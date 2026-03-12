import { CosmosClient } from '@azure/cosmos';

const cosmosEndpoint = normalize(process.env.COSMOS_ENDPOINT);
const cosmosKey = normalize(process.env.COSMOS_KEY);
const cosmosDatabaseName = normalize(process.env.COSMOS_DATABASE_NAME) || 'suppliercompare';
const cosmosContainerName = normalize(process.env.COSMOS_CONTAINER_NAME) || 'appstate';
const cosmosTenant = normalize(process.env.APP_STORAGE_TENANT) || normalize(process.env.ENVIRONMENT) || 'default';
const cosmosLegacyDocumentId = normalize(process.env.APP_STORAGE_DOCUMENT_ID) || 'app-storage';

const hasCosmosConfig = Boolean(cosmosEndpoint && cosmosKey);

const PROJECTS_KEY = 'supplier-agreement-projects';
const PROJECT_COMPARISONS_PREFIX = 'supplier-agreement-comparisons:project:';
const PROJECT_NOTES_PREFIX = 'supplier-agreement-notes:project:';
const PROJECT_CHANGE_RESPONSES_PREFIX = 'supplier-agreement-change-responses:project:';
const LEGACY_CUSTOMERS_KEY = 'supplier-agreement-customers';
const LEGACY_COMPARISONS_KEY = 'supplier-agreement-comparisons';

let lock = Promise.resolve();
let cosmosContainerClientPromise;

function withLock(task) {
  lock = lock.then(task, task);
  return lock;
}

export async function getStorageSnapshot() {
  return withLock(async () => readStore());
}

export async function setStorageValue(key, value) {
  if (!key || typeof key !== 'string') {
    throw new Error('Invalid storage key.');
  }

  return withLock(async () => {
    const container = await getCosmosContainerClient();
    await applyStorageMutation(container, key, value);
  });
}

async function readStore() {
  const container = await getCosmosContainerClient();
  const typedDocs = await queryTypedDocuments(container);

  if (typedDocs.length === 0) {
    const legacy = await readLegacySnapshot(container);
    if (legacy) {
      return legacy;
    }
  }

  return buildSnapshotFromDocuments(typedDocs);
}

async function getCosmosContainerClient() {
  if (!hasCosmosConfig) {
    throw new Error('Cosmos DB is required. Set COSMOS_ENDPOINT and COSMOS_KEY.');
  }

  if (!cosmosContainerClientPromise) {
    cosmosContainerClientPromise = Promise.resolve().then(() => {
      const client = new CosmosClient({
        endpoint: cosmosEndpoint,
        key: cosmosKey,
      });
      return client.database(cosmosDatabaseName).container(cosmosContainerName);
    });
  }

  return cosmosContainerClientPromise;
}

async function queryTypedDocuments(container) {
  const querySpec = {
    query: `
      SELECT * FROM c
      WHERE c.tenant = @tenant
      AND c.type IN ('project', 'run', 'config')
    `,
    parameters: [{ name: '@tenant', value: cosmosTenant }],
  };

  const { resources } = await container.items
    .query(querySpec, { enableCrossPartitionQuery: true })
    .fetchAll();

  return resources || [];
}

async function queryProjectDocuments(container) {
  const querySpec = {
    query: `
      SELECT * FROM c
      WHERE c.tenant = @tenant
      AND c.type = 'project'
    `,
    parameters: [{ name: '@tenant', value: cosmosTenant }],
  };

  const { resources } = await container.items
    .query(querySpec, { enableCrossPartitionQuery: true })
    .fetchAll();

  return resources || [];
}

async function queryRunDocumentsByProject(container, projectId) {
  const querySpec = {
    query: `
      SELECT * FROM c
      WHERE c.tenant = @tenant
      AND c.type = 'run'
      AND c.projectId = @projectId
    `,
    parameters: [
      { name: '@tenant', value: cosmosTenant },
      { name: '@projectId', value: projectId },
    ],
  };

  const { resources } = await container.items
    .query(querySpec, { enableCrossPartitionQuery: true })
    .fetchAll();

  return resources || [];
}

