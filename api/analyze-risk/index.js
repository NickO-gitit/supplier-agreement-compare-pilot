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
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview";

    if (!endpoint || !apiKey || !deployment) {
      context.res = {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: "Azure OpenAI settings are not configured on the server." }
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

    const url =
      `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey
      },
      body: JSON.stringify({
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
      })
    });

    if (!response.ok) {
      const text = await response.text();
      context.res = {
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: { error: `Azure OpenAI error: ${text}` }
      };
      return;
    }

    const data = await response.json();
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
