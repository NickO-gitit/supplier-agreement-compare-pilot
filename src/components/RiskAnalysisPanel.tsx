import { AlertTriangle, CheckCircle, AlertCircle, Loader2, Shield, Zap, Settings } from 'lucide-react';
import type { Difference, RiskAnalysis } from '../types';

interface RiskAnalysisPanelProps {
  differences: Difference[];
  riskAnalyses: RiskAnalysis[];
  selectedDiffId: string | null;
  isAnalyzing: boolean;
  analysisProgress: { completed: number; total: number };
  onAnalyze: () => void;
  isConfigured: boolean;
  onConfigure: () => void;
  onSelectDiff: (id: string) => void;
}

export function RiskAnalysisPanel({
  differences,
  riskAnalyses,
  selectedDiffId,
  isAnalyzing,
  analysisProgress,
  onAnalyze,
  isConfigured,
  onConfigure,
  onSelectDiff,
}: RiskAnalysisPanelProps) {
  const selectedRisk = selectedDiffId
    ? riskAnalyses.find((r) => r.differenceId === selectedDiffId)
    : null;
  const selectedIsError = selectedRisk?.status === 'error';

  const analyzedRisks = riskAnalyses.filter((r) => r.status !== 'error');
  const errorCount = riskAnalyses.filter((r) => r.status === 'error').length;

  const summary = {
    high: analyzedRisks.filter((r) => r.riskLevel === 'high').length,
    medium: analyzedRisks.filter((r) => r.riskLevel === 'medium').length,
    low: analyzedRisks.filter((r) => r.riskLevel === 'low').length,
  };

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
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-indigo-600" />
          <h3 className="font-semibold text-slate-800">Risk Analysis</h3>
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

      {/* Selected Risk Detail */}
      {selectedRisk ? (
        <div className="flex-1 overflow-auto p-4">
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
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <p className="text-sm text-slate-500 text-center mb-4">
            Select a change to see its risk analysis
          </p>

          {/* High Risk List */}
          {summary.high > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-2">High Risk Items</h4>
              {riskAnalyses
                .filter((r) => r.riskLevel === 'high' && r.status !== 'error')
                .map((risk) => (
                  <div
                    key={risk.differenceId}
                    onClick={() => onSelectDiff(risk.differenceId)}
                    className={`p-3 bg-gradient-to-br from-red-50 to-rose-50 rounded-xl border border-red-200 cursor-pointer hover:border-red-300 transition-colors ${
                      selectedDiffId === risk.differenceId ? 'ring-2 ring-red-200' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <AlertTriangle className="w-4 h-4 text-red-500" />
                      <span className="text-sm font-semibold text-red-800">{risk.category}</span>
                    </div>
                    <p className="text-sm text-red-700 line-clamp-2">{risk.explanation}</p>
                  </div>
                ))}
            </div>
          )}

          {/* Analysis Errors */}
          {errorCount > 0 && (
            <div className={`space-y-2 ${summary.high > 0 ? 'mt-4' : ''}`}>
              <h4 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Analysis Errors</h4>
              {riskAnalyses
                .filter((r) => r.status === 'error')
                .map((risk) => (
                  <div
                    key={risk.differenceId}
                    onClick={() => onSelectDiff(risk.differenceId)}
                    className={`p-3 bg-slate-50 rounded-xl border border-slate-200 cursor-pointer hover:border-slate-300 transition-colors ${
                      selectedDiffId === risk.differenceId ? 'ring-2 ring-slate-200' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <AlertTriangle className="w-4 h-4 text-slate-400" />
                      <span className="text-sm font-semibold text-slate-700">{risk.category}</span>
                    </div>
                    <p className="text-sm text-slate-600 line-clamp-2">{risk.explanation}</p>
                  </div>
                ))}
            </div>
          )}
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
