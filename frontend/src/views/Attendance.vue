<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import {
  AlertTriangle, BarChart3, CheckCircle, Clock, Download, FileEdit,
  History, MessageSquareText, Paperclip, Save, Trash2, UserRound, XCircle
} from 'lucide-vue-next'
import { del, get, post, put, scopedUrl } from '../api'
import { useConfirmDialog } from '../composables/confirmDialog'
import EvidenceArea from '../components/EvidenceArea.vue'

const SCENES = ['常规到校', '早自习', '上午', '下午', '晚自习']
const STATUS_OPTIONS = ['出勤', '迟到', '请假', '早退', '缺勤']
const students = ref([])
const dayRecords = ref([])
const stats = ref(null)
const rules = ref([])
const recentRuns = ref([])
const loading = ref(true)
const saving = ref(false)
const evaluatingRules = ref(false)
const pageError = ref('')
const savedMessage = ref('')
const ruleMessage = ref('')
const selectedDate = ref(localDate())
const selectedScene = ref('常规到校')
const loadedDate = ref(selectedDate.value)
const loadedScene = ref(selectedScene.value)
const records = ref({})
const savedSnapshot = ref({})
const dateFrom = ref(monthStart())
const dateTo = ref(localDate())
const statsScene = ref('全部场景')
const showAllStudentStats = ref(false)
const batchNote = ref('')
const batchTarget = ref('异常学生')
const studentView = ref('all')
const studentEntryMode = ref(true)
const studentKeyword = ref('')
const studentSearchInput = ref(null)
const expandedStudentIds = ref(new Set())
const expandedRecordIds = ref(new Map())
const expandedEvidenceIds = ref(new Set())
const preparingEvidenceIds = ref(new Set())
const batchNoteExpanded = ref(false)
const fullSessionConfirmed = ref(false)
const newRule = ref({
  name: '一周迟到提醒', metric: '迟到次数', threshold: 2,
  period_days: 7, priority: '重要', scene: '全部场景'
})
const route = useRoute()
const sourceId = Number(route.query.source_id || 0)
const rulesExpanded = ref(Boolean(sourceId))
const { confirm: confirmDialog } = useConfirmDialog()

