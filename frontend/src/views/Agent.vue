<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, BarChart3, Brain, CheckCircle, CircleAlert, Copy, Download, FileSpreadsheet, GripVertical, KeyRound, MessageCircle, Pencil, Play, Plus, QrCode, RefreshCw, ShieldCheck, Square, Trash2, Upload, UserPlus, X } from 'lucide-vue-next'
import QRCode from 'qrcode'
import { del, get, post, put, analyzeExcelImport, previewExcelImport, discardExcelImport, downloadExcelImportErrors } from '../api'
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

const importStep = ref('idle')
const importBusy = ref(false)
const importError = ref('')
const importAnalysis = ref(null)
const importPreview = ref(null)
const importResult = ref(null)
const importFileId = ref('')
const importModule = ref('')
const importSheetIndex = ref(0)
const importDuplicateStrategy = ref('update')
const importFileInput = ref(null)
const importMappingExpanded = ref(false)

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

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function moduleName(name) {
  return ({ students: '学生信息', scores: '成绩', calendar: '校历', timetable: '课程表' })[name] || name
}

function triggerImportFile() {
  importFileInput.value?.click()
}

async function handleImportFile(event) {
  const file = event.target.files?.[0]
  if (!file) return
  event.target.value = ''
  importBusy.value = true
  importError.value = ''
  importStep.value = 'uploading'
  importAnalysis.value = null
  importPreview.value = null
  importResult.value = null
  try {
    const fd = new FormData()
    fd.append('file', file)
    const result = await analyzeExcelImport(fd)
    importFileId.value = result.file_id
    importAnalysis.value = result
    if (result.candidate_modules?.length === 1) {
      importModule.value = result.candidate_modules[0].module
      importSheetIndex.value = result.candidate_modules[0].sheet_index ?? 0
    } else {
      importModule.value = ''
      importSheetIndex.value = 0
    }
    importStep.value = 'analyzed'
  } catch (e) {
    importError.value = e.detail?.message || e.message || '文件分析失败'
    importStep.value = 'idle'
  } finally {
    importBusy.value = false
  }
}

function selectImportCandidate(candidate) {
  importModule.value = candidate.module
  importSheetIndex.value = candidate.sheet_index ?? 0
}

async function downloadImportErrors() {
  importError.value = ''
  try {
    await downloadExcelImportErrors(importFileId.value, importModule.value)
  } catch (e) {
    importError.value = e.message || '错误报告下载失败'
  }
}

async function doImportPreview() {
  if (!importFileId.value || !importModule.value) return
  importBusy.value = true
  importError.value = ''
  importMappingExpanded.value = false
  try {
    const result = await previewExcelImport(importFileId.value, importModule.value, importSheetIndex.value, importDuplicateStrategy.value)
    importPreview.value = result
    importStep.value = 'preview'
  } catch (e) {
    importError.value = e.detail?.message || e.message || '预览生成失败'
  } finally {
    importBusy.value = false
  }
}

async function doImportExecute() {
  if (!importPreview.value) return
  importError.value = '旧版导入入口仅保留预览；请在班小助中上传文件并通过统一确认链写入。'
}

async function doImportDiscard() {
  if (!importFileId.value) return
  try {
    await discardExcelImport(importFileId.value)
  } catch { /* ignore */ }
  resetImport()
}

