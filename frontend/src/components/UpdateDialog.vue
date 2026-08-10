<script setup>
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { CheckCircle, Download, ExternalLink, Key, LoaderCircle, RefreshCw, X } from 'lucide-vue-next'
import { get, post } from '../api'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['close'])

const checking = ref(false)
const result = ref(null)
const updateStatus = ref(null)
const errorMessage = ref('')
let pollTimer = null
const dialog = ref(null)
const closeButton = ref(null)
let previousActiveEl = null

const showTokenInput = ref(false)
const tokenValue = ref('')
const tokenSaving = ref(false)
const tokenConfigured = ref(false)
const tokenMessage = ref('')

function clearPoll() {
  if (pollTimer) window.clearTimeout(pollTimer)
  pollTimer = null
}

async function checkUpdate() {
  checking.value = true
  errorMessage.value = ''
  updateStatus.value = null
  try {
    const [statusRes, updateRes] = await Promise.all([
      get('/api/system/update/github-token').catch(() => ({ configured: false })),
      get('/api/system/update/check'),
    ])
    tokenConfigured.value = statusRes.configured
    result.value = updateRes
    if (updateRes.error) errorMessage.value = updateRes.error
  } catch (error) {
    errorMessage.value = error.message
  } finally {
    checking.value = false
  }
}

async function saveToken() {
  if (!tokenValue.value.trim()) return
  tokenSaving.value = true
  tokenMessage.value = ''
  try {
    await fetch('/api/system/update/github-token', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenValue.value.trim() }),
    })
    tokenConfigured.value = true
    tokenValue.value = ''
    showTokenInput.value = false
    tokenMessage.value = 'Token 已保存'
    checkUpdate()
  } catch (error) {
    let msg = error.message
    try {
      const body = JSON.parse(msg)
      msg = body.detail || msg
    } catch {}
    tokenMessage.value = msg
  } finally {
    tokenSaving.value = false
  }
}

async function pollInstallStatus() {
  try {
    updateStatus.value = await get('/api/system/update/status')
    if (['starting', 'checking', 'backing_up', 'downloading', 'verifying'].includes(updateStatus.value.status)) {
      pollTimer = window.setTimeout(pollInstallStatus, 700)
    }
  } catch {
    // 程序即将退出并交给安装器时，轮询请求中断是正常现象。
  }
}

async function installUpdate() {
  errorMessage.value = ''
  updateStatus.value = { status: 'starting', message: '准备更新…' }
  try {
    await post('/api/system/update/install', {})
    pollInstallStatus()
  } catch (error) {
    errorMessage.value = error.message
  }
}

function close() {
  clearPoll()
  emit('close')
  nextTick(() => {
    if (previousActiveEl?.isConnected && typeof previousActiveEl.focus === 'function') previousActiveEl.focus()
    previousActiveEl = null
  })
}

function handleDialogKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab' || !dialog.value) return
  const focusable = [...dialog.value.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')]
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.open, value => {
  if (value) {
    previousActiveEl = document.activeElement
    checkUpdate()
    nextTick(() => closeButton.value?.focus())
  } else {
    clearPoll()
  }
})

onUnmounted(clearPoll)
</script>

<template>
  <div v-if="open" class="update-scrim" @click.self="close">
    <section ref="dialog" class="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title" tabindex="-1" @keydown="handleDialogKeydown">
      <div class="update-dialog-head">
        <div>
          <div id="update-title" class="update-title">软件更新</div>
          <div class="update-subtitle">保持工作台处于最新状态</div>
        </div>
        <button ref="closeButton" class="icon-button" type="button" aria-label="关闭更新窗口" @click="close">
          <X :size="18" />
        </button>
      </div>

      <div v-if="checking" class="update-state update-state-loading">
        <LoaderCircle class="spin" :size="22" />
        <span>正在检查最新版本…</span>
      </div>
      <div v-else-if="errorMessage" class="update-state update-state-error">
        <div>{{ errorMessage }}</div>
        <div class="update-actions" style="justify-content: center;">
          <button class="btn btn-outline" type="button" @click="checkUpdate"><RefreshCw :size="15" /> 重试</button>
          <button v-if="!tokenConfigured" class="btn btn-outline" type="button" @click="showTokenInput = !showTokenInput"><Key :size="15" /> 配置 Token</button>
        </div>
      </div>
      <div v-if="showTokenInput" class="update-token-section">
        <div class="update-token-title">配置 GitHub Token（私有仓库必需）</div>
        <div class="update-token-desc">前往 GitHub Settings → Developer settings → Personal access tokens 生成，需勾选 repo 权限。</div>
        <div class="update-token-row">
          <input v-model="tokenValue" type="password" class="update-token-input" placeholder="ghp_ 或 github_pat_" @keydown.enter="saveToken" />
          <button class="btn btn-primary btn-sm" type="button" :disabled="!tokenValue.trim() || tokenSaving" @click="saveToken">
            <LoaderCircle v-if="tokenSaving" class="spin" :size="13" />
            <span v-else>保存</span>
          </button>
        </div>
        <div v-if="tokenMessage" class="update-token-msg" :class="{ 'update-token-msg-ok': tokenConfigured }">{{ tokenMessage }}</div>
      </div>
      <template v-else-if="result">
        <div class="update-version-row">
          <span>当前版本 {{ result.current_version }}</span>
          <span>最新版本 {{ result.latest_version || '暂不可用' }}</span>
        </div>
        <div v-if="updateStatus" class="update-progress">
          <LoaderCircle v-if="!['error', 'up_to_date'].includes(updateStatus.status)" class="spin" :size="18" />
          <CheckCircle v-else-if="updateStatus.status === 'up_to_date'" :size="18" />
          <span>{{ updateStatus.message || updateStatus.error }}</span>
        </div>
        <div v-else-if="result.update_available" class="update-available">
          <div class="update-available-title">发现新版本 {{ result.latest_version }}</div>
          <div class="update-available-copy">更新将先下载并校验安装包，再启动系统安装程序。你的数据不会被覆盖。</div>
        </div>
        <div v-else class="update-state update-state-success">
          <CheckCircle :size="22" />
          <span>当前已经是最新版本</span>
        </div>
        <div v-if="result.release_notes" class="update-notes">{{ result.release_notes }}</div>
        <div class="update-actions">
          <a v-if="result.release_url" class="btn btn-outline" :href="result.release_url" target="_blank" rel="noreferrer">
            <ExternalLink :size="15" /> 查看发布说明
          </a>
          <button v-if="result.update_available && result.downloadable && !updateStatus" class="btn btn-primary" type="button" @click="installUpdate">
            <Download :size="15" /> 下载并安装
          </button>
          <button v-else-if="updateStatus?.status === 'error'" class="btn btn-primary" type="button" @click="installUpdate">
            <RefreshCw :size="15" /> 重试安装
          </button>
          <button v-else class="btn btn-outline" type="button" @click="checkUpdate">
            <RefreshCw :size="15" /> 重新检查
          </button>
          <button v-if="tokenConfigured" class="btn btn-outline" type="button" @click="showTokenInput = !showTokenInput" title="GitHub Token 已配置">
            <Key :size="14" /> 已配置
          </button>
        </div>
        <div v-if="result.update_available && !result.downloadable" class="update-warning">当前系统的安装包或校验文件暂不可用，请打开发布页手动下载。</div>
      </template>
    </section>
  </div>
