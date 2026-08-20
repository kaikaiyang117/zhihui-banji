<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { MessageCircle, Plus, Trash2, Copy, RotateCcw, Save, FileText, ChevronRight, ChevronLeft, LockKeyhole, ChevronDown, Eye, EyeOff } from 'lucide-vue-next'
import { del, get, listNotificationTemplates, ensureNotificationTemplates, getNotificationTemplate, generateNotificationContent, savePersonalTemplate, deleteNotificationTemplate, restoreNotificationTemplate, generateMeetingSummary, generateMeetingOutline } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'
import WorkflowModal from '../components/WorkflowModal.vue'
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
  health: false,
})
const mpHealthExpanded = ref(false)
const mpSummaryResult = ref(null)
const mpOutlineText = ref('')
const mpGenerating = ref(false)
const mpGeneratingOutline = ref(false)
const mpMessage = ref('')
const mpCopyMessage = ref('')
const mpMobileStep = ref(1)
const mpStudentSearch = ref('')

const mpFilteredStudents = computed(() => {
  const q = mpStudentSearch.value.trim().toLowerCase()
  if (!q) return mpStudents.value
  return mpStudents.value.filter(s =>
    (s['姓名'] || '').toLowerCase().includes(q) || String(s['学号'] || '').toLowerCase().includes(q)
  )
})

const mpSelectedStudentName = computed(() => {
  if (!mpStudentId.value) return ''
  const s = mpStudents.value.find(s => s.id === Number(mpStudentId.value))
  return s ? s['姓名'] : ''
})

const categoryOptions = [
  { key: 'scores', label: '成绩', param: 'include_scores' },
  { key: 'attendance', label: '考勤', param: 'include_attendance' },
  { key: 'points', label: '积分', param: 'include_points' },
  { key: 'communications', label: '家校沟通', param: 'include_communications' },
  { key: 'events', label: '事件', param: 'include_events' },
]

async function mpLoadStudents() {
  try {
    mpStudents.value = (await get('/api/students')).students || []
  } catch { }
}

async function mpGenerate() {
  if (!mpStudentId.value) return
  mpGenerating.value = true
  mpMessage.value = ''
  mpSummaryResult.value = null
  mpOutlineText.value = ''
  try {
    const params = {
      student_id: Number(mpStudentId.value),
      date_start: mpDateFrom.value || undefined,
      date_end: mpDateTo.value || undefined,
      include_scores: mpCategories.value.scores,
      include_attendance: mpCategories.value.attendance,
      include_points: mpCategories.value.points,
      include_communications: mpCategories.value.communications,
      include_events: mpCategories.value.events,
      include_health: mpCategories.value.health && mpHealthExpanded.value,
    }
    mpSummaryResult.value = await generateMeetingSummary(params)
    if (isMobile.value) mpMobileStep.value = 3
  } catch (e) {
    mpMessage.value = `生成失败：${e.message}`
  } finally {
    mpGenerating.value = false
  }
}

async function mpGenerateOutline() {
  if (!mpSummaryResult.value) return
  mpGeneratingOutline.value = true
  mpMessage.value = ''
  try {
    const result = await generateMeetingOutline({
      student_id: Number(mpStudentId.value),
      summary: mpSummaryResult.value,
    })
    mpOutlineText.value = result.outline || ''
  } catch (e) {
    mpMessage.value = `提纲生成失败：${e.message}`
  } finally {
    mpGeneratingOutline.value = false
  }
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

function mpReset() {
  mpSummaryResult.value = null
  mpOutlineText.value = ''
  mpMessage.value = ''
  if (isMobile.value) mpMobileStep.value = 2
}

function mpGoBack() {
  if (isMobile.value) {
    if (mpMobileStep.value === 3) mpMobileStep.value = 2
    else if (mpMobileStep.value === 2) mpMobileStep.value = 1
  }
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
  mpMobileStep.value = 1
  if (!mpStudents.value.length) mpLoadStudents()
}

watch(() => activeTab.value, (tab) => {
  if (tab === 'meetings' && !mpStudents.value.length) mpLoadStudents()
})

const scenes = [
  { key: '放假通知', label: '放假通知', icon: '🏖️' },
  { key: '安全提醒', label: '安全提醒', icon: '🛡️' },
  { key: '调课通知', label: '调课通知', icon: '📅' },
  { key: '班级活动', label: '班级活动', icon: '🎉' },
  { key: '材料收集', label: '材料收集', icon: '📋' },
]
const templates = ref([])
const selectedScene = ref(null)
const selectedTemplate = ref(null)
const templateDetail = ref(null)
const variableValues = ref({})
const generatedContent = ref('')
const draftContent = ref('')
const generating = ref(false)
const savingTemplate = ref(false)
const templateMessage = ref('')
const mobileStep = ref(1)
const showSaveDialog = ref(false)
const saveTemplateName = ref('')
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
  templateMessage.value = ''
  await loadTemplates()
  if (templates.value.length === 1) {
    await selectTemplate(templates.value[0])
  }
  if (isMobile.value) mobileStep.value = 2
}

