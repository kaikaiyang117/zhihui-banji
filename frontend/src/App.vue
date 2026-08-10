<script setup>
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MessageCircle, RefreshCw, Send, Settings } from 'lucide-vue-next'
import QRCode from 'qrcode'
import { NAV } from './sheets'
import { getIcon } from './icons'
import { clearDeviceCredential, del, get, post, streamPost } from './api'
import { renderAgentMarkdown } from './markdown'
import UpdateDialog from './components/UpdateDialog.vue'
import ContextSwitcher from './components/ContextSwitcher.vue'

const route = useRoute()
const router = useRouter()
const activeTab = computed(() => route.path.startsWith('/p/') ? 'personal' : 'teacher')
const activeNav = computed(() => NAV.find(t => t.key === activeTab.value))
const searchText = ref('')
const searchResults = ref([])
const searchOpen = ref(false)
const searching = ref(false)
const accessInfo = ref(null)
const accessQr = ref('')
const accessOpen = ref(false)
const accessCopied = ref(false)
const accessExpiresAt = ref('')
const pairedDevices = ref([])
const accessLoading = ref(false)
const accessError = ref('')
const accessBlocked = ref(false)
const updateOpen = ref(false)
const runtime = ref(null)
const contextVersion = ref(0)
const agentOpen = ref(false)
const agentInput = ref('')
const agentMessages = ref([])
const agentSending = ref(false)
const agentError = ref('')
const agentPlanIndex = ref(-1)
const agentBody = ref(null)
const agentInputEl = ref(null)
const agentFabEl = ref(null)
const accessDialogEl = ref(null)
const accessCloseEl = ref(null)
const accessTriggerEl = ref(null)
let accessPreviousActiveEl = null
const agentSuggestions = [
  '我们班有多少名学生？',
  '查询张三的基本信息',
  '最近有哪些学生需要跟进？',
]

function getWebAgentSessionId() {
  const storageKey = 'meimei_agent_web_session_id'
  try {
    const existing = window.localStorage.getItem(storageKey)
    if (existing) return existing
    const sessionId = `web:${window.crypto?.randomUUID?.() || Date.now()}`
    window.localStorage.setItem(storageKey, sessionId)
    return sessionId
  } catch {
    return 'web:default'
  }
}

const agentSessionId = ref(getWebAgentSessionId())

function itemTo(item) {
  return activeTab.value === 'teacher' ? '/' + item.page : '/p/' + item.page
}
function isActive(item) {
  const base = activeTab.value === 'teacher' ? '/' : '/p/'
  return route.path === base + item.page
}
function tabTo(tab) {
  return tab.key === 'teacher' ? '/dashboard' : '/p/health'
}

function handleContextChange() {
  contextVersion.value += 1
}

async function runSearch() {
  if (!searchText.value.trim()) return
  searching.value = true
  searchOpen.value = true
  try {
    const data = await get(`/api/search?q=${encodeURIComponent(searchText.value.trim())}`)
    searchResults.value = data.results || []
  } finally {
    searching.value = false
  }
}

function openResult(result) {
  searchOpen.value = false
  router.push(result.path)
}

function renderIcon(name) {
  const comp = getIcon(name)
  if (!comp) return null
  return h(comp, { size: 18, 'stroke-width': 2 })
}

async function loadAccessInfo() {
  try {
    const info = await get('/api/system/access-info')
    accessInfo.value = info
    accessBlocked.value = false
    accessError.value = ''
  } catch (error) {
    if (error.status === 401 || new URLSearchParams(window.location.search).has('pair')) {
      accessBlocked.value = true
      accessError.value = error.message || '此设备的访问授权无效，请在电脑端重新配对。'
    }
  }
}

async function loadRuntime() {
  try { runtime.value = await get('/api/system/runtime') } catch { runtime.value = null }
}

async function openAccessDialog() {
  accessPreviousActiveEl = document.activeElement
  accessOpen.value = true
  await refreshPairing()
  await nextTick()
  accessCloseEl.value?.focus()
}

function closeAccessDialog() {
  accessOpen.value = false
  nextTick(() => {
    if (accessPreviousActiveEl && typeof accessPreviousActiveEl.focus === 'function') accessPreviousActiveEl.focus()
    else accessTriggerEl.value?.focus()
    accessPreviousActiveEl = null
  })
}

function handleAccessDialogKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeAccessDialog()
    return
  }
  if (event.key !== 'Tab' || !accessDialogEl.value) return
  const focusable = [...accessDialogEl.value.querySelectorAll(
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

async function refreshPairing() {
  if (!accessInfo.value?.can_manage || accessLoading.value) return
  accessLoading.value = true
  accessError.value = ''
  try {
    const [pairing, deviceData] = await Promise.all([
      post('/api/system/pairing/start', {}),
      get('/api/system/devices'),
    ])
    accessInfo.value = { ...accessInfo.value, url: pairing.url }
    accessExpiresAt.value = pairing.expires_at
    pairedDevices.value = deviceData.devices || []
    accessQr.value = await QRCode.toDataURL(pairing.url, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#1d1d1f', light: '#ffffff' },
    })
  } catch (error) {
    accessError.value = error.message
  } finally {
    accessLoading.value = false
  }
}

async function revokeAccessDevice(device) {
  if (!confirm(`撤销“${device.name}”的访问权限吗？`)) return
  await del(`/api/system/devices/${device.id}`)
  pairedDevices.value = (await get('/api/system/devices')).devices || []
}

async function revokeAllAccessDevices() {
  if (!confirm('撤销全部移动设备的访问权限吗？本机仍可正常使用。')) return
  await post('/api/system/devices/revoke-all', {})
  pairedDevices.value = (await get('/api/system/devices')).devices || []
}

async function logoutAccessDevice() {
  if (!confirm('退出这台设备吗？退出后需要在电脑端重新扫码配对。')) return
  try {
    await post('/api/system/devices/logout', {})
  } finally {
    clearDeviceCredential()
    accessInfo.value = null
    accessBlocked.value = true
    accessError.value = '这台设备已退出，请在电脑端重新生成二维码后扫码配对。'
  }
}

async function copyAccessUrl() {
  if (!accessInfo.value?.url) return
  await navigator.clipboard?.writeText(accessInfo.value.url)
  accessCopied.value = true
  window.setTimeout(() => { accessCopied.value = false }, 1800)
}

function appendAgentMessage(role, content) {
  agentMessages.value.push({ role, content })
  scrollAgentToBottom()
}

function planStatusText(status) {
  return ({ pending: '等待执行', running: '执行中', completed: '已完成', skipped: '已跳过', error: '失败' })[status] || status
}

function handleAgentPlanEvent(event) {
  if (event.type === 'plan') {
    const plan = {
      role: 'plan',
      goal: event.goal || '整理查询步骤',
      steps: (event.steps || []).map(step => ({ ...step })),
    }
    if (agentPlanIndex.value < 0 || event.status === 'replanned') {
      agentMessages.value.push(plan)
      agentPlanIndex.value = agentMessages.value.length - 1
    } else {
      agentMessages.value[agentPlanIndex.value] = plan
    }
  } else if (event.type === 'plan_step' && agentPlanIndex.value >= 0) {
    const plan = agentMessages.value[agentPlanIndex.value]
    const step = plan?.steps?.find(item => item.id === event.id)
    if (step) {
      step.status = event.status
      if (event.message) step.message = event.message
    }
  }
  scrollAgentToBottom()
}

function scrollAgentToBottom() {
  nextTick(() => {
    if (agentBody.value) agentBody.value.scrollTop = agentBody.value.scrollHeight
  })
}

function useAgentSuggestion(message) {
  agentInput.value = message
  nextTick(() => agentInputEl.value?.focus())
}

function openAgentChat() {
  agentOpen.value = true
  nextTick(() => agentInputEl.value?.focus())
}

function closeAgentChat() {
  agentOpen.value = false
  nextTick(() => agentFabEl.value?.focus())
}

function handleAgentDialogKeydown(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  closeAgentChat()
}

async function sendAgentMessage() {
  const message = agentInput.value.trim()
  if (!message || agentSending.value) return
  appendAgentMessage('user', message)
  agentInput.value = ''
  agentError.value = ''
  agentPlanIndex.value = -1
  agentSending.value = true
  let assistantIndex = -1
  try {
    await streamPost('/api/agent/chat/stream', {
      session_id: agentSessionId.value,
      message,
      channel: 'web',
      actor_id: 'web-user',
    }, async (event) => {
      if (event.type === 'error') throw new Error(event.message || 'Agent 流式响应失败，请稍后重试。')
      if (event.type === 'plan' || event.type === 'plan_step') {
        handleAgentPlanEvent(event)
        return
      }
      if (event.type !== 'delta' || !event.content) return
      if (assistantIndex < 0) {
        agentMessages.value.push({ role: 'assistant', content: '' })
        assistantIndex = agentMessages.value.length - 1
      }
      agentMessages.value[assistantIndex].content += event.content
      scrollAgentToBottom()
    })
    if (assistantIndex < 0) appendAgentMessage('assistant', '凯凯小兵暂时没有返回内容。')
  } catch (error) {
    if (assistantIndex >= 0 && !agentMessages.value[assistantIndex].content) {
      agentMessages.value.splice(assistantIndex, 1)
    }
    agentError.value = error.message || '发送失败，请稍后重试。'
    scrollAgentToBottom()
  } finally {
    agentSending.value = false
  }
}

function handleAgentKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendAgentMessage()
  }
}

async function resetAgentSession() {
  if (agentSending.value) return
  try {
    await del(`/api/agent/sessions/${encodeURIComponent(agentSessionId.value)}`)
    agentMessages.value = []
    agentPlanIndex.value = -1
    agentError.value = ''
    scrollAgentToBottom()
  } catch (error) {
    agentError.value = error.message || '新会话创建失败，请稍后重试。'
  }
}

