import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, AlertCircle, Loader2, Shield, Zap, Settings, MessageSquare, ArrowDownUp, RefreshCw, Download, StickyNote, X } from 'lucide-react';
import type { Difference, RiskAnalysis, Note } from '../types';
import { askRiskFollowUp } from '../services/riskAnalysis';
import { NotesPanel } from './NotesPanel';

interface RiskAnalysisPanelProps {
  differences: Difference[];
  riskAnalyses: RiskAnalysis[];
  notes: Note[];
  selectedDiffId: string | null;
  isAnalyzing: boolean;
  analysisProgress: { completed: number; total: number };
  onAnalyze: () => void;
  isConfigured: boolean;
  onConfigure: () => void;
  onOpenSettings: () => void;
  onExport: () => void;
  canExport: boolean;
  onNewComparison: () => void;
  onSelectDiff: (id: string) => void;
  onAddNote: (note: Note) => void;
  onUpdateNote: (note: Note) => void;
  onDeleteNote: (noteId: string) => void;
}

export function RiskAnalysisPanel({
  differences,
  riskAnalyses,
  notes,
  selectedDiffId,
  isAnalyzing,
  analysisProgress,
  onAnalyze,
  isConfigured,
  onConfigure,
  onOpenSettings,
  onExport,
  canExport,
  onNewComparison,
  onSelectDiff,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
}: RiskAnalysisPanelProps) {
  const [riskOrderMode, setRiskOrderMode] = useState<'risk' | 'document'>(() => {
    try {
      const saved = localStorage.getItem('risk-order-mode');
      return saved === 'document' ? 'document' : 'risk';
    } catch {
      return 'risk';
    }
  });
  const [notesDiffId, setNotesDiffId] = useState<string | null>(null);
  const [followUpQuestion, setFollowUpQuestion] = useState('');
  const [isAskingFollowUp, setIsAskingFollowUp] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [followUpByDifference, setFollowUpByDifference] = useState<
    Record<string, Array<{ question: string; answer: string; askedAt: Date }>>
  >({});

  useEffect(() => {
    setFollowUpQuestion('');
    setFollowUpError(null);
  }, [selectedDiffId]);

  useEffect(() => {
    try {
      localStorage.setItem('risk-order-mode', riskOrderMode);
    } catch {
      // Ignore localStorage errors.
    }
  }, [riskOrderMode]);

  const selectedRisk = selectedDiffId
    ? riskAnalyses.find((r) => r.differenceId === selectedDiffId)
    : null;
  const selectedDifference = selectedDiffId
    ? differences.find((d) => d.id === selectedDiffId) || null
    : null;
  const selectedIsError = selectedRisk?.status === 'error';
  const selectedFollowUps =
    selectedDiffId && followUpByDifference[selectedDiffId]
      ? followUpByDifference[selectedDiffId]
      : [];

  const analyzedRisks = riskAnalyses.filter((r) => r.status !== 'error');
  const errorCount = riskAnalyses.filter((r) => r.status === 'error').length;
  const differenceOrder = new Map(differences.map((difference, index) => [difference.id, index]));
  const riskIndexOrder = new Map(
    riskAnalyses.map((riskAnalysis, index) => [riskAnalysis.differenceId, index])
  );
  const notesByDifference = notes.reduce<Record<string, number>>((accumulator, note) => {
    if (note.differenceId) {
      accumulator[note.differenceId] = (accumulator[note.differenceId] || 0) + 1;
    }
    return accumulator;
  }, {});

  const summary = {
    high: analyzedRisks.filter((r) => r.riskLevel === 'high').length,
    medium: analyzedRisks.filter((r) => r.riskLevel === 'medium').length,
    low: analyzedRisks.filter((r) => r.riskLevel === 'low').length,
  };
  const orderedRisks = useMemo(() => {
    const rank = (risk: RiskAnalysis): number => {
      if (risk.status === 'error') return 3;
      if (risk.riskLevel === 'high') return 0;
      if (risk.riskLevel === 'medium') return 1;
      if (risk.riskLevel === 'low') return 2;
      return 3;
    };

    return [...riskAnalyses].sort((left, right) => {
      const leftOrder =
        differenceOrder.get(left.differenceId) ??
        riskIndexOrder.get(left.differenceId) ??
        Number.MAX_SAFE_INTEGER;
      const rightOrder =
        differenceOrder.get(right.differenceId) ??
        riskIndexOrder.get(right.differenceId) ??
        Number.MAX_SAFE_INTEGER;

      if (riskOrderMode === 'document') {
        return leftOrder - rightOrder;
      }

      const rankDelta = rank(left) - rank(right);
      if (rankDelta !== 0) {
        return rankDelta;
      }

      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }

      return leftOrder - rightOrder;
    });
  }, [differenceOrder, riskAnalyses, riskIndexOrder, riskOrderMode]);

  const getRiskIcon = (level: string, isError?: boolean) => {
    if (isError) {
      return <AlertTriangle className="w-5 h-5 text-slate-400" />;
    }
    switch (level) {
      case 'high':
        return <AlertTriangle className="w-5 h-5 text-red-500" />;
      case 'medium':
        return <AlertCircle className="w-5 h-5 text-amber-500" />;
      case 'low':
        return <CheckCircle className="w-5 h-5 text-emerald-500" />;
      default:
        return <Shield className="w-5 h-5 text-slate-400" />;
    }
  };

  const getRiskBgColor = (level: string, isError?: boolean) => {
    if (isError) {
      return 'bg-slate-50 border-slate-200';
    }
    switch (level) {
      case 'high':
        return 'bg-gradient-to-br from-red-50 to-rose-50 border-red-200';
      case 'medium':
        return 'bg-gradient-to-br from-amber-50 to-orange-50 border-amber-200';
      case 'low':
        return 'bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-200';
      default:
        return 'bg-slate-50 border-slate-200';
    }
  };

  const handleAskFollowUp = async () => {
    if (!selectedDiffId || !selectedRisk || !selectedDifference) {
      return;
    }

    const question = followUpQuestion.trim();
    if (!question) {
      setFollowUpError('Enter a question first.');
      return;
    }

    setIsAskingFollowUp(true);
    setFollowUpError(null);

    try {
      const answer = await askRiskFollowUp(selectedDifference, selectedRisk, question);
      setFollowUpByDifference((previous) => ({
        ...previous,
        [selectedDiffId]: [
          ...(previous[selectedDiffId] || []),
          { question, answer, askedAt: new Date() },
        ],
      }));
      setFollowUpQuestion('');
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : 'Failed to get follow-up answer.');
    } finally {
      setIsAskingFollowUp(false);
    }
  };

  if (!isConfigured) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-full text-center">
        <div className="p-4 bg-slate-100 rounded-2xl mb-4">
          <Settings className="w-10 h-10 text-slate-400" />
        </div>
        <h3 className="font-semibold text-slate-800 mb-2">Risk Analysis Not Configured</h3>
        <p className="text-sm text-slate-500 mb-5 max-w-xs">
          Configure your OpenAI API key to enable AI-powered legal risk analysis of changes.
        </p>
        <button
          onClick={onConfigure}
          className="px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl hover:from-indigo-700 hover:to-purple-700 transition-all duration-200 font-medium shadow-lg shadow-indigo-500/25"
        >
          Configure API Key
        </button>
      </div>
    );
  }

  if (differences.length === 0) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-full text-center">
        <div className="p-4 bg-emerald-100 rounded-2xl mb-4">
          <CheckCircle className="w-10 h-10 text-emerald-500" />
        </div>
        <h3 className="font-semibold text-slate-800 mb-2">No Changes Detected</h3>
        <p className="text-sm text-slate-500">
          Upload and compare documents to see risk analysis.
        </p>
      </div>
    );
  }

  if (riskAnalyses.length === 0 && !isAnalyzing) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-full text-center">
        <div className="relative mb-4">
          <div className="absolute inset-0 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-2xl blur-lg opacity-30"></div>
          <div className="relative p-4 bg-gradient-to-br from-indigo-100 to-purple-100 rounded-2xl">
            <Shield className="w-10 h-10 text-indigo-600" />
          </div>
        </div>
        <h3 className="font-semibold text-slate-800 mb-2">Ready to Analyze</h3>
        <p className="text-sm text-slate-500 mb-5">
          <span className="font-semibold text-indigo-600">{differences.length}</span> change{differences.length > 1 ? 's' : ''} detected. Run analysis to assess legal risks.
        </p>
        <button
          onClick={onAnalyze}
          className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl hover:from-indigo-700 hover:to-purple-700 transition-all duration-200 font-medium shadow-lg shadow-indigo-500/25"
        >
          <Zap className="w-4 h-4" />
          Analyze Risks
        </button>
      </div>
    );
  }

  if (isAnalyzing) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-full text-center">
        <div className="relative mb-4">
          <div className="absolute inset-0 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full blur-xl opacity-30 animate-pulse"></div>
          <div className="relative p-4 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full">
            <Loader2 className="w-10 h-10 text-white animate-spin" />
          </div>
        </div>
        <h3 className="font-semibold text-slate-800 mb-2">Analyzing Risks...</h3>
        <p className="text-sm text-slate-500 mb-4">
          <span className="font-semibold text-indigo-600">{analysisProgress.completed}</span> of <span className="font-semibold">{analysisProgress.total}</span> changes analyzed
        </p>
        <div className="w-full max-w-xs">
          <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-300"
              style={{ width: `${(analysisProgress.completed / analysisProgress.total) * 100}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-indigo-600" />
            <h3 className="font-semibold text-slate-800">Risk Analysis</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onExport()}
              disabled={!canExport}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-slate-100 text-slate-700 rounded-lg border border-slate-200 hover:bg-slate-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Export report"
            >
              <Download className="w-3.5 h-3.5" />
              Export
            </button>
            <button
              onClick={onOpenSettings}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-slate-100 text-slate-700 rounded-lg border border-slate-200 hover:bg-slate-200 transition-colors"
              title="Open settings"
            >
              <Settings className="w-3.5 h-3.5" />
              Settings
            </button>
            <button
              onClick={onNewComparison}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-slate-100 text-slate-700 rounded-lg border border-slate-200 hover:bg-slate-200 transition-colors"
              title="Start a new comparison"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              New
            </button>
            <div className="inline-flex items-center rounded-lg border border-slate-200 overflow-hidden">
              <button
                onClick={() => setRiskOrderMode('risk')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  riskOrderMode === 'risk'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
                title="Sort by risk level"
              >
                <ArrowDownUp className="w-3.5 h-3.5" />
                High to Low
              </button>
              <button
                onClick={() => setRiskOrderMode('document')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border-l border-slate-200 transition-colors ${
                  riskOrderMode === 'document'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
                title="Sort by document order"
              >
                Document
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="p-4 bg-gradient-to-br from-slate-50 to-slate-100 border-b border-slate-100">
        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 bg-gradient-to-br from-red-50 to-rose-50 rounded-xl border border-red-200 text-center">
            <div className="text-2xl font-bold text-red-600">{summary.high}</div>
            <div className="text-xs font-medium text-red-500">High Risk</div>
          </div>
          <div className="p-3 bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl border border-amber-200 text-center">
            <div className="text-2xl font-bold text-amber-600">{summary.medium}</div>
            <div className="text-xs font-medium text-amber-500">Medium</div>
          </div>
          <div className="p-3 bg-gradient-to-br from-emerald-50 to-teal-50 rounded-xl border border-emerald-200 text-center">
            <div className="text-2xl font-bold text-emerald-600">{summary.low}</div>
            <div className="text-xs font-medium text-emerald-500">Low Risk</div>
          </div>
        </div>
        {errorCount > 0 && (
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <AlertTriangle className="w-4 h-4 text-slate-400" />
            <span>{errorCount} change{errorCount > 1 ? 's' : ''} failed to analyze</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {selectedRisk ? (
          <div className={`p-4 rounded-xl border-2 ${getRiskBgColor(selectedRisk.riskLevel, selectedIsError)}`}>
            <div className="flex items-center gap-2 mb-4">
              {getRiskIcon(selectedRisk.riskLevel, selectedIsError)}
              <span className="font-semibold text-slate-800 capitalize">
                {selectedIsError ? 'Analysis Error' : `${selectedRisk.riskLevel} Risk`}
              </span>
              <span className="px-2 py-0.5 bg-white/60 rounded-lg text-xs font-medium text-slate-600">
                {selectedRisk.category}
              </span>
            </div>

            <div className="space-y-4">
              <div>
                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">What Changed</h4>
                <p className="text-sm text-slate-700">{selectedRisk.explanation}</p>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Legal Implication</h4>
                <p className="text-sm text-slate-700">{selectedRisk.legalImplication}</p>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Recommendation</h4>
                <p className="text-sm text-slate-700">{selectedRisk.recommendation}</p>
              </div>

              {selectedIsError && selectedRisk.error && (
                <div>
                  <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Error Details</h4>
                  <p className="text-sm text-slate-600">{selectedRisk.error}</p>
                </div>
              )}

              {!selectedIsError && (
                <div className="pt-2 border-t border-slate-200/70">
                  <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                    Ask AI About This Risk
                  </h4>
                  <textarea
                    value={followUpQuestion}
                    onChange={(event) => setFollowUpQuestion(event.target.value)}
                    placeholder="Ask a follow-up question for this specific risk analysis..."
                    rows={3}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white/80 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  />
                  {followUpError && (
                    <p className="text-xs text-red-600 mt-2">{followUpError}</p>
                  )}
                  <button
                    onClick={handleAskFollowUp}
                    disabled={isAskingFollowUp || followUpQuestion.trim().length === 0}
                    className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-indigo-100 text-indigo-700 rounded-lg border border-indigo-200 hover:bg-indigo-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isAskingFollowUp ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <MessageSquare className="w-3.5 h-3.5" />
                    )}
                    {isAskingFollowUp ? 'Asking...' : 'Ask AI'}
                  </button>

                  {selectedFollowUps.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {selectedFollowUps.map((item, index) => (
                        <div key={`${selectedDiffId}-followup-${index}`} className="p-2 rounded-lg bg-white/70 border border-slate-200">
                          <p className="text-xs font-semibold text-slate-600">Q: {item.question}</p>
                          <p className="text-sm text-slate-700 mt-1">A: {item.answer}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500 text-center">
            Select a change to see full risk details
          </p>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
              All Risks ({orderedRisks.length})
            </h4>
            <span className="text-[11px] font-medium text-slate-500">
              Sorted by: {riskOrderMode === 'risk' ? 'Risk Level' : 'Document Order'}
            </span>
          </div>
          {orderedRisks.map((risk) => {
            const isError = risk.status === 'error';
            const selected = selectedDiffId === risk.differenceId;
            const noteCount = notesByDifference[risk.differenceId] || 0;
            return (
              <div
                key={risk.differenceId}
                onClick={() => onSelectDiff(risk.differenceId)}
                className={`p-3 rounded-xl border cursor-pointer transition-colors ${
                  selected ? 'ring-2 ring-indigo-200 border-indigo-300' : ''
                } ${getRiskBgColor(risk.riskLevel, isError)} hover:border-slate-300`}
              >
                <div className="flex items-center gap-2 mb-1">
                  {getRiskIcon(risk.riskLevel, isError)}
                  <span className="text-sm font-semibold text-slate-800 capitalize">
                    {isError ? 'Analysis Error' : `${risk.riskLevel} Risk`}
                  </span>
                  <span className="px-2 py-0.5 bg-white/60 rounded-lg text-xs font-medium text-slate-600">
                    {risk.category}
                  </span>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectDiff(risk.differenceId);
                      setNotesDiffId(risk.differenceId);
                    }}
                    className="ml-auto inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-white/80 text-slate-700 rounded-lg border border-slate-200 hover:bg-white transition-colors"
                    title="Open notes for this risk"
                  >
                    <StickyNote className="w-3 h-3" />
                    Notes {noteCount > 0 ? `(${noteCount})` : ''}
                  </button>
                </div>
                <p className="text-sm text-slate-700 line-clamp-2">{risk.explanation}</p>
              </div>
            );
          })}
        </div>
      </div>

      {notesDiffId && (
        <div className="absolute inset-0 z-20 bg-slate-900/25 p-4">
          <div className="h-full bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StickyNote className="w-4 h-4 text-amber-500" />
                <h4 className="text-sm font-semibold text-slate-800">Notes for Selected Risk</h4>
              </div>
              <button
                onClick={() => setNotesDiffId(null)}
                className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
                title="Close notes"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <NotesPanel
                notes={notes}
                selectedDiffId={notesDiffId}
                differences={differences}
                onAddNote={onAddNote}
                onUpdateNote={onUpdateNote}
                onDeleteNote={onDeleteNote}
              />
            </div>
          </div>
        </div>
      )}

      {/* Re-analyze button */}
      <div className="p-4 border-t border-slate-100">
        <button
          onClick={onAnalyze}
          disabled={isAnalyzing}
          className="w-full px-4 py-2.5 text-sm font-medium bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all duration-200 disabled:opacity-50"
        >
          Re-analyze All Changes
        </button>
      </div>
    </div>
  );
}
