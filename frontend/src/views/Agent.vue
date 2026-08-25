<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, BarChart3, Brain, CheckCircle, CircleAlert, Copy, GripVertical, KeyRound, MessageCircle, Pencil, Play, Plus, QrCode, RefreshCw, ShieldCheck, Square, Trash2, UserPlus, X } from 'lucide-vue-next'
import QRCode from 'qrcode'
import { del, get, post, put } from '../api'
import { useConfirmDialog } from '../composables/confirmDialog'

const router = useRouter()
const { confirm: confirmDialog } = useConfirmDialog()
const profiles = ref([])
const activeProfileId = ref('')
const status = ref(null)
const loading = ref(true)
const profileBusy = ref(false)
const notice = ref('')
const error = ref('')
const wechat = ref(null)
const wechatConfig = reactive({ allow_all: false, allow_users: [], source: 'local' })
const newWechatUser = ref('')
const wechatLoading = ref(true)
const loginStarting = ref(false)
const loginPolling = ref(false)
const loopChanging = ref(false)
const policySaving = ref(false)
const wechatQr = ref('')
const wechatQrSource = ref('')
const agentSessions = ref([])
const agentUsage = ref(null)
const sessionsLoading = ref(false)
const sessionBusy = ref(false)
const currentWebSessionId = ref(getCurrentWebSessionId())
let loginTimer = null
let statusTimer = null

function getCurrentWebSessionId() {
  try { return window.localStorage.getItem('meimei_agent_web_session_id') || '' } catch { return '' }
}

function dispatchSessionChange(sessionId) {
  currentWebSessionId.value = sessionId
  window.localStorage.setItem('meimei_agent_web_session_id', sessionId)
  window.dispatchEvent(new CustomEvent('meimei-agent-session-change', { detail: { sessionId } }))
}

async function newWebSession() {
  sessionBusy.value = true
  try {
    const created = await post('/api/agent/sessions', {})
    dispatchSessionChange(String(created.session_id || ''))
    await loadAgentOperations()
  } catch (e) {
    error.value = e.message
  } finally {
    sessionBusy.value = false
  }
}

async function loadAgentOperations() {
  sessionsLoading.value = true
  try {
    const [sessions, usage] = await Promise.all([
      get('/api/agent/sessions?prefix=web%3A'),
      get('/api/agent/usage'),
    ])
    agentSessions.value = sessions.sessions || []
    agentUsage.value = usage
  } catch (e) {
    error.value = e.message
  } finally {
    sessionsLoading.value = false
  }
}

function selectWebSession(sessionId) {
  if (!sessionId || sessionId === currentWebSessionId.value) return
  dispatchSessionChange(sessionId)
}

async function renameWebSession(session) {
  const title = window.prompt('请输入新的会话名称', session.title || '新会话')?.trim()
  if (!title || title === session.title) return
  sessionBusy.value = true
  try {
    await put(`/api/agent/sessions/${encodeURIComponent(session.session_id)}`, { title })
    await loadAgentOperations()
    notice.value = '会话名称已更新。'
  } catch (e) {
    error.value = e.message
  } finally {
    sessionBusy.value = false
  }
}