async function loadAgentHistory() {
  try {
    const data = await get(`/api/agent/sessions/${encodeURIComponent(agentSessionId.value)}`)
    agentMessages.value = (data.messages || []).map(item => ({ role: item.role, content: item.content }))
    scrollAgentToBottom()
  } catch (error) {
    agentError.value = error.message || '历史会话加载失败。'
  }
}

async function switchAgentSession(event) {
  const sessionId = String(event.detail?.sessionId || '')
  if (!sessionId.startsWith('web:') || sessionId === agentSessionId.value || agentSending.value) return
  window.localStorage.setItem('meimei_agent_web_session_id', sessionId)
  agentSessionId.value = sessionId
  agentMessages.value = []
  agentPlanIndex.value = -1
  agentError.value = ''
  await loadAgentHistory()
}

onMounted(async () => {
  window.addEventListener('meimei-agent-session-change', switchAgentSession)
  window.addEventListener('workbench-context-change', handleContextChange)
  await loadRuntime()
  await loadAccessInfo()
  await loadAgentHistory()
})

onBeforeUnmount(() => {
  window.removeEventListener('meimei-agent-session-change', switchAgentSession)
  window.removeEventListener('workbench-context-change', handleContextChange)
})
</script>

<template>
  <div class="app">
    <header class="top-tabs">
      <router-link v-for="tab in NAV" :key="tab.key"
        :to="tabTo(tab)" class="top-tab" :class="{ active: tab.key === activeTab }">
        <component :is="renderIcon(tab.icon)" class="tab-icon" />
        <span>{{ tab.title }}</span>
      </router-link>
      <ContextSwitcher v-if="activeTab === 'teacher'" />
      <span v-if="runtime?.business_date_overridden" class="runtime-date-badge">开发日期 {{ runtime.business_date }}</span>
      <div class="global-search">
        <input v-model="searchText" type="search" enterkeyhint="search" placeholder="搜索学生、事件、成绩…" @keyup.enter="runSearch" @focus="searchOpen = !!searchResults.length" />
        <button v-if="searchText" class="search-clear" aria-label="清除搜索" @click="searchText = ''; searchResults = []; searchOpen = false">×</button>
        <div v-if="searchOpen" class="search-popover">
          <div v-if="searching" class="search-empty">搜索中…</div>
          <div v-else-if="!searchResults.length" class="search-empty">没有找到匹配记录</div>
          <button v-for="result in searchResults" v-else :key="`${result.kind}-${result.id}`" class="search-result" @click="openResult(result)">
            <span class="search-kind">{{ result.kind }}</span>
            <span><strong>{{ result.title }}</strong><small>{{ result.summary }}</small></span>
          </button>
        </div>
      </div>
      <button v-if="accessInfo?.enabled && accessInfo?.can_manage" ref="accessTriggerEl" class="access-button" type="button" aria-label="显示手机访问二维码" @click="openAccessDialog">
        <component :is="renderIcon('Wifi')" :size="16" />
        <span>手机访问</span>
      </button>
      <button v-else-if="accessInfo?.enabled" class="device-logout-button" type="button" aria-label="退出当前授权设备" @click="logoutAccessDevice">
        <component :is="renderIcon('LogOut')" :size="16" />
        <span>退出设备</span>
      </button>
      <button class="ai-settings-button" type="button" aria-label="打开 AI 设置" @click="router.push('/agent')">
        <Settings :size="16" />
        <span>AI 设置</span>
      </button>
      <button class="update-button" type="button" aria-label="检查软件更新" @click="updateOpen = true">
        <component :is="renderIcon('Download')" :size="16" />
        <span>更新</span>
      </button>
    </header>
    <UpdateDialog :open="updateOpen" @close="updateOpen = false" />
    <div v-if="accessBlocked" class="access-scrim access-blocked-scrim">
      <section class="access-blocked-card" role="alertdialog" aria-modal="true" aria-labelledby="access-blocked-title">
        <div class="access-blocked-icon"><component :is="renderIcon('ShieldAlert')" :size="24" /></div>
        <div id="access-blocked-title" class="access-title">需要重新配对</div>
        <p>{{ accessError }}</p>
        <div class="access-warning">请回到运行工作台的电脑，点击右上角“手机访问”，再用这台设备扫描新二维码。</div>
        <button class="btn btn-primary" type="button" @click="loadAccessInfo">重新检查</button>
      </section>
    </div>
    <div v-if="accessOpen" class="access-scrim" @click.self="closeAccessDialog">
      <section ref="accessDialogEl" class="access-dialog" role="dialog" aria-modal="true" aria-labelledby="access-title" tabindex="-1" @keydown="handleAccessDialogKeydown">
        <div class="access-dialog-head">
          <div>
            <div id="access-title" class="access-title">手机 / 平板访问</div>
            <div class="access-subtitle">连接同一 Wi-Fi 后，用相机扫描短时配对二维码</div>
          </div>
          <button ref="accessCloseEl" class="icon-button" type="button" aria-label="关闭二维码" @click="closeAccessDialog">
            <component :is="renderIcon('X')" :size="18" />
          </button>
        </div>
        <div class="access-qr-frame">
          <img v-if="accessQr" :src="accessQr" alt="局域网访问二维码" class="access-qr" />
          <div v-else class="access-qr-loading">{{ accessLoading ? '正在生成配对二维码…' : '暂时无法生成二维码' }}</div>
        </div>
        <div class="access-url-label">单次配对地址 · {{ accessExpiresAt ? `${accessExpiresAt} 失效` : '5 分钟有效' }}</div>
        <div class="access-url">{{ accessInfo?.url }}</div>
        <button class="btn btn-outline access-copy" type="button" @click="copyAccessUrl">
          <component :is="renderIcon(accessCopied ? 'Check' : 'Copy')" :size="15" />
          {{ accessCopied ? '已复制地址' : '复制访问地址' }}
        </button>
        <button class="btn btn-outline access-copy" type="button" :disabled="accessLoading" @click="refreshPairing">
          <RefreshCw :size="15" /> 重新生成二维码
        </button>
        <div v-if="accessError" class="access-error">{{ accessError }}</div>
        <div class="access-warning">二维码仅可使用一次并在 5 分钟后失效。配对后的设备可在下方随时撤权。</div>
        <div class="access-device-head"><strong>已授权设备</strong><button v-if="pairedDevices.some(item => item.status === '已授权')" type="button" @click="revokeAllAccessDevices">全部撤权</button></div>
        <div class="access-devices">
          <div v-if="!pairedDevices.length" class="access-device-empty">还没有已配对设备</div>
          <div v-for="device in pairedDevices" :key="device.id" class="access-device-row">
            <div><strong>{{ device.name }}</strong><span>{{ device.status }} · 最近访问 {{ device.last_seen_at || '暂无' }}</span></div>
            <button v-if="device.status === '已授权'" type="button" @click="revokeAccessDevice(device)">撤权</button>
          </div>
        </div>
      </section>
    </div>
    <div class="agent-float" :class="{ 'is-open': agentOpen }">
      <button v-if="!agentOpen" ref="agentFabEl" class="agent-fab" type="button" aria-label="打开凯凯小兵对话" @click="openAgentChat">
        <MessageCircle :size="19" :stroke-width="2.2" />
        <span>凯凯小兵</span>
      </button>
      <section v-else class="agent-chat-panel" role="dialog" aria-modal="false" aria-labelledby="agent-chat-title" @keydown="handleAgentDialogKeydown">
        <header class="agent-chat-head">
          <div class="agent-chat-identity">
            <div>
              <div id="agent-chat-title" class="agent-chat-title">凯凯小兵</div>
              <div class="agent-chat-subtitle"><span class="agent-status-dot"></span>美美工作台 Agent 助手</div>
            </div>
          </div>
          <div class="agent-chat-actions">
            <button class="agent-icon-button" type="button" aria-label="开启新会话" title="新会话" @click="resetAgentSession">
              <RefreshCw :size="16" />
            </button>
            <button class="agent-icon-button" type="button" aria-label="收起凯凯小兵" title="收起" @click="closeAgentChat">
              <component :is="renderIcon('X')" :size="17" />
            </button>
          </div>
        </header>
        <div ref="agentBody" class="agent-chat-body" aria-live="polite">
          <div v-if="!agentMessages.length" class="agent-chat-welcome">
            <div class="agent-welcome-title">你好，我是凯凯小兵</div>
            <span>我可以帮你查询和整理工作台里的学生数据。</span>
            <div class="agent-suggestion-list">
              <button v-for="suggestion in agentSuggestions" :key="suggestion" type="button" class="agent-suggestion" @click="useAgentSuggestion(suggestion)">
                {{ suggestion }}
                <component :is="renderIcon('ChevronRight')" :size="14" />
              </button>
            </div>
          </div>
          <div v-for="(message, index) in agentMessages" :key="`${message.role}-${index}`" class="agent-message" :class="message.role">
            <details v-if="message.role === 'plan'" class="agent-plan-card" open>
              <summary><span class="agent-plan-mark">✦</span><span class="agent-plan-title">执行规划</span><span class="agent-plan-goal">{{ message.goal }}</span></summary>
              <div class="agent-plan-steps">
                <div v-for="step in message.steps" :key="step.id" class="agent-plan-step" :class="step.status">
                  <span class="agent-plan-step-dot"></span>
                  <span class="agent-plan-step-label">{{ step.label }}</span>
                  <span class="agent-plan-step-status">{{ planStatusText(step.status) }}</span>
                </div>
              </div>
            </details>
            <div v-else-if="message.role === 'assistant'" class="agent-message-bubble agent-markdown" v-html="renderAgentMarkdown(message.content)"></div>
            <div v-else class="agent-message-bubble">{{ message.content }}</div>
          </div>
          <div v-if="agentSending" class="agent-message assistant">
            <div class="agent-message-bubble agent-thinking"><span></span><span></span><span></span></div>
          </div>
          <div v-if="agentError" class="agent-chat-error">{{ agentError }}</div>
        </div>
        <footer class="agent-chat-foot">
          <div class="agent-composer">
            <textarea ref="agentInputEl" v-model="agentInput" rows="2" maxlength="2000" placeholder="给凯凯小兵发送消息…" :disabled="agentSending" @keydown="handleAgentKeydown"></textarea>
            <div class="agent-composer-bottom">
              <div class="agent-composer-meta"><span class="agent-status-dot"></span>工作台数据已连接</div>
              <button class="agent-send-button" type="button" aria-label="发送消息" :disabled="!agentInput.trim() || agentSending" @click="sendAgentMessage">
                <Send :size="16" :stroke-width="2.2" />
              </button>
            </div>
          </div>
          <div class="agent-chat-hint">Enter 发送 · Shift + Enter 换行</div>
        </footer>
      </section>
    </div>
    <div class="app-body">
      <aside class="sidebar">
        <div class="sidebar-header">
          <img class="brand-logo" src="/logo.svg" alt="" aria-hidden="true" />
          <h2>{{ activeNav.title }}</h2>
          <div class="sub">{{ activeNav.school }}</div>
        </div>
        <nav class="sidebar-nav" aria-label="功能导航">
          <div v-for="group in activeNav.groups" :key="group.title" class="nav-group">
            <div class="nav-group-title">{{ group.title }}</div>
            <router-link v-for="item in group.items" :key="item.page"
              :to="itemTo(item)" class="nav-item" :class="{ active: isActive(item) }">
              <component :is="renderIcon(item.icon)" class="nav-item-icon" :size="16" :stroke-width="2" />
              <span>{{ item.label }}</span>
            </router-link>
          </div>
        </nav>
        <div class="sidebar-footer">
          <span>凯凯小兵 为你值守</span>
        </div>
      </aside>
      <main class="main">
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
          <component :is="Component" :key="`${route.fullPath}:${contextVersion}`" />
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<style>
.page-enter-active {
  transition: opacity 150ms cubic-bezier(0.25, 0.1, 0.25, 1),
              transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

.page-leave-active {
  transition: opacity 100ms cubic-bezier(0.25, 0.1, 0.25, 1);
  position: absolute;
  width: 100%;
}

.page-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.page-leave-to {
  opacity: 0;
}

.runtime-date-badge { align-self: center; padding: 4px 8px; border: 1px solid rgba(91,106,191,.2); border-radius: 999px; background: var(--primary-bg); color: var(--primary); font-size: 10px; white-space: nowrap; }
.global-search { position: relative; align-self: center; min-width: 0; margin-left: auto; width: min(300px, 32vw); }
.global-search input { width: 100%; height: 34px; box-sizing: border-box; border: 1px solid var(--border); border-radius: 999px; background: rgba(255,255,255,.72); padding: 0 32px 0 14px; color: var(--text); outline: none; transition: border-color .2s, box-shadow .2s; }
.global-search input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(91,106,191,.12); }
.search-clear { position: absolute; right: 10px; top: 6px; border: 0; background: transparent; color: var(--text-secondary); font-size: 18px; cursor: pointer; }
.search-popover { position: absolute; z-index: 20; top: calc(100% + 8px); left: 0; right: 0; max-height: 360px; overflow: auto; padding: 7px; background: rgba(255,255,255,.96); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 14px 36px rgba(25,35,65,.14); }
.search-result { width: 100%; display: flex; gap: 9px; align-items: flex-start; padding: 10px; border: 0; border-radius: 10px; background: transparent; text-align: left; cursor: pointer; color: var(--text); }
.search-result:hover { background: var(--bg); }
.search-result span:last-child { min-width: 0; display: grid; gap: 3px; }
.search-result small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.search-kind { flex: 0 0 auto; padding: 3px 6px; border-radius: 6px; background: var(--primary-bg); color: var(--primary); font-size: 11px; }
.search-empty { padding: 18px 10px; text-align: center; color: var(--text-secondary); font-size: 13px; }

