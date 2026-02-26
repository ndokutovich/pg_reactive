<script>
  import { fly, fade } from 'svelte/transition';
  import { toasts } from '../stores.js';
</script>

<div class="toast-area">
  {#each $toasts as toast (toast.id)}
    <div
      class="toast toast-{toast.type}"
      in:fly={{ x: 30, duration: 300 }}
      out:fade={{ duration: 300 }}
    >
      {toast.msg}
    </div>
  {/each}
</div>
