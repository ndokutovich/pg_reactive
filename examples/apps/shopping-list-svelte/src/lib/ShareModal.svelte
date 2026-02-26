<script context="module">
  import { writable } from 'svelte/store';
  export const shareModalOpen = writable(false);
</script>

<script>
  import { currentList } from '../stores.js';

  let copyFeedback = '';
  let canNativeShare = typeof navigator !== 'undefined' && !!navigator.share;

  $: shareCode = $currentList ? ($currentList.share_code || '').toUpperCase() : '------';

  function close() {
    $shareModalOpen = false;
    copyFeedback = '';
  }

  function handleOverlayClick(e) {
    if (e.target === e.currentTarget) close();
  }

  function copyCode() {
    navigator.clipboard.writeText(shareCode).then(() => {
      copyFeedback = 'Copied!';
    }).catch(() => {
      copyFeedback = 'Copy failed -- select and copy manually';
    });
  }

  function nativeShare() {
    if (!$currentList || !navigator.share) return;
    navigator.share({
      title: 'Join my shopping list: ' + $currentList.name,
      text: 'Use code ' + shareCode + ' to join my shopping list on What to Buy!'
    }).catch(() => { /* user cancelled */ });
  }
</script>

{#if $shareModalOpen}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div
    class="modal-overlay"
    on:click={handleOverlayClick}
    on:keydown={e => e.key === 'Escape' && close()}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <div class="modal-box">
      <h3>Share This List</h3>
      <p>Give this code to your partner so they can join the list.</p>
      <div class="share-code-display">{shareCode}</div>
      <div class="copy-feedback">{copyFeedback}</div>
      <button class="btn btn-primary btn-full" on:click={copyCode}>Copy Code</button>
      {#if canNativeShare}
        <button class="btn btn-ghost btn-full" style="margin-top:8px;" on:click={nativeShare}>Share via...</button>
      {/if}
      <button class="btn btn-ghost btn-full" style="margin-top:8px;" on:click={close}>Close</button>
    </div>
  </div>
{/if}
