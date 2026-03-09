
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Settings,
  Shield,
  Upload,
  X,
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import {
  AlignmentType,
  BorderStyle,
  Document as DocxDocument,
  PageOrientation,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type {
  ChangeResponse,
  ChangeResponseStatus,
  Comparison,
  Customer,
  CustomerColor,
  DefaultOriginalAgreement,
  Difference,
  Document,
  RiskAnalysis,
} from './types';
import { computeDiff, generateInlineDiffHTML } from './services/diffEngine';
import { extractText, getFileType } from './services/extractText';
import { analyzeAllRisks, analyzeRiskExpanded, askRiskFollowUp, isConfigured } from './services/riskAnalysis';
import {
  clearDefaultOriginalAgreement,
  createCustomer,
  deriveInitials,
  generateId,
  hydrateFromBackend,
  getChangeResponsesForComparison,
  getComparisons,
  getCustomers,
  getDefaultOriginalAgreement,
  saveChangeResponse,
  saveComparison,
  saveDefaultOriginalAgreement,
} from './services/storage';

type AppRoute =
  | { type: 'upload'; customerId: string | null }
  | { type: 'customer'; customerId: string }
  | { type: 'review'; comparisonId: string }
  | { type: 'settings' };

type UploadKind = 'original' | 'proposed';
type ExportFormat = 'pdf' | 'docx' | 'email';

type UploadState = {
  processing: boolean;
  progress: number;
  error: string | null;
};

type DraftStatus = Exclude<ChangeResponseStatus, 'pending'> | null;
type ExportChangeTone = 'neutral' | 'added' | 'removed';

type ExportChangePart = {
  label: string;
  text: string;
  tone: ExportChangeTone;
  strike?: boolean;
};

type ExportRow = {
  index: number;
  section: string;
  changeParts: ExportChangePart[];
  risk: string;
  type: Difference['type'];
  response: ChangeResponseStatus;
  comment: string;
};

const COLOR_BADGE_CLASS: Record<CustomerColor, string> = {
  blue: 'bg-blue-600',
  emerald: 'bg-emerald-600',
  violet: 'bg-violet-600',
  orange: 'bg-orange-500',
  rose: 'bg-rose-600',
  cyan: 'bg-cyan-600',
};

const DEFAULT_NOTE =
  'Thank you for sharing the proposed updates. Please find our clause-by-clause response attached.';

function parseRoute(pathname: string, search: string): AppRoute {
  if (pathname === '/settings') return { type: 'settings' };

  const reviewMatch = pathname.match(/^\/comparisons\/([^/]+)\/review$/);
  if (reviewMatch) {
    return { type: 'review', comparisonId: decodeURIComponent(reviewMatch[1]) };
  }

  const customerMatch = pathname.match(/^\/customers\/([^/]+)$/);
  if (customerMatch) {
    return { type: 'customer', customerId: decodeURIComponent(customerMatch[1]) };
  }

  const params = new URLSearchParams(search);
  const customerId = params.get('customer');
  return { type: 'upload', customerId: customerId || null };
}

function toRoutePath(route: AppRoute): string {
  if (route.type === 'settings') return '/settings';
  if (route.type === 'review') return `/comparisons/${encodeURIComponent(route.comparisonId)}/review`;
  if (route.type === 'customer') return `/customers/${encodeURIComponent(route.customerId)}`;
  return route.customerId ? `/?customer=${encodeURIComponent(route.customerId)}` : '/';
}

function bytesToLabel(sizeBytes?: number): string {
  if (!sizeBytes || sizeBytes <= 0) return 'Unknown size';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function riskChipClass(level: RiskAnalysis['riskLevel'] | 'unknown'): string {
  if (level === 'high') return 'bg-red-50 text-red-700 border-red-200';
  if (level === 'medium') return 'bg-amber-50 text-amber-700 border-amber-200';
  if (level === 'low') return 'bg-emerald-50 text-emerald-700 border-emerald-100';
  return 'bg-gray-50 text-gray-600 border-gray-200';
}

function diffChipClass(type: Difference['type']): string {
  if (type === 'deletion') return 'bg-red-50 text-red-700 border-red-200';
  if (type === 'addition') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  return 'bg-blue-50 text-blue-700 border-blue-200';
}

function responseChipClass(status: ChangeResponseStatus): string {
  if (status === 'accepted') return 'bg-green-50 text-green-700';
  if (status === 'countered') return 'bg-blue-50 text-blue-700';
  if (status === 'rejected') return 'bg-red-50 text-red-700';
  if (status === 'ignored') return 'bg-slate-100 text-slate-700';
  return 'text-gray-400';
}

function responseLabel(status: ChangeResponseStatus): string {
  if (status === 'accepted') return 'Accepted';
  if (status === 'countered') return 'Counter-proposed';
  if (status === 'rejected') return 'Rejected';
  if (status === 'ignored') return 'Ignored';
  return 'Pending';
}

function topBarClass(type: Difference['type']): string {
  if (type === 'deletion') return 'bg-red-400';
  if (type === 'addition') return 'bg-emerald-400';
  return 'bg-amber-400';
}

function responseForChange(responses: ChangeResponse[], changeId: string): ChangeResponseStatus {
  return responses.find((entry) => entry.changeId === changeId)?.status || 'pending';
}

function reviewStatusForComparison(comparison: Comparison, responses: ChangeResponse[]): Comparison {
  const reviewed = comparison.differences.filter(
    (difference) => responseForChange(responses, difference.id) !== 'pending'
  ).length;

  return {
    ...comparison,
    status: reviewed === comparison.differences.length && comparison.differences.length > 0
      ? 'reviewed'
      : 'pending_review',
    changeResponses: responses,
  };
}

function asOriginalDocument(defaultOriginal: DefaultOriginalAgreement): Document {
  return {
    id: defaultOriginal.id,
    name: defaultOriginal.name,
    type: 'original',
    fileType: defaultOriginal.fileType,
    text: defaultOriginal.text,
    uploadedAt: defaultOriginal.uploadedAt,
    sizeBytes: defaultOriginal.sizeBytes,
  };
}

function normalizeEmailText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2192/g, '->')
    .replace(/\u00A0/g, ' ');
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function riskForChange(risks: RiskAnalysis[], changeId: string): RiskAnalysis | null {
  return risks.find((entry) => entry.differenceId === changeId) || null;
}

function preserveManualRiskOverrides(
  existingRisks: RiskAnalysis[],
  newRisks: RiskAnalysis[]
): RiskAnalysis[] {
  const existingById = new Map(existingRisks.map((risk) => [risk.differenceId, risk]));

  return newRisks.map((risk) => {
    const existing = existingById.get(risk.differenceId);
    if (!existing?.manualOverride) {
      return risk;
    }

    return {
      ...risk,
      riskLevel: existing.riskLevel,
      aiConfidence: existing.aiConfidence ?? risk.aiConfidence ?? 0,
      category: existing.category,
      manualOverride: true,
      manualOverrideAt: existing.manualOverrideAt || new Date(),
      autoRiskLevel: risk.riskLevel,
      autoAiConfidence: risk.aiConfidence,
      autoCategory: risk.category,
    };
  });
}

function riskLevelForChange(risks: RiskAnalysis[], changeId: string): 'low' | 'medium' | 'high' {
  const risk = risks.find((entry) => entry.differenceId === changeId && entry.status !== 'error');
  return risk?.riskLevel || 'medium';
}

function aiConfidenceForChange(risks: RiskAnalysis[], changeId: string): number {
  const risk = risks.find((entry) => entry.differenceId === changeId && entry.status !== 'error');
  if (!risk) return 0;
  const value = risk.manualOverride ? risk.autoAiConfidence ?? risk.aiConfidence : risk.aiConfidence;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeContextSection(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '[Not available]') return null;
  return trimmed;
}

function parseDifferenceContextSections(context: string): {
  original: string | null;
  proposed: string | null;
} {
  if (!context || !context.trim()) {
    return { original: null, proposed: null };
  }

  const originalMatch = context.match(
    /Original section context:\n([\s\S]*?)(?:\n\nProposed section context:\n|$)/
  );
  const proposedMatch = context.match(/Proposed section context:\n([\s\S]*)$/);

  return {
    original: normalizeContextSection(originalMatch?.[1] ?? null),
    proposed: normalizeContextSection(proposedMatch?.[1] ?? null),
  };
}

function clampPosition(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function extractContextWindow(
  text: string,
  position: Difference['originalPosition'] | Difference['proposedPosition'] | undefined,
  maxChars = 1800
): string | null {
  const source = text || '';
  if (!source.trim()) return null;

  if (!position) {
    return source.slice(0, maxChars).trim() || null;
  }

  const safeStart = clampPosition(position.start, 0, source.length);
  const safeEnd = clampPosition(position.end, safeStart, source.length);
  const before = Math.floor(maxChars * 0.45);
  const after = Math.floor(maxChars * 0.55);
  let sliceStart = clampPosition(safeStart - before, 0, source.length);
  let sliceEnd = clampPosition(safeEnd + after, sliceStart, source.length);

  if (sliceStart > 0) {
    const nextNewline = source.indexOf('\n', sliceStart);
    if (nextNewline > sliceStart && nextNewline < sliceStart + 240) {
      sliceStart = nextNewline + 1;
    }
  }

  if (sliceEnd < source.length) {
    const previousNewline = source.lastIndexOf('\n', sliceEnd);
    if (previousNewline > sliceEnd - 240) {
      sliceEnd = previousNewline;
    }
  }

  const section = source.slice(sliceStart, sliceEnd).trim();
  return section || null;
}

function getDifferenceContextSections(
  difference: Difference,
  originalDocumentText: string,
  proposedDocumentText: string
): {
  original: string | null;
  proposed: string | null;
} {
  const parsed = parseDifferenceContextSections(difference.context || '');
  const fallbackOriginal = extractContextWindow(
    originalDocumentText,
    difference.originalPosition
  );
  const fallbackProposed = extractContextWindow(
    proposedDocumentText,
    difference.proposedPosition
  );

  return {
    original: parsed.original || fallbackOriginal,
    proposed: parsed.proposed || fallbackProposed,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function textToHtml(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function highlightSnippetInContext(
  contextText: string | null,
  snippet: string | null,
  className: 'diff-added' | 'diff-removed' | 'diff-modified'
): string | null {
  if (!contextText) return null;
  const context = contextText;
  const rawSnippet = (snippet || '').trim();
  if (!rawSnippet) {
    return textToHtml(context);
  }

  const candidates = [
    rawSnippet,
    ...rawSnippet
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 20)
      .sort((a, b) => b.length - a.length),
  ];

  let match = '';
  let index = -1;
  for (const candidate of candidates) {
    const candidateIndex = context.indexOf(candidate);
    if (candidateIndex >= 0) {
      match = candidate;
      index = candidateIndex;
      break;
    }
  }

  if (index < 0 || !match) {
    return textToHtml(context);
  }

  const before = context.slice(0, index);
  const marked = context.slice(index, index + match.length);
  const after = context.slice(index + match.length);
  return `${textToHtml(before)}<span class="diff-segment ${className}">${textToHtml(marked)}</span>${textToHtml(after)}`;
}

function toSingleLine(value: string): string {
  return normalizeEmailText(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateForExport(value: string, max = 120): string {
  const single = toSingleLine(value);
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1).trimEnd()}...`;
}

function extractSectionHeadingFromContext(context: string): string | null {
  const lines = context
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Original section context:|^Proposed section context:/i.test(line))
    .filter((line) => line !== '[Not available]');

  const numberedHeading = lines.find((line) => /^\d+(?:\.\d+){0,6}\.?\s+\S/.test(line));
  if (numberedHeading) return truncateForExport(numberedHeading, 140);

  return lines.length > 0 ? truncateForExport(lines[0], 140) : null;
}

function extractSectionForExport(difference: Difference): string {
  const fromContext = extractSectionHeadingFromContext(difference.context || '');
  if (fromContext) return fromContext;

  const source = difference.originalText || difference.proposedText || '';
  if (!source.trim()) return `Change ${difference.id}`;

  const firstLine = source
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return truncateForExport(firstLine || source, 140);
}

function buildChangePartsForExport(difference: Difference): ExportChangePart[] {
  const removed = normalizeEmailText(difference.originalText || '').trim();
  const added = normalizeEmailText(difference.proposedText || '').trim();

  if (difference.type === 'deletion') {
    return [{ label: 'Removed', text: removed || '[No text]', tone: 'removed', strike: true }];
  }
  if (difference.type === 'addition') {
    return [{ label: 'Adds', text: added || '[No text]', tone: 'added' }];
  }

  const parts: ExportChangePart[] = [];
  if (removed) parts.push({ label: 'Removed', text: removed, tone: 'removed', strike: true });
  if (added) parts.push({ label: 'Adds', text: added, tone: 'added' });
  if (parts.length === 0) parts.push({ label: 'Change', text: '[No text]', tone: 'neutral' });
  return parts;
}

function changeTypeLabel(type: Difference['type']): string {
  if (type === 'addition') return 'Addition';
  if (type === 'deletion') return 'Deletion';
  return 'Modification';
}

function riskPalette(level: string): { text: string; bg: string } {
  const normalized = (level || '').toLowerCase();
  if (normalized === 'high') return { text: 'BE123C', bg: 'FFF1F2' };
  if (normalized === 'medium') return { text: 'B45309', bg: 'FFFBEB' };
  if (normalized === 'low') return { text: '15803D', bg: 'F0FDF4' };
  return { text: '475569', bg: 'F8FAFC' };
}

function responsePalette(status: ChangeResponseStatus): { text: string; bg: string } {
  if (status === 'accepted') return { text: '15803D', bg: 'F0FDF4' };
  if (status === 'countered') return { text: '1D4ED8', bg: 'EFF6FF' };
  if (status === 'rejected') return { text: 'BE123C', bg: 'FFF1F2' };
  if (status === 'ignored') return { text: '475569', bg: 'F1F5F9' };
  return { text: '64748B', bg: 'F8FAFC' };
}

function toneColor(tone: ExportChangeTone): string {
  if (tone === 'added') return '15803D';
  if (tone === 'removed') return 'BE123C';
  return '334155';
}

function App() {
  const [pathState, setPathState] = useState({
    pathname: window.location.pathname,
    search: window.location.search,
  });

  const [customers, setCustomers] = useState<Customer[]>(() => getCustomers());
  const [comparisons, setComparisons] = useState<Comparison[]>(() => getComparisons());
  const [defaultOriginal, setDefaultOriginal] = useState<DefaultOriginalAgreement | null>(() =>
    getDefaultOriginalAgreement()
  );

  const [sidebarAdding, setSidebarAdding] = useState(false);
  const [sidebarCustomerName, setSidebarCustomerName] = useState('');

  const [originalDocument, setOriginalDocument] = useState<Document | null>(null);
  const [proposedDocument, setProposedDocument] = useState<Document | null>(null);
  const [uploadState, setUploadState] = useState<Record<UploadKind, UploadState>>({
    original: { processing: false, progress: 0, error: null },
    proposed: { processing: false, progress: 0, error: null },
  });
  const [uploadCustomerId, setUploadCustomerId] = useState('');
  const [uploadAddingCustomer, setUploadAddingCustomer] = useState(false);
  const [uploadNewCustomerName, setUploadNewCustomerName] = useState('');
  const [compareError, setCompareError] = useState<string | null>(null);
  const [isComparing, setIsComparing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState({ completed: 0, total: 0 });
  const [disclaimerComparisonId, setDisclaimerComparisonId] = useState<string | null>(null);

  const [reviewIndex, setReviewIndex] = useState(0);
  const [responses, setResponses] = useState<ChangeResponse[]>([]);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>(null);
  const [draftComment, setDraftComment] = useState('');
  const [draftReadOnly, setDraftReadOnly] = useState(false);
  const [savingResponse, setSavingResponse] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [askQuestion, setAskQuestion] = useState('');
  const [askLoading, setAskLoading] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [expandedRiskLoading, setExpandedRiskLoading] = useState(false);
  const [expandedRiskError, setExpandedRiskError] = useState<string | null>(null);
  const [answersByChange, setAnswersByChange] = useState<
    Record<string, Array<{ question: string; answer: string; askedAt: Date }>>
  >({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf');
  const [coverNote, setCoverNote] = useState(DEFAULT_NOTE);

  const [defaultUploadError, setDefaultUploadError] = useState<string | null>(null);
  const [uploadingDefault, setUploadingDefault] = useState(false);

  const fileInputRefs = useRef<Record<UploadKind, HTMLInputElement | null>>({ original: null, proposed: null });
  const route = useMemo(() => parseRoute(pathState.pathname, pathState.search), [pathState]);

  const navigate = useCallback((next: AppRoute, replace = false) => {
    const nextPath = toRoutePath(next);
    if (replace) {
      window.history.replaceState({}, '', nextPath);
    } else {
      window.history.pushState({}, '', nextPath);
    }
    setPathState({ pathname: window.location.pathname, search: window.location.search });
  }, []);

  const refreshCustomers = useCallback(() => setCustomers(getCustomers()), []);
  const refreshComparisons = useCallback(() => setComparisons(getComparisons()), []);

  useEffect(() => {
    const onPopState = () => setPathState({ pathname: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    let active = true;

    const runHydration = async () => {
      await hydrateFromBackend();
      if (!active) return;
      setCustomers(getCustomers());
      setComparisons(getComparisons());
      setDefaultOriginal(getDefaultOriginalAgreement());
    };

    void runHydration();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (customers.length === 0) {
      setUploadCustomerId('');
      return;
    }

    if (route.type === 'upload') {
      if (route.customerId && customers.some((entry) => entry.id === route.customerId)) {
        setUploadCustomerId(route.customerId);
      } else if (!uploadCustomerId || !customers.some((entry) => entry.id === uploadCustomerId)) {
        setUploadCustomerId(customers[0].id);
      }
    }
  }, [customers, route, uploadCustomerId]);

  useEffect(() => {
    if (route.type === 'upload' && defaultOriginal && !originalDocument) {
      setOriginalDocument(asOriginalDocument(defaultOriginal));
    }
  }, [defaultOriginal, originalDocument, route]);

  const comparisonsByCustomer = useMemo(() => {
    const grouped: Record<string, Comparison[]> = {};
    comparisons.forEach((entry) => {
      if (!entry.customerId) return;
      grouped[entry.customerId] = grouped[entry.customerId] || [];
      grouped[entry.customerId].push(entry);
    });
    return grouped;
  }, [comparisons]);

  const pendingByCustomer = useMemo(() => {
    const counts: Record<string, number> = {};
    customers.forEach((customer) => {
      counts[customer.id] = (comparisonsByCustomer[customer.id] || []).filter(
        (entry) => entry.status === 'pending_review'
      ).length;
    });
    return counts;
  }, [comparisonsByCustomer, customers]);

  const currentComparison = useMemo(() => {
    if (route.type !== 'review') return null;
    return comparisons.find((entry) => entry.id === route.comparisonId) || null;
  }, [comparisons, route]);

  const currentCustomer = useMemo(() => {
    if (route.type === 'customer') {
      return customers.find((entry) => entry.id === route.customerId) || null;
    }

    if (route.type === 'review' && currentComparison) {
      return customers.find((entry) => entry.id === currentComparison.customerId) || null;
    }

    if (route.type === 'upload' && uploadCustomerId) {
      return customers.find((entry) => entry.id === uploadCustomerId) || null;
    }

    return null;
  }, [currentComparison, customers, route, uploadCustomerId]);

  const reviewDiffs = currentComparison?.differences || [];
  const reviewRisks = currentComparison?.riskAnalyses || [];
  const selectedDifference = reviewDiffs[reviewIndex] || null;
  const selectedRisk = selectedDifference ? riskForChange(reviewRisks, selectedDifference.id) : null;

  const reviewedCount = useMemo(() => {
    if (!currentComparison) return 0;
    return currentComparison.differences.filter(
      (difference) => responseForChange(responses, difference.id) !== 'pending'
    ).length;
  }, [currentComparison, responses]);

  useEffect(() => {
    if (!currentComparison) return;

    const loaded = getChangeResponsesForComparison(currentComparison.id);
    setResponses(loaded);

    setReviewIndex((previous) => {
      if (currentComparison.differences.length === 0) return 0;
      if (previous < 0) return 0;
      if (previous >= currentComparison.differences.length) return currentComparison.differences.length - 1;
      return previous;
    });
  }, [currentComparison?.id]);

  useEffect(() => {
    if (!selectedDifference) {
      setDraftStatus(null);
      setDraftComment('');
      setDraftReadOnly(false);
      setExpandedRiskError(null);
      return;
    }

    const existing = responses.find((entry) => entry.changeId === selectedDifference.id);
    if (!existing) {
      setDraftStatus(null);
      setDraftComment('');
      setDraftReadOnly(false);
      setExpandedRiskError(null);
      return;
    }

    setDraftStatus(existing.status === 'pending' ? null : existing.status);
    setDraftComment(existing.comment || '');
    setDraftReadOnly(true);
    setExpandedRiskError(null);
  }, [responses, selectedDifference?.id]);

  const handleCreateCustomer = useCallback(
    (name: string, onCreated?: (customer: Customer) => void) => {
      if (!name.trim()) return;
      const created = createCustomer(name.trim());
      refreshCustomers();
      onCreated?.(created);
    },
    [refreshCustomers]
  );

  const setUploadStepState = useCallback((kind: UploadKind, patch: Partial<UploadState>) => {
    setUploadState((previous) => ({
      ...previous,
      [kind]: {
        ...previous[kind],
        ...patch,
      },
    }));
  }, []);

  const handleFile = useCallback(
    async (file: File, kind: UploadKind) => {
      const fileType = getFileType(file);
      if (!fileType) {
        setUploadStepState(kind, { error: 'Unsupported file type.', progress: 0, processing: false });
        return;
      }

      setUploadStepState(kind, { processing: true, progress: 0, error: null });

      try {
        const text = await extractText(file, (progress) => setUploadStepState(kind, { progress }));
        if (!text.trim()) {
          throw new Error('No text extracted from file.');
        }

        const doc: Document = {
          id: generateId(),
          name: file.name,
          type: kind,
          fileType,
          text,
          uploadedAt: new Date(),
          sizeBytes: file.size,
        };

        if (kind === 'original') {
          setOriginalDocument(doc);
        } else {
          setProposedDocument(doc);
        }

        setUploadStepState(kind, { processing: false, progress: 100, error: null });
      } catch (error) {
        setUploadStepState(kind, {
          processing: false,
          progress: 0,
          error: error instanceof Error ? error.message : 'Failed to process file.',
        });
      }
    },
    [setUploadStepState]
  );

  const upsertComparison = useCallback((comparison: Comparison) => {
    saveComparison(comparison);
    refreshComparisons();
  }, [refreshComparisons]);

  const runRiskAnalysis = useCallback(
    async (comparison: Comparison) => {
      if (!comparison.differences.length || !isConfigured()) {
        return;
      }

      setIsAnalyzing(true);
      setAnalysisProgress({ completed: 0, total: comparison.differences.length });

      try {
        const analyzedRisks = await analyzeAllRisks(comparison.differences, (completed, total) => {
          setAnalysisProgress({ completed, total });
        });
        const currentComparisonState =
          getComparisons().find((entry) => entry.id === comparison.id) || comparison;
        const risks = preserveManualRiskOverrides(
          currentComparisonState.riskAnalyses || [],
          analyzedRisks
        );

        upsertComparison({
          ...currentComparisonState,
          riskAnalyses: risks,
        });
        setDisclaimerComparisonId(comparison.id);
      } finally {
        setIsAnalyzing(false);
      }
    },
    [upsertComparison]
  );

  const handleCompare = useCallback(async () => {
    if (!originalDocument || !proposedDocument || !uploadCustomerId) return;

    setCompareError(null);
    setIsComparing(true);

    try {
      const result = computeDiff(originalDocument.text, proposedDocument.text, 'word');
      const comparison: Comparison = {
        id: generateId(),
        customerId: uploadCustomerId,
        originalDocument,
        proposedDocument,
        differences: result.differences,
        riskAnalyses: [],
        groupingReviews: [],
        groupingActionLogs: [],
        notes: [],
        changeResponses: [],
        createdAt: new Date(),
        status: 'pending_review',
      };

      upsertComparison(comparison);
      navigate({ type: 'review', comparisonId: comparison.id });
      void runRiskAnalysis(comparison);
    } catch (error) {
      setCompareError(error instanceof Error ? error.message : 'Comparison failed.');
    } finally {
      setIsComparing(false);
    }
  }, [navigate, originalDocument, proposedDocument, runRiskAnalysis, uploadCustomerId, upsertComparison]);

  const saveCurrentResponse = useCallback(async () => {
    if (!currentComparison || !selectedDifference || !draftStatus) return;

    const requiresComment = draftStatus === 'countered' || draftStatus === 'rejected';
    const comment = draftComment.trim();
    if (requiresComment && !comment) return;

    setSavingResponse(true);
    try {
      saveChangeResponse(currentComparison.id, selectedDifference.id, draftStatus, comment || null);
      const nextResponses = getChangeResponsesForComparison(currentComparison.id);
      setResponses(nextResponses);

      const updatedComparison = reviewStatusForComparison(currentComparison, nextResponses);
      upsertComparison(updatedComparison);

      const pending = updatedComparison.differences
        .map((difference, index) => ({
          index,
          status: responseForChange(nextResponses, difference.id),
        }))
        .filter((entry) => entry.status === 'pending')
        .map((entry) => entry.index);

      if (pending.length > 0) {
        const nextAfterCurrent = pending.find((index) => index > reviewIndex);
        setReviewIndex(nextAfterCurrent ?? pending[0]);
      }

      setDraftReadOnly(true);
    } finally {
      setSavingResponse(false);
    }
  }, [currentComparison, draftComment, draftStatus, reviewIndex, selectedDifference, upsertComparison]);

  const setManualRiskClassification = useCallback(
    (differenceId: string, level: 'low' | 'medium' | 'high') => {
      if (!currentComparison) return;

      const now = new Date();
      const existingRisk = currentComparison.riskAnalyses.find(
        (entry) => entry.differenceId === differenceId
      );
      const difference = currentComparison.differences.find((entry) => entry.id === differenceId);

      let nextRisks: RiskAnalysis[];
      if (existingRisk) {
        nextRisks = currentComparison.riskAnalyses.map((entry) => {
          if (entry.differenceId !== differenceId) return entry;
          return {
            ...entry,
            riskLevel: level,
            aiConfidence: entry.aiConfidence ?? 0,
            manualOverride: true,
            manualOverrideAt: now,
            autoRiskLevel: entry.autoRiskLevel || entry.riskLevel,
            autoAiConfidence: entry.autoAiConfidence ?? entry.aiConfidence ?? 0,
            autoCategory: entry.autoCategory || entry.category,
          };
        });
      } else {
        nextRisks = [
          ...currentComparison.riskAnalyses,
          {
            differenceId,
            riskLevel: level,
            aiConfidence: 0,
            category: 'Manual classification',
            explanation: difference?.context || 'Manual classification applied.',
            legalImplication: 'Manual risk classification applied by reviewer.',
            recommendation: 'Use reviewer judgement for this change.',
            analyzedAt: now,
            status: 'ok',
            manualOverride: true,
            manualOverrideAt: now,
          },
        ];
      }

      upsertComparison({
        ...currentComparison,
        riskAnalyses: nextRisks,
      });
    },
    [currentComparison, upsertComparison]
  );

  const clearManualRiskClassification = useCallback(
    (differenceId: string) => {
      if (!currentComparison) return;

      const hasManual = currentComparison.riskAnalyses.some(
        (entry) => entry.differenceId === differenceId && entry.manualOverride
      );
      if (!hasManual) return;

      const nextRisks = currentComparison.riskAnalyses.map((entry) => {
        if (entry.differenceId !== differenceId || !entry.manualOverride) return entry;
        return {
          ...entry,
          riskLevel: entry.autoRiskLevel || entry.riskLevel,
          aiConfidence: entry.autoAiConfidence ?? entry.aiConfidence ?? 0,
          category: entry.autoCategory || entry.category,
          manualOverride: false,
          manualOverrideAt: undefined,
          autoRiskLevel: undefined,
          autoAiConfidence: undefined,
          autoCategory: undefined,
        };
      });

      upsertComparison({
        ...currentComparison,
        riskAnalyses: nextRisks,
      });
    },
    [currentComparison, upsertComparison]
  );

  const askRisk = useCallback(async () => {
    if (!selectedDifference || !selectedRisk) return;
    const question = askQuestion.trim();
    if (!question) return;

    setAskLoading(true);
    setAskError(null);

    try {
      const answer = await askRiskFollowUp(selectedDifference, selectedRisk, question);
      setAnswersByChange((previous) => ({
        ...previous,
        [selectedDifference.id]: [
          ...(previous[selectedDifference.id] || []),
          { question, answer, askedAt: new Date() },
        ],
      }));
      setAskQuestion('');
    } catch (error) {
      setAskError(error instanceof Error ? error.message : 'Unable to ask AI.');
    } finally {
      setAskLoading(false);
    }
  }, [askQuestion, selectedDifference, selectedRisk]);

  const runExpandedRiskAnalysisForSelected = useCallback(async () => {
    if (!currentComparison || !selectedDifference) return;

    setExpandedRiskLoading(true);
    setExpandedRiskError(null);
    try {
      const expanded = await analyzeRiskExpanded(selectedDifference);
      const existing = currentComparison.riskAnalyses.find(
        (entry) => entry.differenceId === selectedDifference.id
      );

      let merged = expanded;
      if (existing?.manualOverride) {
        merged = {
          ...expanded,
          riskLevel: existing.riskLevel,
          aiConfidence: existing.aiConfidence ?? expanded.aiConfidence ?? 0,
          category: existing.category,
          manualOverride: true,
          manualOverrideAt: existing.manualOverrideAt || new Date(),
          autoRiskLevel: expanded.riskLevel,
          autoAiConfidence: expanded.aiConfidence,
          autoCategory: expanded.category,
        };
      }

      const exists = currentComparison.riskAnalyses.some(
        (entry) => entry.differenceId === selectedDifference.id
      );
      const nextRisks = exists
        ? currentComparison.riskAnalyses.map((entry) =>
            entry.differenceId === selectedDifference.id ? merged : entry
          )
        : [...currentComparison.riskAnalyses, merged];

      upsertComparison({
        ...currentComparison,
        riskAnalyses: nextRisks,
      });
    } catch (error) {
      setExpandedRiskError(
        error instanceof Error ? error.message : 'Failed to run expanded legal analysis.'
      );
    } finally {
      setExpandedRiskLoading(false);
    }
  }, [currentComparison, selectedDifference, upsertComparison]);
  const exportResponse = useCallback(async () => {
    if (!currentComparison) return;

    const generatedAt = new Date();
    const generatedIso = generatedAt.toISOString();
    const generatedDisplay = generatedAt.toLocaleString();
    const customerName = currentCustomer?.name || 'N/A';
    const originalName = currentComparison.originalDocument?.name || 'N/A';
    const proposedName = currentComparison.proposedDocument?.name || 'N/A';
    const noteText = normalizeEmailText(coverNote || DEFAULT_NOTE).trim() || DEFAULT_NOTE;

    const exportRows: ExportRow[] = currentComparison.differences.map((difference, index) => {
      const response = responses.find((entry) => entry.changeId === difference.id);
      const risk = riskForChange(currentComparison.riskAnalyses, difference.id);
      return {
        index: index + 1,
        section: extractSectionForExport(difference),
        changeParts: buildChangePartsForExport(difference),
        risk: (risk?.riskLevel || 'unknown').toLowerCase(),
        type: difference.type,
        response: (response?.status || 'pending') as ChangeResponseStatus,
        comment: normalizeEmailText(response?.comment || '').trim() || '-',
      };
    });

    const stats = {
      total: exportRows.length,
      accepted: exportRows.filter((row) => row.response === 'accepted').length,
      countered: exportRows.filter((row) => row.response === 'countered').length,
      rejected: exportRows.filter((row) => row.response === 'rejected').length,
    };

    const metadataRows: Array<[string, string, string, string]> = [
      ['Customer', customerName, 'Original file', originalName],
      ['Proposed file', proposedName, 'Generated', generatedDisplay],
    ];

    if (exportFormat === 'email') {
      const metadataHtml = metadataRows
        .map(
          (row) => `<tr>
  <td style="padding:8px 10px;font-weight:700;color:#6B7280;border:1px solid #D1D5DB;">${escapeHtml(row[0])}</td>
  <td style="padding:8px 10px;color:#111827;border:1px solid #D1D5DB;">${escapeHtml(row[1])}</td>
  <td style="padding:8px 10px;font-weight:700;color:#6B7280;border:1px solid #D1D5DB;">${escapeHtml(row[2])}</td>
  <td style="padding:8px 10px;color:#111827;border:1px solid #D1D5DB;">${escapeHtml(row[3])}</td>
</tr>`
        )
        .join('');

      const rowsHtml = exportRows
        .map((row, rowIndex) => {
          const risk = riskPalette(row.risk);
          const response = responsePalette(row.response);
          const rowBg = rowIndex % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
          const changeHtml = row.changeParts
            .map((part) => {
              const textColor = toneColor(part.tone);
              const decoration = part.strike ? 'text-decoration:line-through;' : '';
              return `<div style="margin-bottom:8px;">
  <div style="font-size:11px;font-weight:700;color:#6B7280;">${escapeHtml(part.label)}:</div>
  <div style="font-size:12px;line-height:1.45;color:#${textColor};${decoration}">${escapeHtml(part.text).replace(/\n/g, '<br/>')}</div>
</div>`;
            })
            .join('');

          return `<tr>
  <td style="padding:8px;border:1px solid #D1D5DB;background:${rowBg};text-align:center;font-weight:700;color:#1B3A5C;">${row.index}</td>
  <td style="padding:8px;border:1px solid #D1D5DB;background:${rowBg};font-weight:700;color:#111827;">${escapeHtml(row.section)}</td>
  <td style="padding:8px;border:1px solid #D1D5DB;background:${rowBg};">${changeHtml}</td>
  <td style="padding:8px;border:1px solid #D1D5DB;background:#${risk.bg};text-align:center;">
    <div style="font-weight:700;color:#${risk.text};">${escapeHtml(row.risk.charAt(0).toUpperCase() + row.risk.slice(1))}</div>
    <div style="font-size:11px;color:#${risk.text};">${escapeHtml(changeTypeLabel(row.type))}</div>
  </td>
  <td style="padding:8px;border:1px solid #D1D5DB;background:#${response.bg};text-align:center;font-weight:700;color:#${response.text};">${escapeHtml(responseLabel(row.response))}</td>
  <td style="padding:8px;border:1px solid #D1D5DB;background:${rowBg};color:#111827;"><i>${escapeHtml(row.comment)}</i></td>
</tr>`;
        })
        .join('');

      const htmlBody = `<!doctype html><html><body style="margin:0;padding:20px;background:#F8FAFC;font-family:Segoe UI,Arial,sans-serif;color:#111827;">
<div style="max-width:1280px;margin:0 auto;background:#FFFFFF;border:1px solid #D1D5DB;padding:20px;">
  <h1 style="margin:0;color:#1B3A5C;font-size:32px;">Supplier Response</h1>
  <p style="margin:8px 0 12px;color:#6B7280;">Framework Agreement Review &middot; ${escapeHtml(generatedIso.slice(0, 10))}</p>
  <hr style="border:none;border-top:2px solid #1B3A5C;margin:0 0 16px;" />
  <table style="width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:14px;"><colgroup><col style="width:14%" /><col style="width:36%" /><col style="width:14%" /><col style="width:36%" /></colgroup>${metadataHtml}</table>
  <table style="width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:14px;"><tr>
    <td style="padding:10px;border:1px solid #D1D5DB;background:#F1F5F9;text-align:center;"><div style="font-size:24px;font-weight:700;color:#1B3A5C;">${stats.total}</div><div style="font-size:12px;color:#1B3A5C;">Total</div></td>
    <td style="padding:10px;border:1px solid #D1D5DB;background:#F0FDF4;text-align:center;"><div style="font-size:24px;font-weight:700;color:#15803D;">${stats.accepted}</div><div style="font-size:12px;color:#15803D;">Accepted</div></td>
    <td style="padding:10px;border:1px solid #D1D5DB;background:#EFF6FF;text-align:center;"><div style="font-size:24px;font-weight:700;color:#1D4ED8;">${stats.countered}</div><div style="font-size:12px;color:#1D4ED8;">Counter-proposed</div></td>
    <td style="padding:10px;border:1px solid #D1D5DB;background:#FEF2F2;text-align:center;"><div style="font-size:24px;font-weight:700;color:#BE123C;">${stats.rejected}</div><div style="font-size:12px;color:#BE123C;">Rejected</div></td>
  </tr></table>
  <div style="border-left:4px solid #1B3A5C;background:#EEF3F8;padding:10px 12px;margin-bottom:16px;color:#111827;"><i>${escapeHtml(noteText).replace(/\n/g, '<br/>')}</i></div>
  <table style="width:100%;border-collapse:collapse;table-layout:fixed;">
    <colgroup><col style="width:5%" /><col style="width:20%" /><col style="width:27%" /><col style="width:8%" /><col style="width:10%" /><col style="width:30%" /></colgroup>
    <thead><tr>
      <th style="padding:8px;border:1px solid #D1D5DB;background:#1B3A5C;color:#FFF;text-align:left;">#</th>
      <th style="padding:8px;border:1px solid #D1D5DB;background:#1B3A5C;color:#FFF;text-align:left;">Section</th>
      <th style="padding:8px;border:1px solid #D1D5DB;background:#1B3A5C;color:#FFF;text-align:left;">Change</th>
      <th style="padding:8px;border:1px solid #D1D5DB;background:#1B3A5C;color:#FFF;text-align:left;">Risk</th>
      <th style="padding:8px;border:1px solid #D1D5DB;background:#1B3A5C;color:#FFF;text-align:left;">Response</th>
      <th style="padding:8px;border:1px solid #D1D5DB;background:#1B3A5C;color:#FFF;text-align:left;">Comment</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</div></body></html>`;

      const emlContent = [
        `Subject: Supplier Response - ${customerName}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        htmlBody,
      ].join('\r\n');
      const emlBlob = new Blob([emlContent], { type: 'message/rfc822;charset=utf-8' });
      downloadBlob(emlBlob, `supplier-response-${currentComparison.id}.eml`);
      setExportOpen(false);
      return;
    }

    if (exportFormat === 'pdf') {
      const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
      const margin = 28;
      const pageHeight = pdf.internal.pageSize.getHeight();
      const pageWidth = pdf.internal.pageSize.getWidth();
      const maxWidth = pageWidth - margin * 2;
      const lineHeight = 11;
      const cellPad = 6;
      let y = margin;

      const hexToRgb = (hex: string): [number, number, number] => {
        const h = hex.replace('#', '');
        const n = h.length === 3 ? h.split('').map((c) => `${c}${c}`).join('') : h;
        return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
      };
      const setTextHex = (hex: string) => {
        const [r, g, b] = hexToRgb(hex);
        pdf.setTextColor(r, g, b);
      };
      const setFillHex = (hex: string) => {
        const [r, g, b] = hexToRgb(hex);
        pdf.setFillColor(r, g, b);
      };
      const setDrawHex = (hex: string) => {
        const [r, g, b] = hexToRgb(hex);
        pdf.setDrawColor(r, g, b);
      };

      const drawWrapped = (
        text: string,
        x: number,
        yTop: number,
        width: number,
        color = '111827',
        style: 'normal' | 'bold' | 'italic' = 'normal',
        center = false
      ): number => {
        const lines = pdf.splitTextToSize(normalizeEmailText(text || ''), Math.max(16, width - cellPad * 2));
        pdf.setFont('helvetica', style);
        pdf.setFontSize(9);
        setTextHex(color);
        lines.forEach((line: string, i: number) => {
          const ty = yTop + cellPad + lineHeight * (i + 1) - 2;
          if (center) {
            const tw = pdf.getTextWidth(line);
            pdf.text(line, x + width / 2 - tw / 2, ty);
          } else {
            pdf.text(line, x + cellPad, ty);
          }
        });
        return Math.max(1, lines.length);
      };

      const measureWrapped = (text: string, width: number): number =>
        Math.max(
          1,
          pdf.splitTextToSize(normalizeEmailText(text || ''), Math.max(16, width - cellPad * 2)).length
        );

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(28);
      setTextHex('1B3A5C');
      pdf.text('Supplier Response', margin, y + 24);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(11);
      setTextHex('6B7280');
      pdf.text(`Framework Agreement Review · ${generatedIso.slice(0, 10)}`, margin, y + 42);
      setDrawHex('1B3A5C');
      pdf.setLineWidth(1.2);
      pdf.line(margin, y + 50, pageWidth - margin, y + 50);
      y += 64;

      const metaCols = [0.14, 0.36, 0.14, 0.36].map((w) => w * maxWidth);
      metadataRows.forEach((row) => {
        let x = margin;
        row.forEach((cell, i) => {
          setFillHex('FFFFFF');
          setDrawHex('D1D5DB');
          pdf.rect(x, y, metaCols[i], 26, 'FD');
          drawWrapped(cell, x, y, metaCols[i], i % 2 === 0 ? '6B7280' : '111827', i % 2 === 0 ? 'bold' : 'normal');
          x += metaCols[i];
        });
        y += 26;
      });
      y += 10;

      const statCards = [
        { label: 'Total', value: stats.total, text: '1B3A5C', bg: 'F1F5F9' },
        { label: 'Accepted', value: stats.accepted, text: '15803D', bg: 'F0FDF4' },
        { label: 'Counter-proposed', value: stats.countered, text: '1D4ED8', bg: 'EFF6FF' },
        { label: 'Rejected', value: stats.rejected, text: 'BE123C', bg: 'FEF2F2' },
      ];
      const gap = 8;
      const cardWidth = (maxWidth - gap * 3) / 4;
      statCards.forEach((card, index) => {
        const x = margin + index * (cardWidth + gap);
        setFillHex(card.bg);
        setDrawHex('D1D5DB');
        pdf.rect(x, y, cardWidth, 62, 'FD');
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(22);
        setTextHex(card.text);
        const w = pdf.getTextWidth(String(card.value));
        pdf.text(String(card.value), x + cardWidth / 2 - w / 2, y + 27);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(9);
        const lw = pdf.getTextWidth(card.label);
        pdf.text(card.label, x + cardWidth / 2 - lw / 2, y + 43);
      });
      y += 74;

      const noteLines = pdf.splitTextToSize(noteText, maxWidth - 26);
      const noteHeight = noteLines.length * lineHeight + 14;
      setFillHex('EEF3F8');
      setDrawHex('D1D5DB');
      pdf.rect(margin, y, maxWidth, noteHeight, 'FD');
      setDrawHex('1B3A5C');
      pdf.setLineWidth(2);
      pdf.line(margin + 1, y + 1, margin + 1, y + noteHeight - 1);
      pdf.setFont('helvetica', 'italic');
      pdf.setFontSize(9);
      setTextHex('111827');
      noteLines.forEach((line: string, i: number) => pdf.text(line, margin + 10, y + 12 + i * lineHeight));
      y += noteHeight + 10;

      const colWidths = [36, 150, 225, 72, 90, maxWidth - 36 - 150 - 225 - 72 - 90];
      const drawHeaderRow = () => {
        const headers = ['#', 'Section', 'Change', 'Risk', 'Response', 'Comment'];
        let x = margin;
        headers.forEach((header, i) => {
          setFillHex('1B3A5C');
          setDrawHex('D1D5DB');
          pdf.rect(x, y, colWidths[i], 24, 'FD');
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(9);
          setTextHex('FFFFFF');
          pdf.text(header, x + cellPad, y + 15);
          x += colWidths[i];
        });
        y += 24;
      };
      drawHeaderRow();

      exportRows.forEach((row, idx) => {
        const risk = riskPalette(row.risk);
        const response = responsePalette(row.response);
        const rowBg = idx % 2 === 0 ? 'FFFFFF' : 'F8FAFC';
        const sectionH = measureWrapped(row.section, colWidths[1]) * lineHeight;
        const changeText = row.changeParts.map((part) => `${part.label}: ${part.text}`).join('\n\n');
        const changeH = measureWrapped(changeText, colWidths[2]) * lineHeight;
        const riskH = measureWrapped(`${row.risk}\n${changeTypeLabel(row.type)}`, colWidths[3]) * lineHeight;
        const responseH = measureWrapped(responseLabel(row.response), colWidths[4]) * lineHeight;
        const commentH = measureWrapped(row.comment || '-', colWidths[5]) * lineHeight;
        const rowHeight = Math.max(lineHeight, sectionH, changeH, riskH, responseH, commentH) + cellPad * 2;

        if (y + rowHeight > pageHeight - margin) {
          pdf.addPage();
          y = margin;
          drawHeaderRow();
        }

        let x = margin;
        colWidths.forEach((w, i) => {
          setFillHex(i === 3 ? risk.bg : i === 4 ? response.bg : rowBg);
          setDrawHex('D1D5DB');
          pdf.rect(x, y, w, rowHeight, 'FD');
          x += w;
        });

        drawWrapped(String(row.index), margin, y, colWidths[0], '1B3A5C', 'bold', true);
        drawWrapped(row.section, margin + colWidths[0], y, colWidths[1], '111827', 'bold');
        drawWrapped(changeText, margin + colWidths[0] + colWidths[1], y, colWidths[2], '334155');
        drawWrapped(
          `${row.risk.charAt(0).toUpperCase() + row.risk.slice(1)}\n${changeTypeLabel(row.type)}`,
          margin + colWidths[0] + colWidths[1] + colWidths[2],
          y,
          colWidths[3],
          risk.text,
          'bold',
          true
        );
        drawWrapped(
          responseLabel(row.response),
          margin + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3],
          y,
          colWidths[4],
          response.text,
          'bold',
          true
        );
        drawWrapped(
          row.comment || '-',
          margin + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + colWidths[4],
          y,
          colWidths[5],
          '111827',
          'italic'
        );

        y += rowHeight;
      });

      const pdfBlob = pdf.output('blob');
      downloadBlob(pdfBlob, `supplier-response-${currentComparison.id}.pdf`);
      setExportOpen(false);
      return;
    }

    const cellBorders = {
      top: { style: BorderStyle.SINGLE, size: 2, color: 'D1D5DB' },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: 'D1D5DB' },
      left: { style: BorderStyle.SINGLE, size: 2, color: 'D1D5DB' },
      right: { style: BorderStyle.SINGLE, size: 2, color: 'D1D5DB' },
    };

    const metadataTable = new Table({
      width: { size: 13958, type: WidthType.DXA },
      rows: metadataRows.map(
        (row) =>
          new TableRow({
            children: [
              new TableCell({ width: { size: 1800, type: WidthType.DXA }, borders: cellBorders, children: [new Paragraph({ children: [new TextRun({ text: row[0], bold: true, color: '6B7280', size: 18 })] })] }),
              new TableCell({ width: { size: 5279, type: WidthType.DXA }, borders: cellBorders, children: [new Paragraph({ children: [new TextRun({ text: row[1], color: '111827', size: 18 })] })] }),
              new TableCell({ width: { size: 1800, type: WidthType.DXA }, borders: cellBorders, children: [new Paragraph({ children: [new TextRun({ text: row[2], bold: true, color: '6B7280', size: 18 })] })] }),
              new TableCell({ width: { size: 5079, type: WidthType.DXA }, borders: cellBorders, children: [new Paragraph({ children: [new TextRun({ text: row[3], color: '111827', size: 18 })] })] }),
            ],
          })
      ),
    });

    const statsTable = new Table({
      width: { size: 13958, type: WidthType.DXA },
      rows: [
        new TableRow({
          children: [
            { label: 'Total', value: stats.total, text: '1B3A5C', bg: 'F1F5F9' },
            { label: 'Accepted', value: stats.accepted, text: '15803D', bg: 'F0FDF4' },
            { label: 'Counter-proposed', value: stats.countered, text: '1D4ED8', bg: 'EFF6FF' },
            { label: 'Rejected', value: stats.rejected, text: 'BE123C', bg: 'FEF2F2' },
          ].map((card) => new TableCell({
            width: { size: 3489, type: WidthType.DXA },
            borders: cellBorders,
            shading: { fill: card.bg },
            children: [
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(card.value), bold: true, color: card.text, size: 48 })] }),
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: card.label, color: card.text, size: 16 })] }),
            ],
          })),
        }),
      ],
    });

    const changeHeader = ['#', 'Section', 'Change', 'Risk', 'Response', 'Comment'];
    const changeWidths = [600, 2800, 3600, 1000, 1358, 4600];
    const changeRows: TableRow[] = [
      new TableRow({
        tableHeader: true,
        children: changeHeader.map((header, index) => new TableCell({
          width: { size: changeWidths[index], type: WidthType.DXA },
          borders: cellBorders,
          shading: { fill: '1B3A5C' },
          children: [new Paragraph({ children: [new TextRun({ text: header, bold: true, color: 'FFFFFF', size: 18 })] })],
        })),
      }),
    ];

    exportRows.forEach((row, rowIndex) => {
      const risk = riskPalette(row.risk);
      const response = responsePalette(row.response);
      const rowBg = rowIndex % 2 === 0 ? 'FFFFFF' : 'F8FAFC';
      const changeChildren: Paragraph[] = [];
      row.changeParts.forEach((part) => {
        changeChildren.push(
          new Paragraph({ spacing: { after: 20 }, children: [new TextRun({ text: `${part.label}:`, bold: true, color: '6B7280', size: 16 })] }),
          new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: part.text || '-', color: toneColor(part.tone), strike: !!part.strike, size: 16 })] })
        );
      });
      if (changeChildren.length === 0) changeChildren.push(new Paragraph({ text: '-' }));

      changeRows.push(new TableRow({
        children: [
          new TableCell({ width: { size: changeWidths[0], type: WidthType.DXA }, borders: cellBorders, shading: { fill: rowBg }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(row.index), bold: true, color: '1B3A5C', size: 18 })] })] }),
          new TableCell({ width: { size: changeWidths[1], type: WidthType.DXA }, borders: cellBorders, shading: { fill: rowBg }, children: [new Paragraph({ children: [new TextRun({ text: row.section, bold: true, color: '111827', size: 18 })] })] }),
          new TableCell({ width: { size: changeWidths[2], type: WidthType.DXA }, borders: cellBorders, shading: { fill: rowBg }, children: changeChildren }),
          new TableCell({ width: { size: changeWidths[3], type: WidthType.DXA }, borders: cellBorders, shading: { fill: risk.bg }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: row.risk.charAt(0).toUpperCase() + row.risk.slice(1), bold: true, color: risk.text, size: 16 })] }), new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: changeTypeLabel(row.type), color: risk.text, size: 14 })] })] }),
          new TableCell({ width: { size: changeWidths[4], type: WidthType.DXA }, borders: cellBorders, shading: { fill: response.bg }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: responseLabel(row.response), bold: true, color: response.text, size: 16 })] })] }),
          new TableCell({ width: { size: changeWidths[5], type: WidthType.DXA }, borders: cellBorders, shading: { fill: rowBg }, children: [new Paragraph({ children: [new TextRun({ text: row.comment || '-', italics: true, color: '111827', size: 18 })] })] }),
        ],
      }));
    });

    const docx = new DocxDocument({
      sections: [
        {
          properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } },
          children: [
            new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: 'Supplier Response', bold: true, color: '1B3A5C', size: 44 })] }),
            new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: `Framework Agreement Review · ${generatedIso.slice(0, 10)}`, color: '6B7280', size: 18 })] }),
            metadataTable,
            new Paragraph({ text: '' }),
            statsTable,
            new Paragraph({ text: '' }),
            new Paragraph({
              border: { left: { style: BorderStyle.SINGLE, size: 12, color: '1B3A5C' } },
              shading: { fill: 'EEF3F8' },
              indent: { left: 160 },
              spacing: { before: 80, after: 80 },
              children: [new TextRun({ text: noteText, italics: true, color: '111827', size: 18 })],
            }),
            new Paragraph({ text: '' }),
            new Table({ width: { size: 13958, type: WidthType.DXA }, rows: changeRows }),
          ],
        },
      ],
    });

    const docxBlob = await Packer.toBlob(docx);
    downloadBlob(
      docxBlob,
      `supplier-response-${currentComparison.id}.docx`
    );
    setExportOpen(false);
  }, [coverNote, currentComparison, currentCustomer?.name, exportFormat, responses]);

  const exportVerboseLog = useCallback(() => {
    const payload = {
      generatedAt: new Date().toISOString(),
      route,
      customers,
      comparisons,
      responses,
      answersByChange,
      defaultOriginal,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `agreement-verbose-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }, [answersByChange, comparisons, customers, defaultOriginal, responses, route]);

  const uploadDefaultOriginal = useCallback(async (file: File) => {
    const fileType = getFileType(file);
    if (!fileType) {
      setDefaultUploadError('Unsupported file type for default original agreement.');
      return;
    }

    setUploadingDefault(true);
    setDefaultUploadError(null);

    try {
      const text = await extractText(file);
      if (!text.trim()) throw new Error('No text extracted from file.');

      const value: DefaultOriginalAgreement = {
        id: generateId(),
        name: file.name,
        fileType,
        text,
        uploadedAt: new Date(),
        sizeBytes: file.size,
      };

      saveDefaultOriginalAgreement(value);
      setDefaultOriginal(value);
      setOriginalDocument(asOriginalDocument(value));
    } catch (error) {
      setDefaultUploadError(error instanceof Error ? error.message : 'Failed to set default original agreement.');
    } finally {
      setUploadingDefault(false);
    }
  }, []);

  const removeDefaultOriginal = useCallback(() => {
    clearDefaultOriginalAgreement();
    setDefaultOriginal(null);
  }, []);

  const renderUploadPage = () => {
    const canCompare = !!(originalDocument && proposedDocument && uploadCustomerId && !isComparing);

    return (
      <div className="px-8 py-6 bg-gray-50 h-full overflow-auto">
        <div className="max-w-5xl mx-auto space-y-6">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">New Comparison</h1>
            <p className="text-sm text-gray-500">Upload files, select customer, then run deterministic comparison.</p>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-800">Upload Documents</h2>
            </div>
            <div className="px-6 py-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <UploadBlock
                title="Original Agreement"
                accent="blue"
                value={originalDocument}
                upload={uploadState.original}
                showDefaultBadge={!!defaultOriginal && originalDocument?.id === defaultOriginal.id}
                onClear={() => setOriginalDocument(null)}
                onPick={() => fileInputRefs.current.original?.click()}
                onDropFile={(file) => void handleFile(file, 'original')}
              />

              <UploadBlock
                title="Proposed Changes"
                accent="emerald"
                value={proposedDocument}
                upload={uploadState.proposed}
                showDefaultBadge={false}
                onClear={() => setProposedDocument(null)}
                onPick={() => fileInputRefs.current.proposed?.click()}
                onDropFile={(file) => void handleFile(file, 'proposed')}
              />

              <input
                ref={(el) => {
                  fileInputRefs.current.original = el;
                }}
                type="file"
                className="hidden"
                accept=".pdf,.docx,.xlsx,.txt,.jpg,.jpeg,.png"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFile(file, 'original');
                }}
              />
              <input
                ref={(el) => {
                  fileInputRefs.current.proposed = el;
                }}
                type="file"
                className="hidden"
                accept=".pdf,.docx,.xlsx,.txt,.jpg,.jpeg,.png"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFile(file, 'proposed');
                }}
              />
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-6 space-y-4">
            <label className="text-sm font-medium text-gray-700 block">Customer</label>
            <select
              value={uploadCustomerId}
              onChange={(event) => {
                const value = event.target.value;
                if (value === '__new__') {
                  setUploadAddingCustomer(true);
                  return;
                }
                setUploadCustomerId(value);
              }}
              className="w-full h-10 rounded border border-gray-300 bg-white px-3 text-sm"
            >
              <option value="">Select customer</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
              <option value="__new__">+ New customer</option>
            </select>

            {uploadAddingCustomer && (
              <div className="border border-gray-200 rounded p-3 bg-gray-50 flex flex-col sm:flex-row gap-2">
                <input
                  value={uploadNewCustomerName}
                  onChange={(event) => setUploadNewCustomerName(event.target.value)}
                  placeholder="Customer name"
                  className="h-9 flex-1 rounded border border-gray-300 px-3 text-sm"
                />
                <button
                  onClick={() => {
                    handleCreateCustomer(uploadNewCustomerName, (customer) => {
                      setUploadCustomerId(customer.id);
                      setUploadNewCustomerName('');
                      setUploadAddingCustomer(false);
                    });
                  }}
                  className="h-9 px-3 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700"
                >
                  Add
                </button>
                <button
                  onClick={() => {
                    setUploadAddingCustomer(false);
                    setUploadNewCustomerName('');
                  }}
                  className="h-9 px-3 border border-gray-200 text-gray-600 text-sm font-medium rounded hover:bg-gray-50"
                >
                  ✕
                </button>
              </div>
            )}

            {compareError && <p className="text-sm text-red-600">{compareError}</p>}

            <button
              disabled={!canCompare}
              onClick={handleCompare}
              className={`h-10 px-4 rounded text-sm font-medium ${
                canCompare
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              {isComparing ? 'Comparing...' : 'Compare Documents'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderCustomerPage = () => {
    if (route.type !== 'customer') return null;
    const customer = customers.find((entry) => entry.id === route.customerId);
    if (!customer) {
      return (
        <div className="px-8 py-6 bg-gray-50 h-full">
          <p className="text-sm text-gray-500">Customer not found.</p>
        </div>
      );
    }

    const list = (comparisonsByCustomer[customer.id] || []).slice().sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const pending = list.filter((entry) => entry.status === 'pending_review').length;

    return (
      <div className="px-8 py-6 bg-gray-50 h-full overflow-auto">
        <div className="max-w-6xl mx-auto space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className={`w-10 h-10 rounded text-white text-sm font-bold flex items-center justify-center ${COLOR_BADGE_CLASS[customer.color]}`}>
                {customer.initials || deriveInitials(customer.name)}
              </span>
              <div>
                <h1 className="text-xl font-semibold text-gray-900">{customer.name}</h1>
                <p className="text-sm text-gray-500">
                  {list.length} comparison{list.length === 1 ? '' : 's'}{pending > 0 ? ` • ${pending} pending review` : ''}
                </p>
              </div>
            </div>
            <button
              onClick={() => navigate({ type: 'upload', customerId: customer.id })}
              className="h-10 px-4 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700"
            >
              + New Comparison
            </button>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-800">Comparison History</h2>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="text-left px-6 py-3 font-medium">Date</th>
                  <th className="text-left px-6 py-3 font-medium">Proposed File</th>
                  <th className="text-left px-6 py-3 font-medium">Changes</th>
                  <th className="text-left px-6 py-3 font-medium">Status</th>
                  <th className="text-right px-6 py-3 font-medium">View</th>
                </tr>
              </thead>
              <tbody>
                {list.map((comparison) => {
                  const changes = comparison.differences.length;
                  const changesClass = changes > 20 ? 'text-red-600' : changes > 8 ? 'text-amber-600' : 'text-emerald-600';
                  const statusClass = comparison.status === 'pending_review'
                    ? 'bg-amber-50 text-amber-700'
                    : 'bg-green-50 text-green-700';

                  return (
                    <tr key={comparison.id} className="border-t border-gray-100">
                      <td className="px-6 py-3 text-gray-700">{new Date(comparison.createdAt).toLocaleString()}</td>
                      <td className="px-6 py-3 text-gray-700">
                        <span
                          className="inline-block max-w-[32rem] whitespace-normal break-all leading-5 align-bottom"
                          title={comparison.proposedDocument?.name || 'N/A'}
                        >
                          {comparison.proposedDocument?.name || 'N/A'}
                        </span>
                      </td>
                      <td className={`px-6 py-3 font-medium ${changesClass}`}>{changes}</td>
                      <td className="px-6 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${statusClass}`}>
                          {comparison.status === 'pending_review' ? 'Pending review' : 'Reviewed'}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-right">
                        <button
                          onClick={() => navigate({ type: 'review', comparisonId: comparison.id })}
                          className="text-blue-600 hover:text-blue-700 font-medium"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {list.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-6 py-6 text-gray-500">No comparisons yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };
  const renderReviewPage = () => {
    if (route.type !== 'review' || !currentComparison) {
      return (
        <div className="px-8 py-6 bg-gray-50 h-full">
          <p className="text-sm text-gray-500">Comparison not found.</p>
        </div>
      );
    }

    if (!selectedDifference) {
      return (
        <div className="px-8 py-6 bg-gray-50 h-full">
          <p className="text-sm text-gray-500">No changes to review.</p>
        </div>
      );
    }

    const status = responseForChange(responses, selectedDifference.id);
    const riskLevel = riskLevelForChange(reviewRisks, selectedDifference.id);
    const aiConfidence = aiConfidenceForChange(reviewRisks, selectedDifference.id);
    const manualRiskOverride = !!selectedRisk?.manualOverride;
    const aiClassifiedLevel =
      selectedRisk?.manualOverride
        ? selectedRisk.autoRiskLevel || selectedRisk.riskLevel
        : selectedRisk?.riskLevel || riskLevel;
    const followUps = answersByChange[selectedDifference.id] || [];
    const submittedResponse = responses.find((entry) => entry.changeId === selectedDifference.id) || null;
    const requiresComment = draftStatus === 'countered' || draftStatus === 'rejected';
    const canSave = !!draftStatus && (!requiresComment || !!draftComment.trim()) && !savingResponse;
    const analysisPercent =
      analysisProgress.total > 0
        ? Math.max(0, Math.min(100, Math.round((analysisProgress.completed / analysisProgress.total) * 100)))
        : 0;

    const inlineHtml = generateInlineDiffHTML(
      currentComparison.originalDocument?.text || '',
      currentComparison.proposedDocument?.text || '',
      'word'
    );
    const selectedContext = getDifferenceContextSections(
      selectedDifference,
      currentComparison.originalDocument?.text || '',
      currentComparison.proposedDocument?.text || ''
    );
    const selectedContextBaseText =
      selectedDifference.type === 'deletion'
        ? selectedContext.original
        : selectedContext.proposed || selectedContext.original;
    const selectedContextSnippet =
      selectedDifference.type === 'deletion'
        ? selectedDifference.originalText
        : selectedDifference.proposedText;
    const selectedContextClass =
      selectedDifference.type === 'deletion'
        ? 'diff-removed'
        : selectedDifference.type === 'addition'
        ? 'diff-added'
        : 'diff-modified';
    const selectedContextFocusedHtml = highlightSnippetInContext(
      selectedContextBaseText,
      selectedContextSnippet,
      selectedContextClass
    );

    return (
      <div className="px-8 py-6 bg-gray-50 h-full overflow-auto">
        <div className="max-w-3xl mx-auto space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-gray-900">{currentCustomer?.name || 'Review'}</h1>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-2xl">
                <FileNamePill label="Original" value={currentComparison.originalDocument?.name || 'N/A'} />
                <FileNamePill label="Proposed" value={currentComparison.proposedDocument?.name || 'N/A'} />
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 flex-nowrap">
              <div className="inline-flex items-center border border-gray-200 rounded shrink-0">
                <button className="h-9 w-9 flex items-center justify-center hover:bg-gray-50" onClick={() => setReviewIndex((v) => Math.max(0, v - 1))}><ChevronLeft className="w-4 h-4" /></button>
                <span className="w-[4.75rem] px-2 text-sm text-gray-600 whitespace-nowrap text-center tabular-nums">{reviewIndex + 1}/{reviewDiffs.length}</span>
                <button className="h-9 w-9 flex items-center justify-center hover:bg-gray-50" onClick={() => setReviewIndex((v) => Math.min(reviewDiffs.length - 1, v + 1))}><ChevronRight className="w-4 h-4" /></button>
              </div>
              <button onClick={() => setDrawerOpen(true)} className="h-9 w-[9.5rem] whitespace-nowrap shrink-0 border border-gray-200 bg-white rounded text-sm font-medium text-gray-700 hover:bg-gray-50">View Document</button>
            </div>
          </div>

          {isAnalyzing && (
            <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
                  <p className="text-sm font-medium text-gray-700">Running risk analysis</p>
                </div>
                <div className="inline-flex items-center gap-2">
                  <span className="text-xs font-semibold text-gray-600 tabular-nums">
                    {analysisProgress.completed}/{analysisProgress.total}
                  </span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-100 tabular-nums">
                    {analysisPercent}%
                  </span>
                </div>
              </div>
              <div className="mt-3 h-2.5 rounded-full bg-slate-100 overflow-hidden border border-slate-200">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-blue-500 via-indigo-500 to-cyan-400 transition-all duration-500 ease-out shadow-[0_0_8px_rgba(59,130,246,0.45)]"
                  style={{ width: `${analysisPercent}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                <span>Preparing legal risk summary</span>
                <span>Auto-run enabled</span>
              </div>
            </div>
          )}

          <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
            <div className={`h-1 ${topBarClass(selectedDifference.type)}`} />
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-2">
              <h2 className="font-semibold text-gray-800">Change {reviewIndex + 1}</h2>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-xs font-medium px-2 py-0.5 rounded border ${diffChipClass(selectedDifference.type)}`}>{selectedDifference.type}</span>
                <span className={`text-xs font-medium px-2 py-0.5 rounded border ${riskChipClass(riskLevel)}`}>{riskLevel} risk</span>
                <span className={`text-xs font-medium px-2 py-0.5 rounded ${responseChipClass(status)}`}>{responseLabel(status)}</span>
              </div>
            </div>
            <div className="p-5 space-y-3">
              {selectedDifference.type === 'deletion' && (
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Removed</p>
                  <div className="bg-red-50 border border-red-100 rounded p-3 font-mono text-sm line-through text-red-800 whitespace-pre-wrap">{selectedDifference.originalText}</div>
                </div>
              )}
              {selectedDifference.type === 'addition' && (
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Supplier adds</p>
                  <div className="bg-emerald-50 border border-emerald-100 rounded p-3 font-mono text-sm text-emerald-900 whitespace-pre-wrap">{selectedDifference.proposedText}</div>
                </div>
              )}
              {selectedDifference.type === 'modification' && (
                <>
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Changed from</p>
                    <div className="bg-amber-50 border border-amber-100 rounded p-3 font-mono text-sm text-amber-900 whitespace-pre-wrap">{selectedDifference.originalText}</div>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Supplier proposes</p>
                    <div className="bg-blue-50 border border-blue-100 rounded p-3 font-mono text-sm text-blue-900 whitespace-pre-wrap">{selectedDifference.proposedText}</div>
                  </div>
                </>
              )}
              <div className="pt-2 border-t border-gray-100">
                <button
                  onClick={() => setContextOpen(true)}
                  className="text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  View Context
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2"><Shield className="w-4 h-4 text-gray-500" /><h3 className="font-semibold text-gray-800">Risk Analysis</h3></div>
              <div className="flex items-center gap-2">
                <span className={`text-xs font-medium px-2 py-0.5 rounded border ${riskChipClass(riskLevel)}`}>
                  {riskLevel.charAt(0).toUpperCase() + riskLevel.slice(1)} Risk
                </span>
              </div>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Legal Implication</p>
                <p className="text-sm text-gray-700 mt-1 whitespace-pre-wrap">{selectedRisk?.legalImplication || 'Analysis pending.'}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Recommendation</p>
                <p className="text-sm text-gray-700 mt-1 whitespace-pre-wrap">{selectedRisk?.recommendation || 'Analysis pending.'}</p>
              </div>
              <div className="pt-3 border-t border-gray-100 flex items-center justify-between gap-3">
                <div className="text-sm text-gray-600">
                  <span className="text-gray-500">AI classified as</span>{' '}
                  <span className={`inline-flex px-2 py-0.5 rounded border text-xs font-medium ${riskChipClass(aiClassifiedLevel || riskLevel)}`}>
                    {(aiClassifiedLevel || riskLevel).charAt(0).toUpperCase() + (aiClassifiedLevel || riskLevel).slice(1)}
                  </span>
                  <span className="ml-2 text-gray-500">· {aiConfidence}% confidence</span>
                </div>
                <select
                  value={manualRiskOverride ? riskLevel : 'auto'}
                  onChange={(event) => {
                    const value = event.target.value as 'auto' | 'high' | 'medium' | 'low';
                    if (value === 'auto') {
                      clearManualRiskClassification(selectedDifference.id);
                      return;
                    }
                    setManualRiskClassification(selectedDifference.id, value);
                  }}
                  className="h-9 min-w-[9rem] rounded border border-gray-200 bg-white px-3 text-sm text-gray-700"
                >
                  <option value="auto">Override: none</option>
                  <option value="high">Override: High</option>
                  <option value="medium">Override: Medium</option>
                  <option value="low">Override: Low</option>
                </select>
              </div>
              <div className="pt-1">
                <button
                  onClick={runExpandedRiskAnalysisForSelected}
                  disabled={expandedRiskLoading}
                  className={`h-8 px-3 rounded text-sm font-medium border ${
                    expandedRiskLoading
                      ? 'border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed'
                      : 'border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100'
                  }`}
                >
                  {expandedRiskLoading ? 'Running expanded analysis...' : 'Run Expanded Legal Analysis'}
                </button>
                {selectedRisk?.analysisDetailLevel === 'expanded' && (
                  <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded border border-indigo-200 bg-indigo-50 text-indigo-700">
                    Expanded
                  </span>
                )}
                {expandedRiskError && (
                  <p className="mt-2 text-xs text-red-600">{expandedRiskError}</p>
                )}
              </div>
              <div className="pt-1">
                <button onClick={() => setAskOpen((v) => !v)} className="text-sm font-medium text-blue-600 hover:text-blue-700">Ask AI about this risk</button>
                {askOpen && (
                  <div className="mt-2 space-y-2">
                    <textarea value={askQuestion} onChange={(e) => setAskQuestion(e.target.value)} rows={3} className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
                    {askError && <p className="text-xs text-red-600">{askError}</p>}
                    <button onClick={askRisk} disabled={askLoading || askQuestion.trim().length === 0} className={`h-9 px-3 rounded text-sm font-medium ${askLoading || askQuestion.trim().length === 0 ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>{askLoading ? 'Asking...' : 'Ask AI'}</button>
                    {followUps.map((entry, index) => (
                      <div key={`${selectedDifference.id}-qa-${index}`} className="border border-gray-200 rounded p-2 bg-gray-50">
                        <p className="text-xs font-medium text-gray-500">Q: {entry.question}</p>
                        <p className="text-sm text-gray-700 mt-1">A: {entry.answer}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100"><h3 className="font-semibold text-gray-800">Your Response</h3></div>
            <div className="p-5 space-y-4">
              {draftReadOnly && status !== 'pending' ? (
                <div className="border border-gray-200 rounded p-3 bg-gray-50 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded ${responseChipClass(status)}`}>
                      {responseLabel(status)} submitted
                    </span>
                    <button
                      className="text-sm text-blue-600 hover:text-blue-700"
                      onClick={() => setDraftReadOnly(false)}
                    >
                      Edit
                    </button>
                  </div>
                  <div className="border border-gray-200 rounded bg-white px-3 py-2">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                      Submitted response
                    </p>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">
                      {submittedResponse?.comment?.trim()
                        ? submittedResponse.comment
                        : 'No comment was included for this response.'}
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                    <ActionChoice label="✓ Accept" active={draftStatus === 'accepted'} activeClass="bg-emerald-600 border-emerald-600 text-white" idleClass="border border-gray-200 text-gray-600 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700" onClick={() => setDraftStatus((v) => v === 'accepted' ? null : 'accepted')} />
                    <ActionChoice label="↩ Counter-propose" active={draftStatus === 'countered'} activeClass="bg-blue-600 border-blue-600 text-white" idleClass="border border-gray-200 text-gray-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700" onClick={() => setDraftStatus((v) => v === 'countered' ? null : 'countered')} />
                    <ActionChoice label="✕ Reject" active={draftStatus === 'rejected'} activeClass="bg-red-600 border-red-600 text-white" idleClass="border border-gray-200 text-gray-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700" onClick={() => setDraftStatus((v) => v === 'rejected' ? null : 'rejected')} />
                    <ActionChoice label="⊘ Ignore" active={draftStatus === 'ignored'} activeClass="bg-slate-600 border-slate-600 text-white" idleClass="border border-gray-200 text-gray-600 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-700" onClick={() => setDraftStatus((v) => v === 'ignored' ? null : 'ignored')} />
                  </div>

                  {draftStatus && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {draftStatus === 'countered'
                          ? 'Counter-proposal comment *'
                          : draftStatus === 'rejected'
                          ? 'Rejection reason *'
                          : draftStatus === 'ignored'
                          ? 'Optional reason for ignoring'
                          : 'Optional note'}
                      </label>
                      <textarea value={draftComment} onChange={(e) => setDraftComment(e.target.value)} rows={4} className="w-full rounded border border-gray-300 px-3 py-2 text-sm" placeholder={draftStatus === 'countered' ? 'Describe the alternative wording you propose...' : draftStatus === 'rejected' ? 'Explain why this change cannot be accepted...' : draftStatus === 'ignored' ? 'Optional note on why this change is being ignored (for example formatting-only change).' : 'Optional note to the supplier...'} />
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <button disabled={!canSave} onClick={saveCurrentResponse} className={`h-10 px-4 rounded text-sm font-medium ${canSave ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-blue-200 text-white opacity-40 cursor-not-allowed'}`}>{savingResponse ? 'Saving...' : 'Save & continue →'}</button>
                    <button onClick={() => { setDraftStatus(null); setDraftComment(''); setDraftReadOnly(false); }} className="h-10 px-4 border border-gray-200 text-gray-600 text-sm font-medium rounded hover:bg-gray-50">Clear</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {drawerOpen && (
          <div className="fixed inset-0 z-50">
            <div className="absolute inset-0 bg-black/30" onClick={() => setDrawerOpen(false)} />
            <div className="absolute right-0 top-0 h-full w-[500px] bg-white border-l border-gray-200 shadow-2xl flex flex-col">
              <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-gray-800">Full Document</h3>
                  <p className="text-sm text-gray-500">{currentComparison.proposedDocument?.name} • {reviewDiffs.length} changes</p>
                </div>
                <button onClick={() => setDrawerOpen(false)} className="p-1 rounded hover:bg-gray-100"><X className="w-4 h-4" /></button>
              </div>
              <div className="flex-1 overflow-auto p-4 space-y-3">
                <div className="text-sm font-mono whitespace-pre-wrap border border-gray-200 rounded p-3 bg-gray-50" dangerouslySetInnerHTML={{ __html: inlineHtml }} />
                {reviewDiffs.map((entry, index) => {
                  const state = responseForChange(responses, entry.id);
                  const level = riskLevelForChange(reviewRisks, entry.id);
                  const viewing = index === reviewIndex;
                  return (
                    <button key={entry.id} onClick={() => { setReviewIndex(index); setDrawerOpen(false); }} className={`w-full text-left border rounded p-3 ${viewing ? 'ring-2 ring-blue-500 border-blue-300' : 'border-gray-200 hover:border-gray-300'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded border ${diffChipClass(entry.type)}`}>{entry.type}</span>
                          <span className={`text-xs font-medium px-2 py-0.5 rounded border ${riskChipClass(level)}`}>{level}</span>
                          <span className={`text-xs font-medium px-2 py-0.5 rounded ${responseChipClass(state)}`}>{responseLabel(state)}</span>
                        </div>
                        <span className="text-xs text-gray-500">{viewing ? 'Viewing' : 'Click to review →'}</span>
                      </div>
                      <p className="text-sm text-gray-700 line-clamp-2 mt-2">{entry.proposedText || entry.originalText || entry.context}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {contextOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/40" onClick={() => setContextOpen(false)} />
            <div className="relative w-full max-w-5xl max-h-[85vh] rounded-lg shadow-2xl border border-gray-200 bg-white flex flex-col">
              <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-gray-800">Expanded Context</h3>
                  <p className="text-sm text-gray-500">
                    Surrounding section context for change {reviewIndex + 1}
                  </p>
                </div>
                <button
                  onClick={() => setContextOpen(false)}
                  className="p-1 rounded hover:bg-gray-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-auto p-6">
                <div className="border border-gray-200 rounded overflow-hidden">
                  <div className="px-4 py-2 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-3">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Expanded context with highlights
                    </p>
                    <span className="text-[11px] px-2 py-0.5 rounded border border-blue-200 bg-blue-50 text-blue-700">
                      Only selected change is highlighted
                    </span>
                  </div>
                  <div className="p-4">
                    {selectedContextFocusedHtml ? (
                      <div
                        className="text-sm text-gray-700 whitespace-pre-wrap font-mono break-words"
                        dangerouslySetInnerHTML={{ __html: selectedContextFocusedHtml }}
                      />
                    ) : (
                      <p className="text-sm text-gray-500 font-mono">[No context available for this change]</p>
                    )}
                  </div>
                </div>
              </div>
              <div className="px-6 py-4 border-t border-gray-100 flex justify-end">
                <button
                  onClick={() => setContextOpen(false)}
                  className="h-9 px-3 border border-gray-200 text-gray-600 text-sm font-medium rounded hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {exportOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/40" onClick={() => setExportOpen(false)} />
            <div className="relative w-full max-w-md rounded-lg shadow-2xl border border-gray-200 bg-white">
              <div className="px-6 py-4 border-b border-gray-100">
                <h3 className="font-semibold text-gray-800">Export Supplier Response</h3>
                <p className="text-sm text-gray-500 truncate" title={`${currentCustomer?.name} • ${currentComparison.proposedDocument?.name}`}>
                  {currentCustomer?.name} • {currentComparison.proposedDocument?.name}
                </p>
              </div>
              <div className="px-6 py-4 space-y-4">
                <div className="grid grid-cols-5 gap-1 sm:gap-2 text-center text-xs">
                  <StatCell label="Total" value={String(reviewDiffs.length)} />
                  <StatCell label="Accepted" value={String(reviewDiffs.filter((entry) => responseForChange(responses, entry.id) === 'accepted').length)} />
                  <StatCell label="Countered" value={String(reviewDiffs.filter((entry) => responseForChange(responses, entry.id) === 'countered').length)} />
                  <StatCell label="Rejected" value={String(reviewDiffs.filter((entry) => responseForChange(responses, entry.id) === 'rejected').length)} />
                  <StatCell label="Ignored" value={String(reviewDiffs.filter((entry) => responseForChange(responses, entry.id) === 'ignored').length)} />
                </div>
                {reviewedCount < reviewDiffs.length && <div className="rounded border border-amber-200 bg-amber-50 text-amber-700 text-xs px-3 py-2">{reviewDiffs.length - reviewedCount} changes remain pending.</div>}
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-1">Format</p>
                  <div className="grid grid-cols-3 gap-2">
                    <FormatChoice label="PDF Report" active={exportFormat === 'pdf'} onClick={() => setExportFormat('pdf')} />
                    <FormatChoice label="Word (.docx)" active={exportFormat === 'docx'} onClick={() => setExportFormat('docx')} />
                    <FormatChoice label="Email Draft" active={exportFormat === 'email'} onClick={() => setExportFormat('email')} />
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-1">Cover note</p>
                  <textarea rows={4} value={coverNote} onChange={(e) => setCoverNote(e.target.value)} className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
                </div>
              </div>
              <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
                <button onClick={() => setExportOpen(false)} className="h-9 px-3 border border-gray-200 text-gray-600 text-sm font-medium rounded hover:bg-gray-50">Cancel</button>
                <button onClick={exportResponse} className="h-9 px-3 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700">Export & Download</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderSettingsPage = () => (
    <div className="px-8 py-6 bg-gray-50 h-full overflow-auto">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500">Manage default original agreement and diagnostics export.</p>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-800">Default Original Agreement</h2>
          </div>
          <div className="px-6 py-4 space-y-4">
            {defaultOriginal ? (
              <div className="border border-gray-200 rounded p-3 bg-gray-50">
                <p className="text-sm font-medium text-gray-800">{defaultOriginal.name}</p>
                <p className="text-xs text-gray-500 mt-1">{bytesToLabel(defaultOriginal.sizeBytes)} • Uploaded {new Date(defaultOriginal.uploadedAt).toLocaleString()}</p>
              </div>
            ) : (
              <div className="text-sm text-gray-500 border border-dashed border-gray-300 rounded p-3">No default original agreement configured.</div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <label className="h-9 px-3 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 cursor-pointer inline-flex items-center">
                Upload new default
                <input type="file" className="hidden" accept=".pdf,.docx,.xlsx,.txt,.jpg,.jpeg,.png" onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadDefaultOriginal(file); }} />
              </label>
              <button onClick={removeDefaultOriginal} className="h-9 px-3 border border-gray-200 text-gray-600 text-sm font-medium rounded hover:bg-gray-50">Remove default</button>
            </div>
            {uploadingDefault && <p className="text-sm text-gray-500">Uploading default file...</p>}
            {defaultUploadError && <p className="text-sm text-red-600">{defaultUploadError}</p>}
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-6">
          <button onClick={exportVerboseLog} className="h-10 px-4 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700">Export Verbose Log</button>
        </div>
      </div>
    </div>
  );

  const reviewSegments = currentComparison
    ? currentComparison.differences.map((difference) => ({
        id: difference.id,
        status: responseForChange(responses, difference.id),
      }))
    : [];

  return (
    <div className="h-screen w-full flex overflow-hidden">
      <aside className="w-72 bg-gray-900 border-r border-gray-700 flex flex-col">
        <div className="px-4 py-4 border-b border-gray-700"><div className="flex items-center gap-2"><div className="bg-indigo-500 w-6 h-6 rounded flex items-center justify-center text-white"><Building2 className="w-4 h-4" /></div><span className="font-semibold text-white text-sm">Agreement Compare</span></div></div>
        <div className="px-3 pt-4 pb-2"><p className="text-xs font-bold uppercase tracking-widest text-gray-500">Customers</p></div>
        <nav className="px-3 flex-1 overflow-auto space-y-1">
          {customers.map((customer) => {
            const active = (route.type === 'customer' && route.customerId === customer.id) || (route.type === 'review' && currentComparison?.customerId === customer.id) || (route.type === 'upload' && uploadCustomerId === customer.id);
            const pending = pendingByCustomer[customer.id] || 0;
            return (
              <button key={customer.id} onClick={() => navigate({ type: 'customer', customerId: customer.id })} className={`w-full text-left text-gray-400 hover:bg-gray-800 hover:text-gray-200 rounded px-2.5 py-2 text-sm flex items-center gap-2 ${active ? 'bg-gray-700 text-white' : ''}`}>
                <span className={`w-6 h-6 rounded text-xs font-bold text-white flex items-center justify-center ${COLOR_BADGE_CLASS[customer.color]}`}>{customer.initials || deriveInitials(customer.name)}</span>
                <span className="truncate flex-1">{customer.name}</span>
                {pending > 0 && <span className="bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">{pending}</span>}
              </button>
            );
          })}

          {!sidebarAdding ? (
            <button onClick={() => setSidebarAdding(true)} className="w-full text-left text-gray-400 hover:bg-gray-800 hover:text-gray-200 rounded px-2.5 py-2 text-sm border border-dashed border-gray-700">+ Add customer</button>
          ) : (
            <div className="border border-gray-700 rounded p-2 space-y-2">
              <input value={sidebarCustomerName} onChange={(e) => setSidebarCustomerName(e.target.value)} className="w-full h-8 rounded bg-gray-800 border border-gray-700 text-gray-100 px-2 text-sm" placeholder="Customer name" />
              <div className="flex items-center gap-2">
                <button onClick={() => handleCreateCustomer(sidebarCustomerName, (customer) => { setSidebarCustomerName(''); setSidebarAdding(false); navigate({ type: 'customer', customerId: customer.id }); })} className="h-8 px-2 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-700">Add</button>
                <button onClick={() => { setSidebarAdding(false); setSidebarCustomerName(''); }} className="h-8 px-2 border border-gray-700 text-gray-300 text-xs font-medium rounded hover:bg-gray-800">✕</button>
              </div>
            </div>
          )}

          {route.type === 'review' && currentComparison && (
            <div className="mt-4 space-y-3">
              <div>
                <div className="h-1 w-full rounded bg-gray-800 overflow-hidden flex">{reviewSegments.map((segment) => <span key={segment.id} className={`h-full flex-1 ${segment.status === 'accepted' ? 'bg-emerald-400' : segment.status === 'countered' ? 'bg-blue-400' : segment.status === 'rejected' ? 'bg-red-400' : segment.status === 'ignored' ? 'bg-slate-400' : 'bg-gray-600'}`} />)}</div>
                <p className="text-xs text-gray-500 mt-2">{reviewedCount} of {currentComparison.differences.length} reviewed</p>
              </div>
              <div className="space-y-1">
                {currentComparison.differences.map((difference, index) => {
                  const state = responseForChange(responses, difference.id);
                  const level = riskLevelForChange(currentComparison.riskAnalyses, difference.id);
                  const active = index === reviewIndex;
                  return <button key={difference.id} onClick={() => setReviewIndex(index)} className={`w-full text-left text-gray-400 hover:bg-gray-800 hover:text-gray-200 rounded px-2.5 py-2 text-xs flex items-center gap-2 ${active ? 'bg-gray-700 text-white' : ''}`}><span className={`w-2 h-2 rounded-full ${level === 'high' ? 'bg-red-400' : level === 'medium' ? 'bg-amber-400' : 'bg-emerald-400'}`} /><span className="truncate flex-1">{difference.context || `Change ${index + 1}`}</span><span>{state === 'accepted' ? '✓' : state === 'countered' ? '↩' : state === 'rejected' ? '✕' : state === 'ignored' ? '⊘' : '○'}</span></button>;
                })}
              </div>
            </div>
          )}
        </nav>

        <div className="border-t border-gray-700 px-3 py-3 space-y-2">
          {route.type === 'review' && currentComparison && <button onClick={() => setExportOpen(true)} disabled={reviewedCount === 0} className={`w-full h-9 rounded text-sm font-medium ${reviewedCount === 0 ? 'text-gray-600 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>{reviewedCount === currentComparison.differences.length ? 'Export Response' : `Export (${reviewedCount}/${currentComparison.differences.length})`}</button>}
          <button onClick={() => navigate({ type: 'settings' })} className={`w-full text-left text-gray-400 hover:bg-gray-800 hover:text-gray-200 rounded px-2.5 py-2 text-sm flex items-center gap-2 ${route.type === 'settings' ? 'bg-gray-700 text-white' : ''}`}><Settings className="w-4 h-4" />Settings</button>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        {route.type === 'upload' && renderUploadPage()}
        {route.type === 'customer' && renderCustomerPage()}
        {route.type === 'review' && renderReviewPage()}
        {route.type === 'settings' && renderSettingsPage()}
      </main>

      {disclaimerComparisonId && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-white rounded-lg shadow-2xl border border-gray-200 p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-2">AI Risk Analysis Notice</h3>
            <p className="text-sm text-gray-600">This analysis is AI-generated decision support and may miss legal context. You must validate all conclusions and recommendations through your own legal and commercial review before accepting any contractual change.</p>
            <div className="mt-4 flex justify-end"><button onClick={() => setDisclaimerComparisonId(null)} className="h-9 px-3 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700">I Understand</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

type UploadBlockProps = {
  title: string;
  accent: 'blue' | 'emerald';
  value: Document | null;
  upload: UploadState;
  showDefaultBadge: boolean;
  onClear: () => void;
  onPick: () => void;
  onDropFile: (file: File) => void;
};

function UploadBlock({ title, accent, value, upload, showDefaultBadge, onClear, onPick, onDropFile }: UploadBlockProps) {
  const accentClass = accent === 'blue' ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700';

  if (value) {
    return (
      <div className={`rounded border p-4 ${accentClass}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium truncate max-w-[14rem]" title={value.name}>{value.name}</p>
              {showDefaultBadge && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-600 text-white">Default</span>}
            </div>
            <p className="text-xs opacity-80 mt-1">{bytesToLabel(value.sizeBytes)} • {value.fileType.toUpperCase()}</p>
          </div>
          <button onClick={onClear} className="p-1 rounded hover:bg-white/60"><X className="w-4 h-4" /></button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded border border-dashed border-gray-300 bg-white p-5 text-center" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files?.[0]; if (file) onDropFile(file); }}>
      <div className="flex flex-col items-center gap-2"><Upload className="w-5 h-5 text-gray-400" /><p className="text-sm font-medium text-gray-700">{title}</p><button onClick={onPick} className="h-8 px-3 border border-gray-200 text-gray-600 text-sm font-medium rounded hover:bg-gray-50">Select file</button>{upload.processing && <p className="text-xs text-gray-500">Processing... {Math.round(upload.progress)}%</p>}{upload.error && <p className="text-xs text-red-600">{upload.error}</p>}</div>
    </div>
  );
}

type ActionChoiceProps = {
  label: string;
  active: boolean;
  activeClass: string;
  idleClass: string;
  onClick: () => void;
};

function ActionChoice({ label, active, activeClass, idleClass, onClick }: ActionChoiceProps) {
  return <button onClick={onClick} className={`h-10 rounded text-sm font-medium ${active ? activeClass : idleClass}`}>{label}</button>;
}

type StatCellProps = { label: string; value: string };

function StatCell({ label, value }: StatCellProps) {
  return (
    <div className="border border-gray-200 rounded p-2 bg-gray-50 min-w-0">
      <p className="text-[11px] text-gray-500 truncate" title={label}>{label}</p>
      <p className="text-sm font-semibold text-gray-800 mt-1 truncate" title={value}>{value}</p>
    </div>
  );
}

type FormatChoiceProps = {
  label: string;
  active: boolean;
  onClick: () => void;
};

function FormatChoice({ label, active, onClick }: FormatChoiceProps) {
  return <button onClick={onClick} className={`h-9 rounded text-xs font-medium border ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>{label}</button>;
}

type FileNamePillProps = {
  label: string;
  value: string;
};

function FileNamePill({ label, value }: FileNamePillProps) {
  return (
    <div className="border border-gray-200 rounded bg-white px-3 py-2 min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className="text-sm text-gray-700 whitespace-normal break-all leading-5" title={value}>
        {value}
      </p>
    </div>
  );
}

export default App;
