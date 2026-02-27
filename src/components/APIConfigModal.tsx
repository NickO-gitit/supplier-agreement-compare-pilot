import { X, HelpCircle } from 'lucide-react';

interface APIConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onExportVerboseLog: () => void;
}

export function APIConfigModal({
  isOpen,
  onClose,
  onExportVerboseLog,
}: APIConfigModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold text-gray-800">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Help text */}
          <div className="flex items-start gap-2 p-3 bg-gray-50 rounded-lg">
            <HelpCircle className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-gray-600">
              <p>
                AI provider, endpoint, and credentials are configured on the backend deployment.
                Manual provider/API key setup in the browser has been removed.
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-between gap-3 p-4 border-t bg-gray-50 rounded-b-xl">
          <button
            onClick={onExportVerboseLog}
            className="px-4 py-2 text-sm text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors"
            title="Export detailed runtime diagnostics and analysis logs"
          >
            Export Verbose Log
          </button>
          <div className="flex gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg transition-colors"
          >
            Close
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}