async function selectTemplate(tpl) {
  selectedTemplate.value = tpl
  const data = await getNotificationTemplate(tpl.id)
  templateDetail.value = data
  variableValues.value = {}
  if (data.variables) {
    data.variables.forEach(v => {
      variableValues.value[v.name] = v.default_value || ''
    })
  }
  generatedContent.value = ''
  draftContent.value = ''
  templateMessage.value = ''
  if (isMobile.value) mobileStep.value = 3
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
    const result = await generateNotificationContent(selectedTemplate.value.id, variableValues.value)
    generatedContent.value = result.content || ''
    draftContent.value = result.content || ''
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
  templateMessage.value = '已恢复原模板文案'
  setTimeout(() => { templateMessage.value = '' }, 2000)
}

function openSaveDialog() {
  saveTemplateName.value = ''
  showSaveDialog.value = true
}

async function saveAsPersonal() {
  if (!saveTemplateName.value.trim() || !draftContent.value) return
  savingTemplate.value = true
  templateMessage.value = ''
  try {
    await savePersonalTemplate(selectedTemplate.value?.id || null, saveTemplateName.value.trim(), draftContent.value)
    templateMessage.value = '已保存为个人模板'
    showSaveDialog.value = false
    await loadTemplates()
  } catch (e) {
    templateMessage.value = `保存失败：${e.message}`
  } finally {
    savingTemplate.value = false
  }
}

async function removeTemplate(tpl) {
  if (!(await confirmDialog({ title: '删除模板？', message: `将删除"${tpl.name}"，系统模板删除后可恢复。`, confirmText: '删除' }))) return
  try {
    await deleteNotificationTemplate(tpl.id)
    if (selectedTemplate.value?.id === tpl.id) {
      selectedTemplate.value = null
      templateDetail.value = null
    }
    await loadTemplates()
  } catch (e) {
    templateMessage.value = `删除失败：${e.message}`
  }
}

async function restoreTemplate(tpl) {
  try {
    await restoreNotificationTemplate(tpl.id)
    await loadTemplates()
    templateMessage.value = '模板已恢复'
    setTimeout(() => { templateMessage.value = '' }, 2000)
  } catch (e) {
    templateMessage.value = `恢复失败：${e.message}`
  }
}

function goBackToScenes() {
  mobileStep.value = 1
  selectedScene.value = null
  templates.value = []
  selectedTemplate.value = null
  templateDetail.value = null
}

function goBackToTemplates() {
  mobileStep.value = 2
  selectedTemplate.value = null
  templateDetail.value = null
  generatedContent.value = ''
  draftContent.value = ''
}

function onTabTemplates() {
  activeTab.value = 'templates'
  mobileStep.value = 1
  selectedScene.value = null
  loadTemplates()
}

