import type { Difference, RiskAnalysis } from '../types';

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

interface OpenAIConfig {
  apiKey: string;
  endpoint?: string; // For Azure OpenAI
  deploymentName?: string; // For Azure OpenAI
  azureApiVersion?: string; // For Azure OpenAI
  isAzure?: boolean;
  model?: string; // For OpenAI
}

let config: OpenAIConfig | null = null;

export function configureRiskAnalysis(newConfig: OpenAIConfig) {
  config = newConfig;
}

export function isConfigured(): boolean {
  return hasRiskProxyConfigured() || (config !== null && !!config.apiKey);
}

export async function analyzeRisk(difference: Difference): Promise<RiskAnalysis> {
  try {
    const parsed = hasRiskProxyConfigured()
      ? await callRiskProxy(difference)
      : await analyzeWithDirectApi(difference);

    return {
      differenceId: difference.id,
      riskLevel: normalizeRiskLevel(parsed.riskLevel),
      category: stringOrFallback(parsed.category, 'Other'),
      explanation: stringOrFallback(parsed.explanation, 'Unable to analyze this change.'),
      legalImplication: stringOrFallback(
        parsed.legalImplication,
        'Review with legal counsel recommended.'
      ),
      recommendation: stringOrFallback(parsed.recommendation, 'Consult with legal team before accepting.'),
      analyzedAt: new Date(),
      status: 'ok',
    };
  } catch (error) {
    console.error('Risk analysis failed:', error);
    return {
      differenceId: difference.id,
      riskLevel: 'medium',
      category: 'Analysis Error',
      explanation: 'Failed to analyze this change automatically.',
      legalImplication: 'Manual review required.',
      recommendation: 'Please review this change manually with your legal team.',
      analyzedAt: new Date(),
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function analyzeWithDirectApi(difference: Difference): Promise<Record<string, unknown>> {
  if (!config || !config.apiKey) {
    throw new Error('Risk analysis not configured. Please provide API key.');
  }

  const prompt = RISK_ANALYSIS_PROMPT
    .replace('{changeType}', difference.type)
    .replace('{originalText}', difference.originalText || '[None - New Addition]')
    .replace('{proposedText}', difference.proposedText || '[None - Deleted]')
    .replace('{context}', difference.context || '[No surrounding context]');

  const response = await callOpenAI(prompt);
  return parseRiskResponse(response);
}

export async function analyzeAllRisks(
  differences: Difference[],
  onProgress?: (completed: number, total: number) => void
): Promise<RiskAnalysis[]> {
  const results: RiskAnalysis[] = [];
  const total = differences.length;

  for (let i = 0; i < differences.length; i++) {
    const analysis = await analyzeRisk(differences[i]);
    results.push(analysis);

    if (onProgress) {
      onProgress(i + 1, total);
    }

    // Small delay to avoid rate limiting
    if (i < differences.length - 1) {
      await sleep(200);
    }
  }

  return results;
}

async function callOpenAI(prompt: string): Promise<string> {
  if (!config) throw new Error('Not configured');

  let url = 'https://api.openai.com/v1/chat/completions';
  if (config.isAzure) {
    const azureInfo = resolveAzureConfig(config);
    url = `${azureInfo.endpoint}/openai/deployments/${azureInfo.deploymentName}/chat/completions?api-version=${azureInfo.apiVersion}`;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.isAzure) {
    headers['api-key'] = config.apiKey;
  } else {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  const body = {
    model: config.isAzure ? undefined : config.model || 'gpt-4.1-mini',
    messages: [
      {
        role: 'system',
        content: 'You are a legal expert specializing in commercial contract analysis. Always respond with valid JSON only.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 0.3,
    max_tokens: 500,
    response_format: config.isAzure ? undefined : { type: 'json_object' },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    if (config.isAzure && response.status === 404) {
      throw new Error(
        `OpenAI API error: ${error}. Check Azure endpoint/deployment. Endpoint must be like https://<resource>.openai.azure.com (no /openai/deployments path). Deployment must exactly match your Azure deployment name.`
      );
    }
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('OpenAI API error: empty response content');
  }
  return content;
}

async function callRiskProxy(difference: Difference): Promise<Record<string, unknown>> {
  const riskProxyUrl = getRiskProxyUrl();
  if (!riskProxyUrl) {
    throw new Error('Risk proxy is not configured.');
  }

  const response = await fetch(riskProxyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ difference }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Risk proxy error: ${error}`);
  }

  const data = await response.json();
  if (!data || typeof data !== 'object') {
    throw new Error('Risk proxy returned invalid response.');
  }

  return data as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRiskLevel(value: unknown): 'low' | 'medium' | 'high' {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return 'medium';
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function parseRiskResponse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      const snippet = raw.slice(start, end + 1);
      return JSON.parse(snippet);
    }
    throw new Error('Invalid JSON response from model');
  }
}

function getRiskProxyUrl(): string | null {
  const value = import.meta.env.VITE_RISK_API_URL;
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasRiskProxyConfigured(): boolean {
  return !!getRiskProxyUrl();
}

function resolveAzureConfig(currentConfig: OpenAIConfig): {
  endpoint: string;
  deploymentName: string;
  apiVersion: string;
} {
  const normalizedEndpoint = normalizeAzureEndpoint(currentConfig.endpoint);
  const deploymentName =
    stringOrFallback(currentConfig.deploymentName, '') ||
    extractDeploymentNameFromEndpoint(currentConfig.endpoint);

  if (!normalizedEndpoint) {
    throw new Error(
      'Azure endpoint is missing. Use the resource endpoint (for example https://myresource.openai.azure.com).'
    );
  }

  if (!deploymentName) {
    throw new Error(
      'Azure deployment name is missing. Use the deployment name exactly as shown in Azure OpenAI Deployments.'
    );
  }

  return {
    endpoint: normalizedEndpoint,
    deploymentName,
    apiVersion: stringOrFallback(currentConfig.azureApiVersion, '2024-10-21'),
  };
}

function normalizeAzureEndpoint(value: string | undefined): string {
  const input = stringOrFallback(value, '');
  if (!input) return '';

  // Accept full target URIs and normalize to resource endpoint root.
  const withoutQuery = input.split('?')[0];
  const marker = '/openai/deployments/';
  const markerIndex = withoutQuery.toLowerCase().indexOf(marker);
  const root = markerIndex >= 0 ? withoutQuery.slice(0, markerIndex) : withoutQuery;
  return root.replace(/\/+$/, '');
}

function extractDeploymentNameFromEndpoint(value: string | undefined): string {
  const input = stringOrFallback(value, '');
  if (!input) return '';

  const marker = '/openai/deployments/';
  const lower = input.toLowerCase();
  const markerIndex = lower.indexOf(marker);
  if (markerIndex < 0) return '';

  const after = input.slice(markerIndex + marker.length);
  const firstSegment = after.split('/')[0];
  return firstSegment.trim();
}

/**
 * Batch analyze with smart grouping for similar changes
 */
export async function batchAnalyzeRisks(
  differences: Difference[],
  onProgress?: (completed: number, total: number) => void
): Promise<RiskAnalysis[]> {
  // For now, just use sequential analysis
  // In future, could batch similar changes together
  return analyzeAllRisks(differences, onProgress);
}
