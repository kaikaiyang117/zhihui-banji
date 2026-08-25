<script setup>
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { FileSpreadsheet, Maximize2, Minimize2, Paperclip, Send, Settings, Sparkles, SquarePen } from 'lucide-vue-next'
import { useChat } from '@ai-sdk/vue'
import { DefaultChatTransport } from 'ai'
import QRCode from 'qrcode'
import { DEFAULT_SCHOOL_NAME, NAV } from './sheets'
import { getIcon } from './icons'
import {
  clearDeviceCredential,
  discardExcelArtifact,
  del,
  fetchWithAccess,
  get,
  downloadExcelImportPlanErrors,
  post,
  uploadExcelArtifact,
} from './api'
import { renderAgentMarkdown } from './markdown'
import UpdateDialog from './components/UpdateDialog.vue'
import ContextSwitcher from './components/ContextSwitcher.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'

const route = useRoute()
const router = useRouter()
const mainEl = ref(null)
const activeNav = NAV[0]
const schoolName = ref(DEFAULT_SCHOOL_NAME)
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
const contextVersion = ref(0)
const agentOpen = ref(false)
const agentExpanded = ref(false)
const agentScopeLabel = ref('当前班级 · 当前学期')
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
  artifactId: '',
  artifact: null,
})
const accessDialogEl = ref(null)
const accessCloseEl = ref(null)
const accessTriggerEl = ref(null)
let accessPreviousActiveEl = null
const agentSuggestions = [
  { text: '今天谁缺勤？', action: 'send' },
  { text: '查看本周待办', action: 'send' },
  { text: '上传 Excel 分析', action: 'upload' },
]
const agentCapabilities = [
  '查询班级数据',
  '分析学生情况',
  '处理 Excel 表格',
  '记录待办和家校沟通',
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
      const excelPart = (lastUserMessage?.parts || []).find(part =>
        part.type === 'file' && String(part.url || '').startsWith('artifact://'))
      const artifactId = excelPart ? String(excelPart.url).slice('artifact://'.length) : ''
      return {
        body: {
          session_id: agentSessionId.value,
          message: message.trim() || (artifactId
            ? '请先识别这份 Excel 的结构，并简要说明可以进行哪些操作。'
            : ''),
          attachment: artifactId
            ? {
                artifact_id: artifactId,
                filename: excelPart.filename || '',
                user_text_empty: !message.trim(),
              }
            : undefined,
        },
      }
    },
  }),
  onError: error => {
    petAgentHadError = true
    sendPetState('failed')
    agentError.value = friendlyAgentError(error.message || '这次没有完成，请稍后重试。')
    scrollAgentToBottom()
  },
})
const agentMessages = agentChat.messages
const displayedAgentMessages = computed(() => {
  const grouped = []
  for (const message of agentMessages.value) {
    const previous = grouped[grouped.length - 1]
    if (previous?.role === 'assistant' && message.role === 'assistant') {
      previous.parts = [...(previous.parts || []), ...(message.parts || [])]
      continue
    }
    grouped.push({ ...message, parts: [...(message.parts || [])] })
  }
  return grouped
})
const agentStatus = agentChat.status
const agentSending = computed(() => ['submitted', 'streaming'].includes(agentStatus.value))
let petAgentWasRunning = false
let petAgentHadError = false
let agentScrollFrame = 0
let agentBodyPinned = true

function sendPetState(state) {
  if (!window.workbenchDesktop?.sendPetState) return
  window.workbenchDesktop.sendPetState(state).catch(() => {})
}

watch(agentStatus, status => {
  if (status === 'submitted' || status === 'streaming') {
    if (!petAgentWasRunning) petAgentHadError = false
    petAgentWasRunning = true
    sendPetState('running')
  } else if (petAgentWasRunning) {
    petAgentWasRunning = false
    sendPetState(petAgentHadError || status === 'error' ? 'failed' : 'success')
  }
})

function queueAgentAutoScroll() {
  if (!agentBodyPinned || agentScrollFrame) return
  agentScrollFrame = window.requestAnimationFrame(() => {
    agentScrollFrame = 0
    scrollAgentToBottom({ instant: true, onlyIfPinned: true })
  })
}

watch([agentMessages, agentStatus], queueAgentAutoScroll, { deep: true, flush: 'post' })

async function createAgentSession() {
  const created = await post('/api/agent/sessions', {})
  const sessionId = String(created.session_id || '')
  if (!sessionId) throw new Error('服务器没有返回会话 ID')
  window.localStorage.setItem('meimei_agent_web_session_id', sessionId)
  agentSessionId.value = sessionId
  return sessionId
}

function itemTo(item) {
  return '/' + item.page
}
function isActive(item) {
  return route.path === '/' + item.page
}

watch(() => route.fullPath, async () => {
  await nextTick()
  if (mainEl.value) mainEl.value.scrollTop = 0
}, { flush: 'post' })

function handleContextChange(event) {
  contextVersion.value += 1
  const label = String(event.detail?.label || '').trim()
  if (label) agentScopeLabel.value = label
}

function handleContextReady(detail) {
  const label = String(detail?.label || '').trim()
  if (label) agentScopeLabel.value = label
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
  excel_inspect_workbook: '识别 Excel 工作簿',
  excel_list_regions: '识别数据区域',
  excel_suggest_import_plan: '推荐导入方案',
  excel_read_range: '读取 Excel 范围',
  excel_profile_region: '分析 Excel 区域',
  excel_query_region: '查询 Excel 数据',
  excel_create_import_plan: '创建导入计划',
  excel_update_import_plan: '更新导入计划',
  excel_preview_import: '预览 Excel 导入',
  execute_excel_import: '写入 Excel 导入',
}

const excelModuleLabels = {
  students: '学生信息',
  scores: '成绩记录',
  calendar: '校历安排',
  timetable: '课程表',
}

const excelDuplicateLabels = {
  update: '更新已有记录',
  skip: '跳过已有记录',
  merge: '合并已有安排',
  replace: '替换已有课程表',
  conflict: '遇到冲突时保留原记录',
}

function agentToolName(part) {
  const toolName = part.toolName || String(part.type || '').replace(/^tool-/, '')
  return agentToolLabels[toolName] || '执行工具'
}

function excelModuleName(module) {
  return excelModuleLabels[String(module || '')] || 'Excel 数据'
}

function excelDuplicateName(part) {
  const preview = excelPreviewModel(part)
  return excelDuplicateLabels[String(preview?.duplicateStrategy || '')] || '按系统规则处理重复记录'
}

function excelMappingStatusKey(mapping) {
  const status = String(mapping?.mapping_status || mapping?.status || '')
  if (status === 'needs_confirmation') return 'needs-confirmation'
  if (status === 'ignored' || !mapping?.target) return 'ignored'
  if (String(mapping?.source_kind || mapping?.source || '') === 'ai') return 'ai-suggestion'
  return 'confirmed'
}

function excelMappingStatus(mapping) {
  return ({
    'needs-confirmation': '需要确认',
    ignored: '已忽略',
    'ai-suggestion': 'AI 建议',
    confirmed: '已确认',
  })[excelMappingStatusKey(mapping)] || '已确认'
}

function excelMappingSymbol(mapping) {
  const status = String(mapping?.mapping_status || mapping?.status || '')
  if (status === 'needs_confirmation') return '?'
  if (status === 'ignored' || !mapping?.target) return '—'
  return '✓'
}

