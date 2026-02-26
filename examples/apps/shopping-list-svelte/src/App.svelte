<script>
  import { onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { currentScreen } from './stores.js';
  import SetupScreen from './lib/SetupScreen.svelte';
  import AuthScreen from './lib/AuthScreen.svelte';
  import ListsScreen from './lib/ListsScreen.svelte';
  import DetailScreen from './lib/DetailScreen.svelte';
  import Toast from './lib/Toast.svelte';
  import ShareModal from './lib/ShareModal.svelte';

  onMount(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.log('SW registration failed:', err);
      });
    }
  });
</script>

<Toast />
<ShareModal />

{#key $currentScreen}
  <div in:fly={{ y: 6, duration: 250 }} out:fade={{ duration: 100 }}>
    {#if $currentScreen === 'setup'}
      <SetupScreen />
    {:else if $currentScreen === 'auth'}
      <AuthScreen />
    {:else if $currentScreen === 'lists'}
      <ListsScreen />
    {:else if $currentScreen === 'detail'}
      <DetailScreen />
    {/if}
  </div>
{/key}
