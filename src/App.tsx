import { useState, useEffect, useCallback } from 'react';
import { ArrowRight, Loader2, RefreshCw, Zap, FileSearch, Shield, Plus, Minus, PenLine } from 'lucide-react';
import { Header } from './components/Header';
import { FileUpload } from './components/FileUpload';
import { DiffViewer } from './components/DiffViewer';
import { RiskAnalysisPanel } from './components/RiskAnalysisPanel';
import { NotesPanel } from './components/NotesPanel';
import { APIConfigModal } from './components/APIConfigModal';
import { computeDiff } from './services/diffEngine';
import { configureRiskAnalysis, isConfigured, analyzeAllRisks } from './services/riskAnalysis';
import {
  saveComparison,
  getAPIConfig,
  saveAPIConfig,
  saveNote,
  deleteNote,
  getNotesForComparison,
  generateId,
} from './services/storage';
import type { Document, Difference, RiskAnalysis, Note, Comparison } from './types';
import type { APIConfig } from './services/storage';

type AppState = 'upload' | 'comparing' | 'results';
const env = import.meta.env;

function getAPIConfigFromEnv(): APIConfig | null {
  if (env.VITE_OPENAI_API_KEY) {
    return {
      apiKey: env.VITE_OPENAI_API_KEY,
      isAzure: false,
      model: env.VITE_OPENAI_MODEL || 'gpt-4.1-mini',
    };
  }

  if (env.VITE_AZURE_OPENAI_KEY && env.VITE_AZURE_OPENAI_ENDPOINT && env.VITE_AZURE_OPENAI_DEPLOYMENT) {
    return {
      apiKey: env.VITE_AZURE_OPENAI_KEY,
      isAzure: true,
      endpoint: env.VITE_AZURE_OPENAI_ENDPOINT,
      deploymentName: env.VITE_AZURE_OPENAI_DEPLOYMENT,
    };
  }

  return null;
}

