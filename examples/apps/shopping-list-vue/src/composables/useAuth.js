import { ref, computed } from 'vue'
import { API_BASE, parseJwt } from '../api.js'

const accessToken = ref(null)
const currentUser = ref(null)

export function useAuth() {
  const isLoggedIn = computed(() => !!accessToken.value)

  const userEmail = computed(() => currentUser.value?.email || '')

  const userId = computed(() => {
    if (!accessToken.value) return null
    const claims = parseJwt(accessToken.value)
    return claims ? claims.sub : null
  })

  async function login(email, password) {
    const res = await fetch(API_BASE + '/auth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email, password })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || data.message || 'Login failed')
    accessToken.value = data.access_token
    currentUser.value = data.user
    return data
  }

  async function signup(email, password) {
    const res = await fetch(API_BASE + '/auth/v1/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || data.message || 'Signup failed')
    accessToken.value = data.access_token
    currentUser.value = data.user
    return data
  }

  function logout() {
    const token = accessToken.value
    if (token) {
      fetch(API_BASE + '/auth/v1/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        }
      }).catch(() => {})
    }
    accessToken.value = null
    currentUser.value = null
  }

  return {
    accessToken,
    currentUser,
    isLoggedIn,
    userEmail,
    userId,
    login,
    signup,
    logout
  }
}
