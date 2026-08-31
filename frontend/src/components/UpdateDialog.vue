<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { CheckCircle, Download, ExternalLink, LoaderCircle, RefreshCw, WifiOff, X } from 'lucide-vue-next'
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

const isDesktop = typeof window !== 'undefined' && Boolean(window.workbenchDesktop?.isDesktop)
const installing = ref(false)
const installMessage = ref('')
const activeStatuses = new Set(['starting', 'checking', 'backing_up', 'downloading', 'retry_wait', 'verifying'])

const progressValue = computed(() => {
  const value = Number(updateStatus.value?.progress || 0)
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
})
const hasDownloadProgress = computed(() => Boolean(updateStatus.value)
  && ['downloading', 'retry_wait', 'verifying', 'ready_to_install'].includes(updateStatus.value.status)
  && Number(updateStatus.value.total_bytes || 0) > 0)

function clearPoll() {
  if (pollTimer) window.clearTimeout(pollTimer)
  pollTimer = null
}

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
}

function sourceLabel(source) {
  const value = String(source || '')
  if (!value) return ''
  if (value.includes('mirror')) return '镜像源'
  if (value.includes('github')) return 'GitHub Release'
  if (/^[\w.-]+\.[a-z]{2,}$/i.test(value)) return value
  return value
}

async function checkUpdate() {
  checking.value = true
  errorMessage.value = ''
  installMessage.value = ''
  try {
    result.value = await get('/api/system/update/check')
    if (result.value.error) errorMessage.value = result.value.error
    else await readInstallStatus()
  } catch (error) {
    errorMessage.value = error.message
  } finally {
    checking.value = false
  }
}

async function readInstallStatus() {
  try {
    const state = await get('/api/system/update/status')
    updateStatus.value = state?.status && state.status !== 'idle' ? state : null
    return state
  } catch {
    return null
  }
}

async function pollInstallStatus() {
  clearPoll()
  try {
    const state = await readInstallStatus()
    if (state && activeStatuses.has(state.status)) {
      pollTimer = window.setTimeout(pollInstallStatus, 650)
    }
  } catch {
    // Electron 正在退出并交给安装器时，本地 HTTP 中断属于正常现象。
  }
}

async function installUpdate() {
  errorMessage.value = ''
  installMessage.value = ''
  updateStatus.value = { status: 'starting', message: '准备更新…', progress: 0 }
  try {
    await post('/api/system/update/install', {})
    pollInstallStatus()
  } catch (error) {
    errorMessage.value = error.message
  }
}