onMounted(() => {
  load()
  if (studentId) mpLoadStudents()
  window.addEventListener('resize', onResize)
})
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <div>
    <div class="page-title-bar"><div><div class="page-title">家校沟通</div><div class="page-subtitle">记录沟通内容，也记住双方约定的下一步</div></div></div>

    <div class="segmented parent-comm-segmented">
      <button :class="{ active: activeTab === 'records' }" @click="activeTab = 'records'">沟通记录</button>
      <button :class="{ active: activeTab === 'templates' }" @click="onTabTemplates">通知模板</button>
      <button :class="{ active: activeTab === 'meetings' }" @click="onTabMeetings">会谈准备</button>
    </div>

    <template v-if="activeTab === 'records'">
      <div class="overview-cards">
        <div class="overview-card"><div class="oc-label">本页记录</div><div class="oc-value">{{ communications.length }}</div></div>
        <div class="overview-card"><div class="oc-label">需要回访</div><div class="oc-value">{{ communications.filter(c => c.followup_at && c.status !== '已完成').length }}</div></div>
        <div class="overview-card"><div class="oc-label">电话沟通</div><div class="oc-value">{{ communications.filter(c => c.method === '电话').length }}</div></div>
      </div>
      <div class="card parent-comm-records-card">
        <div class="card-title-row"><span class="card-title"><MessageCircle :size="16" /> 沟通台账</span><button class="btn btn-primary btn-sm" @click="showAdd = true"><Plus :size="14" /> 记录沟通</button></div>
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

    <template v-if="activeTab === 'templates'">
      <div v-if="templateMessage" class="inline-message">{{ templateMessage }}</div>
      <div v-if="copyMessage" class="inline-message">{{ copyMessage }}</div>

      <div v-if="isMobile" class="nt-mobile-flow">
        <div class="nt-mobile-steps">
          <span class="nt-step" :class="{ active: mobileStep === 1 }">1 选模板</span>
          <span class="nt-step-arrow">›</span>
          <span class="nt-step" :class="{ active: mobileStep === 2 }">2 填信息</span>
          <span class="nt-step-arrow">›</span>
          <span class="nt-step" :class="{ active: mobileStep === 3 }">3 编辑复制</span>
        </div>

        <div v-if="mobileStep === 1" class="card">
          <div class="card-title"><FileText :size="16" /> 选择场景</div>
          <div class="nt-scene-list">
            <button v-for="scene in scenes" :key="scene.key" class="nt-scene-row" :class="{ active: selectedScene === scene.key }" @click="selectScene(scene.key)">
              <span class="nt-scene-icon">{{ scene.icon }}</span>
              <span>{{ scene.label }}</span>
              <ChevronRight :size="14" class="nt-scene-arrow" />
            </button>
          </div>
        </div>

        <div v-if="mobileStep === 2" class="card">
          <div class="nt-mobile-back">
            <button class="btn btn-sm btn-outline" @click="goBackToScenes"><ChevronLeft :size="14" /> 返回场景</button>
            <span class="hint">{{ selectedScene }}</span>
          </div>
          <div v-if="!templates.length" class="empty-state">该场景暂无模板</div>
          <template v-else>
            <div class="card-title">选择模板</div>
            <div class="nt-scene-list">
              <button v-for="tpl in templates" :key="tpl.id" class="nt-template-row" :class="{ active: selectedTemplate?.id === tpl.id }" @click="selectTemplate(tpl)">
                <span>{{ tpl.name }}</span>
                <span class="tag" :class="tpl.is_system ? 'tag-green' : 'tag-orange'">{{ tpl.is_system ? '系统' : '个人' }}</span>
                <ChevronRight :size="14" class="nt-scene-arrow" />
              </button>
            </div>
          </template>
        </div>

        <div v-if="mobileStep === 3 && templateDetail" class="card">
          <div class="nt-mobile-back">
            <button class="btn btn-sm btn-outline" @click="goBackToTemplates"><ChevronLeft :size="14" /> 返回模板</button>
            <span class="hint">{{ templateDetail.name }}</span>
          </div>
          <div class="card-title-row">
            <span class="card-title">{{ templateDetail.name }}</span>
            <span class="tag" :class="templateDetail.is_system ? 'tag-green' : 'tag-orange'">{{ templateDetail.is_system ? '系统模板' : '个人模板' }}</span>
            <div class="record-actions">
              <button v-if="templateDetail.is_deleted" class="btn btn-sm btn-outline" @click="restoreTemplate(templateDetail)"><RotateCcw :size="13" /> 恢复</button>
              <button v-else class="btn btn-sm btn-outline" @click="removeTemplate(templateDetail)"><Trash2 :size="13" /></button>
            </div>
          </div>
          <div v-if="templateDetail.description" class="hint" style="margin-bottom:12px">{{ templateDetail.description }}</div>
          <div v-if="templateDetail.variables?.length" class="nt-variable-form">
            <div class="nt-variable-title">填写变量</div>
            <div class="form-grid">
              <label v-for="v in templateDetail.variables" :key="v.name">
                {{ v.label || v.name }}<span v-if="v.required" class="nt-required">*</span>
                <input v-if="v.format === 'date'" class="form-input" type="date" v-model="variableValues[v.name]" />
                <input v-else class="form-input" type="text" v-model="variableValues[v.name]" :placeholder="v.default_value || ''" />
              </label>
            </div>
          </div>
          <div class="nt-generate-bar">
            <button class="btn btn-primary" :disabled="generating || requiredVariablesMissing()" @click="generate">
              <FileText :size="14" /> {{ generating ? '生成中…' : '生成文案' }}
            </button>
            <span v-if="requiredVariablesMissing()" class="hint">请填写必填变量</span>
          </div>
          <div v-if="generatedContent" class="nt-draft-area">
            <div class="nt-draft-label">草稿</div>
            <textarea class="form-textarea nt-draft-textarea" v-model="draftContent" rows="8"></textarea>
            <div class="nt-draft-actions">
              <button class="btn btn-outline" @click="copyToClipboard"><Copy :size="14" /> 复制</button>
              <button class="btn btn-outline" @click="restoreOriginal"><RotateCcw :size="14" /> 恢复原模板</button>
              <button class="btn btn-outline" @click="openSaveDialog"><Save :size="14" /> 另存为个人模板</button>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="nt-layout">
        <div class="card nt-scene-panel">
          <div class="card-title"><FileText :size="16" /> 选择场景</div>
          <div class="nt-scene-list">
            <button v-for="scene in scenes" :key="scene.key" class="nt-scene-row" :class="{ active: selectedScene === scene.key }" @click="selectScene(scene.key)">
              <span class="nt-scene-icon">{{ scene.icon }}</span>
              <span>{{ scene.label }}</span>
              <ChevronRight v-if="selectedScene === scene.key" :size="14" class="nt-scene-arrow" />
            </button>
          </div>
          <div v-if="templates.length && selectedScene" class="nt-template-list">
            <div class="nt-template-divider">模板</div>
            <button v-for="tpl in templates" :key="tpl.id" class="nt-template-row" :class="{ active: selectedTemplate?.id === tpl.id }" @click="selectTemplate(tpl)">
              <span>{{ tpl.name }}</span>
              <span class="tag" :class="tpl.is_system ? 'tag-green' : 'tag-orange'">{{ tpl.is_system ? '系统' : '个人' }}</span>
              <ChevronRight v-if="selectedTemplate?.id === tpl.id" :size="14" class="nt-scene-arrow" />
            </button>
          </div>
          <div v-else-if="selectedScene && !templates.length" class="hint" style="padding:12px 0">该场景暂无模板</div>
        </div>

        <div class="card nt-content-panel">
          <div v-if="!selectedScene" class="empty-state">请先选择左侧场景</div>
          <div v-else-if="!templateDetail" class="empty-state">请选择模板</div>
          <template v-else>
            <div class="card-title-row">
              <span class="card-title">{{ templateDetail.name }}</span>
              <span class="tag" :class="templateDetail.is_system ? 'tag-green' : 'tag-orange'">{{ templateDetail.is_system ? '系统模板' : '个人模板' }}</span>
              <div class="record-actions">
                <button v-if="templateDetail.is_deleted" class="btn btn-sm btn-outline" @click="restoreTemplate(templateDetail)"><RotateCcw :size="13" /> 恢复</button>
                <button v-else class="btn btn-sm btn-outline" @click="removeTemplate(templateDetail)"><Trash2 :size="13" /></button>
              </div>
            </div>
            <div v-if="templateDetail.description" class="hint" style="margin-bottom:12px">{{ templateDetail.description }}</div>
            <div v-if="templateDetail.variables?.length" class="nt-variable-form">
              <div class="nt-variable-title">填写变量</div>
              <div class="form-grid">
                <label v-for="v in templateDetail.variables" :key="v.name">
                  {{ v.label || v.name }}<span v-if="v.required" class="nt-required">*</span>
                  <input v-if="v.format === 'date'" class="form-input" type="date" v-model="variableValues[v.name]" />
                  <input v-else class="form-input" type="text" v-model="variableValues[v.name]" :placeholder="v.default_value || ''" />
                </label>
              </div>
            </div>
            <div class="nt-generate-bar">
              <button class="btn btn-primary" :disabled="generating || requiredVariablesMissing()" @click="generate">
                <FileText :size="14" /> {{ generating ? '生成中…' : '生成文案' }}
              </button>
              <span v-if="requiredVariablesMissing()" class="hint">请填写必填变量</span>
            </div>
            <div v-if="generatedContent" class="nt-draft-area">
              <div class="nt-draft-label">草稿</div>
              <textarea class="form-textarea nt-draft-textarea" v-model="draftContent" rows="8"></textarea>
              <div class="nt-draft-actions">
                <button class="btn btn-outline" @click="copyToClipboard"><Copy :size="14" /> 复制</button>
                <button class="btn btn-outline" @click="restoreOriginal"><RotateCcw :size="14" /> 恢复原模板</button>
                <button class="btn btn-outline" @click="openSaveDialog"><Save :size="14" /> 另存为个人模板</button>
              </div>
            </div>
          </template>
        </div>
      </div>

      <div v-if="showSaveDialog" class="modal-overlay show" @click.self="showSaveDialog = false">
        <div class="modal">
          <div class="modal-kicker">另存为个人模板</div>
          <h3>保存当前草稿</h3>
          <label style="display:grid;gap:5px;color:var(--text-secondary);font-size:12px">模板名称<input class="form-input" v-model="saveTemplateName" placeholder="如：期末放假通知（个人版）" /></label>
          <div class="modal-actions">
            <button class="btn btn-outline" @click="showSaveDialog = false">取消</button>
            <button class="btn btn-primary" :disabled="savingTemplate || !saveTemplateName.trim()" @click="saveAsPersonal">{{ savingTemplate ? '保存中…' : '保存' }}</button>
          </div>
        </div>
      </div>
    </template>

    <template v-if="activeTab === 'meetings'">
      <div v-if="mpMessage" class="inline-message">{{ mpMessage }}</div>
      <div v-if="mpCopyMessage" class="inline-message">{{ mpCopyMessage }}</div>

      <div v-if="isMobile" class="mp-mobile-flow">
        <div class="nt-mobile-steps">
          <span class="nt-step" :class="{ active: mpMobileStep === 1 }">1 选学生</span>
          <span class="nt-step-arrow">›</span>
          <span class="nt-step" :class="{ active: mpMobileStep === 2 }">2 选条件</span>
          <span class="nt-step-arrow">›</span>
          <span class="nt-step" :class="{ active: mpMobileStep === 3 }">3 查看结果</span>
        </div>

        <div v-if="mpMobileStep === 1" class="card">
          <div class="card-title"><MessageCircle :size="16" /> 选择学生</div>
          <input class="form-input" v-model="mpStudentSearch" placeholder="搜索姓名或学号" style="margin-bottom:10px" />
          <div v-if="!mpFilteredStudents.length" class="empty-state">暂无学生</div>
          <div v-else class="mp-student-list">
            <button v-for="s in mpFilteredStudents" :key="s.id" class="mp-student-row" :class="{ active: mpStudentId === s.id }" @click="mpStudentId = s.id; mpMobileStep = 2">
              <strong>{{ s['姓名'] }}</strong><small>{{ s['学号'] }}</small>
              <ChevronRight :size="14" class="nt-scene-arrow" />
            </button>
          </div>
        </div>

        <div v-if="mpMobileStep === 2" class="card">
          <div class="nt-mobile-back">
            <button class="btn btn-sm btn-outline" @click="mpMobileStep = 1"><ChevronLeft :size="14" /> 返回</button>
            <span class="hint">{{ mpSelectedStudentName }}</span>
          </div>
          <div class="mp-options-form">
            <div class="form-grid">
              <label>起始日期<input class="form-input" type="date" v-model="mpDateFrom" /></label>
              <label>截止日期<input class="form-input" type="date" v-model="mpDateTo" /></label>
            </div>
            <div class="mp-category-group">
              <div class="mp-category-title">事实类别</div>
              <div class="mp-category-list">
                <label v-for="cat in categoryOptions" :key="cat.key" class="mp-category-check">
                  <input type="checkbox" v-model="mpCategories[cat.key]" /> {{ cat.label }}
                </label>
              </div>
              <details class="mp-sensitive-details" :open="mpHealthExpanded" @toggle="mpHealthExpanded = $event.target.open">
                <summary class="mp-sensitive-summary">
                  <LockKeyhole :size="13" /> 健康数据
                  <span class="mp-sensitive-note">包含敏感信息，需授权查看</span>
                </summary>
                <div class="mp-sensitive-content">
                  <label class="mp-category-check">
                    <input type="checkbox" v-model="mpCategories.health" /> 包含健康数据
                  </label>
                  <p class="hint">健康数据属于敏感信息，确认已获得查看授权后再勾选。</p>
                </div>
              </details>
            </div>
            <button class="btn btn-primary" :disabled="!mpStudentId || mpGenerating" @click="mpGenerate">
              <FileText :size="14" /> {{ mpGenerating ? '生成中…' : '生成事实摘要' }}
            </button>
          </div>
        </div>

        <div v-if="mpMobileStep === 3 && mpSummaryResult" class="card">
          <div class="nt-mobile-back">
            <button class="btn btn-sm btn-outline" @click="mpReset"><ChevronLeft :size="14" /> 返回条件</button>
            <span class="hint">{{ mpSelectedStudentName }}</span>
          </div>

          <div class="mp-section-divider"><span>事实摘要</span></div>
          <div class="mp-summary-area">
            <div v-for="section in mpSummaryResult.sections" :key="section.category" class="mp-section-card">
              <div class="mp-section-head">
                <strong>{{ section.category }}</strong>
                <span class="mp-source-tag">{{ section.source }}</span>
                <span v-if="section.date_range" class="mp-date-range">{{ section.date_range }}</span>
              </div>
              <div v-if="section.has_data" class="mp-section-items">
                <div v-for="(item, idx) in section.items" :key="idx" class="mp-item-row">
                  <span v-if="mpItemDate(item)" class="mp-item-date">{{ mpItemDate(item) }}</span>
                  <span class="mp-item-text">{{ mpFormatItem(item) }}</span>
                </div>
              </div>
              <div v-else class="mp-no-data">暂无记录</div>
            </div>
          </div>

          <div class="mp-section-divider"><span>会谈提纲</span></div>
          <div class="mp-outline-area">
            <div v-if="!mpOutlineText" class="mp-outline-actions">
              <button class="btn btn-primary" :disabled="mpGeneratingOutline" @click="mpGenerateOutline">
                <FileText :size="14" /> {{ mpGeneratingOutline ? '生成中…' : '生成提纲' }}
              </button>
            </div>
            <template v-else>
              <textarea class="form-textarea mp-outline-textarea" v-model="mpOutlineText" rows="10"></textarea>
              <div class="mp-outline-actions">
                <button class="btn btn-outline" @click="mpCopyOutline"><Copy :size="14" /> 复制提纲</button>
                <button class="btn btn-outline" @click="mpGenerateOutline" :disabled="mpGeneratingOutline"><RotateCcw :size="14" /> 重新生成</button>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div v-else class="mp-layout">
        <div class="card mp-config-panel">
          <div class="card-title"><MessageCircle :size="16" /> 会谈准备</div>
          <div class="mp-student-select">
            <label>学生</label>
            <input class="form-input" v-model="mpStudentSearch" placeholder="搜索姓名或学号" />
            <select class="form-select" v-model="mpStudentId">
              <option value="">请选择学生</option>
              <option v-for="s in mpFilteredStudents" :key="s.id" :value="s.id">{{ s['姓名'] }} · {{ s['学号'] }}</option>
            </select>
          </div>
          <div class="form-grid">
            <label>起始日期<input class="form-input" type="date" v-model="mpDateFrom" /></label>
            <label>截止日期<input class="form-input" type="date" v-model="mpDateTo" /></label>
          </div>
          <div class="mp-category-group">
            <div class="mp-category-title">事实类别</div>
            <div class="mp-category-list">
              <label v-for="cat in categoryOptions" :key="cat.key" class="mp-category-check">
                <input type="checkbox" v-model="mpCategories[cat.key]" /> {{ cat.label }}
              </label>
            </div>
            <details class="mp-sensitive-details" :open="mpHealthExpanded" @toggle="mpHealthExpanded = $event.target.open">
              <summary class="mp-sensitive-summary">
                <LockKeyhole :size="13" /> 健康数据
                <span class="mp-sensitive-note">包含敏感信息，需授权查看</span>
              </summary>
              <div class="mp-sensitive-content">
                <label class="mp-category-check">
                  <input type="checkbox" v-model="mpCategories.health" /> 包含健康数据
                </label>
                <p class="hint">健康数据属于敏感信息，确认已获得查看授权后再勾选。</p>
              </div>
            </details>
          </div>
          <button class="btn btn-primary" :disabled="!mpStudentId || mpGenerating" @click="mpGenerate">
            <FileText :size="14" /> {{ mpGenerating ? '生成中…' : '生成事实摘要' }}
          </button>
        </div>

        <div class="mp-results-panel">
          <div v-if="!mpSummaryResult" class="empty-state">选择学生和条件后生成事实摘要</div>
          <template v-else>
            <div class="mp-section-divider"><span>事实摘要（只读）</span></div>
            <div class="mp-summary-area">
              <div v-for="section in mpSummaryResult.sections" :key="section.category" class="mp-section-card">
                <div class="mp-section-head">
                  <strong>{{ section.category }}</strong>
                  <span class="mp-source-tag">{{ section.source }}</span>
                  <span v-if="section.date_range" class="mp-date-range">{{ section.date_range }}</span>
                </div>
                <div v-if="section.has_data" class="mp-section-items">
                  <div v-for="(item, idx) in section.items" :key="idx" class="mp-item-row">
                    <span v-if="mpItemDate(item)" class="mp-item-date">{{ mpItemDate(item) }}</span>
                    <span class="mp-item-text">{{ mpFormatItem(item) }}</span>
                  </div>
                </div>
                <div v-else class="mp-no-data">暂无记录</div>
              </div>
            </div>

            <div class="mp-section-divider"><span>会谈提纲（可编辑）</span></div>
            <div class="mp-outline-area">
              <div v-if="!mpOutlineText" class="mp-outline-actions">
                <button class="btn btn-primary" :disabled="mpGeneratingOutline" @click="mpGenerateOutline">
                  <FileText :size="14" /> {{ mpGeneratingOutline ? '生成中…' : '生成提纲' }}
                </button>
              </div>
              <template v-else>
                <textarea class="form-textarea mp-outline-textarea" v-model="mpOutlineText" rows="12"></textarea>
                <div class="mp-outline-actions">
                  <button class="btn btn-outline" @click="mpCopyOutline"><Copy :size="14" /> 复制提纲</button>
                  <button class="btn btn-outline" @click="mpGenerateOutline" :disabled="mpGeneratingOutline"><RotateCcw :size="14" /> 重新生成</button>
                </div>
              </template>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
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
  grid-template-columns: minmax(240px, .7fr) minmax(0, 1.3fr);
  gap: 16px;
}
.nt-scene-panel {
  align-self: start;
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
  font-size: 18px;
  width: 24px;
  text-align: center;
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
  align-self: start;
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
  grid-template-columns: minmax(280px, .6fr) minmax(0, 1.4fr);
  gap: 16px;
}
.mp-config-panel {
  align-self: start;
}
.mp-student-select {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
}
.mp-student-select label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 500;
}
.mp-category-group {
  margin-bottom: 16px;
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
  margin-bottom: 10px;
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
.mp-sensitive-details {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0;
  overflow: hidden;
}
.mp-sensitive-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-secondary);
  background: var(--bg);
  list-style: none;
}
.mp-sensitive-summary::-webkit-details-marker {
  display: none;
}
.mp-sensitive-summary::before {
  content: '▶';
  font-size: 10px;
  transition: transform .15s;
}
.mp-sensitive-details[open] .mp-sensitive-summary::before {
  transform: rotate(90deg);
}
.mp-sensitive-note {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-left: auto;
}
.mp-sensitive-content {
  padding: 10px 12px;
  border-top: 1px solid var(--border);
}
.mp-sensitive-content .hint {
  margin-top: 6px;
  font-size: 11px;
}
.mp-results-panel {
  align-self: start;
}
.mp-section-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}
.mp-section-divider::before,
.mp-section-divider::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--border);
}
.mp-section-divider:first-child {
  margin-top: 0;
}
.mp-summary-area {
  display: grid;
  gap: 10px;
}
.mp-section-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  background: var(--bg);
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
  background: var(--bg-secondary, var(--border));
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
  font-style: italic;
  padding: 4px 0;
}
.mp-outline-area {
  margin-top: 4px;
}
.mp-outline-textarea {
  font-size: 14px;
  line-height: 1.7;
  min-height: 180px;
}
.mp-outline-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.mp-mobile-flow {
  display: grid;
  gap: 12px;
}
.mp-student-list {
  display: grid;
  gap: 2px;
  max-height: 320px;
  overflow-y: auto;
}
.mp-student-row {
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
.mp-student-row:hover,
.mp-student-row.active {
  background: var(--primary-bg);
}
.mp-student-row small {
  color: var(--text-tertiary);
  font-size: 12px;
}
</style>
