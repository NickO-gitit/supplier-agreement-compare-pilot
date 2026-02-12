import type { Difference, GroupingReview, RiskAnalysis } from '../types';

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

interface OpenAIConfig {
  apiKey: string;
  endpoint?: string; // For Azure OpenAI
  deploymentName?: string; // For Azure OpenAI
  azureApiVersion?: string; // For Azure OpenAI
  isAzure?: boolean;
  model?: string; // For OpenAI
}

interface GroupingReviewPayload {
  difference: Difference;
  previousDifference: Difference | null;
  nextDifference: Difference | null;
  originalContext: string;
  proposedContext: string;
}

interface NormalizedGroupingResult {
  quality: 'good' | 'over_grouped' | 'over_split' | 'unclear';
  suggestedAction: 'keep' | 'split' | 'merge_with_previous' | 'merge_with_next';
  section: string;
  summary: string;
  rationale: string;
  confidence: number;
}

interface StructuralGroupingAssessment {
  quality: 'good' | 'over_grouped' | 'over_split' | 'unclear';
  suggestedAction: 'keep' | 'split' | 'merge_with_previous' | 'merge_with_next';
  confidence: number;
  rationale: string;
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

export function isGroupingReviewConfigured(): boolean {
  return hasGroupingProxyConfigured() || (config !== null && !!config.apiKey);
}

export async function analyzeGroupingReview(
  difference: Difference,
  previousDifference: Difference | null,
  nextDifference: Difference | null,
  originalText: string,
  proposedText: string
): Promise<GroupingReview> {
  const payload = buildGroupingReviewPayload(
    difference,
    previousDifference,
    nextDifference,
    originalText,
    proposedText
  );

  try {
    const parsed = hasGroupingProxyConfigured()
      ? await callGroupingReviewProxy(payload)
      : await analyzeGroupingWithDirectApi(payload);

    const modelResult = normalizeGroupingResult(parsed, payload.difference);
    const structuralResult = evaluateStructuralGrouping(payload);
    const finalResult = combineGroupingAssessments(modelResult, structuralResult);

    return {
      differenceId: difference.id,
      quality: finalResult.quality,
      suggestedAction: finalResult.suggestedAction,
      section: finalResult.section,
      summary: finalResult.summary,
      rationale: finalResult.rationale,
      confidence: finalResult.confidence,
      reviewedAt: new Date(),
      status: 'ok',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Grouping review failed:', error);
    return {
      differenceId: difference.id,
      quality: 'unclear',
      suggestedAction: 'keep',
      section: 'Unknown',
      summary: `Unable to review grouping quality automatically: ${errorMessage}`,
      rationale: 'Manual review is required for this change group.',
      confidence: 0,
      reviewedAt: new Date(),
      status: 'error',
      error: errorMessage,
    };
  }
}

export async function analyzeAllGroupingReviews(
  differences: Difference[],
  originalText: string,
  proposedText: string,
  onProgress?: (completed: number, total: number) => void
): Promise<GroupingReview[]> {
  const results: GroupingReview[] = [];
  const total = differences.length;

  for (let i = 0; i < differences.length; i++) {
    const current = differences[i];
    const previous = i > 0 ? differences[i - 1] : null;
    const next = i < differences.length - 1 ? differences[i + 1] : null;

    const review = await analyzeGroupingReview(
      current,
      previous,
      next,
      originalText,
      proposedText
    );
    results.push(review);

    if (onProgress) {
      onProgress(i + 1, total);
    }

    if (i < differences.length - 1) {
      await sleep(200);
    }
  }

  return results;
}

async function analyzeGroupingWithDirectApi(
  payload: GroupingReviewPayload
): Promise<Record<string, unknown>> {
  if (!config || !config.apiKey) {
    throw new Error('Grouping review not configured. Please provide API key.');
  }

  const prompt = GROUPING_REVIEW_PROMPT
    .replace('{selectedChange}', formatDifference(payload.difference))
    .replace('{previousChange}', payload.previousDifference ? formatDifference(payload.previousDifference) : '[None]')
    .replace('{nextChange}', payload.nextDifference ? formatDifference(payload.nextDifference) : '[None]')
    .replace('{originalContext}', payload.originalContext || '[Not available]')
    .replace('{proposedContext}', payload.proposedContext || '[Not available]');

  const response = await callOpenAI(prompt);
  return parseRiskResponse(response);
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

async function callGroupingReviewProxy(
  payload: GroupingReviewPayload
): Promise<Record<string, unknown>> {
  const url = getGroupingProxyUrl();
  if (!url) {
    throw new Error('Grouping review proxy is not configured.');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Grouping review proxy error: ${error}`);
  }

  const data = await response.json();
  if (!data || typeof data !== 'object') {
    throw new Error('Grouping review proxy returned invalid response.');
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

function normalizeGroupingQuality(
  value: unknown
): 'good' | 'over_grouped' | 'over_split' | 'unclear' {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    normalized === 'good' ||
    normalized === 'over_grouped' ||
    normalized === 'over_split' ||
    normalized === 'unclear'
  ) {
    return normalized;
  }
  return 'unclear';
}

function normalizeGroupingAction(
  value: unknown
): 'keep' | 'split' | 'merge_with_previous' | 'merge_with_next' {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    normalized === 'keep' ||
    normalized === 'split' ||
    normalized === 'merge_with_previous' ||
    normalized === 'merge_with_next'
  ) {
    return normalized;
  }
  return 'keep';
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  return 0.5;
}

function normalizeGroupingResult(
  parsed: Record<string, unknown>,
  difference: Difference
): NormalizedGroupingResult {
  const fallbackSection =
    detectClauseId(difference.originalText || '') ||
    detectClauseId(difference.proposedText || '') ||
    'Unknown';

  return {
    quality: normalizeGroupingQuality(parsed.quality),
    suggestedAction: normalizeGroupingAction(parsed.suggestedAction),
    section: stringOrFallback(parsed.section, fallbackSection),
    summary: stringOrFallback(parsed.summary, 'Grouping appears acceptable.'),
    rationale: stringOrFallback(parsed.rationale, 'No strong grouping issue identified.'),
    confidence: normalizeConfidence(parsed.confidence),
  };
}

function evaluateStructuralGrouping(payload: GroupingReviewPayload): StructuralGroupingAssessment {
  const selectedText = combineDifferenceText(payload.difference);
  const previousText = payload.previousDifference ? combineDifferenceText(payload.previousDifference) : '';
  const nextText = payload.nextDifference ? combineDifferenceText(payload.nextDifference) : '';

  const selectedTokenCount = countTokens(selectedText);
  const selectedLength = selectedText.trim().length;
  const punctuationOnly = isPunctuationOnlyChange(payload.difference);
  const fragmentScore = calculateFragmentScore(payload.difference);
  const previousSimilarity = textSimilarity(selectedText, previousText);
  const nextSimilarity = textSimilarity(selectedText, nextText);
  const strongestNeighbor =
    previousSimilarity > nextSimilarity ? 'merge_with_previous' : 'merge_with_next';
  const strongestSimilarity = Math.max(previousSimilarity, nextSimilarity);
  const similarityGap = Math.abs(previousSimilarity - nextSimilarity);
  const distinctClauseCount = countDistinctClauseMarkers(selectedText);

  if (punctuationOnly && selectedLength <= 8) {
    return {
      quality: 'good',
      suggestedAction: 'keep',
      confidence: 0.9,
      rationale: 'Standalone punctuation/numbering edit appears structurally complete.',
    };
  }

  if (
    fragmentScore >= 0.5 &&
    strongestSimilarity >= 0.26 &&
    similarityGap >= 0.04
  ) {
    return {
      quality: 'over_split',
      suggestedAction: strongestNeighbor,
      confidence: clamp01(0.65 + fragmentScore * 0.25 + strongestSimilarity * 0.2),
      rationale: 'Change appears syntactically incomplete and strongly attached to a neighboring group.',
    };
  }

  if (distinctClauseCount >= 2 || (selectedTokenCount > 55 && selectedText.includes('\n'))) {
    return {
      quality: 'over_grouped',
      suggestedAction: 'split',
      confidence: 0.78,
      rationale: 'Change appears to span multiple structural units and may be grouped too broadly.',
    };
  }

  return {
    quality: 'unclear',
    suggestedAction: 'keep',
    confidence: 0.45,
    rationale: 'No strong deterministic structural signal was detected.',
  };
}

function combineGroupingAssessments(
  model: NormalizedGroupingResult,
  structural: StructuralGroupingAssessment
): NormalizedGroupingResult {
  if (structural.quality !== 'unclear' && structural.confidence >= 0.82) {
    return {
      ...model,
      quality: structural.quality,
      suggestedAction: structural.suggestedAction,
      confidence: structural.confidence,
      summary: buildSummaryFromStructural(structural),
      rationale: `${structural.rationale} LLM perspective: ${model.rationale}`,
    };
  }

  if (
    model.quality === 'good' &&
    structural.quality !== 'unclear' &&
    structural.confidence >= 0.72
  ) {
    return {
      ...model,
      quality: structural.quality,
      suggestedAction: structural.suggestedAction,
      confidence: Math.max(model.confidence, structural.confidence),
      summary: buildSummaryFromStructural(structural),
      rationale: `${structural.rationale} LLM initially marked this as good.`,
    };
  }

  if (model.confidence < 0.5 && structural.quality !== 'unclear') {
    return {
      ...model,
      quality: structural.quality,
      suggestedAction: structural.suggestedAction,
      confidence: structural.confidence,
      summary: buildSummaryFromStructural(structural),
      rationale: structural.rationale,
    };
  }

  return model;
}

function buildSummaryFromStructural(structural: StructuralGroupingAssessment): string {
  if (structural.quality === 'over_split') {
    return 'This change likely belongs with an adjacent group based on structural continuity.';
  }
  if (structural.quality === 'over_grouped') {
    return 'This change likely contains multiple structural edits and may need splitting.';
  }
  return 'This change appears structurally complete as a standalone group.';
}

function combineDifferenceText(difference: Difference): string {
  const original = difference.originalText || '';
  const proposed = difference.proposedText || '';
  return `${original} ${proposed}`.trim();
}

function countTokens(text: string): number {
  const tokens = text.trim().match(/\S+/g);
  return tokens ? tokens.length : 0;
}

function isPunctuationOnlyChange(difference: Difference): boolean {
  const original = (difference.originalText || '').trim();
  const proposed = (difference.proposedText || '').trim();
  const value = `${original}${proposed}`.trim();
  if (!value) {
    return false;
  }
  return /^[\p{P}\p{S}\s]+$/u.test(value);
}

function calculateFragmentScore(difference: Difference): number {
  const original = difference.originalText || '';
  const proposed = difference.proposedText || '';
  const selected = combineDifferenceText(difference);

  let score = 0;
  if (countTokens(selected) <= 4 || selected.trim().length <= 20) {
    score += 0.28;
  }

  if (hasUnbalancedDelimiters(original) || hasUnbalancedDelimiters(proposed)) {
    score += 0.25;
  }

  if (endsWithConnector(original) || endsWithConnector(proposed)) {
    score += 0.24;
  }

  if (startsWithConnector(original) || startsWithConnector(proposed)) {
    score += 0.2;
  }

  if (startsMidWord(original) || startsMidWord(proposed) || endsMidWord(original) || endsMidWord(proposed)) {
    score += 0.2;
  }

  return clamp01(score);
}

function hasUnbalancedDelimiters(text: string): boolean {
  const openParens = (text.match(/\(/g) || []).length;
  const closeParens = (text.match(/\)/g) || []).length;
  const openBrackets = (text.match(/\[/g) || []).length;
  const closeBrackets = (text.match(/\]/g) || []).length;
  const openBraces = (text.match(/\{/g) || []).length;
  const closeBraces = (text.match(/\}/g) || []).length;
  const quotes = (text.match(/["']/g) || []).length;

  return (
    openParens !== closeParens ||
    openBrackets !== closeBrackets ||
    openBraces !== closeBraces ||
    quotes % 2 === 1
  );
}

function startsWithConnector(text: string): boolean {
  return /^[\s]*[,:;)\]}]/.test(text);
}

function endsWithConnector(text: string): boolean {
  return /[,:;(\[{]\s*$/.test(text);
}

function startsMidWord(text: string): boolean {
  return /^[a-z][a-z0-9-]{1,}/.test(text.trim());
}

function endsMidWord(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /[a-z0-9]$/i.test(trimmed) && !/[.!?:;)]$/.test(trimmed);
}

function countDistinctClauseMarkers(text: string): number {
  const matches = text.match(/(?:^|\n)\s*(\d+(?:\.\d+)*\.?)(?=\s|$)/g) || [];
  const normalized = matches.map((entry) =>
    entry
      .replace(/\s+/g, '')
      .replace(/\.$/, '')
      .replace(/^\n/, '')
  );
  return new Set(normalized.filter((m) => m.length > 0)).size;
}

function detectClauseId(text: string): string {
  const match = text.match(/^\s*(\d+(?:\.\d+)*\.?)/);
  return match ? match[1].replace(/\.$/, '') : '';
}

function textSimilarity(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  const leftSet = toWordSet(left);
  const rightSet = toWordSet(right);
  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap++;
    }
  }

  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 ? overlap / union : 0;
}

function toWordSet(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3);
  return new Set(words);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
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

function getGroupingProxyUrl(): string | null {
  const explicit = import.meta.env.VITE_GROUPING_REVIEW_API_URL;
  if (explicit && typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const riskUrl = getRiskProxyUrl();
  if (!riskUrl) {
    return null;
  }

  return riskUrl.replace(/\/analyze-risk\/?$/i, '/review-grouping');
}

function hasGroupingProxyConfigured(): boolean {
  return !!getGroupingProxyUrl();
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

function buildGroupingReviewPayload(
  difference: Difference,
  previousDifference: Difference | null,
  nextDifference: Difference | null,
  originalText: string,
  proposedText: string
): GroupingReviewPayload {
  return {
    difference,
    previousDifference,
    nextDifference,
    originalContext: buildContextWindow(
      originalText,
      difference.originalPosition?.start ?? 0,
      difference.originalPosition?.end ?? difference.originalPosition?.start ?? 0
    ),
    proposedContext: buildContextWindow(
      proposedText,
      difference.proposedPosition?.start ?? 0,
      difference.proposedPosition?.end ?? difference.proposedPosition?.start ?? 0
    ),
  };
}

function buildContextWindow(
  sourceText: string,
  startPosition: number,
  endPosition: number,
  radius = 220
): string {
  if (!sourceText || sourceText.length === 0) {
    return '';
  }

  const safeStart = Math.max(0, Math.min(sourceText.length, startPosition));
  const safeEnd = Math.max(safeStart, Math.min(sourceText.length, endPosition));

  const from = Math.max(0, safeStart - radius);
  const to = Math.min(sourceText.length, safeEnd + radius);
  return sourceText.slice(from, to);
}

function formatDifference(difference: Difference): string {
  return JSON.stringify(
    {
      id: difference.id,
      type: difference.type,
      originalText: difference.originalText,
      proposedText: difference.proposedText,
      context: difference.context,
    },
    null,
    2
  );
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
