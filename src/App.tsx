
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
import { analyzeAllRisks, askRiskFollowUp, isConfigured } from './services/riskAnalysis';
import {
  clearDefaultOriginalAgreement,
  createCustomer,
  deriveInitials,
  generateId,
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
  return 'text-gray-400';
}

function responseLabel(status: ChangeResponseStatus): string {
  if (status === 'accepted') return 'Accepted';
  if (status === 'countered') return 'Counter-proposed';
  if (status === 'rejected') return 'Rejected';
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

function riskForChange(risks: RiskAnalysis[], changeId: string): RiskAnalysis | null {
  return risks.find((entry) => entry.differenceId === changeId) || null;
}

function riskLevelForChange(risks: RiskAnalysis[], changeId: string): 'low' | 'medium' | 'high' {
  const risk = risks.find((entry) => entry.differenceId === changeId && entry.status !== 'error');
  return risk?.riskLevel || 'medium';
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
  const [answersByChange, setAnswersByChange] = useState<
    Record<string, Array<{ question: string; answer: string; askedAt: Date }>>
  >({});
  const [drawerOpen, setDrawerOpen] = useState(false);
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
      return;
    }

    const existing = responses.find((entry) => entry.changeId === selectedDifference.id);
    if (!existing) {
      setDraftStatus(null);
      setDraftComment('');
      setDraftReadOnly(false);
      return;
    }

    setDraftStatus(existing.status === 'pending' ? null : existing.status);
    setDraftComment(existing.comment || '');
    setDraftReadOnly(true);
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
        const risks = await analyzeAllRisks(comparison.differences, (completed, total) => {
          setAnalysisProgress({ completed, total });
        });

        upsertComparison({
          ...comparison,
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
  const exportResponse = useCallback(() => {
    if (!currentComparison) return;

    const lines: string[] = [];
    lines.push('SUPPLIER RESPONSE EXPORT');
    lines.push('========================');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Customer: ${currentCustomer?.name || 'N/A'}`);
    lines.push(`Original file: ${currentComparison.originalDocument?.name || 'N/A'}`);
    lines.push(`Proposed file: ${currentComparison.proposedDocument?.name || 'N/A'}`);
    lines.push('');
    lines.push('Cover note:');
    lines.push(coverNote);
    lines.push('');

    currentComparison.differences.forEach((difference, index) => {
      const response = responses.find((entry) => entry.changeId === difference.id);
      const risk = riskForChange(currentComparison.riskAnalyses, difference.id);
      lines.push(`#${index + 1}`);
      lines.push(`Type: ${difference.type}`);
      lines.push(`Risk: ${risk?.riskLevel || 'unknown'}`);
      lines.push(`Response: ${response?.status || 'pending'}`);
      lines.push(`Comment: ${response?.comment || '[none]'}`);
      if (difference.originalText) lines.push(`Original: ${difference.originalText}`);
      if (difference.proposedText) lines.push(`Proposed: ${difference.proposedText}`);
      lines.push('');
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const extension = exportFormat === 'email' ? 'eml' : exportFormat === 'docx' ? 'docx' : 'pdf';
    link.href = url;
    link.download = `supplier-response-${currentComparison.id}.${extension}`;
    link.click();
    URL.revokeObjectURL(url);
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
                      <td className="px-6 py-3 text-gray-700">{comparison.proposedDocument?.name || 'N/A'}</td>
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
    const followUps = answersByChange[selectedDifference.id] || [];
    const requiresComment = draftStatus === 'countered' || draftStatus === 'rejected';
    const canSave = !!draftStatus && (!requiresComment || !!draftComment.trim()) && !savingResponse;

    const inlineHtml = generateInlineDiffHTML(
      currentComparison.originalDocument?.text || '',
      currentComparison.proposedDocument?.text || '',
      'word'
    );

    return (
      <div className="px-8 py-6 bg-gray-50 h-full overflow-auto">
        <div className="max-w-3xl mx-auto space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">{currentCustomer?.name || 'Review'}</h1>
              <p className="text-sm text-gray-500">
                {currentComparison.originalDocument?.name} {'->'} {currentComparison.proposedDocument?.name}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="inline-flex items-center border border-gray-200 rounded">
                <button className="h-9 w-9 flex items-center justify-center hover:bg-gray-50" onClick={() => setReviewIndex((v) => Math.max(0, v - 1))}><ChevronLeft className="w-4 h-4" /></button>
                <span className="px-3 text-sm text-gray-600">{reviewIndex + 1} / {reviewDiffs.length}</span>
                <button className="h-9 w-9 flex items-center justify-center hover:bg-gray-50" onClick={() => setReviewIndex((v) => Math.min(reviewDiffs.length - 1, v + 1))}><ChevronRight className="w-4 h-4" /></button>
              </div>
              <button onClick={() => setDrawerOpen(true)} className="h-9 px-3 border border-gray-200 bg-white rounded text-sm font-medium text-gray-700 hover:bg-gray-50">View Document</button>
            </div>
          </div>

          {isAnalyzing && (
            <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4 flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
              <p className="text-sm text-gray-600">Running risk analysis {analysisProgress.completed}/{analysisProgress.total}</p>
            </div>
          )}

          <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
            <div className={`h-1 ${topBarClass(selectedDifference.type)}`} />
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-2">
              <h2 className="font-semibold text-gray-800">Change {reviewIndex + 1}</h2>
              <div className="flex items-center gap-2">
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
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2"><Shield className="w-4 h-4 text-gray-500" /><h3 className="font-semibold text-gray-800">Risk Analysis</h3></div>
              <span className={`text-xs font-medium px-2 py-0.5 rounded border ${riskChipClass(riskLevel)}`}>{riskLevel}</span>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Legal Implication</p>
                <p className="text-sm text-gray-700 mt-1 whitespace-pre-wrap">{selectedRisk?.legalImplication || 'Analysis pending.'}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Recommendation</p>
                <p className="text-sm text-gray-700 mt-1 whitespace-pre-wrap">{selectedRisk?.recommendation || 'Analysis pending.'}</p>
              </div>
              <div className="pt-2 border-t border-gray-100">
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
                <div className="border border-gray-200 rounded p-3 bg-gray-50 flex items-center justify-between">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${responseChipClass(status)}`}>{responseLabel(status)} saved</span>
                  <button className="text-sm text-blue-600 hover:text-blue-700" onClick={() => setDraftReadOnly(false)}>Edit</button>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <ActionChoice label="✓ Accept" active={draftStatus === 'accepted'} activeClass="bg-emerald-600 border-emerald-600 text-white" idleClass="border border-gray-200 text-gray-600 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700" onClick={() => setDraftStatus((v) => v === 'accepted' ? null : 'accepted')} />
                    <ActionChoice label="↩ Counter-propose" active={draftStatus === 'countered'} activeClass="bg-blue-600 border-blue-600 text-white" idleClass="border border-gray-200 text-gray-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700" onClick={() => setDraftStatus((v) => v === 'countered' ? null : 'countered')} />
                    <ActionChoice label="✕ Reject" active={draftStatus === 'rejected'} activeClass="bg-red-600 border-red-600 text-white" idleClass="border border-gray-200 text-gray-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700" onClick={() => setDraftStatus((v) => v === 'rejected' ? null : 'rejected')} />
                  </div>

                  {draftStatus && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {draftStatus === 'countered' ? 'Counter-proposal comment *' : draftStatus === 'rejected' ? 'Rejection reason *' : 'Optional note'}
                      </label>
                      <textarea value={draftComment} onChange={(e) => setDraftComment(e.target.value)} rows={4} className="w-full rounded border border-gray-300 px-3 py-2 text-sm" placeholder={draftStatus === 'countered' ? 'Describe the alternative wording you propose...' : draftStatus === 'rejected' ? 'Explain why this change cannot be accepted...' : 'Optional note to the supplier...'} />
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

        {exportOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/40" onClick={() => setExportOpen(false)} />
            <div className="relative w-full max-w-md rounded-lg shadow-2xl border border-gray-200 bg-white">
              <div className="px-6 py-4 border-b border-gray-100">
                <h3 className="font-semibold text-gray-800">Export Supplier Response</h3>
                <p className="text-sm text-gray-500">{currentCustomer?.name} • {currentComparison.proposedDocument?.name}</p>
              </div>
              <div className="px-6 py-4 space-y-4">
                <div className="grid grid-cols-4 gap-2 text-center text-xs">
                  <StatCell label="Total" value={String(reviewDiffs.length)} />
                  <StatCell label="Accepted" value={String(reviewDiffs.filter((entry) => responseForChange(responses, entry.id) === 'accepted').length)} />
                  <StatCell label="Countered" value={String(reviewDiffs.filter((entry) => responseForChange(responses, entry.id) === 'countered').length)} />
                  <StatCell label="Rejected" value={String(reviewDiffs.filter((entry) => responseForChange(responses, entry.id) === 'rejected').length)} />
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
                <div className="h-1 w-full rounded bg-gray-800 overflow-hidden flex">{reviewSegments.map((segment) => <span key={segment.id} className={`h-full flex-1 ${segment.status === 'accepted' ? 'bg-emerald-400' : segment.status === 'countered' ? 'bg-blue-400' : segment.status === 'rejected' ? 'bg-red-400' : 'bg-gray-600'}`} />)}</div>
                <p className="text-xs text-gray-500 mt-2">{reviewedCount} of {currentComparison.differences.length} reviewed</p>
              </div>
              <div className="space-y-1">
                {currentComparison.differences.map((difference, index) => {
                  const state = responseForChange(responses, difference.id);
                  const level = riskLevelForChange(currentComparison.riskAnalyses, difference.id);
                  const active = index === reviewIndex;
                  return <button key={difference.id} onClick={() => setReviewIndex(index)} className={`w-full text-left text-gray-400 hover:bg-gray-800 hover:text-gray-200 rounded px-2.5 py-2 text-xs flex items-center gap-2 ${active ? 'bg-gray-700 text-white' : ''}`}><span className={`w-2 h-2 rounded-full ${level === 'high' ? 'bg-red-400' : level === 'medium' ? 'bg-amber-400' : 'bg-emerald-400'}`} /><span className="truncate flex-1">{difference.context || `Change ${index + 1}`}</span><span>{state === 'accepted' ? '✓' : state === 'countered' ? '↩' : state === 'rejected' ? '✕' : '○'}</span></button>;
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
            <div className="flex items-center gap-2"><p className="text-sm font-medium truncate">{value.name}</p>{showDefaultBadge && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-600 text-white">Default</span>}</div>
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
  return <div className="border border-gray-200 rounded p-2 bg-gray-50"><p className="text-gray-500">{label}</p><p className="text-sm font-semibold text-gray-800 mt-1">{value}</p></div>;
}

type FormatChoiceProps = {
  label: string;
  active: boolean;
  onClick: () => void;
};

function FormatChoice({ label, active, onClick }: FormatChoiceProps) {
  return <button onClick={onClick} className={`h-9 rounded text-xs font-medium border ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>{label}</button>;
}

export default App;
