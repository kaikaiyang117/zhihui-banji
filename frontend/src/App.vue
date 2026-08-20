<script setup>
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { FileSpreadsheet, MessageCircle, Paperclip, RefreshCw, Send, Settings } from 'lucide-vue-next'
import { useChat } from '@ai-sdk/vue'
import { DefaultChatTransport } from 'ai'
import QRCode from 'qrcode'
import { NAV } from './sheets'
import { getIcon } from './icons'
import {
  analyzeExcelImport,
  clearDeviceCredential,
  del,
  discardExcelImport,
  executeExcelImport,
  fetchWithAccess,
  get,
  post,
  previewExcelImport,
} from './api'
import { renderAgentMarkdown } from './markdown'
import UpdateDialog from './components/UpdateDialog.vue'
import ContextSwitcher from './components/ContextSwitcher.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'

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
const agentError = ref('')
const agentBody = ref(null)
const agentInputEl = ref(null)
const agentFabEl = ref(null)
const agentActionStates = ref({})
const agentTraceOpenStates = ref({})
const agentExcelInput = ref(null)
const agentExcel = ref({
  step: 'idle',
  busy: false,
  error: '',
  fileId: '',
  analysis: null,
  module: '',
  sheetIndex: 0,
  duplicateStrategy: 'update',
  preview: null,
  result: null,
})
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
    return ''
  } catch {
    return ''
  }
}

const agentSessionId = ref(getWebAgentSessionId())

const agentChat = useChat({
  id: 'meimei-web-agent',
  transport: new DefaultChatTransport({
    api: '/api/agent/chat/stream',
    fetch: fetchWithAccess,
    prepareSendMessagesRequest: ({ messages }) => {
      const lastUserMessage = [...messages].reverse().find(item => item.role === 'user')
      const message = (lastUserMessage?.parts || [])
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
      return {
        body: {
          session_id: agentSessionId.value,
          message,
          attachment: agentExcel.value.fileId
            ? {
                file_id: agentExcel.value.fileId,
                filename: agentExcel.value.analysis?.filename || '',
                sheets: agentExcel.value.analysis?.sheets || [],
                candidate_modules: agentExcel.value.analysis?.candidate_modules || [],
              }
            : undefined,
        },
      }
    },
  }),
  onError: error => {
    agentError.value = error.message || 'Agent 流式响应失败，请稍后重试。'
    scrollAgentToBottom()
  },
})
const agentMessages = agentChat.messages
const agentStatus = agentChat.status
const agentSending = computed(() => ['submitted', 'streaming'].includes(agentStatus.value))

async function createAgentSession() {
  const created = await post('/api/agent/sessions', {})
  const sessionId = String(created.session_id || '')
  if (!sessionId) throw new Error('服务器没有返回会话 ID')
  window.localStorage.setItem('meimei_agent_web_session_id', sessionId)
  agentSessionId.value = sessionId
  return sessionId
}

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

const agentToolLabels = {
  class_student_count: '班级人数',
  attendance_summary: '考勤汇总',
  scores_summary: '成绩汇总',
  tasks_list: '待办任务',
  school_calendar_query: '校历查询',
  communications_list: '家校沟通',
  students_search: '搜索学生',
  student_get_profile: '查询学生档案',
  student_get_timeline: '查询学生时间线',
  student_term_comment_context: '查询评语上下文',
  students_query: '查询学生数据',
  students_aggregate: '汇总学生数据',
  create_task: '创建待办',
  record_communication: '记录家校沟通',
  save_attendance: '记录考勤',
  record_points: '记录积分',
  update_task: '修改待办',
  create_event: '记录学生事件',
  create_focus: '创建重点关注',
  create_meeting: '记录班会',
  create_activity: '记录班级活动',
  create_diary: '记录班主任日志',
  create_knowledge_note: '创建知识库笔记',
  create_class_task: '创建班级任务',
}

function agentToolName(part) {
  const toolName = part.toolName || String(part.type || '').replace(/^tool-/, '')
  return agentToolLabels[toolName] || '执行工具'
}

function agentToolOutputText(output) {
  if (output === undefined || output === null) return ''
  if (output && typeof output === 'object' && output.confirmation_required) {
    return output.preview || '请确认是否写入。'
  }
  if (output && typeof output === 'object' && output.error?.message) return output.error.message
  if (Array.isArray(output)) return `返回 ${output.length} 条记录`
  if (typeof output === 'object') return `已返回 ${Object.keys(output).length} 项结果`
  return String(output)
}

function isPendingAgentAction(part) {
  return Boolean(part.output?.confirmation_required && part.output?.action_id)
}

function isAgentToolPart(part) {
  return part?.type === 'dynamic-tool' || String(part?.type || '').startsWith('tool-')
}

function agentToolPartId(part) {
  return String(part?.toolCallId || part?.toolInvocationId || part?.id || '')
}

function agentTraceSteps(message) {
  const parts = message?.parts || []
  const plans = parts.filter(part => part.type === 'data-agent-plan')
  const latestPlan = plans[plans.length - 1]
  const toolParts = parts.filter(isAgentToolPart)
  const toolById = new Map(toolParts.map(part => [agentToolPartId(part), part]))
  const planSteps = Array.isArray(latestPlan?.data?.steps) ? latestPlan.data.steps : []
  const usedToolIds = new Set()
  const steps = planSteps.map(step => {
    const toolPart = toolById.get(String(step.id))
    if (toolPart) usedToolIds.add(agentToolPartId(toolPart))
    return { ...step, toolPart, label: step.label || (toolPart ? agentToolName(toolPart) : '执行步骤') }
  })
  toolParts.forEach(toolPart => {
    if (!usedToolIds.has(agentToolPartId(toolPart))) {
      steps.push({
        id: agentToolPartId(toolPart) || `tool-${steps.length}`,
        label: agentToolName(toolPart),
        status: toolPart.state === 'output-error' ? 'error' : 'completed',
        toolPart,
      })
    }
  })
  return steps
}

function agentTraceStepStatus(step) {
  const toolPart = step.toolPart
  if (step.status === 'error' || toolPart?.state === 'output-error') return 'error'
  if (toolPart && isPendingAgentAction(toolPart)) {
    const actionStatus = agentActionState(toolPart).status
    if (actionStatus === 'executed') return 'completed'
    if (actionStatus === 'cancelled') return 'skipped'
    if (actionStatus === 'error') return 'error'
    return 'waiting'
  }
  if (toolPart?.state === 'output-available') return 'completed'
  return step.status || 'pending'
}