function App() {
  const [appState, setAppState] = useState<AppState>('upload');
  const [originalDocument, setOriginalDocument] = useState<Document | null>(null);
  const [proposedDocument, setProposedDocument] = useState<Document | null>(null);
  const [differences, setDifferences] = useState<Difference[]>([]);
  const [riskAnalyses, setRiskAnalyses] = useState<RiskAnalysis[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedDiffId, setSelectedDiffId] = useState<string | null>(null);
  const [comparisonId, setComparisonId] = useState<string | null>(null);

  const [, setIsComparing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState({ completed: 0, total: 0 });
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [apiConfig, setApiConfig] = useState<APIConfig | null>(null);

  // Load API config on mount
  useEffect(() => {
    const savedConfig = getAPIConfig();
    const config = savedConfig || getAPIConfigFromEnv();

    if (config) {
      if (savedConfig) {
        setApiConfig(savedConfig);
      } else {
        setApiConfig(config);
      }
      configureRiskAnalysis({
        apiKey: config.apiKey,
        isAzure: config.isAzure,
        endpoint: config.endpoint,
        deploymentName: config.deploymentName,
        model: config.model,
      });
    }
  }, []);

  // Perform comparison when both documents are loaded
  const handleCompare = useCallback(async () => {
    if (!originalDocument || !proposedDocument) return;

    setIsComparing(true);
    setAppState('comparing');

    // Small delay to show loading state
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      const result = computeDiff(originalDocument.text, proposedDocument.text, 'word');
      setDifferences(result.differences);

      // Create comparison record
      const id = generateId();
      setComparisonId(id);

      const comparison: Comparison = {
        id,
        originalDocument,
        proposedDocument,
        differences: result.differences,
        riskAnalyses: [],
        notes: [],
        createdAt: new Date(),
        status: 'completed',
      };
      saveComparison(comparison);

      setAppState('results');
    } catch (error) {
      console.error('Comparison failed:', error);
      setAppState('upload');
    } finally {
      setIsComparing(false);
    }
  }, [originalDocument, proposedDocument]);

  // Run risk analysis
  const handleAnalyzeRisks = useCallback(async () => {
    if (differences.length === 0 || !isConfigured()) return;

    setIsAnalyzing(true);
    setAnalysisProgress({ completed: 0, total: differences.length });

    try {
      const analyses = await analyzeAllRisks(differences, (completed, total) => {
        setAnalysisProgress({ completed, total });
      });
      setRiskAnalyses(analyses);

      // Update saved comparison
      if (comparisonId) {
        const comparison: Comparison = {
          id: comparisonId,
          originalDocument,
          proposedDocument,
          differences,
          riskAnalyses: analyses,
          notes,
          createdAt: new Date(),
          status: 'completed',
        };
        saveComparison(comparison);
      }
    } catch (error) {
      console.error('Risk analysis failed:', error);
    } finally {
      setIsAnalyzing(false);
    }
  }, [differences, comparisonId, originalDocument, proposedDocument, notes]);

  // Handle API config save
  const handleSaveAPIConfig = (config: APIConfig) => {
    setApiConfig(config);
    saveAPIConfig(config);
    configureRiskAnalysis({
      apiKey: config.apiKey,
      isAzure: config.isAzure,
      endpoint: config.endpoint,
      deploymentName: config.deploymentName,
      model: config.model,
    });
  };

  // Notes handlers
  const handleAddNote = (note: Note) => {
    if (comparisonId) {
      saveNote(comparisonId, note);
      setNotes((prev) => [...prev, note]);
    }
  };

  const handleUpdateNote = (note: Note) => {
    if (comparisonId) {
      saveNote(comparisonId, note);
      setNotes((prev) => prev.map((n) => (n.id === note.id ? note : n)));
    }
  };

  const handleDeleteNote = (noteId: string) => {
    if (comparisonId) {
      deleteNote(comparisonId, noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
    }
  };

  // Load notes when comparison changes
  useEffect(() => {
    if (comparisonId) {
      const loadedNotes = getNotesForComparison(comparisonId);
      setNotes(loadedNotes);
    }
  }, [comparisonId]);

  // Reset to start new comparison
  const handleReset = () => {
    setAppState('upload');
    setOriginalDocument(null);
    setProposedDocument(null);
    setDifferences([]);
    setRiskAnalyses([]);
    setNotes([]);
    setSelectedDiffId(null);
    setComparisonId(null);
  };

  // Export report
  const handleExport = () => {
    if (!originalDocument || !proposedDocument || differences.length === 0) return;

    const report = generateReport();
    const blob = new Blob([report], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agreement-comparison-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const generateReport = () => {
    const lines: string[] = [
      '═══════════════════════════════════════════════════════════════════',
      '                    AGREEMENT COMPARISON REPORT',
      '═══════════════════════════════════════════════════════════════════',
      '',
      `Generated: ${new Date().toLocaleString()}`,
      '',
      'DOCUMENTS COMPARED:',
      `  Original: ${originalDocument?.name}`,
      `  Proposed: ${proposedDocument?.name}`,
      '',
      '───────────────────────────────────────────────────────────────────',
      '                          SUMMARY',
      '───────────────────────────────────────────────────────────────────',
      '',
      `Total Changes: ${differences.length}`,
      `  - Additions: ${differences.filter((d) => d.type === 'addition').length}`,
      `  - Deletions: ${differences.filter((d) => d.type === 'deletion').length}`,
      `  - Modifications: ${differences.filter((d) => d.type === 'modification').length}`,
      '',
    ];

    if (riskAnalyses.length > 0) {
      const analyzedRisks = riskAnalyses.filter((r) => r.status !== 'error');
      const errorCount = riskAnalyses.filter((r) => r.status === 'error').length;
      const highRisk = analyzedRisks.filter((r) => r.riskLevel === 'high').length;
      const mediumRisk = analyzedRisks.filter((r) => r.riskLevel === 'medium').length;
      const lowRisk = analyzedRisks.filter((r) => r.riskLevel === 'low').length;

      lines.push(
        'RISK ASSESSMENT:',
        `  - High Risk: ${highRisk}`,
        `  - Medium Risk: ${mediumRisk}`,
        `  - Low Risk: ${lowRisk}`,
        `  - Analysis Errors: ${errorCount}`,
        ''
      );
    }

    lines.push(
      '───────────────────────────────────────────────────────────────────',
      '                       DETAILED CHANGES',
      '───────────────────────────────────────────────────────────────────',
      ''
    );

    differences.forEach((diff, index) => {
      const risk = riskAnalyses.find((r) => r.differenceId === diff.id);
      const diffNotes = notes.filter((n) => n.differenceId === diff.id);

      lines.push(`CHANGE #${index + 1} - ${diff.type.toUpperCase()}`);

      if (risk) {
        if (risk.status === 'error') {
          lines.push(`Risk Level: ANALYSIS ERROR (${risk.category})`);
        } else {
          lines.push(`Risk Level: ${risk.riskLevel.toUpperCase()} (${risk.category})`);
        }
      }

      lines.push('');

      if (diff.originalText) {
        lines.push(`ORIGINAL:`);
        lines.push(`  "${diff.originalText}"`);
      }

      if (diff.proposedText) {
        lines.push(`PROPOSED:`);
        lines.push(`  "${diff.proposedText}"`);
      }

      if (risk) {
        lines.push('');
        lines.push(`ANALYSIS:`);
        lines.push(`  ${risk.explanation}`);
        lines.push(`  Legal Implication: ${risk.legalImplication}`);
        lines.push(`  Recommendation: ${risk.recommendation}`);
        if (risk.status === 'error' && risk.error) {
          lines.push(`  Error: ${risk.error}`);
        }
      }

      if (diffNotes.length > 0) {
        lines.push('');
        lines.push('NOTES:');
        diffNotes.forEach((note) => {
          lines.push(`  [${note.category.toUpperCase()}] ${note.content}`);
        });
      }

      lines.push('');
      lines.push('───────────────────────────────────────────────────────────────────');
      lines.push('');
    });

    // Add general notes
    const generalNotes = notes.filter((n) => !n.differenceId);
    if (generalNotes.length > 0) {
      lines.push('GENERAL NOTES:');
      generalNotes.forEach((note) => {
        lines.push(`  [${note.category.toUpperCase()}] ${note.content}`);
      });
      lines.push('');
    }

    lines.push('═══════════════════════════════════════════════════════════════════');
    lines.push('                         END OF REPORT');
    lines.push('═══════════════════════════════════════════════════════════════════');

    return lines.join('\n');
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header
        onOpenSettings={() => setShowConfigModal(true)}
        onExport={handleExport}
        canExport={appState === 'results' && differences.length > 0}
      />

      <main className="flex-1 p-6">
        {/* Upload State */}
        {appState === 'upload' && (
          <div className="max-w-5xl mx-auto animate-fadeIn">
            {/* Hero Section */}
            <div className="text-center mb-10">
              <h2 className="text-3xl font-bold text-white mb-3">
                Compare Supplier Agreements
              </h2>
              <p className="text-lg text-white/80 max-w-2xl mx-auto">
                Upload your documents to find every difference with 100% accuracy using deterministic comparison - no AI guessing involved.
              </p>
            </div>

            {/* Main Upload Card */}
            <div className="bg-white/95 backdrop-blur-xl rounded-3xl shadow-2xl shadow-purple-500/20 p-8 mb-8">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 bg-indigo-100 rounded-xl">
                  <FileSearch className="w-5 h-5 text-indigo-600" />
                </div>
                <h3 className="text-xl font-semibold text-slate-800">Upload Documents</h3>
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                <FileUpload
                  type="original"
                  onDocumentLoaded={setOriginalDocument}
                  currentDocument={originalDocument}
                />
                <FileUpload
                  type="proposed"
                  onDocumentLoaded={setProposedDocument}
                  currentDocument={proposedDocument}
                />
              </div>

              {originalDocument && proposedDocument && (
                <div className="mt-8 flex justify-center">
                  <button
                    onClick={handleCompare}
                    className="group flex items-center gap-3 px-8 py-4 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-2xl hover:from-indigo-700 hover:to-purple-700 transition-all duration-300 font-semibold text-lg shadow-xl shadow-indigo-500/30 hover:shadow-2xl hover:shadow-indigo-500/40 hover:-translate-y-1"
                  >
                    <Zap className="w-5 h-5" />
                    Compare Documents
                    <ArrowRight className="w-5 h-5 transition-transform group-hover:translate-x-1" />
                  </button>
                </div>
              )}
            </div>

            {/* Features */}
            <div className="grid md:grid-cols-3 gap-6">
              <div className="bg-white/90 backdrop-blur rounded-2xl p-6 shadow-lg">
                <div className="p-3 bg-emerald-100 rounded-xl w-fit mb-4">
                  <Shield className="w-6 h-6 text-emerald-600" />
                </div>
                <h4 className="font-semibold text-slate-800 mb-2">100% Accurate</h4>
                <p className="text-slate-600 text-sm">Deterministic diff algorithm finds every single change - no AI hallucinations or missed differences.</p>
              </div>
              <div className="bg-white/90 backdrop-blur rounded-2xl p-6 shadow-lg">
                <div className="p-3 bg-amber-100 rounded-xl w-fit mb-4">
                  <Zap className="w-6 h-6 text-amber-600" />
                </div>
                <h4 className="font-semibold text-slate-800 mb-2">AI Risk Analysis</h4>
                <p className="text-slate-600 text-sm">Optional GPT-4 powered legal analysis classifies each change by risk level and provides recommendations.</p>
              </div>
              <div className="bg-white/90 backdrop-blur rounded-2xl p-6 shadow-lg">
                <div className="p-3 bg-purple-100 rounded-xl w-fit mb-4">
                  <FileSearch className="w-6 h-6 text-purple-600" />
                </div>
                <h4 className="font-semibold text-slate-800 mb-2">Multiple Formats</h4>
                <p className="text-slate-600 text-sm">Upload PDF, Word, Excel, text files, or even images - we extract and compare the text content.</p>
              </div>
            </div>
          </div>
        )}

        {/* Comparing State */}
        {appState === 'comparing' && (
          <div className="flex items-center justify-center h-[60vh]">
            <div className="text-center bg-white/95 backdrop-blur-xl rounded-3xl p-12 shadow-2xl">
              <div className="relative mb-6">
                <div className="absolute inset-0 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full blur-xl opacity-30 animate-pulse"></div>
                <div className="relative p-6 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-full inline-block">
                  <Loader2 className="w-12 h-12 text-white animate-spin" />
                </div>
              </div>
              <p className="text-2xl font-bold text-slate-800 mb-2">Analyzing Documents</p>
              <p className="text-slate-500">Finding all differences...</p>
            </div>
          </div>
        )}

        {/* Results State */}
        {appState === 'results' && (
          <div className="h-[calc(100vh-160px)] animate-fadeIn">
            {/* Summary Bar */}
            <div className="bg-white/95 backdrop-blur-xl rounded-2xl shadow-xl shadow-purple-500/10 p-5 mb-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-8">
                  <div>
                    <span className="text-4xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                      {differences.length}
                    </span>
                    <span className="text-slate-500 ml-3 text-lg">changes found</span>
                  </div>
                  <div className="flex items-center gap-5">
                    <div className="flex items-center gap-2 px-4 py-2 bg-emerald-50 rounded-xl border border-emerald-200">
                      <Plus className="w-4 h-4 text-emerald-600" />
                      <span className="font-semibold text-emerald-700">
                        {differences.filter((d) => d.type === 'addition').length}
                      </span>
                      <span className="text-emerald-600 text-sm">additions</span>
                    </div>
                    <div className="flex items-center gap-2 px-4 py-2 bg-red-50 rounded-xl border border-red-200">
                      <Minus className="w-4 h-4 text-red-600" />
                      <span className="font-semibold text-red-700">
                        {differences.filter((d) => d.type === 'deletion').length}
                      </span>
                      <span className="text-red-600 text-sm">deletions</span>
                    </div>
                    <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 rounded-xl border border-amber-200">
                      <PenLine className="w-4 h-4 text-amber-600" />
                      <span className="font-semibold text-amber-700">
                        {differences.filter((d) => d.type === 'modification').length}
                      </span>
                      <span className="text-amber-600 text-sm">modifications</span>
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleReset}
                  className="flex items-center gap-2 px-5 py-2.5 text-slate-600 bg-white border-2 border-slate-200 rounded-xl hover:border-slate-300 hover:bg-slate-50 transition-all duration-200 font-medium"
                >
                  <RefreshCw className="w-4 h-4" />
                  New Comparison
                </button>
              </div>
            </div>

            {/* Main Content */}
            <div className="grid grid-cols-12 gap-5 h-[calc(100%-100px)]">
              {/* Diff Viewer - Main Panel */}
              <div className="col-span-7 bg-white/95 backdrop-blur-xl rounded-2xl shadow-xl shadow-purple-500/10 overflow-hidden">
                <DiffViewer
                  originalText={originalDocument?.text || ''}
                  proposedText={proposedDocument?.text || ''}
                  differences={differences}
                  riskAnalyses={riskAnalyses}
                  notes={notes}
                  selectedDiffId={selectedDiffId}
                  onSelectDiff={setSelectedDiffId}
                />
              </div>

              {/* Right Sidebar */}
              <div className="col-span-5 flex flex-col gap-5">
                {/* Risk Analysis Panel */}
                <div className="bg-white/95 backdrop-blur-xl rounded-2xl shadow-xl shadow-purple-500/10 flex-1 overflow-hidden">
                  <RiskAnalysisPanel
                    differences={differences}
                    riskAnalyses={riskAnalyses}
                    selectedDiffId={selectedDiffId}
                    isAnalyzing={isAnalyzing}
                    analysisProgress={analysisProgress}
                    onAnalyze={handleAnalyzeRisks}
                    isConfigured={isConfigured()}
                    onConfigure={() => setShowConfigModal(true)}
                    onSelectDiff={setSelectedDiffId}
                  />
                </div>

                {/* Notes Panel */}
                <div className="bg-white/95 backdrop-blur-xl rounded-2xl shadow-xl shadow-purple-500/10 flex-1 overflow-hidden">
                  <NotesPanel
                    notes={notes}
                    selectedDiffId={selectedDiffId}
                    differences={differences}
                    onAddNote={handleAddNote}
                    onUpdateNote={handleUpdateNote}
                    onDeleteNote={handleDeleteNote}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* API Config Modal */}
      <APIConfigModal
        isOpen={showConfigModal}
        onClose={() => setShowConfigModal(false)}
        onSave={handleSaveAPIConfig}
        currentConfig={apiConfig}
      />
    </div>
  );
}

export default App;
