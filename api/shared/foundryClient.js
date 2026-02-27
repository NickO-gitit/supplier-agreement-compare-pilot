const DEFAULT_API_VERSION_CANDIDATES = [
  "2024-12-01-preview",
  "2024-10-21",
  "2024-08-01-preview",
  "2024-06-01",
  "2024-05-01-preview",
  "2024-02-15-preview",
  "2024-02-01"
];

const workingVersionCache = new Map();

async function postChatCompletionWithVersionFallback({
  endpoint,
  deployment,
  apiKey,
  apiVersion,
  payload
}) {
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const resourceRoot = deriveResourceRoot(normalizedEndpoint);
  const routePlans = buildRoutePlans(normalizedEndpoint, resourceRoot, deployment);

  const attempts = [];
  let lastUnsupportedVersionError = "";
  let lastErrorText = "";

  for (const routePlan of routePlans) {
    const cacheKey = `${routePlan.cacheKey}|${deployment}`;
    const versions = routePlan.requiresVersion
      ? buildApiVersionCandidates(cacheKey, apiVersion)
      : [null];

    for (const version of versions) {
      const url = routePlan.buildUrl(version);
      const requestPayload = routePlan.preparePayload(payload, deployment);
      const response = await fetch(url, {
        method: "POST",
        headers: routePlan.headers(apiKey),
        body: JSON.stringify(requestPayload)
      });

      if (response.ok) {
        if (version) {
          workingVersionCache.set(cacheKey, version);
        }
        return response.json();
      }

      const text = await response.text();
      lastErrorText = text || lastErrorText;
      attempts.push(formatAttempt(routePlan, version));

      if (isUnsupportedApiVersion(text)) {
        lastUnsupportedVersionError = text || lastUnsupportedVersionError;
        continue;
      }

      if (shouldTryAlternativeRoute(text)) {
        break;
      }

      throw new Error(`Foundry/OpenAI error: ${text}`);
    }
  }

  if (lastUnsupportedVersionError) {
    const versionAttempts = attempts
      .filter((entry) => entry.version)
      .map((entry) => entry.version);
    throw new Error(
      `Foundry/OpenAI error: ${lastUnsupportedVersionError} (tried: ${Array.from(new Set(versionAttempts)).join(", ")})`
    );
  }

  throw new Error(
    `Foundry/OpenAI error: ${lastErrorText || "No compatible endpoint/route found"} (tried routes: ${attempts.map((entry) => entry.label).join(", ")})`
  );
}

function buildRoutePlans(endpoint, resourceRoot, deployment) {
  return [
    {
      name: "azure_openai_deployments",
      requiresVersion: true,
      cacheKey: `${endpoint}|openai-deployments`,
      buildUrl: (version) =>
        `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${version}`,
      preparePayload: (payload) => payload,
      headers: (apiKey) => ({
        "Content-Type": "application/json",
        "api-key": apiKey
      })
    },
    {
      name: "foundry_models_chat",
      requiresVersion: true,
      cacheKey: `${resourceRoot}|foundry-models`,
      buildUrl: (version) =>
        `${resourceRoot}/models/chat/completions?api-version=${version || "2024-05-01-preview"}`,
      preparePayload: (payload, model) => withModel(payload, model),
      headers: (apiKey) => ({
        "Content-Type": "application/json",
        "api-key": apiKey
      })
    },
    {
      name: "foundry_openai_v1_chat",
      requiresVersion: false,
      cacheKey: `${resourceRoot}|openai-v1`,
      buildUrl: () => `${resourceRoot}/openai/v1/chat/completions`,
      preparePayload: (payload, model) => withModel(payload, model),
      headers: (apiKey) => ({
        "Content-Type": "application/json",
        "api-key": apiKey
      })
    }
  ];
}

function buildApiVersionCandidates(cacheKey, primary) {
  const cached = workingVersionCache.get(cacheKey);
  const envCandidates = parseCsv(process.env.FOUNDRY_API_VERSION_CANDIDATES);
  const values = [cached, primary, ...envCandidates, ...DEFAULT_API_VERSION_CANDIDATES]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);

  return Array.from(new Set(values));
}

function parseCsv(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeEndpoint(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function deriveResourceRoot(endpoint) {
  const marker = "/api/projects/";
  const markerIndex = endpoint.toLowerCase().indexOf(marker);
  if (markerIndex >= 0) {
    return endpoint.slice(0, markerIndex).replace(/\/+$/, "");
  }
  return endpoint;
}

function withModel(payload, model) {
  if (payload && typeof payload === "object" && payload.model) {
    return payload;
  }
  return {
    ...payload,
    model
  };
}

function shouldTryAlternativeRoute(errorText) {
  const parsed = parseErrorPayload(errorText);
  const code = parsed.code.toLowerCase();
  const message = parsed.message.toLowerCase();
  const combined = `${code} ${message}`;

  return (
    combined.includes("resource not found") ||
    combined.includes("deploymentnotfound") ||
    combined.includes("unknown_model") ||
    combined.includes("unavailable_model") ||
    combined.includes("api version not supported")
  );
}

function parseErrorPayload(errorText) {
  const fallbackMessage = extractErrorMessage(errorText).trim();
  try {
    const parsed = JSON.parse(errorText);
    if (parsed && typeof parsed === "object") {
      if (parsed.error && typeof parsed.error === "object") {
        return {
          code: String(parsed.error.code || ""),
          message: String(parsed.error.message || fallbackMessage)
        };
      }
      return {
        code: String(parsed.code || ""),
        message: String(parsed.message || fallbackMessage)
      };
    }
  } catch {
    // Ignore invalid JSON and use fallback message.
  }

  return {
    code: "",
    message: fallbackMessage
  };
}

function formatAttempt(routePlan, version) {
  const label = version ? `${routePlan.name}@${version}` : routePlan.name;
  return { label, version };
}

function isUnsupportedApiVersion(errorText) {
  const normalized = extractErrorMessage(errorText).toLowerCase();
  return (
    normalized.includes("api version not supported") ||
    normalized.includes("unsupported api version") ||
    normalized.includes("invalid api version")
  );
}

function extractErrorMessage(errorText) {
  if (typeof errorText !== "string" || errorText.trim().length === 0) {
    return "";
  }

  const raw = errorText.trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.message === "string") {
        return parsed.message;
      }
      if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
        return parsed.error.message;
      }
      if (typeof parsed.error === "string") {
        return parsed.error;
      }
    }
  } catch {
    // Non-JSON payloads are handled below.
  }

  return raw;
}

module.exports = {
  postChatCompletionWithVersionFallback
};