function agentTraceStepStatusText(step) {
  return ({
    pending: '等待执行', running: '执行中', completed: '已完成', skipped: '已跳过',
    error: '失败', waiting: '等待确认',
  })[agentTraceStepStatus(step)] || '处理中'
}

function agentTraceStepDetail(step) {
  const toolPart = step.toolPart
  if (toolPart?.state === 'output-error') return toolPart.errorText || '工具执行失败'
  if (toolPart?.state === 'output-available') return agentToolOutputText(toolPart.output)
  return step.message || ''
}

function agentTraceStatus(message) {
  const steps = agentTraceSteps(message)
  if (!steps.length) return 'completed'
  if (steps.some(step => agentTraceStepStatus(step) === 'error')) return 'error'
  if (steps.some(step => agentTraceStepStatus(step) === 'waiting')) return 'waiting'
  if (steps.some(step => agentTraceStepStatus(step) === 'running')) return 'running'
  return 'completed'
}

function agentTraceStatusText(message) {
  return ({ running: '执行中', waiting: '等待确认', error: '执行失败', completed: '已完成' })[agentTraceStatus(message)]
}

function agentTraceOpen(message) {
  const messageId = String(message?.id || '')
  if (Object.prototype.hasOwnProperty.call(agentTraceOpenStates.value, messageId)) {
    return agentTraceOpenStates.value[messageId]
  }
  return true
}

function handleAgentTraceToggle(message, event) {
  const messageId = String(message?.id || '')
  if (!messageId) return
  agentTraceOpenStates.value = {
    ...agentTraceOpenStates.value,
    [messageId]: Boolean(event.currentTarget?.open),
  }
}

function agentActionState(part) {
  return agentActionStates.value[String(part.output?.action_id)] || { status: 'pending', error: '' }
}

function setAgentActionState(actionId, state) {
  agentActionStates.value = { ...agentActionStates.value, [String(actionId)]: state }
}

