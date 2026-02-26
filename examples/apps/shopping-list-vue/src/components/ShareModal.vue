<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  list: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['close'])

const copyFeedback = ref('')
const hasNativeShare = typeof navigator !== 'undefined' && !!navigator.share

const shareCodeDisplay = computed(() => {
  return (props.list.share_code || '').toUpperCase()
})

function copyCode() {
  const code = shareCodeDisplay.value
  navigator.clipboard.writeText(code).then(() => {
    copyFeedback.value = 'Copied!'
  }).catch(() => {
    copyFeedback.value = 'Copy failed -- select and copy manually'
  })
}

function nativeShare() {
  if (!navigator.share) return
  navigator.share({
    title: 'Join my shopping list: ' + props.list.name,
    text: 'Use code ' + shareCodeDisplay.value + ' to join my shopping list on What to Buy!'
  }).catch(() => { /* user cancelled */ })
}

function onOverlayClick(e) {
  if (e.target === e.currentTarget) {
    emit('close')
  }
}
</script>

<template>
  <div class="modal-overlay" @click="onOverlayClick">
    <div class="modal-box">
      <h3>Share This List</h3>
      <p>Give this code to your partner so they can join the list.</p>
      <div class="share-code-display">{{ shareCodeDisplay }}</div>
      <div class="copy-feedback">{{ copyFeedback }}</div>
      <button class="btn btn-primary btn-full" @click="copyCode">Copy Code</button>
      <button
        v-if="hasNativeShare"
        class="btn btn-ghost btn-full"
        style="margin-top:8px;"
        @click="nativeShare"
      >
        Share via...
      </button>
      <button
        class="btn btn-ghost btn-full"
        style="margin-top:8px;"
        @click="$emit('close')"
      >
        Close
      </button>
    </div>
  </div>
</template>
