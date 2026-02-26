import { ref } from 'vue'

const toasts = ref([])
let nextId = 0

export function useToast() {
  function toast(message, type = 'info') {
    const id = nextId++
    toasts.value.push({ id, message, type })
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, 3200)
  }

  return {
    toasts,
    toast
  }
}
