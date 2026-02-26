import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { postSql } from '../../api/sql';

interface PgActivity {
  pid: number;
  query: string;
  state: string;
  query_start: string;
  wait_event_type: string | null;
  wait_event: string | null;
}

const MAX_LINES = 200;

function formatLogLine(row: PgActivity): string {
  const time = row.query_start ? row.query_start.slice(11, 19) : '??:??:??';
  const wait = row.wait_event
    ? ` [${row.wait_event_type ?? ''}:${row.wait_event}]`
    : '';
  const query = row.query?.replace(/\s+/g, ' ').slice(0, 120) ?? '';
  return `[${row.pid}] ${time} ${row.state}${wait}  ${query}`;
}

export function LogViewer(): React.ReactElement {
  const [lines, setLines] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['pg-activity'],
    queryFn: async () => {
      const sql = `
        SELECT
          pid,
          query,
          state,
          query_start::text,
          wait_event_type,
          wait_event
        FROM pg_stat_activity
        WHERE state != 'idle'
          AND pid != pg_backend_pid()
        ORDER BY query_start DESC
        LIMIT 50
      `;
      const result = await postSql(sql);
      if (result.error) throw new Error(result.error);
      return (result.rows ?? []) as unknown as PgActivity[];
    },
    refetchInterval: 3_000,
  });

  useEffect(() => {
    if (!data) return;
    const timestamp = new Date().toLocaleTimeString();
    const newLines = data.length > 0
      ? data.map(formatLogLine)
      : [`[${timestamp}] No active queries`];

    setLines((prev) => {
      const combined = [...prev, `--- ${timestamp} ---`, ...newLines];
      return combined.slice(-MAX_LINES);
    });
  }, [data]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto bg-surface font-mono text-xs text-green-400 p-4 space-y-0.5"
      aria-live="polite"
      aria-label="Active PostgreSQL queries"
    >
      {lines.length === 0 ? (
        <div className="text-gray-500">Waiting for data...</div>
      ) : (
        lines.map((line, idx) => (
          <div
            key={idx}
            className={
              line.startsWith('---')
                ? 'text-gray-600 border-t border-surface-200 pt-1 mt-1'
                : 'hover:text-green-300'
            }
          >
            {line}
          </div>
        ))
      )}
    </div>
  );
}
