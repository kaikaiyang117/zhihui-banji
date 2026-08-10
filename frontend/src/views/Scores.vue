<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  AlertTriangle, CheckCircle, Download, FileUp, History,
  Settings2, Trash2, TrendingDown, TrendingUp, Users, X
} from 'lucide-vue-next'
import { del, get, post, put, upload } from '../api'

const route = useRoute()
const sourceId = Number(route.query.source_id || 0)
const summary = ref({ exams: [], subjects: [], students: [], records: [], definition: {} })
const config = ref({
  exams: [], subjects: [], settings: { mode: '固定科目' },
  sichuan_312: { ready: false, issues: [], combinations: [], standard_subject_ids: [] },
})
const rules = ref([])
const recentRuns = ref([])
const loading = ref(true)
const pageError = ref('')
const message = ref('')
const selectedExamId = ref(0)
const configOpen = ref(false)
const fileInput = ref(null)
const selectedFile = ref(null)
const importing = ref(false)
const preview = ref(null)
const duplicateStrategy = ref('update')
const committing = ref(false)
const newSubject = ref({ name: '', full_score: 100, subject_group: '必考', score_type: '原始分' })
const newExam = ref({ name: '', exam_date: '', subject_ids: [] })
const newRule = ref({ name: '总分明显下降', metric: '总分下降', subject_id: null, threshold: 20, priority: '重要' })
const detailStudentId = ref(0)
const studentKeyword = ref('')
const selectionDraft = ref({})
const selectionFilter = ref('all')
const selectedSelectionStudentIds = ref([])
const batchCombinationCode = ref('')
const applyingPreset = ref(false)
const batchSaving = ref(false)
const detailSection = ref(null)

const selectedExam = computed(() => summary.value.exams.find(item => Number(item.id) === Number(selectedExamId.value)) || null)
const selectedRecords = computed(() => summary.value.records.filter(item => Number(item.exam_id) === Number(selectedExamId.value)))
const selectedRawSubjects = computed(() => selectedExam.value?.subject_stats || [])
const rawRecordMap = computed(() => new Map(
  selectedRecords.value.map(row => [
    `${row.student_id}:${row.configured_subject_name || row.subject}`,
    row,
  ])
))
const rawStudentRows = computed(() => {
  const studentIds = new Set(selectedRecords.value.map(row => Number(row.student_id)))
  return summary.value.students.filter(student => studentIds.has(Number(student.student_id)))
})
const previewRows = computed(() => preview.value?.rows || [])
const commitRows = computed(() => previewRows.value.filter(item => item.valid && item.action !== '跳过'))
const studentOverviewRows = computed(() => {
  const keyword = studentKeyword.value.trim().toLowerCase()
  const latestExam = summary.value.exams.at(-1)
  return summary.value.students
    .map(student => {
      const latest = latestExam ? studentExam(student, latestExam.id) : null
      const change = latest?.total_change
      const status = student.selection_configured && student.selection_status !== '有效'
        ? '选科待确认'
        : latest?.missing_subjects?.length
        ? '数据不完整'
        : change !== null && change !== undefined && change <= -20
          ? '需要关注'
          : '状态稳定'
      return { ...student, latest, status }
    })
    .filter(student => !keyword || `${student.姓名} ${student.学号}`.toLowerCase().includes(keyword))
})
const selectedStudent = computed(() => summary.value.students.find(
  student => String(student.student_id) === String(detailStudentId.value)
) || summary.value.students[0] || null)
const selectedStudentLatest = computed(() => {
  const exam = summary.value.exams.at(-1)
  return exam && selectedStudent.value ? studentExam(selectedStudent.value, exam.id) : null
})
const selectedStudentSubjects = computed(() => summary.value.subjects.map(subject => ({
  ...subject,
  exams: summary.value.exams.map(exam => {
    const result = selectedStudent.value ? studentExam(selectedStudent.value, exam.id) : null
    const item = result?.subjects?.[subject.name]
    const configured = selectedStudent.value?.selection_configured
    const selected = !configured || subject.subject_group === '必考'
      || selectedStudent.value.selected_subject_ids.includes(Number(subject.id))
    return { exam, score: item?.score, status: selected ? (item?.status || '未录入') : '未选科' }
  }),
})))
const combinationOptions = computed(() => config.value.sichuan_312?.combinations || [])
const selectionStudents = computed(() => summary.value.students.map(student => ({
  ...student,
  selected_subject_ids: selectionDraft.value[student.student_id] || [],
})))
const selectionCounts = computed(() => ({
  all: selectionStudents.value.length,
  unset: selectionStudents.value.filter(student => !student.selection_configured).length,
  invalid: selectionStudents.value.filter(
    student => student.selection_configured && student.selection_status !== '有效'
  ).length,
}))
const filteredSelectionStudents = computed(() => selectionStudents.value.filter(student => {
  if (selectionFilter.value === 'unset') return !student.selection_configured
  if (selectionFilter.value === 'invalid') {
    return student.selection_configured && student.selection_status !== '有效'
  }
  return true
}))
const allFilteredSelectionStudentsSelected = computed(() => (
  filteredSelectionStudents.value.length > 0
  && filteredSelectionStudents.value.every(student => selectedSelectionStudentIds.value.includes(student.student_id))
))
const standardSubjectIds = computed(() => new Set(config.value.sichuan_312?.standard_subject_ids || []))
const trendSummary = computed(() => {
  if (!summary.value.exams.length) return '暂无成绩趋势数据。'
  const complete = summary.value.students.reduce((count, student) =>
    count + student.exams.filter(item => item.complete).length, 0)
  return `当前包含 ${summary.value.exams.length} 次考试、${summary.value.students.length} 名学生和 ${complete} 份完整总分。`
})

function studentExam(student, examId) {
  return student.exams.find(item => Number(item.exam_id) === Number(examId))
}

function formatChange(value, suffix = '') {
  if (value === null || value === undefined) return '—'
  if (value > 0) return `↑ ${value}${suffix}`
  if (value < 0) return `↓ ${Math.abs(value)}${suffix}`
  return `持平${suffix}`
}

function rawRecordFor(studentId, subjectName) {
  return rawRecordMap.value.get(`${studentId}:${subjectName}`)
}

