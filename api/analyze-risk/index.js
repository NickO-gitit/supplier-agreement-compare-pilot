const { postChatCompletionWithVersionFallback } = require("../shared/foundryClient");

const RISK_ANALYSIS_PROMPT = `You are a legal expert analyzing changes to a supplier framework agreement.
Analyze the following change and provide a risk assessment for the CUSTOMER (not the supplier).

IMPORTANT: Be concise. Focus on the practical business and legal implications.

Change Type: {changeType}
Original Text: {originalText}
Proposed Text: {proposedText}
Context: {context}

Respond in this exact JSON format:
{
  "riskLevel": "low" | "medium" | "high",
  "category": "<category name: e.g., Liability, Payment Terms, Termination, IP Rights, Data Protection, Indemnification, Warranty, Force Majeure, Non-Compete, Other>",
  "explanation": "<1-2 sentences explaining what changed>",
  "legalImplication": "<1-2 sentences on the legal impact for the customer>",
  "recommendation": "<1-2 sentences on recommended action>"
}`;

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

    const requestBody = parseRequestBody(req.body);
    const difference = requestBody.difference;

    if (!difference || typeof difference !== "object") {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Request must include a 'difference' object." }
      };
      return;
    }

    const prompt = RISK_ANALYSIS_PROMPT
      .replace("{changeType}", difference.type || "modification")
      .replace("{originalText}", difference.originalText || "[None - New Addition]")
      .replace("{proposedText}", difference.proposedText || "[None - Deleted]")
      .replace("{context}", difference.context || "[No surrounding context]");

    const data = await postChatCompletionWithVersionFallback({
      endpoint,
      deployment,
      apiKey,
      apiVersion,
      payload: {
        messages: [
          {
            role: "system",
            content: "You are a legal expert specializing in commercial contract analysis. Always respond with valid JSON only."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 500
      }
    });
    const rawContent = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
    const parsed = parseRiskResponse(rawContent);

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        riskLevel: normalizeRiskLevel(parsed.riskLevel),
        category: stringOrFallback(parsed.category, "Other"),
        explanation: stringOrFallback(parsed.explanation, "Unable to analyze this change."),
        legalImplication: stringOrFallback(parsed.legalImplication, "Review with legal counsel recommended."),
        recommendation: stringOrFallback(parsed.recommendation, "Consult with legal team before accepting.")
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

function parseRiskResponse(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("Model response content was empty.");
  }

  const direct = tryParseJsonCandidate(raw);
  if (direct) {
    return direct;
  }

  for (const candidate of extractJsonCandidates(raw)) {
    const parsed = tryParseJsonCandidate(candidate);
    if (parsed) {
      return parsed;
    }
  }

  const fallback = parseRiskFromText(raw);
  if (hasMeaningfulRiskFields(fallback)) {
    return fallback;
  }

  throw new Error("Model did not return valid JSON.");
}

function tryParseJsonCandidate(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = stripCodeFences(value.trim());
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Try a minimal cleanup pass for common trailing-comma issues.
    const sanitized = trimmed.replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
  }
}

function extractJsonCandidates(raw) {
  const candidates = [];
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = codeBlockRegex.exec(raw)) !== null) {
    if (match[1]) {
      candidates.push(match[1].trim());
    }
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    candidates.push(raw.slice(start, end + 1));
  }

  return candidates;
}

function stripCodeFences(text) {
  if (!text.startsWith("```")) {
    return text;
  }

  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function parseRiskFromText(raw) {
  const riskLevel =
    extractRiskLevel(raw) ||
    "";

  const category =
    extractLabeledField(raw, ["category", "risk category"]) ||
    "";

  const explanation =
    extractLabeledField(raw, ["what changed", "explanation", "change summary"]) ||
    "";

  const legalImplication =
    extractLabeledField(raw, ["legal implication", "impact", "legal impact"]) ||
    "";

  const recommendation =
    extractLabeledField(raw, ["recommendation", "recommended action", "action"]) ||
    "";

  return {
    riskLevel,
    category,
    explanation,
    legalImplication,
    recommendation
  };
}

function extractRiskLevel(text) {
  const lower = text.toLowerCase();
  const labeled = lower.match(/(?:risk\s*level|risk)\s*[:\-]\s*(low|medium|high)\b/i);
  if (labeled && labeled[1]) {
    return labeled[1].toLowerCase();
  }

  const standalone = lower.match(/\b(low|medium|high)\s+risk\b/i);
  return standalone && standalone[1] ? standalone[1].toLowerCase() : "";
}

function extractLabeledField(text, labels) {
  const escapedLabels = labels.map(escapeRegex);
  const labelGroup = escapedLabels.join("|");
  const pattern = new RegExp(
    `(?:^|\\n)\\s*(?:${labelGroup})\\s*[:\\-]\\s*([\\s\\S]*?)(?=\\n\\s*[A-Za-z][^\\n]{0,40}[:\\-]|$)`,
    "i"
  );
  const match = text.match(pattern);
  if (!match || !match[1]) {
    return "";
  }

  return match[1]
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasMeaningfulRiskFields(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return false;
  }

  return Boolean(
    (typeof parsed.riskLevel === "string" && parsed.riskLevel.trim()) ||
    (typeof parsed.category === "string" && parsed.category.trim()) ||
    (typeof parsed.explanation === "string" && parsed.explanation.trim()) ||
    (typeof parsed.legalImplication === "string" && parsed.legalImplication.trim()) ||
    (typeof parsed.recommendation === "string" && parsed.recommendation.trim())
  );
}

function normalizeRiskLevel(value) {
  const level = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (level === "low" || level === "medium" || level === "high") {
    return level;
  }
  return "medium";
}

function stringOrFallback(value, fallback) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
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