function appendAgentAssistantMessage(text) {
  agentMessages.value.push({
    id: `local-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    parts: [{ type: 'text', text, state: 'done' }],
  })
  scrollAgentToBottom()
}

async function confirmAgentAction(part) {
  if (!isPendingAgentAction(part)) return
  const actionId = String(part.output.action_id)
  if (['confirming', 'executed', 'cancelled'].includes(agentActionState(part).status)) return
  setAgentActionState(actionId, { status: 'confirming', error: '' })
  try {
    await post(`/api/agent/actions/${encodeURIComponent(actionId)}/confirm`, {
      session_id: agentSessionId.value,
    })
    setAgentActionState(actionId, { status: 'executed', error: '' })
    appendAgentAssistantMessage(`已确认写入：${agentToolName(part)}。写入校验已通过。`)
  } catch (error) {
    setAgentActionState(actionId, { status: 'error', error: error.message || '写入失败，请稍后重试。' })
  }
}

async function cancelAgentAction(part) {
  if (!isPendingAgentAction(part)) return
  const actionId = String(part.output.action_id)
  if (['confirming', 'executed', 'cancelled'].includes(agentActionState(part).status)) return
  setAgentActionState(actionId, { status: 'confirming', error: '' })
  try {
    await post(`/api/agent/actions/${encodeURIComponent(actionId)}/cancel`, {
      session_id: agentSessionId.value,
    })
    setAgentActionState(actionId, { status: 'cancelled', error: '' })
    appendAgentAssistantMessage(`已取消${agentToolName(part)}，没有修改业务数据。`)
  } catch (error) {
    setAgentActionState(actionId, { status: 'error', error: error.message || '取消失败，请稍后重试。' })
  }
}

function historyMessage(item, index) {
  const role = item.role === 'user' || item.role === 'assistant' ? item.role : ''
  const content = typeof item.content === 'string' ? item.content : ''
  if (!role || !content.trim()) return null
  return {
    id: `history-${index}`,
    role,
    parts: [{ type: 'text', text: content, state: 'done' }],
  }
}

function scrollAgentToBottom(options = {}) {
  nextTick(() => {
    const body = agentBody.value
    if (!body) return
    const instant = options.instant ?? !agentOpen.value
    if (instant) {
      const previousScrollBehavior = body.style.scrollBehavior
      body.style.scrollBehavior = 'auto'
      body.scrollTop = body.scrollHeight
      body.style.scrollBehavior = previousScrollBehavior
      return
    }
    body.scrollTo({
      top: body.scrollHeight,
      behavior: 'smooth',
    })
  })
}

function useAgentSuggestion(message) {
  agentInput.value = message
  nextTick(() => agentInputEl.value?.focus())
}

function openAgentChat() {
  agentOpen.value = true
  nextTick(() => {
    agentInputEl.value?.focus()
    scrollAgentToBottom({ instant: true })
  })
}

function handleAgentPanelEntered() {
  agentInputEl.value?.focus()
  scrollAgentToBottom({ instant: true })
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

function agentExcelModuleName(module) {
  return ({ students: '学生信息', scores: '成绩', calendar: '校历', timetable: '课程表' })[module] || module
}

function formatAgentFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function resetAgentExcelState() {
  agentExcel.value = {
    step: 'idle', busy: false, error: '', fileId: '', analysis: null,
    module: '', sheetIndex: 0, duplicateStrategy: 'update', preview: null, result: null,
  }
}

function triggerAgentExcelUpload() {
  if (agentExcel.value.busy || agentSending.value) return
  agentExcelInput.value?.click()
}

async function handleAgentExcelFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (!/\.xlsx$/i.test(file.name)) {
    agentExcel.value.error = '目前仅支持 .xlsx 文件，请先另存为 Excel 工作簿。'
    return
  }
  if (agentExcel.value.fileId) {
    try { await discardExcelImport(agentExcel.value.fileId, agentSessionId.value) } catch { /* 上传新文件时忽略旧文件清理失败 */ }
  }
  if (!agentSessionId.value) await createAgentSession()
  agentExcel.value = { ...agentExcel.value, step: 'uploading', busy: true, error: '', analysis: null, preview: null, result: null, fileId: '' }
  try {
    const formData = new FormData()
    formData.append('file', file)
    const analysis = await analyzeExcelImport(formData, agentSessionId.value)
    agentExcel.value = {
      ...agentExcel.value,
      step: 'analyzed',
      busy: false,
      fileId: analysis.file_id,
      analysis,
      module: analysis.candidate_modules?.length === 1 ? analysis.candidate_modules[0].module : '',
      sheetIndex: 0,
      duplicateStrategy: 'update',
    }
    scrollAgentToBottom({ instant: true })
  } catch (error) {
    agentExcel.value = { ...agentExcel.value, step: 'idle', busy: false, error: error.detail?.message || error.message || '文件分析失败' }
  }
}

async function previewAgentExcel() {
  const current = agentExcel.value
  if (!current.fileId || !current.module || current.busy) return
  agentExcel.value = { ...current, busy: true, error: '' }
  try {
    const preview = await previewExcelImport(current.fileId, current.module, current.sheetIndex, current.duplicateStrategy, agentSessionId.value)
    agentExcel.value = { ...agentExcel.value, step: 'preview', busy: false, preview }
  } catch (error) {
    agentExcel.value = { ...agentExcel.value, busy: false, error: error.detail?.message || error.message || '预览生成失败' }
  }
}

async function executeAgentExcel() {
  const current = agentExcel.value
  if (!current.preview || current.busy) return
  agentExcel.value = { ...current, busy: true, error: '' }
  try {
    const result = await executeExcelImport(current.fileId, current.module, current.preview.preview_hash, `agent-web-${Date.now()}`, agentSessionId.value)
    agentExcel.value = { ...agentExcel.value, step: 'result', busy: false, result }
  } catch (error) {
    agentExcel.value = { ...agentExcel.value, busy: false, error: error.detail?.message || error.message || '导入执行失败' }
  }
}

function backToAgentExcelAnalysis() {
  agentExcel.value = { ...agentExcel.value, step: 'analyzed', preview: null, result: null, error: '' }
}

async function discardAgentExcel() {
  const fileId = agentExcel.value.fileId
  if (fileId) {
    try { await discardExcelImport(fileId, agentSessionId.value) } catch { /* 文件过期时也允许清理界面 */ }
  }
  resetAgentExcelState()
}

async function sendAgentMessage() {
  const message = agentInput.value.trim() || (agentExcel.value.fileId ? '请分析我刚上传的 Excel 文件，并告诉我下一步。' : '')
  if (!message || agentSending.value) return
  agentInput.value = ''
  agentError.value = ''
  try {
    if (!agentSessionId.value) await createAgentSession()
    await agentChat.sendMessage({ text: message })
  } catch (error) {
    agentError.value = error.message || '发送失败，请稍后重试。'
    scrollAgentToBottom({ instant: true })
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
    await discardAgentExcel()
    if (agentSessionId.value) {
      await del(`/api/agent/sessions/${encodeURIComponent(agentSessionId.value)}`)
    }
    await createAgentSession()
    agentMessages.value = []
    agentTraceOpenStates.value = {}
    agentChat.clearError()
    agentError.value = ''
    scrollAgentToBottom({ instant: true })
  } catch (error) {
    agentError.value = error.message || '新会话创建失败，请稍后重试。'
  }
}

async function loadAgentHistory() {
  try {
    if (!agentSessionId.value) await createAgentSession()
    const data = await get(`/api/agent/sessions/${encodeURIComponent(agentSessionId.value)}`)
    agentMessages.value = (data.messages || []).map(historyMessage).filter(Boolean)
    agentChat.clearError()
    scrollAgentToBottom({ instant: true })
  } catch (error) {
    if (error.status === 404) {
      try {
        await createAgentSession()
        agentMessages.value = []
        return
      } catch (createError) {
        agentError.value = createError.message || '新会话创建失败。'
        return
      }
    }
    agentError.value = error.message || '历史会话加载失败。'
  }
}

async function switchAgentSession(event) {
  const sessionId = String(event.detail?.sessionId || '')
  if (!sessionId.startsWith('web:') || sessionId === agentSessionId.value || agentSending.value) return
  await discardAgentExcel()
  window.localStorage.setItem('meimei_agent_web_session_id', sessionId)
  agentSessionId.value = sessionId
  agentMessages.value = []
  agentTraceOpenStates.value = {}
  agentChat.clearError()
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
    <ConfirmDialog />
    <div v-if="accessBlocked" class="access-scrim access-blocked-scrim">
      <section class="access-blocked-card" role="alertdialog" aria-modal="true" aria-labelledby="access-blocked-title">
        <div class="access-blocked-icon"><component :is="renderIcon('ShieldAlert')" :size="24" /></div>
        <div id="access-blocked-title" class="access-title">需要重新配对</div>
        <p>{{ accessError }}</p>
        <div class="access-warning">请回到运行工作台的电脑，点击右上角“手机访问”，再用这台设备扫描新二维码。</div>
        <button class="btn btn-primary" type="button" @click="loadAccessInfo">重新检查</button>
      </section>
    </div>
    <transition name="access-scrim">
      <div v-if="accessOpen" class="access-scrim" @click.self="closeAccessDialog">
        <transition name="access-dialog" appear>
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
        </transition>
      </div>
    </transition>
    <div class="agent-float" :class="{ 'is-open': agentOpen }">
      <transition name="agent-panel" @after-enter="handleAgentPanelEntered">
        <section v-show="agentOpen" class="agent-chat-panel" role="dialog" aria-modal="false" aria-labelledby="agent-chat-title" @keydown="handleAgentDialogKeydown">
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
          <div v-for="message in agentMessages" :key="message.id" class="agent-message" :class="message.role">
            <template v-for="(part, partIndex) in message.parts" :key="`${message.id}-${partIndex}`">
              <details v-if="message.role === 'assistant' && partIndex === 0 && agentTraceSteps(message).length" class="agent-trace-card" :open="agentTraceOpen(message)" @toggle="handleAgentTraceToggle(message, $event)">
                <summary>
                  <span class="agent-trace-mark">✦</span>
                  <span class="agent-trace-title">执行过程</span>
                  <span class="agent-trace-status" :class="agentTraceStatus(message)">{{ agentTraceStatusText(message) }}</span>
                </summary>
                <div v-if="message.parts.find(item => item.type === 'data-agent-plan')?.data?.goal" class="agent-trace-goal">
                  {{ message.parts.find(item => item.type === 'data-agent-plan')?.data?.goal }}
                </div>
                <div class="agent-trace-steps">
                  <div v-for="step in agentTraceSteps(message)" :key="step.id" class="agent-trace-step" :class="agentTraceStepStatus(step)">
                    <span class="agent-trace-step-dot"></span>
                    <div class="agent-trace-step-main">
                      <div class="agent-trace-step-head">
                        <span class="agent-trace-step-label">{{ step.label }}</span>
                        <span class="agent-trace-step-status">{{ agentTraceStepStatusText(step) }}</span>
                      </div>
                      <div v-if="agentTraceStepDetail(step)" class="agent-trace-step-detail">{{ agentTraceStepDetail(step) }}</div>
                      <div v-if="step.toolPart && isPendingAgentAction(step.toolPart)" class="agent-action-buttons">
                        <template v-if="agentActionState(step.toolPart).status === 'pending'">
                          <button class="btn btn-primary btn-sm" type="button" @click="confirmAgentAction(step.toolPart)">确认写入</button>
                          <button class="btn btn-outline btn-sm" type="button" @click="cancelAgentAction(step.toolPart)">取消</button>
                        </template>
                        <span v-else-if="agentActionState(step.toolPart).status === 'confirming'" class="agent-action-state">处理中…</span>
                        <span v-else-if="agentActionState(step.toolPart).status === 'executed'" class="agent-action-state success">已写入并完成校验</span>
                        <span v-else-if="agentActionState(step.toolPart).status === 'cancelled'" class="agent-action-state">已取消，未修改数据</span>
                        <span v-else class="agent-action-state error">{{ agentActionState(step.toolPart).error }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </details>
              <template v-if="part.type === 'text'">
                <div v-if="message.role === 'assistant' && (part.state !== 'streaming' || agentStatus === 'ready')" class="agent-message-bubble agent-markdown" v-html="renderAgentMarkdown(part.text)"></div>
                <div v-else-if="message.role === 'assistant'" class="agent-message-bubble agent-streaming-text">{{ part.text }}</div>
                <div v-else class="agent-message-bubble">{{ part.text }}</div>
              </template>
            </template>
          </div>
          <div v-if="agentSending" class="agent-message assistant">
            <div class="agent-message-bubble agent-thinking"><span></span><span></span><span></span></div>
          </div>
          <div v-if="agentError" class="agent-chat-error">{{ agentError }}</div>
        </div>
        <footer class="agent-chat-foot">
          <div class="agent-composer">
            <input ref="agentExcelInput" class="agent-excel-input" type="file" accept=".xlsx" @change="handleAgentExcelFile" />
            <div v-if="agentExcel.step !== 'idle'" class="agent-excel-card">
              <div class="agent-excel-card-head">
                <div class="agent-excel-file"><FileSpreadsheet :size="16" /><strong>{{ agentExcel.analysis?.filename || 'Excel 文件' }}</strong></div>
                <button class="agent-excel-remove" type="button" aria-label="移除 Excel 文件" :disabled="agentExcel.busy" @click="discardAgentExcel">×</button>
              </div>
              <div v-if="agentExcel.step === 'uploading'" class="agent-excel-loading">正在读取工作表和字段…</div>
              <template v-else-if="agentExcel.analysis && agentExcel.step === 'analyzed'">
                <div class="agent-excel-summary">{{ formatAgentFileSize(agentExcel.analysis.size_bytes) }} · {{ agentExcel.analysis.sheets?.join('、') || '未识别工作表' }}</div>
                <div v-if="agentExcel.analysis.candidate_modules?.length" class="agent-excel-options">
                  <label v-for="candidate in agentExcel.analysis.candidate_modules" :key="candidate.module" class="agent-excel-option" :class="{ selected: agentExcel.module === candidate.module }">
                    <input v-model="agentExcel.module" type="radio" :value="candidate.module" :disabled="agentExcel.busy" />
                    <span><strong>{{ agentExcelModuleName(candidate.module) }}</strong><small>{{ candidate.reason }}</small></span>
                  </label>
                </div>
                <div v-else class="agent-excel-empty">未自动识别模块，请确认文件首行是否为字段名。</div>
                <div class="agent-excel-controls">
                  <select v-if="agentExcel.analysis.sheets?.length > 1" v-model="agentExcel.sheetIndex" :disabled="agentExcel.busy" aria-label="工作表">
                    <option v-for="(sheet, index) in agentExcel.analysis.sheets" :key="index" :value="index">{{ sheet }}</option>
                  </select>
                  <select v-model="agentExcel.duplicateStrategy" :disabled="agentExcel.busy" aria-label="重复记录策略">
                    <option value="update">重复记录：更新</option>
                    <option value="skip">重复记录：跳过</option>
                  </select>
                  <button class="btn btn-primary btn-sm" type="button" :disabled="!agentExcel.module || agentExcel.busy" @click="previewAgentExcel">{{ agentExcel.busy ? '处理中…' : '预览' }}</button>
                </div>
              </template>
              <template v-else-if="agentExcel.preview && agentExcel.step === 'preview'">
                <div class="agent-excel-summary">{{ agentExcelModuleName(agentExcel.module) }} · 预览结果</div>
                <div class="agent-excel-counts">
                  <span>总行 {{ agentExcel.preview.total_rows }}</span><span>有效 {{ agentExcel.preview.valid_rows }}</span><span>新增 {{ agentExcel.preview.new_count }}</span><span>更新 {{ agentExcel.preview.update_count }}</span><span>错误 {{ agentExcel.preview.error_rows }}</span>
                </div>
                <div v-if="agentExcel.preview.error_rows > 0" class="agent-excel-warning">存在错误行，请先检查预览结果再确认。</div>
                <div class="agent-excel-controls">
                  <button class="btn btn-primary btn-sm" type="button" :disabled="agentExcel.busy" @click="executeAgentExcel">{{ agentExcel.busy ? '导入中…' : '确认导入' }}</button>
                  <button class="btn btn-outline btn-sm" type="button" :disabled="agentExcel.busy" @click="backToAgentExcelAnalysis">返回修改</button>
                </div>
              </template>
              <template v-else-if="agentExcel.result && agentExcel.step === 'result'">
                <div class="agent-excel-success">导入完成：新增 {{ agentExcel.result.imported }}，更新 {{ agentExcel.result.updated }}，跳过 {{ agentExcel.result.skipped }}，错误 {{ agentExcel.result.error_count }}。</div>
                <div class="agent-excel-controls"><button class="btn btn-outline btn-sm" type="button" @click="resetAgentExcelState">继续上传</button></div>
              </template>
              <div v-if="agentExcel.error" class="agent-excel-error">{{ agentExcel.error }}</div>
            </div>
            <textarea ref="agentInputEl" v-model="agentInput" rows="2" maxlength="2000" placeholder="给凯凯小兵发送消息…" :disabled="agentSending" @keydown="handleAgentKeydown"></textarea>
            <div class="agent-composer-bottom">
              <div class="agent-composer-meta"><button class="agent-attach-button" type="button" :disabled="agentSending || agentExcel.busy" @click="triggerAgentExcelUpload"><Paperclip :size="14" /> 添加 Excel</button><span class="agent-status-dot"></span>工作台数据已连接</div>
              <button class="agent-send-button" type="button" aria-label="发送消息" :disabled="(!agentInput.trim() && !agentExcel.fileId) || agentSending" @click="sendAgentMessage">
                <Send :size="16" :stroke-width="2.2" />
              </button>
            </div>
          </div>
          <div class="agent-chat-hint">Enter 发送 · Shift + Enter 换行</div>
        </footer>
        </section>
      </transition>
      <button v-if="!agentOpen" ref="agentFabEl" class="agent-fab" type="button" aria-label="打开凯凯小兵对话" @click="openAgentChat">
        <MessageCircle :size="19" :stroke-width="2.2" />
        <span>凯凯小兵</span>
      </button>
    </div>
    <div class="app-body">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="sidebar-brand">
            <img class="brand-logo" src="/logo.svg" alt="" aria-hidden="true" />
            <div class="sidebar-brand-copy">
              <h2>{{ activeNav.title }}</h2>
              <div class="sub">{{ activeNav.school }}</div>
            </div>
          </div>
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
  transition: opacity var(--ds-duration-fast) var(--ds-ease-standard);
}

.page-leave-active {
  transition: opacity var(--ds-duration-fast) var(--ds-ease-standard);
}

.page-enter-from {
  opacity: 0;
}

.page-leave-to {
  opacity: 0;
}

.agent-panel-enter-active,
.agent-panel-leave-active {
  transform-origin: right bottom;
  transition: opacity var(--ds-duration-standard) var(--ds-ease-standard),
    transform var(--ds-duration-standard) var(--ds-ease-out),
    filter var(--ds-duration-standard) var(--ds-ease-standard);
  will-change: opacity, transform;
}

.agent-panel-enter-from,
.agent-panel-leave-to {
  opacity: 0;
  filter: blur(2px);
  transform: translateY(8px) scale(.97);
}

.runtime-date-badge { align-self: center; padding: 4px 8px; border: 1px solid var(--ds-color-primary-border); border-radius: var(--ds-radius-pill); background: var(--ds-color-primary-soft); color: var(--ds-color-primary-hover); font: var(--ds-type-meta); white-space: nowrap; }
.global-search { position: relative; align-self: center; min-width: 0; margin-left: auto; width: min(300px, 32vw); }
.global-search input { width: 100%; height: 38px; box-sizing: border-box; border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-pill); background: rgba(255,255,255,.84); padding: 0 34px 0 14px; color: var(--ds-color-ink); font: var(--ds-type-body); outline: none; transition: border-color var(--ds-duration-fast) var(--ds-ease-out), box-shadow var(--ds-duration-fast) var(--ds-ease-out); }
.global-search input:focus { border-color: var(--ds-color-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ds-color-primary) 16%, transparent); }
.search-clear { position: absolute; right: 10px; top: 6px; border: 0; background: transparent; color: var(--text-secondary); font-size: 18px; cursor: pointer; }
.search-popover { position: absolute; z-index: 20; top: calc(100% + 8px); left: 0; right: 0; max-height: 360px; overflow: auto; padding: 7px; background: rgba(255,255,255,.98); border-radius: var(--ds-radius-card); box-shadow: var(--ds-shadow-raised); }
.search-result { width: 100%; display: flex; gap: 9px; align-items: flex-start; padding: 10px; border: 0; border-radius: 10px; background: transparent; text-align: left; cursor: pointer; color: var(--text); }
.search-result:hover { background: var(--ds-color-surface-subtle); }
.search-result span:last-child { min-width: 0; display: grid; gap: 3px; }
.search-result small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ds-color-ink-secondary); }
.search-kind { flex: 0 0 auto; padding: 3px 6px; border-radius: var(--ds-radius-sm); background: var(--ds-color-primary-soft); color: var(--ds-color-primary-hover); font: var(--ds-type-meta); }
.search-empty { padding: 18px 10px; text-align: center; color: var(--ds-color-ink-secondary); font: var(--ds-type-body); }

.access-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  margin: 7px 0 7px 10px;
  padding: 0 12px;
  min-height: 36px;
  border: 1px solid var(--ds-color-success-border);
  border-radius: var(--ds-radius-pill);
  background: var(--ds-color-success-soft);
  color: var(--ds-color-success);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: transform var(--ds-duration-fast) var(--ds-ease-out), background var(--ds-duration-fast) var(--ds-ease-out);
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
  min-height: 36px;
  border: 1px solid var(--ds-color-border);
  border-radius: var(--ds-radius-pill);
  background: rgba(255,255,255,.78);
  color: var(--ds-color-ink-secondary);
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
  min-height: 36px;
  border: 1px solid var(--ds-color-primary-border);
  border-radius: var(--ds-radius-pill);
  background: var(--ds-color-primary-soft);
  color: var(--ds-color-primary-hover);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: transform var(--ds-duration-fast) var(--ds-ease-out), background var(--ds-duration-fast) var(--ds-ease-out);
  touch-action: manipulation;
}
.ai-settings-button:hover { background: color-mix(in srgb, var(--ds-color-primary-soft) 72%, var(--ds-color-primary-border)); }
.ai-settings-button:active { transform: scale(.97); }
.update-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  margin: 7px 0 7px 8px;
  padding: 0 10px;
  min-height: 36px;
  border: 1px solid var(--ds-color-border);
  border-radius: var(--ds-radius-pill);
  background: rgba(255,255,255,.78);
  color: var(--ds-color-ink-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: transform var(--ds-duration-fast) var(--ds-ease-out), color var(--ds-duration-fast) var(--ds-ease-out), background var(--ds-duration-fast) var(--ds-ease-out);
  touch-action: manipulation;
}
.update-button:hover { color: var(--ds-color-primary-hover); background: var(--ds-color-primary-soft); }
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
.access-scrim-enter-active,
.access-scrim-leave-active {
  transition: opacity var(--ds-duration-fast) var(--ds-ease-out);
}
.access-scrim-enter-from,
.access-scrim-leave-to { opacity: 0; }
.access-dialog {
  width: min(360px, 100%);
  padding: 22px;
  border-radius: var(--ds-radius-dialog);
  background: rgba(255,255,255,.97);
  box-shadow: var(--ds-shadow-overlay);
}
.access-dialog-enter-active,
.access-dialog-leave-active {
  transition: opacity var(--ds-duration-standard) var(--ds-ease-out),
    transform var(--ds-duration-standard) var(--ds-ease-out),
    filter var(--ds-duration-standard) var(--ds-ease-standard);
}
.access-dialog-enter-from,
.access-dialog-leave-to {
  opacity: 0;
  filter: blur(2px);
  transform: translateY(6px) scale(.96);
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
.access-url-label { margin-bottom: 5px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.access-url { padding: 10px 12px; border-radius: 10px; background: var(--bg); color: var(--text); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; user-select: text; }
.access-copy { width: 100%; justify-content: center; margin-top: 12px; }
.access-warning { margin-top: 12px; color: var(--ds-color-ink-muted); font: var(--ds-type-meta); text-align: center; }
.access-error { margin-top: 10px; color: var(--danger); font-size: 12px; text-align: center; }
.access-device-head { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); font-size: 12px; }
.access-device-head button, .access-device-row > button { border: 0; background: transparent; color: var(--ds-color-danger); font: var(--ds-type-label); cursor: pointer; }
.access-devices { max-height: 150px; overflow-y: auto; }
.access-device-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border); text-align: left; }
.access-device-row > div { min-width: 0; display: grid; gap: 2px; }
.access-device-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.access-device-row span, .access-device-empty { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.access-device-empty { padding: 12px 0 2px; text-align: center; }
.agent-float { position: fixed; right: 20px; bottom: 20px; z-index: 400; }
.agent-fab { display: inline-flex; align-items: center; gap: 8px; height: 46px; padding: 0 17px; border: 1px solid rgba(255,255,255,.7); border-radius: var(--ds-radius-pill); background: var(--ds-color-primary); color: #fff; box-shadow: 0 12px 28px rgba(75, 87, 162, .24); font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; transition: transform var(--ds-duration-fast) var(--ds-ease-out), box-shadow var(--ds-duration-fast) var(--ds-ease-out); touch-action: manipulation; }
.agent-fab:active { transform: scale(.97); }
@media (hover: hover) and (pointer: fine) {
  .agent-fab:hover { transform: translateY(-1px); box-shadow: 0 16px 34px rgba(75, 87, 162, .28); }
}
.agent-chat-panel { display: flex; flex-direction: column; width: min(420px, calc(100vw - 32px)); height: min(640px, calc(100vh - 40px)); overflow: hidden; border-radius: var(--ds-radius-dialog); background: rgba(255,255,255,.98); box-shadow: var(--ds-shadow-overlay); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
.agent-chat-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 16px; border-bottom: 1px solid var(--border); background: linear-gradient(135deg, rgba(91,106,191,.11), rgba(255,255,255,.66)); }
.agent-chat-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
.agent-chat-title { color: var(--text); font-size: 14px; font-weight: 700; }
.agent-chat-subtitle { display: flex; align-items: center; gap: 5px; margin-top: 3px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.agent-status-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #43b866; box-shadow: 0 0 0 3px rgba(67,184,102,.12); }
.agent-chat-actions { display: flex; gap: 4px; }
.agent-icon-button { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 9px; background: transparent; color: var(--text-secondary); cursor: pointer; touch-action: manipulation; }
.agent-icon-button:hover { background: var(--primary-bg); color: var(--primary); }
.agent-icon-button:active { transform: scale(.94); }
.agent-chat-body { flex: 1; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 24px 20px; background: var(--ds-color-surface-subtle); scroll-behavior: smooth; }
.agent-chat-welcome { display: grid; justify-items: center; gap: 8px; margin: 58px 8px 30px; color: var(--text-secondary); text-align: center; font-size: 12px; line-height: 1.5; }
.agent-chat-welcome span { max-width: 260px; }
.agent-welcome-title { color: var(--text); font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
.agent-suggestion-list { display: grid; width: min(300px, 100%); gap: 7px; margin-top: 13px; }
.agent-suggestion { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; padding: 9px 11px; border: 1px solid var(--border); border-radius: 11px; background: rgba(255,255,255,.78); color: var(--text-secondary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; transition: border-color var(--ds-duration-fast) var(--ds-ease-out), background var(--ds-duration-fast) var(--ds-ease-out), color var(--ds-duration-fast) var(--ds-ease-out), transform var(--ds-duration-fast) var(--ds-ease-out); }
.agent-suggestion:hover { border-color: rgba(91,106,191,.36); background: var(--primary-bg); color: var(--primary); }
.agent-suggestion:active { transform: scale(.98); }
.agent-message { display: flex; align-items: flex-end; gap: 7px; width: 100%; max-width: 100%; min-width: 0; margin: 9px 0; box-sizing: border-box; }
.agent-message.assistant { display: block; }
.agent-message.user { justify-content: flex-end; }
.agent-message.plan { display: block; margin: 7px 0 10px; }
.agent-message-bubble { min-width: 0; max-width: 100%; box-sizing: border-box; padding: 8px 0; border-radius: 15px; background: transparent; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.62; }
.agent-message.assistant .agent-message-bubble { width: min(86%, 320px); }
.agent-message.user .agent-message-bubble { width: fit-content; max-width: min(78%, 290px); padding: 10px 12px; border-radius: 15px 15px 5px 15px; background: var(--primary-bg); color: var(--text); box-shadow: 0 2px 8px rgba(40, 48, 85, .06); }
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
.agent-markdown pre code { padding: 0; background: transparent; color: var(--text); font-size: 12px; white-space: pre; }
.agent-markdown blockquote { margin: 9px 0; padding: 2px 0 2px 11px; border-left: 3px solid rgba(91,106,191,.4); color: var(--text-secondary); }
.agent-markdown a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
.agent-markdown hr { margin: 12px 0; border: 0; border-top: 1px solid var(--border); }
.agent-markdown { min-width: 0; max-width: 100%; }
.agent-markdown table { width: 100%; min-width: 0; max-width: 100%; margin: 9px 0; table-layout: fixed; border-collapse: collapse; font-size: 12px; }
.agent-markdown th, .agent-markdown td { padding: 6px 8px; border: 1px solid var(--border); text-align: left; white-space: normal; overflow-wrap: anywhere; word-break: break-word; vertical-align: top; }
.agent-markdown th { background: var(--primary-bg); color: var(--text); font-weight: 650; }
.agent-streaming-text { white-space: pre-wrap; }
.agent-trace-card { width: min(92%, 350px); box-sizing: border-box; margin: 5px 0 9px; padding: 9px 11px; border: 1px solid rgba(91,106,191,.16); border-radius: 12px; background: rgba(248,249,253,.94); color: var(--text-secondary); box-shadow: 0 2px 8px rgba(40,48,85,.04); }
.agent-trace-card[open] { background: rgba(248,249,253,.98); }
.agent-trace-card summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; font: var(--ds-type-meta); }
.agent-trace-card summary::-webkit-details-marker { display: none; }
.agent-trace-mark { color: var(--primary); font-size: 13px; }
.agent-trace-title { color: var(--text); font-weight: 700; }
.agent-trace-status { margin-left: auto; color: var(--ds-color-ink-muted); font: var(--ds-type-meta); }
.agent-trace-status.running { color: var(--primary); }
.agent-trace-status.waiting { color: #a56a12; }
.agent-trace-status.error { color: var(--danger, #c83b32); }
.agent-trace-status.completed { color: var(--success); }
.agent-trace-goal { margin-top: 7px; padding: 6px 8px; border-radius: 8px; background: rgba(91,106,191,.07); color: var(--text-secondary); font: var(--ds-type-meta); overflow-wrap: anywhere; }
.agent-trace-steps { display: grid; gap: 7px; margin-top: 9px; padding-left: 3px; }
.agent-trace-step { display: grid; grid-template-columns: 8px minmax(0,1fr); align-items: start; gap: 8px; min-width: 0; }
.agent-trace-step-dot { width: 7px; height: 7px; margin-top: 4px; border-radius: 50%; background: var(--text-tertiary); }
.agent-trace-step.running .agent-trace-step-dot { background: var(--primary); box-shadow: 0 0 0 3px rgba(91,106,191,.13); }
.agent-trace-step.completed .agent-trace-step-dot { background: var(--success); }
.agent-trace-step.waiting .agent-trace-step-dot { background: #d89222; box-shadow: 0 0 0 3px rgba(216,146,34,.13); }
.agent-trace-step.error .agent-trace-step-dot { background: var(--danger, #c83b32); }
.agent-trace-step-main { min-width: 0; }
.agent-trace-step-head { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.agent-trace-step-label { min-width: 0; color: var(--text); font: var(--ds-type-meta); font-weight: 650; overflow-wrap: anywhere; }
.agent-trace-step-status { margin-left: auto; flex: 0 0 auto; color: var(--ds-color-ink-muted); font: var(--ds-type-meta); }
.agent-trace-step.completed .agent-trace-step-status { color: var(--success); }
.agent-trace-step.waiting .agent-trace-step-status { color: #a56a12; }
.agent-trace-step.error .agent-trace-step-status { color: var(--danger, #c83b32); }
.agent-trace-step-detail { margin-top: 3px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); line-height: 1.45; overflow-wrap: anywhere; }
.agent-plan-card { max-width: min(92%, 350px); padding: 9px 11px; border: 1px solid rgba(91,106,191,.14); border-radius: 12px; background: rgba(248,249,253,.9); color: var(--text-secondary); box-shadow: 0 2px 8px rgba(40,48,85,.04); }
.agent-plan-card summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; font: var(--ds-type-meta); }
.agent-plan-card summary::-webkit-details-marker { display: none; }
.agent-plan-mark { color: var(--primary); font-size: 13px; }
.agent-plan-title { color: var(--text); font-weight: 700; }
.agent-plan-goal { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-plan-steps { display: grid; gap: 5px; margin-top: 8px; padding-left: 2px; }
.agent-plan-step { display: grid; grid-template-columns: 7px minmax(0,1fr) auto; align-items: center; gap: 7px; font: var(--ds-type-meta); }
.agent-plan-step-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-tertiary); }
.agent-plan-step.running .agent-plan-step-dot { background: var(--primary); box-shadow: 0 0 0 3px rgba(91,106,191,.12); }
.agent-plan-step.completed .agent-plan-step-dot { background: var(--success); }
.agent-plan-step.error .agent-plan-step-dot { background: var(--danger, #c83b32); }
.agent-plan-step-label { color: var(--text); }
.agent-plan-step-status { color: var(--ds-color-ink-muted); font: var(--ds-type-meta); }
.agent-plan-step.completed .agent-plan-step-status { color: var(--success); }
.agent-plan-step.error .agent-plan-step-status { color: var(--danger, #c83b32); }
.agent-tool-card { max-width: min(92%, 350px); margin: 5px 0; padding: 7px 10px; border: 1px solid rgba(67,184,102,.18); border-radius: 11px; background: rgba(247,252,248,.9); color: var(--text-secondary); }
.agent-tool-card summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; font: var(--ds-type-meta); }
.agent-tool-card summary::-webkit-details-marker { display: none; }
.agent-tool-mark { color: var(--success); font-size: 13px; }
.agent-tool-name { color: var(--text); font-weight: 650; }
.agent-tool-status { margin-left: auto; color: var(--success); font: var(--ds-type-meta); }
.agent-tool-meta { margin-top: 7px; color: var(--ds-color-ink-muted); font: var(--ds-type-meta); }
.agent-tool-output { margin-top: 7px; color: var(--text-secondary); font: var(--ds-type-meta); }
.agent-tool-output pre { max-height: 180px; margin: 7px 0 0; padding: 8px; overflow: auto; border-radius: 8px; background: rgba(255,255,255,.8); color: var(--text); font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.agent-action-buttons { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 9px; }
.agent-action-buttons .btn { min-height: 30px; padding: 5px 10px; font-size: 12px; }
.agent-action-state { color: var(--ds-color-ink-secondary); }
.agent-action-state.success { color: var(--success); }
.agent-action-state.error { color: var(--danger, #c83b32); }
.agent-thinking { display: inline-flex; align-items: center; gap: 4px; padding: 12px 14px; }
.agent-thinking span { width: 5px; height: 5px; border-radius: 50%; background: var(--text-tertiary); animation: agent-thinking-bounce 1s infinite ease-in-out; }
.agent-thinking span:nth-child(2) { animation-delay: .12s; }
.agent-thinking span:nth-child(3) { animation-delay: .24s; }
.agent-chat-error { margin: 12px 2px 0; padding: 8px 10px; border-radius: var(--ds-radius-control); background: var(--ds-color-danger-soft); color: var(--ds-color-danger); font: var(--ds-type-meta); }
.agent-chat-foot { padding: 10px 14px 13px; border-top: 1px solid var(--border); background: rgba(255,255,255,.9); }
.agent-composer { padding: 7px 9px 8px 12px; border: 1px solid rgba(126,137,194,.35); border-radius: 16px; background: #fff; box-shadow: 0 3px 12px rgba(40, 48, 85, .06); }
.agent-excel-input { display: none; }
.agent-excel-card { margin: 0 0 8px; padding: 9px 10px; border: 1px solid rgba(91,106,191,.18); border-radius: 11px; background: rgba(248,249,253,.9); font-size: 12px; }
.agent-excel-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.agent-excel-file { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--primary); }
.agent-excel-file strong { overflow: hidden; color: var(--text); text-overflow: ellipsis; white-space: nowrap; }
.agent-excel-remove { flex: 0 0 auto; width: 22px; height: 22px; border: 0; border-radius: 7px; background: transparent; color: var(--text-tertiary); font-size: 17px; line-height: 1; cursor: pointer; }
.agent-excel-remove:hover { background: var(--primary-bg); color: var(--primary); }
.agent-excel-summary, .agent-excel-loading, .agent-excel-empty { margin-top: 6px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.agent-excel-options { display: grid; gap: 5px; margin-top: 8px; }
.agent-excel-option { display: flex; align-items: flex-start; gap: 7px; padding: 6px 7px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
.agent-excel-option.selected { border-color: rgba(91,106,191,.4); background: var(--primary-bg); }
.agent-excel-option input { margin-top: 2px; accent-color: var(--primary); }
.agent-excel-option span { display: grid; gap: 2px; min-width: 0; }
.agent-excel-option small { color: var(--ds-color-ink-secondary); overflow-wrap: anywhere; }
.agent-excel-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.agent-excel-controls select { min-width: 0; max-width: 142px; padding: 5px 7px; border: 1px solid var(--border); border-radius: 7px; background: #fff; color: var(--text-secondary); font: inherit; font-size: 11px; }
.agent-excel-counts { display: flex; flex-wrap: wrap; gap: 5px 9px; margin-top: 8px; color: var(--text-secondary); font-size: 11px; }
.agent-excel-warning, .agent-excel-error { margin-top: 7px; color: var(--danger, #c83b32); font-size: 11px; line-height: 1.4; }
.agent-excel-success { margin-top: 7px; color: var(--success); font-size: 12px; line-height: 1.45; }
.agent-attach-button { display: inline-flex; align-items: center; gap: 4px; padding: 3px 5px; border: 0; border-radius: 6px; background: transparent; color: var(--ds-color-ink-secondary); font: inherit; font-size: 11px; cursor: pointer; }
.agent-attach-button:hover { background: var(--primary-bg); color: var(--primary); }
.agent-attach-button:disabled { opacity: .5; cursor: default; }
.agent-chat-foot textarea { display: block; width: 100%; box-sizing: border-box; min-height: 48px; resize: none; padding: 3px 2px 8px; border: 0; outline: none; background: transparent; color: var(--text); font: inherit; font-size: 13px; line-height: 1.5; }
.agent-chat-foot textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(91,106,191,.12); }
.agent-chat-foot textarea:focus-visible { outline: none !important; outline-offset: 0; }
.agent-chat-foot textarea:disabled { opacity: .7; }
.agent-chat-foot textarea:focus { box-shadow: none; }
.agent-composer-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.agent-composer-meta { display: flex; align-items: center; gap: 7px; color: var(--ds-color-ink-muted); font: var(--ds-type-meta); }
.agent-send-button { display: grid; place-items: center; flex: 0 0 auto; width: 32px; height: 32px; border: 0; border-radius: 10px; background: var(--primary); color: #fff; cursor: pointer; transition: transform var(--ds-duration-fast) var(--ds-ease-out), opacity var(--ds-duration-fast) var(--ds-ease-out); touch-action: manipulation; }
.agent-send-button:disabled { opacity: .38; cursor: default; }
.agent-send-button:not(:disabled):active { transform: scale(.93); }
.agent-chat-hint { margin: 7px 2px 0; color: var(--ds-color-ink-muted); font: var(--ds-type-meta); }
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
  .agent-float { right: 12px; bottom: calc(72px + env(safe-area-inset-bottom)); }
  .agent-float.is-open { right: 0; bottom: 0; width: 100%; }
  .agent-chat-panel { width: 100%; height: min(680px, calc(100vh - 12px)); border-radius: 20px 20px 0 0; }
  .agent-chat-foot { padding-bottom: calc(13px + env(safe-area-inset-bottom)); }
}

@media (prefers-reduced-motion: reduce) {
  .page-enter-active,
  .page-leave-active {
    transition: opacity 160ms var(--ds-ease-standard) !important;
    transform: none !important;
  }
  .agent-panel-enter-active,
  .agent-panel-leave-active { transition: opacity 160ms var(--ds-ease-standard) !important; }
  .agent-panel-enter-from,
  .agent-panel-leave-to { filter: none; transform: none !important; }
  .access-scrim-enter-active,
  .access-scrim-leave-active,
  .access-dialog-enter-active,
  .access-dialog-leave-active { transition: opacity 160ms var(--ds-ease-standard) !important; }
  .access-dialog-enter-from,
  .access-dialog-leave-to { filter: none; transform: none !important; }
  .agent-thinking span { animation: none; }
}

@media (prefers-reduced-transparency: reduce) {
  .access-scrim { background: rgba(20, 24, 38, .42); backdrop-filter: none; -webkit-backdrop-filter: none; }
  .access-dialog { background: #fff; }
  .agent-chat-panel, .agent-chat-head, .agent-chat-foot { background: #fff; backdrop-filter: none; -webkit-backdrop-filter: none; }
}
</style>
