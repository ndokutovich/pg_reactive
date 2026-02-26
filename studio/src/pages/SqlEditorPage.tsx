import React, { useState, useCallback } from 'react';
import { ResizablePanel } from '../components/ui/ResizablePanel';
import { SqlEditor } from '../components/sql-editor/SqlEditor';
import { ResultsGrid } from '../components/sql-editor/ResultsGrid';
import { QueryHistory } from '../components/sql-editor/QueryHistory';
import { EditorToolbar } from '../components/sql-editor/EditorToolbar';
import { postSql } from '../api/sql';
import type { SqlResult } from '../api/sql';

const HISTORY_KEY = 'pgstack-studio-sql-history';
const MAX_HISTORY = 50;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(history: string[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

export function SqlEditorPage(): React.ReactElement {
  const [sql, setSql] = useState('SELECT * FROM pg_stat_activity LIMIT 10;');
  const [result, setResult] = useState<SqlResult | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [elapsedMs, setElapsedMs] = useState<number | undefined>();

  const runQuery = useCallback(async () => {
    if (!sql.trim() || running) return;
    setRunning(true);
    const start = Date.now();
    try {
      const res = await postSql(sql);
      const elapsed = Date.now() - start;
      setResult(res);
      setElapsedMs(elapsed);

      if (!res.error) {
        setHistory((prev) => {
          const deduped = [sql, ...prev.filter((q) => q !== sql)].slice(0, MAX_HISTORY);
          saveHistory(deduped);
          return deduped;
        });
      }
    } finally {
      setRunning(false);
    }
  }, [sql, running]);

  const rowCount =
    result?.rows !== undefined ? result.rows.length : undefined;

  const editorArea = (
    <div className="flex flex-col h-full">
      <EditorToolbar
        onRun={() => void runQuery()}
        isRunning={running}
        rowCount={rowCount}
        elapsedMs={elapsedMs}
      />
      <div className="flex-1 min-h-0">
        <SqlEditor value={sql} onChange={setSql} onRun={() => void runQuery()} />
      </div>
    </div>
  );

  const resultsArea = (
    <div className="h-full overflow-hidden">
      <ResultsGrid result={result} isLoading={running} />
    </div>
  );

  return (
    <div className="flex h-full">
      {historyOpen && (
        <div className="w-60 flex-shrink-0 overflow-hidden">
          <QueryHistory
            history={history}
            onSelect={(q) => setSql(q)}
            onClear={() => {
              setHistory([]);
              saveHistory([]);
            }}
          />
        </div>
      )}

      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <div className="flex items-center px-3 py-1.5 border-b border-surface-200 bg-surface-100">
          <button
            onClick={() => setHistoryOpen((v) => !v)}
            className="text-xs text-gray-500 hover:text-white transition-colors"
            aria-label="Toggle history panel"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" className="inline mr-1">
              <line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
            {historyOpen ? 'Hide' : 'Show'} History
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <ResizablePanel top={editorArea} bottom={resultsArea} defaultSplit={60} />
        </div>
      </div>
    </div>
  );
}
