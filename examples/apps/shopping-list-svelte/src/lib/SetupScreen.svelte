<script>
  import { currentScreen } from '../stores.js';
  import { apiSql } from '../api.js';
  import { MIGRATION_SQL } from '../migration.js';

  let running = false;
  let done = false;
  let logEntries = [];
  let logVisible = false;
  let logEl;

  function appendLog(text, cls = '') {
    logEntries = [...logEntries, { text, cls }];
    // Scroll to bottom after DOM update
    setTimeout(() => {
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }, 0);
  }

  async function runSetup() {
    running = true;
    logVisible = true;
    logEntries = [];
    let allOk = true;

    for (let i = 0; i < MIGRATION_SQL.length; i++) {
      const stmt = MIGRATION_SQL[i];
      let short = stmt.replace(/\n/g, ' ');
      if (short.length > 60) short = short.substring(0, 60) + '...';
      appendLog('> ' + short);

      try {
        const result = await apiSql(stmt);
        if (result.error) {
          if (result.error.indexOf('already exists') !== -1 || result.error.indexOf('duplicate') !== -1) {
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
      appendLog('');
      appendLog('Setup complete! Proceeding to sign in...', 'ok');
      appendLog('NOTE: If REST calls fail, restart proxy: docker compose restart proxy', 'ok');
      done = true;
      setTimeout(() => { $currentScreen = 'auth'; }, 1200);
    } else {
      appendLog('');
      appendLog('Setup finished with errors. You may retry.', 'error');
      running = false;
    }
  }

  function skipSetup() {
    $currentScreen = 'auth';
  }
</script>

<div class="setup-hero card">
  <div class="card-body">
    <div class="setup-icon">&#x1F6D2;</div>
    <h1>What to Buy</h1>
    <p>A shared shopping list for couples. Set up the database to get started.</p>

    <button
      class="btn btn-primary btn-full"
      on:click={runSetup}
      disabled={running}
    >
      {#if done}
        Done!
      {:else if running}
        Setting up...
      {:else}
        Setup Database
      {/if}
    </button>

    <button
      class="btn btn-ghost btn-full setup-skip"
      on:click={skipSetup}
    >
      Skip (already set up)
    </button>

    {#if logVisible}
      <div class="setup-log" bind:this={logEl}>
        {#each logEntries as entry}
          <div class={entry.cls}>{entry.text}</div>
        {/each}
      </div>
    {/if}
  </div>
</div>
