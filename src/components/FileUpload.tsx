import { useCallback, useState } from 'react';
import { Upload, FileText, Loader2, CheckCircle, AlertCircle, X, FileCheck } from 'lucide-react';
import { extractText, getFileType } from '../services/extractText';
import type { Document } from '../types';
import { generateId } from '../services/storage';

interface FileUploadProps {
  type: 'original' | 'proposed';
  onDocumentLoaded: (doc: Document) => void;
  currentDocument: Document | null;
}

export function FileUpload({ type, onDocumentLoaded, currentDocument }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);

    const fileType = getFileType(file);
    if (!fileType) {
      setError(`Unsupported file type. Please upload PDF, DOCX, XLSX, TXT, JPG, or PNG files.`);
      return;
    }

    setIsProcessing(true);
    setProgress(0);

    try {
      const text = await extractText(file, setProgress);

      if (!text.trim()) {
        setError('Could not extract any text from the file. The file may be empty or contain only images.');
        setIsProcessing(false);
        return;
      }

      const doc: Document = {
        id: generateId(),
        name: file.name,
        type,
        fileType,
        text,
        uploadedAt: new Date(),
      };

      onDocumentLoaded(doc);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process file');
    } finally {
      setIsProcessing(false);
      setProgress(0);
    }
  }, [type, onDocumentLoaded]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file) {
      handleFile(file);
    }
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
  }, [handleFile]);

  const title = type === 'original' ? 'Original Agreement' : 'Proposed Changes';
  const isOriginal = type === 'original';

  const gradientFrom = isOriginal ? 'from-blue-500' : 'from-emerald-500';
  const gradientTo = isOriginal ? 'to-indigo-600' : 'to-teal-600';
  const lightBg = isOriginal ? 'bg-blue-50' : 'bg-emerald-50';
  const borderActive = isOriginal ? 'border-blue-400' : 'border-emerald-400';
  const iconBg = isOriginal ? 'bg-blue-100' : 'bg-emerald-100';
  const iconColor = isOriginal ? 'text-blue-600' : 'text-emerald-600';
  const progressBg = isOriginal ? 'from-blue-500 to-indigo-500' : 'from-emerald-500 to-teal-500';

  if (currentDocument) {
    return (
      <div className={`relative overflow-hidden rounded-2xl border-2 ${isOriginal ? 'border-blue-200 bg-gradient-to-br from-blue-50 to-indigo-50' : 'border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50'} p-5 transition-all duration-300`}>
        <div className="absolute top-0 right-0 w-32 h-32 transform translate-x-16 -translate-y-16">
          <div className={`w-full h-full rounded-full ${isOriginal ? 'bg-blue-200' : 'bg-emerald-200'} opacity-30`}></div>
        </div>

        <div className="relative flex items-center gap-4">
          <div className={`p-3 rounded-xl ${iconBg} shadow-sm`}>
            <FileCheck className={`w-6 h-6 ${iconColor}`} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-slate-800 truncate">{currentDocument.name}</p>
            <p className="text-sm text-slate-500 mt-0.5">
              <span className={`font-medium ${iconColor}`}>{currentDocument.text.length.toLocaleString()}</span> characters extracted
            </p>
          </div>
          <button
            onClick={() => onDocumentLoaded(null as unknown as Document)}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-white/50 transition-all duration-200"
            title="Remove file"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <CheckCircle className={`w-4 h-4 ${iconColor}`} />
          <span className={`text-xs font-medium ${iconColor}`}>Ready for comparison</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`
        relative overflow-hidden rounded-2xl border-2 border-dashed transition-all duration-300 cursor-pointer
        ${isDragging
          ? `${borderActive} ${lightBg} scale-[1.02] shadow-lg`
          : 'border-slate-300 bg-white hover:border-slate-400 hover:shadow-md'
        }
        ${isProcessing ? 'pointer-events-none' : ''}
      `}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <input
        type="file"
        accept=".pdf,.docx,.xlsx,.txt,.jpg,.jpeg,.png"
        onChange={handleInputChange}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
        disabled={isProcessing}
      />

      {/* Background decoration */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className={`absolute -top-24 -right-24 w-48 h-48 rounded-full ${lightBg} opacity-50`}></div>
        <div className={`absolute -bottom-16 -left-16 w-32 h-32 rounded-full ${lightBg} opacity-30`}></div>
      </div>

      <div className="relative p-8">
        <div className="flex flex-col items-center text-center">
          {isProcessing ? (
            <>
              <div className={`p-4 rounded-2xl bg-gradient-to-br ${gradientFrom} ${gradientTo} shadow-lg mb-4`}>
                <Loader2 className="w-8 h-8 text-white animate-spin" />
              </div>
              <p className="font-semibold text-slate-700 mb-1">Processing {title}...</p>
              <p className="text-sm text-slate-500 mb-4">Extracting text content</p>

              <div className="w-full max-w-xs">
                <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full bg-gradient-to-r ${progressBg} transition-all duration-300 ease-out`}
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-xs text-slate-400 mt-2 font-medium">{Math.round(progress)}% complete</p>
              </div>
            </>
          ) : (
            <>
              <div className={`p-4 rounded-2xl bg-gradient-to-br ${gradientFrom} ${gradientTo} shadow-lg shadow-indigo-500/25 mb-4 transition-transform duration-300 group-hover:scale-110`}>
                {isOriginal ? (
                  <FileText className="w-8 h-8 text-white" />
                ) : (
                  <Upload className="w-8 h-8 text-white" />
                )}
              </div>

              <h3 className="font-bold text-lg text-slate-800 mb-1">{title}</h3>
              <p className="text-slate-500 mb-4">
                Drag & drop or <span className={`font-semibold ${iconColor}`}>click to browse</span>
              </p>

              <div className="flex flex-wrap justify-center gap-2">
                {['PDF', 'DOCX', 'XLSX', 'TXT', 'JPG', 'PNG'].map((format) => (
                  <span
                    key={format}
                    className="px-2.5 py-1 text-xs font-medium bg-slate-100 text-slate-600 rounded-lg"
                  >
                    {format}
                  </span>
                ))}
              </div>
            </>
          )}

          {error && (
            <div className="flex items-center gap-2 mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-red-600">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span className="text-sm">{error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
