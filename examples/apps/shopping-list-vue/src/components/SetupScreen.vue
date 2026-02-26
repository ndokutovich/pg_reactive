<script setup>
import { ref } from 'vue'
import { apiSql } from '../api.js'
import { MIGRATION_SQL } from '../migration.js'

const emit = defineEmits(['skip', 'done'])

const running = ref(false)
const buttonText = ref('Setup Database')
const showLog = ref(false)
const logLines = ref([])

function appendLog(text, cls = '') {
  logLines.value.push({ text, cls })
}

async function runSetup() {
  running.value = true
  buttonText.value = 'Setting up...'
  showLog.value = true
  logLines.value = []

  let allOk = true

  for (let i = 0; i < MIGRATION_SQL.length; i++) {
    const stmt = MIGRATION_SQL[i]
    let short = stmt.replace(/\n/g, ' ')
    if (short.length > 60) short = short.substring(0, 60) + '...'
    appendLog('> ' + short)

    try {
      const result = await apiSql(stmt)
      if (result.error) {
        if (result.error.indexOf('already exists') !== -1 || result.error.indexOf('duplicate') !== -1) {
          appendLog('  (skipped)', 'ok')
        } else {
          appendLog('  ERROR: ' + result.error, 'error')
          allOk = false
        }
      } else {
        appendLog('  OK', 'ok')
      }
    } catch (err) {
      appendLog('  NETWORK ERROR: ' + err.message, 'error')
      allOk = false
    }
  }

  if (allOk) {
    appendLog('')
    appendLog('Setup complete! Proceeding to sign in...', 'ok')
    appendLog('NOTE: If REST calls fail, restart proxy: docker compose restart proxy', 'ok')
    buttonText.value = 'Done!'
    setTimeout(() => emit('done'), 1200)
  } else {
    appendLog('')
    appendLog('Setup finished with errors. You may retry.', 'error')
    running.value = false
    buttonText.value = 'Retry Setup'
  }
}
</script>

<template>
  <div class="screen-enter-active">
    <div class="setup-hero card">
      <div class="card-body">
        <div class="setup-icon">&#x1F6D2;</div>
        <h1>What to Buy</h1>
        <p>A shared shopping list for couples. Set up the database to get started.</p>
        <button
          class="btn btn-primary btn-full"
          :disabled="running"
          @click="runSetup"
        >
          {{ buttonText }}
        </button>
        <button
          class="btn btn-ghost btn-full setup-skip"
          @click="$emit('skip')"
        >
          Skip (already set up)
        </button>
        <div v-if="showLog" class="setup-log" ref="logEl">
          <div
            v-for="(line, i) in logLines"
            :key="i"
            :class="line.cls"
          >{{ line.text }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
