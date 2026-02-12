import { FileText, Settings, History, Download, Sparkles } from 'lucide-react';

interface HeaderProps {
  onOpenSettings: () => void;
  onExport: () => void;
  canExport: boolean;
}

export function Header({ onOpenSettings, onExport, canExport }: HeaderProps) {
  return (
    <header className="bg-white/95 backdrop-blur-lg border-b border-white/20 shadow-lg shadow-purple-500/10">
      <div className="max-w-screen-2xl mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-xl blur-lg opacity-50"></div>
            <div className="relative p-3 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-xl shadow-lg">
              <FileText className="w-6 h-6 text-white" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                Agreement Compare
              </h1>
              <Sparkles className="w-4 h-4 text-amber-500" />
            </div>
            <p className="text-sm text-slate-500">Compare supplier framework agreements with AI-powered analysis</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {canExport && (
            <button
              onClick={onExport}
              className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-gradient-to-r from-emerald-500 to-teal-500 rounded-xl hover:from-emerald-600 hover:to-teal-600 transition-all duration-200 shadow-md shadow-emerald-500/25 hover:shadow-lg hover:shadow-emerald-500/30 hover:-translate-y-0.5"
            >
              <Download className="w-4 h-4" />
              Export Report
            </button>
          )}

          <button
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-400 bg-slate-100 rounded-xl cursor-not-allowed"
            title="History (coming soon)"
            disabled
          >
            <History className="w-4 h-4" />
            <span className="hidden sm:inline">History</span>
          </button>

          <button
            onClick={onOpenSettings}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border-2 border-slate-200 rounded-xl hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50 transition-all duration-200"
          >
            <Settings className="w-4 h-4" />
            <span className="hidden sm:inline">Settings</span>
          </button>
        </div>
      </div>
    </header>
  );
}
