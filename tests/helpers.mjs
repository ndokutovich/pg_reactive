import { execFileSync } from 'child_process';

/**
 * Run a SQL statement inside the test DB container and return trimmed stdout.
 */
export function psql(sql) {
  return execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'pg_reactive_test', '-t', '-A', '-c', sql],
    { encoding: 'utf-8' }
  ).trim();
}

/**
 * Poll `messages` array until a message matching `predicate` appears or timeout.
 * Resolves with the matched message; rejects on timeout.
 */
export function waitForMessage(messages, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForMessage timeout')), timeoutMs);
    function check() {
      const m = messages.find(predicate);
      if (m) { clearTimeout(timer); resolve(m); }
      else { setTimeout(check, 50); }
    }
    check();
  });
}
