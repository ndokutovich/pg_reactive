<script>
  import { onMount, onDestroy } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { accessToken, currentUser, currentScreen, currentList } from './stores.js';
  import { loadSession, clearSession, tryRefresh, parseJwt, apiRest } from './api.js';
  import SetupScreen from './lib/SetupScreen.svelte';
  import AuthScreen from './lib/AuthScreen.svelte';
  import ListsScreen from './lib/ListsScreen.svelte';
  import DetailScreen from './lib/DetailScreen.svelte';
  import Toast from './lib/Toast.svelte';
  import ShareModal from './lib/ShareModal.svelte';

  function navigate(path) {
    location.hash = '#/' + path;
  }

  function dispatch() {
    const hash = location.hash || '#/setup';
    const parts = hash.slice(2).split('/');
    const route = parts[0] || 'setup';

    if (route === 'setup') { $currentScreen = 'setup'; return; }
    if (route === 'auth') { $currentScreen = 'auth'; return; }
    if (route === 'lists') {
      if (!$accessToken) { navigate('auth'); return; }
      $currentScreen = 'lists';
      return;
    }
    if (route === 'list' && parts[1]) {
      const listId = parseInt(parts[1], 10);
      if ($currentList && $currentList.id === listId) {
        $currentScreen = 'detail';
        return;
      }
      if (!$accessToken) { navigate('auth'); return; }
      apiRest('GET', 'shopping_lists?id=eq.' + listId + '&select=*')
        .then(data => {
          if (Array.isArray(data) && data.length > 0) {
            $currentList = data[0];
            $currentScreen = 'detail';
          } else {
            navigate('lists');
          }
        }).catch(() => navigate('lists'));
      return;
    }
    // Default
    if ($accessToken) navigate('lists');
    else $currentScreen = 'setup';
  }

  function handleVisibility() {
    if (document.visibilityState === 'visible' && $accessToken) {
      const claims = parseJwt($accessToken);
      if (claims && claims.exp && (claims.exp - Math.floor(Date.now() / 1000)) < 300) {
        tryRefresh().then(data => {
          if (data) {
            $accessToken = data.access_token;
            $currentUser = data.user;
          }
        });
      }
    }
  }

  let removeHashListener;
  let removeVisibilityListener;

  onMount(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.log('SW registration failed:', err);
      });
    }

    // Restore session
    const session = loadSession();
    if (session && session.access_token) {
      const claims = parseJwt(session.access_token);
      if (claims && (!claims.exp || (claims.exp - Math.floor(Date.now() / 1000)) > 300)) {
        $accessToken = session.access_token;
        $currentUser = session.user;
      } else if (claims) {
        // Token expiring soon or expired — try refresh
        tryRefresh().then(data => {
          if (data) {
            $accessToken = data.access_token;
            $currentUser = data.user;
          }
          dispatch();
        });
        // Set up listeners before early return
        window.addEventListener('hashchange', dispatch);
        removeHashListener = () => window.removeEventListener('hashchange', dispatch);
        document.addEventListener('visibilitychange', handleVisibility);
        removeVisibilityListener = () => document.removeEventListener('visibilitychange', handleVisibility);
        return;
      } else {
        clearSession();
      }
    }

    // Hash routing
    window.addEventListener('hashchange', dispatch);
    removeHashListener = () => window.removeEventListener('hashchange', dispatch);
    dispatch();

    // Visibility
    document.addEventListener('visibilitychange', handleVisibility);
    removeVisibilityListener = () => document.removeEventListener('visibilitychange', handleVisibility);
  });

  onDestroy(() => {
    if (removeHashListener) removeHashListener();
    if (removeVisibilityListener) removeVisibilityListener();
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