function agentToolOutputText(output) {
  if (output === undefined || output === null) return ''
  const businessPreview = output?.business_preview?.preview
  if (businessPreview && typeof businessPreview === 'object') {
    return `准备导入：新增 ${businessPreview.new_count ?? 0}，更新 ${businessPreview.update_count ?? 0}，跳过 ${businessPreview.skip_count ?? 0}，错误 ${businessPreview.error_rows ?? 0}`
  }
  if (output && typeof output === 'object' && output.confirmation_required) {
    return output.preview || '请确认是否写入。'
  }
  if (output && typeof output === 'object' && output.error?.message) return output.error.message
  const preview = output?.plan?.preview || output?.preview
  if (preview && typeof preview === 'object' && preview.module) {
    return `Excel 导入预览：新增 ${preview.new_count ?? 0}，更新 ${preview.update_count ?? 0}，跳过 ${preview.skip_count ?? 0}，错误 ${preview.error_rows ?? 0}`
  }
  if (Array.isArray(output)) return `返回 ${output.length} 条记录`
  if (typeof output === 'object') return `已返回 ${Object.keys(output).length} 项结果`
  return String(output)
}

function excelPreviewModel(part) {
  const output = part?.output
  const preview = output?.business_preview?.preview || output?.plan?.preview || output?.preview
  if (!preview || typeof preview !== 'object' || !preview.module) return null
  const mappings = Array.isArray(preview.field_mapping) ? preview.field_mapping : []
  return {
    module: preview.module,
    needsInput: preview.needs_input === true,
    needsInputMappings: Array.isArray(preview.needs_input_mappings) ? preview.needs_input_mappings : [],
    rows: preview.total_rows ?? 0,
    valid: preview.valid_rows ?? 0,
    added: preview.new_count ?? 0,
    updated: preview.update_count ?? 0,
    skipped: preview.skip_count ?? 0,
    errors: preview.error_rows ?? 0,
    mappings,
    duplicateStrategy: preview.duplicate_strategy || preview.options?.duplicateStrategy || '',
  }
}

function isExcelImportAction(part) {
  const toolName = String(part?.toolName || '')
  return toolName.startsWith('excel_') || toolName === 'execute_excel_import' || Boolean(part?.output?.business_preview)
}

function agentExcelPreviewPart(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const previews = parts.filter(part => isAgentToolPart(part) && excelPreviewModel(part))
  return previews[previews.length - 1] || null
}

function requestExcelMapping(part) {
  const preview = excelPreviewModel(part)
  const columns = preview?.needsInputMappings?.map(item => item.source).filter(Boolean) || []
  if (!columns.length) return
  agentInput.value = `请帮我补充字段映射：${columns.join('、')}。`
  nextTick(() => agentInputEl.value?.focus())
}

function excelImportButtonLabel(part) {
  const preview = excelPreviewModel(part)
  if (!preview) return '导入'
  const count = Number(preview.added) + Number(preview.updated)
  return count > 0 ? `导入 ${count} 条` : '导入'
}

function excelImportPlanId(part) {
  return String(part?.output?.business_preview?.plan_id || part?.output?.plan?.id || '').trim()
}

async function downloadExcelPlanErrors(part) {
  const planId = excelImportPlanId(part)
  if (!planId) return
  try {
    await downloadExcelImportPlanErrors(planId, agentSessionId.value)
  } catch (error) {
    agentError.value = error.message || '错误报告下载失败。'
  }
}

function hasAgentAction(part) {
  return Boolean(part?.output?.confirmation_required && part?.output?.action_id)
}

function isPendingAgentAction(part) {
  return hasAgentAction(part) && agentActionState(part).status === 'pending'
}

function agentActionStatus(part) {
  return hasAgentAction(part) ? agentActionState(part).status : ''
}

function agentActionScopeLabel(part) {
  const scope = part?.output?.target_scope || part?.output?.business_preview?.target_scope
  if (scope?.label) return String(scope.label)
  if (scope?.class_name || scope?.term_name) return `${scope.class_name || '当前班级'} · ${scope.term_name || '当前学期'}`
  return agentScopeLabel.value
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
  const toolParts = parts.filter(isAgentToolPart)
  const toolById = new Map(toolParts.map(part => [agentToolPartId(part), part]))
  const planStepsById = new Map()
  plans.forEach(plan => {
    const steps = Array.isArray(plan.data?.steps) ? plan.data.steps : []
    steps.forEach(step => {
      const id = String(step.id || `plan-step-${planStepsById.size}`)
      planStepsById.set(id, { ...(planStepsById.get(id) || {}), ...step })
    })
  })
  const planSteps = [...planStepsById.values()]
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
  if (toolPart && hasAgentAction(toolPart)) {
    const actionStatus = agentActionState(toolPart).status
    if (actionStatus === 'executed') return 'completed'
    if (actionStatus === 'cancelled') return 'skipped'
    if (actionStatus === 'error') return 'error'
    if (['pending', 'confirming'].includes(actionStatus)) return 'waiting'
  }
  if (toolPart?.state === 'output-available') return 'completed'
  return step.status || 'pending'
}

function agentTraceStepStatusText(step) {
  if (agentTraceStepStatus(step) === 'waiting' && isExcelImportAction(step.toolPart)) return '等待导入'
  return ({
    pending: '等待执行', running: '执行中', completed: '已完成', skipped: '已跳过',
    error: '失败', waiting: '等待确认',
  })[agentTraceStepStatus(step)] || '处理中'
}

function agentTraceStepDetail(step) {
  const toolPart = step.toolPart
  if (toolPart?.state === 'output-error') return friendlyAgentError(toolPart.errorText || '工具执行失败')
  if (toolPart?.state === 'output-available') return agentToolOutputText(toolPart.output)
  return step.message || ''
}

function friendlyAgentError(message) {
  const text = String(message || '').trim()
  if (!text) return '这一步没有完成，请重试。'
  if (/no tool invocation found|tool call id|invalid tool/i.test(text)) return '这一步没有完成，请重试。'
  if (/timeout|timed out|超时/i.test(text)) return '处理时间较长，暂时没有完成，请稍后重试。'
  return text
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
  const status = agentTraceStatus(message)
  if (status === 'running') {
    const active = agentTraceSteps(message).find(step => agentTraceStepStatus(step) === 'running')
    return active ? `正在${active.label}…` : '正在处理…'
  }
  if (status === 'waiting') return '等待你确认'
  return ({ error: '处理未完成', completed: '已完成检查' })[status]
}

