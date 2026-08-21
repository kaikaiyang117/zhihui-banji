<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { MessageCircle, MessageSquareReply, Plus, Trash2, Copy, RotateCcw, FileText, ChevronRight, ChevronLeft, Umbrella, ShieldAlert, CalendarDays, PartyPopper, ClipboardList, ReceiptText, BookOpenCheck, UsersRound, Sparkles, Target, CircleCheck, CircleAlert, HelpCircle, SlidersHorizontal } from 'lucide-vue-next'
import { del, get, listNotificationTemplates, ensureNotificationTemplates, getNotificationTemplate, generateNotificationAiContent, generateMeetingSummary, generateMeetingOutline } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'
import WorkflowModal from '../components/WorkflowModal.vue'
import ParentReplyAssistant from '../components/ParentReplyAssistant.vue'
import { useConfirmDialog } from '../composables/confirmDialog'

const route = useRoute()
const sourceId = Number(route.query.source_id || 0)
const studentId = Number(route.query.student_id || 0)
const { confirm: confirmDialog } = useConfirmDialog()

const activeTab = ref(studentId ? 'meetings' : 'records')

const communications = ref([])
const loading = ref(true)
const showAdd = ref(false)
const workflowTarget = ref(null)

const mpStudents = ref([])
const mpStudentId = ref(studentId || '')
const mpDateFrom = ref('')
const mpDateTo = ref('')
const mpCategories = ref({
  scores: true,
  attendance: true,
  points: true,
  communications: true,
  events: true,
})
const mpPurpose = ref('阶段学习沟通')
const mpTeacherNotes = ref('')
const mpSummaryResult = ref(null)
const mpPlan = ref(null)
const mpFacts = ref([])
const mpOutlineText = ref('')
const mpGenerating = ref(false)
const mpMessage = ref('')
const mpCopyMessage = ref('')
const mpAdvancedOpen = ref(false)

const mpSelectedStudentName = computed(() => {
  if (!mpStudentId.value) return ''
  const s = mpStudents.value.find(s => s.id === Number(mpStudentId.value))
  return s ? s['姓名'] : ''
})

const meetingPurposeOptions = ['阶段学习沟通', '成绩变化', '行为与习惯', '考勤与到校', '家校协同', '其他']

const categoryOptions = [
  { key: 'scores', label: '成绩', param: 'include_scores' },
  { key: 'attendance', label: '考勤', param: 'include_attendance' },
  { key: 'points', label: '积分', param: 'include_points' },
  { key: 'communications', label: '家校沟通', param: 'include_communications' },
  { key: 'events', label: '事件', param: 'include_events' },
]

async function mpLoadSetup() {
  try {
    const [studentData, contextData, runtime] = await Promise.all([
      get('/api/students'),
      get('/api/context'),
      get('/api/system/runtime'),
    ])
    mpStudents.value = studentData.students || []
    const current = contextData.current || {}
    const today = runtime.business_date || new Date().toISOString().slice(0, 10)
    const termEnd = current.end_date && current.end_date < today ? current.end_date : today
    mpDateFrom.value = current.start_date && current.start_date <= termEnd ? current.start_date : termEnd
    mpDateTo.value = termEnd
  } catch (e) {
    mpMessage.value = `会谈准备加载失败：${e.message}`
  }
}

function mpRequestParams() {
  return {
    student_id: Number(mpStudentId.value),
    date_start: mpDateFrom.value || undefined,
    date_end: mpDateTo.value || undefined,
    include_scores: mpCategories.value.scores,
    include_attendance: mpCategories.value.attendance,
    include_points: mpCategories.value.points,
    include_communications: mpCategories.value.communications,
    include_events: mpCategories.value.events,
  }
}

async function mpGenerate() {
  if (!mpStudentId.value || !mpPurpose.value) return
  mpGenerating.value = true
  mpMessage.value = ''
  mpPlan.value = null
  mpFacts.value = []
  mpOutlineText.value = ''
  const params = mpRequestParams()
  try {
    mpSummaryResult.value = await generateMeetingSummary(params)
  } catch (e) {
    mpMessage.value = `事实整理失败：${e.message}`
    mpGenerating.value = false
    return
  }
  try {
    const result = await generateMeetingOutline({
      ...params,
      purpose: mpPurpose.value,
      teacher_notes: mpTeacherNotes.value.trim(),
    })
    mpSummaryResult.value = result.summary || mpSummaryResult.value
    mpPlan.value = result.plan || null
    mpFacts.value = result.facts || []
    mpOutlineText.value = result.outline || result.plan?.outline || ''
  } catch (e) {
    mpMessage.value = `事实已整理，但 AI 方案生成失败：${e.message}`
  }
  mpGenerating.value = false
}

async function mpCopyOutline() {
  const text = mpOutlineText.value
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  mpCopyMessage.value = '已复制提纲'
  setTimeout(() => { mpCopyMessage.value = '' }, 3000)
}

function mpEvidenceFor(insight) {
  const refs = new Set(insight?.evidence_refs || [])
  return mpFacts.value.filter(fact => refs.has(fact.id))
}

function mpFormatItem(item) {
  if (item.summary) return item.summary
  const parts = []
  if (item.exam_name) parts.push(item.exam_name)
  if (item.subject) parts.push(item.subject)
  if (item.score != null) parts.push(`${item.score}分`)
  if (item.rank) parts.push(`第${item.rank}名`)
  if (item.record_status && item.record_status !== '正常') parts.push(item.record_status)
  if (item.scene) parts.push(item.scene)
  if (item.status) parts.push(item.status)
  if (item.reason) parts.push(item.reason)
  if (item.amount != null) parts.push(`${item.amount > 0 ? '+' : ''}${item.amount}分`)
  if (item.category) parts.push(item.category)
  if (item.method) parts.push(item.method)
  if (item.event_type) parts.push(item.event_type)
  if (item.description) parts.push(item.description)
  if (item.followup_at) parts.push(`回访${item.followup_at}`)
  return parts.join(' · ')
}