async function readLegacySnapshot(container) {
  try {
    const { resource } = await container.item(cosmosLegacyDocumentId, cosmosTenant).read();
    if (!resource || typeof resource.data !== 'object' || Array.isArray(resource.data)) {
      return null;
    }

    return sanitizeStore(resource.data);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function buildSnapshotFromDocuments(documents) {
  const snapshot = {};

  const projectDocs = documents.filter((entry) => entry.type === 'project');
  const runDocs = documents.filter((entry) => entry.type === 'run');
  const configDocs = documents.filter((entry) => entry.type === 'config');

  const projects = projectDocs
    .map((entry) => ({
      id: String(entry.projectId || ''),
      name: String(entry.name || ''),
      color: String(entry.color || 'blue'),
      initials: String(entry.initials || ''),
      createdAt: entry.createdAt || new Date().toISOString(),
    }))
    .filter((entry) => entry.id)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  if (projects.length > 0) {
    snapshot[PROJECTS_KEY] = JSON.stringify(projects);
  }

  const runDocsByProject = new Map();
  runDocs.forEach((entry) => {
    const projectId = String(entry.projectId || '').trim();
    if (!projectId) return;
    const list = runDocsByProject.get(projectId) || [];
    list.push(entry);
    runDocsByProject.set(projectId, list);
  });

  for (const [projectId, runs] of runDocsByProject.entries()) {
    const comparisons = runs
      .map((entry) => {
        const comparison = sanitizeObject(entry.comparison);
        if (!comparison.id) {
          return null;
        }

        return {
          ...comparison,
          projectId,
        };
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          new Date(String(b.createdAt || 0)).getTime() -
          new Date(String(a.createdAt || 0)).getTime()
      );

    if (comparisons.length > 0) {
      snapshot[`${PROJECT_COMPARISONS_PREFIX}${projectId}`] = JSON.stringify(comparisons);
    }

    const notesByComparison = {};
    const responsesByComparison = {};

    runs.forEach((entry) => {
      const runId = String(entry.runId || '').trim();
      if (!runId) return;

      if (Array.isArray(entry.notes) && entry.notes.length > 0) {
        notesByComparison[runId] = entry.notes;
      }

      if (Array.isArray(entry.changeResponses) && entry.changeResponses.length > 0) {
        responsesByComparison[runId] = entry.changeResponses;
      }
    });

    if (Object.keys(notesByComparison).length > 0) {
      snapshot[`${PROJECT_NOTES_PREFIX}${projectId}`] = JSON.stringify(notesByComparison);
    }

    if (Object.keys(responsesByComparison).length > 0) {
      snapshot[`${PROJECT_CHANGE_RESPONSES_PREFIX}${projectId}`] = JSON.stringify(responsesByComparison);
    }
  }

  configDocs.forEach((entry) => {
    const key = typeof entry.key === 'string' ? entry.key : '';
    if (!key) return;
    const value = typeof entry.value === 'string' ? entry.value : '';
    snapshot[key] = value;
  });

  return snapshot;
}

async function applyStorageMutation(container, key, value) {
  if (key === PROJECTS_KEY || key === LEGACY_CUSTOMERS_KEY) {
    await applyProjectsKey(container, value);
    return;
  }

  if (key.startsWith(PROJECT_COMPARISONS_PREFIX)) {
    const projectId = key.slice(PROJECT_COMPARISONS_PREFIX.length).trim();
    await applyProjectComparisonsKey(container, projectId, value);
    return;
  }

  if (key === LEGACY_COMPARISONS_KEY) {
    await applyLegacyComparisonsKey(container, value);
    return;
  }

  if (key.startsWith(PROJECT_NOTES_PREFIX)) {
    const projectId = key.slice(PROJECT_NOTES_PREFIX.length).trim();
    await applyProjectNotesKey(container, projectId, value);
    return;
  }

  if (key.startsWith(PROJECT_CHANGE_RESPONSES_PREFIX)) {
    const projectId = key.slice(PROJECT_CHANGE_RESPONSES_PREFIX.length).trim();
    await applyProjectChangeResponsesKey(container, projectId, value);
    return;
  }

  await applyConfigKey(container, key, value);
}

async function applyProjectsKey(container, value) {
  const projects = parseProjectsValue(value);
  const incomingIds = new Set(projects.map((entry) => entry.id));

  const existingProjectDocs = await queryProjectDocuments(container);
  const existingByProjectId = new Map(
    existingProjectDocs.map((entry) => [String(entry.projectId || ''), entry])
  );

  const now = new Date().toISOString();

  for (const project of projects) {
    const existing = existingByProjectId.get(project.id);
    const doc = {
      id: buildProjectDocumentId(project.id),
      type: 'project',
      tenant: cosmosTenant,
      projectId: project.id,
      name: project.name,
      color: project.color,
      initials: project.initials,
      createdAt: project.createdAt || existing?.createdAt || now,
      updatedAt: now,
    };

    await container.items.upsert(doc);
  }

  for (const projectDoc of existingProjectDocs) {
    const projectId = String(projectDoc.projectId || '').trim();
    if (!projectId || incomingIds.has(projectId)) {
      continue;
    }

    await deleteDocument(container, projectDoc);

    const projectRuns = await queryRunDocumentsByProject(container, projectId);
    for (const run of projectRuns) {
      await deleteDocument(container, run);
    }
  }
}

async function applyProjectComparisonsKey(container, projectId, value) {
  if (!projectId) {
    return;
  }

  const comparisons = parseComparisonsValue(value, projectId);
  const existingRunDocs = await queryRunDocumentsByProject(container, projectId);
  const existingByRunId = new Map(
    existingRunDocs.map((entry) => [String(entry.runId || ''), entry])
  );

  const incomingRunIds = new Set();
  const now = new Date().toISOString();

  for (const comparison of comparisons) {
    const runId = comparison.id;
    incomingRunIds.add(runId);

    const existing = existingByRunId.get(runId);
    const doc = {
      id: buildRunDocumentId(projectId, runId),
      type: 'run',
      tenant: cosmosTenant,
      projectId,
      runId,
      comparison,
      notes: Array.isArray(existing?.notes) ? existing.notes : [],
      changeResponses: Array.isArray(existing?.changeResponses) ? existing.changeResponses : [],
      createdAt: existing?.createdAt || comparison.createdAt || now,
      updatedAt: now,
    };

    await container.items.upsert(doc);
  }

  for (const run of existingRunDocs) {
    const runId = String(run.runId || '').trim();
    if (!runId || incomingRunIds.has(runId)) {
      continue;
    }

    await deleteDocument(container, run);
  }
}

async function applyLegacyComparisonsKey(container, value) {
  const raw = parseJsonObject(value);
  if (!Array.isArray(raw)) {
    return;
  }

  const grouped = new Map();
  raw.forEach((entry) => {
    const normalized = normalizeComparison(entry, '');
    const projectId = normalized.projectId;
    if (!projectId) return;

    const list = grouped.get(projectId) || [];
    list.push(normalized);
    grouped.set(projectId, list);
  });

  for (const [projectId, comparisons] of grouped.entries()) {
    await applyProjectComparisonsKey(container, projectId, JSON.stringify(comparisons));
  }
}

async function applyProjectNotesKey(container, projectId, value) {
  if (!projectId) {
    return;
  }

  const notesByComparison = parseJsonObject(value);
  const runDocs = await queryRunDocumentsByProject(container, projectId);
  const now = new Date().toISOString();

  for (const run of runDocs) {
    const runId = String(run.runId || '').trim();
    if (!runId) continue;

    const nextNotes = Array.isArray(notesByComparison?.[runId]) ? notesByComparison[runId] : [];
    run.notes = nextNotes;
    run.updatedAt = now;
    await container.items.upsert(run);
  }
}

async function applyProjectChangeResponsesKey(container, projectId, value) {
  if (!projectId) {
    return;
  }

  const responsesByComparison = parseJsonObject(value);
  const runDocs = await queryRunDocumentsByProject(container, projectId);
  const now = new Date().toISOString();

  for (const run of runDocs) {
    const runId = String(run.runId || '').trim();
    if (!runId) continue;

    const nextResponses = Array.isArray(responsesByComparison?.[runId])
      ? responsesByComparison[runId]
      : [];

    run.changeResponses = nextResponses;
    run.updatedAt = now;
    await container.items.upsert(run);
  }
}

async function applyConfigKey(container, key, value) {
  const id = buildConfigDocumentId(key);

  if (value === null || value === undefined) {
    try {
      await container.item(id, '__system').delete();
      return;
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }

    try {
      await container.item(id, cosmosTenant).delete();
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }

    return;
  }

  await container.items.upsert({
    id,
    type: 'config',
    tenant: cosmosTenant,
    projectId: '__system',
    key,
    value: String(value),
    updatedAt: new Date().toISOString(),
  });
}

function parseProjectsValue(value) {
  const parsed = parseJsonObject(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((entry) => {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (!id) return null;

      return {
        id,
        name: typeof entry?.name === 'string' ? entry.name : id,
        color: typeof entry?.color === 'string' ? entry.color : 'blue',
        initials: typeof entry?.initials === 'string' ? entry.initials : '',
        createdAt:
          typeof entry?.createdAt === 'string' || typeof entry?.createdAt === 'number'
            ? entry.createdAt
            : new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

function parseComparisonsValue(value, defaultProjectId) {
  const parsed = parseJsonObject(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((entry) => normalizeComparison(entry, defaultProjectId))
    .filter((entry) => entry.id && entry.projectId);
}

function normalizeComparison(entry, defaultProjectId) {
  const source = sanitizeObject(entry);
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  const projectId =
    (typeof source.projectId === 'string' && source.projectId.trim()) ||
    (typeof source.customerId === 'string' && source.customerId.trim()) ||
    defaultProjectId ||
    '';

  return {
    ...source,
    id,
    projectId,
    title:
      typeof source.title === 'string' && source.title.trim().length > 0
        ? source.title
        : null,
    createdAt: source.createdAt || new Date().toISOString(),
  };
}

function buildProjectDocumentId(projectId) {
  return `project:${projectId}`;
}

function buildRunDocumentId(projectId, runId) {
  return `run:${projectId}:${runId}`;
}

function buildConfigDocumentId(key) {
  const encoded = Buffer.from(String(key)).toString('base64url');
  return `config:${encoded}`;
}

async function deleteDocument(container, doc) {
  const candidates = Array.from(
    new Set([doc?.projectId, doc?.tenant, '__system', cosmosTenant].filter(Boolean))
  );

  let lastError = null;
  for (const partitionKey of candidates) {
    try {
      await container.item(doc.id, partitionKey).delete();
      return;
    } catch (error) {
      if (isNotFound(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  if (lastError && !isNotFound(lastError)) {
    throw lastError;
  }
}

function sanitizeStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, String(entryValue)])
  );
}

function sanitizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value;
}

function parseJsonObject(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isNotFound(error) {
  if (!error || typeof error !== 'object') return false;
  const status = Number(error.statusCode || error.status || 0);
  return status === 404;
}

function normalize(value) {
  return typeof value === 'string' ? value.trim() : '';
}
