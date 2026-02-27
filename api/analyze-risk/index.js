const { postChatCompletionWithVersionFallback } = require("../shared/foundryClient");

const RISK_ANALYSIS_PROMPT = `You are a legal expert analyzing changes to a supplier framework agreement.
Analyze the following change and provide a risk assessment for the CUSTOMER (not the supplier).

IMPORTANT: Be concise. Focus on practical business and legal implications.
IMPORTANT OUTPUT RULES:
- Return VALID JSON only.
- Do NOT include chain-of-thought, self-talk, internal reasoning, or <think> tags.
- Do NOT include markdown, code fences, or extra keys.
- Keep each text field short (1-2 sentences).

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

const RISK_ANALYSIS_EXPANDED_PROMPT = `You are a legal expert analyzing changes to a supplier framework agreement.
Analyze the following change and provide a risk assessment for the CUSTOMER (not the supplier).

IMPORTANT: Provide a fuller analysis than standard mode. Include practical legal and commercial context.
IMPORTANT OUTPUT RULES:
- Return VALID JSON only.
- Do NOT include chain-of-thought, self-talk, internal reasoning, or <think> tags.
- Do NOT include markdown, code fences, or extra keys.

Change Type: {changeType}
Original Text: {originalText}
Proposed Text: {proposedText}
Context: {context}

Respond in this exact JSON format:
{
  "riskLevel": "low" | "medium" | "high",
  "category": "<category name: e.g., Liability, Payment Terms, Termination, IP Rights, Data Protection, Indemnification, Warranty, Force Majeure, Non-Compete, Other>",
  "explanation": "<3-6 sentences explaining what changed and why it matters>",
  "legalImplication": "<3-6 sentences on legal/commercial impact for the customer>",
  "recommendation": "<3-6 sentences with actionable next steps and fallback language suggestions>"
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
    const analysisMode = requestBody.analysisMode === "expanded" ? "expanded" : "standard";

    if (!difference || typeof difference !== "object") {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Request must include a 'difference' object." }
      };
      return;
    }

    const promptTemplate =
      analysisMode === "expanded" ? RISK_ANALYSIS_EXPANDED_PROMPT : RISK_ANALYSIS_PROMPT;

    const prompt = promptTemplate
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
            content:
              "You are a legal expert specializing in commercial contract analysis. Return valid JSON only with final answers. Never output chain-of-thought or <think> content."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: analysisMode === "expanded" ? 1200 : 700
      }
    });
    const rawContent = extractModelText(data);
    const parsed = parseRiskResponse(rawContent);
    const normalized = normalizeParsedRisk(parsed, analysisMode);
    const analysisTrace = {
      provider: "proxy",
      prompt,
      rawResponse: typeof rawContent === "string" ? rawContent : "",
      route: endpoint,
      model: deployment,
      timestamp: new Date().toISOString()
    };

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        ...normalized,
        analysisDetailLevel: analysisMode,
        analysisTrace
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

function extractModelText(data) {
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          if (typeof item.text === "string") {
            return item.text;
          }
          if (item.type === "text" && typeof item.content === "string") {
            return item.content;
          }
        }
        return "";
      })
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  if (typeof data?.output_text === "string") {
    return data.output_text;
  }
  if (Array.isArray(data?.output_text)) {
    return data.output_text.filter((part) => typeof part === "string").join("\n");
  }

  return "";
}

