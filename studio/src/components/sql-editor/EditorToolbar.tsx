import React from 'react';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';

interface EditorToolbarProps {
  onRun: () => void;
  onExplain: () => void;
  onAnalyze: () => void;
  isRunning: boolean;
  rowCount?: number;
  elapsedMs?: number;
}

export function EditorToolbar({ onRun, onExplain, onAnalyze, isRunning, rowCount, elapsedMs }: EditorToolbarProps): React.ReactElement {
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-surface-200 bg-surface-100 flex-shrink-0">
      <Button variant="primary" size="sm" onClick={onRun} loading={isRunning}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
        Run
        <span className="text-xs opacity-60 ml-1">(Ctrl+Enter)</span>
      </Button>

      <Button
        variant="secondary"
        size="sm"
        onClick={onExplain}
        disabled={isRunning}
        title="Show the execution plan with plain EXPLAIN — plans the query without executing it. Always safe to run."
      >
        Explain
      </Button>

      <Button
        variant="danger"
        size="sm"
        onClick={onAnalyze}
        disabled={isRunning}
        title="EXPLAIN ANALYZE — RUNS the statement to measure real timings, including any writes, nextval(), or other side effects. Confirms before executing."
      >
        Analyze
      </Button>

      {isRunning && <Spinner size="sm" />}

      {!isRunning && rowCount !== undefined && elapsedMs !== undefined && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="px-2 py-0.5 bg-surface-200 rounded text-gray-300">
            {rowCount} rows
          </span>
          <span className="px-2 py-0.5 bg-surface-200 rounded text-gray-300">
            {elapsedMs}ms
          </span>
        </div>
      )}
    </div>
  );
}
