<script setup>
import { computed, h, nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MessageCircle, RefreshCw, Send } from 'lucide-vue-next'
import QRCode from 'qrcode'
import { NAV } from './sheets'
import { getIcon } from './icons'
import { del, get, post } from './api'
import { renderAgentMarkdown } from './markdown'
import UpdateDialog from './components/UpdateDialog.vue'

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
const updateOpen = ref(false)
const agentOpen = ref(false)
const agentInput = ref('')
const agentMessages = ref([])
const agentSending = ref(false)
const agentError = ref('')
const agentBody = ref(null)
const agentInputEl = ref(null)
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

const agentSessionId = getWebAgentSessionId()

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
    if (info.enabled && info.url) {
      accessQr.value = await QRCode.toDataURL(info.url, {
        width: 240,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#1d1d1f', light: '#ffffff' },
      })
    }
  } catch {
    // 本机模式或旧版本服务没有访问信息时，不显示局域网入口。
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

function scrollAgentToBottom() {
  nextTick(() => {
    if (agentBody.value) agentBody.value.scrollTop = agentBody.value.scrollHeight
  })
}

function useAgentSuggestion(message) {
  agentInput.value = message
  nextTick(() => agentInputEl.value?.focus())
}

async function sendAgentMessage() {
  const message = agentInput.value.trim()
  if (!message || agentSending.value) return
  appendAgentMessage('user', message)
  agentInput.value = ''
  agentError.value = ''
  agentSending.value = true
  try {
    const result = await post('/api/agent/chat', {
      session_id: agentSessionId,
      message,
      channel: 'web',
      actor_id: 'web-user',
    })
    appendAgentMessage('assistant', result.answer || '凯凯小兵暂时没有返回内容。')
  } catch (error) {
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
    await del(`/api/agent/sessions/${encodeURIComponent(agentSessionId)}`)
    agentMessages.value = []
    agentError.value = ''
    scrollAgentToBottom()
  } catch (error) {
    agentError.value = error.message || '新会话创建失败，请稍后重试。'
  }
}

onMounted(loadAccessInfo)
</script>

<template>
  <div class="app">
    <header class="top-tabs">
      <router-link v-for="tab in NAV" :key="tab.key"
        :to="tabTo(tab)" class="top-tab" :class="{ active: tab.key === activeTab }">
        <component :is="renderIcon(tab.icon)" class="tab-icon" />
        <span>{{ tab.title }}</span>
      </router-link>
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
      <button v-if="accessInfo?.enabled" class="access-button" type="button" aria-label="显示手机访问二维码" @click="accessOpen = true">
        <component :is="renderIcon('Wifi')" :size="16" />
        <span>手机访问</span>
      </button>
      <button class="update-button" type="button" aria-label="检查软件更新" @click="updateOpen = true">
        <component :is="renderIcon('Download')" :size="16" />
        <span>更新</span>
      </button>
    </header>
    <UpdateDialog :open="updateOpen" @close="updateOpen = false" />
    <div v-if="accessOpen" class="access-scrim" @click.self="accessOpen = false">
      <section class="access-dialog" role="dialog" aria-modal="true" aria-labelledby="access-title">
        <div class="access-dialog-head">
          <div>
            <div id="access-title" class="access-title">手机 / 平板访问</div>
            <div class="access-subtitle">连接同一 Wi-Fi 后，用相机扫描二维码</div>
          </div>
          <button class="icon-button" type="button" aria-label="关闭二维码" @click="accessOpen = false">
            <component :is="renderIcon('X')" :size="18" />
          </button>
        </div>
        <div class="access-qr-frame">
          <img v-if="accessQr" :src="accessQr" alt="局域网访问二维码" class="access-qr" />
          <div v-else class="access-qr-loading">二维码生成中…</div>
        </div>
        <div class="access-url-label">访问地址</div>
        <div class="access-url">{{ accessInfo?.url }}</div>
        <button class="btn btn-outline access-copy" type="button" @click="copyAccessUrl">
          <component :is="renderIcon(accessCopied ? 'Check' : 'Copy')" :size="15" />
          {{ accessCopied ? '已复制地址' : '复制访问地址' }}
        </button>
        <div class="access-warning">二维码包含本次启动生成的访问密钥，请只分享给可信设备。</div>
      </section>
    </div>
    <div class="agent-float" :class="{ 'is-open': agentOpen }">
      <button v-if="!agentOpen" class="agent-fab" type="button" aria-label="打开凯凯小兵对话" @click="agentOpen = true">
        <MessageCircle :size="19" :stroke-width="2.2" />
        <span>凯凯小兵</span>
      </button>
      <section v-else class="agent-chat-panel" role="dialog" aria-modal="false" aria-labelledby="agent-chat-title">
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
            <button class="agent-icon-button" type="button" aria-label="收起凯凯小兵" title="收起" @click="agentOpen = false">
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
            <div v-if="message.role === 'assistant'" class="agent-message-bubble agent-markdown" v-html="renderAgentMarkdown(message.content)"></div>
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
            <component :is="Component" />
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

.global-search { position: relative; margin-left: auto; width: min(300px, 32vw); }
.global-search input { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 999px; background: rgba(255,255,255,.72); padding: 9px 32px 9px 14px; color: var(--text); outline: none; transition: border-color .2s, box-shadow .2s; }
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
.agent-message-bubble { max-width: min(86%, 320px); padding: 8px 0; border-radius: 15px; background: transparent; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.62; }
.agent-message.user .agent-message-bubble { max-width: min(78%, 290px); padding: 10px 12px; border-radius: 15px 15px 5px 15px; background: var(--primary-bg); color: var(--text); box-shadow: 0 2px 8px rgba(40, 48, 85, .06); }
.agent-markdown p { margin: 0 0 8px; }
.agent-markdown p:last-child { margin-bottom: 0; }
.agent-markdown h1, .agent-markdown h2, .agent-markdown h3 { margin: 12px 0 7px; color: var(--text); line-height: 1.35; }
.agent-markdown h1:first-child, .agent-markdown h2:first-child, .agent-markdown h3:first-child { margin-top: 0; }
.agent-markdown h1 { font-size: 17px; }
.agent-markdown h2 { font-size: 15px; }
.agent-markdown h3 { font-size: 14px; }
.agent-markdown ul, .agent-markdown ol { margin: 6px 0 9px; padding-left: 20px; }
.agent-markdown li { margin: 3px 0; }
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

@media (max-width: 760px) {
  .global-search { width: 42vw; }
  .global-search input { font-size: 12px; }
}

@media (max-width: 640px) {
  .top-tabs { height: auto; min-height: 52px; flex-wrap: wrap; gap: 2px; }
  .global-search { order: 3; flex: 1 0 100%; width: 100%; margin: 4px 0 2px; }
  .global-search input { min-height: 40px; padding-top: 8px; padding-bottom: 8px; font-size: 14px; }
  .search-popover { position: fixed; top: 96px; left: 10px; right: 10px; max-height: min(360px, 52vh); }
  .access-button { margin-left: auto; padding: 0 10px; }
  .access-button span { display: none; }
  .update-button { margin-left: 6px; padding: 0 10px; }
  .update-button span { display: none; }
  .access-scrim { align-items: end; padding: 0; }
  .access-dialog { width: 100%; border-radius: 24px 24px 0 0; padding: 20px 18px calc(20px + env(safe-area-inset-bottom)); }
  .agent-float { right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); }
  .agent-chat-panel { width: calc(100vw - 24px); height: min(600px, calc(100vh - 24px)); border-radius: 20px; }
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
}
</style>
