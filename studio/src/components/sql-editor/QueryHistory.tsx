import React from 'react';

interface QueryHistoryProps {
  history: string[];
  onSelect: (query: string) => void;
  onClear: () => void;
}

export function QueryHistory({ history, onSelect, onClear }: QueryHistoryProps): React.ReactElement {
  return (
    <div className="flex flex-col h-full bg-surface-100 border-r border-surface-200">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-surface-200 flex-shrink-0">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">History</span>
        {history.length > 0 && (
          <button
            onClick={onClear}
            className="text-xs text-gray-500 hover:text-red-400 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {history.length === 0 ? (
          <p className="px-3 py-4 text-xs text-gray-500 text-center">No history yet</p>
        ) : (
          <div className="divide-y divide-surface-200">
            {history.map((q, idx) => (
              <button
                key={idx}
                onClick={() => onSelect(q)}
                className="w-full text-left px-3 py-2 text-xs text-gray-400 hover:text-white hover:bg-surface-200 transition-colors"
                title={q}
              >
                <span className="block truncate font-mono">
                  {q.length > 80 ? q.slice(0, 80) + '...' : q}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
