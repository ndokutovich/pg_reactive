import React, { useState, useCallback, useRef, useEffect } from 'react';
import { apiSql } from '../api';
import { MIGRATION_SQL } from '../migration';

export default function SetupScreen({ onComplete }) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [logLines, setLogLines] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  const appendLog = useCallback((text, cls = '') => {
    setLogLines((prev) => [...prev, { text, cls }]);
  }, []);

  const runSetup = useCallback(async () => {
    setRunning(true);
    setShowLog(true);
    setLogLines([]);

    let allOk = true;

    for (let i = 0; i < MIGRATION_SQL.length; i++) {
      const stmt = MIGRATION_SQL[i];
      let short = stmt.replace(/\n/g, ' ');
      if (short.length > 60) short = short.substring(0, 60) + '...';
      appendLog('> ' + short);

      try {
        const result = await apiSql(stmt);
        if (result.error) {
          if (
            result.error.indexOf('already exists') !== -1 ||
            result.error.indexOf('duplicate') !== -1
          ) {
            appendLog('  (skipped)', 'ok');
          } else {
            appendLog('  ERROR: ' + result.error, 'error');
            allOk = false;
          }
        } else {
          appendLog('  OK', 'ok');
        }
      } catch (err) {
        appendLog('  NETWORK ERROR: ' + err.message, 'error');
        allOk = false;
      }
    }

    if (allOk) {
      appendLog('\nSetup complete! Proceeding to sign in...', 'ok');
      appendLog('NOTE: If REST calls fail, restart proxy: docker compose restart proxy', 'ok');
      setDone(true);
      setTimeout(() => onComplete(), 1200);
    } else {
      appendLog('\nSetup finished with errors. You may retry.', 'error');
      setRunning(false);
    }
  }, [onComplete, appendLog]);

  const buttonText = done ? 'Done!' : running ? 'Setting up...' : 'Setup Database';

  return (
    <div className="screen active">
      <div className="setup-hero card">
        <div className="card-body">
          <div className="setup-icon">{'\uD83D\uDED2'}</div>
          <h1>What to Buy</h1>
          <p>A shared shopping list for couples. Set up the database to get started.</p>
          <button
            className="btn btn-primary btn-full"
            disabled={running || done}
            onClick={runSetup}
          >
            {buttonText}
          </button>
          <button
            className="btn btn-ghost btn-full setup-skip"
            onClick={onComplete}
            disabled={running}
          >
            Skip (already set up)
          </button>
          {showLog && (
            <div className="setup-log visible" ref={logRef}>
              {logLines.map((line, i) => (
                <div key={i} className={line.cls || undefined}>
                  {line.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
