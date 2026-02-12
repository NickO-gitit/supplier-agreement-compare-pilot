import { useState } from 'react';
import { X, Key, Server, HelpCircle } from 'lucide-react';
import type { APIConfig } from '../services/storage';

interface APIConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: APIConfig) => void;
  currentConfig: APIConfig | null;
}

export function APIConfigModal({ isOpen, onClose, onSave, currentConfig }: APIConfigModalProps) {
  const [isAzure, setIsAzure] = useState(currentConfig?.isAzure ?? false);
  const [apiKey, setApiKey] = useState(currentConfig?.apiKey ?? '');
  const [endpoint, setEndpoint] = useState(currentConfig?.endpoint ?? '');
  const [deploymentName, setDeploymentName] = useState(currentConfig?.deploymentName ?? '');
  const [model, setModel] = useState(currentConfig?.model ?? 'gpt-4.1-mini');

  if (!isOpen) return null;

  const handleSave = () => {
    const config: APIConfig = {
      apiKey,
      isAzure,
      endpoint: isAzure ? endpoint : undefined,
      deploymentName: isAzure ? deploymentName : undefined,
      model: !isAzure && model.trim() ? model.trim() : undefined,
    };
    onSave(config);
    onClose();
  };

  const isValid = apiKey.trim() && (!isAzure || (endpoint.trim() && deploymentName.trim()));

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold text-gray-800">Configure OpenAI API</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Provider Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Provider</label>
            <div className="flex gap-3">
              <button
                onClick={() => setIsAzure(false)}
                className={`flex-1 p-3 rounded-lg border-2 transition-all ${
                  !isAzure
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <Key className={`w-5 h-5 mx-auto mb-1 ${!isAzure ? 'text-blue-600' : 'text-gray-400'}`} />
                <p className={`text-sm font-medium ${!isAzure ? 'text-blue-700' : 'text-gray-600'}`}>
                  OpenAI
                </p>
                <p className="text-xs text-gray-500">api.openai.com</p>
              </button>
              <button
                onClick={() => setIsAzure(true)}
                className={`flex-1 p-3 rounded-lg border-2 transition-all ${
                  isAzure
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <Server className={`w-5 h-5 mx-auto mb-1 ${isAzure ? 'text-blue-600' : 'text-gray-400'}`} />
                <p className={`text-sm font-medium ${isAzure ? 'text-blue-700' : 'text-gray-600'}`}>
                  Azure OpenAI
                </p>
                <p className="text-xs text-gray-500">Your Azure endpoint</p>
              </button>
            </div>
          </div>

          {/* API Key */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              API Key
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={isAzure ? 'Enter your Azure OpenAI API key' : 'sk-...'}
              className="w-full p-2.5 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* OpenAI-specific fields */}
          {!isAzure && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Model
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-4.1-mini"
                className="w-full p-2.5 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">Default: gpt-4.1-mini</p>
            </div>
          )}

          {/* Azure-specific fields */}
          {isAzure && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Endpoint (Resource URL)
                </label>
                <input
                  type="text"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://your-resource.openai.azure.com"
                  className="w-full p-2.5 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Use the resource endpoint only (no <code>/openai/deployments/...</code> path).
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Deployment Name
                </label>
                <input
                  type="text"
                  value={deploymentName}
                  onChange={(e) => setDeploymentName(e.target.value)}
                  placeholder="gpt-4-turbo"
                  className="w-full p-2.5 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </>
          )}

          {/* Help text */}
          <div className="flex items-start gap-2 p-3 bg-gray-50 rounded-lg">
            <HelpCircle className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-gray-600">
              {isAzure ? (
                <p>
                  Your Azure OpenAI endpoint and deployment name can be found in the Azure Portal
                  under your OpenAI resource. The API key is in the &quot;Keys and Endpoint&quot; section.
                </p>
              ) : (
                <p>
                  Get your API key from{' '}
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    platform.openai.com/api-keys
                  </a>
                  . GPT-4 Turbo is recommended for best legal analysis quality.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-4 border-t bg-gray-50 rounded-b-xl">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!isValid}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Save Configuration
          </button>
        </div>
      </div>
    </div>
  );
}