async function deleteWebSession(session) {
  if (!(await confirmDialog({
    title: '删除会话？',
    message: `将删除“${session.title || '新会话'}”及其历史记录，此操作无法恢复。`,
    confirmText: '删除',
  }))) return
  sessionBusy.value = true
  try {
    await del(`/api/agent/sessions/${encodeURIComponent(session.session_id)}`)
    if (session.session_id === currentWebSessionId.value) await newWebSession()
    await loadAgentOperations()
    notice.value = '会话已删除。'
  } catch (e) {
    error.value = e.message
  } finally {
    sessionBusy.value = false
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [saved, current] = await Promise.all([get('/api/agent/config'), get('/api/agent/status')])
    const loadedProfiles = Array.isArray(saved.profiles) ? saved.profiles : []
    profiles.value = loadedProfiles.length ? loadedProfiles : [{
      profile_id: saved.profile_id || 'default',
      profile_name: saved.profile_name || '默认配置',
    }]
    activeProfileId.value = saved.active_profile_id || saved.profile_id || profiles.value[0]?.profile_id || ''
    status.value = current
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function switchProfile() {
  if (!activeProfileId.value) return
  profileBusy.value = true
  notice.value = ''
  error.value = ''
  try {
    await post(`/api/agent/config/profiles/${encodeURIComponent(activeProfileId.value)}/select`, {})
    await load()
    notice.value = '已切换配置档案。'
  } catch (e) {
    error.value = e.message
  } finally {
    profileBusy.value = false
  }
}

async function switchToProfile(profileId) {
  if (!profileId || profileId === activeProfileId.value) return
  activeProfileId.value = profileId
  await switchProfile()
}

function openCreateProfile() {
  router.push('/agent/config/new')
}

function openProfileEditor(profileId) {
  router.push(`/agent/config/${encodeURIComponent(profileId)}`)
}

async function duplicateProfile(profile) {
  profileBusy.value = true
  notice.value = ''
  error.value = ''
  try {
    await post(`/api/agent/config/profiles/${encodeURIComponent(profile.profile_id)}/duplicate`, {
      name: `${profile.profile_name} 副本`,
    })
    await load()
    notice.value = `已复制“${profile.profile_name}”，当前正在使用副本。`
  } catch (e) {
    error.value = e.message
  } finally {
    profileBusy.value = false
  }
}

async function removeProfile() {
  if (profiles.value.length <= 1 || !activeProfileId.value) return
  const current = profiles.value.find((item) => item.profile_id === activeProfileId.value)
  if (!(await confirmDialog({
    title: '删除配置？',
    message: `将删除“${current?.profile_name || '当前配置'}”，此操作无法恢复。`,
    confirmText: '删除',
  }))) return
  profileBusy.value = true
  notice.value = ''
  error.value = ''
  try {
    await del(`/api/agent/config/profiles/${encodeURIComponent(activeProfileId.value)}`)
    await load()
    notice.value = '配置档案已删除。'
  } catch (e) {
    error.value = e.message
  } finally {
    profileBusy.value = false
  }
}

async function loadWechat() {
  wechatLoading.value = true
  try {
    const [current, policy] = await Promise.all([get('/api/wechat/status'), get('/api/wechat/config')])
    wechat.value = current
    await updateWechatQr(current.login?.qrcode_img_content)
    wechatConfig.allow_all = !!policy.allow_all
    wechatConfig.allow_users = [...(policy.allow_users || [])]
    wechatConfig.source = policy.source || 'local'
    if (current.login?.status === 'waiting' || current.login?.status === 'scanned') startLoginPolling()
  } catch (e) {
    error.value = e.message
  } finally {
    wechatLoading.value = false
  }
}

async function refreshWechat() {
  try {
    const current = await get('/api/wechat/status')
    wechat.value = current
    await updateWechatQr(current.login?.qrcode_img_content)
  } catch (e) {
    error.value = e.message
  }
}

function startLoginPolling() {
  if (loginTimer) return
  loginTimer = window.setInterval(pollWechatLogin, 2200)
}

function stopLoginPolling() {
  if (loginTimer) window.clearInterval(loginTimer)
  loginTimer = null
}

async function startWechatLogin() {
  loginStarting.value = true
  notice.value = ''
  error.value = ''
  try {
    const result = await post('/api/wechat/login/start', {})
    wechat.value = { ...(wechat.value || {}), login: result }
    await updateWechatQr(result.qrcode_img_content)
    notice.value = '二维码已生成，请使用微信扫描。'
    startLoginPolling()
  } catch (e) {
    error.value = e.message
  } finally {
    loginStarting.value = false
  }
}

async function pollWechatLogin() {
  if (loginPolling.value) return
  loginPolling.value = true
  try {
    const login = await post('/api/wechat/login/poll', {})
    wechat.value = { ...(wechat.value || {}), login }
    await updateWechatQr(login.qrcode_img_content)
    if (login.status === 'confirmed' || login.status === 'expired') {
      stopLoginPolling()
      await refreshWechat()
      if (login.status === 'confirmed') notice.value = '微信已连接，消息循环已自动启动。'
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loginPolling.value = false
  }
}

async function changeWechatLoop(action) {
  loopChanging.value = true
  notice.value = ''
  error.value = ''
  try {
    await post(`/api/wechat/loop/${action}`, {})
    await refreshWechat()
    notice.value = action === 'start' ? '微信消息循环已启动。' : '微信消息循环已停止。'
  } catch (e) {
    error.value = e.message
  } finally {
    loopChanging.value = false
  }
}

function addWechatUser(userId = newWechatUser.value) {
  const normalized = userId.trim()
  if (!normalized || wechatConfig.allow_users.includes(normalized)) return
  wechatConfig.allow_users.push(normalized)
  newWechatUser.value = ''
}

function removeWechatUser(userId) {
  wechatConfig.allow_users = wechatConfig.allow_users.filter(item => item !== userId)
}

async function saveWechatPolicy() {
  policySaving.value = true
  notice.value = ''
  error.value = ''
  try {
    const result = await put('/api/wechat/config', {
      allow_all: wechatConfig.allow_all,
      allow_users: wechatConfig.allow_users,
    })
    wechatConfig.allow_users = [...(result.allow_users || [])]
    wechatConfig.source = result.source || 'local'
    notice.value = '微信授权策略已保存。'
  } catch (e) {
    error.value = e.message
  } finally {
    policySaving.value = false
  }
}

async function updateWechatQr(content) {
  const raw = String(content || '').trim()
  if (!raw) {
    wechatQr.value = ''
    wechatQrSource.value = ''
    return
  }
  if (raw === wechatQrSource.value) return
  wechatQrSource.value = raw
  if (raw.startsWith('data:image/')) {
    wechatQr.value = raw
    return
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    wechatQr.value = await QRCode.toDataURL(raw, {
      width: 440,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#1d1d1f', light: '#ffffff' },
    })
    return
  }
  wechatQr.value = `data:image/png;base64,${raw.replace(/\s/g, '')}`
}

function loginStatusText(value) {
  return ({ waiting: '请用微信扫描二维码', scanned: '已扫码，请在微信中确认', expired: '二维码已过期，请重新生成' })[value] || '正在等待微信授权'
}

onMounted(() => {
  load()
  loadAgentOperations()
  loadWechat()
  statusTimer = window.setInterval(refreshWechat, 6000)
})

onBeforeUnmount(() => {
  stopLoginPolling()
  if (statusTimer) window.clearInterval(statusTimer)
})
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div>
        <button class="btn btn-outline agent-back-button" type="button" @click="router.push('/settings')"><ArrowLeft :size="14" /> 返回系统设置</button>
        <div class="page-title">AI 设置</div>
        <div class="page-subtitle">配置模型，让班小助能够查询智汇·班记数据</div>
      </div>
    </div>

    <div v-if="loading" class="loading">加载配置中…</div>
    <template v-else>
      <div v-if="notice" class="notice-bar"><CheckCircle :size="16" /> {{ notice }}</div>
      <div v-if="error" class="agent-error"><CircleAlert :size="16" /> {{ error }}</div>

      <div class="card">
        <div class="card-title"><Brain :size="16" /> 模型连接</div>
        <div class="agent-profile-heading">
          <div>
            <strong>配置档案</strong>
          </div>
          <button class="btn btn-outline" type="button" :disabled="profileBusy" @click="openCreateProfile"><Plus :size="14" /> 新建配置</button>
        </div>
        <div class="agent-profile-list">
          <div v-for="item in profiles" :key="item.profile_id" class="agent-profile-card" :class="{ active: item.profile_id === activeProfileId }" @click="switchToProfile(item.profile_id)">
            <GripVertical :size="15" class="agent-profile-grip" aria-hidden="true" />
            <div class="agent-profile-icon"><Brain :size="18" /></div>
            <div class="agent-profile-main">
              <div class="agent-profile-name">{{ item.profile_name }} <span v-if="item.profile_id === activeProfileId" class="agent-profile-using">✓ 使用中</span></div>
              <div class="agent-profile-url">{{ item.base_url || '尚未配置 API Base URL' }}</div>
            </div>
            <div class="agent-profile-actions">
              <button v-if="item.profile_id !== activeProfileId" class="btn btn-outline agent-profile-use" type="button" :disabled="profileBusy" @click.stop="switchToProfile(item.profile_id)">使用此配置</button>
              <template v-else>
                <button class="icon-button" type="button" title="编辑配置" :disabled="profileBusy" @click.stop="openProfileEditor(item.profile_id)"><Pencil :size="15" /></button>
                <button class="icon-button" type="button" title="复制配置" :disabled="profileBusy" @click.stop="duplicateProfile(item)"><Copy :size="15" /></button>
                <button class="icon-button" type="button" title="编辑 API Key" :disabled="profileBusy" @click.stop="openProfileEditor(item.profile_id)"><KeyRound :size="15" /></button>
                <button v-if="profiles.length > 1" class="icon-button" type="button" title="删除配置" :disabled="profileBusy" @click.stop="removeProfile"><Trash2 :size="15" /></button>
              </template>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">当前状态</div>
        <div class="agent-status-grid">
          <div><span>模型</span><strong>{{ status?.model || '未配置' }}</strong></div>
          <div><span>模型配置</span><strong :class="status?.model_configured ? 'status-ok' : 'status-off'">{{ status?.model_configured ? '已配置' : '未配置' }}</strong></div>
          <div><span>可用工具</span><strong>{{ status?.tool_count || 0 }} 个工具</strong></div>
        </div>
      </div>

      <div class="card agent-session-card">
        <div class="card-title"><MessageCircle :size="16" /> 网页 Agent 会话</div>
        <div class="session-toolbar">
          <span class="muted">网页与微信会话相互隔离；切换会话不会混用上下文。</span>
          <button class="btn btn-primary" type="button" @click="newWebSession"><Plus :size="14" /> 新建会话</button>
        </div>
        <div class="current-session">当前会话已就绪</div>
        <div v-if="sessionsLoading" class="loading-inline">读取会话中…</div>
        <div v-else-if="!agentSessions.length" class="wechat-muted">还没有保存的网页会话，发送第一条消息后会自动出现在这里。</div>
        <div v-else class="session-list">
          <div v-for="session in agentSessions" :key="session.session_id" class="session-row" :class="{ active: session.session_id === currentWebSessionId }">
            <button class="session-select" type="button" @click="selectWebSession(session.session_id)">
              <strong>{{ session.title || '新会话' }}</strong>
              <small>{{ session.message_count }} 条消息 · {{ session.updated_at }}</small>
            </button>
            <div class="session-actions">
              <button class="icon-button" type="button" title="重命名会话" :disabled="sessionBusy" @click="renameWebSession(session)"><Pencil :size="14" /></button>
              <button class="icon-button" type="button" title="删除会话" :disabled="sessionBusy" @click="deleteWebSession(session)"><Trash2 :size="14" /></button>
            </div>
          </div>
        </div>
      </div>

      <div class="card agent-usage-card">
        <div class="card-title"><BarChart3 :size="16" /> Agent 使用统计</div>
        <div class="usage-grid">
          <div><span>工具调用</span><strong>{{ agentUsage?.tool_calls?.total ?? 0 }}</strong></div>
          <div><span>成功</span><strong class="status-ok">{{ agentUsage?.tool_calls?.successful ?? 0 }}</strong></div>
          <div><span>失败/拒绝</span><strong class="status-off">{{ agentUsage?.tool_calls?.failed ?? 0 }}</strong></div>
          <div><span>失败率</span><strong>{{ agentUsage ? `${(agentUsage.tool_calls.failure_rate * 100).toFixed(1)}%` : '—' }}</strong></div>
        </div>
        <div class="muted">统计来自本地 Agent 审计记录；模型 Token 需模型接口返回 usage 后才会显示。</div>
      </div>

      <div class="card wechat-card">
        <div class="card-title"><MessageCircle :size="16" /> 微信 iLink 连接</div>
        <div v-if="wechatLoading" class="loading-inline">读取微信连接状态中…</div>
        <template v-else>
          <div class="wechat-connection-grid">
            <div class="wechat-login-panel">
              <div class="wechat-status-line">
                <span class="status-dot" :class="wechat?.running ? 'is-on' : ''"></span>
                <strong>{{ wechat?.running ? '消息循环运行中' : '微信未运行' }}</strong>
                <span v-if="wechat?.configured" class="status-ok">已完成授权</span>
              </div>
              <div v-if="wechat?.needs_relogin" class="wechat-relogin-warning">
                <CircleAlert :size="15" /> 微信会话已过期，请重新扫码连接。
              </div>
              <div class="wechat-metrics">已处理 {{ wechat?.processed || 0 }} 条微信消息</div>
              <div v-if="wechatQr && wechat?.login?.status !== 'confirmed'" class="wechat-qr-wrap">
                <img :src="wechatQr" alt="微信登录二维码" class="wechat-qr" />
                <div class="wechat-qr-tip">{{ loginStatusText(wechat.login.status) }}</div>
              </div>
              <div v-else-if="!wechat?.configured" class="wechat-empty-state">
                <QrCode :size="30" />
                <span>还没有微信授权，请先生成二维码。</span>
              </div>
              <div v-else class="wechat-connected-state">
                <ShieldCheck :size="30" />
                <span>微信已授权{{ wechat.account_id ? `（${wechat.account_id}）` : '' }}。</span>
              </div>
              <div class="toolbar wechat-actions">
                <button class="btn btn-primary" :disabled="loginStarting" @click="startWechatLogin">
                  <QrCode :size="14" /> {{ loginStarting ? '生成中…' : '扫码连接微信' }}
                </button>
                <button v-if="wechat?.configured && !wechat?.running" class="btn btn-outline" :disabled="loopChanging" @click="changeWechatLoop('start')">
                  <Play :size="14" /> 启动消息循环
                </button>
                <button v-if="wechat?.running" class="btn btn-outline" :disabled="loopChanging" @click="changeWechatLoop('stop')">
                  <Square :size="14" /> 停止消息循环
                </button>
              </div>
              <div v-if="wechat?.last_error" class="wechat-last-error">最近错误：{{ wechat.last_error }}</div>
            </div>

            <div class="wechat-policy-panel">
              <div class="wechat-panel-title"><ShieldCheck :size="15" /> 使用授权</div>
              <label class="checkbox-row">
                <input v-model="wechatConfig.allow_all" type="checkbox" />
                <span><strong>允许所有微信用户</strong><small>仅建议本机联调时短暂开启</small></span>
              </label>
              <div class="wechat-security-note">默认只允许下方白名单用户。未授权用户发消息后，可从"最近发送者"复制 ID 加入。</div>
              <div class="wechat-user-input">
                <input v-model="newWechatUser" class="form-input" placeholder="粘贴微信用户 ID" @keyup.enter="addWechatUser()" />
                <button class="btn btn-outline" type="button" @click="addWechatUser()"><UserPlus :size="14" /> 添加</button>
              </div>
              <div v-if="wechatConfig.allow_users.length" class="wechat-user-list">
                <div v-for="userId in wechatConfig.allow_users" :key="userId" class="wechat-user-row">
                  <code>{{ userId }}</code>
                  <button class="icon-button" type="button" aria-label="移除白名单用户" @click="removeWechatUser(userId)"><Trash2 :size="14" /></button>
                </div>
              </div>
              <div v-else class="wechat-muted">当前没有白名单用户。</div>
              <div v-if="wechat?.recent_senders?.length" class="wechat-recent">
                <div class="wechat-muted">最近发送者</div>
                <button v-for="userId in wechat.recent_senders" :key="userId" class="wechat-recent-user" type="button" @click="addWechatUser(userId)">
                  <code>{{ userId }}</code><span>加入</span>
                </button>
              </div>
              <button class="btn btn-outline wechat-save-policy" :disabled="policySaving || wechatConfig.source === 'environment'" @click="saveWechatPolicy">
                <RefreshCw :size="14" /> {{ wechatConfig.source === 'environment' ? '由环境变量管理' : (policySaving ? '保存中…' : '保存授权策略') }}
              </button>
            </div>
          </div>
        </template>
      </div>
    </template>

  </div>
</template>

<style scoped>
.agent-back-button { margin-bottom:12px; }
.agent-profile-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; max-width:900px; margin-bottom:12px; }
.agent-profile-heading > div { display:grid; gap:4px; }
.agent-profile-heading strong { font-size:14px; }
.agent-profile-heading span { color:var(--text-secondary); font-size:12px; }
.agent-profile-list { display:grid; gap:10px; max-width:900px; }
.agent-profile-card { display:flex; align-items:center; gap:12px; min-height:78px; padding:12px 14px; border:1px solid var(--border); border-radius:14px; background:var(--surface); cursor:pointer; transition:border-color .16s ease, background .16s ease, box-shadow .16s ease; }
.agent-profile-card:hover { border-color:var(--primary); box-shadow:0 3px 12px rgba(51,82,180,.08); }
.agent-profile-card.active { border-color:#6d96ff; background:#f3f7ff; box-shadow:0 3px 12px rgba(51,82,180,.08); }
.agent-profile-grip { flex:none; color:var(--text-tertiary); }
.agent-profile-icon { display:grid; place-items:center; flex:none; width:34px; height:34px; border:1px solid var(--border); border-radius:10px; color:#5578ee; background:#f7f9ff; }
.agent-profile-main { min-width:0; flex:1; display:grid; gap:5px; }
.agent-profile-name { display:flex; align-items:center; gap:8px; min-width:0; color:var(--text); font-size:15px; font-weight:600; }
.agent-profile-using { flex:none; padding:3px 8px; border-radius:6px; color:var(--text-secondary); background:#eef0f4; font-size:11px; font-weight:500; }
.agent-profile-url { overflow:hidden; color:#1670e8; font-size:13px; text-overflow:ellipsis; white-space:nowrap; }
.agent-profile-actions { display:flex; align-items:center; gap:4px; flex:none; }
.agent-profile-use { white-space:nowrap; }
.agent-security-note { margin-top: 14px; color: var(--text-secondary); font-size: 12px; }
.agent-key-status { color: var(--success); font-size: 12px; font-weight: 400; }
.agent-error { display:flex; align-items:center; gap:8px; padding:10px 14px; margin:-8px 0 18px; border-radius:var(--radius); color:#a33a32; background:var(--danger-bg); font-size:13px; }
.agent-status-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
.agent-status-grid div { display:grid; gap:4px; padding:12px; border-radius:10px; background:var(--bg); }
.agent-status-grid span { color:var(--text-secondary); font-size:12px; }
.agent-status-grid strong { font-size:14px; }
.status-ok { color:var(--success); }
.status-off { color:var(--text-secondary); }
.status-warn { color:#a56a12; }
.status-error { color:#c83b32; }
.wechat-card { margin-top:18px; }
.agent-session-card, .agent-usage-card { margin-top:18px; }
.session-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.current-session { margin:12px 0; color:var(--text-secondary); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.session-list { display:grid; gap:7px; max-height:280px; overflow:auto; }
.session-row { display:flex; align-items:center; gap:8px; padding:7px 9px; border:1px solid transparent; border-radius:9px; background:var(--bg); }
.session-row.active { border-color:var(--primary); background:var(--primary-bg); }
.session-select { min-width:0; flex:1; display:grid; gap:3px; padding:0; border:0; background:none; color:var(--text); text-align:left; cursor:pointer; }
.session-select strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.session-select small { color:var(--text-secondary); font-size:11px; }
.session-actions { display:flex; gap:2px; }
.usage-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-bottom:10px; }
.usage-grid div { display:grid; gap:4px; padding:11px; border-radius:9px; background:var(--bg); }
.usage-grid span { color:var(--text-secondary); font-size:12px; }
.usage-grid strong { font-size:18px; }
.wechat-connection-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(300px,0.9fr); gap:24px; }
.wechat-login-panel, .wechat-policy-panel { min-width:0; }
.wechat-status-line { display:flex; align-items:center; gap:8px; min-height:24px; }
.wechat-metrics { color:var(--text-secondary); font-size:12px; margin-top:6px; }
.wechat-relogin-warning { display:flex; align-items:center; gap:7px; margin-top:14px; padding:9px 11px; border-radius:9px; color:#9a5a00; background:var(--warning-bg); font-size:12px; }
.status-dot { width:8px; height:8px; border-radius:50%; background:var(--text-tertiary); }
.status-dot.is-on { background:var(--success); box-shadow:0 0 0 4px var(--success-bg); }
.wechat-qr-wrap { display:flex; flex-direction:column; align-items:center; gap:10px; margin:18px 0; }
.wechat-qr { width:220px; height:220px; object-fit:contain; border:1px solid var(--border); border-radius:12px; background:#fff; }
.wechat-qr-tip, .wechat-security-note, .wechat-last-error { color:var(--text-secondary); font-size:12px; }
.wechat-empty-state, .wechat-connected-state { display:flex; align-items:center; gap:10px; min-height:110px; margin:18px 0; color:var(--text-secondary); }
.wechat-connected-state { color:var(--success); }
.wechat-actions { margin-top:8px; }
.wechat-last-error { margin-top:12px; color:#a33a32; }
.wechat-panel-title { display:flex; align-items:center; gap:6px; font-weight:600; margin-bottom:14px; }
.checkbox-row { display:flex; align-items:flex-start; gap:9px; cursor:pointer; }
.checkbox-row input { margin-top:4px; accent-color:var(--primary); }
.checkbox-row span { display:grid; gap:2px; }
.checkbox-row small { color:var(--text-secondary); font-size:12px; }
.wechat-user-input { display:flex; gap:8px; margin-top:16px; }
.wechat-user-input .form-input { min-width:0; }
.wechat-user-list { display:grid; gap:6px; margin-top:12px; max-height:150px; overflow:auto; }
.wechat-user-row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 9px; background:var(--bg); border-radius:8px; }
.wechat-user-row code, .wechat-recent-user code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wechat-muted { color:var(--text-secondary); font-size:12px; margin-top:12px; }
.wechat-recent { display:grid; gap:6px; margin-top:14px; }
.wechat-recent-user { display:flex; justify-content:space-between; align-items:center; gap:8px; border:0; padding:0; background:none; color:var(--primary); cursor:pointer; text-align:left; }
.wechat-recent-user span { font-size:12px; }
.wechat-save-policy { margin-top:16px; }
.loading-inline { color:var(--text-secondary); font-size:13px; padding:12px 0; }

@media (max-width: 850px) { .wechat-connection-grid { grid-template-columns:1fr; } }
@media (max-width: 700px) {
  .agent-status-grid { grid-template-columns:1fr; }
  .session-toolbar { align-items:flex-start; flex-direction:column; }.usage-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .agent-profile-heading { align-items:flex-start; flex-direction:column; }.agent-profile-card { align-items:flex-start; }.agent-profile-actions { flex-wrap:wrap; margin-left:auto; }.agent-profile-main { padding-top:2px; }
}
</style>