</template>

<style>
.update-scrim { position: fixed; inset: 0; z-index: 500; display: grid; place-items: center; padding: 20px; background: rgba(20,24,38,.28); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.update-dialog { width: min(440px, 100%); padding: 22px; border: 1px solid rgba(255,255,255,.72); border-radius: 24px; background: rgba(255,255,255,.94); box-shadow: 0 24px 70px rgba(21,28,58,.22); animation: update-dialog-in 250ms cubic-bezier(.16,1,.3,1); }
.update-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.update-title { font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
.update-subtitle { margin-top: 4px; color: var(--text-secondary); font-size: 12px; }
.update-state { display: flex; align-items: center; justify-content: center; gap: 9px; min-height: 100px; color: var(--text-secondary); text-align: center; }
.update-state-success { color: var(--success); }
.update-state-error { flex-direction: column; color: var(--danger); }
.update-state-error .btn { color: var(--text); }
.update-version-row { display: flex; justify-content: space-between; gap: 12px; margin-top: 24px; color: var(--text-secondary); font-size: 12px; }
.update-available { margin-top: 18px; padding: 14px; border-radius: 14px; background: var(--primary-bg); }
.update-available-title { color: var(--primary); font-weight: 650; }
.update-available-copy { margin-top: 5px; color: var(--text-secondary); font-size: 12px; line-height: 1.55; }
.update-progress { display: flex; align-items: center; gap: 9px; min-height: 100px; color: var(--primary); font-size: 13px; }
.update-notes { max-height: 130px; margin-top: 14px; padding: 11px 12px; overflow: auto; border-radius: 10px; background: var(--bg); color: var(--text-secondary); font-size: 12px; line-height: 1.55; white-space: pre-line; }
.update-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
.update-warning { margin-top: 12px; color: var(--warning); font-size: 11px; line-height: 1.5; }
.update-token-section { margin-top: 14px; padding: 12px 14px; border-radius: 12px; background: var(--bg); border: 1px solid var(--border); }
.update-token-title { font-weight: 600; font-size: 13px; }
.update-token-desc { margin-top: 4px; color: var(--text-secondary); font-size: 11px; line-height: 1.5; }
.update-token-row { display: flex; gap: 8px; margin-top: 10px; }
.update-token-input { flex: 1; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; font-family: monospace; outline: none; }
.update-token-input:focus { border-color: var(--primary); }
.update-token-msg { margin-top: 6px; font-size: 11px; color: var(--danger); }
.update-token-msg-ok { color: var(--success); }
.btn-sm { padding: 5px 12px; font-size: 12px; }
.spin { animation: update-spin 900ms linear infinite; }
@keyframes update-dialog-in { from { opacity: 0; transform: scale(.96) translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes update-spin { to { transform: rotate(360deg); } }
@media (max-width: 640px) {
  .update-scrim { align-items: end; padding: 0; }
  .update-dialog { width: 100%; border-radius: 24px 24px 0 0; padding: 20px 18px calc(20px + env(safe-area-inset-bottom)); }
  .update-actions > * { flex: 1 1 150px; justify-content: center; }
}
@media (prefers-reduced-motion: reduce) {
  .update-dialog { animation: none; }
  .spin { animation: none; }
}
@media (prefers-reduced-transparency: reduce) {
  .update-scrim { background: rgba(20,24,38,.42); backdrop-filter: none; -webkit-backdrop-filter: none; }
  .update-dialog { background: #fff; }
}
</style>
