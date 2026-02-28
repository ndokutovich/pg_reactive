<script setup>
import { ref, provide, onMounted, onUnmounted } from 'vue'
import { apiRest } from './api.js'
import { useAuth } from './composables/useAuth.js'
import { useToast } from './composables/useToast.js'
import SetupScreen from './components/SetupScreen.vue'
import AuthScreen from './components/AuthScreen.vue'
import ListsScreen from './components/ListsScreen.vue'
import DetailScreen from './components/DetailScreen.vue'
import ShareModal from './components/ShareModal.vue'
import Toast from './components/Toast.vue'
import './App.css'

const auth = useAuth()
const { toasts, toast } = useToast()

const screen = ref('setup')
const currentList = ref(null)
const showShareModal = ref(false)

provide('auth', auth)
provide('toast', toast)
provide('screen', screen)
provide('currentList', currentList)

function navigate(path) {
  location.hash = '#/' + path
}

function dispatch() {
  const hash = location.hash || '#/setup'
  const parts = hash.slice(2).split('/')
  const route = parts[0] || 'setup'

  if (route === 'setup') screen.value = 'setup'
  else if (route === 'auth') screen.value = 'auth'
  else if (route === 'lists') screen.value = 'lists'
  else if (route === 'list' && parts[1]) {
    const listId = parseInt(parts[1])
    if (currentList.value && currentList.value.id === listId) {
      screen.value = 'detail'
    } else if (auth.accessToken.value) {
      apiRest('GET', 'shopping_lists?id=eq.' + listId + '&select=*', undefined, auth.accessToken.value)
        .then(data => {
          if (Array.isArray(data) && data.length > 0) {
            currentList.value = data[0]
            screen.value = 'detail'
          } else {
            navigate('lists')
          }
        }).catch(() => navigate('lists'))
    } else {
      navigate('auth')
    }
  } else {
    screen.value = 'setup'
  }
}

function goToAuth() { navigate('auth') }
function goToLists() { navigate('lists') }
function openList(list) {
  currentList.value = list
  navigate('list/' + list.id)
}
function goBackToLists() {
  currentList.value = null
  navigate('lists')
}

function openShare() {
  showShareModal.value = true
}

function closeShare() {
  showShareModal.value = false
}

function handleLogout() {
  auth.logout()
  currentList.value = null
  navigate('auth')
}

function handleVisibility() {
  if (document.visibilityState === 'visible') {
    auth.refreshIfNeeded()
  }
}

onMounted(() => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.log('SW registration failed:', err)
    })
  }

  // Restore session
  const restored = auth.restoreSession()
  if (restored && (!location.hash || location.hash === '#/' || location.hash === '#/setup' || location.hash === '#/auth')) {
    navigate('lists')
  }

  // Start hash routing
  window.addEventListener('hashchange', dispatch)
  dispatch()

  // Visibility change for token refresh
  document.addEventListener('visibilitychange', handleVisibility)
})

onUnmounted(() => {
  window.removeEventListener('hashchange', dispatch)
  document.removeEventListener('visibilitychange', handleVisibility)
})
</script>

<template>
  <Toast :toasts="toasts" />

  <SetupScreen
    v-if="screen === 'setup'"
    @skip="goToAuth"
    @done="goToAuth"
  />

  <AuthScreen
    v-if="screen === 'auth'"
    @authenticated="goToLists"
  />

  <ListsScreen
    v-if="screen === 'lists'"
    @open-list="openList"
    @logout="handleLogout"
  />

  <DetailScreen
    v-if="screen === 'detail'"
    :list="currentList"
    @back="goBackToLists"
    @share="openShare"
    @deleted="goBackToLists"
  />

  <ShareModal
    v-if="showShareModal && currentList"
    :list="currentList"
    @close="closeShare"
  />
</template>
