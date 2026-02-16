const RISK_FOLLOWUP_PROMPT = `You are a legal contract assistant.
You are answering a follow-up question about ONE specific contract change and its prior risk analysis.

Change Type: {changeType}
Original Text: {originalText}
Proposed Text: {proposedText}
Context: {context}

Prior Risk Analysis:
- Risk Level: {riskLevel}
- Category: {category}
- What Changed: {explanation}
- Legal Implication: {legalImplication}
- Recommendation: {recommendation}

User Question:
{question}

Instructions:
- Answer only the question asked.
- Keep the answer concise and practical.
- Use plain text (not JSON).
- If legal uncertainty remains, state that clearly.`;

module.exports = async function (context, req) {
  try {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";

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
    const riskAnalysis = requestBody.riskAnalysis;
    const question = typeof requestBody.question === "string" ? requestBody.question.trim() : "";

    if (!difference || typeof difference !== "object") {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Request must include a 'difference' object." }
      };
      return;
    }

    if (!riskAnalysis || typeof riskAnalysis !== "object") {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Request must include a 'riskAnalysis' object." }
      };
      return;
    }

    if (!question) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Request must include a non-empty 'question'." }
      };
      return;
    }

    const prompt = RISK_FOLLOWUP_PROMPT
      .replace("{changeType}", difference.type || "modification")
      .replace("{originalText}", difference.originalText || "[None - New Addition]")
      .replace("{proposedText}", difference.proposedText || "[None - Deleted]")
      .replace("{context}", difference.context || "[No surrounding context]")
      .replace("{riskLevel}", riskAnalysis.riskLevel || "unknown")
      .replace("{category}", riskAnalysis.category || "Other")
      .replace("{explanation}", riskAnalysis.explanation || "Not available")
      .replace("{legalImplication}", riskAnalysis.legalImplication || "Not available")
      .replace("{recommendation}", riskAnalysis.recommendation || "Not available")
      .replace("{question}", question);

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
            content: "You are a legal expert specializing in commercial contract analysis."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.2,
        max_tokens: 700
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
    const answer = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";

    if (typeof answer !== "string" || !answer.trim()) {
      context.res = {
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: { error: "Model returned an empty follow-up answer." }
      };
      return;
    }

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        answer: answer.trim()
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
