const DEFAULT_API_VERSION_CANDIDATES = [
  "2024-10-21",
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
  const cacheKey = `${endpoint}|${deployment}`;
  const triedVersions = [];
  let lastVersionError = "";

  for (const version of buildApiVersionCandidates(cacheKey, apiVersion)) {
    triedVersions.push(version);
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${version}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      workingVersionCache.set(cacheKey, version);
      return response.json();
    }

    const text = await response.text();
    if (isUnsupportedApiVersion(text)) {
      lastVersionError = text;
      continue;
    }

    throw new Error(`Foundry/OpenAI error: ${text}`);
  }

  throw new Error(
    `Foundry/OpenAI error: ${lastVersionError || "API version not supported"} (tried: ${triedVersions.join(", ")})`
  );
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