function localDate() {
  const d = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function monthStart() {
  return `${localDate().slice(0, 7)}-01`
}

function defaultRecord(student) {
  return { student_id: student.id, status: '出勤', reason: '', arrive: '', leave: '', note: '' }
}

function hydrateDayRecords() {
  const byStudent = new Map(dayRecords.value.map(item => [Number(item.student_id), item]))
  const next = {}
  const nextRecordIds = new Map()
  for (const student of students.value) {
    const old = byStudent.get(Number(student.id))
    next[student.id] = old
      ? {
          student_id: student.id, status: old.status || '出勤',
          reason: old.reason || '', arrive: old.arrive_at || '',
          leave: old.leave_at || '', note: old.note || ''
        }
      : defaultRecord(student)
    if (old?.id) nextRecordIds.set(student.id, old.id)
  }
  records.value = next
  expandedRecordIds.value = nextRecordIds
}

function recordSnapshot() {
  return students.value.reduce((snapshot, student) => {
    const record = records.value[student.id] || defaultRecord(student)
    snapshot[student.id] = {
      status: record.status || '出勤', reason: record.reason || '',
      arrive: record.arrive || '', leave: record.leave || '', note: record.note || '',
    }
    return snapshot
  }, {})
}

const hasUnsavedChanges = computed(() => (
  changedStudentCount.value > 0 || fullSessionConfirmed.value
))

function recordMatchesSnapshot(student) {
  const current = records.value[student.id] || defaultRecord(student)
  const saved = savedSnapshot.value[student.id] || defaultRecord(student)
  return JSON.stringify({
    status: current.status || '出勤', reason: current.reason || '',
    arrive: current.arrive || '', leave: current.leave || '', note: current.note || '',
  }) === JSON.stringify({
    status: saved.status || '出勤', reason: saved.reason || '',
    arrive: saved.arrive || '', leave: saved.leave || '', note: saved.note || '',
  })
}

const changedStudentCount = computed(() => students.value.filter(student => !recordMatchesSnapshot(student)).length)
const recordedStudentIds = computed(() => new Set(dayRecords.value.map(item => Number(item.student_id))))
const sessionRecordCount = computed(() => students.value.filter(student => recordedStudentIds.value.has(Number(student.id))).length)
const sessionIsComplete = computed(() => students.value.length > 0 && sessionRecordCount.value === students.value.length)
const needsFullSessionSave = computed(() => fullSessionConfirmed.value || !sessionIsComplete.value)
const quickEntryHint = computed(() => sessionIsComplete.value
  ? '搜索后直接选择异常状态，只提交本次修改。'
  : '搜索后补录异常；首次保存会同时写入全班出勤。')
const saveButtonLabel = computed(() => {
  if (saving.value) return '保存中…'
  if (needsFullSessionSave.value) return '保存本场点名'
  return studentEntryMode.value ? '保存异常修改' : '保存全班点名'
})

async function loadDayRecords() {
  const query = new URLSearchParams({ date: selectedDate.value, scene: selectedScene.value })
  dayRecords.value = (await get(`/api/attendance/records?${query}`)).records || []
  hydrateDayRecords()
  loadedDate.value = selectedDate.value
  loadedScene.value = selectedScene.value
  savedSnapshot.value = recordSnapshot()
  expandedStudentIds.value = new Set()
  expandedEvidenceIds.value = new Set()
  preparingEvidenceIds.value = new Set()
  batchNoteExpanded.value = false
  fullSessionConfirmed.value = false
}

async function loadStats() {
  const query = new URLSearchParams({
    date_from: dateFrom.value, date_to: dateTo.value, scene: statsScene.value
  })
  stats.value = await get(`/api/stats/attendance?${query}`)
  showAllStudentStats.value = false
}

async function loadRules() {
  const data = await get(sourceId
    ? `/api/attendance/rules?source_id=${sourceId}`
    : '/api/attendance/rules')
  rules.value = data.rules || []
  recentRuns.value = data.recent_runs || []
}

async function load() {
  loading.value = true
  pageError.value = ''
  try {
    students.value = (await get('/api/students')).students || []
    await loadDayRecords()
    await loadStats()
    await loadRules()
  } catch (error) {
    pageError.value = error.message
  } finally {
    loading.value = false
  }
}

async function changeAttendanceScope() {
  if (!confirmDiscardChanges('切换日期或场景')) {
    selectedDate.value = loadedDate.value
    selectedScene.value = loadedScene.value
    return
  }
  savedMessage.value = ''
  try {
    await loadDayRecords()
  } catch (error) {
    pageError.value = error.message
  }
}

async function addRule() {
  ruleMessage.value = ''
  try {
    const result = await post('/api/attendance/rules', newRule.value)
    const evaluation = result.evaluation
    ruleMessage.value = evaluation?.created_count
      ? `规则已保存，并生成 ${evaluation.created_count} 条跟进工作项`
      : '规则已保存并完成首次检查'
    await loadRules()
  } catch (error) {
    ruleMessage.value = `保存失败：${error.message}`
  }
}

async function toggleRule(rule) {
  ruleMessage.value = ''
  try {
    const result = await put(`/api/attendance/rules/${rule.id}`, { enabled: !rule.enabled })
    ruleMessage.value = !rule.enabled
      ? `规则已启用并重新检查，重开 ${result.evaluation?.reopened_count || 0} 项`
      : `规则已停用，解除 ${result.resolved_count || 0} 项提醒`
    await loadRules()
  } catch (error) {
    ruleMessage.value = error.message
  }
}

async function removeRule(rule) {
  if (!(await confirmDialog({ title: '删除考勤规则？', message: `将删除规则“${rule.name}”并移入回收站。`, confirmText: '移入回收站' }))) return
  try {
    await del(`/api/records/attendance_rule/${rule.id}`)
    ruleMessage.value = '规则已移入回收站'
    await loadRules()
  } catch (error) {
    ruleMessage.value = error.message
  }
}

async function evaluateRules() {
  evaluatingRules.value = true
  ruleMessage.value = ''
  try {
    const result = await post('/api/attendance/rules/evaluate', {
      reference_date: selectedDate.value
    })
    ruleMessage.value = `检查完成：命中 ${result.hit_count}，新建 ${result.created_count}，重开 ${result.reopened_count}，解除 ${result.resolved_count}`
    await loadRules()
  } catch (error) {
    ruleMessage.value = `检查失败：${error.message}`
  } finally {
    evaluatingRules.value = false
  }
}

function normalizeStatusFields(record) {
  if (record.status === '出勤') {
    record.reason = ''
    record.arrive = ''
    record.leave = ''
    return
  }
  if (record.status !== '迟到') record.arrive = ''
  if (record.status !== '早退') record.leave = ''
}

function toggleStudentDetails(studentId) {
  const next = new Set(expandedStudentIds.value)
  if (next.has(studentId)) next.delete(studentId)
  else next.add(studentId)
  expandedStudentIds.value = next
}

async function ensureRecordForEvidence(studentId) {
  if (expandedRecordIds.value.get(studentId)) return true
  const pending = new Set(preparingEvidenceIds.value)
  if (pending.has(studentId)) return false
  pending.add(studentId)
  preparingEvidenceIds.value = pending
  try {
    await post('/api/attendance/daily', {
      date: selectedDate.value,
      scene: selectedScene.value,
      records: [records.value[studentId]]
    })
    const query = new URLSearchParams({ date: selectedDate.value, scene: selectedScene.value })
    const data = await get(`/api/attendance/records?${query}`)
    const savedRecord = (data.records || []).find(item => Number(item.student_id) === Number(studentId))
    if (!savedRecord?.id) throw new Error('考勤记录创建失败')
    const nextRecordIds = new Map(expandedRecordIds.value)
    nextRecordIds.set(studentId, savedRecord.id)
    expandedRecordIds.value = nextRecordIds
    savedSnapshot.value = recordSnapshot()
    return true
  } catch (error) {
    savedMessage.value = `凭证准备失败：${error.message}`
    return false
  } finally {
    const next = new Set(preparingEvidenceIds.value)
    next.delete(studentId)
    preparingEvidenceIds.value = next
  }
}

async function toggleEvidence(studentId) {
  const next = new Set(expandedEvidenceIds.value)
  if (next.has(studentId)) {
    next.delete(studentId)
    expandedEvidenceIds.value = next
    return
  }
  if (!(await ensureRecordForEvidence(studentId))) return
  next.add(studentId)
  expandedEvidenceIds.value = next
}

function hasStudentDetails(record) {
  return Boolean(record?.reason || record?.arrive || record?.leave || record?.note)
}

function studentDetailsLabel(student) {
  const record = records.value[student.id]
  if (expandedStudentIds.value.has(student.id)) return '收起详情'
  return hasStudentDetails(record) ? '查看详情' : '补充详情'
}

function handleStatusChange(student) {
  const record = records.value[student.id]
  normalizeStatusFields(record)
  if (record.status === '出勤') {
    const next = new Set(expandedStudentIds.value)
    next.delete(student.id)
    expandedStudentIds.value = next
  } else {
    const next = new Set(expandedStudentIds.value)
    next.add(student.id)
    expandedStudentIds.value = next
  }
}

function setStudentStatus(student, status) {
  const record = records.value[student.id]
  record.status = status
  handleStatusChange(student)
}

function confirmPresentStudents() {
  if (sessionIsComplete.value && !changedStudentCount.value) {
    savedMessage.value = anomalyStudents.value.length
      ? '本场次已完整保存，异常记录保持不变'
      : '本场次已保存为全员到校'
    return
  }
  fullSessionConfirmed.value = true
  savedMessage.value = ''
  studentEntryMode.value = false
  studentView.value = 'all'
}

function applyBatchNote() {
  const note = batchNote.value.trim()
  if (!note) return
  let applied = 0
  for (const student of students.value) {
    const record = records.value[student.id]
    if (batchTarget.value === '异常学生' && record.status === '出勤') continue
    record.note = note
    applied += 1
  }
  savedMessage.value = `已把备注填入 ${applied} 名${batchTarget.value}`
}

const dailyCounts = computed(() => students.value.reduce((acc, student) => {
  const status = records.value[student.id]?.status || '出勤'
  acc[status] = (acc[status] || 0) + 1
  return acc
}, { 出勤: 0, 迟到: 0, 请假: 0, 早退: 0, 缺勤: 0 }))
const attentionStudents = computed(() => (stats.value?.student_stats || []).filter(item => item['异常'] > 0))
const statsAnomalyRecords = computed(() => {
  const counts = stats.value?.status_count || {}
  return ['迟到', '请假', '早退', '缺勤'].reduce((total, status) => total + (counts[status] || 0), 0)
})
const anomalyStudents = computed(() => students.value.filter(student => (
  records.value[student.id]?.status && records.value[student.id].status !== '出勤'
)))
const visibleStudents = computed(() => {
  if (!studentEntryMode.value && studentView.value === 'anomaly') return anomalyStudents.value
  if (!studentEntryMode.value) return students.value
  const keyword = studentKeyword.value.trim().toLowerCase()
  if (!keyword) return []
  return students.value.filter(student => `${student.姓名}${student.学号}`.toLowerCase().includes(keyword))
})
const isReadOnlyAnomalyView = computed(() => !studentEntryMode.value && studentView.value === 'anomaly')

function showStudentView(view) {
  studentView.value = view
  studentEntryMode.value = false
  studentKeyword.value = ''
  if (view === 'anomaly') {
    expandedStudentIds.value = new Set()
    expandedEvidenceIds.value = new Set()
    batchNoteExpanded.value = false
  }
}

async function startExceptionEntry() {
  studentEntryMode.value = true
  studentKeyword.value = ''
  await nextTick()
  studentSearchInput.value?.focus()
}

async function saveDaily() {
  const saveWholeSession = needsFullSessionSave.value || !studentEntryMode.value
  const recordsToSave = saveWholeSession
    ? Object.values(records.value)
    : students.value
      .filter(student => !recordMatchesSnapshot(student))
      .map(student => records.value[student.id])
  if (!recordsToSave.length) return
  saving.value = true
  savedMessage.value = ''
  try {
    const result = await post('/api/attendance/daily', {
      date: selectedDate.value, scene: selectedScene.value,
      records: recordsToSave
    })
    const evaluationErrorText = result.evaluation_error
      ? `；规则检查失败：${result.evaluation_error}`
      : ''
    savedMessage.value = saveWholeSession
      ? `已保存 ${result.saved} 名学生的${selectedScene.value}考勤${evaluationErrorText}`
      : `已保存 ${result.saved} 名学生的考勤修改${evaluationErrorText}`
    await loadDayRecords()
    await loadStats()
    await loadRules()
    if (studentEntryMode.value) studentKeyword.value = ''
  } catch (error) {
    savedMessage.value = `保存失败：${error.message}`
  } finally {
    saving.value = false
  }
}

function exportReport() {
  const query = new URLSearchParams()
  if (dateFrom.value) query.set('date_from', dateFrom.value)
  if (dateTo.value) query.set('date_to', dateTo.value)
  const anchor = document.createElement('a')
  anchor.href = scopedUrl(`/api/export/report/attendance?${query}`)
  anchor.click()
}

function runLabel(trigger) {
  return ({ save: '保存后自动检查', startup: '启动检查', manual: '手动检查', rule_change: '规则变更检查' })[trigger] || trigger
}

function confirmDiscardChanges(action = '离开页面') {
  return !hasUnsavedChanges.value || window.confirm(`当前点名有未保存修改，${action}会放弃这些修改。确定继续吗？`)
}

function handleBeforeUnload(event) {
  if (!hasUnsavedChanges.value) return
  event.preventDefault()
  event.returnValue = ''
}

onBeforeRouteLeave(() => confirmDiscardChanges())
onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload)
  load()
})
onBeforeUnmount(() => window.removeEventListener('beforeunload', handleBeforeUnload))
</script>