async function scrollToDetail() {
  await nextTick()
  if (globalThis.matchMedia && !globalThis.matchMedia('(max-width: 900px)').matches) return
  detailSection.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function selectStudent(student) {
  detailStudentId.value = student.student_id
  await scrollToDetail()
}

async function load() {
  loading.value = true
  pageError.value = ''
  try {
    const [data, configData, ruleData] = await Promise.all([
      get('/api/exams/summary'), get('/api/score-config'),
      get(sourceId ? `/api/score-rules?source_id=${sourceId}` : '/api/score-rules')
    ])
    summary.value = data
    config.value = configData
    selectionDraft.value = Object.fromEntries(
      data.students.map(student => [student.student_id, [...(student.selected_subject_ids || [])]])
    )
    const currentStudentIds = new Set(data.students.map(student => student.student_id))
    selectedSelectionStudentIds.value = selectedSelectionStudentIds.value.filter(
      studentId => currentStudentIds.has(studentId)
    )
    if (!batchCombinationCode.value && configData.sichuan_312?.combinations?.length) {
      batchCombinationCode.value = configData.sichuan_312.combinations[0].code
    }
    rules.value = ruleData.rules || []
    recentRuns.value = ruleData.recent_runs || []
    if (!selectedExamId.value || !data.exams.some(item => Number(item.id) === Number(selectedExamId.value))) {
      selectedExamId.value = data.exams.at(-1)?.id || 0
    }
    const requestedStudentId = Number(route.query.student_id || 0)
    if (requestedStudentId && data.students.some(item => Number(item.student_id) === requestedStudentId)) {
      detailStudentId.value = requestedStudentId
    } else if (!detailStudentId.value || !data.students.some(item => String(item.student_id) === String(detailStudentId.value))) {
      detailStudentId.value = data.students[0]?.student_id || 0
    }
  } catch (error) {
    pageError.value = error.message
  } finally {
    loading.value = false
  }
}

function pickFile() { fileInput.value?.click() }

async function previewFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  selectedFile.value = file
  await runPreview()
}

async function runPreview() {
  if (!selectedFile.value) return
  importing.value = true
  message.value = ''
  try {
    preview.value = await upload(
      `/api/exams/import/preview?duplicate_strategy=${duplicateStrategy.value}`,
      selectedFile.value
    )
  } catch (error) {
    message.value = `检查失败：${error.message}`
  } finally {
    importing.value = false
  }
}

function closePreview() {
  preview.value = null
  selectedFile.value = null
}

async function commitImport() {
  if (!commitRows.value.length) return
  committing.value = true
  try {
    const requestId = globalThis.crypto?.randomUUID?.() || `score-${Date.now()}`
    const result = await post('/api/exams/import/commit', {
      filename: preview.value.filename, duplicate_strategy: duplicateStrategy.value,
      request_id: requestId, rows: commitRows.value
    })
    const ruleText = result.evaluation_error
      ? `；规则检查失败：${result.evaluation_error}`
      : `；规则命中 ${result.evaluation?.hit_count || 0}，新建 ${result.evaluation?.created_count || 0}`
    message.value = `已新增 ${result.imported} 条，更新 ${result.updated} 条，跳过 ${result.skipped} 条${ruleText}`
    closePreview()
    await load()
  } catch (error) {
    message.value = `提交失败，未写入部分数据：${error.message}`
  } finally {
    committing.value = false
  }
}

async function addSubject() {
  try {
    await post('/api/score-config/subjects', newSubject.value)
    newSubject.value = { name: '', full_score: 100, subject_group: '必考', score_type: '原始分' }
    message.value = '科目已添加'
    await load()
  } catch (error) { message.value = error.message }
}

async function saveSubject(subject) {
  try {
    await put(`/api/score-config/subjects/${subject.id}`, {
      name: subject.name, full_score: Number(subject.full_score || 0), enabled: subject.enabled,
      subject_group: subject.subject_group, score_type: subject.score_type,
    })
    message.value = '科目配置已保存'
    await load()
  } catch (error) { message.value = error.message }
}

function combinationForSubjectIds(subjectIds) {
  const key = [...(subjectIds || [])].map(Number).sort((a, b) => a - b).join(',')
  return combinationOptions.value.find(item => (
    [...item.subject_ids].map(Number).sort((a, b) => a - b).join(',') === key
  )) || null
}

function isStandardSubject(subject) {
  return standardSubjectIds.value.has(Number(subject.id))
}

function toggleFilteredSelectionStudents() {
  const selected = new Set(selectedSelectionStudentIds.value)
  if (allFilteredSelectionStudentsSelected.value) {
    filteredSelectionStudents.value.forEach(student => selected.delete(student.student_id))
  } else {
    filteredSelectionStudents.value.forEach(student => selected.add(student.student_id))
  }
  selectedSelectionStudentIds.value = [...selected]
}

async function applySichuanPreset() {
  applyingPreset.value = true
  try {
    await post('/api/score-config/presets/sichuan-312', {})
    message.value = '四川3+1+2标准科目已准备好，可以开始登记学生选科'
    await load()
  } catch (error) {
    message.value = error.message
  } finally {
    applyingPreset.value = false
  }
}

async function saveStudentSelection(student) {
  try {
    await put(`/api/score-config/students/${student.student_id}/subjects`, {
      subject_ids: selectionDraft.value[student.student_id] || [],
    })
    message.value = `${student.姓名}的选科已保存`
    await load()
  } catch (error) {
    message.value = error.message
    await load()
  }
}

async function saveStudentCombination(student, combinationCode) {
  const combination = combinationOptions.value.find(item => item.code === combinationCode)
  if (!combination) return
  selectionDraft.value[student.student_id] = [...combination.subject_ids]
  await saveStudentSelection(student)
}

async function applyBatchCombination() {
  const combination = combinationOptions.value.find(item => item.code === batchCombinationCode.value)
  if (!combination || !selectedSelectionStudentIds.value.length) return
  batchSaving.value = true
  try {
    const result = await put('/api/score-config/student-subjects/batch', {
      student_ids: selectedSelectionStudentIds.value,
      subject_ids: combination.subject_ids,
    })
    message.value = `已为 ${result.updated_count} 名学生登记“${combination.code}”组合`
    selectedSelectionStudentIds.value = []
    await load()
  } catch (error) {
    message.value = error.message
  } finally {
    batchSaving.value = false
  }
}

async function addExam() {
  try {
    await post('/api/score-config/exams', newExam.value)
    newExam.value = { name: '', exam_date: '', subject_ids: [] }
    message.value = '考试已添加'
    await load()
  } catch (error) { message.value = error.message }
}

async function saveExam(exam) {
  try {
    await put(`/api/score-config/exams/${exam.id}`, {
      name: exam.name, exam_date: exam.exam_date,
      subject_ids: exam.subject_ids, enabled: exam.enabled
    })
    message.value = '考试配置已保存'
    await load()
  } catch (error) { message.value = error.message }
}

async function addRule() {
  try {
    const payload = { ...newRule.value }
    if (payload.metric !== '单科下降') payload.subject_id = null
    const result = await post('/api/score-rules', payload)
    message.value = result.evaluation?.created_count
      ? `规则已保存，并生成 ${result.evaluation.created_count} 条跟进工作项`
      : '规则已保存并完成首次检查'
    await load()
  } catch (error) { message.value = error.message }
}