async function launchInstaller() {
  if (installing.value || !window.workbenchDesktop?.installUpdate) return
  installing.value = true
  installMessage.value = ''
  const resultInfo = await window.workbenchDesktop.installUpdate()
    .catch(error => ({ ok: false, error: error.message || String(error) }))
  if (!resultInfo?.ok) {
    installing.value = false
    installMessage.value = resultInfo?.error || '启动安装程序失败，请稍后重试。'
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
          <div class="update-subtitle">下载中断后会保留进度，下次可继续</div>
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
        </div>
      </div>
      <template v-else-if="result">
        <div class="update-version-row">
          <span>当前版本 {{ result.current_version }}</span>
          <span>最新版本 {{ result.latest_version || '暂不可用' }}</span>
        </div>
        <div v-if="result.source" class="update-source-row">可用来源：{{ sourceLabel(result.source) }}</div>

        <div v-if="updateStatus" class="update-progress" :class="{ 'is-retrying': updateStatus.status === 'retry_wait', 'is-error': updateStatus.status === 'error' }">
          <div class="update-progress-head">
            <LoaderCircle v-if="activeStatuses.has(updateStatus.status) && updateStatus.status !== 'retry_wait'" class="spin" :size="18" />
            <WifiOff v-else-if="updateStatus.status === 'retry_wait'" :size="18" />
            <CheckCircle v-else-if="['ready_to_install', 'up_to_date'].includes(updateStatus.status)" :size="18" />
            <RefreshCw v-else-if="updateStatus.status === 'error'" :size="18" />
            <div>
              <strong>{{ updateStatus.message || updateStatus.error }}</strong>
              <small v-if="updateStatus.error && updateStatus.status !== 'error'">{{ updateStatus.error }}</small>
            </div>
          </div>

          <template v-if="hasDownloadProgress">
            <div class="update-progress-bar" role="progressbar" :aria-valuenow="Math.round(progressValue)" aria-valuemin="0" aria-valuemax="100">
              <i :style="{ width: `${progressValue}%` }"></i>
            </div>
            <div class="update-progress-meta">
              <span>{{ formatBytes(updateStatus.downloaded_bytes) }} / {{ formatBytes(updateStatus.total_bytes) }}</span>
              <strong>{{ Math.round(progressValue) }}%</strong>
            </div>
            <div class="update-progress-detail">
              <span v-if="updateStatus.speed_bytes_per_second > 0">{{ formatBytes(updateStatus.speed_bytes_per_second) }}/s</span>
              <span v-if="updateStatus.source">当前源：{{ sourceLabel(updateStatus.source) }}</span>
              <span v-if="updateStatus.retry_count">已自动重试 {{ updateStatus.retry_count }} 次</span>
            </div>
          </template>
        </div>

        <div v-else-if="result.update_available" class="update-available">
          <div class="update-available-title">发现新版本 {{ result.latest_version }}</div>
          <div class="update-available-copy">安装包会先在后台下载并校验。网络中断时已下载部分会保留，重新尝试会从断点继续。</div>
        </div>
        <div v-else class="update-state update-state-success">
          <CheckCircle :size="22" />
          <span>当前已经是最新版本</span>
        </div>

        <div v-if="result.release_notes" class="update-notes">{{ result.release_notes }}</div>
        <div v-if="installMessage" class="update-feedback">{{ installMessage }}</div>

        <div class="update-actions">
          <a v-if="result.release_url" class="btn btn-outline" :href="result.release_url" target="_blank" rel="noreferrer">
            <ExternalLink :size="15" /> 查看发布说明
          </a>
          <template v-if="updateStatus?.status === 'ready_to_install'">
            <button v-if="isDesktop" class="btn btn-primary" type="button" :disabled="installing" @click="launchInstaller">
              <Download :size="15" /> 安装并重启工作台
            </button>
            <span v-else class="update-warning">安装包已就绪，请在运行工作台的桌面客户端中点击安装。</span>
          </template>
          <button v-else-if="updateStatus?.status === 'error'" class="btn btn-primary" type="button" @click="installUpdate">
            <RefreshCw :size="15" /> 继续下载
          </button>
          <button v-else-if="result.update_available && result.downloadable && isDesktop && !updateStatus" class="btn btn-primary" type="button" @click="installUpdate">
            <Download :size="15" /> 下载更新
          </button>
          <button v-else-if="!updateStatus || !activeStatuses.has(updateStatus.status)" class="btn btn-outline" type="button" @click="checkUpdate">
            <RefreshCw :size="15" /> 重新检查
          </button>
        </div>
        <div v-if="result.update_available && !result.downloadable" class="update-warning">当前系统的安装包或校验信息暂不可用，请打开发布页手动下载。</div>
        <div v-else-if="result.update_available && result.downloadable && !isDesktop" class="update-warning">请在运行工作台的桌面客户端中下载和安装更新。</div>
      </template>
    </section>
  </div>
</template>

<style>
.update-scrim { position: fixed; inset: 0; z-index: 500; display: grid; place-items: center; padding: 20px; background: rgba(20,24,38,.28); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.update-dialog { width: min(470px, 100%); padding: 22px; border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-dialog); background: rgba(255,255,255,.98); box-shadow: var(--ds-shadow-overlay); animation: update-dialog-in var(--ds-duration-standard) var(--ds-ease-out); }
.update-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.update-title { font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
.update-subtitle { margin-top: 4px; color: var(--text-secondary); font-size: 12px; }
.update-state { display: flex; align-items: center; justify-content: center; gap: 9px; min-height: 100px; color: var(--text-secondary); text-align: center; }
.update-state-success { color: var(--success); }
.update-state-error { flex-direction: column; color: var(--danger); }
.update-state-error .btn { color: var(--text); }
.update-version-row { display: flex; justify-content: space-between; gap: 12px; margin-top: 24px; color: var(--text-secondary); font-size: 12px; }
.update-source-row { margin-top: 6px; color: var(--text-secondary); font-size: 11px; }
.update-available { margin-top: 18px; padding: 14px; border-radius: 14px; background: var(--primary-bg); }
.update-available-title { color: var(--primary); font-weight: 650; }
.update-available-copy { margin-top: 5px; color: var(--text-secondary); font-size: 12px; line-height: 1.55; }
.update-progress { display: grid; gap: 12px; margin-top: 18px; padding: 14px; border-radius: 14px; background: var(--primary-bg); color: var(--primary); }
.update-progress.is-retrying { background: var(--warning-bg, #fff7e8); color: var(--warning); }
.update-progress.is-error { background: var(--danger-bg, #fff1f0); color: var(--danger); }
.update-progress-head { display: flex; align-items: flex-start; gap: 9px; }
.update-progress-head > div { display: grid; gap: 3px; min-width: 0; }
.update-progress-head strong { font-size: 13px; font-weight: 650; }
.update-progress-head small { color: var(--text-secondary); font-size: 11px; line-height: 1.45; }
.update-progress-bar { height: 8px; overflow: hidden; border-radius: 99px; background: rgba(107,114,128,.16); }
.update-progress-bar i { display: block; height: 100%; border-radius: inherit; background: currentColor; transition: width 220ms ease; }
.update-progress-meta, .update-progress-detail { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--text-secondary); font-size: 11px; }
.update-progress-meta strong { color: var(--text); font-variant-numeric: tabular-nums; }
.update-progress-detail { justify-content: flex-start; flex-wrap: wrap; }
.update-notes { max-height: 130px; margin-top: 14px; padding: 11px 12px; overflow: auto; border-radius: 10px; background: var(--bg); color: var(--text-secondary); font-size: 12px; line-height: 1.55; white-space: pre-line; }
.update-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
.update-warning { margin-top: 12px; color: var(--warning); font-size: 11px; line-height: 1.5; }
.update-feedback { margin-top: 6px; color: var(--danger); font-size: 11px; }
.btn-sm { padding: 5px 12px; font-size: 12px; }
.spin { animation: update-spin 900ms linear infinite; }
@keyframes update-dialog-in { from { opacity: 0; transform: scale(.96) translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes update-spin { to { transform: rotate(360deg); } }
@media (max-width: 640px) {
  .update-scrim { align-items: end; padding: 0; }
  .update-dialog { width: 100%; border-radius: 24px 24px 0 0; padding: 20px 18px calc(20px + env(safe-area-inset-bottom)); }
  .update-actions > * { flex: 1 1 150px; justify-content: center; }
  .update-progress-meta { align-items: flex-start; }
}
@media (prefers-reduced-motion: reduce) {
  .update-dialog { animation: none; }
  .spin { animation: none; }
  .update-progress-bar i { transition: none; }
}
@media (prefers-reduced-transparency: reduce) {
  .update-scrim { background: rgba(20,24,38,.42); backdrop-filter: none; -webkit-backdrop-filter: none; }
  .update-dialog { background: #fff; }
}
</style>
