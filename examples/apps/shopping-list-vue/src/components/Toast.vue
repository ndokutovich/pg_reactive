<script setup>
defineProps({
  toasts: {
    type: Array,
    required: true
  }
})
</script>

<template>
  <div class="toast-area">
    <div
      v-for="t in toasts"
      :key="t.id"
      :class="['toast', 'toast-' + t.type]"
    >
      {{ t.message }}
    </div>
  </div>
</template>