<template>
  <div class="attendance-page">
    <div class="page-title-bar">
      <div>
        <div class="page-title">考勤管理</div>
        <div class="page-subtitle">按场景完成点名，保存后自动识别需要跟进的异常</div>
      </div>
      <div class="toolbar attendance-export-actions">
        <a class="btn btn-outline btn-export" :href="scopedUrl('/api/export/sheet/考勤管理')"><Download :size="14" /> 导出明细</a>
        <button class="btn btn-outline" @click="exportReport"><Download :size="14" /> 导出汇总</button>
      </div>
    </div>

    <div v-if="pageError" class="empty-state">
      <AlertTriangle :size="28" />
      <strong>考勤数据加载失败</strong><span>{{ pageError }}</span>
      <button class="btn btn-outline" @click="load">重新加载</button>
    </div>
    <template v-else>
      <section class="attendance-hero card" aria-label="考勤场次">
        <label class="attendance-date">点名日期<input type="date" v-model="selectedDate" @change="changeAttendanceScope"></label>
        <label class="attendance-date">考勤场景<select class="form-select" v-model="selectedScene" @change="changeAttendanceScope"><option v-for="scene in SCENES" :key="scene">{{ scene }}</option></select></label>
        <div class="attendance-actions">
          <button class="btn btn-outline" @click="confirmPresentStudents"><CheckCircle :size="14" /> {{ anomalyStudents.length ? '确认其余到校' : '确认全员到校' }}</button>
        </div>
      </section>

      <section class="attendance-summary" aria-label="当前场次人数统计">
        <div class="attendance-summary-item green"><CheckCircle :size="17" /><span>出勤</span><strong>{{ dailyCounts['出勤'] }}</strong></div>
        <div class="attendance-summary-item orange"><Clock :size="17" /><span>迟到</span><strong>{{ dailyCounts['迟到'] }}</strong></div>
        <div class="attendance-summary-item blue"><FileEdit :size="17" /><span>请假</span><strong>{{ dailyCounts['请假'] }}</strong></div>
        <div class="attendance-summary-item purple"><Clock :size="17" /><span>早退</span><strong>{{ dailyCounts['早退'] }}</strong></div>
        <div class="attendance-summary-item red"><XCircle :size="17" /><span>缺勤</span><strong>{{ dailyCounts['缺勤'] }}</strong></div>
      </section>

      <section class="card">
        <div class="attendance-card-head">
          <div class="card-title"><UserRound :size="16" /> 全班点名 <span class="count">{{ students.length }} 人 · {{ selectedScene }}</span></div>
          <button v-if="!isReadOnlyAnomalyView" class="btn btn-primary attendance-save-button" :disabled="saving || loading || !hasUnsavedChanges" @click="saveDaily">
            <Save :size="14" /> {{ saveButtonLabel }}
          </button>
          <span class="attendance-status-live" role="status" aria-live="polite">{{ savedMessage }}</span>
        </div>
        <div class="attendance-mode-row">
          <div class="attendance-mode-tabs" role="tablist" aria-label="点名方式">
            <button type="button" role="tab" :aria-selected="studentEntryMode" :class="{ active: studentEntryMode }" @click="startExceptionEntry">快速登记异常</button>
            <button type="button" role="tab" :aria-selected="!studentEntryMode && studentView === 'all'" :class="{ active: !studentEntryMode && studentView === 'all' }" @click="showStudentView('all')">全班复核</button>
          </div>
          <button v-if="anomalyStudents.length" type="button" class="attendance-filter-link" :class="{ active: !studentEntryMode && studentView === 'anomaly' }" @click="showStudentView('anomaly')">只看异常 {{ anomalyStudents.length }}</button>
          <button v-if="!studentEntryMode && visibleStudents.length && !isReadOnlyAnomalyView" type="button" class="attendance-filter-link" :class="{ active: batchNoteExpanded }" @click="batchNoteExpanded = !batchNoteExpanded">批量备注</button>
        </div>
        <div v-if="studentEntryMode" class="attendance-quick-panel">
          <label class="attendance-search-field"><span>查找需要登记的学生</span><input ref="studentSearchInput" v-model="studentKeyword" class="form-input" placeholder="输入姓名或学号"></label>
          <span class="attendance-search-hint">{{ quickEntryHint }}</span>
        </div>
        <div v-if="!studentEntryMode && visibleStudents.length && batchNoteExpanded" class="batch-note-row">
          <MessageSquareText :size="15" />
          <label class="batch-note-target"><span>备注对象</span><select v-model="batchTarget" class="form-select" aria-label="备注对象"><option>异常学生</option><option>全班</option></select></label>
          <input v-model="batchNote" class="form-input" placeholder="填写批量备注，例如：暴雨天气统一延迟到校">
          <button class="btn btn-outline" :disabled="!batchNote.trim()" @click="applyBatchNote">应用备注</button>
        </div>
        <div v-if="loading" class="loading">加载中…</div>
        <div v-else-if="!students.length" class="empty-state">请先导入学生名单</div>
        <div v-else-if="visibleStudents.length" class="attendance-list" :class="{ 'attendance-list-quick': studentEntryMode }">
          <div v-for="student in visibleStudents" :key="student.id" class="attendance-row" :class="`attendance-${records[student.id]?.status || '出勤'}`">
            <div class="attendance-row-main">
              <div class="attendance-student"><span>{{ student.学号 }}</span><strong>{{ student.姓名 }}</strong></div>
              <div v-if="!isReadOnlyAnomalyView" class="attendance-status-picker" role="group" :aria-label="`${student.姓名}考勤状态`">
                <button v-for="status in STATUS_OPTIONS" :key="status" type="button" :aria-pressed="records[student.id].status === status" :class="{ active: records[student.id].status === status }" @click="setStudentStatus(student, status)">{{ status }}</button>
              </div>
              <span v-else class="attendance-readonly-status">{{ records[student.id].status }}</span>
              <span v-if="!isReadOnlyAnomalyView && hasStudentDetails(records[student.id]) && !expandedStudentIds.has(student.id)" class="attendance-detail-status">已补充详情</span>
              <button v-if="!isReadOnlyAnomalyView" type="button" class="attendance-details-toggle" :aria-expanded="expandedStudentIds.has(student.id)" @click="toggleStudentDetails(student.id)">{{ studentDetailsLabel(student) }}</button>
            </div>
            <div v-if="expandedStudentIds.has(student.id)" class="attendance-row-details">
              <label v-if="records[student.id].status !== '出勤'" class="attendance-field"><span>{{ records[student.id].status === '请假' ? '请假原因' : '异常原因' }}</span><input :aria-label="`${student.姓名}异常原因`" class="form-input" v-model="records[student.id].reason" :placeholder="records[student.id].status === '请假' ? '例如：发烧休息' : '可选'"></label>
              <label v-if="records[student.id].status === '迟到'" class="attendance-field"><span>到校时间</span><input :aria-label="`${student.姓名}到校时间`" class="form-input attendance-time" type="time" v-model="records[student.id].arrive"></label>
              <label v-if="records[student.id].status === '早退'" class="attendance-field"><span>离校时间</span><input :aria-label="`${student.姓名}离校时间`" class="form-input attendance-time" type="time" v-model="records[student.id].leave"></label>
              <button v-if="records[student.id].status === '请假'" type="button" class="attendance-evidence-toggle" :disabled="preparingEvidenceIds.has(student.id)" @click="toggleEvidence(student.id)"><Paperclip :size="14" /> {{ preparingEvidenceIds.has(student.id) ? '准备中…' : expandedEvidenceIds.has(student.id) ? '收起凭证' : '添加凭证' }}</button>
              <EvidenceArea v-if="records[student.id].status === '请假' && expandedRecordIds.get(student.id) && expandedEvidenceIds.has(student.id)" owner-type="attendance" :owner-id="expandedRecordIds.get(student.id)" :student-id="student.id" />
            </div>
          </div>
        </div>
        <div v-else-if="studentEntryMode && !studentKeyword.trim()" class="attendance-ready-state"><CheckCircle :size="22" /><strong>从一位学生开始</strong><span>输入姓名或学号，直接选择迟到、请假、早退或缺勤。</span></div>
        <div v-else-if="studentEntryMode" class="empty-state compact-empty">没有找到匹配的学生</div>
        <div v-else-if="studentView === 'anomaly' && !anomalyStudents.length" class="attendance-ready-state"><CheckCircle :size="22" /><strong>当前没有异常记录</strong><span>切换到“全班复核”查看全部学生。</span><button class="btn btn-outline" @click="showStudentView('all')">查看全班</button></div>
      </section>

      <section class="card attendance-rules-card">
        <div class="card-title"><Clock :size="16" /> 考勤规则 <span class="count">保存考勤和启动应用时自动检查</span><button class="btn btn-outline rule-toggle" @click="rulesExpanded = !rulesExpanded">{{ rulesExpanded ? '收起规则' : '管理规则' }}</button><button v-if="rulesExpanded" class="btn btn-outline rule-evaluate" :disabled="evaluatingRules" @click="evaluateRules">{{ evaluatingRules ? '检查中…' : '立即检查' }}</button></div>
        <div v-if="!rulesExpanded" class="attendance-collapsed-summary"><span>{{ rules.length ? `已配置 ${rules.length} 条规则` : '尚未配置规则' }}</span><span class="hint">日常点名无需展开此区域</span></div>
        <div v-show="rulesExpanded" class="attendance-rules-content">
          <div class="rule-create-row">
          <input class="form-input" v-model="newRule.name" placeholder="规则名称">
          <select class="form-select" aria-label="规则指标" v-model="newRule.metric"><option>迟到次数</option><option>请假次数</option><option>缺勤次数</option><option>连续缺勤天数</option></select>
          <select class="form-select" aria-label="规则适用场景" v-model="newRule.scene"><option>全部场景</option><option v-for="scene in SCENES" :key="scene">{{ scene }}</option></select>
          <input aria-label="规则阈值" class="form-input rule-number" type="number" min="1" v-model.number="newRule.threshold"><span>次 /</span>
          <input aria-label="统计天数" class="form-input rule-number" type="number" min="1" max="365" v-model.number="newRule.period_days"><span>天</span>
          <select aria-label="规则优先级" class="form-select" v-model="newRule.priority"><option>普通</option><option>重要</option><option>紧急</option></select>
          <button class="btn btn-primary" @click="addRule">新增规则</button>
          </div>
        <div v-if="ruleMessage" class="inline-message">{{ ruleMessage }}</div>
        <div v-if="!rules.length" class="empty-state compact-empty">还没有考勤规则，新增后会立即执行首次检查</div>
        <article v-for="rule in rules" :key="rule.id" class="rule-card" :class="{ 'source-highlight': rule.id === sourceId }">
          <div class="rule-card-head">
            <div><strong>{{ rule.name }}</strong><span>{{ rule.metric }} ≥ {{ rule.threshold }} · 最近 {{ rule.period_days }} 天 · {{ rule.scene }} · {{ rule.priority }}</span><small>{{ rule.last_run_at ? `最近执行：${rule.last_run_at}` : '尚未执行' }}</small></div>
            <div class="record-actions"><span class="tag" :class="rule.active_hit_count ? 'tag-orange' : 'tag-green'">待处理 {{ rule.active_hit_count }}</span><span v-if="rule.handled_hit_count" class="tag">已处理 {{ rule.handled_hit_count }}</span><button class="tag" :class="rule.enabled ? 'tag-green' : ''" @click="toggleRule(rule)">{{ rule.enabled ? '已启用' : '已停用' }}</button><button class="btn btn-sm btn-outline" aria-label="删除考勤规则" @click="removeRule(rule)"><Trash2 :size="13" /></button></div>
          </div>
          <div v-if="rule.hits.length" class="rule-hit-list">
            <router-link v-for="hit in rule.hits.slice(0, 6)" :key="hit.id" :to="hit.task_id ? `/tasks?bucket=all&task=${hit.task_id}&action=edit` : `/student/${hit.student_id}`" class="rule-hit-row">
              <span><strong>{{ hit.student_name }}</strong> · 当前值 {{ hit.current_value }}</span>
              <em :class="{ active: hit.status === '待处理' }">{{ hit.status }}<template v-if="hit.task_status"> · {{ hit.task_status }}</template></em>
            </router-link>
          </div>
        </article>
        <details v-if="recentRuns.length" class="rule-run-history">
          <summary><History :size="14" /> 最近执行历史</summary>
          <div v-for="run in recentRuns.slice(0, 8)" :key="run.id" class="rule-run-row"><span>{{ run.created_at }} · {{ runLabel(run.trigger_type) }}</span><span>规则 {{ run.rules_evaluated }} · 命中 {{ run.hit_count }} · 新建 {{ run.created_count }} · 重开 {{ run.reopened_count }} · 解除 {{ run.resolved_count }}</span></div>
        </details>
        </div>
      </section>

      <section class="card attendance-analysis">
        <div class="card-title"><BarChart3 :size="16" /> 考勤统计</div>
        <div class="attendance-filter-row">
          <label>开始日期<input type="date" v-model="dateFrom"></label>
          <label>结束日期<input type="date" v-model="dateTo"></label>
          <label>场景<select class="form-select" v-model="statsScene"><option>全部场景</option><option v-for="scene in SCENES" :key="scene">{{ scene }}</option></select></label>
          <button class="btn btn-outline" @click="loadStats">更新统计</button>
        </div>
        <p class="stats-definition"><span>{{ stats?.definition }}</span><span>仅统计已保存的考勤记录</span><span v-if="stats?.total_sessions > 0 && stats.total_sessions < 3" class="stats-sample-note">当前仅有 {{ stats.total_sessions }} 次点名，数据较少</span></p>
        <div class="overview-cards compact-overview attendance-period-summary">
          <div class="overview-card"><div class="oc-label">已保存点名</div><div class="oc-value">{{ stats?.total_sessions || 0 }}</div><small class="attendance-stat-meta">{{ stats?.total_records || 0 }} 条学生记录</small></div>
          <div class="overview-card"><div class="oc-label">异常学生</div><div class="oc-value">{{ attentionStudents.length }}</div><small class="attendance-stat-meta">有异常记录的学生</small></div>
          <div class="overview-card"><div class="oc-label">异常记录</div><div class="oc-value">{{ statsAnomalyRecords }}</div><small class="attendance-stat-meta">迟到、请假、早退和缺勤</small></div>
          <div class="overview-card"><div class="oc-label">迟到</div><div class="oc-value">{{ stats?.status_count?.['迟到'] || 0 }}</div><small class="attendance-stat-meta">需要关注的记录</small></div>
        </div>
        <div class="attendance-analysis-actions">
          <span class="hint">默认只显示有异常记录的学生，完整统计按需展开</span>
          <button v-if="stats?.student_stats?.length" class="btn btn-outline" @click="showAllStudentStats = !showAllStudentStats">{{ showAllStudentStats ? '收起全部统计' : `查看全部已记录学生（${stats.student_stats.length}）` }}</button>
        </div>
        <div class="attendance-analysis-grid">
          <div class="attendance-table-panel">
            <div class="attendance-panel-head"><div><h3>需要关注的学生</h3><span>按异常次数排序</span></div><span class="count">{{ attentionStudents.length }} 人</span></div>
            <div v-if="!stats?.student_stats?.length" class="empty-state compact-empty">当前范围没有已保存的考勤记录</div>
            <div v-else-if="!attentionStudents.length" class="empty-state compact-empty">当前范围没有异常学生</div>
            <div v-else class="attendance-attention-list">
              <router-link v-for="item in attentionStudents" :key="item.student_id" :to="`/student/${item.student_id}`" class="attendance-attention-row">
                <div class="attendance-attention-student"><strong>{{ item.student_name }}</strong><span>{{ item['学号'] }} · 应到 {{ item['应到次数'] }} 次</span></div>
                <div class="attendance-stat-chips"><span v-if="item['迟到']" class="attendance-stat-chip warning">迟到 {{ item['迟到'] }}</span><span v-if="item['请假']" class="attendance-stat-chip blue">请假 {{ item['请假'] }}</span><span v-if="item['早退']" class="attendance-stat-chip purple">早退 {{ item['早退'] }}</span><span v-if="item['缺勤']" class="attendance-stat-chip danger">缺勤 {{ item['缺勤'] }}</span></div>
                <div class="attendance-attention-rates"><span>按时 <strong>{{ item.punctual_rate }}%</strong></span><span>到勤 <strong>{{ item.presence_rate }}%</strong></span></div>
              </router-link>
            </div>
          </div>
          <div class="attendance-table-panel">
            <div class="attendance-panel-head"><div><h3>最近异常记录</h3><span>用于快速回看具体场次</span></div><span class="count">{{ stats?.anomalies?.length || 0 }} 条</span></div>
            <div v-if="!stats?.anomalies?.length" class="empty-state compact-empty">当前范围没有已保存的异常记录</div>
            <div v-else class="anomaly-list"><router-link v-for="item in stats.anomalies.slice(0, 50)" :key="item.id" :to="`/student/${item.student_id}`" class="anomaly-row"><span><strong>{{ item.student_name }}</strong> · {{ item.date }} · {{ item.scene }}</span><span><em>{{ item.status }}</em>{{ item.reason || item.note || '无备注' }}</span></router-link></div>
          </div>
        </div>
        <div v-if="showAllStudentStats" class="attendance-full-stats attendance-table-panel">
          <div class="attendance-panel-head"><div><h3>全部已记录学生</h3><span>只统计当前区间内至少有一次点名记录的学生</span></div><span class="count">{{ stats.student_stats.length }} 人</span></div>
          <div class="table-scroll"><table><thead><tr><th>学生</th><th>应到</th><th>正常出勤</th><th>异常概况</th><th>按时率</th><th>到勤率</th></tr></thead><tbody><tr v-for="item in stats.student_stats" :key="item.student_id"><td><router-link :to="`/student/${item.student_id}`">{{ item.student_name }}</router-link></td><td>{{ item['应到次数'] }}</td><td>{{ item['正常出勤'] }}</td><td><span v-if="!item['异常']" class="muted">无异常</span><span v-else class="attendance-table-anomaly">{{ item['异常'] }} 次异常</span></td><td>{{ item.punctual_rate }}%</td><td>{{ item.presence_rate }}%</td></tr></tbody></table></div>
        </div>
        <div class="attendance-period-grid">
          <div><h3>按月</h3><div v-for="item in stats?.month_stats || []" :key="item.label" class="period-row"><strong>{{ item.label }}</strong><span>{{ item['总记录'] }} 条 · 异常 {{ item['异常'] }}</span></div><div v-if="!stats?.month_stats?.length" class="hint">暂无月度数据</div></div>
          <div><h3>按周次</h3><div v-for="item in stats?.week_stats || []" :key="item.label" class="period-row"><strong>{{ item.label }}</strong><span>{{ item['总记录'] }} 条 · 异常 {{ item['异常'] }}</span></div><div v-if="!stats?.week_stats?.length" class="hint">暂无周次数据</div></div>
        </div>
      </section>
    </template>
  </div>
</template>
