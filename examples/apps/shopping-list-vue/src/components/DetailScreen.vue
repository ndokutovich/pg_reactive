<script setup>
import { ref, computed, inject, onMounted, onUnmounted } from 'vue'
import { apiRest, parseJwt, POLL_INTERVAL } from '../api.js'

const props = defineProps({
  list: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['back', 'share', 'deleted'])
const auth = inject('auth')
const toast = inject('toast')

const items = ref([])
const newItemName = ref('')
const newItemQty = ref('1')
const knownItemIds = ref(new Set())
let suppressNotifications = false
let pollTimer = null

const uncheckedItems = computed(() => items.value.filter(i => !i.checked))
const checkedItems = computed(() => items.value.filter(i => i.checked))
const total = computed(() => items.value.length)
const done = computed(() => checkedItems.value.length)
const progressPct = computed(() => total.value > 0 ? Math.round(done.value / total.value * 100) : 0)
const progressText = computed(() => done.value + ' / ' + total.value)

function showNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, icon: 'icon.svg', tag: 'wtb-' + Date.now() })
    } catch (e) { /* ignore */ }
  }
  toast(title + ': ' + body, 'info')
}

function detectChanges(newItems) {
  if (suppressNotifications || knownItemIds.value.size === 0) {
    newItems.forEach(it => knownItemIds.value.add(it.id))
    return
  }

  const myUserId = auth.userId.value

  newItems.forEach(it => {
    if (!knownItemIds.value.has(it.id)) {
      knownItemIds.value.add(it.id)
      if (it.added_by !== myUserId) {
        showNotification('Item added', it.name + (it.quantity !== '1' ? ' x' + it.quantity : ''))
      }
      return
    }
    const old = items.value.find(o => o.id === it.id)
    if (old && old.checked !== it.checked && it.added_by !== myUserId) {
      if (it.checked) {
        showNotification('Item checked off', it.name)
      }
    }
  })
}

async function loadItems() {
  if (!props.list) return
  try {
    const data = await apiRest(
      'GET',
      'shopping_items?list_id=eq.' + props.list.id + '&order=checked.asc,created_at.desc',
      undefined,
      auth.accessToken.value
    )
    const newItems = Array.isArray(data) ? data : []
    detectChanges(newItems)
    items.value = newItems
  } catch (err) {
    console.error('Load items failed:', err)
  }
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(() => loadItems(), POLL_INTERVAL)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function handleAddItem() {
  if (!props.list) return
  const name = newItemName.value.trim()
  const qty = newItemQty.value.trim() || '1'
  if (!name) return

  const claims = parseJwt(auth.accessToken.value)
  const body = {
    list_id: props.list.id,
    name,
    quantity: qty,
    checked: false,
    added_by: claims ? claims.sub : null
  }

  suppressNotifications = true
  setTimeout(() => { suppressNotifications = false }, 3000)

  try {
    const created = await apiRest('POST', 'shopping_items', body, auth.accessToken.value)
    items.value.unshift(created)
    knownItemIds.value.add(created.id)
    newItemName.value = ''
    newItemQty.value = '1'
  } catch (err) {
    toast('Failed to add: ' + err.message, 'error')
  }
}

function toggleItem(id, checked) {
  const item = items.value.find(i => i.id === id)
  if (!item) return

  const prev = item.checked
  item.checked = checked

  suppressNotifications = true
  setTimeout(() => { suppressNotifications = false }, 3000)

  apiRest('PATCH', 'shopping_items?id=eq.' + id, { checked }, auth.accessToken.value)
    .catch(err => {
      item.checked = prev
      toast('Update failed: ' + err.message, 'error')
    })
}

function deleteItem(id) {
  const idx = items.value.findIndex(i => i.id === id)
  if (idx === -1) return

  const removed = items.value.splice(idx, 1)[0]
  knownItemIds.value.delete(id)

  apiRest('DELETE', 'shopping_items?id=eq.' + id, undefined, auth.accessToken.value)
    .catch(err => {
      items.value.splice(idx, 0, removed)
      knownItemIds.value.add(id)
      toast('Delete failed: ' + err.message, 'error')
    })
}

function handleDeleteList() {
  if (!props.list) return
  if (!confirm('Delete "' + props.list.name + '" and all its items?')) return

  apiRest('DELETE', 'shopping_lists?id=eq.' + props.list.id, undefined, auth.accessToken.value)
    .then(() => {
      toast('List deleted', 'success')
      emit('deleted')
    })
    .catch(err => {
      toast('Delete failed: ' + err.message, 'error')
    })
}

onMounted(() => {
  knownItemIds.value.clear()
  loadItems()
  startPolling()
})

onUnmounted(() => {
  stopPolling()
})
</script>

<template>
  <div class="screen-enter-active">
    <!-- Top bar -->
    <div class="detail-bar">
      <button class="btn btn-icon btn-ghost" title="Back" @click="$emit('back')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <h1>{{ list.name }}</h1>
      <button class="btn btn-icon btn-ghost" title="Share" @click="$emit('share')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
      </button>
      <button class="btn btn-icon btn-danger" title="Delete list" @click="handleDeleteList">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>

    <!-- Progress strip -->
    <div class="progress-strip">
      <div class="progress-bar-wrap">
        <div class="progress-bar" :style="{ width: progressPct + '%' }"></div>
      </div>
      <div class="progress-text">{{ progressText }}</div>
    </div>

    <!-- Add item row -->
    <form class="add-item-row" @submit.prevent="handleAddItem">
      <input
        v-model="newItemName"
        type="text"
        class="input"
        placeholder="Add item..."
        required
        maxlength="200"
      >
      <input
        v-model="newItemQty"
        type="text"
        class="input qty-input"
        placeholder="Qty"
        maxlength="10"
      >
      <button type="submit" class="btn btn-primary btn-icon" title="Add">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </form>

    <!-- Items -->
    <div>
      <ul v-if="total > 0" class="item-list">
        <!-- Unchecked section -->
        <template v-if="uncheckedItems.length > 0">
          <li class="item-separator">To buy ({{ uncheckedItems.length }})</li>
          <li
            v-for="item in uncheckedItems"
            :key="item.id"
            class="item-row"
          >
            <input
              type="checkbox"
              class="item-checkbox"
              :checked="item.checked"
              @change="toggleItem(item.id, true)"
            >
            <div class="item-info">
              <div class="item-name">{{ item.name }}</div>
            </div>
            <span class="item-qty">x{{ item.quantity || '1' }}</span>
            <button
              class="btn btn-danger item-delete"
              title="Remove"
              @click.stop="deleteItem(item.id)"
            >&#x2715;</button>
          </li>
        </template>

        <!-- Checked section -->
        <template v-if="checkedItems.length > 0">
          <li class="item-separator">In cart ({{ checkedItems.length }})</li>
          <li
            v-for="item in checkedItems"
            :key="item.id"
            class="item-row checked"
          >
            <input
              type="checkbox"
              class="item-checkbox"
              :checked="item.checked"
              @change="toggleItem(item.id, false)"
            >
            <div class="item-info">
              <div class="item-name">{{ item.name }}</div>
            </div>
            <span class="item-qty">x{{ item.quantity || '1' }}</span>
            <button
              class="btn btn-danger item-delete"
              title="Remove"
              @click.stop="deleteItem(item.id)"
            >&#x2715;</button>
          </li>
        </template>
      </ul>

      <div v-else class="empty-items">
        <div style="font-size:40px; opacity:0.4;">&#x1F6D2;</div>
        <p>List is empty. Add items above!</p>
      </div>
    </div>
  </div>
</template>