function mpItemDate(item) {
  return item.exam_date || item.date || item.occurred_at || item.communicated_at || ''
}

function onTabMeetings() {
  activeTab.value = 'meetings'
  if (!mpStudents.value.length) mpLoadSetup()
}

watch(() => activeTab.value, (tab) => {
  if (tab === 'meetings' && !mpStudents.value.length) mpLoadSetup()
})

const scenes = [
  { key: '放假通知', label: '放假通知', description: '适合节假日、寒暑假和临时放假。', icon: Umbrella },
  { key: '安全提醒', label: '安全提醒', description: '适合防溺水、交通、消防、极端天气等安全教育。', icon: ShieldAlert },
  { key: '调课通知', label: '调课通知', description: '说明调课、考试、新安排和学生需要准备的物品。', icon: CalendarDays },
  { key: '班级活动', label: '活动研学', description: '适合运动会、研学、社会实践和班级活动。', icon: PartyPopper },
  { key: '缴费回执', label: '缴费回执', description: '只处理学校已经明确的项目，不替学校新增收费要求。', icon: ReceiptText },
  { key: '学习提醒', label: '学习提醒', description: '适合作业、阅读、实践或阶段学习安排提醒。', icon: BookOpenCheck },
  { key: '家长会', label: '家长会', description: '适合家长会、家长开放日和个别预约沟通。', icon: UsersRound },
  { key: '材料收集', label: '材料收集', description: '适合回执、照片、健康材料和信息核对。', icon: ClipboardList },
]
const selectedSceneLabel = computed(() => scenes.find(scene => scene.key === selectedScene.value)?.label || '')
const templates = ref([])
const selectedScene = ref(null)
const selectedTemplate = ref(null)
const templateDetail = ref(null)
const variableValues = ref({})
const generatedContent = ref('')
const draftContent = ref('')
const aiInstruction = ref('')
const generating = ref(false)
const templateMessage = ref('')
const mobileStep = ref(1)
const copyMessage = ref('')
const isMobile = ref(window.innerWidth <= 800)

function onResize() { isMobile.value = window.innerWidth <= 800 }

async function load() {
  loading.value = true
  const params = new URLSearchParams({ limit: '200' })
  if (sourceId) params.set('source_id', sourceId)
  if (studentId) params.set('student_id', studentId)
  try { communications.value = (await get(`/api/communications?${params}`)).communications || [] } finally { loading.value = false }
}

async function removeCommunication(item) {
  if (!(await confirmDialog({ title: '删除沟通记录？', message: `将删除"${item.reason}"并移入回收站，关联待办会一同隐藏。`, confirmText: '移入回收站' }))) return
  await del(`/api/records/communication/${item.id}`)
  await load()
}

function onParentReplySaved() {
  activeTab.value = 'records'
  load()
}

async function loadTemplates() {
  await ensureNotificationTemplates()
  const scene = selectedScene.value || undefined
  const data = await listNotificationTemplates(scene)
  templates.value = data.templates || []
}

async function selectScene(scene) {
  selectedScene.value = scene
  selectedTemplate.value = null
  templateDetail.value = null
  variableValues.value = {}
  generatedContent.value = ''
  draftContent.value = ''
  aiInstruction.value = ''
  templateMessage.value = ''
  await loadTemplates()
  const sceneStructure = templates.value.find(item => item.is_system)
  if (sceneStructure) await selectTemplate(sceneStructure)
  else templateMessage.value = '该通知类型暂时不可用'
  if (isMobile.value) mobileStep.value = 2
}

async function selectTemplate(tpl) {
  selectedTemplate.value = tpl
  const data = await getNotificationTemplate(tpl.id)
  templateDetail.value = data.template || data
  variableValues.value = {}
  if (templateDetail.value.variables) {
    templateDetail.value.variables.forEach(v => {
      variableValues.value[v.name] = v.default_value || ''
    })
  }
  generatedContent.value = ''
  draftContent.value = ''
  aiInstruction.value = ''
  templateMessage.value = ''
}

function requiredVariablesMissing() {
  if (!templateDetail.value?.variables) return false
  return templateDetail.value.variables.some(v => v.required && !variableValues.value[v.name]?.trim())
}

async function generate() {
  if (!selectedTemplate.value || requiredVariablesMissing()) return
  generating.value = true
  templateMessage.value = ''
  try {
    const result = await generateNotificationAiContent(selectedTemplate.value.id, variableValues.value, aiInstruction.value)
    generatedContent.value = result.source_content || result.content || ''
    draftContent.value = result.content || ''
    if (isMobile.value) mobileStep.value = 3
  } catch (e) {
    templateMessage.value = `生成失败：${e.message}`
  } finally {
    generating.value = false
  }
}

async function copyToClipboard() {
  const text = draftContent.value || generatedContent.value
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copyMessage.value = '已复制，尚未证明已发送'
  setTimeout(() => { copyMessage.value = '' }, 3000)
}

function restoreOriginal() {
  draftContent.value = generatedContent.value
  templateMessage.value = '已恢复 AI 初稿'
  setTimeout(() => { templateMessage.value = '' }, 2000)
}

function goBackToScenes() {
  mobileStep.value = 1
  selectedScene.value = null
  templates.value = []
  selectedTemplate.value = null
  templateDetail.value = null
}

