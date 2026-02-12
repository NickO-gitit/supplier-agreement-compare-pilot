import { useState, useMemo, useRef, useEffect } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { generateInlineDiffHTML } from '../services/diffEngine';
import type { Difference, RiskAnalysis, Note } from '../types';

interface DiffViewerProps {
  originalText: string;
  proposedText: string;
  differences: Difference[];
  riskAnalyses: RiskAnalysis[];
  notes: Note[];
  selectedDiffId: string | null;
  onSelectDiff: (id: string | null) => void;
}

export function DiffViewer({
  originalText,
  proposedText,
  differences,
  riskAnalyses,
  notes,
  selectedDiffId,
  onSelectDiff,
}: DiffViewerProps) {
  const [currentDiffIndex, setCurrentDiffIndex] = useState(0);
  const diffRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const inlineContainerRef = useRef<HTMLDivElement>(null);

  const inlineHTML = useMemo(
    () => generateInlineDiffHTML(originalText, proposedText, 'word'),
    [originalText, proposedText]
  );

  const getRiskForDiff = (diffId: string): RiskAnalysis | undefined => {
    return riskAnalyses.find((r) => r.differenceId === diffId);
  };

  const getNotesForDiff = (diffId: string): Note[] => {
    return notes.filter((n) => n.differenceId === diffId);
  };

  const navigateToDiff = (index: number) => {
    if (index >= 0 && index < differences.length) {
      setCurrentDiffIndex(index);
      const diff = differences[index];
      onSelectDiff(diff.id);

      const ref = diffRefs.current.get(diff.id);
      if (ref) {
        ref.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  };

  useEffect(() => {
    if (selectedDiffId) {
      const index = differences.findIndex((d) => d.id === selectedDiffId);
      if (index >= 0) {
        setCurrentDiffIndex(index);
      }
    }
  }, [selectedDiffId, differences]);

  useEffect(() => {
    const clearSelected = (container: HTMLDivElement | null) => {
      if (!container) return;
      container.querySelectorAll('.diff-selected').forEach((el) => {
        el.classList.remove('diff-selected');
      });
    };

    clearSelected(inlineContainerRef.current);

    if (!selectedDiffId) return;
    const selector = `[data-diff-id="${selectedDiffId}"]`;

    const markSelected = (container: HTMLDivElement | null) => {
      if (!container) return;
      container.querySelectorAll(selector).forEach((el) => {
        el.classList.add('diff-selected');
      });
    };

    markSelected(inlineContainerRef.current);
  }, [selectedDiffId, inlineHTML]);

  useEffect(() => {
    if (!selectedDiffId) return;
    const selector = `[data-diff-id="${selectedDiffId}"]`;

    const inline = inlineContainerRef.current?.querySelector(selector) as HTMLElement | null;
    inline?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selectedDiffId, inlineHTML]);

  const getRiskBadgeColor = (level?: string, isError?: boolean) => {
    if (isError) {
      return 'bg-gray-100 text-gray-700 border-gray-200';
    }
    switch (level) {
      case 'high':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'medium':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'low':
        return 'bg-green-100 text-green-800 border-green-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between p-3 bg-gray-50 border-b">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigateToDiff(currentDiffIndex - 1)}
              disabled={currentDiffIndex <= 0}
              className="p-1 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronUp className="w-5 h-5" />
            </button>
            <span className="text-sm text-gray-600 min-w-[80px] text-center">
              {differences.length > 0 ? `${currentDiffIndex + 1} / ${differences.length}` : 'No changes'}
            </span>
            <button
              onClick={() => navigateToDiff(currentDiffIndex + 1)}
              disabled={currentDiffIndex >= differences.length - 1}
              className="p-1 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronDown className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-green-200 border border-green-300" />
            <span className="text-gray-600">Added</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-red-200 border border-red-300" />
            <span className="text-gray-600">Removed</span>
          </span>
        </div>
      </div>

      {/* Content */}
      <div ref={inlineContainerRef} className="flex-1 overflow-auto">
        <div className="p-2 bg-gray-50 border-b">
          <h3 className="font-medium text-gray-700">Comparison Document</h3>
        </div>
        <div
          className="p-4 font-mono text-sm whitespace-pre-wrap"
          dangerouslySetInnerHTML={{ __html: inlineHTML }}
        />
      </div>

      {/* Differences List */}
      {differences.length > 0 && (
        <div className="border-t max-h-64 overflow-auto">
          <div className="p-2 bg-gray-50 border-b sticky top-0">
            <h3 className="font-medium text-gray-700">All Changes ({differences.length})</h3>
          </div>
          <div className="divide-y">
            {differences.map((diff, index) => {
              const risk = getRiskForDiff(diff.id);
              const diffNotes = getNotesForDiff(diff.id);
              const isError = risk?.status === 'error';

              return (
                <div
                  key={diff.id}
                  ref={(el) => {
                    if (el) diffRefs.current.set(diff.id, el);
                  }}
                  onClick={() => {
                    setCurrentDiffIndex(index);
                    onSelectDiff(diff.id);
                  }}
                  className={`p-3 cursor-pointer hover:bg-gray-50 ${selectedDiffId === diff.id ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`px-2 py-0.5 text-xs font-medium rounded-full capitalize
                          ${diff.type === 'addition' ? 'bg-green-100 text-green-800' : ''}
                          ${diff.type === 'deletion' ? 'bg-red-100 text-red-800' : ''}
                          ${diff.type === 'modification' ? 'bg-yellow-100 text-yellow-800' : ''}
                        `}>
                          {diff.type}
                        </span>

                        {risk && (
                          <span className={`px-2 py-0.5 text-xs font-medium rounded-full border ${getRiskBadgeColor(risk.riskLevel, isError)}`}>
                            {isError ? 'analysis error' : `${risk.riskLevel} risk`}
                          </span>
                        )}

                        {diffNotes.length > 0 && (
                          <span className="px-2 py-0.5 text-xs bg-purple-100 text-purple-800 rounded-full">
                            {diffNotes.length} note{diffNotes.length > 1 ? 's' : ''}
                          </span>
                        )}
                      </div>

                      <p className="text-sm text-gray-600 truncate">
                        {diff.type === 'deletion'
                          ? diff.originalText
                          : diff.type === 'addition'
                          ? diff.proposedText
                          : `"${diff.originalText?.slice(0, 30)}..." → "${diff.proposedText?.slice(0, 30)}..."`}
                      </p>
                    </div>

                    <span className="text-xs text-gray-400">#{index + 1}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