function resetImport() {
  importStep.value = 'idle'
  importBusy.value = false
  importError.value = ''
  importAnalysis.value = null
  importPreview.value = null
  importResult.value = null
  importFileId.value = ''
  importModule.value = ''
  importSheetIndex.value = 0
  importDuplicateStrategy.value = 'update'
  importMappingExpanded.value = false
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
        <div class="current-session">当前会话：<code>{{ currentWebSessionId }}</code></div>
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

      <div class="card excel-import-card">
        <div class="card-title"><FileSpreadsheet :size="16" /> 对话式 Excel 导入</div>

        <div v-if="importError" class="agent-error"><CircleAlert :size="16" /> {{ importError }}</div>

        <div v-if="importStep === 'idle'" class="import-idle">
          <input ref="importFileInput" type="file" accept=".xlsx" style="display:none" @change="handleImportFile" />
          <button class="btn btn-primary" type="button" :disabled="importBusy" @click="triggerImportFile">
            <Upload :size="14" /> 选择 Excel 文件
          </button>
        </div>

        <div v-else-if="importStep === 'uploading'" class="import-uploading">
          <div class="import-spinner"></div>
          <span>正在分析文件…</span>
        </div>

        <div v-else-if="importStep === 'analyzed' && importAnalysis" class="import-analyzed">
          <div class="import-info-card">
            <div class="import-info-row">
              <span class="import-info-label">文件名</span>
              <strong>{{ importAnalysis.filename }}</strong>
            </div>
            <div class="import-info-row">
              <span class="import-info-label">大小</span>
              <span>{{ formatFileSize(importAnalysis.size_bytes) }}</span>
            </div>
            <div class="import-info-row">
              <span class="import-info-label">工作表</span>
              <span>{{ importAnalysis.sheets.join('、') }}</span>
            </div>
            <div class="import-info-row">
              <span class="import-info-label">识别方式</span>
              <span>{{ importAnalysis.recognition_mode === 'hybrid' ? 'AI 语义识别 + 本地规则校验' : '本地规则识别' }}</span>
            </div>
            <div v-if="importAnalysis.scope" class="import-info-row">
              <span class="import-info-label">导入范围</span>
              <strong>{{ importAnalysis.scope.class_name }} · {{ importAnalysis.scope.term_name }}</strong>
            </div>
          </div>
          <div v-if="importAnalysis.recognition_warning" class="import-recognition-warning">{{ importAnalysis.recognition_warning }}</div>

          <div class="import-module-card">
            <div class="import-section-title">识别结果</div>
            <div v-if="importAnalysis.candidate_modules?.length" class="import-module-list">
              <label v-for="candidate in importAnalysis.candidate_modules" :key="`${candidate.module}-${candidate.sheet_index}`" class="import-module-option" :class="{ selected: importModule === candidate.module && importSheetIndex === candidate.sheet_index }">
                <input type="radio" :checked="importModule === candidate.module && importSheetIndex === candidate.sheet_index" :disabled="importBusy" @change="selectImportCandidate(candidate)" />
                <div class="import-module-info">
                  <strong>{{ moduleName(candidate.module) }} · {{ importAnalysis.sheets[candidate.sheet_index] }}</strong>
                  <span class="import-module-reason">{{ candidate.reason }}</span>
                </div>
                <span class="import-module-confidence" :class="{ high: candidate.confidence >= 0.8, medium: candidate.confidence >= 0.5 && candidate.confidence < 0.8 }">
                  {{ (candidate.confidence * 100).toFixed(0) }}%
                </span>
              </label>
            </div>
            <div v-else class="import-no-module">
              <CircleAlert :size="14" /> 无法自动识别，请确认文件格式。
            </div>

            <div v-if="importAnalysis.sheets.length > 1" class="import-sheet-select">
              <label class="import-info-label">选择工作表</label>
              <select v-model="importSheetIndex" class="form-input import-sheet-dropdown" :disabled="importBusy">
                <option v-for="(sheet, idx) in importAnalysis.sheets" :key="idx" :value="idx">{{ sheet }} ({{ importAnalysis.row_counts[idx] }} 行)</option>
              </select>
            </div>

            <div class="import-dup-select">
              <label class="import-info-label">重复记录策略</label>
              <select v-model="importDuplicateStrategy" class="form-input import-sheet-dropdown" :disabled="importBusy">
                <option value="update">按学号更新已有记录</option>
                <option value="skip">跳过已有记录</option>
              </select>
            </div>
          </div>

          <div class="import-actions">
            <button class="btn btn-primary" type="button" :disabled="!importModule || importBusy" @click="doImportPreview">
              预览导入
            </button>
            <button class="btn btn-outline" type="button" :disabled="importBusy" @click="doImportDiscard">
              取消
            </button>
          </div>
        </div>

        <div v-else-if="importStep === 'preview' && importPreview" class="import-preview">
          <div class="import-info-card">
            <div class="import-info-row">
              <span class="import-info-label">模块</span>
              <strong>{{ moduleName(importModule) }}</strong>
            </div>
          </div>

          <div class="import-counts">
            <div class="import-count-item"><span>总行数</span><strong>{{ importPreview.total_rows }}</strong></div>
            <div class="import-count-item"><span>有效</span><strong class="status-ok">{{ importPreview.valid_rows }}</strong></div>
            <div class="import-count-item"><span>新增</span><strong>{{ importPreview.new_count }}</strong></div>
            <div class="import-count-item"><span>更新</span><strong>{{ importPreview.update_count }}</strong></div>
            <div class="import-count-item"><span>跳过</span><strong class="status-off">{{ importPreview.skip_count }}</strong></div>
            <div class="import-count-item"><span>错误</span><strong :class="importPreview.error_rows > 0 ? 'status-error' : 'status-ok'">{{ importPreview.error_rows }}</strong></div>
          </div>

          <div v-if="importPreview.error_rows > 0 && importPreview.errors?.length" class="import-error-preview">
            <div class="import-section-title">错误行（前 10 条）</div>
            <div class="import-error-list">
              <div v-for="(err, idx) in importPreview.errors.slice(0, 10)" :key="idx" class="import-error-row">
                <span class="import-error-line">第 {{ err.row }} 行</span>
                <span>{{ err.reason }}</span>
              </div>
            </div>
          </div>

          <div v-if="importPreview.field_mapping?.some(m => m.mapping_status === 'needs_confirmation')" class="import-mapping-warning">
            存在置信度不足的 AI 字段建议，本次不能直接导入；请修改原文件中的列名后重新上传。
          </div>

          <details class="import-mapping-details" :open="importMappingExpanded" @toggle="importMappingExpanded = $event.currentTarget.open">
            <summary>
              <span>字段映射 ({{ importPreview.field_mapping.filter(m => m.matched).length }}/{{ importPreview.field_mapping.length }})</span>
            </summary>
            <table class="import-mapping-table">
              <thead>
                <tr><th>Excel 列名</th><th>目标字段</th><th>状态</th></tr>
              </thead>
              <tbody>
                <tr v-for="(mapping, idx) in importPreview.field_mapping" :key="idx">
                  <td>{{ mapping.source }}</td>
                  <td>{{ mapping.target || '—' }}</td>
                  <td><span :class="mapping.mapping_status === 'needs_confirmation' ? 'status-warn' : (mapping.matched ? 'status-ok' : 'status-off')">{{ mapping.mapping_status === 'needs_confirmation' ? '待人工确认' : (mapping.matched ? (mapping.source_kind === 'ai' ? 'AI 建议，已校验' : '规则匹配') : '未匹配') }}</span></td>
                </tr>
              </tbody>
            </table>
          </details>

          <div class="import-actions">
            <button class="btn btn-primary" type="button" disabled title="请在班小助中使用统一确认链写入" @click="doImportExecute">
              请在班小助中确认写入
            </button>
            <button class="btn btn-outline" type="button" :disabled="importBusy" @click="doImportDiscard">
              取消
            </button>
          </div>
        </div>

        <div v-else-if="importStep === 'result' && importResult" class="import-result">
          <div class="import-result-card">
            <CheckCircle :size="28" class="import-result-icon" />
            <div class="import-result-title">导入完成</div>
          </div>

          <div class="import-counts">
            <div class="import-count-item"><span>新增</span><strong class="status-ok">{{ importResult.imported }}</strong></div>
            <div class="import-count-item"><span>更新</span><strong>{{ importResult.updated }}</strong></div>
            <div class="import-count-item"><span>跳过</span><strong class="status-off">{{ importResult.skipped }}</strong></div>
            <div class="import-count-item"><span>错误</span><strong :class="importResult.error_count > 0 ? 'status-error' : 'status-ok'">{{ importResult.error_count }}</strong></div>
          </div>

          <div v-if="importResult.error_count > 0" class="import-error-download">
            <button type="button" class="btn btn-outline" @click="downloadImportErrors">
              <Download :size="14" /> 下载错误行
            </button>
          </div>

          <div class="import-actions">
            <button class="btn btn-outline" type="button" @click="doImportDiscard">
              继续导入其他文件
            </button>
          </div>
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
.current-session code { color:var(--text); }
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

.excel-import-card { margin-top:18px; }
.import-idle { display:flex; gap:10px; align-items:center; }
.import-uploading { display:flex; align-items:center; gap:10px; color:var(--text-secondary); font-size:13px; }
.import-spinner { width:18px; height:18px; border:2px solid var(--border); border-top-color:var(--primary); border-radius:50%; animation:import-spin .6s linear infinite; }
@keyframes import-spin { to { transform:rotate(360deg); } }
.import-info-card { padding:12px 14px; border:1px solid var(--border); border-radius:10px; background:var(--bg); display:grid; gap:8px; margin-bottom:14px; }
.import-info-row { display:flex; align-items:center; gap:8px; font-size:13px; }
.import-info-label { color:var(--text-secondary); font-size:12px; min-width:70px; }
.import-recognition-warning { margin:-6px 0 14px; padding:8px 10px; border-radius:8px; background:var(--warning-bg); color:#8a5a10; font-size:12px; }
.import-module-card { padding:12px 14px; border:1px solid var(--border); border-radius:10px; background:var(--bg); margin-bottom:14px; }
.import-section-title { font-size:13px; font-weight:600; margin-bottom:10px; }
.import-module-list { display:grid; gap:8px; }
.import-module-option { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid transparent; border-radius:9px; cursor:pointer; transition:border-color .15s ease, background .15s ease; }
.import-module-option:hover { background:var(--primary-bg); }
.import-module-option.selected { border-color:var(--primary); background:var(--primary-bg); }
.import-module-option input[type="radio"] { accent-color:var(--primary); }
.import-module-info { min-width:0; flex:1; display:grid; gap:2px; }
.import-module-info strong { font-size:13px; }
.import-module-reason { color:var(--text-secondary); font-size:12px; }
.import-module-confidence { flex:none; padding:2px 8px; border-radius:6px; font-size:11px; font-weight:600; }
.import-module-confidence.high { background:#e6f9ed; color:#1a8c42; }
.import-module-confidence.medium { background:#fef3e0; color:#a56a12; }
.import-no-module { display:flex; align-items:center; gap:7px; color:var(--text-secondary); font-size:12px; }
.import-sheet-select, .import-dup-select { margin-top:12px; display:grid; gap:4px; }
.import-sheet-dropdown { max-width:300px; }
.import-counts { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:8px; margin-bottom:14px; }
.import-count-item { display:grid; gap:3px; padding:10px; border-radius:8px; background:var(--bg); text-align:center; }
.import-count-item span { color:var(--text-secondary); font-size:11px; }
.import-count-item strong { font-size:16px; }
.import-error-preview { margin-bottom:14px; }
.import-mapping-warning { margin-bottom:14px; padding:9px 11px; border:1px solid #f0d59b; border-radius:8px; background:#fff8e8; color:#8a5b0a; font-size:12px; line-height:1.5; }
.import-error-list { display:grid; gap:4px; max-height:160px; overflow:auto; }
.import-error-row { display:flex; gap:8px; padding:5px 8px; border-radius:6px; background:var(--bg); font-size:12px; }
.import-error-line { color:#c83b32; font-weight:600; white-space:nowrap; min-width:60px; }
.import-mapping-details { margin-bottom:14px; border:1px solid var(--border); border-radius:9px; overflow:hidden; }
.import-mapping-details summary { padding:8px 12px; background:var(--bg); font-size:13px; font-weight:600; cursor:pointer; list-style:none; }
.import-mapping-details summary::-webkit-details-marker { display:none; }
.import-mapping-table { width:100%; border-collapse:collapse; font-size:12px; }
.import-mapping-table th, .import-mapping-table td { padding:6px 10px; border-top:1px solid var(--border); text-align:left; }
.import-mapping-table th { background:var(--bg); color:var(--text-secondary); font-weight:600; }
.import-actions { display:flex; gap:8px; }
.import-result-card { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
.import-result-icon { color:var(--success); }
.import-result-title { font-size:16px; font-weight:700; }
.import-error-download { margin-bottom:14px; }
.import-error-download .btn { text-decoration:none; }

@media (max-width: 850px) { .wechat-connection-grid { grid-template-columns:1fr; } }
@media (max-width: 700px) {
  .agent-status-grid { grid-template-columns:1fr; }
  .session-toolbar { align-items:flex-start; flex-direction:column; }.usage-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .agent-profile-heading { align-items:flex-start; flex-direction:column; }.agent-profile-card { align-items:flex-start; }.agent-profile-actions { flex-wrap:wrap; margin-left:auto; }.agent-profile-main { padding-top:2px; }
  .import-counts { grid-template-columns:repeat(3,minmax(0,1fr)); }
  .import-module-option { padding:6px 8px; }
}
</style>
