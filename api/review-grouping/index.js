const { postChatCompletionWithVersionFallback } = require("../shared/foundryClient");

const GROUPING_REVIEW_PROMPT = `You are a contract diff quality reviewer.
Your task is to judge whether ONE detected change appears grouped correctly in legal-document context.

Assess if the selected change should stay as-is, be split, or be merged with a neighbor.
Important guidance:
- A short standalone edit can still be correct if it is a complete punctuation/numbering edit.
- Do NOT mark "good" if the selected change is a syntactic fragment that clearly depends on adjacent change text.
- Use local context and structure, not any tool-specific markers.

Respond in this exact JSON format:
{
  "quality": "good" | "over_grouped" | "over_split" | "unclear",
  "suggestedAction": "keep" | "split" | "merge_with_previous" | "merge_with_next",
  "section": "<short section label like 5.1 or Clause 12, or 'Unknown'>",
  "summary": "<1-2 short sentences about grouping quality>",
  "rationale": "<brief reason based on local context>",
  "confidence": <number from 0 to 1>
}

Selected change:
{selectedChange}

Previous change:
{previousChange}

Next change:
{nextChange}

Original context around selected change:
{originalContext}

Proposed context around selected change:
{proposedContext}`;

module.exports = async function (context, req) {
  try {
    const endpoint = resolveEndpoint();
    const apiKey = process.env.FOUNDRY_API_KEY || process.env.AZURE_OPENAI_KEY;
    const deployment = process.env.FOUNDRY_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion =
      process.env.FOUNDRY_API_VERSION || process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";

    if (!endpoint || !apiKey || !deployment) {
      context.res = {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: "Foundry/OpenAI settings are not configured on the server." }
      };
      return;
    }

    const body = parseRequestBody(req.body);
    const difference = body.difference;
    const previousDifference = body.previousDifference || null;
    const nextDifference = body.nextDifference || null;
    const originalContext = typeof body.originalContext === "string" ? body.originalContext : "";
    const proposedContext = typeof body.proposedContext === "string" ? body.proposedContext : "";

    if (!difference || typeof difference !== "object") {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Request must include a 'difference' object." }
      };
      return;
    }

    const prompt = GROUPING_REVIEW_PROMPT
      .replace("{selectedChange}", formatDifference(difference))
      .replace("{previousChange}", previousDifference ? formatDifference(previousDifference) : "[None]")
      .replace("{nextChange}", nextDifference ? formatDifference(nextDifference) : "[None]")
      .replace("{originalContext}", originalContext || "[Not available]")
      .replace("{proposedContext}", proposedContext || "[Not available]");

    const data = await postChatCompletionWithVersionFallback({
      endpoint,
      deployment,
      apiKey,
      apiVersion,
      payload: {
        messages: [
          {
            role: "system",
            content: "You are a contract redline reviewer. Respond with valid JSON only."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.2,
        max_tokens: 500
      }
    });
    const rawContent = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
    const parsed = parseResponse(rawContent);

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        quality: normalizeQuality(parsed.quality),
        suggestedAction: normalizeAction(parsed.suggestedAction),
        section: stringOrFallback(parsed.section, "Unknown"),
        summary: stringOrFallback(parsed.summary, "Grouping appears acceptable."),
        rationale: stringOrFallback(parsed.rationale, "No strong grouping issue identified."),
        confidence: normalizeConfidence(parsed.confidence)
      }
    };
  } catch (error) {
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: error instanceof Error ? error.message : "Unknown server error" }
    };
  }
};

function parseRequestBody(body) {
  if (!body) {
    return {};
  }
  if (typeof body === "string") {
    return JSON.parse(body);
  }
  return body;
}

function parseResponse(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("Model response content was empty.");
  }

  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON.");
  }
}

function normalizeQuality(value) {
  const quality = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (quality === "good" || quality === "over_grouped" || quality === "over_split" || quality === "unclear") {
    return quality;
  }
  return "unclear";
}

function normalizeAction(value) {
  const action = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    action === "keep" ||
    action === "split" ||
    action === "merge_with_previous" ||
    action === "merge_with_next"
  ) {
    return action;
  }
  return "keep";
}

function normalizeConfidence(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.min(1, parsed));
  }
  return 0.5;
}

function stringOrFallback(value, fallback) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function formatDifference(difference) {
  return JSON.stringify(
    {
      id: difference.id,
      type: difference.type,
      originalText: difference.originalText,
      proposedText: difference.proposedText,
      context: difference.context
    },
    null,
    2
  );
}

function resolveEndpoint() {
  const raw =
    process.env.FOUNDRY_PROJECT_ENDPOINT ||
    process.env.AZURE_FOUNDRY_ENDPOINT ||
    process.env.AZURE_OPENAI_ENDPOINT ||
    "";
  return normalizeEndpoint(raw);
}

function normalizeEndpoint(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";

  const withoutQuery = trimmed.split("?")[0];
  const marker = "/openai/deployments/";
  const markerIndex = withoutQuery.toLowerCase().indexOf(marker);
  const root = markerIndex >= 0 ? withoutQuery.slice(0, markerIndex) : withoutQuery;
  return root.replace(/\/+$/, "");
}
