<script>
  import { onMount } from 'svelte';
  import {
    accessToken, currentUser, currentScreen,
    lists, currentList, items, addToast
  } from '../stores.js';
  import { apiRpc } from '../api.js';

  let listName = '';
  let shareCode = '';
  let creating = false;
  let joining = false;
  let loading = true;

  onMount(() => {
    requestNotificationPermission();
    loadLists();
  });

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  async function loadLists() {
    loading = true;
    try {
      const data = await apiRpc('my_shopping_lists');
      $lists = Array.isArray(data) ? data : [];
    } catch (err) {
      addToast('Failed to load lists: ' + err.message, 'error');
    } finally {
      loading = false;
    }
  }

  async function handleCreateList() {
    const name = listName.trim();
    if (!name) return;

    creating = true;
    try {
      await apiRpc('create_shopping_list', { list_name: name });
      listName = '';
      addToast('List created!', 'success');
      await loadLists();
    } catch (err) {
      addToast('Failed: ' + err.message, 'error');
    } finally {
      creating = false;
    }
  }

  async function handleJoinList() {
    const code = shareCode.trim();
    if (!code) return;

    joining = true;
    try {
      const data = await apiRpc('join_shopping_list', { code });
      shareCode = '';
      addToast('Joined list: ' + (data.name || 'Success'), 'success');
      await loadLists();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      joining = false;
    }
  }

  function openList(list) {
    $currentList = list;
    $currentScreen = 'detail';
  }

  function handleLogout() {
    const token = $accessToken;
    if (token) {
      fetch('http://127.0.0.1:8080/auth/v1/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        }
      }).catch(() => {});
    }

    $accessToken = null;
    $currentUser = null;
    $lists = [];
    $currentList = null;
    $items = [];
    $currentScreen = 'auth';
  }
</script>

<div class="app-bar">
  <h1>&#x1F6D2; What to Buy</h1>
  <div class="app-bar-right">
    {#if $currentUser}
      <span class="user-email">{$currentUser.email}</span>
    {/if}
    <button class="btn btn-ghost" on:click={handleLogout}>Log out</button>
  </div>
</div>

<div class="main-pad">
  <div class="section-label">Create New List</div>
  <form class="action-row" on:submit|preventDefault={handleCreateList}>
    <input
      type="text"
      class="input"
      placeholder="e.g. Weekly groceries"
      required
      maxlength="100"
      bind:value={listName}
    >
    <button type="submit" class="btn btn-primary" disabled={creating}>Create</button>
  </form>

  <div class="section-label">Join a List</div>
  <form class="action-row" on:submit|preventDefault={handleJoinList}>
    <input
      type="text"
      class="input"
      placeholder="Enter share code"
      required
      maxlength="10"
      style="text-transform:uppercase; letter-spacing:0.1em; font-weight:600;"
      bind:value={shareCode}
    >
    <button type="submit" class="btn btn-secondary" disabled={joining}>Join</button>
  </form>

  <div class="section-label">My Lists</div>

  {#if loading}
    <div style="text-align:center; padding:20px;">
      <div class="spinner"></div>
    </div>
  {:else if $lists.length === 0}
    <div class="empty-lists">
      <div style="font-size:40px; opacity:0.4;">&#x1F4CB;</div>
      <p>No lists yet. Create one or join with a share code!</p>
    </div>
  {:else}
    {#each $lists as list (list.id)}
      <div
        class="list-card"
        on:click={() => openList(list)}
        on:keydown={e => e.key === 'Enter' && openList(list)}
        role="button"
        tabindex="0"
      >
        <div class="list-card-icon">&#x1F6D2;</div>
        <div class="list-card-info">
          <div class="list-card-name">{list.name}</div>
          <div class="list-card-meta">
            <span>&#x1F465; {list.member_count}</span>
            <span>Code: {(list.share_code || '').toUpperCase()}</span>
          </div>
        </div>
        <div class="list-card-progress">{list.checked_count}/{list.item_count}</div>
      </div>
    {/each}
  {/if}

  <div class="app-footer">
    Built with pgStack &mdash; PostgreSQL + Rust + Row Level Security
  </div>
</div>