function parseRiskResponse(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("Model response content was empty.");
  }

  const sanitizedRaw = sanitizeModelText(raw);

  const direct = tryParseJsonCandidate(sanitizedRaw);
  if (direct) {
    return direct;
  }

  for (const candidate of extractJsonCandidates(sanitizedRaw)) {
    const parsed = tryParseJsonCandidate(candidate);
    if (parsed) {
      return parsed;
    }
  }

  const fallback = parseRiskFromText(sanitizedRaw);
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
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Try a minimal cleanup pass for common trailing-comma issues.
    const sanitized = trimmed.replace(/,\s*([}\]])/g, "$1");
    try {
      const reparsed = JSON.parse(sanitized);
      return reparsed && typeof reparsed === "object" && !Array.isArray(reparsed) ? reparsed : null;
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
    extractSingleLineLabeledField(raw, ["category", "risk category"]) ||
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

function extractSingleLineLabeledField(text, labels) {
  const escapedLabels = labels.map(escapeRegex);
  const labelGroup = escapedLabels.join("|");
  const pattern = new RegExp(
    `(?:^|\\n)\\s*(?:${labelGroup})\\s*[:\\-]\\s*([^\\n]+)`,
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

function normalizeParsedRisk(parsed, mode) {
  const isExpanded = mode === "expanded";
  const explanationLimit = isExpanded ? 1150 : 420;
  const legalLimit = isExpanded ? 1400 : 520;
  const recommendationLimit = isExpanded ? 1400 : 520;

  return {
    riskLevel: normalizeRiskLevel(parsed.riskLevel),
    category: normalizeCategory(parsed.category),
    explanation: normalizeNarrativeField(
      parsed.explanation,
      "Unable to analyze this change.",
      explanationLimit
    ),
    legalImplication: normalizeNarrativeField(
      parsed.legalImplication,
      "Review with legal counsel recommended.",
      legalLimit
    ),
    recommendation: normalizeNarrativeField(
      parsed.recommendation,
      "Consult with legal team before accepting.",
      recommendationLimit
    )
  };
}

function normalizeCategory(value) {
  const cleaned = sanitizeModelText(typeof value === "string" ? value : "")
    .replace(/^category\s*[:\-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "Other";
  }

  const canonical = [
    "Liability",
    "Payment Terms",
    "Termination",
    "IP Rights",
    "Data Protection",
    "Indemnification",
    "Warranty",
    "Force Majeure",
    "Non-Compete",
    "Compliance",
    "Other"
  ];

  const exact = canonical.find((entry) => entry.toLowerCase() === cleaned.toLowerCase());
  if (exact) {
    return exact;
  }

  const lower = cleaned.toLowerCase();
  if (/[.!?]/.test(cleaned) || cleaned.length > 48) {
    return inferCategory(lower);
  }

  return inferCategory(lower) || cleaned;
}

function inferCategory(lowerText) {
  if (!lowerText) return "Other";
  if (lowerText.includes("liab")) return "Liability";
  if (lowerText.includes("payment") || lowerText.includes("wage")) return "Payment Terms";
  if (lowerText.includes("terminat")) return "Termination";
  if (lowerText.includes("ip") || lowerText.includes("intellectual property")) return "IP Rights";
  if (lowerText.includes("data") || lowerText.includes("privacy")) return "Data Protection";
  if (lowerText.includes("indemn")) return "Indemnification";
  if (lowerText.includes("warrant")) return "Warranty";
  if (lowerText.includes("force majeure")) return "Force Majeure";
  if (lowerText.includes("non-compete") || lowerText.includes("restrictive covenant")) return "Non-Compete";
  if (lowerText.includes("compliance") || lowerText.includes("monitor") || lowerText.includes("audit")) {
    return "Compliance";
  }
  return "Other";
}

function normalizeNarrativeField(value, fallback, maxChars) {
  const cleaned = sanitizeModelText(typeof value === "string" ? value : "");
  if (!cleaned) {
    return fallback;
  }

  const withoutThought = stripReasoningTails(cleaned);
  const normalizedWhitespace = withoutThought
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

  if (!normalizedWhitespace) {
    return fallback;
  }

  return trimToMaxSentence(normalizedWhitespace, maxChars);
}

function sanitizeModelText(text) {
  if (typeof text !== "string") {
    return "";
  }

  const withoutThink = text
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<\/?think>/gi, " ");

  return withoutThink
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function stripReasoningTails(text) {
  const cutMarkers = [
    /\bwait,\b/i,
    /\bnow,\s*considering\b/i,
    /\blet me\b/i,
    /\bi should\b/i,
    /\bi need to\b/i,
    /\bi will\b/i
  ];

  let bestCut = -1;
  for (const marker of cutMarkers) {
    const match = marker.exec(text);
    if (match && match.index > 0) {
      if (bestCut === -1 || match.index < bestCut) {
        bestCut = match.index;
      }
    }
  }

  const trimmed = bestCut > 0 ? text.slice(0, bestCut).trim() : text.trim();
  return trimmed;
}

function trimToMaxSentence(text, maxChars) {
  if (typeof text !== "string" || text.length <= maxChars) {
    return text;
  }

  const candidate = text.slice(0, maxChars).trim();
  const sentenceBoundary = Math.max(
    candidate.lastIndexOf("."),
    candidate.lastIndexOf("!"),
    candidate.lastIndexOf("?")
  );

  if (sentenceBoundary >= Math.floor(maxChars * 0.55)) {
    return candidate.slice(0, sentenceBoundary + 1).trim();
  }

  const wordBoundary = candidate.lastIndexOf(" ");
  if (wordBoundary > 0) {
    return `${candidate.slice(0, wordBoundary).trim()}...`;
  }
  return `${candidate}...`;
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
