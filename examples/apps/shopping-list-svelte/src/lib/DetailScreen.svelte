<script>
  import { onMount, onDestroy } from 'svelte';
  import {
    accessToken, currentScreen, currentList, items,
    lists, uncheckedItems, checkedItems, progressPct,
    progressText, addToast
  } from '../stores.js';
  import { apiRest, parseJwt } from '../api.js';

  let itemName = '';
  let itemQty = '1';
  let pollTimer = null;
  let suppressNotifications = false;
  let knownItemIds = new Set();
  let showShareModal = false;
  let itemNameInput;

  // Expose share modal state for the ShareModal component
  import { writable } from 'svelte/store';
  import { shareModalOpen } from './ShareModal.svelte';

  onMount(() => {
    knownItemIds.clear();
    loadItems();
    startPolling();
  });

  onDestroy(() => {
    stopPolling();
  });

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => { loadItems(); }, 2000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function loadItems() {
    if (!$currentList) return;

    try {
      const data = await apiRest('GET', 'shopping_items?list_id=eq.' + $currentList.id + '&order=checked.asc,created_at.desc');
      const newItems = Array.isArray(data) ? data : [];
      detectChanges(newItems);
      $items = newItems;
    } catch (err) {
      console.error('Load items failed:', err);
    }
  }

  function detectChanges(newItems) {
    if (suppressNotifications || knownItemIds.size === 0) {
      newItems.forEach(it => knownItemIds.add(it.id));
      return;
    }

    const claims = parseJwt($accessToken);
    const myUserId = claims ? claims.sub : null;

    newItems.forEach(it => {
      if (!knownItemIds.has(it.id)) {
        knownItemIds.add(it.id);
        if (it.added_by !== myUserId) {
          showNotification('Item added', it.name + (it.quantity !== '1' ? ' x' + it.quantity : ''));
        }
        return;
      }
      const old = $items.find(o => o.id === it.id);
      if (old && old.checked !== it.checked && it.added_by !== myUserId) {
        if (it.checked) {
          showNotification('Item checked off', it.name);
        }
      }
    });
  }

  function showNotification(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, { body, icon: 'icon.svg', tag: 'wtb-' + Date.now() });
      } catch (e) { /* ignore */ }
    }
    addToast(title + ': ' + body, 'info');
  }

  async function handleAddItem() {
    if (!$currentList) return;
    const name = itemName.trim();
    const qty = itemQty.trim() || '1';
    if (!name) return;

    const claims = parseJwt($accessToken);
    const body = {
      list_id: $currentList.id,
      name,
      quantity: qty,
      checked: false,
      added_by: claims ? claims.sub : null
    };

    suppressNotifications = true;
    setTimeout(() => { suppressNotifications = false; }, 3000);

    try {
      const created = await apiRest('POST', 'shopping_items', body);
      $items = [created, ...$items];
      knownItemIds.add(created.id);
      itemName = '';
      itemQty = '1';
      if (itemNameInput) itemNameInput.focus();
    } catch (err) {
      addToast('Failed to add: ' + err.message, 'error');
    }
  }

  function toggleItem(id, checked) {
    const idx = $items.findIndex(i => i.id === id);
    if (idx === -1) return;

    const prev = $items[idx].checked;
    // Optimistic update
    $items[idx] = { ...$items[idx], checked };
    $items = $items;

    suppressNotifications = true;
    setTimeout(() => { suppressNotifications = false; }, 3000);

    apiRest('PATCH', 'shopping_items?id=eq.' + id, { checked }).catch(err => {
      // Rollback
      $items[idx] = { ...$items[idx], checked: prev };
      $items = $items;
      addToast('Update failed: ' + err.message, 'error');
    });
  }

  function deleteItem(id) {
    const idx = $items.findIndex(i => i.id === id);
    if (idx === -1) return;

    const removed = $items[idx];
    // Optimistic removal
    $items = $items.filter(i => i.id !== id);
    knownItemIds.delete(id);

    apiRest('DELETE', 'shopping_items?id=eq.' + id).catch(err => {
      // Rollback
      $items = [...$items.slice(0, idx), removed, ...$items.slice(idx)];
      knownItemIds.add(id);
      addToast('Delete failed: ' + err.message, 'error');
    });
  }

  function handleDeleteList() {
    if (!$currentList) return;
    if (!confirm('Delete "' + $currentList.name + '" and all its items?')) return;

    apiRest('DELETE', 'shopping_lists?id=eq.' + $currentList.id).then(() => {
      addToast('List deleted', 'success');
      goBack();
    }).catch(err => {
      addToast('Delete failed: ' + err.message, 'error');
    });
  }

  function goBack() {
    stopPolling();
    $currentList = null;
    $items = [];
    $currentScreen = 'lists';
  }

  function openShare() {
    $shareModalOpen = true;
  }
</script>

<div class="detail-bar">
  <button class="btn btn-icon btn-ghost" on:click={goBack} title="Back">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
  </button>
  <h1>{$currentList ? $currentList.name : 'List'}</h1>
  <button class="btn btn-icon btn-ghost" on:click={openShare} title="Share">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
  </button>
  <button class="btn btn-icon btn-danger" on:click={handleDeleteList} title="Delete list">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
  </button>
</div>

<div class="progress-strip">
  <div class="progress-bar-wrap">
    <div class="progress-bar" style="width:{$progressPct}%"></div>
  </div>
  <div class="progress-text">{$progressText}</div>
</div>

<form class="add-item-row" on:submit|preventDefault={handleAddItem}>
  <input
    type="text"
    class="input"
    placeholder="Add item..."
    required
    maxlength="200"
    bind:value={itemName}
    bind:this={itemNameInput}
  >
  <input
    type="text"
    class="input qty-input"
    placeholder="Qty"
    maxlength="10"
    bind:value={itemQty}
  >
  <button type="submit" class="btn btn-primary btn-icon" title="Add">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
  </button>
</form>

<div>
  {#if $items.length === 0}
    <div class="empty-items">
      <div style="font-size:40px; opacity:0.4;">&#x1F6D2;</div>
      <p>List is empty. Add items above!</p>
    </div>
  {:else}
    <ul class="item-list">
      {#if $uncheckedItems.length > 0}
        <li class="item-separator">To buy ({$uncheckedItems.length})</li>
        {#each $uncheckedItems as item (item.id)}
          <li class="item-row">
            <input
              type="checkbox"
              class="item-checkbox"
              checked={false}
              on:change={() => toggleItem(item.id, true)}
            >
            <div class="item-info">
              <div class="item-name">{item.name}</div>
            </div>
            <span class="item-qty">x{item.quantity || '1'}</span>
            <button class="btn btn-danger item-delete" title="Remove" on:click|stopPropagation={() => deleteItem(item.id)}>
              &#x2715;
            </button>
          </li>
        {/each}
      {/if}

      {#if $checkedItems.length > 0}
        <li class="item-separator">In cart ({$checkedItems.length})</li>
        {#each $checkedItems as item (item.id)}
          <li class="item-row checked">
            <input
              type="checkbox"
              class="item-checkbox"
              checked={true}
              on:change={() => toggleItem(item.id, false)}
            >
            <div class="item-info">
              <div class="item-name">{item.name}</div>
            </div>
            <span class="item-qty">x{item.quantity || '1'}</span>
            <button class="btn btn-danger item-delete" title="Remove" on:click|stopPropagation={() => deleteItem(item.id)}>
              &#x2715;
            </button>
          </li>
        {/each}
      {/if}
    </ul>
  {/if}
</div>