function onTabTemplates() {
  activeTab.value = 'templates'
  mobileStep.value = 1
  selectedScene.value = null
  loadTemplates()
}

onMounted(() => {
  load()
  if (studentId) mpLoadSetup()
  window.addEventListener('resize', onResize)
})
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <div>
    <div class="page-title-bar"><div><div class="page-title">{{ activeTab === 'reply' ? '回复家长' : activeTab === 'templates' ? 'AI 通知生成' : activeTab === 'meetings' ? 'AI 会谈准备' : '家校沟通' }}</div><div class="page-subtitle">{{ activeTab === 'reply' ? '先核实事实和职责边界，再生成由教师确认的回复。' : activeTab === 'templates' ? '选择通知类型，补齐关键事实，由 AI 生成可编辑的微信群消息；最终由老师确认后发送。' : activeTab === 'meetings' ? '基于学生事实生成可核对、可编辑的沟通方案。' : '记录沟通内容，也记住双方约定的下一步' }}</div></div></div>

    <div v-if="activeTab !== 'reply'" class="segmented parent-comm-segmented" role="tablist" aria-label="家校沟通功能">
      <button role="tab" :aria-selected="activeTab === 'records'" :class="{ active: activeTab === 'records' }" @click="activeTab = 'records'">沟通记录</button>
      <button role="tab" :aria-selected="activeTab === 'templates'" :class="{ active: activeTab === 'templates' }" @click="onTabTemplates">AI 通知</button>
      <button role="tab" :aria-selected="activeTab === 'meetings'" :class="{ active: activeTab === 'meetings' }" @click="onTabMeetings">AI 会谈</button>
    </div>

    <template v-if="activeTab === 'records'">
      <div class="overview-cards">
        <div class="overview-card"><div class="oc-label">本页记录</div><div class="oc-value">{{ communications.length }}</div></div>
        <div class="overview-card"><div class="oc-label">需要回访</div><div class="oc-value">{{ communications.filter(c => c.followup_at && c.status !== '已完成').length }}</div></div>
        <div class="overview-card"><div class="oc-label">电话沟通</div><div class="oc-value">{{ communications.filter(c => c.method === '电话').length }}</div></div>
      </div>
      <div class="card parent-comm-records-card">
        <div class="card-title-row"><span class="card-title"><MessageCircle :size="16" /> 沟通台账</span><div class="record-actions"><button class="btn btn-outline btn-sm" @click="activeTab = 'reply'"><MessageSquareReply :size="14" /> 回复家长</button><button class="btn btn-primary btn-sm" @click="showAdd = true"><Plus :size="14" /> 记录沟通</button></div></div>
        <div v-if="loading" class="loading">加载中…</div>
        <div v-else-if="!communications.length" class="empty-state">还没有沟通记录</div>
        <div v-else class="communication-list">
          <div v-for="item in communications" :key="item.id" class="communication-row" :class="{ 'source-highlight': item.id === sourceId }">
            <div class="communication-date">{{ item.communicated_at }}<span>{{ item.method }}</span></div>
            <div class="communication-copy"><strong>{{ item.student_name }} · {{ item.reason }}</strong><p>{{ item.summary }}</p><span v-if="item.agreement" class="hint">约定：{{ item.agreement }}</span></div>
            <div class="communication-status"><span class="tag" :class="item.followup_at && item.status !== '已完成' ? 'tag-orange' : 'tag-green'">{{ item.followup_at ? `回访 ${item.followup_at}` : item.status }}</span><div class="record-actions"><button class="btn btn-sm btn-outline" @click="workflowTarget = item">处理</button><button class="btn btn-sm btn-outline" aria-label="删除沟通记录" @click="removeCommunication(item)"><Trash2 :size="13" /></button></div></div>
          </div>
        </div>
      </div>
      <QuickRecordModal v-if="showAdd" mode="comm" @success="showAdd = false; load()" @close="showAdd = false" />
      <WorkflowModal v-if="workflowTarget" source-type="communication" :source-id="workflowTarget.id" :title="`${workflowTarget.student_name} · ${workflowTarget.reason}`" @close="workflowTarget = null" @success="workflowTarget = null; load()" />
    </template>

    <ParentReplyAssistant v-if="activeTab === 'reply'" :initial-student-id="studentId" @back="activeTab = 'records'" @saved="onParentReplySaved" />

    <template v-if="activeTab === 'templates'">
      <div v-if="templateMessage" class="inline-message">{{ templateMessage }}</div>
      <div v-if="copyMessage" class="inline-message">{{ copyMessage }}</div>

      <div v-if="isMobile" class="nt-mobile-flow">
        <div class="nt-mobile-steps">
          <span class="nt-step" :class="{ active: mobileStep === 1 }">1 选类型</span>
          <span class="nt-step-arrow">›</span>
          <span class="nt-step" :class="{ active: mobileStep === 2 }">2 填信息</span>
          <span class="nt-step-arrow">›</span>
          <span class="nt-step" :class="{ active: mobileStep === 3 }">3 编辑复制</span>
        </div>

        <div v-if="mobileStep === 1" class="card">
          <div class="card-title"><FileText :size="16" /> 选择通知类型</div>
          <div class="nt-scene-list">
            <button v-for="scene in scenes" :key="scene.key" class="nt-scene-row" :class="{ active: selectedScene === scene.key }" @click="selectScene(scene.key)">
              <component :is="scene.icon" :size="17" class="nt-scene-icon" aria-hidden="true" />
              <span>{{ scene.label }}</span>
              <ChevronRight :size="14" class="nt-scene-arrow" />
            </button>
          </div>
        </div>

        <div v-if="mobileStep === 2 && templateDetail" class="card">
          <div class="nt-mobile-back">
            <button class="btn btn-sm btn-outline" @click="goBackToScenes"><ChevronLeft :size="14" /> 返回类型</button>
            <span class="hint">{{ selectedSceneLabel }}</span>
          </div>
          <div class="card-title">填写关键信息</div>
          <div v-if="templateDetail.variables?.length" class="nt-variable-form">
            <div class="form-grid">
              <label v-for="v in templateDetail.variables" :key="v.name">
                <span class="nt-field-label">{{ v.label || v.name }}<span v-if="v.required" class="nt-required">*</span></span>
                <input v-if="v.format === 'date'" class="form-input" type="date" v-model="variableValues[v.name]" :required="v.required" />
                <input v-else class="form-input" type="text" v-model="variableValues[v.name]" :placeholder="v.default_value || ''" :required="v.required" />
              </label>
            </div>
          </div>
          <label class="nt-ai-instruction">AI 写作要求（可选）<textarea v-model="aiInstruction" class="form-textarea" rows="2" placeholder="例如：语气更简洁，突出返校时间。"></textarea></label>
          <div class="nt-generate-bar">
            <button class="btn btn-primary" :disabled="generating || requiredVariablesMissing()" @click="generate">
              <FileText :size="14" /> {{ generating ? 'AI 生成中…' : 'AI 生成通知初稿' }}
            </button>
            <span v-if="requiredVariablesMissing()" class="hint">请填写带 * 的信息</span>
          </div>
        </div>

        <div v-if="mobileStep === 3 && draftContent" class="card">
          <div class="nt-mobile-back">
            <button class="btn btn-sm btn-outline" @click="mobileStep = 2"><ChevronLeft :size="14" /> 返回修改</button>
            <span class="hint">{{ selectedSceneLabel }}</span>
          </div>
          <div class="nt-draft-label">AI 通知草稿（可编辑）</div>
          <textarea class="form-textarea nt-draft-textarea" v-model="draftContent" rows="8"></textarea>
          <div class="nt-draft-actions">
            <button class="btn btn-outline" @click="copyToClipboard"><Copy :size="14" /> 复制通知</button>
            <button class="btn btn-outline" @click="restoreOriginal"><RotateCcw :size="14" /> 恢复 AI 初稿</button>
          </div>
        </div>
      </div>

      <div v-else class="nt-layout">
        <div class="card nt-scene-panel">
          <div class="nt-panel-heading">
            <div>
              <div class="card-title"><FileText :size="16" /> 选择通知类型</div>
              <div class="nt-panel-helper">选择类型后填写关键事实，再由 AI 生成通知。</div>
            </div>
            <MessageCircle :size="18" class="nt-panel-heading-icon" aria-hidden="true" />
          </div>

          <div class="nt-scene-grid">
            <button v-for="scene in scenes" :key="scene.key" class="nt-scene-card" :class="{ active: selectedScene === scene.key }" @click="selectScene(scene.key)">
              <span class="nt-scene-card-icon"><component :is="scene.icon" :size="18" aria-hidden="true" /></span>
              <span class="nt-scene-card-copy"><strong>{{ scene.label }}</strong><small>{{ scene.description }}</small></span>
            </button>
          </div>

          <div v-if="selectedScene" class="nt-selected-template">
            <span class="nt-selected-template-icon"><FileText :size="16" aria-hidden="true" /></span>
            <span><strong>{{ selectedSceneLabel }}</strong><small>已选择通知类型，可以继续填写关键信息。</small></span>
            <button class="btn btn-sm btn-quiet" type="button" @click="goBackToScenes">更换</button>
          </div>
          <div v-else class="nt-selection-hint">选择上方通知类型后，这里会显示需要填写的信息。</div>

          <template v-if="templateDetail">
            <div v-if="templateDetail.variables?.length" class="nt-variable-form nt-desktop-variable-form">
              <div class="nt-variable-title">关键信息清单</div>
              <div class="form-grid">
                <label v-for="v in templateDetail.variables" :key="v.name">
                  <span class="nt-field-label">{{ v.label || v.name }}<span v-if="v.required" class="nt-required">*</span></span>
                  <input v-if="v.format === 'date'" class="form-input" type="date" v-model="variableValues[v.name]" :required="v.required" />
                  <input v-else class="form-input" type="text" v-model="variableValues[v.name]" :placeholder="v.default_value || ''" :required="v.required" />
                </label>
              </div>
            </div>
            <label class="nt-ai-instruction">AI 写作要求（可选）<textarea v-model="aiInstruction" class="form-textarea" rows="2" placeholder="例如：语气更简洁，突出返校时间。"></textarea></label>
            <div class="nt-generate-bar nt-desktop-generate-bar">
              <button class="btn btn-primary" :disabled="generating || requiredVariablesMissing()" @click="generate">
                <FileText :size="14" /> {{ generating ? 'AI 生成中…' : 'AI 生成通知初稿' }}
              </button>
              <span v-if="requiredVariablesMissing()" class="hint">请填写带 * 的信息</span>
            </div>
          </template>
        </div>

        <div class="card nt-content-panel nt-preview-panel">
          <div class="nt-preview-header">
            <div>
              <div class="card-title">微信通知预览</div>
              <div class="nt-panel-helper">生成后可继续修改，确认无误后再复制到微信发送。</div>
            </div>
            <div class="nt-preview-actions">
              <button class="btn btn-outline" :disabled="!draftContent" @click="copyToClipboard"><Copy :size="14" /> 复制通知</button>
            </div>
          </div>

          <div class="nt-preview-compose">
            <div class="nt-preview-author">
              <span class="nt-preview-avatar">班</span>
              <span><strong>班主任</strong><small>{{ selectedSceneLabel || 'AI 通知草稿' }}</small></span>
            </div>
            <textarea class="form-textarea nt-preview-textarea" v-model="draftContent" :placeholder="selectedScene ? '填写左侧信息后，点击“AI 生成通知初稿”' : '先选择左侧通知类型'" rows="12"></textarea>
            <div class="nt-preview-footer">
              <span v-if="generatedContent">AI 草稿仅供人工审核，事实信息来自左侧填写内容。</span>
              <span v-else>草稿将在这里显示，你可以随时手动修改。</span>
              <button v-if="generatedContent" class="btn btn-sm btn-quiet" @click="restoreOriginal"><RotateCcw :size="13" /> 恢复 AI 初稿</button>
            </div>
          </div>
        </div>
      </div>

    </template>

    <template v-if="activeTab === 'meetings'">
      <div v-if="mpMessage" class="inline-message">{{ mpMessage }}</div>
      <div v-if="mpCopyMessage" class="inline-message">{{ mpCopyMessage }}</div>

      <div class="mp-layout">
        <section class="card mp-config-panel" aria-labelledby="mp-config-title">
          <div class="mp-config-heading">
            <span class="mp-heading-icon"><Sparkles :size="18" aria-hidden="true" /></span>
            <div>
              <h2 id="mp-config-title">准备本次会谈</h2>
              <p>告诉 AI 要和谁谈、重点谈什么。</p>
            </div>
          </div>

          <div class="mp-form-stack">
            <label class="mp-field">
              <span>学生</span>
              <select class="form-select" v-model="mpStudentId" aria-label="选择学生">
                <option value="">请选择学生</option>
                <option v-for="s in mpStudents" :key="s.id" :value="s.id">{{ s['姓名'] }} · {{ s['学号'] }}</option>
              </select>
            </label>

            <label class="mp-field">
              <span>本次会谈目的</span>
              <select class="form-select" v-model="mpPurpose">
                <option v-for="purpose in meetingPurposeOptions" :key="purpose" :value="purpose">{{ purpose }}</option>
              </select>
            </label>

            <label class="mp-field">
              <span>老师关注点 <small>可选</small></span>
              <textarea v-model="mpTeacherNotes" class="form-textarea" rows="3" placeholder="例如：近期数学成绩下降，希望了解在家学习节奏。"></textarea>
            </label>

            <details class="mp-advanced-details" :open="mpAdvancedOpen" @toggle="mpAdvancedOpen = $event.target.open">
              <summary class="mp-advanced-summary">
                <span><SlidersHorizontal :size="15" aria-hidden="true" />资料范围</span>
                <small>{{ mpDateFrom }} 至 {{ mpDateTo }}</small>
              </summary>
              <div class="mp-advanced-body">
                <div class="form-grid">
                  <label>起始日期<input class="form-input" type="date" v-model="mpDateFrom" /></label>
                  <label>截止日期<input class="form-input" type="date" v-model="mpDateTo" /></label>
                </div>
                <div class="mp-category-title">读取资料</div>
                <div class="mp-category-list">
                  <label v-for="cat in categoryOptions" :key="cat.key" class="mp-category-check">
                    <input type="checkbox" v-model="mpCategories[cat.key]" /> {{ cat.label }}
                  </label>
                </div>
              </div>
            </details>

            <button class="btn btn-primary mp-ai-button" :disabled="!mpStudentId || !mpPurpose || mpGenerating" @click="mpGenerate">
              <Sparkles :size="15" aria-hidden="true" /> {{ mpGenerating ? '正在整理事实并生成方案…' : 'AI 准备会谈' }}
            </button>
            <p class="mp-scope-note">只读取当前班级与学期内、截至今天的记录；生成内容不会自动写入学生档案。</p>
          </div>
        </section>

        <section class="mp-results-panel" aria-live="polite">
          <div v-if="!mpSummaryResult" class="mp-empty-state">
            <span class="mp-empty-icon"><Target :size="24" aria-hidden="true" /></span>
            <div>
              <h2>准备一场有依据的沟通</h2>
              <p>AI 会先整理所选范围内的学生事实，再给出优势、关注点、待核实问题和可编辑提纲。</p>
            </div>
          </div>

          <template v-else>
            <div class="card mp-result-card">
              <header class="mp-result-header">
                <div>
                  <h2>{{ mpSelectedStudentName }} · {{ mpPurpose }}</h2>
                  <p>{{ mpSummaryResult.scope?.class_name }} · {{ mpSummaryResult.scope?.term_name }} · {{ mpSummaryResult.date_range?.start }} 至 {{ mpSummaryResult.date_range?.end }}</p>
                </div>
                <span v-if="mpPlan" class="mp-ai-badge"><Sparkles :size="13" aria-hidden="true" />AI 草稿</span>
              </header>

              <div v-if="mpPlan" class="mp-plan-content">
                <section class="mp-focus-block">
                  <h3><Target :size="16" aria-hidden="true" />本次重点</h3>
                  <p>{{ mpPlan.meeting_focus }}</p>
                </section>

                <div class="mp-plan-grid">
                  <section class="mp-plan-section">
                    <h3><CircleCheck :size="16" aria-hidden="true" />值得肯定</h3>
                    <ul v-if="mpPlan.strengths?.length" class="mp-insight-list">
                      <li v-for="(insight, index) in mpPlan.strengths" :key="`strength-${index}`">
                        <p>{{ insight.text }}</p>
                        <ul v-if="mpEvidenceFor(insight).length" class="mp-evidence-list">
                          <li v-for="fact in mpEvidenceFor(insight)" :key="fact.id">{{ fact.source_label }}<span v-if="fact.date"> · {{ fact.date }}</span> · {{ fact.text }}</li>
                        </ul>
                      </li>
                    </ul>
                    <p v-else class="mp-no-data">所选范围内没有足够事实。</p>
                  </section>

                  <section class="mp-plan-section">
                    <h3><CircleAlert :size="16" aria-hidden="true" />需要关注</h3>
                    <ul v-if="mpPlan.concerns?.length" class="mp-insight-list">
                      <li v-for="(insight, index) in mpPlan.concerns" :key="`concern-${index}`">
                        <p>{{ insight.text }}</p>
                        <ul v-if="mpEvidenceFor(insight).length" class="mp-evidence-list">
                          <li v-for="fact in mpEvidenceFor(insight)" :key="fact.id">{{ fact.source_label }}<span v-if="fact.date"> · {{ fact.date }}</span> · {{ fact.text }}</li>
                        </ul>
                      </li>
                    </ul>
                    <p v-else class="mp-no-data">所选范围内没有明确的关注事实。</p>
                  </section>

                  <section v-if="mpPlan.questions_to_verify?.length" class="mp-plan-section mp-plan-full">
                    <h3><HelpCircle :size="16" aria-hidden="true" />先向家长核实</h3>
                    <ol class="mp-number-list"><li v-for="question in mpPlan.questions_to_verify" :key="question">{{ question }}</li></ol>
                  </section>

                  <section class="mp-plan-section mp-plan-full">
                    <h3><MessageCircle :size="16" aria-hidden="true" />建议开场</h3>
                    <p class="mp-opening">{{ mpPlan.suggested_opening }}</p>
                  </section>

                  <section v-if="mpPlan.talking_points?.length" class="mp-plan-section">
                    <h3>沟通要点</h3>
                    <ol class="mp-number-list"><li v-for="point in mpPlan.talking_points" :key="point">{{ point }}</li></ol>
                  </section>

                  <section v-if="mpPlan.agreements_to_confirm?.length" class="mp-plan-section">
                    <h3>建议确认的行动</h3>
                    <ul class="mp-check-list"><li v-for="agreement in mpPlan.agreements_to_confirm" :key="agreement">{{ agreement }}</li></ul>
                  </section>
                </div>

                <div v-if="mpPlan.warnings?.length" class="mp-warning-list">
                  <strong>人工确认</strong>
                  <span v-for="warning in mpPlan.warnings" :key="warning">{{ warning }}</span>
                </div>

                <section class="mp-outline-area">
                  <div class="mp-outline-heading">
                    <div><h3>完整会谈提纲</h3><p>可直接修改，复制后再用于实际沟通。</p></div>
                    <div class="mp-outline-actions">
                      <button class="btn btn-outline" @click="mpCopyOutline"><Copy :size="14" /> 复制提纲</button>
                      <button class="btn btn-quiet" :disabled="mpGenerating" @click="mpGenerate"><RotateCcw :size="14" /> 重新生成</button>
                    </div>
                  </div>
                  <textarea class="form-textarea mp-outline-textarea" v-model="mpOutlineText" rows="12" aria-label="完整会谈提纲"></textarea>
                </section>
              </div>

              <div v-else-if="mpGenerating" class="mp-result-status">
                <Sparkles :size="18" aria-hidden="true" />正在读取事实并生成会谈方案…
              </div>
              <div v-else class="mp-result-status mp-result-status-warning">
                事实资料已整理；AI 方案暂未生成。你仍可以展开下方事实依据查看记录。
              </div>

              <details class="mp-facts-details">
                <summary>查看事实依据</summary>
                <div class="mp-summary-area">
                  <section v-for="section in mpSummaryResult.sections" :key="section.category" class="mp-section-card">
                    <div class="mp-section-head">
                      <strong>{{ section.category }}</strong>
                      <span class="mp-source-tag">{{ section.source_label }}</span>
                      <span v-if="section.date_range" class="mp-date-range">{{ section.date_range }}</span>
                    </div>
                    <div v-if="section.has_data" class="mp-section-items">
                      <div v-for="(item, idx) in section.items" :key="idx" class="mp-item-row">
                        <span v-if="mpItemDate(item)" class="mp-item-date">{{ mpItemDate(item) }}</span>
                        <span class="mp-item-text">{{ mpFormatItem(item) }}</span>
                      </div>
                    </div>
                    <div v-else class="mp-no-data">所选范围内暂无记录</div>
                  </section>
                </div>
              </details>
            </div>
          </template>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.communication-list {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 12px;
}

