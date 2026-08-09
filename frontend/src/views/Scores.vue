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
const config = ref({ exams: [], subjects: [] })
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
const detailSection = ref(null)

const selectedExam = computed(() => summary.value.exams.find(item => Number(item.id) === Number(selectedExamId.value)) || null)
const selectedRecords = computed(() => summary.value.records.filter(item => Number(item.exam_id) === Number(selectedExamId.value)))
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
const selectableSubjects = computed(() => config.value.subjects.filter(
  subject => subject.enabled && subject.subject_group !== '必考'
))
const selectionStudents = computed(() => summary.value.students.map(student => ({
  ...student,
  selected_subject_ids: selectionDraft.value[student.student_id] || [],
})))
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
    rules.value = ruleData.rules || []
    recentRuns.value = ruleData.recent_runs || []
    if (!selectedExamId.value || !data.exams.some(item => Number(item.id) === Number(selectedExamId.value))) {
      selectedExamId.value = data.exams.at(-1)?.id || 0
    }
    if (!detailStudentId.value || !data.students.some(item => String(item.student_id) === String(detailStudentId.value))) {
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

async function saveTermSettings() {
  try {
    await put('/api/score-config/settings', config.value.settings)
    message.value = '选科模式已保存'
    await load()
  } catch (error) { message.value = error.message }
}

async function saveStudentSelection(student) {
  try {
    await put(`/api/score-config/students/${student.student_id}/subjects`, {
      subject_ids: selectionDraft.value[student.student_id] || [],
    })
    message.value = `${student.姓名}的选科已保存`
    await load()
  } catch (error) { message.value = error.message }
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

async function removeScore(row) {
  if (!confirm(`删除“${row.姓名} · ${row.exam_name} · ${row.subject}”成绩并移入回收站吗？`)) return
  try {
    await del(`/api/records/exam/${row.id}`)
    message.value = '成绩已移入回收站'
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
      <div class="card-title"><Settings2 :size="16" /> 考试与科目配置</div>
      <div class="score-mode-settings">
        <label>成绩制度<select v-model="config.settings.mode" class="form-select" @change="saveTermSettings"><option>固定科目</option><option>3+1+2</option><option>3+3</option><option>自定义</option></select></label>
        <p>启用选科模式后，必考科目计入所有学生；首选、再选或选考科目按学生的选科记录计入总分。</p>
      </div>
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
              <input v-model="subject.name" class="form-input" aria-label="科目名称">
              <input v-model.number="subject.full_score" class="form-input" type="number" min="0" aria-label="科目满分">
              <select v-model="subject.subject_group" class="form-select" aria-label="科目分组"><option>必考</option><option>首选</option><option>再选</option><option>选考</option></select>
              <select v-model="subject.score_type" class="form-select" aria-label="成绩口径"><option>原始分</option><option>等级赋分</option></select>
              <label><input v-model="subject.enabled" type="checkbox"> 启用</label>
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
      <details v-if="selectableSubjects.length" class="score-selection-settings">
        <summary>学生选科设置 <span class="count">{{ selectableSubjects.length }} 门选考科目</span></summary>
        <p class="hint">首选/再选/选考科目不再默认要求全班统一成绩；请为已确定选科的学生勾选科目。未配置的学生继续兼容旧版“考试配置中的全部科目”口径。</p>
        <div class="table-wrap score-selection-table-wrap">
          <table class="data-table score-selection-table">
            <thead><tr><th>学生</th><th v-for="subject in selectableSubjects" :key="subject.id">{{ subject.name }}<small class="table-sub">{{ subject.subject_group }}</small></th><th>操作</th></tr></thead>
            <tbody><tr v-for="student in selectionStudents" :key="student.student_id"><td><strong>{{ student.姓名 }}</strong><small class="table-sub">{{ student.学号 }}</small></td><td v-for="subject in selectableSubjects" :key="subject.id"><label class="selection-check"><input v-model="selectionDraft[student.student_id]" type="checkbox" :value="subject.id"><span>{{ subject.subject_group }}</span></label></td><td><span class="score-status" :class="student.selection_configured && student.selection_status !== '有效' ? 'status-incomplete' : student.selection_configured ? 'status-stable' : 'status-unset'">{{ student.selection_configured ? student.selection_status : '未配置' }}</span><button class="btn btn-sm btn-outline" type="button" @click="saveStudentSelection(student)">保存</button></td></tr></tbody>
          </table>
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
        <div><div class="card-title"><Users :size="16" /> 班级学生总览</div><p class="chart-text-summary">{{ trendSummary }} 点击学生后查看各科、各次考试的详细成绩。</p></div>
        <label class="score-student-search">搜索学生<input v-model.trim="studentKeyword" class="form-input" placeholder="姓名或学号"></label>
      </div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!studentOverviewRows.length" class="empty-state">还没有匹配的学生成绩。</div>
      <div v-else class="table-wrap score-student-overview-wrap">
        <table class="data-table score-student-overview-table">
          <thead><tr><th>学生</th><th>最近总分</th><th>分数变化</th><th>排名</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="student in studentOverviewRows" :key="student.student_id" :class="{ active: selectedStudent?.student_id === student.student_id }">
              <td><div class="student-overview-name"><router-link :to="`/student/${student.student_id}`" class="table-link">{{ student.姓名 }}</router-link><small class="table-sub">{{ student.学号 }}</small></div></td>
              <td><strong>{{ student.latest?.total ?? '—' }}</strong><small class="table-sub">{{ summary.exams.at(-1)?.name }}</small></td>
              <td :class="student.latest?.total_change < 0 ? 'score-change-down' : 'score-change-up'">{{ formatChange(student.latest?.total_change, ' 分') }}</td>
              <td>{{ student.latest?.rank ?? '—' }}<small v-if="student.latest?.stratum" class="table-sub">{{ student.latest.stratum }}</small></td>
              <td><span class="score-status" :class="student.status === '需要关注' ? 'status-attention' : ['数据不完整', '选科待确认'].includes(student.status) ? 'status-incomplete' : 'status-stable'">{{ student.status }}</span></td>
              <td><button class="btn btn-sm btn-outline" type="button" @click="selectStudent(student)">查看详情</button></td>
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
      <summary><span class="card-title"><Users :size="16" /> 原始成绩记录 <span class="count">{{ selectedRecords.length }} 条 · {{ selectedExam?.name || '当前考试' }}</span></span><span class="raw-records-hint">用于核对和删除单条记录</span></summary>
      <div v-if="!selectedRecords.length" class="empty-state compact">当前考试还没有成绩记录</div>
      <div v-else class="table-wrap" style="max-height:420px"><table class="data-table"><thead><tr><th>学生</th><th>科目</th><th>分数/状态</th><th>备注</th><th>操作</th></tr></thead><tbody><tr v-for="row in selectedRecords" :key="row.id"><td>{{ row.姓名 }}<small class="table-sub">{{ row.学号 }}</small></td><td>{{ row.subject }}</td><td><strong>{{ row.record_status === '正常' ? row.score : row.record_status }}</strong></td><td>{{ row.note || '—' }}</td><td><button class="icon-btn danger" aria-label="删除成绩" @click="removeScore(row)"><Trash2 :size="14" /></button></td></tr></tbody></table></div>
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
.score-config-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.score-config-grid h3 { margin: 0 0 10px; font-size: 13px; }
.score-mode-settings { display: flex; align-items: end; gap: 12px; margin: 14px 0 18px; padding: 11px 13px; border-radius: 10px; background: var(--primary-bg); }
.score-mode-settings label { display: grid; min-width: 150px; gap: 5px; color: var(--text-secondary); font-size: 11px; }
.score-mode-settings p { margin: 0; color: var(--text-secondary); font-size: 11px; line-height: 1.5; }
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
.score-student-workspace { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(390px, .9fr); align-items: start; gap: 16px; }
.score-student-workspace > .card { min-width: 0; }
.score-student-search { display: grid; flex: 0 1 260px; gap: 5px; color: var(--text-secondary); font-size: 11px; }
.score-student-overview-wrap { max-height: 560px; overflow: auto; margin-top: 14px; }
.score-student-overview-table { min-width: 700px; }
.score-student-overview-table tbody tr { transition: background .15s ease; }
.score-student-overview-table tbody tr.active { background: var(--primary-bg); }
.student-overview-name { display: grid; gap: 2px; }
.score-change-down { color: var(--danger); }
.score-change-up { color: var(--success); }
.score-status { display: inline-flex; align-items: center; padding: 3px 7px; border-radius: 999px; font-size: 11px; white-space: nowrap; }
.status-attention { color: var(--danger); background: rgba(220, 60, 60, .09); }
.status-incomplete { color: var(--warning); background: rgba(210, 145, 20, .11); }
.status-stable { color: var(--success); background: rgba(34, 170, 90, .1); }
.status-unset { color: var(--text-secondary); background: var(--surface-subtle); }
.score-student-detail-card { position: sticky; top: 78px; max-height: calc(100vh - 98px); overflow: auto; border-color: rgba(82, 95, 192, .2); scroll-margin-top: 78px; }
.score-student-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.score-student-detail-head h2 { margin: 12px 0 3px; font-size: 19px; }
.score-student-detail-head h2 small { margin-left: 6px; color: var(--text-secondary); font-size: 12px; font-weight: 500; }
.score-student-detail-head p { margin: 0; }
.score-student-detail-head > label { display: grid; min-width: 190px; gap: 5px; color: var(--text-secondary); font-size: 11px; }
.student-detail-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; margin: 16px 0; }
.student-detail-summary > div { display: grid; gap: 3px; padding: 11px 13px; border-radius: 10px; background: var(--surface-subtle); }
.student-detail-summary span, .student-detail-summary small { color: var(--text-secondary); font-size: 11px; }
.student-detail-summary strong { font-size: 20px; line-height: 1.15; }
.score-student-detail-wrap { overflow-x: auto; }
.score-student-detail-table { min-width: 680px; }
.score-student-detail-table th, .score-student-detail-table td { white-space: nowrap; }
.score-detail-cell { min-width: 92px; text-align: center; }
.score-not-selected { color: var(--text-secondary); font-size: 11px; }
.score-selection-settings { margin-top: 18px; border-top: 1px solid var(--border); padding-top: 14px; }
.score-selection-settings summary { cursor: pointer; font-size: 12px; font-weight: 650; }
.score-selection-settings > .hint { margin: 8px 0 12px; }
.score-selection-table-wrap { max-height: 360px; overflow: auto; }
.score-selection-table { min-width: 720px; }
.selection-check { display: grid; justify-items: center; gap: 3px; color: var(--text-secondary); font-size: 10px; }
.selection-check input { margin: 0; }
.score-selection-table td:last-child { display: flex; align-items: center; gap: 7px; }
.score-raw-records { padding: 0; overflow: hidden; }
.score-raw-records > summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 17px 18px; cursor: pointer; list-style: none; }
.score-raw-records > summary::-webkit-details-marker { display: none; }
.score-raw-records > summary::after { content: '展开'; color: var(--primary); font-size: 11px; }
.score-raw-records[open] > summary::after { content: '收起'; }
.score-raw-records > summary .card-title { margin: 0; }
.raw-records-hint { margin-left: auto; color: var(--text-secondary); font-size: 11px; }
.score-raw-records > .table-wrap, .score-raw-records > .empty-state { margin: 0 18px 18px; }
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
  .score-mode-settings { align-items: stretch; flex-direction: column; }
  .score-mode-settings label { width: 100%; }
  .score-student-workspace { grid-template-columns: 1fr; }
  .score-student-detail-card { position: static; max-height: none; overflow: visible; }
  .score-section-head, .score-student-detail-head { flex-direction: column; }
  .score-student-search, .score-student-detail-head > label { width: 100%; max-width: none; }
  .score-rule-create { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 680px) {
  .scores-actions { width: 100%; display: grid; grid-template-columns: 1fr 1fr; }
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