function agentTraceOpen(message) {
  const messageId = String(message?.id || '')
  if (Object.prototype.hasOwnProperty.call(agentTraceOpenStates.value, messageId)) {
    return agentTraceOpenStates.value[messageId]
  }
  const status = agentTraceStatus(message)
  return status === 'running' || status === 'error'
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

function actionResultSummary(part) {
  const state = agentActionState(part)
  const raw = state.result
  const outcome = raw?.result && typeof raw.result === 'object' && raw.result.result
    ? raw.result : raw
  const result = outcome?.result && typeof outcome.result === 'object' ? outcome.result : outcome
  if (isExcelImportAction(part) && result && typeof result === 'object'
    && ['imported', 'updated', 'skipped', 'error_count'].some(key => key in result)) {
    return `导入完成：新增 ${result.imported ?? 0}，更新 ${result.updated ?? 0}，跳过 ${result.skipped ?? 0}，错误 ${result.error_count ?? 0}；写入校验已通过。`
  }
  return state.status === 'executed' ? `已确认写入：${agentToolName(part)}。写入校验已通过。` : ''
}

function agentActionParts(message) {
  return (message?.parts || []).filter(part => hasAgentAction(part) && !isExcelImportAction(part))
}

function agentActionCardTitle(part) {
  return agentToolName(part)
}

function agentActionCardStatus(part) {
  return ({
    pending: '待确认', confirming: '正在写入', executed: '已完成',
    cancelled: '已取消', error: '写入失败',
  })[agentActionStatus(part)] || '待处理'
}

function excelResultStatus(part) {
  const preview = excelPreviewModel(part)
  if (preview?.needsInput) return '需要补充'
  return ({
    pending: '待确认', confirming: '正在导入', executed: '已完成',
    cancelled: '已取消', error: '导入失败',
  })[agentActionStatus(part)] || '已检查'
}

function excelResultTitle(part) {
  const suffix = agentActionStatus(part) === 'executed' ? '导入完成' : '导入预览'
  return `${excelModuleName(excelPreviewModel(part).module)}${suffix}`
}

function excelResultConsequence(part) {
  const preview = excelPreviewModel(part)
  const verb = agentActionStatus(part) === 'executed' ? '已新增' : '将新增'
  return `${verb} ${preview.added} 条，${agentActionStatus(part) === 'executed' ? '已更新' : '更新'} ${preview.updated} 条。`
}

function actionHistoryMessage(action) {
  const actionId = String(action.action_id || '')
  if (!actionId) return null
  const output = {
    confirmation_required: true,
    action_id: Number(action.action_id),
    preview: action.preview || '',
    target_scope: action.target_scope || null,
    ...(action.business_preview ? { business_preview: action.business_preview } : {}),
  }
  return {
    id: `history-action-${actionId}`,
    role: 'assistant',
    parts: [{
      type: 'dynamic-tool', toolName: action.tool_name, toolCallId: `action-${actionId}`,
      state: 'output-available', output,
    }],
  }
}

function actionHistoryPart(action, toolCallId) {
  const message = actionHistoryMessage(action)
  if (!message) return null
  return { ...message.parts[0], toolCallId: toolCallId || message.parts[0].toolCallId }
}

function hydrateAgentActions(actions) {
  const states = {}
  for (const action of Array.isArray(actions) ? actions : []) {
    const actionId = String(action.action_id || '')
    if (!actionId) continue
    const status = String(action.status || '')
    states[actionId] = {
      status: status === 'executed' ? 'executed'
        : status === 'cancelled' ? 'cancelled'
          : ['failed', 'expired'].includes(status) ? 'error' : 'pending',
      error: status === 'expired' ? '确认已过期，请重新生成预览。' : '',
      result: action.result || null,
    }
  }
  agentActionStates.value = states
}

async function confirmAgentAction(part) {
  if (!isPendingAgentAction(part)) return
  const actionId = String(part.output.action_id)
  if (['confirming', 'executed', 'cancelled'].includes(agentActionState(part).status)) return
  setAgentActionState(actionId, { status: 'confirming', error: '' })
  try {
    const result = await post(`/api/agent/actions/${encodeURIComponent(actionId)}/confirm`, {
      session_id: agentSessionId.value,
    })
    setAgentActionState(actionId, { status: 'executed', error: '', result })
    scrollAgentToBottom()
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
    scrollAgentToBottom()
  } catch (error) {
    setAgentActionState(actionId, { status: 'error', error: error.message || '取消失败，请稍后重试。' })
  }
}

function historyMessage(item, index, actionByToolCallId = new Map()) {
  const role = item.role === 'user' || item.role === 'assistant' ? item.role : ''
  const contentValue = item.display_content === undefined ? item.content : item.display_content
  const content = typeof contentValue === 'string' ? contentValue : ''
  if (!role) return null
  const parts = []
  const attachment = item.attachment && typeof item.attachment === 'object' ? item.attachment : null
  if (role === 'user' && attachment?.artifact_id) {
    parts.push({
      type: 'file',
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: attachment.filename || 'Excel 文件',
      url: `artifact://${attachment.artifact_id}`,
    })
  }
  if (content.trim()) parts.push({ type: 'text', text: content, state: 'done' })
  if (role === 'assistant' && Array.isArray(item.tool_calls)) {
    item.tool_calls.forEach(call => {
      const callId = String(call?.id || '')
      const action = actionByToolCallId.get(callId)
      const part = action ? actionHistoryPart(action, callId) : null
      if (part) parts.push(part)
    })
  }
  if (!parts.length) return null
  return {
    id: `history-${index}`,
    role,
    parts,
  }
}

function handleAgentBodyScroll(event) {
  const body = event.currentTarget
  agentBodyPinned = body.scrollHeight - body.scrollTop - body.clientHeight <= 48
}

function scrollAgentToBottom(options = {}) {
  nextTick(() => {
    const body = agentBody.value
    if (!body) return
    if (options.onlyIfPinned && !agentBodyPinned) return
    const instant = options.instant ?? !agentOpen.value
    if (instant) {
      const previousScrollBehavior = body.style.scrollBehavior
      body.style.scrollBehavior = 'auto'
      body.scrollTop = body.scrollHeight
      body.style.scrollBehavior = previousScrollBehavior
      agentBodyPinned = true
      return
    }
    body.scrollTo({
      top: body.scrollHeight,
      behavior: 'smooth',
    })
    agentBodyPinned = true
  })
}

async function useAgentSuggestion(suggestion) {
  if (suggestion.action === 'upload') {
    triggerAgentExcelUpload()
    return
  }
  agentInput.value = suggestion.text
  await nextTick()
  sendAgentMessage()
}

function handleAgentInput() {
  const input = agentInputEl.value
  if (!input) return
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`
  input.style.overflowY = input.scrollHeight > 140 ? 'auto' : 'hidden'
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

function formatAgentFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function resetAgentExcelState() {
  agentExcel.value = {
    step: 'idle', busy: false, error: '', artifactId: '', artifact: null,
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
  if (agentExcel.value.artifactId) {
    try { await discardExcelArtifact(agentExcel.value.artifactId, agentSessionId.value) } catch { /* 上传新文件时忽略旧文件清理失败 */ }
  }
  if (!agentSessionId.value) await createAgentSession()
  agentExcel.value = { step: 'uploading', busy: true, error: '', artifact: null, artifactId: '' }
  try {
    const uploaded = await uploadExcelArtifact(file, agentSessionId.value)
    const artifact = uploaded.artifact
    agentExcel.value = {
      step: 'attached',
      busy: false,
      error: '',
      artifactId: artifact.id,
      artifact,
    }
    scrollAgentToBottom({ instant: true })
  } catch (error) {
    agentExcel.value = { step: 'idle', busy: false, artifactId: '', artifact: null, error: error.detail?.message || error.message || '文件上传失败' }
  }
}

async function discardAgentExcel() {
  const artifactId = agentExcel.value.artifactId
  if (artifactId) {
    try { await discardExcelArtifact(artifactId, agentSessionId.value) } catch { /* 文件过期时也允许清理界面 */ }
  }
  resetAgentExcelState()
}

async function sendAgentMessage() {
  const message = agentInput.value.trim()
  const artifact = agentExcel.value.artifact
  if ((!message && !artifact) || agentSending.value || agentExcel.value.busy) return
  agentInput.value = ''
  nextTick(handleAgentInput)
  agentError.value = ''
  try {
    if (!agentSessionId.value) await createAgentSession()
    const files = artifact ? [{
      type: 'file',
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: artifact.filename,
      url: `artifact://${artifact.id}`,
    }] : undefined
    const sending = message
      ? agentChat.sendMessage({ text: message, files })
      : agentChat.sendMessage({ files })
    resetAgentExcelState()
    await sending
  } catch (error) {
    if (artifact) {
      agentExcel.value = {
        step: 'attached', busy: false, error: '', artifactId: artifact.id, artifact,
      }
    }
    agentInput.value = message
    agentError.value = error.message || '发送失败，请稍后重试。'
    scrollAgentToBottom({ instant: true })
  }
}