.access-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  margin: 7px 0 7px 10px;
  padding: 0 12px;
  border: 1px solid rgba(52,199,89,.24);
  border-radius: 999px;
  background: var(--success-bg);
  color: #248a3d;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: transform var(--transition-fast), background var(--transition-fast);
  touch-action: manipulation;
}
.access-button:active { transform: scale(.97); }
.device-logout-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  margin: 7px 0 7px 10px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255,255,255,.68);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.device-logout-button:active { transform: scale(.97); }
.ai-settings-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  margin: 7px 0 7px 8px;
  padding: 0 10px;
  border: 1px solid rgba(91,106,191,.2);
  border-radius: 999px;
  background: var(--primary-bg);
  color: var(--primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: transform var(--transition-fast), background var(--transition-fast);
  touch-action: manipulation;
}
.ai-settings-button:hover { background: rgba(91,106,191,.14); }
.ai-settings-button:active { transform: scale(.97); }
.update-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  margin: 7px 0 7px 8px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255,255,255,.68);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: transform var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
  touch-action: manipulation;
}
.update-button:hover { color: var(--primary); background: var(--primary-bg); }
.update-button:active { transform: scale(.97); }

.access-scrim {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(20, 24, 38, .28);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.access-dialog {
  width: min(360px, 100%);
  padding: 22px;
  border: 1px solid rgba(255,255,255,.72);
  border-radius: 24px;
  background: rgba(255,255,255,.94);
  box-shadow: 0 24px 70px rgba(21, 28, 58, .22);
  animation: access-dialog-in 250ms cubic-bezier(.16, 1, .3, 1);
}
.access-blocked-scrim { z-index: 900; }
.access-blocked-card {
  display: grid;
  justify-items: center;
  width: min(340px, 100%);
  box-sizing: border-box;
  padding: 28px 24px 24px;
  border: 1px solid rgba(255,255,255,.72);
  border-radius: 24px;
  background: rgba(255,255,255,.97);
  box-shadow: 0 24px 70px rgba(21,28,58,.22);
  text-align: center;
}
.access-blocked-icon { display: grid; place-items: center; width: 48px; height: 48px; margin-bottom: 14px; border-radius: 15px; background: var(--primary-bg); color: var(--primary); }
.access-blocked-card p { margin: 8px 0 0; color: var(--text-secondary); font-size: 13px; line-height: 1.55; }
.access-blocked-card .btn { margin-top: 18px; }
.access-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.access-title { font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
.access-subtitle { margin-top: 4px; color: var(--text-secondary); font-size: 12px; }
.icon-button { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 50%; background: var(--bg); color: var(--text-secondary); cursor: pointer; touch-action: manipulation; }
.icon-button:active { transform: scale(.94); }
.access-qr-frame { display: grid; place-items: center; min-height: 244px; margin: 20px auto 16px; padding: 10px; border-radius: 18px; background: #fff; box-shadow: inset 0 0 0 1px rgba(0,0,0,.06); }
.access-qr { display: block; width: 240px; height: 240px; image-rendering: pixelated; }
.access-qr-loading { color: var(--text-secondary); font-size: 13px; }
.access-url-label { margin-bottom: 5px; color: var(--text-secondary); font-size: 11px; }
.access-url { padding: 10px 12px; border-radius: 10px; background: var(--bg); color: var(--text); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; user-select: text; }
.access-copy { width: 100%; justify-content: center; margin-top: 12px; }
.access-warning { margin-top: 12px; color: var(--text-tertiary); font-size: 11px; line-height: 1.5; text-align: center; }
.access-error { margin-top: 10px; color: var(--danger); font-size: 12px; text-align: center; }
.access-device-head { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); font-size: 12px; }
.access-device-head button, .access-device-row > button { border: 0; background: transparent; color: var(--danger); font: inherit; font-size: 11px; cursor: pointer; }
.access-devices { max-height: 150px; overflow-y: auto; }
.access-device-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border); text-align: left; }
.access-device-row > div { min-width: 0; display: grid; gap: 2px; }
.access-device-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.access-device-row span, .access-device-empty { color: var(--text-secondary); font-size: 10px; }
.access-device-empty { padding: 12px 0 2px; text-align: center; }
@keyframes access-dialog-in { from { opacity: 0; transform: scale(.96) translateY(6px); } to { opacity: 1; transform: none; } }

