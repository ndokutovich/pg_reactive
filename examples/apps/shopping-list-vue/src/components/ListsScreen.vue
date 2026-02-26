<script setup>
import { ref, inject, onMounted } from 'vue'
import { apiRpc } from '../api.js'

const emit = defineEmits(['open-list', 'logout'])
const auth = inject('auth')
const toast = inject('toast')

const lists = ref([])
const loading = ref(true)
const newListName = ref('')
const shareCode = ref('')
const creating = ref(false)
const joining = ref(false)

onMounted(() => {
  requestNotificationPermission()
  loadLists()
})

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

async function loadLists() {
  loading.value = true
  try {
    const data = await apiRpc('my_shopping_lists', {}, auth.accessToken.value)
    lists.value = Array.isArray(data) ? data : []
  } catch (err) {
    toast('Failed to load lists: ' + err.message, 'error')
  } finally {
    loading.value = false
  }
}

async function handleCreateList() {
  const name = newListName.value.trim()
  if (!name) return

  creating.value = true
  try {
    await apiRpc('create_shopping_list', { list_name: name }, auth.accessToken.value)
    newListName.value = ''
    toast('List created!', 'success')
    await loadLists()
  } catch (err) {
    toast('Failed: ' + err.message, 'error')
  } finally {
    creating.value = false
  }
}

async function handleJoinList() {
  const code = shareCode.value.trim()
  if (!code) return

  joining.value = true
  try {
    const data = await apiRpc('join_shopping_list', { code }, auth.accessToken.value)
    shareCode.value = ''
    toast('Joined list: ' + (data.name || 'Success'), 'success')
    await loadLists()
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    joining.value = false
  }
}

function formatCode(code) {
  return (code || '').toUpperCase()
}
</script>

<template>
  <div class="screen-enter-active">
    <div class="app-bar">
      <h1>&#x1F6D2; What to Buy</h1>
      <div class="app-bar-right">
        <span class="user-email">{{ auth.userEmail.value }}</span>
        <button class="btn btn-ghost" @click="$emit('logout')">Log out</button>
      </div>
    </div>

    <div class="main-pad">
      <div class="section-label">Create New List</div>
      <form class="action-row" @submit.prevent="handleCreateList">
        <input
          v-model="newListName"
          type="text"
          class="input"
          placeholder="e.g. Weekly groceries"
          required
          maxlength="100"
        >
        <button
          type="submit"
          class="btn btn-primary"
          :disabled="creating"
        >
          Create
        </button>
      </form>

      <div class="section-label">Join a List</div>
      <form class="action-row" @submit.prevent="handleJoinList">
        <input
          v-model="shareCode"
          type="text"
          class="input"
          placeholder="Enter share code"
          required
          maxlength="10"
          style="text-transform:uppercase; letter-spacing:0.1em; font-weight:600;"
        >
        <button
          type="submit"
          class="btn btn-secondary"
          :disabled="joining"
        >
          Join
        </button>
      </form>

      <div class="section-label">My Lists</div>

      <div v-if="loading" style="text-align:center; padding:20px;">
        <div class="spinner"></div>
      </div>

      <div v-else-if="lists.length === 0" class="empty-lists">
        <div style="font-size:40px; opacity:0.4;">&#x1F4CB;</div>
        <p>No lists yet. Create one or join with a share code!</p>
      </div>

      <div v-else>
        <div
          v-for="list in lists"
          :key="list.id"
          class="list-card"
          @click="$emit('open-list', list)"
        >
          <div class="list-card-icon">&#x1F6D2;</div>
          <div class="list-card-info">
            <div class="list-card-name">{{ list.name }}</div>
            <div class="list-card-meta">
              <span>&#x1F465; {{ list.member_count }}</span>
              <span>Code: {{ formatCode(list.share_code) }}</span>
            </div>
          </div>
          <div class="list-card-progress">
            {{ list.checked_count }}/{{ list.item_count }}
          </div>
        </div>
      </div>

      <div class="app-footer">
        Built with pgStack &mdash; PostgreSQL + Rust + Row Level Security
      </div>
    </div>
  </div>
</template>
