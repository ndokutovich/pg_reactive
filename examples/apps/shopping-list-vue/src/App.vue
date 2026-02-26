<script setup>
import { ref, provide, onMounted } from 'vue'
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

// Screen state: 'setup' | 'auth' | 'lists' | 'detail'
const screen = ref('setup')
const currentList = ref(null)
const showShareModal = ref(false)

provide('auth', auth)
provide('toast', toast)
provide('screen', screen)
provide('currentList', currentList)

function goToAuth() {
  screen.value = 'auth'
}

function goToLists() {
  screen.value = 'lists'
}

function openList(list) {
  currentList.value = list
  screen.value = 'detail'
}

function goBackToLists() {
  currentList.value = null
  screen.value = 'lists'
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
  screen.value = 'auth'
}

onMounted(() => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.log('SW registration failed:', err)
    })
  }
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