.agent-float { position: fixed; right: 20px; bottom: 20px; z-index: 400; }
.agent-fab { display: inline-flex; align-items: center; gap: 8px; height: 46px; padding: 0 17px; border: 1px solid rgba(255,255,255,.7); border-radius: 999px; background: var(--primary); color: #fff; box-shadow: 0 12px 28px rgba(72, 88, 170, .28); font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; transition: transform var(--transition-fast), box-shadow var(--transition-fast); touch-action: manipulation; }
.agent-fab:hover { transform: translateY(-2px); box-shadow: 0 16px 32px rgba(72, 88, 170, .34); }
.agent-fab:active { transform: scale(.97); }
.agent-chat-panel { display: flex; flex-direction: column; width: min(420px, calc(100vw - 32px)); height: min(640px, calc(100vh - 40px)); overflow: hidden; border: 1px solid rgba(255,255,255,.78); border-radius: 22px; background: rgba(255,255,255,.97); box-shadow: 0 24px 70px rgba(33, 43, 86, .24); animation: agent-panel-in 220ms cubic-bezier(.16, 1, .3, 1); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
.agent-chat-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 16px; border-bottom: 1px solid var(--border); background: linear-gradient(135deg, rgba(91,106,191,.11), rgba(255,255,255,.66)); }
.agent-chat-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
.agent-chat-title { color: var(--text); font-size: 14px; font-weight: 700; }
.agent-chat-subtitle { display: flex; align-items: center; gap: 5px; margin-top: 3px; color: var(--text-secondary); font-size: 11px; }
.agent-status-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #43b866; box-shadow: 0 0 0 3px rgba(67,184,102,.12); }
.agent-chat-actions { display: flex; gap: 4px; }
.agent-icon-button { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 9px; background: transparent; color: var(--text-secondary); cursor: pointer; touch-action: manipulation; }
.agent-icon-button:hover { background: var(--primary-bg); color: var(--primary); }
.agent-icon-button:active { transform: scale(.94); }
.agent-chat-body { flex: 1; min-height: 0; overflow-y: auto; padding: 24px 20px; background: linear-gradient(180deg, rgba(248,249,253,.76), rgba(255,255,255,.9)); scroll-behavior: smooth; }
.agent-chat-welcome { display: grid; justify-items: center; gap: 8px; margin: 58px 8px 30px; color: var(--text-secondary); text-align: center; font-size: 12px; line-height: 1.5; }
.agent-chat-welcome span { max-width: 260px; }
.agent-welcome-title { color: var(--text); font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
.agent-suggestion-list { display: grid; width: min(300px, 100%); gap: 7px; margin-top: 13px; }
.agent-suggestion { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; padding: 9px 11px; border: 1px solid var(--border); border-radius: 11px; background: rgba(255,255,255,.78); color: var(--text-secondary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; transition: border-color var(--transition-fast), background var(--transition-fast), color var(--transition-fast), transform var(--transition-fast); }
.agent-suggestion:hover { border-color: rgba(91,106,191,.36); background: var(--primary-bg); color: var(--primary); }
.agent-suggestion:active { transform: scale(.98); }
.agent-message { display: flex; align-items: flex-end; gap: 7px; margin: 9px 0; }
.agent-message.user { justify-content: flex-end; }
.agent-message.plan { display: block; margin: 7px 0 10px; }
.agent-message-bubble { max-width: min(86%, 320px); padding: 8px 0; border-radius: 15px; background: transparent; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.62; }
.agent-message.user .agent-message-bubble { max-width: min(78%, 290px); padding: 10px 12px; border-radius: 15px 15px 5px 15px; background: var(--primary-bg); color: var(--text); box-shadow: 0 2px 8px rgba(40, 48, 85, .06); }
.agent-markdown { line-height: 1.52; }
.agent-markdown p { margin: .28em 0; }
.agent-markdown p:last-child { margin-bottom: 0; }
.agent-markdown h1, .agent-markdown h2, .agent-markdown h3 { margin: 9px 0 4px; color: var(--text); line-height: 1.3; }
.agent-markdown h1:first-child, .agent-markdown h2:first-child, .agent-markdown h3:first-child { margin-top: 0; }
.agent-markdown h1 { font-size: 17px; }
.agent-markdown h2 { font-size: 15px; }
.agent-markdown h3 { font-size: 14px; }
.agent-markdown ul, .agent-markdown ol { margin: .25em 0 .45em; padding-left: 19px; }
.agent-markdown li { margin: 0; }
.agent-markdown li > p { margin: .12em 0; }
.agent-markdown strong { color: var(--text); font-weight: 700; }
.agent-markdown code { padding: 2px 5px; border-radius: 5px; background: rgba(91,106,191,.1); color: var(--primary); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
.agent-markdown pre { margin: 9px 0; padding: 11px 12px; overflow-x: auto; border: 1px solid rgba(91,106,191,.12); border-radius: 10px; background: #f5f6fb; }
.agent-markdown pre code { padding: 0; background: transparent; color: var(--text); font-size: 11px; white-space: pre; }
.agent-markdown blockquote { margin: 9px 0; padding: 2px 0 2px 11px; border-left: 3px solid rgba(91,106,191,.4); color: var(--text-secondary); }
.agent-markdown a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
.agent-markdown hr { margin: 12px 0; border: 0; border-top: 1px solid var(--border); }
.agent-markdown table { display: block; max-width: 100%; margin: 9px 0; overflow-x: auto; border-collapse: collapse; font-size: 12px; }
.agent-markdown th, .agent-markdown td { padding: 6px 8px; border: 1px solid var(--border); text-align: left; white-space: nowrap; }
.agent-markdown th { background: var(--primary-bg); color: var(--text); font-weight: 650; }
.agent-plan-card { max-width: min(92%, 350px); padding: 9px 11px; border: 1px solid rgba(91,106,191,.14); border-radius: 12px; background: rgba(248,249,253,.9); color: var(--text-secondary); box-shadow: 0 2px 8px rgba(40,48,85,.04); }
.agent-plan-card summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; font-size: 11px; }
.agent-plan-card summary::-webkit-details-marker { display: none; }
.agent-plan-mark { color: var(--primary); font-size: 13px; }
.agent-plan-title { color: var(--text); font-weight: 700; }
.agent-plan-goal { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-plan-steps { display: grid; gap: 5px; margin-top: 8px; padding-left: 2px; }
.agent-plan-step { display: grid; grid-template-columns: 7px minmax(0,1fr) auto; align-items: center; gap: 7px; font-size: 11px; }
.agent-plan-step-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-tertiary); }
.agent-plan-step.running .agent-plan-step-dot { background: var(--primary); box-shadow: 0 0 0 3px rgba(91,106,191,.12); }
.agent-plan-step.completed .agent-plan-step-dot { background: var(--success); }
.agent-plan-step.error .agent-plan-step-dot { background: var(--danger, #c83b32); }
.agent-plan-step-label { color: var(--text); }
.agent-plan-step-status { color: var(--text-tertiary); font-size: 10px; }
.agent-plan-step.completed .agent-plan-step-status { color: var(--success); }
.agent-plan-step.error .agent-plan-step-status { color: var(--danger, #c83b32); }
.agent-thinking { display: inline-flex; align-items: center; gap: 4px; padding: 12px 14px; }
.agent-thinking span { width: 5px; height: 5px; border-radius: 50%; background: var(--text-tertiary); animation: agent-thinking-bounce 1s infinite ease-in-out; }
.agent-thinking span:nth-child(2) { animation-delay: .12s; }
.agent-thinking span:nth-child(3) { animation-delay: .24s; }
.agent-chat-error { margin: 12px 2px 0; padding: 8px 10px; border-radius: 9px; background: var(--danger-bg, #fff1f0); color: var(--danger, #c83b32); font-size: 11px; line-height: 1.45; }
.agent-chat-foot { padding: 10px 14px 13px; border-top: 1px solid var(--border); background: rgba(255,255,255,.9); }
.agent-composer { padding: 7px 9px 8px 12px; border: 1px solid rgba(126,137,194,.35); border-radius: 16px; background: #fff; box-shadow: 0 3px 12px rgba(40, 48, 85, .06); }
.agent-chat-foot textarea { display: block; width: 100%; box-sizing: border-box; min-height: 48px; resize: none; padding: 3px 2px 8px; border: 0; outline: none; background: transparent; color: var(--text); font: inherit; font-size: 13px; line-height: 1.5; }
.agent-chat-foot textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(91,106,191,.12); }
.agent-chat-foot textarea:disabled { opacity: .7; }
.agent-chat-foot textarea:focus { box-shadow: none; }
.agent-composer-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.agent-composer-meta { display: flex; align-items: center; gap: 7px; color: var(--text-tertiary); font-size: 10px; }
.agent-send-button { display: grid; place-items: center; flex: 0 0 auto; width: 32px; height: 32px; border: 0; border-radius: 10px; background: var(--primary); color: #fff; cursor: pointer; transition: transform var(--transition-fast), opacity var(--transition-fast); touch-action: manipulation; }
.agent-send-button:disabled { opacity: .38; cursor: default; }
.agent-send-button:not(:disabled):active { transform: scale(.93); }
.agent-chat-hint { margin: 7px 2px 0; color: var(--text-tertiary); font-size: 10px; }
@keyframes agent-panel-in { from { opacity: 0; transform: translateY(10px) scale(.97); } to { opacity: 1; transform: none; } }
@keyframes agent-thinking-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .45; } 30% { transform: translateY(-3px); opacity: 1; } }

@media (min-width: 641px) and (max-width: 1100px) {
  .global-search { order: 3; flex: 1 0 100%; width: 100%; margin: 4px 0 2px; }
  .global-search input { min-height: 40px; }
}

@media (max-width: 760px) {
  .global-search input { font-size: 12px; }
}

@media (max-width: 640px) {
  .top-tabs { height: auto; min-height: 52px; flex-wrap: wrap; gap: 2px; }
  .global-search { order: 3; flex: 1 0 100%; width: 100%; margin: 4px 0 2px; }
  .global-search input { height: 40px; min-height: 40px; padding-top: 8px; padding-bottom: 8px; font-size: 14px; }
  .search-popover { position: fixed; top: 96px; left: 10px; right: 10px; max-height: min(360px, 52vh); }
  .access-button { margin-left: auto; padding: 0 10px; }
  .access-button span { display: none; }
  .device-logout-button { margin-left: auto; padding: 0 10px; }
  .device-logout-button span { display: none; }
  .update-button { margin-left: 6px; padding: 0 10px; }
  .update-button span { display: none; }
  .ai-settings-button { margin-left: 6px; padding: 0 10px; }
  .ai-settings-button span { display: none; }
  .access-scrim { align-items: end; padding: 0; }
  .access-dialog { width: 100%; border-radius: 24px 24px 0 0; padding: 20px 18px calc(20px + env(safe-area-inset-bottom)); }
  .agent-float { right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); }
  .agent-float.is-open { right: 0; bottom: 0; width: 100%; }
  .agent-chat-panel { width: 100%; height: min(680px, calc(100vh - 12px)); border-radius: 20px 20px 0 0; }
  .agent-chat-foot { padding-bottom: calc(13px + env(safe-area-inset-bottom)); }
}

@media (prefers-reduced-motion: reduce) {
  .page-enter-active,
  .page-leave-active {
    transition: none !important;
  }
  .access-dialog { animation: none; }
  .agent-chat-panel, .agent-thinking span { animation: none; }
}

@media (prefers-reduced-transparency: reduce) {
  .access-scrim { background: rgba(20, 24, 38, .42); backdrop-filter: none; -webkit-backdrop-filter: none; }
  .access-dialog { background: #fff; }
  .agent-chat-panel, .agent-chat-head, .agent-chat-foot { background: #fff; backdrop-filter: none; -webkit-backdrop-filter: none; }
}
</style>