async function retryLastAgentMessage() {
  if (agentSending.value) return
  const lastUser = [...agentMessages.value].reverse().find(message => message.role === 'user')
  if (!lastUser) return
  const text = (lastUser.parts || [])
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('')
    .trim()
  const file = (lastUser.parts || []).find(part => part.type === 'file' && String(part.url || '').startsWith('artifact://'))
  const files = file ? [{
    type: 'file', mediaType: file.mediaType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: file.filename || 'Excel 文件', url: file.url,
  }] : undefined
  agentError.value = ''
  try {
    await agentChat.sendMessage({ ...(text ? { text } : {}), ...(files ? { files } : {}) })
  } catch (error) {
    agentError.value = error.message || '重试失败，请稍后重试。'
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
    await createAgentSession()
    agentMessages.value = []
    agentActionStates.value = {}
    agentTraceOpenStates.value = {}
    agentInput.value = ''
    nextTick(handleAgentInput)
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
    const actions = Array.isArray(data.actions) ? data.actions : []
    hydrateAgentActions(actions)
    const actionById = new Map(actions.map(action => [String(action.action_id), action]))
    const actionByToolCallId = new Map()
    for (const item of (data.messages || [])) {
      if (item.role !== 'tool') continue
      let output = null
      try { output = JSON.parse(String(item.content || '{}')) } catch { /* ignore malformed history */ }
      const actionId = output?.action_id
      if (actionId && actionById.has(String(actionId))) {
        actionByToolCallId.set(String(item.tool_call_id || ''), actionById.get(String(actionId)))
      }
    }
    const messages = (data.messages || []).map((item, index) => historyMessage(item, index, actionByToolCallId)).filter(Boolean)
    agentMessages.value = messages
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
  agentActionStates.value = {}
  agentTraceOpenStates.value = {}
  agentChat.clearError()
  agentError.value = ''
  await loadAgentHistory()
}

async function loadSystemSettings() {
  try {
    const settings = await get('/api/system/settings')
    if (String(settings.school_name || '').trim()) schoolName.value = String(settings.school_name).trim()
  } catch {
    // 使用前端默认名称，保证设置接口不可用时侧栏仍可渲染。
  }
}

function handleSystemSettingsUpdated(event) {
  const name = String(event.detail?.school_name || '').trim()
  if (name) schoolName.value = name
}

onMounted(async () => {
  window.addEventListener('meimei-agent-session-change', switchAgentSession)
  window.addEventListener('workbench-context-change', handleContextChange)
  window.addEventListener('workbench-system-settings-updated', handleSystemSettingsUpdated)
  await loadSystemSettings()
  await loadAccessInfo()
  await loadAgentHistory()
})

onBeforeUnmount(() => {
  if (agentScrollFrame) window.cancelAnimationFrame(agentScrollFrame)
  window.removeEventListener('meimei-agent-session-change', switchAgentSession)
  window.removeEventListener('workbench-context-change', handleContextChange)
  window.removeEventListener('workbench-system-settings-updated', handleSystemSettingsUpdated)
})
</script>

<template>
  <div class="app">
    <header class="top-tabs">
      <div class="topbar-leading">
        <router-link to="/dashboard" class="topbar-home" aria-label="返回教师工作台" title="教师工作台">
          <component :is="renderIcon(activeNav.icon)" class="tab-icon" />
          <span>{{ activeNav.title }}</span>
        </router-link>
        <span class="topbar-divider" aria-hidden="true"></span>
        <ContextSwitcher @ready="handleContextReady" />
      </div>
      <div class="global-search">
        <input v-model="searchText" type="search" enterkeyhint="search" aria-label="全局搜索" placeholder="搜索学生、事件、成绩…" @keyup.enter="runSearch" @focus="searchOpen = !!searchResults.length" />
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
      <div class="topbar-actions" role="group" aria-label="系统工具">
        <button v-if="accessInfo?.enabled && accessInfo?.can_manage" ref="accessTriggerEl" class="access-button" type="button" aria-label="显示手机访问二维码" title="手机访问" @click="openAccessDialog">
          <component :is="renderIcon('Wifi')" :size="16" />
          <span>手机访问</span>
        </button>
        <button v-else-if="accessInfo?.enabled" class="device-logout-button" type="button" aria-label="退出当前授权设备" title="退出当前设备" @click="logoutAccessDevice">
          <component :is="renderIcon('LogOut')" :size="16" />
          <span>退出设备</span>
        </button>
        <button class="settings-button" type="button" aria-label="打开系统设置" title="系统设置" @click="router.push('/settings')">
          <Settings :size="16" />
        </button>
        <button class="update-button" type="button" aria-label="检查软件更新" title="检查更新" @click="updateOpen = true">
          <component :is="renderIcon('Download')" :size="16" />
        </button>
      </div>
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
    <div class="agent-float" :class="{ 'is-open': agentOpen, 'is-expanded': agentExpanded }">
      <transition name="agent-panel" @after-enter="handleAgentPanelEntered">
        <section v-show="agentOpen" class="agent-chat-panel" role="dialog" aria-modal="false" aria-labelledby="agent-chat-title" @keydown="handleAgentDialogKeydown">
        <header class="agent-chat-head">
          <div class="agent-chat-identity">
            <div class="agent-chat-avatar" aria-hidden="true"><Sparkles :size="17" :stroke-width="2.2" /></div>
            <div>
              <div id="agent-chat-title" class="agent-chat-title">班小助</div>
              <div class="agent-chat-subtitle"><span class="agent-status-dot"></span>教师工作台 AI 助手 · {{ agentScopeLabel }}</div>
            </div>
          </div>
          <div class="agent-chat-actions">
            <button class="agent-icon-button" type="button" :aria-label="agentExpanded ? '收起侧栏' : '展开侧栏'" :title="agentExpanded ? '收起侧栏' : '展开侧栏'" :aria-pressed="agentExpanded" @click="agentExpanded = !agentExpanded">
              <Minimize2 v-if="agentExpanded" :size="16" />
              <Maximize2 v-else :size="16" />
            </button>
            <button class="agent-icon-button" type="button" aria-label="开启新会话" title="新会话（保留当前会话）" @click="resetAgentSession">
              <SquarePen :size="16" />
            </button>
            <button class="agent-icon-button" type="button" aria-label="收起班小助" title="收起" @click="closeAgentChat">
              <component :is="renderIcon('X')" :size="17" />
            </button>
          </div>
        </header>
        <div ref="agentBody" class="agent-chat-body" aria-live="polite" @scroll="handleAgentBodyScroll">
          <div v-if="!agentMessages.length" class="agent-chat-welcome">
            <div class="agent-welcome-title">你好，我是班小助</div>
            <p>问班级数据、分析学生，或上传一份 Excel。</p>
            <div class="agent-capability-list" aria-label="班小助可以做什么">
              <span v-for="capability in agentCapabilities" :key="capability">{{ capability }}</span>
            </div>
            <div class="agent-suggestion-list">
              <button v-for="suggestion in agentSuggestions" :key="suggestion.text" type="button" class="agent-suggestion" @click="useAgentSuggestion(suggestion)">
                <span>{{ suggestion.text }}</span>
                <Paperclip v-if="suggestion.action === 'upload'" :size="14" />
                <component v-else :is="renderIcon('ChevronRight')" :size="14" />
              </button>
            </div>
          </div>
          <div v-for="message in displayedAgentMessages" :key="message.id" class="agent-message" :class="message.role">
            <template v-for="(part, partIndex) in message.parts" :key="`${message.id}-${partIndex}`">
              <template v-if="part.type === 'text'">
                <div v-if="message.role === 'assistant' && (part.state !== 'streaming' || agentStatus === 'ready')" class="agent-message-bubble agent-markdown" v-html="renderAgentMarkdown(part.text)"></div>
                <div v-else-if="message.role === 'assistant'" class="agent-message-bubble agent-streaming-text">{{ part.text }}</div>
                <div v-else class="agent-message-bubble">{{ part.text }}</div>
              </template>
              <div v-else-if="message.role === 'user' && part.type === 'file'" class="agent-message-attachment">
                <FileSpreadsheet :size="17" />
                <span>{{ part.filename || 'Excel 文件' }}</span>
              </div>
            </template>
            <template v-if="message.role === 'assistant' && agentExcelPreviewPart(message)">
              <div v-for="previewPart in [agentExcelPreviewPart(message)]" :key="`result-${agentToolPartId(previewPart)}`" class="agent-result-block">
                <div class="agent-result-heading"><Sparkles :size="14" /><span>处理结果</span></div>
                <div class="agent-excel-preview-card agent-result-card">
                  <div class="agent-result-card-head">
                    <div class="agent-result-card-title"><FileSpreadsheet :size="17" /><strong>{{ excelResultTitle(previewPart) }}</strong></div>
                    <span class="agent-result-status" :class="{ 'is-waiting': ['pending', 'confirming'].includes(agentActionStatus(previewPart)), 'is-success': agentActionStatus(previewPart) === 'executed' }">
                      {{ excelResultStatus(previewPart) }}
                    </span>
                  </div>
                  <div class="agent-result-context">目标：{{ agentActionScopeLabel(previewPart) }}</div>
                  <div class="agent-result-context">重复记录：{{ excelDuplicateName(previewPart) }}</div>
                  <div v-if="excelPreviewModel(previewPart).needsInput" class="agent-excel-preview-input-hint">有 {{ excelPreviewModel(previewPart).needsInputMappings.length }} 列暂时无法可靠判断，请补充它们对应的字段。</div>
                  <div class="agent-excel-preview-stats agent-result-stats">
                    <div><strong>{{ excelPreviewModel(previewPart).added }}</strong><span>新增</span></div>
                    <div><strong>{{ excelPreviewModel(previewPart).updated }}</strong><span>更新</span></div>
                    <div><strong>{{ excelPreviewModel(previewPart).skipped }}</strong><span>跳过</span></div>
                    <div class="is-error"><strong>{{ excelPreviewModel(previewPart).errors }}</strong><span>异常</span></div>
                  </div>
                  <details v-if="excelPreviewModel(previewPart).mappings.length" class="agent-mapping-details">
                    <summary>查看字段映射（{{ excelPreviewModel(previewPart).mappings.length }} 列）</summary>
                    <div class="agent-mapping-list">
                      <div v-for="mapping in excelPreviewModel(previewPart).mappings" :key="`${mapping.source}-${mapping.target}`" class="agent-mapping-row">
                        <span class="agent-mapping-symbol" :class="excelMappingStatusKey(mapping)">{{ excelMappingSymbol(mapping) }}</span>
                        <span class="agent-mapping-source">{{ mapping.source }}</span><span class="agent-mapping-arrow">→</span><strong>{{ mapping.target || '未映射' }}</strong>
                        <small>{{ excelMappingStatus(mapping) }}</small>
                      </div>
                    </div>
                  </details>
                  <div v-if="['pending', 'confirming'].includes(agentActionStatus(previewPart))" class="agent-result-consequence">{{ excelResultConsequence(previewPart) }}</div>
                  <div v-else-if="agentActionStatus(previewPart) === 'executed'" class="agent-result-consequence is-success">{{ excelResultConsequence(previewPart) }}</div>
                  <div class="agent-action-buttons agent-result-actions">
                    <template v-if="excelPreviewModel(previewPart).needsInput">
                      <button class="btn btn-primary btn-sm" type="button" @click="requestExcelMapping(previewPart)">补充字段映射</button>
                    </template>
                    <template v-else-if="isPendingAgentAction(previewPart)">
                      <button class="btn btn-primary btn-sm" type="button" @click="confirmAgentAction(previewPart)">确认导入 {{ Number(excelPreviewModel(previewPart).added) + Number(excelPreviewModel(previewPart).updated) }} 条</button>
                      <button class="btn btn-outline btn-sm" type="button" @click="cancelAgentAction(previewPart)">取消</button>
                    </template>
                    <span v-else-if="agentActionStatus(previewPart) === 'confirming'" class="agent-action-state">正在导入…</span>
                    <span v-else-if="agentActionStatus(previewPart) === 'cancelled'" class="agent-action-state">已取消，未修改数据</span>
                    <span v-else-if="agentActionStatus(previewPart) === 'error'" class="agent-action-state error">{{ friendlyAgentError(agentActionState(previewPart).error) }}</span>
                    <button v-if="excelPreviewModel(previewPart).errors > 0 && excelImportPlanId(previewPart)" class="btn btn-outline btn-sm agent-excel-error-download" type="button" @click="downloadExcelPlanErrors(previewPart)">下载错误报告</button>
                  </div>
                </div>
              </div>
            </template>
            <template v-if="message.role === 'assistant' && agentActionParts(message).length">
              <div v-for="actionPart in agentActionParts(message)" :key="`action-result-${agentToolPartId(actionPart)}`" class="agent-result-block">
                <div class="agent-result-heading"><Sparkles :size="14" /><span>操作结果</span></div>
                <div class="agent-action-card agent-result-card">
                  <div class="agent-result-card-head">
                    <div class="agent-result-card-title"><SquarePen :size="17" /><strong>{{ agentActionCardTitle(actionPart) }}</strong></div>
                    <span class="agent-result-status" :class="{ 'is-waiting': ['pending', 'confirming'].includes(agentActionStatus(actionPart)), 'is-success': agentActionStatus(actionPart) === 'executed' }">{{ agentActionCardStatus(actionPart) }}</span>
                  </div>
                  <div class="agent-result-context">目标：{{ agentActionScopeLabel(actionPart) }}</div>
                  <div class="agent-action-preview">{{ actionPart.output.preview || '操作预览已准备，请确认后写入。' }}</div>
                  <div class="agent-action-buttons agent-result-actions">
                    <template v-if="isPendingAgentAction(actionPart)">
                      <button class="btn btn-primary btn-sm" type="button" @click="confirmAgentAction(actionPart)">确认写入</button>
                      <button class="btn btn-outline btn-sm" type="button" @click="cancelAgentAction(actionPart)">取消</button>
                    </template>
                    <span v-else-if="agentActionStatus(actionPart) === 'confirming'" class="agent-action-state">正在写入…</span>
                    <span v-else-if="agentActionStatus(actionPart) === 'executed'" class="agent-action-state success">{{ actionResultSummary(actionPart) }}</span>
                    <span v-else-if="agentActionStatus(actionPart) === 'cancelled'" class="agent-action-state">已取消，未修改数据</span>
                    <span v-else-if="agentActionStatus(actionPart) === 'error'" class="agent-action-state error">{{ friendlyAgentError(agentActionState(actionPart).error) }}</span>
                  </div>
                </div>
              </div>
            </template>
            <details v-if="message.role === 'assistant' && agentTraceSteps(message).length" class="agent-trace-card" :open="agentTraceOpen(message)" @toggle="handleAgentTraceToggle(message, $event)">
              <summary>
                <Sparkles :size="14" class="agent-trace-mark" />
                <span class="agent-trace-title">查看处理过程</span>
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
                  </div>
                </div>
              </div>
            </details>
          </div>
          <div v-if="agentSending" class="agent-message assistant">
            <div class="agent-message-bubble agent-thinking"><span></span><span></span><span></span></div>
          </div>
          <div v-if="agentError" class="agent-chat-error" role="alert">
            <strong>这次没有完成</strong>
            <span>{{ friendlyAgentError(agentError) }}</span>
            <button class="agent-error-retry" type="button" :disabled="agentSending" @click="retryLastAgentMessage">重试</button>
          </div>
        </div>
        <footer class="agent-chat-foot">
          <div class="agent-composer">
            <input ref="agentExcelInput" class="agent-excel-input" type="file" accept=".xlsx" @change="handleAgentExcelFile" />
            <div v-if="agentExcel.step !== 'idle'" class="agent-excel-card">
              <div class="agent-excel-card-head">
                <div class="agent-excel-file"><FileSpreadsheet :size="16" /><strong>{{ agentExcel.artifact?.filename || 'Excel 文件' }}</strong></div>
                <button class="agent-excel-remove" type="button" aria-label="移除 Excel 文件" :disabled="agentExcel.busy" @click="discardAgentExcel">×</button>
              </div>
              <div v-if="agentExcel.step === 'uploading'" class="agent-excel-loading">正在上传附件…</div>
              <div v-else-if="agentExcel.artifact" class="agent-excel-summary">{{ formatAgentFileSize(agentExcel.artifact.sizeBytes) }} · 将随本条消息一起发送</div>
            </div>
            <div v-if="agentExcel.error" class="agent-excel-error">{{ agentExcel.error }}</div>
            <textarea ref="agentInputEl" v-model="agentInput" rows="2" maxlength="2000" placeholder="问班级数据、分析学生，或上传 Excel…" :disabled="agentSending" @input="handleAgentInput" @keydown="handleAgentKeydown"></textarea>
            <div class="agent-composer-bottom">
              <div class="agent-composer-meta"><button class="agent-attach-button" type="button" :disabled="agentSending || agentExcel.busy" @click="triggerAgentExcelUpload"><Paperclip :size="14" /> 添加 Excel</button><span class="agent-status-dot"></span>可读取当前班级数据</div>
              <button class="agent-send-button" type="button" aria-label="发送消息" :disabled="(!agentInput.trim() && !agentExcel.artifactId) || agentSending" @click="sendAgentMessage">
                <Send :size="16" :stroke-width="2.2" />
              </button>
            </div>
          </div>
          <div class="agent-chat-hint">Enter 发送 · Shift + Enter 换行</div>
        </footer>
        </section>
      </transition>
      <button v-if="!agentOpen" ref="agentFabEl" class="agent-fab" type="button" aria-label="打开班小助 AI 助手" @click="openAgentChat">
        <Sparkles :size="18" :stroke-width="2.2" />
        <span>班小助 · AI</span>
      </button>
    </div>
    <div class="app-body">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="sidebar-brand">
            <img class="brand-logo" src="/logo.svg" alt="" aria-hidden="true" />
            <div class="sidebar-brand-copy">
              <h2>智汇·班记</h2>
              <div class="sub">教师智能工作台</div>
            </div>
          </div>
          <div class="sidebar-context">
            <div class="sidebar-school">{{ schoolName }}</div>
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
          <span class="sidebar-footer-slogan">把时间还给老师，把精力留给教育</span>
        </div>
      </aside>
      <main ref="mainEl" class="main">
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

.topbar-leading { display: flex; align-items: center; justify-self: start; min-width: 0; }
.topbar-divider { flex: 0 0 auto; width: 1px; height: 18px; margin: 0 9px; background: var(--ds-color-border); }
.global-search { position: relative; justify-self: center; min-width: 0; width: 100%; max-width: 420px; }
.global-search input { width: 100%; height: 38px; box-sizing: border-box; border: 1px solid var(--ds-color-border); border-radius: 12px; background: rgba(255,255,255,.84); padding: 0 34px 0 14px; color: var(--ds-color-ink); font: var(--ds-type-body); outline: none; transition: border-color var(--ds-duration-fast) var(--ds-ease-out), box-shadow var(--ds-duration-fast) var(--ds-ease-out), background-color var(--ds-duration-fast) var(--ds-ease-out); }
.global-search input:focus { border-color: var(--ds-color-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ds-color-primary) 16%, transparent); }
.search-clear { position: absolute; right: 10px; top: 6px; border: 0; background: transparent; color: var(--text-secondary); font-size: 18px; cursor: pointer; }
.search-popover { position: absolute; z-index: 20; top: calc(100% + 8px); left: 0; right: 0; max-height: 360px; overflow: auto; padding: 7px; background: rgba(255,255,255,.98); border-radius: var(--ds-radius-card); box-shadow: var(--ds-shadow-raised); }
.search-result { width: 100%; display: flex; gap: 9px; align-items: flex-start; padding: 10px; border: 0; border-radius: 10px; background: transparent; text-align: left; cursor: pointer; color: var(--text); }
.search-result:hover { background: var(--ds-color-surface-subtle); }
.search-result span:last-child { min-width: 0; display: grid; gap: 3px; }
.search-result small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ds-color-ink-secondary); }
.search-kind { flex: 0 0 auto; padding: 3px 6px; border-radius: var(--ds-radius-sm); background: var(--ds-color-primary-soft); color: var(--ds-color-primary-hover); font: var(--ds-type-meta); }
.search-empty { padding: 18px 10px; text-align: center; color: var(--ds-color-ink-secondary); font: var(--ds-type-body); }

