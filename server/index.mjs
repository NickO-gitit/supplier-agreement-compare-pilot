import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadTenantConfig } from './loadTenantConfig.mjs';
import { getStorageSnapshot, setStorageValue } from './dataStore.mjs';

const require = createRequire(import.meta.url);
const analyzeRiskHandler = require('../api/analyze-risk/index.js');
const reviewGroupingHandler = require('../api/review-grouping/index.js');
const riskFollowupHandler = require('../api/risk-followup/index.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const indexHtmlPath = path.join(distDir, 'index.html');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

await loadTenantConfig(console);

const port = Number(process.env.PORT || '3000');

const server = createServer(async (req, res) => {
  try {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/health') {
      return sendJson(res, 200, { status: 'ok' });
    }

    if (pathname === '/api/analyze-risk') {
      return handleFunctionRequest(req, res, analyzeRiskHandler);
    }

    if (pathname === '/api/review-grouping') {
      return handleFunctionRequest(req, res, reviewGroupingHandler);
    }

    if (pathname === '/api/risk-followup') {
      return handleFunctionRequest(req, res, riskFollowupHandler);
    }

    if (pathname === '/api/storage') {
      if (method === 'GET') {
        const snapshot = await getStorageSnapshot();
        return sendJson(res, 200, snapshot);
      }

      if (method !== 'POST') {
        return sendJson(res, 405, { error: 'Method not allowed. Use GET or POST.' });
      }

      const bodyText = await readRequestBody(req);
      const body = bodyText ? tryParseJson(bodyText) : null;
      if (!body || typeof body !== 'object') {
        return sendJson(res, 400, { error: 'Invalid JSON body.' });
      }

      const key = typeof body.key === 'string' ? body.key : '';
      const value =
        body.value === null || typeof body.value === 'string' ? body.value : undefined;

      if (!key) {
        return sendJson(res, 400, { error: 'Key is required.' });
      }
      if (value === undefined) {
        return sendJson(res, 400, { error: 'Value must be a string or null.' });
      }

      await setStorageValue(key, value);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'API route not found.' });
    }

    if (method !== 'GET' && method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }

    return serveFrontendAsset(res, pathname, method === 'HEAD');
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

server.listen(port, () => {
  console.log(`Server listening on http://0.0.0.0:${port}`);
});

async function handleFunctionRequest(req, res, handler) {
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
  }

  const bodyText = await readRequestBody(req);
  const parsedBody = bodyText ? tryParseJson(bodyText) : {};

  if (bodyText && parsedBody === null) {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }

  const context = {};
  const request = {
    body: parsedBody ?? {},
    method: req.method,
    headers: req.headers,
    query: {},
    params: {},
  };

  await handler(context, request);

  const response = context.res || {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
    body: { error: 'Function handler did not return a response.' },
  };

  return sendFunctionResponse(res, response);
}

async function serveFrontendAsset(res, requestPath, isHeadRequest) {
  const normalizedPath = requestPath === '/' ? '/index.html' : requestPath;
  const filePath = path.join(distDir, normalizedPath.replace(/^\/+/, ''));
  const safePath = path.normalize(filePath);

  if (!safePath.startsWith(path.normalize(distDir))) {
    return sendJson(res, 403, { error: 'Forbidden path.' });
  }

  if (await fileExists(safePath)) {
    return streamFile(res, safePath, isHeadRequest);
  }

  if (path.extname(normalizedPath)) {
    return sendJson(res, 404, { error: 'Asset not found.' });
  }

  if (!(await fileExists(indexHtmlPath))) {
    return sendJson(res, 500, {
      error: 'Frontend build not found. Run "npm run build" before starting the server.',
    });
  }

  return streamFile(res, indexHtmlPath, isHeadRequest, 'text/html; charset=utf-8');
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function streamFile(res, filePath, isHeadRequest, overrideContentType) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    overrideContentType || MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });

  if (isHeadRequest) {
    res.end();
    return;
  }

  createReadStream(filePath).pipe(res);
}

function sendFunctionResponse(res, response) {
  const status = Number(response.status || 200);
  const headers = response.headers || {};
  const body = response.body;

  const hasContentType = Object.keys(headers).some(
    (key) => key.toLowerCase() === 'content-type'
  );

  if (typeof body === 'string') {
    res.writeHead(status, {
      ...(hasContentType ? {} : { 'Content-Type': 'text/plain; charset=utf-8' }),
      ...headers,
    });
    res.end(body);
    return;
  }

  res.writeHead(status, {
    ...(hasContentType ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    ...headers,
  });
  res.end(JSON.stringify(body ?? {}));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('Request body too large.'));
      }
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
