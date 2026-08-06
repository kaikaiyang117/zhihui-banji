<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Brain, CheckCircle, CircleAlert, MessageCircle, Play, QrCode, RefreshCw, Send, ShieldCheck, Square, Trash2, UserPlus } from 'lucide-vue-next'
import { get, post, put } from '../api'

const providers = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro']
  },
  custom: {
    label: '自定义 OpenAI-compatible',
    baseUrl: '',
    models: []
  }
}

const provider = ref('deepseek')
const config = reactive({ api_key: '', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-flash', thinking: 'disabled' })
const status = ref(null)
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const notice = ref('')
const error = ref('')
const modelOptions = computed(() => providers[provider.value].models)
const wechat = ref(null)
const wechatConfig = reactive({ allow_all: false, allow_users: [], source: 'local' })
const newWechatUser = ref('')
const wechatLoading = ref(true)
const loginStarting = ref(false)
const loginPolling = ref(false)
const loopChanging = ref(false)
const policySaving = ref(false)
let loginTimer = null
let statusTimer = null

function detectProvider(baseUrl) {
  return baseUrl?.includes('api.deepseek.com') ? 'deepseek' : 'custom'
}

function selectProvider() {
  const selected = providers[provider.value]
  if (provider.value === 'deepseek') {
    config.base_url = selected.baseUrl
    if (!selected.models.includes(config.model)) config.model = selected.models[0]
  } else if (config.base_url === providers.deepseek.baseUrl) {
    config.base_url = ''
    config.model = ''
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [saved, current] = await Promise.all([get('/api/agent/config'), get('/api/agent/status')])
    provider.value = detectProvider(saved.base_url)
    config.base_url = saved.base_url || config.base_url
    config.model = saved.model || config.model
    config.thinking = saved.thinking || 'disabled'
    status.value = current
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  notice.value = ''
  error.value = ''
  try {
    const result = await put('/api/agent/config', {
      api_key: config.api_key.trim() || null,
      base_url: config.base_url.trim(),
      model: config.model.trim(),
      thinking: config.thinking,
    })
    config.api_key = ''
    notice.value = `配置已保存${result.api_key_masked ? `（${result.api_key_masked}）` : ''}`
    await load()
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

async function testModel() {
  testing.value = true
  notice.value = ''
  error.value = ''
  try {
    const result = await post('/api/agent/chat', {
      session_id: 'agent-settings-test',
      message: '请只回复：模型连接成功。',
      channel: 'local',
      actor_id: 'settings'
    })
    notice.value = result.answer || '模型已返回结果'
  } catch (e) {
    error.value = e.message
  } finally {
    testing.value = false
  }
}

async function loadWechat() {
  wechatLoading.value = true
  try {
    const [current, policy] = await Promise.all([get('/api/wechat/status'), get('/api/wechat/config')])
    wechat.value = current
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
    wechat.value = await get('/api/wechat/status')
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

function wechatQrImage(content) {
  if (!content) return ''
  if (content.startsWith('data:') || content.startsWith('http')) return content
  return `data:image/png;base64,${content}`
}

function loginStatusText(value) {
  return ({ waiting: '请用微信扫描二维码', scanned: '已扫码，请在微信中确认', expired: '二维码已过期，请重新生成' })[value] || '正在等待微信授权'
}

onMounted(() => {
  load()
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
        <div class="page-title">Agent 设置</div>
        <div class="page-subtitle">配置模型，让凯凯小兵能够查询工作台数据</div>
      </div>
    </div>

    <div v-if="loading" class="loading">加载配置中…</div>
    <template v-else>
      <div v-if="notice" class="notice-bar"><CheckCircle :size="16" /> {{ notice }}</div>
      <div v-if="error" class="agent-error"><CircleAlert :size="16" /> {{ error }}</div>

      <div class="card">
        <div class="card-title"><Brain :size="16" /> 模型连接</div>
        <div class="form-grid agent-form-grid">
          <label>模型服务
            <select v-model="provider" class="form-select" @change="selectProvider">
              <option v-for="(item, key) in providers" :key="key" :value="key">{{ item.label }}</option>
            </select>
          </label>
          <label>模型名称
            <select v-if="provider === 'deepseek'" v-model="config.model" class="form-select">
              <option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option>
            </select>
            <input v-else v-model="config.model" class="form-input" placeholder="例如 deepseek-v4-flash" />
          </label>
          <label class="form-grid-wide">API Base URL
            <input v-model="config.base_url" class="form-input" placeholder="https://api.deepseek.com" />
          </label>
          <label class="form-grid-wide">API Key
            <input v-model="config.api_key" class="form-input" type="password" autocomplete="new-password" placeholder="留空表示保留当前 Key" />
          </label>
          <label>Thinking 模式
            <select v-model="config.thinking" class="form-select">
              <option value="disabled">关闭（推荐，工具调用更稳定）</option>
              <option value="enabled">开启（需要模型支持 reasoning_content）</option>
            </select>
          </label>
        </div>
        <div class="agent-security-note">Key 只保存到本机数据目录，不会通过接口返回，也不会写入 Git。</div>
        <div class="toolbar agent-actions">
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存配置' }}</button>
          <button class="btn btn-outline" :disabled="testing" @click="testModel"><Send :size="14" /> {{ testing ? '测试中…' : '测试模型' }}</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">当前状态</div>
        <div class="agent-status-grid">
          <div><span>模型</span><strong>{{ status?.model || '未配置' }}</strong></div>
          <div><span>模型配置</span><strong :class="status?.model_configured ? 'status-ok' : 'status-off'">{{ status?.model_configured ? '已配置' : '未配置' }}</strong></div>
          <div><span>可用工具</span><strong>{{ status?.tool_count || 0 }} 个只读工具</strong></div>
        </div>
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
              <div v-if="wechat?.login?.qrcode_img_content && wechat?.login?.status !== 'confirmed'" class="wechat-qr-wrap">
                <img :src="wechatQrImage(wechat.login.qrcode_img_content)" alt="微信登录二维码" class="wechat-qr" />
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
              <div class="wechat-security-note">默认只允许下方白名单用户。未授权用户发消息后，可从“最近发送者”复制 ID 加入。</div>
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
.agent-form-grid { max-width: 760px; }
.agent-security-note { margin-top: 14px; color: var(--text-secondary); font-size: 12px; }
.agent-actions { margin-top: 18px; }
.agent-error { display:flex; align-items:center; gap:8px; padding:10px 14px; margin:-8px 0 18px; border-radius:var(--radius); color:#a33a32; background:var(--danger-bg); font-size:13px; }
.agent-status-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
.agent-status-grid div { display:grid; gap:4px; padding:12px; border-radius:10px; background:var(--bg); }
.agent-status-grid span { color:var(--text-secondary); font-size:12px; }
.agent-status-grid strong { font-size:14px; }
.status-ok { color:var(--success); }
.status-off { color:var(--text-secondary); }
.wechat-card { margin-top:18px; }
.wechat-connection-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(300px,0.9fr); gap:24px; }
.wechat-login-panel, .wechat-policy-panel { min-width:0; }
.wechat-status-line { display:flex; align-items:center; gap:8px; min-height:24px; }
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
@media (max-width: 700px) { .agent-status-grid { grid-template-columns:1fr; } }
</style>