.topbar-actions { display: flex; align-items: center; justify-self: end; gap: 2px; padding: 2px; border: 1px solid var(--ds-color-border); border-radius: 12px; background: rgba(255,255,255,.72); box-shadow: 0 1px 2px rgba(28,31,41,.04); }
.access-button, .device-logout-button, .settings-button, .update-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: 0 0 auto; min-height: 32px; border: 0; border-radius: 9px; background: transparent; color: var(--ds-color-ink-secondary); font: inherit; font-size: 12px; cursor: pointer; transition: transform 100ms ease-out, color var(--ds-duration-fast) var(--ds-ease-out), background-color var(--ds-duration-fast) var(--ds-ease-out); touch-action: manipulation; }
.access-button, .device-logout-button { padding: 0 10px; }
.settings-button, .update-button { width: 32px; padding: 0; }
.access-button:hover, .device-logout-button:hover, .settings-button:hover, .update-button:hover { color: var(--ds-color-primary-hover); background: var(--ds-color-primary-soft); }
.access-button:active, .device-logout-button:active, .settings-button:active, .update-button:active { transform: scale(.94); }
.access-button:focus-visible, .device-logout-button:focus-visible, .settings-button:focus-visible, .update-button:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--ds-color-primary) 16%, transparent); }

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
.agent-float.is-expanded .agent-chat-panel { width: min(580px, calc(100vw - 32px)); }
.agent-chat-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 16px; border-bottom: 1px solid var(--border); background: linear-gradient(135deg, rgba(91,106,191,.11), rgba(255,255,255,.66)); }
.agent-chat-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
.agent-chat-avatar { display: grid; place-items: center; flex: 0 0 auto; width: 32px; height: 32px; border-radius: 10px; background: var(--primary-bg); color: var(--primary); }
.agent-chat-title { color: var(--text); font-size: 15px; font-weight: 700; }
.agent-chat-subtitle { display: flex; align-items: center; gap: 5px; margin-top: 3px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.agent-chat-subtitle { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-status-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #43b866; box-shadow: 0 0 0 3px rgba(67,184,102,.12); }
.agent-chat-actions { display: flex; gap: 4px; }
.agent-icon-button { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 9px; background: transparent; color: var(--text-secondary); cursor: pointer; touch-action: manipulation; }
.agent-icon-button:hover { background: var(--primary-bg); color: var(--primary); }
.agent-icon-button:active { transform: scale(.94); }
.agent-chat-body { flex: 1; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 24px 20px; background: var(--ds-color-surface-subtle); scroll-behavior: smooth; }
.agent-chat-welcome { display: grid; justify-items: center; gap: 8px; margin: 48px 8px 30px; color: var(--text-secondary); text-align: center; font-size: 13px; line-height: 1.5; }
.agent-chat-welcome p { max-width: 280px; margin: 0; }
.agent-welcome-title { color: var(--text); font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
.agent-capability-list { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; max-width: 330px; margin-top: 4px; }
.agent-capability-list span { padding: 5px 8px; border: 1px solid rgba(91,106,191,.14); border-radius: 999px; background: rgba(238,240,251,.72); color: var(--primary); font-size: 11px; }
.agent-suggestion-list { display: grid; width: min(300px, 100%); gap: 7px; margin-top: 13px; }
.agent-suggestion { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; padding: 9px 11px; border: 1px solid var(--border); border-radius: 11px; background: rgba(255,255,255,.78); color: var(--text-secondary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; transition: border-color var(--ds-duration-fast) var(--ds-ease-out), background var(--ds-duration-fast) var(--ds-ease-out), color var(--ds-duration-fast) var(--ds-ease-out), transform var(--ds-duration-fast) var(--ds-ease-out); }
.agent-suggestion:hover { border-color: rgba(91,106,191,.36); background: var(--primary-bg); color: var(--primary); }
.agent-suggestion:active { transform: scale(.98); }
.agent-message { display: flex; align-items: flex-end; gap: 7px; width: 100%; max-width: 100%; min-width: 0; margin: 9px 0; box-sizing: border-box; }
.agent-message.assistant { display: block; }
.agent-message.user { justify-content: flex-end; }
.agent-message.plan { display: block; margin: 7px 0 10px; }
.agent-message-bubble { min-width: 0; max-width: 100%; box-sizing: border-box; padding: 8px 0; border-radius: 15px; background: transparent; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.62; }
.agent-message.assistant .agent-message-bubble { width: min(94%, 500px); }
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
.agent-markdown blockquote { margin: 9px 0; padding: 8px 10px; border: 1px solid rgba(91,106,191,.18); border-radius: 8px; background: rgba(238,240,251,.45); color: var(--text-secondary); }
.agent-markdown a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
.agent-markdown hr { margin: 12px 0; border: 0; border-top: 1px solid var(--border); }
.agent-markdown { min-width: 0; max-width: 100%; }
.agent-markdown table { width: 100%; min-width: 0; max-width: 100%; margin: 9px 0; table-layout: fixed; border-collapse: collapse; font-size: 12px; }
.agent-markdown th, .agent-markdown td { padding: 6px 8px; border: 1px solid var(--border); text-align: left; white-space: normal; overflow-wrap: anywhere; word-break: break-word; vertical-align: top; }
.agent-markdown th { background: var(--primary-bg); color: var(--text); font-weight: 650; }
.agent-streaming-text { white-space: pre-wrap; }
.agent-result-block { width: min(100%, 520px); margin: 7px 0 12px; }
.agent-result-heading { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; color: var(--primary); font: var(--ds-type-meta); font-weight: 700; }
.agent-excel-preview-card.agent-result-card { margin-top: 0; padding: 14px; border-color: rgba(91,106,191,.22); border-radius: 14px; background: var(--ds-color-surface); box-shadow: 0 4px 14px rgba(40,48,85,.06); }
.agent-result-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.agent-result-card-title { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--primary); }
.agent-result-card-title strong { color: var(--text); font-size: 14px; }
.agent-result-status { flex: 0 0 auto; padding: 3px 7px; border-radius: 999px; background: var(--primary-bg); color: var(--primary); font: var(--ds-type-meta); }
.agent-result-status.is-waiting { background: #fff5df; color: #8a5b0a; }
.agent-result-status.is-success { background: #eaf7ee; color: var(--success); }
.agent-result-context { margin-top: 6px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.agent-result-stats { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 7px; margin-top: 12px; }
.agent-result-stats div { display: grid; gap: 2px; padding: 8px 7px; border-radius: 9px; background: var(--ds-color-surface-subtle); text-align: center; }
.agent-result-stats strong { color: var(--text); font-size: 18px; line-height: 1; }
.agent-result-stats span { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.agent-result-stats .is-success strong, .agent-result-stats .is-success span { color: var(--success); }
.agent-result-stats .is-error strong, .agent-result-stats .is-error span { color: var(--danger); }
.agent-result-consequence { margin-top: 10px; padding: 8px 10px; border-radius: 9px; background: #fff8e8; color: #8a5b0a; font: var(--ds-type-meta); }
.agent-mapping-details { margin-top: 11px; border-top: 1px solid var(--border); }
.agent-mapping-details summary { padding-top: 10px; color: var(--primary); font: var(--ds-type-meta); font-weight: 650; cursor: pointer; list-style: none; }
.agent-mapping-details summary::-webkit-details-marker { display: none; }
.agent-mapping-list { display: grid; gap: 5px; max-height: 210px; margin-top: 8px; overflow-y: auto; }
.agent-mapping-row { display: grid; grid-template-columns: 18px minmax(0,1fr) auto minmax(0,1fr) auto; align-items: center; gap: 6px; min-width: 0; padding: 5px 0; font-size: 12px; }
.agent-mapping-symbol { display: grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; background: #eaf7ee; color: var(--success); font-size: 11px; font-weight: 700; }
.agent-mapping-symbol.needs-confirmation { background: #fff5df; color: #a56a12; }
.agent-mapping-symbol.ignored { background: var(--ds-color-surface-subtle); color: var(--ds-color-ink-muted); }
.agent-mapping-source, .agent-mapping-row strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-mapping-arrow { color: var(--ds-color-ink-muted); }
.agent-mapping-row small { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); white-space: nowrap; }
.agent-result-actions { margin-top: 12px; }
.agent-result-actions .btn { min-height: 36px; }
.agent-excel-preview-card.agent-result-card .agent-excel-preview-input-hint { margin-top: 10px; font-size: 12px; }
.agent-action-card.agent-result-card { border-color: rgba(91,106,191,.2); }
.agent-action-preview { margin-top: 10px; color: var(--text-secondary); font: var(--ds-type-meta); line-height: 1.5; overflow-wrap: anywhere; }
.agent-result-consequence.is-success { background: #eaf7ee; color: var(--success); }
.agent-trace-card { width: min(100%, 520px); box-sizing: border-box; margin: 7px 0 9px; padding: 8px 10px; border: 1px solid rgba(91,106,191,.12); border-radius: 10px; background: rgba(248,249,253,.72); color: var(--text-secondary); }
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
.agent-excel-preview-card { margin-top: 7px; padding: 8px 9px; border: 1px solid rgba(91,106,191,.14); border-radius: 9px; background: rgba(255,255,255,.72); }
.agent-excel-preview-title { color: var(--text); font: var(--ds-type-meta); font-weight: 700; }
.agent-excel-preview-input-hint { margin-top: 4px; color: #9a6818; font: 11px/1.4 var(--font-sans, system-ui); }
.agent-excel-preview-stats { display: flex; flex-wrap: wrap; gap: 5px 9px; margin-top: 5px; color: var(--ds-color-ink-secondary); font: 12px/1.4 var(--font-sans, system-ui); }
.agent-excel-preview-stats .is-success { color: var(--success); }
.agent-excel-preview-stats .is-error { color: var(--danger, #c83b32); }
.agent-excel-preview-mappings { display: grid; gap: 2px; margin-top: 6px; color: var(--text-secondary); font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; }
.agent-excel-preview-mappings .is-muted { color: var(--ds-color-ink-muted); }
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
.agent-thinking span { width: 5px; height: 5px; border-radius: 50%; background: var(--text-tertiary); animation: agent-thinking-pulse 1s infinite ease-in-out; }
.agent-thinking span:nth-child(2) { animation-delay: .12s; }
.agent-thinking span:nth-child(3) { animation-delay: .24s; }
.agent-chat-error { display: grid; gap: 3px; margin: 12px 2px 0; padding: 10px 11px; border: 1px solid rgba(180,35,24,.16); border-radius: var(--ds-radius-control); background: var(--ds-color-danger-soft); color: var(--ds-color-danger); font: var(--ds-type-meta); }
.agent-chat-error strong { font-size: 13px; }
.agent-error-retry { width: fit-content; margin-top: 4px; padding: 3px 0; border: 0; background: transparent; color: var(--ds-color-danger); font: var(--ds-type-label); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.agent-error-retry:disabled { opacity: .5; cursor: default; }
.agent-chat-foot { padding: 10px 14px 13px; border-top: 1px solid var(--border); background: rgba(255,255,255,.9); }
.agent-composer { padding: 7px 9px 8px 12px; border: 1px solid rgba(126,137,194,.35); border-radius: 16px; background: #fff; box-shadow: 0 3px 12px rgba(40, 48, 85, .06); transition: border-color var(--ds-duration-fast) var(--ds-ease-out), box-shadow var(--ds-duration-fast) var(--ds-ease-out); }
.agent-composer:focus-within { border-color: rgba(126,137,194,.35); box-shadow: 0 3px 12px rgba(40, 48, 85, .06); }
.agent-excel-input { display: none; }
.agent-excel-card { margin: 0 0 8px; padding: 9px 10px; border: 1px solid rgba(91,106,191,.18); border-radius: 11px; background: rgba(248,249,253,.9); font-size: 12px; }
.agent-excel-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.agent-excel-file { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--primary); }
.agent-excel-file strong { overflow: hidden; color: var(--text); text-overflow: ellipsis; white-space: nowrap; }
.agent-excel-remove { flex: 0 0 auto; width: 22px; height: 22px; border: 0; border-radius: 7px; background: transparent; color: var(--text-tertiary); font-size: 17px; line-height: 1; cursor: pointer; }
.agent-excel-remove:hover { background: var(--primary-bg); color: var(--primary); }
.agent-excel-summary, .agent-excel-loading { margin-top: 6px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.agent-excel-error { margin: 0 0 7px; color: var(--danger, #c83b32); font-size: 11px; line-height: 1.4; }
.agent-message-attachment { display: flex; align-items: center; gap: 7px; max-width: min(82%, 320px); padding: 9px 11px; border: 1px solid rgba(255,255,255,.38); border-radius: 11px; background: rgba(255,255,255,.16); color: inherit; }
.agent-message-attachment span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-attach-button { display: inline-flex; align-items: center; gap: 4px; min-height: 36px; padding: 3px 7px; border: 0; border-radius: 8px; background: transparent; color: var(--ds-color-ink-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.agent-attach-button:hover { background: var(--primary-bg); color: var(--primary); }
.agent-attach-button:disabled { opacity: .5; cursor: default; }
.agent-chat-foot textarea { display: block; width: 100%; box-sizing: border-box; min-height: 48px; max-height: 140px; resize: none; overflow-y: hidden; padding: 3px 2px 8px; border: 0; outline: none; background: transparent; color: var(--text); font: inherit; font-size: 13px; line-height: 1.5; }
.agent-chat-foot textarea:focus, .agent-chat-foot textarea:focus-visible, .app .agent-chat-foot textarea:focus-visible { border-color: transparent; box-shadow: none; outline: none !important; outline-offset: 0; }
.agent-chat-foot textarea:disabled { opacity: .7; }
.agent-composer-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.agent-composer-meta { display: flex; align-items: center; gap: 7px; color: var(--ds-color-ink-muted); font: var(--ds-type-meta); }
.agent-send-button { display: grid; place-items: center; flex: 0 0 auto; width: 32px; height: 32px; border: 0; border-radius: 10px; background: var(--primary); color: #fff; cursor: pointer; transition: transform var(--ds-duration-fast) var(--ds-ease-out), opacity var(--ds-duration-fast) var(--ds-ease-out); touch-action: manipulation; }
.agent-send-button:disabled { opacity: .38; cursor: default; }
.agent-send-button:not(:disabled):active { transform: scale(.93); }
.agent-chat-hint { margin: 7px 2px 0; color: var(--ds-color-ink-muted); font: var(--ds-type-meta); }
@keyframes agent-thinking-pulse { 0%, 100% { opacity: .42; } 50% { opacity: 1; } }

@media (min-width: 641px) and (max-width: 1100px) {
  .topbar-leading { grid-column: 1; grid-row: 1; }
  .topbar-actions { grid-column: 2; grid-row: 1; }
  .global-search { grid-column: 1 / -1; grid-row: 2; width: 100%; max-width: none; }
  .global-search input { min-height: 40px; }
}

@media (max-width: 760px) {
  .global-search input { font-size: 12px; }
}

@media (max-width: 640px) {
  .topbar-leading { grid-column: 1; grid-row: 1; min-width: 0; }
  .topbar-divider { display: none; }
  .topbar-actions { grid-column: 2; grid-row: 1; }
  .global-search { grid-column: 1 / -1; grid-row: 2; width: 100%; max-width: none; }
  .global-search input { height: 40px; min-height: 40px; padding-top: 8px; padding-bottom: 8px; font-size: 14px; }
  .search-popover { position: fixed; top: 104px; left: 10px; right: 10px; max-height: min(360px, 52vh); }
  .topbar-actions { flex: 0 0 auto; }
  .access-button, .device-logout-button, .settings-button, .update-button { min-height: 36px; }
  .access-button span { display: none; }
  .device-logout-button span { display: none; }
  .access-button, .device-logout-button, .settings-button, .update-button { width: 36px; padding: 0; }
  .access-scrim { align-items: end; padding: 0; }
  .access-dialog { width: 100%; border-radius: 24px 24px 0 0; padding: 20px 18px calc(20px + env(safe-area-inset-bottom)); }
  .agent-float { right: 12px; bottom: calc(72px + env(safe-area-inset-bottom)); }
  .agent-float.is-open { right: 0; bottom: 0; width: 100%; }
  .agent-float.is-expanded .agent-chat-panel { width: 100%; }
  .agent-chat-panel { width: 100%; height: min(760px, calc(100dvh - 8px)); max-height: calc(100dvh - 8px); border-radius: 20px 20px 0 0; }
  .agent-chat-foot { padding-bottom: calc(13px + env(safe-area-inset-bottom)); }
  .agent-chat-foot textarea { min-height: 56px; font-size: 16px; }
  .agent-attach-button { min-height: 44px; }
  .agent-send-button { width: 44px; height: 44px; }
  .agent-result-stats { gap: 5px; }
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