.communication-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 12px;
  min-height: 148px;
  box-sizing: border-box;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.communication-date {
  width: auto;
  align-self: start;
}

.communication-copy {
  align-self: start;
}

.communication-status {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
}

.parent-comm-segmented {
  margin-bottom: 16px;
}
.parent-comm-records-card .card-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.parent-comm-records-card .card-title-row .card-title {
  margin-bottom: 0;
}
.parent-comm-records-card .card-title-row .btn {
  margin-left: auto;
}
.nt-layout {
  display: grid;
  grid-template-columns: minmax(420px, .98fr) minmax(0, 1.02fr);
  align-items: stretch;
  gap: 16px;
}
.nt-scene-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.nt-panel-heading,
.nt-preview-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.nt-panel-heading .card-title,
.nt-preview-header .card-title {
  margin-bottom: 4px;
}
.nt-panel-helper {
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1.5;
}
.nt-panel-heading-icon {
  flex: 0 0 auto;
  color: var(--primary);
  margin-top: 1px;
}
.nt-scene-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.nt-scene-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  min-height: 74px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast), transform var(--transition-fast);
}
.nt-scene-card:hover {
  border-color: var(--primary-light);
  background: var(--surface-subtle);
}
.nt-scene-card.active {
  border-color: color-mix(in srgb, var(--primary) 35%, var(--border));
  background: var(--primary-bg);
}
.nt-scene-card:active {
  transform: translateY(1px);
}
.nt-scene-card-icon,
.nt-selected-template-icon {
  display: grid;
  place-items: center;
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--surface-subtle);
  color: var(--primary);
}
.nt-scene-card.active .nt-scene-card-icon {
  background: rgba(86, 99, 182, .14);
}
.nt-scene-card-copy,
.nt-selected-template > span:nth-child(2) {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.nt-scene-card-copy strong,
.nt-selected-template strong {
  font-size: 13px;
  font-weight: 600;
}
.nt-scene-card-copy small,
.nt-selected-template small {
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1.45;
}
.nt-template-picker {
  display: grid;
  gap: 5px;
  margin-top: 14px;
  color: var(--text-secondary);
  font-size: 12px;
}
.nt-template-picker label,
.nt-ai-instruction {
  display: grid;
  gap: 5px;
}
.nt-selected-template {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid rgba(86, 99, 182, .18);
  border-radius: 10px;
  background: var(--primary-bg);
}
.nt-selected-template-icon {
  flex-basis: 28px;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--surface);
}
.nt-selected-template > span:nth-child(2) {
  flex: 1;
}
.nt-selected-template .btn {
  flex: 0 0 auto;
}
.nt-selection-hint {
  margin-top: 14px;
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: center;
}
.nt-desktop-variable-form {
  margin-top: 18px;
  margin-bottom: 12px;
}
.nt-ai-instruction {
  color: var(--text-secondary);
  font-size: 12px;
}
.nt-ai-instruction .form-textarea {
  min-height: 58px;
  resize: vertical;
}
.nt-desktop-generate-bar {
  margin-top: auto;
  margin-bottom: 0;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.nt-scene-list {
  display: grid;
  gap: 2px;
}
.nt-scene-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  font-size: 14px;
}
.nt-scene-row:hover,
.nt-scene-row.active {
  background: var(--primary-bg);
}
.nt-scene-icon {
  flex: 0 0 24px;
  color: var(--primary);
}
.nt-scene-arrow {
  margin-left: auto;
  color: var(--text-tertiary);
}
.nt-template-list {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.nt-template-divider {
  font-size: 11px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: .5px;
  padding: 4px 12px;
}
.nt-template-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  font-size: 13px;
}
.nt-template-row:hover,
.nt-template-row.active {
  background: var(--primary-bg);
}
.nt-template-row .tag {
  margin-left: auto;
  font-size: 10px;
}
.nt-content-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 100%;
}
.nt-preview-actions {
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
}
.nt-preview-compose {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 360px;
  margin-top: 18px;
  padding: 22px;
  border: 1px solid rgba(73, 122, 93, .12);
  border-radius: 14px;
  background: var(--success-bg);
}
.nt-preview-author {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.nt-preview-author > span:last-child {
  display: grid;
  gap: 1px;
}
.nt-preview-author strong {
  font-size: 13px;
  font-weight: 600;
}
.nt-preview-author small {
  color: var(--text-tertiary);
  font-size: 11px;
}
.nt-preview-avatar {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: var(--success);
  color: #fff;
  font-size: 17px;
  font-weight: 700;
}
.nt-preview-textarea {
  flex: 1;
  min-height: 260px;
  border-color: rgba(73, 122, 93, .12);
  background: var(--surface);
  font-size: 14px;
  line-height: 1.75;
  resize: vertical;
}
.nt-preview-textarea:focus {
  border-color: var(--primary);
}
.nt-preview-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  color: var(--text-tertiary);
  font-size: 11px;
}
.btn-quiet {
  padding: 4px 6px;
  border: 0;
  background: transparent;
  color: var(--primary);
}
.btn-quiet:hover {
  background: rgba(86, 99, 182, .08);
}
.nt-variable-form {
  margin-bottom: 16px;
}
.nt-variable-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.nt-field-label {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  width: max-content;
}
.nt-required {
  color: var(--danger);
  font-size: 12px;
}
.nt-generate-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.nt-draft-area {
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.nt-draft-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.nt-draft-textarea {
  font-size: 14px;
  line-height: 1.7;
  min-height: 160px;
}
.nt-draft-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.card-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.card-title-row .card-title {
  margin-bottom: 0;
}
.card-title-row .record-actions {
  margin-left: auto;
}
.nt-mobile-flow {
  display: grid;
  gap: 12px;
}
.nt-mobile-steps {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
.nt-step {
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--bg);
}
.nt-step.active {
  background: var(--primary-bg);
  color: var(--primary);
  font-weight: 500;
}
.nt-step-arrow {
  color: var(--text-tertiary);
}
.nt-mobile-back {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.mp-layout {
  display: grid;
  grid-template-columns: minmax(290px, 340px) minmax(0, 1fr);
  align-items: start;
  gap: 20px;
}
.mp-config-panel {
  position: sticky;
  top: 16px;
  align-self: start;
}
.mp-config-heading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 20px;
}
.mp-heading-icon,
.mp-empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  color: var(--primary);
  background: var(--primary-bg);
}
.mp-config-heading h2,
.mp-result-header h2,
.mp-empty-state h2 {
  margin: 0;
  font-size: 17px;
  line-height: 1.4;
}
.mp-config-heading p,
.mp-result-header p,
.mp-empty-state p {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.mp-form-stack,
.mp-field {
  display: grid;
}
.mp-form-stack {
  gap: 14px;
}
.mp-field {
  gap: 6px;
}
.mp-field > span,
.mp-advanced-body label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 500;
}
.mp-field > span small {
  margin-left: 4px;
  color: var(--text-tertiary);
  font-weight: 400;
}
.mp-advanced-details {
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.mp-advanced-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 42px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 12px;
}
.mp-advanced-summary > span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text);
  font-weight: 600;
}
.mp-advanced-summary small {
  color: var(--text-tertiary);
  font-size: 10px;
}
.mp-advanced-body {
  display: grid;
  gap: 12px;
  padding: 4px 0 14px;
}
.mp-category-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.mp-category-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}
.mp-category-check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  cursor: pointer;
}
.mp-category-check input[type="checkbox"] {
  margin: 0;
}
.mp-ai-button {
  width: 100%;
  min-height: 42px;
  justify-content: center;
}
.mp-scope-note {
  margin: -4px 0 0;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1.55;
}
.mp-results-panel {
  min-width: 0;
  align-self: start;
}
.mp-empty-state {
  min-height: 420px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  box-sizing: border-box;
  padding: 32px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  text-align: left;
}
.mp-empty-state > div {
  max-width: 420px;
}
.mp-result-card {
  min-width: 0;
}
.mp-result-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}
.mp-ai-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  padding: 5px 9px;
  border-radius: 999px;
  color: var(--primary);
  background: var(--primary-bg);
  font-size: 11px;
  font-weight: 600;
}
.mp-plan-content {
  display: grid;
  gap: 18px;
}
.mp-focus-block {
  margin-top: 16px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--primary-bg);
}
.mp-focus-block h3,
.mp-plan-section h3,
.mp-outline-heading h3 {
  margin: 0;
  font-size: 13px;
}
.mp-focus-block h3,
.mp-plan-section h3 {
  display: flex;
  align-items: center;
  gap: 7px;
}
.mp-focus-block p {
  margin: 7px 0 0;
  font-size: 14px;
  line-height: 1.7;
}
.mp-plan-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px 24px;
}
.mp-plan-section {
  min-width: 0;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.mp-plan-full {
  grid-column: 1 / -1;
}
.mp-insight-list,
.mp-evidence-list,
.mp-number-list,
.mp-check-list {
  margin: 10px 0 0;
  padding-left: 20px;
}
.mp-insight-list,
.mp-number-list,
.mp-check-list {
  display: grid;
  gap: 10px;
  color: var(--text);
  font-size: 13px;
  line-height: 1.65;
}
.mp-insight-list > li > p {
  margin: 0;
}
.mp-evidence-list {
  display: grid;
  gap: 4px;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1.5;
}
.mp-opening {
  margin: 10px 0 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--bg);
  font-size: 13px;
  line-height: 1.75;
}
.mp-warning-list {
  display: grid;
  gap: 5px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
}
.mp-warning-list strong {
  color: var(--text);
}
.mp-outline-area {
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.mp-outline-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 10px;
}
.mp-outline-heading p {
  margin: 4px 0 0;
  color: var(--text-tertiary);
  font-size: 11px;
}
.mp-outline-textarea {
  min-height: 260px;
  font-size: 13px;
  line-height: 1.7;
}
.mp-outline-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.mp-result-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 240px;
  color: var(--text-secondary);
  font-size: 13px;
}
.mp-result-status-warning {
  min-height: 120px;
  justify-content: flex-start;
}
.mp-facts-details {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.mp-facts-details > summary {
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.mp-facts-details[open] > summary {
  margin-bottom: 12px;
}
.mp-summary-area {
  display: grid;
  gap: 0;
}
.mp-section-card {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.mp-section-card:last-child {
  border-bottom: 0;
}
.mp-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.mp-section-head strong {
  font-size: 13px;
}
.mp-source-tag {
  font-size: 10px;
  color: var(--text-tertiary);
  background: var(--bg);
  padding: 2px 6px;
  border-radius: 4px;
}
.mp-date-range {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-left: auto;
}
.mp-section-items {
  display: grid;
  gap: 4px;
}
.mp-item-row {
  display: flex;
  gap: 8px;
  font-size: 13px;
  line-height: 1.6;
}
.mp-item-date {
  color: var(--text-tertiary);
  font-size: 12px;
  white-space: nowrap;
  min-width: 80px;
}
.mp-item-text {
  flex: 1;
}
.mp-no-data {
  font-size: 13px;
  color: var(--text-tertiary);
  padding: 4px 0;
}

@media (min-width: 761px) and (max-width: 1000px) {
  .nt-layout {
    grid-template-columns: 1fr;
  }

  .nt-preview-compose {
    min-height: 320px;
  }

  .mp-layout {
    grid-template-columns: 1fr;
  }

  .mp-config-panel {
    position: static;
  }
}

@media (max-width: 760px) {
  .communication-list {
    grid-template-columns: 1fr;
  }

  .communication-row {
    min-height: 0;
  }

  .mp-layout,
  .mp-plan-grid {
    grid-template-columns: 1fr;
  }

  .mp-layout {
    gap: 12px;
  }

  .mp-config-panel {
    position: static;
  }

  .mp-plan-full {
    grid-column: auto;
  }

  .mp-result-header,
  .mp-outline-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .mp-outline-actions {
    justify-content: flex-start;
  }

  .mp-empty-state {
    min-height: 260px;
    align-items: flex-start;
  }

  .mp-date-range {
    width: 100%;
    margin-left: 0;
  }
}
</style>
