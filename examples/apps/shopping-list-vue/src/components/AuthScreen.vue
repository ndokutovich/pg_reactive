<script setup>
import { ref, inject } from 'vue'

const emit = defineEmits(['authenticated'])
const auth = inject('auth')
const toast = inject('toast')

const isSignUp = ref(true)
const email = ref('')
const password = ref('')
const error = ref('')
const submitting = ref(false)

const title = () => isSignUp.value ? 'Sign Up' : 'Log In'
const subtitle = () => isSignUp.value
  ? 'Create your account to start shopping together'
  : 'Welcome back!'
const submitLabel = () => isSignUp.value ? 'Sign Up' : 'Log In'
const toggleText = () => isSignUp.value ? 'Already have an account?' : 'Need an account?'
const toggleLinkText = () => isSignUp.value ? 'Log In' : 'Sign Up'

function toggleMode() {
  isSignUp.value = !isSignUp.value
  error.value = ''
}

async function handleSubmit() {
  error.value = ''
  submitting.value = true
  const origText = submitLabel()

  try {
    if (isSignUp.value) {
      await auth.signup(email.value.trim(), password.value)
    } else {
      await auth.login(email.value.trim(), password.value)
    }
    emit('authenticated')
  } catch (err) {
    error.value = err.message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="screen-enter-active">
    <div class="auth-wrap">
      <div class="card">
        <div class="card-body">
          <div class="auth-header">
            <h2>{{ title() }}</h2>
            <p class="subtitle">{{ subtitle() }}</p>
          </div>

          <div v-if="error" class="alert alert-error">
            {{ error }}
          </div>

          <form @submit.prevent="handleSubmit">
            <div class="form-group">
              <label for="auth-email">Email</label>
              <input
                id="auth-email"
                v-model="email"
                type="email"
                class="input"
                placeholder="you@example.com"
                required
                autocomplete="email"
              >
            </div>
            <div class="form-group">
              <label for="auth-password">Password</label>
              <input
                id="auth-password"
                v-model="password"
                type="password"
                class="input"
                placeholder="At least 6 characters"
                required
                minlength="6"
                autocomplete="current-password"
              >
            </div>
            <button
              type="submit"
              class="btn btn-primary btn-full"
              :disabled="submitting"
            >
              {{ submitting ? 'Please wait...' : submitLabel() }}
            </button>
          </form>

          <div class="auth-toggle">
            <span>{{ toggleText() }} </span>
            <a @click="toggleMode">{{ toggleLinkText() }}</a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