async function toggleRule(rule) {
  try {
    const result = await put(`/api/score-rules/${rule.id}`, { enabled: !rule.enabled })
    message.value = rule.enabled
      ? `规则已停用，解除 ${result.resolved_count || 0} 项提醒`
      : `规则已启用，新建 ${result.evaluation?.created_count || 0} 项提醒`
    await load()
  } catch (error) { message.value = error.message }
}

async function removeRule(rule) {
  if (!confirm(`删除规则“${rule.name}”并移入回收站吗？`)) return
  try {
    await del(`/api/records/score_rule/${rule.id}`)
    message.value = '成绩规则已移入回收站'
    await load()
  } catch (error) { message.value = error.message }
}

async function evaluateRules() {
  try {
    const result = await post('/api/score-rules/evaluate', {})
    message.value = `检查完成：命中 ${result.hit_count}，新建 ${result.created_count}，重开 ${result.reopened_count}，解除 ${result.resolved_count}`
    await load()
  } catch (error) { message.value = error.message }
}

function exportExam() {
  if (!selectedExam.value) return
  const anchor = document.createElement('a')
  anchor.href = `/api/export/report/scores?exam=${encodeURIComponent(selectedExam.value.id)}`
  anchor.click()
}

onMounted(load)
</script>

<template>
  <div class="scores-page">
    <div class="page-title-bar">
      <div><div class="page-title">成绩跟踪</div><div class="page-subtitle">先核验导入，再用统一口径观察班级与学生变化</div></div>
      <div class="toolbar scores-actions">
        <button class="btn btn-outline" @click="configOpen = !configOpen"><Settings2 :size="14" /> 考试与科目</button>
        <input ref="fileInput" type="file" accept=".xlsx,.xlsm" hidden @change="previewFile">
        <button class="btn btn-primary" :disabled="importing" @click="pickFile"><FileUp :size="14" /> {{ importing ? '检查中…' : '导入成绩' }}</button>
      </div>
    </div>

    <div v-if="pageError" class="inline-message error">{{ pageError }}</div>
    <div v-if="message" class="inline-message">{{ message }}</div>

    <section v-if="configOpen" class="card score-config-card">
      <div class="card-title"><Settings2 :size="16" /> 选科与考试设置</div>

      <div class="sichuan-mode-card" :class="{ ready: config.sichuan_312?.ready }">
        <div class="sichuan-mode-main">
          <div class="sichuan-mode-icon"><CheckCircle :size="20" /></div>
          <div>
            <div class="sichuan-mode-title">
              四川新高考 · 3+1+2
              <span>{{ config.sichuan_312?.ready ? '标准配置已启用' : '需要初始化' }}</span>
            </div>
            <p>语数英必考，物理/历史二选一，化学、生物、政治、地理四选二。</p>
            <div v-if="config.sichuan_312?.issues?.length" class="sichuan-mode-issues">
              {{ config.sichuan_312.issues.slice(0, 3).join('；') }}<template v-if="config.sichuan_312.issues.length > 3">等 {{ config.sichuan_312.issues.length }} 项</template>
            </div>
          </div>
        </div>
        <button v-if="!config.sichuan_312?.ready" class="btn btn-primary" :disabled="applyingPreset" @click="applySichuanPreset">
          {{ applyingPreset ? '正在准备…' : '应用标准配置' }}
        </button>
      </div>

      <section v-if="config.sichuan_312?.ready" class="score-selection-workspace" aria-labelledby="score-selection-title">
        <div class="score-selection-heading">
          <div>
            <h3 id="score-selection-title">学生选科</h3>
            <p>先选择学生，再统一分配组合；个别学生可在名单中直接修改。</p>
          </div>
          <div class="score-selection-progress">
            <strong>{{ selectionCounts.all - selectionCounts.unset }}</strong> / {{ selectionCounts.all }} 已登记
          </div>
        </div>

        <div class="score-selection-toolbar">
          <div class="score-selection-filters" role="group" aria-label="筛选学生选科状态">
            <button :class="{ active: selectionFilter === 'all' }" @click="selectionFilter = 'all'">全部 {{ selectionCounts.all }}</button>
            <button :class="{ active: selectionFilter === 'unset' }" @click="selectionFilter = 'unset'">未配置 {{ selectionCounts.unset }}</button>
            <button :class="{ active: selectionFilter === 'invalid' }" @click="selectionFilter = 'invalid'">待确认 {{ selectionCounts.invalid }}</button>
          </div>
          <div class="score-batch-assign">
            <select v-model="batchCombinationCode" class="form-select" aria-label="批量选择选科组合">
              <option v-for="combination in combinationOptions" :key="combination.code" :value="combination.code">
                {{ combination.code }} · {{ combination.label }}
              </option>
            </select>
            <button class="btn btn-primary" :disabled="batchSaving || !selectedSelectionStudentIds.length" @click="applyBatchCombination">
              {{ batchSaving ? '正在登记…' : `应用到已选 ${selectedSelectionStudentIds.length} 人` }}
            </button>
          </div>
        </div>

        <div class="table-wrap score-selection-table-wrap">
          <table class="data-table score-selection-table">
            <thead>
              <tr>
                <th class="selection-checkbox-column">
                  <label class="selection-select-current">
                    <input type="checkbox" :checked="allFilteredSelectionStudentsSelected" @change="toggleFilteredSelectionStudents">
                    <span>选择当前名单</span>
                  </label>
                </th>
                <th>学生</th><th>当前组合</th><th>快速修改</th><th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="student in filteredSelectionStudents" :key="student.student_id">
                <td class="selection-checkbox-column">
                  <input v-model="selectedSelectionStudentIds" type="checkbox" :value="student.student_id" :aria-label="`选择${student.姓名}`">
                </td>
                <td><strong>{{ student.姓名 }}</strong><small class="table-sub">{{ student.学号 }}</small></td>
                <td>
                  <template v-if="combinationForSubjectIds(student.selected_subject_ids)">
                    <strong class="combination-code">{{ combinationForSubjectIds(student.selected_subject_ids).code }}</strong>
                    <small class="table-sub">{{ combinationForSubjectIds(student.selected_subject_ids).label }}</small>
                  </template>
                  <span v-else class="selection-empty">尚未登记</span>
                </td>
                <td>
                  <select class="form-select student-combination-select" :value="combinationForSubjectIds(student.selected_subject_ids)?.code || ''" :aria-label="`修改${student.姓名}的选科组合`" @change="saveStudentCombination(student, $event.target.value)">
                    <option value="" disabled>选择组合</option>
                    <option v-for="combination in combinationOptions" :key="combination.code" :value="combination.code">{{ combination.code }}</option>
                  </select>
                </td>
                <td><span class="score-status" :class="student.selection_configured && student.selection_status !== '有效' ? 'status-incomplete' : student.selection_configured ? 'status-stable' : 'status-unset'">{{ student.selection_configured ? student.selection_status : '未配置' }}</span></td>
              </tr>
            </tbody>
          </table>
          <div v-if="!filteredSelectionStudents.length" class="empty-state compact">当前筛选下没有学生。</div>
        </div>
      </section>

      <details class="score-advanced-config">
        <summary>高级科目与考试设置 <span>日常登记选科无需进入这里</span></summary>
        <div class="score-config-grid">
          <div>
            <h3>科目</h3>
            <div class="config-create-row subject-create">
              <input v-model.trim="newSubject.name" class="form-input" placeholder="科目名称">
              <input v-model.number="newSubject.full_score" class="form-input" type="number" min="0" placeholder="满分">
              <select v-model="newSubject.subject_group" class="form-select" aria-label="科目分组"><option>必考</option><option>首选</option><option>再选</option><option>选考</option></select>
              <select v-model="newSubject.score_type" class="form-select" aria-label="成绩口径"><option>原始分</option><option>等级赋分</option></select>
              <button class="btn btn-primary" :disabled="!newSubject.name" @click="addSubject">添加</button>
            </div>
            <div class="config-list">
              <div v-for="subject in config.subjects" :key="subject.id" class="config-row">
                <input v-model="subject.name" class="form-input" aria-label="科目名称" :disabled="isStandardSubject(subject)">
                <input v-model.number="subject.full_score" class="form-input" type="number" min="0" aria-label="科目满分">
                <select v-model="subject.subject_group" class="form-select" aria-label="科目分组" :disabled="isStandardSubject(subject)"><option>必考</option><option>首选</option><option>再选</option><option>选考</option></select>
                <select v-model="subject.score_type" class="form-select" aria-label="成绩口径" :disabled="isStandardSubject(subject)"><option>原始分</option><option>等级赋分</option></select>
                <label><input v-model="subject.enabled" type="checkbox" :disabled="isStandardSubject(subject)"> 启用</label>
                <button class="btn btn-sm btn-outline" @click="saveSubject(subject)">保存</button>
              </div>
            </div>
          </div>
          <div>
            <h3>考试</h3>
            <div class="config-create-row exam-create">
              <input v-model.trim="newExam.name" class="form-input" placeholder="考试名称">
              <input v-model="newExam.exam_date" class="form-input" type="date" aria-label="考试日期">
            </div>
            <div class="subject-checks">
              <label v-for="subject in config.subjects.filter(item => item.enabled)" :key="subject.id">
                <input v-model="newExam.subject_ids" type="checkbox" :value="subject.id"> {{ subject.name }}
              </label>
              <button class="btn btn-primary" :disabled="!newExam.name || !newExam.subject_ids.length" @click="addExam">添加考试</button>
            </div>
            <div class="config-list exam-config-list">
              <details v-for="exam in config.exams" :key="exam.id">
                <summary>{{ exam.name }} · {{ exam.exam_date || '日期未填' }} · {{ exam.subject_ids.length }} 科</summary>
                <div class="exam-edit-grid">
                  <input v-model="exam.name" class="form-input" aria-label="考试名称">
                  <input v-model="exam.exam_date" class="form-input" type="date" aria-label="考试日期">
                  <label><input v-model="exam.enabled" type="checkbox"> 启用</label>
                </div>
                <div class="subject-checks">
                  <label v-for="subject in config.subjects.filter(item => item.enabled)" :key="subject.id">
                    <input v-model="exam.subject_ids" type="checkbox" :value="subject.id"> {{ subject.name }}
                  </label>
                  <button class="btn btn-sm btn-outline" @click="saveExam(exam)">保存考试</button>
                </div>
              </details>
            </div>
          </div>
        </div>
      </details>
    </section>

    <div v-if="summary.exams.length" class="score-exam-tabs" role="tablist" aria-label="选择考试">
      <button v-for="exam in summary.exams" :key="exam.id" :class="{ active: Number(selectedExamId) === Number(exam.id) }" @click="selectedExamId = exam.id">
        <span>{{ exam.name }}</span><small>{{ exam.exam_date || '日期未填' }}</small>
      </button>
    </div>

    <template v-if="selectedExam">
      <section class="overview-cards score-overview" aria-label="考试概况">
        <div class="overview-card"><div class="oc-icon blue"><Users :size="20" /></div><div><div class="oc-label">完整总分</div><strong>{{ selectedExam.complete_count }} / {{ selectedExam.student_count }}</strong><div class="hint">{{ selectedExam.missing_count }} 人数据不完整</div></div></div>
        <div class="overview-card"><div class="oc-icon green"><TrendingUp :size="20" /></div><div><div class="oc-label">班级平均总分</div><strong>{{ selectedExam.class_average_total ?? '—' }}</strong><div class="hint">仅统计完整总分</div></div></div>
        <div class="overview-card"><div class="oc-icon orange"><AlertTriangle :size="20" /></div><div><div class="oc-label">缺考或未录入</div><strong>{{ selectedExam.missing_count }}</strong><div class="hint">不按 0 分处理</div></div></div>
        <button class="overview-card export-score-card" @click="exportExam"><Download :size="20" /><span>导出本次考试</span></button>
      </section>

      <section class="card">
        <div class="card-title"><TrendingUp :size="16" /> 科目统计</div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>科目</th><th>分组</th><th>满分</th><th>平均分</th><th>适用人数</th><th>有效成绩</th><th>缺考</th><th>未录入/免考</th></tr></thead>
            <tbody><tr v-for="item in selectedExam.subject_stats" :key="item.subject_id"><td><strong>{{ item.subject }}</strong></td><td>{{ summary.subjects.find(subject => subject.id === item.subject_id)?.subject_group || '必考' }}</td><td>{{ item.full_score || '未设置' }}</td><td>{{ item.average ?? '—' }}</td><td>{{ item.eligible_count ?? selectedExam.student_count }}</td><td>{{ item.recorded_count }}</td><td>{{ item.absent_count }}</td><td>{{ item.missing_count }}</td></tr></tbody>
          </table>
        </div>
      </section>
    </template>

    <div class="score-student-workspace">
    <section class="card score-class-overview-card">
      <div class="score-section-head">
        <div><div class="card-title"><Users :size="16" /> 班级学生总览</div><p class="chart-text-summary">{{ trendSummary }} 点击学生行切换右侧详情。</p></div>
        <label class="score-student-search">搜索学生<input v-model.trim="studentKeyword" class="form-input" placeholder="姓名或学号"></label>
      </div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!studentOverviewRows.length" class="empty-state">还没有匹配的学生成绩。</div>
      <div v-else class="table-wrap score-student-overview-wrap">
        <table class="data-table score-student-overview-table">
          <thead><tr><th>学生</th><th>最近总分</th><th>分数变化</th><th>排名</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="student in studentOverviewRows" :key="student.student_id" class="score-student-row" :class="{ active: selectedStudent?.student_id === student.student_id }" tabindex="0" :aria-current="selectedStudent?.student_id === student.student_id ? 'true' : undefined" @click="selectStudent(student)" @keydown.enter.prevent="selectStudent(student)" @keydown.space.prevent="selectStudent(student)">
              <td><div class="student-overview-name"><strong>{{ student.姓名 }}</strong><small class="table-sub">{{ student.学号 }}</small></div></td>
              <td><strong>{{ student.latest?.total ?? '—' }}</strong><small class="table-sub">{{ summary.exams.at(-1)?.name }}</small></td>
              <td :class="student.latest?.total_change < 0 ? 'score-change-down' : 'score-change-up'">{{ formatChange(student.latest?.total_change, ' 分') }}</td>
              <td>{{ student.latest?.rank ?? '—' }}<small v-if="student.latest?.stratum" class="table-sub">{{ student.latest.stratum }}</small></td>
              <td><span class="score-status" :class="student.status === '需要关注' ? 'status-attention' : ['数据不完整', '选科待确认'].includes(student.status) ? 'status-incomplete' : 'status-stable'">{{ student.status }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="selectedStudent" ref="detailSection" class="card score-student-detail-card">
      <div class="score-student-detail-head">
        <div><div class="card-title"><TrendingUp :size="16" /> 学生成绩详情</div><h2>{{ selectedStudent.姓名 }} <small>{{ selectedStudent.学号 }}</small></h2><p class="hint">按科目查看 {{ summary.exams.length }} 次考试成绩，缺考和未录入不会按 0 分计算。</p></div>
        <label>切换学生<select v-model="detailStudentId" class="form-select" @change="scrollToDetail"><option v-for="student in summary.students" :key="student.student_id" :value="student.student_id">{{ student.姓名 }} · {{ student.学号 }}</option></select></label>
      </div>
      <div class="student-detail-summary">
        <div><span>最近总分</span><strong>{{ selectedStudentLatest?.total ?? '—' }}</strong><small>{{ summary.exams.at(-1)?.name }}</small></div>
        <div><span>较上次变化</span><strong :class="selectedStudentLatest?.total_change < 0 ? 'score-change-down' : 'score-change-up'">{{ formatChange(selectedStudentLatest?.total_change, ' 分') }}</strong><small>总分变化</small></div>
        <div><span>最近排名</span><strong>{{ selectedStudentLatest?.rank ?? '—' }}</strong><small>{{ selectedStudentLatest?.stratum || '暂无分层' }}</small></div>
      </div>
      <div class="table-wrap score-student-detail-wrap">
        <table class="data-table score-student-detail-table">
          <thead><tr><th>科目</th><th v-for="exam in summary.exams" :key="exam.id">{{ exam.name }}<small class="table-sub">{{ exam.exam_date || '日期未填' }}</small></th></tr></thead>
          <tbody><tr v-for="subject in selectedStudentSubjects" :key="subject.id"><td><strong>{{ subject.name }}</strong><small class="table-sub">{{ subject.subject_group }} · 满分 {{ subject.full_score || '未设置' }}</small></td><td v-for="item in subject.exams" :key="item.exam.id" class="score-detail-cell"><strong v-if="item.status === '正常'">{{ item.score }}</strong><span v-else :class="item.status === '未选科' ? 'score-not-selected' : 'score-missing'">{{ item.status }}</span></td></tr></tbody>
        </table>
      </div>
    </section>
    </div>

    <section class="card score-rules-card">
      <div class="card-title"><TrendingDown :size="16" /> 成绩异常规则 <span class="count">导入完成后自动检查</span><button class="btn btn-sm btn-outline card-title-action" @click="evaluateRules">立即检查</button></div>
      <div class="score-rule-create">
        <input v-model.trim="newRule.name" class="form-input" placeholder="规则名称">
        <select v-model="newRule.metric" class="form-select"><option>总分下降</option><option>排名下降</option><option>单科下降</option></select>
        <select v-if="newRule.metric === '单科下降'" v-model="newRule.subject_id" class="form-select"><option :value="null">选择科目</option><option v-for="subject in config.subjects.filter(item => item.enabled)" :key="subject.id" :value="subject.id">{{ subject.name }}</option></select>
        <input v-model.number="newRule.threshold" class="form-input" type="number" min="1" aria-label="成绩规则阈值">
        <select v-model="newRule.priority" class="form-select"><option>普通</option><option>重要</option><option>紧急</option></select>
        <button class="btn btn-primary" @click="addRule">新增规则</button>
      </div>
      <div v-if="!rules.length" class="empty-state compact">还没有成绩异常规则。规则只比较同一学生最近两次可比考试。</div>
      <article v-for="rule in rules" :key="rule.id" class="score-rule-item">
        <div><strong>{{ rule.name }}</strong><span>{{ rule.metric }}{{ rule.subject_name ? ` · ${rule.subject_name}` : '' }} ≥ {{ rule.threshold }} · {{ rule.priority }}</span><small>最近执行：{{ rule.last_run_at || '尚未执行' }}</small></div>
        <div class="rule-actions"><span>待处理 {{ rule.active_hit_count }}</span><span>已处理 {{ rule.handled_hit_count }}</span><button class="btn btn-sm" :class="rule.enabled ? 'btn-success' : 'btn-outline'" @click="toggleRule(rule)">{{ rule.enabled ? '已启用' : '已停用' }}</button><button class="icon-btn danger" aria-label="删除成绩规则" @click="removeRule(rule)"><Trash2 :size="14" /></button></div>
        <router-link v-for="hit in rule.hits" :key="hit.id" class="score-rule-hit" :to="`/tasks?bucket=all&task=${hit.task_id}&action=edit`"><span><strong>{{ hit.student_name }}</strong> · {{ hit.previous_exam_name }} → {{ hit.current_exam_name }} · {{ hit.current_value }}</span><em>{{ hit.status }} · {{ hit.task_status || '无工作项' }}</em></router-link>
      </article>
      <details v-if="recentRuns.length" class="score-rule-history"><summary><History :size="13" /> 最近执行历史</summary><div v-for="run in recentRuns" :key="run.id"><span>{{ run.created_at }} · {{ run.trigger_type }}</span><small>命中 {{ run.hit_count }} · 新建 {{ run.created_count }} · 重开 {{ run.reopened_count }} · 解除 {{ run.resolved_count }}</small></div></details>
    </section>

    <details class="card score-raw-records">
      <summary><span class="card-title"><Users :size="16" /> 原始成绩记录 <span class="count">{{ selectedRecords.length }} 条 · {{ selectedExam?.name || '当前考试' }}</span></span><span class="raw-records-hint">按考试核对各科成绩，删除单条记录</span></summary>
      <div v-if="summary.exams.length" class="score-raw-exam-tabs" role="tablist" aria-label="选择原始成绩考试">
        <button v-for="exam in summary.exams" :key="exam.id" type="button" role="tab" :aria-selected="Number(selectedExamId) === Number(exam.id)" :class="{ active: Number(selectedExamId) === Number(exam.id) }" @click="selectedExamId = exam.id">
          <span>{{ exam.name }}</span><small>{{ exam.exam_date || '日期未填' }}</small>
        </button>
      </div>
      <div v-if="!selectedRecords.length" class="empty-state compact">当前考试还没有成绩记录</div>
      <div v-else class="table-wrap score-raw-record-table-wrap"><table class="data-table score-raw-record-table"><thead><tr><th>学生</th><th v-for="subject in selectedRawSubjects" :key="subject.subject_id">{{ subject.subject }}<small class="table-sub">满分 {{ subject.full_score || '未设置' }}</small></th></tr></thead><tbody><tr v-for="student in rawStudentRows" :key="student.student_id"><td><strong>{{ student.姓名 }}</strong><small class="table-sub">{{ student.学号 }}</small></td><td v-for="subject in selectedRawSubjects" :key="subject.subject_id" class="score-raw-cell"><template v-if="rawRecordFor(student.student_id, subject.subject)"><strong :class="rawRecordFor(student.student_id, subject.subject).record_status === '正常' ? '' : 'score-raw-status'">{{ rawRecordFor(student.student_id, subject.subject).record_status === '正常' ? rawRecordFor(student.student_id, subject.subject).score : rawRecordFor(student.student_id, subject.subject).record_status }}</strong><small v-if="rawRecordFor(student.student_id, subject.subject).note" class="table-sub">{{ rawRecordFor(student.student_id, subject.subject).note }}</small></template><span v-else class="score-raw-empty">—</span></td></tr></tbody></table></div>
    </details>

    <p v-if="summary.definition?.missing" class="score-definition">{{ summary.definition.missing }} {{ summary.definition.total }} {{ summary.definition.rank }} {{ summary.definition.stratum }}</p>

    <div v-if="preview" class="modal-overlay" @click.self="closePreview">
      <section class="score-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="score-preview-title">
        <div class="preview-header"><div><div id="score-preview-title" class="preview-title">确认成绩导入</div><p>{{ preview.filename }} · {{ preview.format === 'long' ? '长表' : '宽表' }}</p></div><button class="icon-btn" aria-label="关闭预览" @click="closePreview"><X :size="18" /></button></div>
        <div class="preview-controls"><label>重复记录<select v-model="duplicateStrategy" class="form-select" @change="runPreview"><option value="update">更新已有成绩</option><option value="skip">保留已有成绩</option></select></label><div class="preview-counts"><span class="ok">可提交 {{ preview.summary.valid }}</span><span>新增 {{ preview.summary.new }}</span><span>更新 {{ preview.summary.update }}</span><span>跳过 {{ preview.summary.skip }}</span><span :class="{ danger: preview.summary.error }">错误 {{ preview.summary.error }}</span></div></div>
        <div v-if="preview.summary.new_exams || preview.summary.new_subjects" class="preview-notice">提交后将自动建立 {{ preview.summary.new_exams }} 个考试配置和 {{ preview.summary.new_subjects }} 个科目配置；请之后补充科目满分。</div>
        <div class="table-wrap preview-table"><table class="data-table"><thead><tr><th>Excel 行</th><th>学生</th><th>考试</th><th>科目</th><th>分数/状态</th><th>动作</th><th>说明</th></tr></thead><tbody><tr v-for="(row, index) in previewRows" :key="`${row.row}-${row.subject}-${index}`" :class="{ 'preview-error-row': !row.valid }"><td>{{ row.row }}</td><td>{{ row.姓名 || row.学号 }}<small class="table-sub">{{ row.学号 }}</small></td><td>{{ row.exam_name }}<small class="table-sub">{{ row.exam_date }}</small></td><td>{{ row.subject }}</td><td>{{ row.record_status === '正常' ? row.score : row.record_status }}</td><td><span class="preview-action" :class="row.action">{{ row.action }}</span></td><td>{{ row.error || (row.new_exam || row.new_subject ? '将创建配置' : '校验通过') }}</td></tr></tbody></table></div>
        <div class="preview-footer"><p v-if="preview.summary.error"><AlertTriangle :size="14" /> 错误行不会提交；其余有效成绩会在一个事务中写入，任何提交错误都会整体回滚。</p><p v-else><CheckCircle :size="14" /> 全部记录校验通过，确认后一次性写入。</p><div><button class="btn btn-outline" @click="closePreview">取消</button><button class="btn btn-primary" :disabled="!commitRows.length || committing" @click="commitImport">{{ committing ? '提交中…' : `确认提交 ${commitRows.length} 条` }}</button></div></div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.scores-actions { margin-bottom: 0; }
.score-config-card { border-color: rgba(82,95,192,.2); }
.score-config-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 18px; }
.score-config-grid h3 { margin: 0 0 10px; font-size: 13px; }
.sichuan-mode-card { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin: 14px 0 18px; padding: 15px 16px; border: 1px solid rgba(82,95,192,.18); border-radius: 14px; background: linear-gradient(135deg, rgba(82,95,192,.08), rgba(82,95,192,.025)); }
.sichuan-mode-card.ready { border-color: rgba(34,170,90,.2); background: linear-gradient(135deg, rgba(34,170,90,.08), rgba(34,170,90,.025)); }
.sichuan-mode-main { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
.sichuan-mode-icon { display: grid; flex: 0 0 38px; width: 38px; height: 38px; place-items: center; border-radius: 11px; background: #fff; color: var(--primary); box-shadow: var(--shadow-sm); }
.sichuan-mode-card.ready .sichuan-mode-icon { color: var(--success); }
.sichuan-mode-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 14px; font-weight: 700; }
.sichuan-mode-title span { padding: 3px 7px; border-radius: 999px; background: rgba(82,95,192,.1); color: var(--primary); font-size: 10px; font-weight: 650; }
.sichuan-mode-card.ready .sichuan-mode-title span { background: rgba(34,170,90,.11); color: var(--success); }
.sichuan-mode-card p { margin: 5px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
.sichuan-mode-issues { margin-top: 6px; color: var(--warning); font-size: 11px; }
.score-selection-workspace { margin-top: 16px; padding: 17px; border: 1px solid var(--border); border-radius: 14px; background: #fff; }
.score-selection-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.score-selection-heading h3 { margin: 0; font-size: 15px; }
.score-selection-heading p { margin: 5px 0 0; color: var(--text-secondary); font-size: 11px; }
.score-selection-progress { color: var(--text-secondary); font-size: 11px; white-space: nowrap; }
.score-selection-progress strong { color: var(--text); font-size: 18px; }
.score-selection-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 16px 0 12px; }
.score-selection-filters { display: inline-flex; gap: 3px; padding: 3px; border-radius: 10px; background: var(--surface-subtle); }
.score-selection-filters button { padding: 6px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 11px; cursor: pointer; }
.score-selection-filters button.active { background: #fff; color: var(--primary); box-shadow: var(--shadow-sm); font-weight: 650; }
.score-batch-assign { display: flex; align-items: center; gap: 8px; }
.score-batch-assign .form-select { min-width: 210px; }
.score-advanced-config { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 14px; }
.score-advanced-config > summary { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; font-weight: 650; }
.score-advanced-config > summary span { color: var(--text-secondary); font-size: 10px; font-weight: 400; }
.config-create-row { display: grid; grid-template-columns: 1fr 105px auto; gap: 8px; }
.config-create-row.subject-create { grid-template-columns: minmax(100px, 1fr) 80px 100px 100px auto; }
.config-create-row.exam-create { grid-template-columns: 1fr 145px; }
.config-list { display: grid; gap: 7px; margin-top: 10px; }
.config-row { display: grid; grid-template-columns: minmax(90px, 1fr) 70px 90px 90px auto auto; align-items: center; gap: 7px; }
.config-row label, .exam-edit-grid label { white-space: nowrap; color: var(--text-secondary); font-size: 12px; }
.subject-checks { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-top: 9px; }
.subject-checks label { font-size: 12px; color: var(--text-secondary); }
.exam-config-list details { padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; }
.exam-config-list summary { cursor: pointer; font-size: 12px; font-weight: 600; }
.exam-edit-grid { display: grid; grid-template-columns: 1fr 145px auto; align-items: center; gap: 8px; margin-top: 10px; }
.score-exam-tabs { display: flex; gap: 8px; margin-bottom: 16px; overflow-x: auto; padding-bottom: 3px; }
.score-exam-tabs button { display: grid; gap: 2px; min-width: 130px; padding: 9px 13px; border: 1px solid var(--border); border-radius: 11px; background: #fff; color: var(--text-secondary); text-align: left; cursor: pointer; }
.score-exam-tabs button.active { border-color: var(--primary); background: var(--primary-bg); color: var(--primary); box-shadow: var(--shadow-sm); }
.score-exam-tabs span { font-weight: 650; }
.score-exam-tabs small { font-size: 10px; opacity: .78; }
.score-overview { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.export-score-card { border: 1px dashed var(--primary); color: var(--primary); align-items: center; justify-content: center; cursor: pointer; font: inherit; font-size: 12px; }
.score-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.score-section-head .chart-text-summary { margin-bottom: 0; }
.score-student-workspace { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(390px, .9fr); align-items: stretch; gap: 16px; }
.score-student-workspace > .card { min-width: 0; height: min(680px, calc(100vh - 120px)); overflow: hidden; }
.score-class-overview-card { display: flex; flex-direction: column; }
.score-student-search { display: grid; flex: 0 1 260px; gap: 5px; color: var(--text-secondary); font-size: 11px; }
.score-student-overview-wrap { flex: 1; min-height: 0; overflow: auto; margin-top: 14px; }
.score-student-overview-table { min-width: 700px; }
.score-student-overview-table tbody tr.score-student-row { cursor: pointer; transition: background .15s ease, box-shadow .15s ease; }
.score-student-overview-table tbody tr.score-student-row:hover { background: var(--surface-subtle); }
.score-student-overview-table tbody tr.score-student-row:active { background: var(--primary-bg); }
.score-student-overview-table tbody tr.score-student-row.active { background: var(--primary-bg); }
.score-student-overview-table tbody tr.score-student-row:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.student-overview-name { display: grid; gap: 2px; }
.score-change-down { color: var(--danger); }
.score-change-up { color: var(--success); }
.score-status { display: inline-flex; align-items: center; padding: 3px 7px; border-radius: 999px; font-size: 11px; white-space: nowrap; }
.status-attention { color: var(--danger); background: rgba(220, 60, 60, .09); }
.status-incomplete { color: var(--warning); background: rgba(210, 145, 20, .11); }
.status-stable { color: var(--success); background: rgba(34, 170, 90, .1); }
.status-unset { color: var(--text-secondary); background: var(--surface-subtle); }
.score-student-detail-card { position: sticky; top: 78px; display: flex; min-height: 0; flex-direction: column; overflow: hidden; border-color: rgba(82, 95, 192, .2); scroll-margin-top: 78px; }
.score-student-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.score-student-detail-head, .student-detail-summary { flex-shrink: 0; }
.score-student-detail-head h2 { margin: 12px 0 3px; font-size: 19px; }
.score-student-detail-head h2 small { margin-left: 6px; color: var(--text-secondary); font-size: 12px; font-weight: 500; }
.score-student-detail-head p { margin: 0; }
.score-student-detail-head > label { display: grid; min-width: 190px; gap: 5px; color: var(--text-secondary); font-size: 11px; }
.student-detail-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; margin: 16px 0; }
.student-detail-summary > div { display: grid; gap: 3px; padding: 11px 13px; border-radius: 10px; background: var(--surface-subtle); }
.student-detail-summary span, .student-detail-summary small { color: var(--text-secondary); font-size: 11px; }
.student-detail-summary strong { font-size: 20px; line-height: 1.15; }
.score-student-detail-wrap { flex: 1; min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-color: rgba(82, 95, 192, .42) rgba(82, 95, 192, .08); scrollbar-width: thin; }
.score-student-detail-wrap::-webkit-scrollbar { width: 8px; height: 8px; }
.score-student-detail-wrap::-webkit-scrollbar-thumb { background: rgba(82, 95, 192, .42); border-radius: 4px; }
.score-student-detail-wrap::-webkit-scrollbar-track { background: rgba(82, 95, 192, .08); border-radius: 4px; }
.score-student-detail-table { min-width: 680px; }
.score-student-detail-table th, .score-student-detail-table td { white-space: nowrap; }
.score-detail-cell { min-width: 92px; text-align: center; }
.score-not-selected { color: var(--text-secondary); font-size: 11px; }
.score-selection-table-wrap { max-height: 360px; overflow: auto; }
.score-selection-table { min-width: 760px; }
.score-selection-table th { position: sticky; top: 0; z-index: 1; background: #fff; }
.selection-checkbox-column { width: 128px; }
.selection-select-current { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 10px; font-weight: 500; }
.selection-select-current input, .score-selection-table td > input { margin: 0; }
.combination-code { color: var(--primary); font-size: 13px; }
.selection-empty { color: var(--text-secondary); font-size: 11px; }
.student-combination-select { min-width: 108px; }
.score-raw-records { padding: 0; overflow: hidden; }
.score-raw-records > summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 17px 18px; cursor: pointer; list-style: none; }
.score-raw-records > summary::-webkit-details-marker { display: none; }
.score-raw-records > summary::after { content: '展开'; color: var(--primary); font-size: 11px; }
.score-raw-records[open] > summary::after { content: '收起'; }
.score-raw-records > summary .card-title { margin: 0; }
.raw-records-hint { margin-left: auto; color: var(--text-secondary); font-size: 11px; }
.score-raw-exam-tabs { display: flex; gap: 7px; margin: 0 18px 12px; overflow-x: auto; padding: 0 0 3px; }
.score-raw-exam-tabs button { display: grid; gap: 2px; min-width: 112px; padding: 8px 11px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-elevated); color: var(--text-secondary); text-align: left; cursor: pointer; }
.score-raw-exam-tabs button.active { border-color: var(--primary); background: var(--primary-bg); color: var(--primary); box-shadow: var(--shadow-sm); }
.score-raw-exam-tabs span { font-size: 11px; font-weight: 650; }
.score-raw-exam-tabs small { font-size: 10px; opacity: .78; }
.score-raw-records > .table-wrap, .score-raw-records > .empty-state { margin: 0 18px 18px; }
.score-raw-record-table-wrap { max-height: 420px; }
.score-raw-record-table { min-width: 720px; }
.score-raw-record-table th, .score-raw-record-table td { white-space: nowrap; }
.score-raw-cell { min-width: 118px; }
.score-raw-cell > strong, .score-raw-cell > small { display: block; }
.score-raw-cell .score-raw-status { color: var(--warning); font-size: 11px; }
.score-raw-empty { color: var(--text-tertiary); }
.score-rule-create { display: grid; grid-template-columns: minmax(150px, 1.3fr) 120px minmax(100px, .8fr) 90px 95px auto; gap: 8px; margin-bottom: 13px; }
.card-title-action { margin-left: auto; }
.score-rule-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px 18px; padding: 14px 0; border-top: 1px solid var(--border); }
.score-rule-item > div:first-child { display: grid; gap: 3px; }
.score-rule-item > div span, .score-rule-item > div small { color: var(--text-secondary); font-size: 11px; }
.rule-actions { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.score-rule-hit { grid-column: 1 / -1; display: flex; justify-content: space-between; gap: 10px; padding: 9px 11px; border-radius: 9px; background: var(--surface-subtle); color: var(--text); font-size: 11px; text-decoration: none; }
.score-rule-hit em { color: var(--primary); font-style: normal; white-space: nowrap; }
.score-rule-history { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 10px; }
.score-rule-history summary { display: flex; align-items: center; gap: 5px; color: var(--text-secondary); font-size: 11px; cursor: pointer; }
.score-rule-history > div { display: flex; justify-content: space-between; padding: 7px 2px; color: var(--text-secondary); font-size: 10px; }
.score-missing { color: var(--warning); font-size: 11px; }
.score-definition { margin: 2px 3px 18px; color: var(--text-secondary); font-size: 11px; line-height: 1.65; }
.empty-state.compact { padding: 18px; }
.score-preview-dialog { width: min(1080px, calc(100vw - 36px)); max-height: min(86vh, 800px); display: flex; flex-direction: column; padding: 22px; border-radius: 18px; background: #fff; box-shadow: var(--shadow-lg); }
.preview-header { display: flex; justify-content: space-between; gap: 16px; }
.preview-title { font-size: 19px; font-weight: 700; }
.preview-header p { margin: 3px 0 0; color: var(--text-secondary); font-size: 11px; }
.preview-controls { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin: 16px 0 10px; }
.preview-controls label { display: grid; gap: 5px; color: var(--text-secondary); font-size: 11px; }
.preview-counts { display: flex; flex-wrap: wrap; gap: 7px; }
.preview-counts span { padding: 4px 7px; border-radius: 7px; background: var(--surface-subtle); font-size: 10px; }
.preview-counts .ok { color: var(--success); }
.preview-counts .danger { color: var(--danger); }
.preview-notice { margin-bottom: 9px; padding: 9px 11px; border-radius: 9px; background: var(--primary-bg); color: var(--primary); font-size: 11px; }
.preview-table { flex: 1; min-height: 180px; overflow: auto; }
.preview-error-row { background: rgba(220,60,60,.045); }
.preview-action { font-size: 10px; font-weight: 650; }
.preview-action.错误 { color: var(--danger); }
.preview-action.新增 { color: var(--success); }
.preview-action.更新 { color: var(--primary); }
.preview-footer { display: flex; justify-content: space-between; align-items: center; gap: 14px; margin-top: 14px; }
.preview-footer p { display: flex; align-items: center; gap: 5px; margin: 0; color: var(--text-secondary); font-size: 11px; }
.preview-footer > div { display: flex; gap: 8px; }
@media (max-width: 900px) {
  .score-config-grid { grid-template-columns: 1fr; }
  .score-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .score-selection-toolbar { align-items: stretch; flex-direction: column; }
  .score-batch-assign { width: 100%; }
  .score-batch-assign .form-select { min-width: 0; flex: 1; }
  .score-student-workspace { grid-template-columns: 1fr; }
  .score-student-workspace > .card { height: auto; overflow: visible; }
  .score-student-overview-wrap { flex: none; max-height: 560px; }
  .score-student-detail-card { position: static; display: block; overflow: visible; }
  .score-student-detail-wrap { flex: none; min-height: 0; }
  .score-section-head, .score-student-detail-head { flex-direction: column; }
  .score-student-search, .score-student-detail-head > label { width: 100%; max-width: none; }
  .score-rule-create { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 680px) {
  .scores-actions { width: 100%; display: grid; grid-template-columns: 1fr 1fr; }
  .sichuan-mode-card, .score-selection-heading { align-items: stretch; flex-direction: column; }
  .sichuan-mode-card > .btn { width: 100%; }
  .score-selection-workspace { padding: 14px; }
  .score-selection-filters { display: grid; grid-template-columns: repeat(3, 1fr); }
  .score-batch-assign { display: grid; grid-template-columns: 1fr; }
  .config-create-row, .config-create-row.exam-create, .config-row, .exam-edit-grid { grid-template-columns: 1fr 1fr; }
  .config-create-row.subject-create { grid-template-columns: 1fr 1fr; }
  .config-row label { align-self: center; }
  .student-detail-summary { grid-template-columns: 1fr; }
  .score-rule-create { grid-template-columns: 1fr; }
  .score-rule-item { grid-template-columns: 1fr; }
  .rule-actions { flex-wrap: wrap; }
  .score-rule-hit { flex-direction: column; }
  .raw-records-hint { display: none; }
  .score-preview-dialog { width: calc(100vw - 20px); max-height: 91vh; padding: 16px; }
  .preview-controls, .preview-footer { align-items: stretch; flex-direction: column; }
  .preview-footer > div { display: grid; grid-template-columns: 1fr 1fr; }
}
</style>
