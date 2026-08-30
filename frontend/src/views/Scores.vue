<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  AlertTriangle, ArrowRight, CheckCircle, Download, FileUp, History, MoreHorizontal,
  Settings2, Trash2, TrendingDown, TrendingUp, Users, X
} from 'lucide-vue-next'
import { del, get, post, put, upload } from '../api'
import { useConfirmDialog } from '../composables/confirmDialog'

const route = useRoute()
const sourceId = Number(route.query.source_id || 0)
const summary = ref({ exams: [], subjects: [], students: [], records: [], definition: {} })
const config = ref({ exams: [], subjects: [], settings: { mode: '固定科目' }, sichuan_312: { ready: false, issues: [], combinations: [] } })
const rules = ref([])
const recentRuns = ref([])
const loading = ref(true)
const pageError = ref('')
const message = ref('')
const selectedExamId = ref(0)
const selectedStudentId = ref(0)
const studentKeyword = ref('')
const studentFilter = ref('all')
const examDialogOpen = ref(false)
const advancedOpen = ref(false)
const rawOpen = ref(false)
const fileInput = ref(null)
const selectedFile = ref(null)
const importing = ref(false)
const preview = ref(null)
const duplicateStrategy = ref('update')
const committing = ref(false)
const applyingPreset = ref(false)
const batchSaving = ref(false)
const selectionDraft = ref({})
const selectionFilter = ref('all')
const selectedSelectionStudentIds = ref([])
const batchCombinationCode = ref('')
const detailSection = ref(null)
const newSubject = ref({ name: '', full_score: 100, subject_group: '必考', score_type: '原始分' })
const newExam = ref({ name: '', exam_date: '', subject_ids: [] })
const examDraft = ref({ name: '', exam_date: '', full_score: 100, remark: '' })
const newRule = ref({ name: '总分明显下降', metric: '总分下降', subject_id: null, threshold: 20, priority: '重要' })
const { confirm: confirmDialog } = useConfirmDialog()

const selectedExam = computed(() => summary.value.exams.find(item => Number(item.id) === Number(selectedExamId.value)) || null)
const selectedRecords = computed(() => summary.value.records.filter(item => Number(item.exam_id) === Number(selectedExamId.value)))
const selectedRawSubjects = computed(() => selectedExam.value?.subject_stats || [])
const rawRecordMap = computed(() => new Map(selectedRecords.value.map(row => [`${row.student_id}:${row.configured_subject_name || row.subject}`, row])))
const rawStudentRows = computed(() => {
  const ids = new Set(selectedRecords.value.map(row => Number(row.student_id)))
  return summary.value.students.filter(student => ids.has(Number(student.student_id)))
})
const previewRows = computed(() => preview.value?.rows || [])
const commitRows = computed(() => previewRows.value.filter(item => item.valid && item.action !== '跳过'))
const selectedStudent = computed(() => summary.value.students.find(student => Number(student.student_id) === Number(selectedStudentId.value)) || null)
const selectedStudentLatest = computed(() => selectedStudent.value && selectedExam.value ? studentExam(selectedStudent.value, selectedExam.value.id) : null)
const selectedStudentSubjects = computed(() => summary.value.subjects.map(subject => ({
  ...subject,
  exams: summary.value.exams.map(exam => {
    const result = selectedStudent.value ? studentExam(selectedStudent.value, exam.id) : null
    const item = result?.subjects?.[subject.name]
    return { exam, score: item?.score, status: item?.status || '未录入' }
  }),
})))
const selectedExamFullScore = computed(() => examFullScore(selectedExam.value))
const selectedExamResults = computed(() => summary.value.students.map(student => ({
  student, result: selectedExam.value ? studentExam(student, selectedExam.value.id) : null,
})).filter(item => item.result?.total !== null && item.result?.total !== undefined))
const selectedExamMetrics = computed(() => {
  const results = selectedExamResults.value.map(item => Number(item.result.total)).filter(Number.isFinite)
  const fullScore = selectedExamFullScore.value
  const passCount = fullScore > 0 ? results.filter(score => score / fullScore >= .6).length : 0
  return {
    average: selectedExam.value?.class_average_total ?? average(results),
    highest: results.length ? Math.max(...results) : null,
    lowest: results.length ? Math.min(...results) : null,
    passRate: fullScore > 0 && results.length ? Math.round((passCount / results.length) * 100) : null,
    fullScore,
    complete: results.length,
    total: summary.value.students.length,
  }
})
const distribution = computed(() => {
  const fullScore = selectedExamFullScore.value
  const buckets = [
    { label: '90–100%', min: .9, max: 1, tone: 'success' },
    { label: '80–89%', min: .8, max: .9, tone: 'primary' },
    { label: '70–79%', min: .7, max: .8, tone: 'primary' },
    { label: '60–69%', min: .6, max: .7, tone: 'warning' },
    { label: '< 60%', min: 0, max: .6, tone: 'danger' },
  ]
  return buckets.map(bucket => ({ ...bucket, count: fullScore > 0 ? selectedExamResults.value.filter(({ result }) => {
    const rate = Number(result.total) / fullScore
    return rate >= bucket.min && rate < bucket.max
  }).length : 0 })).map(bucket => ({ ...bucket, width: selectedExamResults.value.length ? `${Math.round((bucket.count / selectedExamResults.value.length) * 100)}%` : '0%' }))
})
const attentionStudents = computed(() => {
  const fullScore = selectedExamFullScore.value
  if (!fullScore) return []
  return summary.value.students.map(student => {
    const result = selectedExam.value ? studentExam(student, selectedExam.value.id) : null
    if (result?.total === null || result?.total === undefined) return null
    const rate = Number(result.total) / fullScore
    const currentIndex = student.exams.findIndex(item => Number(item.exam_id) === Number(selectedExam.value.id))
    const previous = student.exams.slice(0, currentIndex).reverse().find(item => item.total !== null && item.total !== undefined)
    const previousFullScore = previous ? examFullScore(summary.value.exams.find(exam => Number(exam.id) === Number(previous.exam_id))) : 0
    const change = previous && previousFullScore ? rate * 100 - (Number(previous.total) / previousFullScore) * 100 : null
    let reason = ''
    let priority = 4
    if (rate < .6) { reason = '低于及格线'; priority = 1 }
    else if (change !== null && change <= -10) { reason = `较上次下降 ${Math.round(Math.abs(change))} 分`; priority = 2 }
    else if (rate < .65) { reason = '接近及格线'; priority = 3 }
    else if (rate >= .85 && rate < .9) { reason = '距优秀线较近'; priority = 4 }
    if (!reason) return null
    return { student, result, reason, priority, change }
  }).filter(Boolean).sort((a, b) => a.priority - b.priority || Number(a.result.total) - Number(b.result.total)).slice(0, 5)
})
const trendData = computed(() => summary.value.exams.map(exam => {
  const fullScore = examFullScore(exam)
  const values = summary.value.students.map(student => studentExam(student, exam.id)?.total).filter(value => value !== null && value !== undefined).map(Number)
  const rate = fullScore > 0 && values.length ? (values.reduce((sum, value) => sum + value / fullScore * 100, 0) / values.length) : null
  return { ...exam, fullScore, rate, average: values.length ? average(values) : null }
}))
const studentOverviewRows = computed(() => {
  const keyword = studentKeyword.value.trim().toLowerCase()
  return summary.value.students.map(student => {
    const latest = selectedExam.value ? studentExam(student, selectedExam.value.id) : null
    const rate = latest?.total !== null && latest?.total !== undefined && selectedExamFullScore.value > 0 ? Number(latest.total) / selectedExamFullScore.value : null
    const status = !latest?.has_any ? '未录入' : latest.missing_subjects?.length ? '数据不完整' : rate !== null && rate < .6 ? '需要关注' : '正常'
    return { ...student, latest, rate, status }
  }).filter(student => {
    if (keyword && !`${student.姓名} ${student.学号}`.toLowerCase().includes(keyword)) return false
    if (studentFilter.value === 'attention') return student.status === '需要关注'
    if (studentFilter.value === 'decline') return attentionStudents.value.some(item => item.student.student_id === student.student_id && item.change !== null && item.change <= -10)
    return true
  })
})
const combinationOptions = computed(() => config.value.sichuan_312?.combinations || [])
const selectionStudents = computed(() => summary.value.students.map(student => ({ ...student, selected_subject_ids: selectionDraft.value[student.student_id] || [] })))
const selectionCounts = computed(() => ({
  all: selectionStudents.value.length,
  unset: selectionStudents.value.filter(student => !student.selection_configured).length,
  invalid: selectionStudents.value.filter(student => student.selection_configured && student.selection_status !== '有效').length,
}))
const filteredSelectionStudents = computed(() => selectionStudents.value.filter(student => selectionFilter.value === 'unset' ? !student.selection_configured : selectionFilter.value === 'invalid' ? student.selection_configured && student.selection_status !== '有效' : true))
const allFilteredSelectionStudentsSelected = computed(() => filteredSelectionStudents.value.length > 0 && filteredSelectionStudents.value.every(student => selectedSelectionStudentIds.value.includes(student.student_id)))
const selectedRecordsLabel = computed(() => `${selectedRecords.value.length} 条 · ${selectedExam.value?.name || '当前考试'}`)

function average(values) { return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null }
function examFullScore(exam) {
  const explicit = Number(exam?.full_score || 0)
  if (explicit > 0) return explicit
  return (exam?.subject_stats || []).reduce((sum, subject) => sum + Number(subject.full_score || 0), 0)
}
function studentExam(student, examId) { return student.exams.find(item => Number(item.exam_id) === Number(examId)) }
function formatChange(value, suffix = '') {
  if (value === null || value === undefined) return '—'
  if (value > 0) return `↑ ${value}${suffix}`
  if (value < 0) return `↓ ${Math.abs(value)}${suffix}`
  return `持平${suffix}`
}
function rawRecordFor(studentId, subjectName) { return rawRecordMap.value.get(`${studentId}:${subjectName}`) }
function statusClass(status) { return status === '需要关注' ? 'status-attention' : status === '数据不完整' ? 'status-incomplete' : status === '未录入' ? 'status-unset' : 'status-stable' }
function localDate() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }

async function load() {
  loading.value = true
  pageError.value = ''
  try {
    const [data, configData, ruleData] = await Promise.all([
      get('/api/exams/summary'), get('/api/score-config'), get(sourceId ? `/api/score-rules?source_id=${sourceId}` : '/api/score-rules'),
    ])
    summary.value = data
    config.value = configData
    selectionDraft.value = Object.fromEntries(data.students.map(student => [student.student_id, [...(student.selected_subject_ids || [])]]))
    if (!batchCombinationCode.value && configData.sichuan_312?.combinations?.length) batchCombinationCode.value = configData.sichuan_312.combinations[0].code
    rules.value = ruleData.rules || []
    recentRuns.value = ruleData.recent_runs || []
    if (!selectedExamId.value || !data.exams.some(item => Number(item.id) === Number(selectedExamId.value))) selectedExamId.value = data.exams.at(-1)?.id || 0
    const requestedStudentId = Number(route.query.student_id || 0)
    if (requestedStudentId && data.students.some(item => Number(item.student_id) === requestedStudentId)) selectedStudentId.value = requestedStudentId
    else if (!selectedStudentId.value || !data.students.some(item => Number(item.student_id) === Number(selectedStudentId.value))) selectedStudentId.value = data.students[0]?.student_id || 0
  } catch (error) { pageError.value = error.message } finally { loading.value = false }
}

function openExamDialog() {
  const defaultFullScore = config.value.subjects.filter(item => item.enabled).reduce((sum, item) => sum + Number(item.full_score || 0), 0)
  examDraft.value = { name: '', exam_date: localDate(), full_score: defaultFullScore || 100, remark: '' }
  examDialogOpen.value = true
}
async function saveNewExam() {
  const subjectIds = config.value.subjects.filter(item => item.enabled).map(item => Number(item.id))
  if (!examDraft.value.name.trim()) { message.value = '请填写考试名称'; return }
  if (!subjectIds.length) { message.value = '请先在“更多设置”中配置至少一个科目'; return }
  try {
    const result = await post('/api/score-config/exams', { name: examDraft.value.name, exam_date: examDraft.value.exam_date, full_score: Number(examDraft.value.full_score || 0), remark: examDraft.value.remark, subject_ids: subjectIds })
    selectedExamId.value = result.exam_id
    examDialogOpen.value = false
    message.value = '考试已创建，可以开始录入成绩'
    await load()
  } catch (error) { message.value = error.message }
}
function pickFile() { fileInput.value?.click() }
async function previewFile(event) { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; selectedFile.value = file; await runPreview() }
async function runPreview() {
  if (!selectedFile.value) return
  importing.value = true; message.value = ''
  try { preview.value = await upload(`/api/exams/import/preview?duplicate_strategy=${duplicateStrategy.value}`, selectedFile.value) } catch (error) { message.value = `检查失败：${error.message}` } finally { importing.value = false }
}
function closePreview() { preview.value = null; selectedFile.value = null }
async function commitImport() {
  if (!commitRows.value.length) return
  committing.value = true
  try {
    const result = await post('/api/exams/import/commit', { filename: preview.value.filename, duplicate_strategy: duplicateStrategy.value, request_id: globalThis.crypto?.randomUUID?.() || `score-${Date.now()}`, rows: commitRows.value })
    message.value = `已新增 ${result.imported} 条，更新 ${result.updated} 条，跳过 ${result.skipped} 条`
    closePreview(); await load()
  } catch (error) { message.value = `提交失败，未写入部分数据：${error.message}` } finally { committing.value = false }
}
async function addSubject() { try { await post('/api/score-config/subjects', newSubject.value); newSubject.value = { name: '', full_score: 100, subject_group: '必考', score_type: '原始分' }; message.value = '科目已添加'; await load() } catch (error) { message.value = error.message } }
async function saveSubject(subject) { try { await put(`/api/score-config/subjects/${subject.id}`, { name: subject.name, full_score: Number(subject.full_score || 0), enabled: subject.enabled, subject_group: subject.subject_group, score_type: subject.score_type }); message.value = '科目配置已保存'; await load() } catch (error) { message.value = error.message } }
async function addExam() { try { await post('/api/score-config/exams', newExam.value); newExam.value = { name: '', exam_date: '', subject_ids: [] }; message.value = '考试已添加'; await load() } catch (error) { message.value = error.message } }
async function saveExam(exam) { try { await put(`/api/score-config/exams/${exam.id}`, { name: exam.name, exam_date: exam.exam_date, subject_ids: exam.subject_ids, enabled: exam.enabled }); message.value = '考试配置已保存'; await load() } catch (error) { message.value = error.message } }
function combinationForSubjectIds(ids) { const key = [...(ids || [])].map(Number).sort((a, b) => a - b).join(','); return combinationOptions.value.find(item => [...item.subject_ids].map(Number).sort((a, b) => a - b).join(',') === key) || null }
function toggleFilteredSelectionStudents() { const selected = new Set(selectedSelectionStudentIds.value); if (allFilteredSelectionStudentsSelected.value) filteredSelectionStudents.value.forEach(student => selected.delete(student.student_id)); else filteredSelectionStudents.value.forEach(student => selected.add(student.student_id)); selectedSelectionStudentIds.value = [...selected] }
async function applySichuanPreset() { applyingPreset.value = true; try { await post('/api/score-config/presets/sichuan-312', {}); message.value = '标准科目已准备好'; await load() } catch (error) { message.value = error.message } finally { applyingPreset.value = false } }
async function saveStudentSelection(student) { try { await put(`/api/score-config/students/${student.student_id}/subjects`, { subject_ids: selectionDraft.value[student.student_id] || [] }); message.value = `${student.姓名}的选科已保存`; await load() } catch (error) { message.value = error.message } }
async function saveStudentCombination(student, code) { const combination = combinationOptions.value.find(item => item.code === code); if (!combination) return; selectionDraft.value[student.student_id] = [...combination.subject_ids]; await saveStudentSelection(student) }
async function applyBatchCombination() { const combination = combinationOptions.value.find(item => item.code === batchCombinationCode.value); if (!combination || !selectedSelectionStudentIds.value.length) return; batchSaving.value = true; try { const result = await put('/api/score-config/student-subjects/batch', { student_ids: selectedSelectionStudentIds.value, subject_ids: combination.subject_ids }); message.value = `已为 ${result.updated_count} 名学生登记组合`; selectedSelectionStudentIds.value = []; await load() } catch (error) { message.value = error.message } finally { batchSaving.value = false } }
async function addRule() { try { const payload = { ...newRule.value, subject_id: newRule.value.metric === '单科下降' ? newRule.value.subject_id : null }; const result = await post('/api/score-rules', payload); message.value = result.evaluation?.created_count ? `规则已保存，并生成 ${result.evaluation.created_count} 条跟进工作项` : '规则已保存并完成首次检查'; await load() } catch (error) { message.value = error.message } }
async function toggleRule(rule) { try { const result = await put(`/api/score-rules/${rule.id}`, { enabled: !rule.enabled }); message.value = rule.enabled ? `规则已停用，解除 ${result.resolved_count || 0} 项提醒` : `规则已启用`; await load() } catch (error) { message.value = error.message } }
async function removeRule(rule) { if (!(await confirmDialog({ title: '删除成绩规则？', message: `将删除规则“${rule.name}”并移入回收站。`, confirmText: '移入回收站' }))) return; try { await del(`/api/records/score_rule/${rule.id}`); message.value = '成绩规则已移入回收站'; await load() } catch (error) { message.value = error.message } }
async function evaluateRules() { try { const result = await post('/api/score-rules/evaluate', {}); message.value = `检查完成：命中 ${result.hit_count}，新建 ${result.created_count}`; await load() } catch (error) { message.value = error.message } }
function hitStatusLabel(hit) { return hit.status || hit.task_status || '待处理' }
function exportExam() { if (!selectedExam.value) return; const anchor = document.createElement('a'); anchor.href = `/api/export/report/scores?exam=${encodeURIComponent(selectedExam.value.id)}`; anchor.click() }
async function selectStudent(student) { selectedStudentId.value = student.student_id; await nextTick(); detailSection.value?.focus?.() }
function closeDetail() { selectedStudentId.value = 0 }

onMounted(load)
</script>

<template>
  <div class="scores-page ds-page">
    <header class="page-title-bar ds-page-header scores-header">
      <div><div class="page-title ds-page-title">成绩跟踪</div><div class="page-subtitle ds-page-subtitle">记录值得保留的考试，快速看整体情况和学生变化</div></div>
      <div class="toolbar scores-actions">
        <input ref="fileInput" type="file" accept=".xlsx,.xlsm" hidden @change="previewFile">
        <button class="btn btn-outline ds-button" :disabled="importing" @click="pickFile"><FileUp :size="15" /> {{ importing ? '检查中…' : '导入成绩' }}</button>
        <button class="btn btn-primary ds-button" @click="openExamDialog"><TrendingUp :size="15" /> 记录考试</button>
        <button class="icon-btn scores-more" aria-label="打开更多设置" title="更多设置" @click="advancedOpen = !advancedOpen"><MoreHorizontal :size="18" /></button>
      </div>
    </header>

    <div v-if="pageError" class="inline-message error">{{ pageError }}</div>
    <div v-if="message" class="inline-message">{{ message }}</div>

    <section class="score-exam-switcher" aria-labelledby="recent-exams-title">
      <div class="section-heading"><div><h2 id="recent-exams-title">最近考试</h2><p>按日期倒序选择一次考试</p></div><button v-if="summary.exams.length > 4" class="text-button" @click="advancedOpen = true">查看全部</button></div>
      <div v-if="summary.exams.length" class="score-exam-tabs" role="tablist" aria-label="选择考试">
        <button v-for="exam in summary.exams" :key="exam.id" role="tab" :aria-selected="Number(selectedExamId) === Number(exam.id)" :class="{ active: Number(selectedExamId) === Number(exam.id) }" @click="selectedExamId = exam.id"><strong>{{ exam.name }}</strong><small>{{ exam.exam_date || '日期未填' }}</small></button>
      </div>
      <div v-else class="empty-state compact">还没有考试记录，点击“记录考试”开始。</div>
    </section>

    <template v-if="selectedExam">
      <section class="score-exam-heading">
        <div><h2>当前考试：{{ selectedExam.name }}</h2><p>{{ selectedExam.exam_date || '日期未填' }} · 满分 {{ selectedExamFullScore || '未设置' }} · {{ selectedExamMetrics.complete }} 人有完整成绩</p></div>
        <button class="btn btn-outline ds-button" @click="exportExam"><Download :size="14" /> 导出本次考试</button>
      </section>

      <section class="score-metrics" aria-label="考试概览">
        <div><span>平均分</span><strong>{{ selectedExamMetrics.average ?? '—' }}</strong><small>完整总分</small></div>
        <div><span>最高分</span><strong>{{ selectedExamMetrics.highest ?? '—' }}</strong><small>满分 {{ selectedExamFullScore || '—' }}</small></div>
        <div><span>最低分</span><strong>{{ selectedExamMetrics.lowest ?? '—' }}</strong><small>完整成绩</small></div>
        <div><span>及格率</span><strong>{{ selectedExamMetrics.passRate === null ? '—' : `${selectedExamMetrics.passRate}%` }}</strong><small>按得分率 60%</small></div>
      </section>

      <div class="score-analysis-grid">
        <section class="score-panel" aria-labelledby="distribution-title">
          <div class="section-heading"><div><h2 id="distribution-title">成绩分布</h2><p>统一按得分率统计</p></div></div>
          <div class="distribution-list">
            <div v-for="item in distribution" :key="item.label" class="distribution-row"><span>{{ item.label }}</span><div class="distribution-bar"><i :class="item.tone" :style="{ width: item.width }"></i></div><strong>{{ item.count }} 人</strong></div>
          </div>
        </section>
        <section class="score-panel" aria-labelledby="attention-title">
          <div class="section-heading"><div><h2 id="attention-title">重点关注</h2><p>低分、明显退步或临界成绩</p></div></div>
          <div v-if="!attentionStudents.length" class="score-empty"><CheckCircle :size="18" /> 当前没有明显需要关注的学生</div>
          <router-link v-for="item in attentionStudents" :key="item.student.student_id" :to="{ path: '/scores', query: { student_id: item.student.student_id } }" class="attention-row" @click="selectedStudentId = item.student.student_id"><div><strong>{{ item.student.姓名 }}</strong><span>{{ item.result.total }} / {{ selectedExamFullScore }}</span></div><span>{{ item.reason }}</span><ArrowRight :size="14" /></router-link>
        </section>
      </div>

      <section class="score-panel score-trend" aria-labelledby="trend-title">
        <div class="section-heading"><div><h2 id="trend-title">历次考试趋势</h2><p>不同满分考试统一换算为百分制得分率</p></div></div>
        <div v-if="trendData.length" class="trend-list"><div v-for="item in trendData" :key="item.id" class="trend-row"><span class="trend-label"><strong>{{ item.name }}</strong><small>{{ item.exam_date || '日期未填' }}</small></span><div class="trend-track"><i :style="{ width: `${item.rate || 0}%` }"></i></div><strong class="trend-value">{{ item.rate === null ? '—' : `${Math.round(item.rate)}%` }}</strong></div></div>
        <div v-else class="score-empty">完成一场考试后，这里会显示趋势。</div>
      </section>

      <section class="score-panel score-students" aria-labelledby="students-title">
        <div class="section-heading score-students-heading"><div><h2 id="students-title">学生成绩</h2><p>点击学生查看详情</p></div><div class="student-tools"><input v-model.trim="studentKeyword" class="form-input" placeholder="搜索姓名或学号" aria-label="搜索学生"><div class="student-filters" role="group" aria-label="筛选学生"><button :class="{ active: studentFilter === 'all' }" @click="studentFilter = 'all'">全部</button><button :class="{ active: studentFilter === 'attention' }" @click="studentFilter = 'attention'">低分</button><button :class="{ active: studentFilter === 'decline' }" @click="studentFilter = 'decline'">退步</button></div></div></div>
        <div v-if="loading" class="loading">加载中…</div>
        <div v-else-if="!studentOverviewRows.length" class="score-empty">还没有匹配的学生成绩。</div>
        <div v-else class="table-wrap score-table-wrap"><table class="data-table score-table"><thead><tr><th>姓名</th><th>分数</th><th>排名</th><th>较上次</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="student in studentOverviewRows" :key="student.student_id" :class="{ active: selectedStudent?.student_id === student.student_id }" tabindex="0" @click="selectStudent(student)" @keydown.enter.prevent="selectStudent(student)"><td><strong>{{ student.姓名 }}</strong><small class="table-sub">{{ student.学号 }}</small></td><td><strong>{{ student.latest?.total ?? '—' }}</strong><small class="table-sub">{{ selectedExam.name }}</small></td><td>{{ student.latest?.rank ?? '—' }}</td><td :class="student.latest?.total_change < 0 ? 'score-change-down' : 'score-change-up'">{{ formatChange(student.latest?.total_change, ' 分') }}</td><td><span class="score-status" :class="statusClass(student.status)">{{ student.status }}</span></td><td><button class="text-button" @click.stop="selectStudent(student)">查看</button></td></tr></tbody></table></div>
      </section>
    </template>

    <div v-else-if="!loading" class="score-empty score-page-empty"><TrendingUp :size="20" /> 记录一场考试后，这里会自动生成班级概览。</div>

    <details class="score-advanced" :open="advancedOpen" @toggle="advancedOpen = $event.target.open">
      <summary><Settings2 :size="16" /> 更多设置 <span>选科、科目、考试配置和异常规则</span></summary>
      <div class="advanced-body">
        <div class="advanced-columns">
          <section><h3>科目配置</h3><div class="config-create-row"><input v-model.trim="newSubject.name" class="form-input" placeholder="科目名称"><input v-model.number="newSubject.full_score" class="form-input" type="number" min="0" placeholder="满分"><button class="btn btn-outline" :disabled="!newSubject.name" @click="addSubject">添加</button></div><div class="config-list"><div v-for="subject in config.subjects" :key="subject.id" class="config-row"><input v-model="subject.name" class="form-input" aria-label="科目名称"><input v-model.number="subject.full_score" class="form-input" type="number" min="0" aria-label="科目满分"><label><input v-model="subject.enabled" type="checkbox"> 启用</label><button class="btn btn-sm btn-outline" @click="saveSubject(subject)">保存</button></div></div></section>
          <section><h3>考试配置</h3><div class="config-create-row"><input v-model.trim="newExam.name" class="form-input" placeholder="考试名称"><input v-model="newExam.exam_date" class="form-input" type="date" aria-label="考试日期"><button class="btn btn-outline" :disabled="!newExam.name || !newExam.subject_ids.length" @click="addExam">添加</button></div><div class="subject-checks"><label v-for="subject in config.subjects.filter(item => item.enabled)" :key="subject.id"><input v-model="newExam.subject_ids" type="checkbox" :value="subject.id"> {{ subject.name }}</label></div><div class="config-list"><details v-for="exam in config.exams" :key="exam.id"><summary>{{ exam.name }} · {{ exam.exam_date || '日期未填' }}</summary><div class="exam-edit-grid"><input v-model="exam.name" class="form-input" aria-label="考试名称"><input v-model="exam.exam_date" class="form-input" type="date" aria-label="考试日期"><button class="btn btn-sm btn-outline" @click="saveExam(exam)">保存</button></div></details></div></section>
        </div>
        <section v-if="config.sichuan_312?.ready || config.settings?.mode === '3+1+2'" class="selection-settings"><div class="advanced-section-head"><div><h3>学生选科</h3><p>仅在确实使用 3+1+2 时配置，不影响单科教师主流程。</p></div><button v-if="!config.sichuan_312?.ready" class="btn btn-outline" :disabled="applyingPreset" @click="applySichuanPreset">准备标准配置</button></div><div class="selection-toolbar"><div class="student-filters"><button :class="{ active: selectionFilter === 'all' }" @click="selectionFilter = 'all'">全部 {{ selectionCounts.all }}</button><button :class="{ active: selectionFilter === 'unset' }" @click="selectionFilter = 'unset'">未配置 {{ selectionCounts.unset }}</button><button :class="{ active: selectionFilter === 'invalid' }" @click="selectionFilter = 'invalid'">待确认 {{ selectionCounts.invalid }}</button></div><div class="batch-combination"><select v-model="batchCombinationCode" class="form-select"><option v-for="item in combinationOptions" :key="item.code" :value="item.code">{{ item.code }}</option></select><button class="btn btn-outline" :disabled="batchSaving || !selectedSelectionStudentIds.length" @click="applyBatchCombination">应用到已选 {{ selectedSelectionStudentIds.length }} 人</button></div></div><div class="table-wrap selection-table-wrap"><table class="data-table"><thead><tr><th><input type="checkbox" :checked="allFilteredSelectionStudentsSelected" @change="toggleFilteredSelectionStudents"></th><th>学生</th><th>当前组合</th><th>修改</th><th>状态</th></tr></thead><tbody><tr v-for="student in filteredSelectionStudents" :key="student.student_id"><td><input v-model="selectedSelectionStudentIds" type="checkbox" :value="student.student_id"></td><td>{{ student.姓名 }}<small class="table-sub">{{ student.学号 }}</small></td><td>{{ combinationForSubjectIds(student.selected_subject_ids)?.code || '尚未登记' }}</td><td><select class="form-select" :value="combinationForSubjectIds(student.selected_subject_ids)?.code || ''" @change="saveStudentCombination(student, $event.target.value)"><option value="">选择组合</option><option v-for="item in combinationOptions" :key="item.code" :value="item.code">{{ item.code }}</option></select></td><td>{{ student.selection_configured ? student.selection_status : '未配置' }}</td></tr></tbody></table></div></section>
        <section class="advanced-rules"><div class="advanced-section-head"><div><h3>异常提醒规则</h3><p>规则只比较同一学生最近两次可比考试。</p></div><button class="btn btn-outline" @click="evaluateRules">立即检查</button></div><div class="rule-create"><input v-model.trim="newRule.name" class="form-input" placeholder="规则名称"><select v-model="newRule.metric" class="form-select"><option>总分下降</option><option>排名下降</option><option>单科下降</option></select><input v-model.number="newRule.threshold" class="form-input" type="number" min="1" aria-label="成绩规则阈值"><button class="btn btn-outline" @click="addRule">新增规则</button></div><div v-if="!rules.length" class="score-empty">暂无异常提醒规则。</div><article v-for="rule in rules" :key="rule.id" class="rule-row"><div><strong>{{ rule.name }}</strong><span>{{ rule.metric }} ≥ {{ rule.threshold }} · {{ rule.priority }}</span></div><div class="rule-actions"><span>待处理 {{ rule.active_hit_count }}</span><button class="btn btn-sm" :class="rule.enabled ? 'btn-success' : 'btn-outline'" @click="toggleRule(rule)">{{ rule.enabled ? '已启用' : '已停用' }}</button><button class="icon-btn danger" aria-label="删除成绩规则" @click="removeRule(rule)"><Trash2 :size="14" /></button></div><router-link v-for="hit in rule.hits" :key="hit.id" class="rule-hit" :to="`/tasks?bucket=all&task=${hit.task_id}&action=edit`"><span>{{ hit.student_name }} · {{ hit.current_value }}</span><em>{{ hitStatusLabel(hit) }}</em></router-link></article><details v-if="recentRuns.length" class="rule-history"><summary><History :size="13" /> 最近执行历史</summary><div v-for="run in recentRuns" :key="run.id">{{ run.created_at }} · 命中 {{ run.hit_count }} · 新建 {{ run.created_count }}</div></details></section>
      </div>
    </details>

    <details class="score-raw" :open="rawOpen" @toggle="rawOpen = $event.target.open"><summary><Users :size="16" /> 原始成绩记录 <span>{{ selectedRecordsLabel }}</span><small>用于核验，不抢占主页面</small></summary><div v-if="!selectedRecords.length" class="score-empty">当前考试还没有成绩记录。</div><div v-else class="table-wrap raw-table-wrap"><table class="data-table"><thead><tr><th>学生</th><th v-for="subject in selectedRawSubjects" :key="subject.subject_id">{{ subject.subject }}<small class="table-sub">满分 {{ subject.full_score || '未设置' }}</small></th></tr></thead><tbody><tr v-for="student in rawStudentRows" :key="student.student_id"><td>{{ student.姓名 }}<small class="table-sub">{{ student.学号 }}</small></td><td v-for="subject in selectedRawSubjects" :key="subject.subject_id">{{ rawRecordFor(student.student_id, subject.subject)?.record_status === '正常' ? rawRecordFor(student.student_id, subject.subject)?.score : rawRecordFor(student.student_id, subject.subject)?.record_status || '—' }}</td></tr></tbody></table></div></details>

    <div v-if="selectedStudent" v-show="selectedStudentId" class="drawer-backdrop" @click.self="closeDetail">
      <aside ref="detailSection" class="score-drawer" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="student-drawer-title"><div class="drawer-head"><div><span>学生详情</span><h2 id="student-drawer-title">{{ selectedStudent.姓名 }}</h2><p>{{ selectedStudent.学号 }}</p></div><button class="icon-btn" aria-label="关闭学生详情" @click="closeDetail"><X :size="18" /></button></div><div class="drawer-summary"><div><span>当前成绩</span><strong>{{ selectedStudentLatest?.total ?? '—' }}</strong></div><div><span>较上次</span><strong :class="selectedStudentLatest?.total_change < 0 ? 'score-change-down' : 'score-change-up'">{{ formatChange(selectedStudentLatest?.total_change, ' 分') }}</strong></div><div><span>排名</span><strong>{{ selectedStudentLatest?.rank ?? '—' }}</strong></div></div><p class="drawer-note">按考试查看历史成绩，缺考和未录入不会按 0 分计算。</p><div class="table-wrap drawer-table-wrap"><table class="data-table"><thead><tr><th>考试</th><th>成绩</th><th>得分率</th></tr></thead><tbody><tr v-for="item in selectedStudent.exams" :key="item.exam_id"><td>{{ item.exam_name }}<small class="table-sub">{{ item.exam_date || '日期未填' }}</small></td><td>{{ item.total ?? (item.missing_subjects?.join('、') || '未录入') }}</td><td>{{ item.total !== null && item.total !== undefined && examFullScore(summary.exams.find(exam => exam.id === item.exam_id)) ? `${Math.round(Number(item.total) / examFullScore(summary.exams.find(exam => exam.id === item.exam_id)) * 100)}%` : '—' }}</td></tr></tbody></table></div><div class="drawer-actions"><router-link class="btn btn-outline" :to="`/student/${selectedStudent.student_id}`">打开学生档案</router-link><button class="btn btn-primary" @click="closeDetail">完成查看</button></div></aside>
    </div>

    <div v-if="examDialogOpen" class="modal-overlay" @click.self="examDialogOpen = false"><section class="exam-dialog" role="dialog" aria-modal="true" aria-labelledby="exam-dialog-title"><div class="dialog-head"><div><h2 id="exam-dialog-title">记录考试</h2><p>保存一场值得保留的考试，不需要选择考试类型。</p></div><button class="icon-btn" aria-label="关闭" @click="examDialogOpen = false"><X :size="18" /></button></div><div class="exam-form"><label>考试名称 *<input v-model.trim="examDraft.name" class="form-input" placeholder="例如：9月月考" autofocus></label><label>考试日期 *<input v-model="examDraft.exam_date" class="form-input" type="date"></label><label>满分<input v-model.number="examDraft.full_score" class="form-input" type="number" min="1"></label><label class="form-wide">备注（可选）<textarea v-model.trim="examDraft.remark" class="form-textarea" rows="3" placeholder="补充这次考试的说明"></textarea></label></div><div class="exam-suggestions"><span>常用名称</span><button v-for="name in ['月考', '期中考试', '期末考试', '单元测试']" :key="name" type="button" @click="examDraft.name = name">{{ name }}</button></div><div class="dialog-actions"><button class="btn btn-outline" @click="examDialogOpen = false">取消</button><button class="btn btn-primary" @click="saveNewExam">下一步：录入成绩</button></div></section></div>

    <div v-if="preview" class="modal-overlay" @click.self="closePreview"><section class="score-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="score-preview-title"><div class="preview-header"><div><div id="score-preview-title" class="preview-title">确认成绩导入</div><p>{{ preview.filename }} · {{ preview.format === 'long' ? '长表' : '宽表' }}</p></div><button class="icon-btn" aria-label="关闭预览" @click="closePreview"><X :size="18" /></button></div><div class="preview-controls"><label>重复记录<select v-model="duplicateStrategy" class="form-select" @change="runPreview"><option value="update">更新已有成绩</option><option value="skip">保留已有成绩</option></select></label><div class="preview-counts"><span class="ok">可提交 {{ preview.summary.valid }}</span><span>新增 {{ preview.summary.new }}</span><span>更新 {{ preview.summary.update }}</span><span>跳过 {{ preview.summary.skip }}</span><span :class="{ danger: preview.summary.error }">错误 {{ preview.summary.error }}</span></div></div><div v-if="preview.summary.new_exams || preview.summary.new_subjects" class="preview-notice">提交后将自动建立 {{ preview.summary.new_exams }} 个考试配置和 {{ preview.summary.new_subjects }} 个科目配置。</div><div class="table-wrap preview-table"><table class="data-table"><thead><tr><th>Excel 行</th><th>学生</th><th>考试</th><th>科目</th><th>分数/状态</th><th>动作</th><th>说明</th></tr></thead><tbody><tr v-for="(row, index) in previewRows" :key="`${row.row}-${row.subject}-${index}`" :class="{ 'preview-error-row': !row.valid }"><td>{{ row.row }}</td><td>{{ row.姓名 || row.学号 }}<small class="table-sub">{{ row.学号 }}</small></td><td>{{ row.exam_name }}<small class="table-sub">{{ row.exam_date }}</small></td><td>{{ row.subject }}</td><td>{{ row.record_status === '正常' ? row.score : row.record_status }}</td><td>{{ row.action }}</td><td>{{ row.error || '校验通过' }}</td></tr></tbody></table></div><div class="preview-footer"><p v-if="preview.summary.error"><AlertTriangle :size="14" /> 错误行不会提交；有效成绩会在一个事务中写入。</p><p v-else><CheckCircle :size="14" /> 全部记录校验通过，确认后一次性写入。</p><div><button class="btn btn-outline" @click="closePreview">取消</button><button class="btn btn-primary" :disabled="!commitRows.length || committing" @click="commitImport">{{ committing ? '提交中…' : `确认提交 ${commitRows.length} 条` }}</button></div></div></section></div>
  </div>
</template>

<style scoped>
.scores-page { display: grid; gap: 20px; color: var(--ds-color-ink); }
.scores-header { align-items: flex-start; margin-bottom: 0; }
.scores-actions { margin: 0; }
.scores-more { align-self: stretch; width: 38px; border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-control); background: var(--ds-color-surface); color: var(--ds-color-ink-secondary); cursor: pointer; }
.score-exam-switcher, .score-panel, .score-advanced, .score-raw { border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-card); background: var(--ds-color-surface); }
.score-exam-switcher { padding: 20px 24px 16px; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.section-heading h2 { margin: 0; font: var(--ds-type-section); letter-spacing: -.02em; }
.section-heading p { margin-top: 4px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.text-button { border: 0; background: transparent; color: var(--ds-color-primary); cursor: pointer; font: var(--ds-type-label); }
.score-exam-tabs { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; }
.score-exam-tabs button { display: grid; gap: 3px; min-width: 132px; padding: 11px 14px; border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-control); background: var(--ds-color-surface-subtle); color: var(--ds-color-ink-secondary); cursor: pointer; text-align: left; }
.score-exam-tabs button:hover { border-color: var(--ds-color-primary-border); background: var(--ds-color-primary-soft); }
.score-exam-tabs button.active { border-color: var(--ds-color-primary); background: var(--ds-color-primary-soft); color: var(--ds-color-primary-hover); }
.score-exam-tabs strong { overflow: hidden; font: var(--ds-type-title); text-overflow: ellipsis; white-space: nowrap; }
.score-exam-tabs small { font: var(--ds-type-meta); }
.score-exam-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.score-exam-heading h2 { margin: 0; font: var(--ds-type-section); }
.score-exam-heading p { margin-top: 5px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.score-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid var(--ds-color-border); border-bottom: 1px solid var(--ds-color-border); }
.score-metrics > div { display: grid; gap: 5px; min-height: 104px; padding: 17px 20px; border-right: 1px solid var(--ds-color-border); }
.score-metrics > div:last-child { border-right: 0; }
.score-metrics span, .score-metrics small { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.score-metrics strong { color: var(--ds-color-ink); font: var(--ds-type-metric); font-variant-numeric: tabular-nums; }
.score-analysis-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr); gap: 20px; }
.score-panel { padding: 20px 24px; }
.distribution-list, .trend-list { display: grid; gap: 12px; }
.distribution-row { display: grid; grid-template-columns: 70px minmax(0, 1fr) 42px; align-items: center; gap: 10px; font: var(--ds-type-meta); }
.distribution-row > strong { font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }
.distribution-bar, .trend-track { height: 9px; overflow: hidden; border-radius: var(--ds-radius-pill); background: var(--ds-color-surface-sunken); }
.distribution-bar i, .trend-track i { display: block; height: 100%; min-width: 2px; border-radius: inherit; background: var(--ds-color-primary); }
.distribution-bar i.success { background: var(--ds-color-success); }.distribution-bar i.warning { background: var(--ds-color-warning); }.distribution-bar i.danger { background: var(--ds-color-danger); }
.attention-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 10px; min-height: 52px; padding: 7px 0; border-top: 1px solid var(--ds-color-border); color: var(--ds-color-ink); text-decoration: none; }
.attention-row > div { display: grid; gap: 2px; min-width: 0; }.attention-row strong { font: var(--ds-type-title); }.attention-row div span, .attention-row > span { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.attention-row > span { color: var(--ds-color-danger); }.attention-row > svg { color: var(--ds-color-primary); }
.score-empty { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 80px; color: var(--ds-color-ink-secondary); font: var(--ds-type-body); }.score-empty svg { color: var(--ds-color-success); }
.trend-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) 50px; align-items: center; gap: 14px; }.trend-label { display: grid; gap: 2px; min-width: 0; }.trend-label strong { overflow: hidden; font: var(--ds-type-title); text-overflow: ellipsis; white-space: nowrap; }.trend-label small { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.trend-track i { background: var(--ds-color-primary); }.trend-value { color: var(--ds-color-primary-hover); font: var(--ds-type-label); text-align: right; }
.score-students { padding-bottom: 10px; }.score-students-heading { align-items: flex-end; }.student-tools { display: flex; align-items: center; gap: 10px; }.student-tools .form-input { width: 190px; }.student-filters { display: inline-flex; gap: 2px; padding: 3px; border-radius: var(--ds-radius-control); background: var(--ds-color-surface-subtle); }.student-filters button { border: 0; border-radius: var(--ds-radius-sm); padding: 6px 10px; background: transparent; color: var(--ds-color-ink-secondary); cursor: pointer; font: var(--ds-type-label); }.student-filters button.active { background: var(--ds-color-surface); color: var(--ds-color-primary); box-shadow: var(--ds-shadow-raised); }
.score-table-wrap { overflow-x: auto; }.score-table { min-width: 700px; }.score-table tbody tr { cursor: pointer; }.score-table tbody tr:hover, .score-table tbody tr.active { background: var(--ds-color-primary-soft); }.score-table td { height: 56px; }.score-table td:first-child { display: grid; align-content: center; gap: 2px; }.score-change-down { color: var(--ds-color-danger); }.score-change-up { color: var(--ds-color-success); }.score-status { display: inline-flex; padding: 4px 8px; border-radius: var(--ds-radius-pill); font: var(--ds-type-meta); }.status-attention { background: var(--ds-color-danger-soft); color: var(--ds-color-danger); }.status-incomplete { background: var(--ds-color-warning-soft); color: var(--ds-color-warning); }.status-stable { background: var(--ds-color-success-soft); color: var(--ds-color-success); }.status-unset { background: var(--ds-color-surface-subtle); color: var(--ds-color-ink-secondary); }
.score-page-empty { border: 1px dashed var(--ds-color-border-strong); border-radius: var(--ds-radius-card); }.score-advanced, .score-raw { padding: 0; overflow: hidden; }.score-advanced > summary, .score-raw > summary { display: flex; align-items: center; gap: 8px; padding: 17px 20px; cursor: pointer; list-style: none; font: var(--ds-type-title); }.score-advanced > summary::-webkit-details-marker, .score-raw > summary::-webkit-details-marker { display: none; }.score-advanced > summary::after, .score-raw > summary::after { margin-left: auto; color: var(--ds-color-primary); content: '展开'; font: var(--ds-type-label); }.score-advanced[open] > summary::after, .score-raw[open] > summary::after { content: '收起'; }.score-advanced summary span, .score-raw summary span { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.score-raw summary small { margin-left: auto; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.advanced-body { display: grid; gap: 22px; padding: 0 20px 22px; border-top: 1px solid var(--ds-color-border); }.advanced-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding-top: 20px; }.advanced-body h3 { margin: 0 0 10px; font-size: 14px; }.config-create-row, .exam-edit-grid { display: grid; grid-template-columns: minmax(0, 1fr) 110px auto; gap: 8px; }.config-list { display: grid; gap: 8px; margin-top: 12px; }.config-row { display: grid; grid-template-columns: minmax(0, 1fr) 90px auto auto; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid var(--ds-color-border); }.config-row label { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); white-space: nowrap; }.subject-checks { display: flex; flex-wrap: wrap; gap: 8px 14px; margin: 10px 0; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.config-list details { padding: 8px 0; border-top: 1px solid var(--ds-color-border); }.config-list summary { cursor: pointer; font: var(--ds-type-label); }.selection-settings, .advanced-rules { padding-top: 18px; border-top: 1px solid var(--ds-color-border); }.advanced-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }.advanced-section-head p { margin-top: 4px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.selection-toolbar { display: flex; justify-content: space-between; gap: 12px; margin: 14px 0; }.batch-combination { display: flex; gap: 8px; }.selection-table-wrap { max-height: 340px; overflow: auto; }.rule-create { display: grid; grid-template-columns: minmax(0, 1fr) 130px 90px auto; gap: 8px; margin: 14px 0; }.rule-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px 18px; padding: 14px 0; border-top: 1px solid var(--ds-color-border); }.rule-row > div:first-child { display: grid; gap: 3px; }.rule-row > div span, .rule-actions { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.rule-actions { display: flex; align-items: center; gap: 8px; }.rule-hit { grid-column: 1 / -1; display: flex; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: var(--ds-radius-sm); background: var(--ds-color-surface-subtle); color: var(--ds-color-ink); font: var(--ds-type-meta); text-decoration: none; }.rule-hit em { color: var(--ds-color-primary); font-style: normal; }.rule-history { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--ds-color-border); color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.raw-table-wrap { max-height: 400px; overflow: auto; margin: 0 20px 20px; }
.drawer-backdrop { position: fixed; z-index: 300; inset: 0; display: flex; justify-content: flex-end; background: rgba(32,36,47,.22); }.score-drawer { width: min(470px, 100vw); height: 100%; overflow: auto; padding: 26px; background: var(--ds-color-surface); box-shadow: var(--ds-shadow-overlay); }.drawer-head { display: flex; justify-content: space-between; gap: 16px; }.drawer-head span { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.drawer-head h2 { margin-top: 5px; font: var(--ds-type-page); font-size: 26px; }.drawer-head p { margin-top: 3px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.drawer-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 24px 0 14px; }.drawer-summary > div { display: grid; gap: 4px; padding: 12px; border-radius: var(--ds-radius-control); background: var(--ds-color-surface-subtle); }.drawer-summary span, .drawer-note { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.drawer-summary strong { font-size: 20px; }.drawer-note { margin-bottom: 14px; }.drawer-table-wrap { overflow-x: auto; }.drawer-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.exam-dialog { width: min(520px, calc(100vw - 32px)); padding: 24px; border-radius: var(--ds-radius-dialog); background: var(--ds-color-surface); box-shadow: var(--ds-shadow-overlay); }.dialog-head, .preview-header { display: flex; justify-content: space-between; gap: 16px; }.dialog-head h2 { margin: 0; font: var(--ds-type-section); }.dialog-head p { margin-top: 5px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.exam-form { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 22px; }.exam-form label { display: grid; gap: 6px; color: var(--ds-color-ink-secondary); font: var(--ds-type-label); }.exam-form .form-wide { grid-column: 1 / -1; }.exam-suggestions { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 15px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.exam-suggestions button { border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-pill); padding: 5px 9px; background: var(--ds-color-surface); color: var(--ds-color-ink-secondary); cursor: pointer; font: inherit; }.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }.score-preview-dialog { width: min(1080px, calc(100vw - 36px)); max-height: min(86vh, 800px); display: flex; flex-direction: column; padding: 22px; border-radius: var(--ds-radius-dialog); background: var(--ds-color-surface); box-shadow: var(--ds-shadow-overlay); }.preview-title { font-size: 19px; font-weight: 700; }.preview-header p { margin-top: 4px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.preview-controls { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin: 16px 0 10px; }.preview-controls label { display: grid; gap: 5px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.preview-counts { display: flex; flex-wrap: wrap; gap: 7px; }.preview-counts span { padding: 4px 7px; border-radius: var(--ds-radius-sm); background: var(--ds-color-surface-subtle); font: var(--ds-type-meta); }.preview-counts .ok { color: var(--ds-color-success); }.preview-counts .danger { color: var(--ds-color-danger); }.preview-notice { margin-bottom: 9px; padding: 9px 11px; border-radius: var(--ds-radius-sm); background: var(--ds-color-primary-soft); color: var(--ds-color-primary-hover); font: var(--ds-type-meta); }.preview-table { min-height: 180px; overflow: auto; }.preview-error-row { background: var(--ds-color-danger-soft); }.preview-footer { display: flex; justify-content: space-between; align-items: center; gap: 14px; margin-top: 14px; }.preview-footer p { display: flex; align-items: center; gap: 5px; margin: 0; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }.preview-footer > div { display: flex; gap: 8px; }
@media (max-width: 900px) { .score-analysis-grid, .advanced-columns { grid-template-columns: 1fr; }.score-metrics { grid-template-columns: repeat(2, 1fr); }.score-metrics > div:nth-child(2) { border-right: 0; }.score-metrics > div:nth-child(-n+2) { border-bottom: 1px solid var(--ds-color-border); }.student-tools { align-items: stretch; flex-direction: column; width: 100%; }.student-tools .form-input { width: 100%; }.score-students-heading, .score-exam-heading { align-items: stretch; flex-direction: column; } }
@media (max-width: 640px) { .scores-page { gap: 16px; }.scores-header { display: grid; gap: 14px; }.scores-actions { width: 100%; }.scores-actions .btn { flex: 1; justify-content: center; }.scores-more { flex: 0 0 38px !important; }.score-exam-switcher, .score-panel { padding: 16px; }.score-metrics > div { min-height: 92px; padding: 14px 12px; }.score-metrics strong { font-size: 22px; }.distribution-row { grid-template-columns: 62px minmax(0, 1fr) 36px; gap: 7px; }.trend-row { grid-template-columns: 100px minmax(0, 1fr) 42px; gap: 8px; }.advanced-body { padding: 0 16px 18px; }.config-create-row, .exam-edit-grid, .config-row, .rule-create { grid-template-columns: 1fr 1fr; }.config-create-row button, .rule-create button { grid-column: 1 / -1; }.config-row button { grid-column: 2; }.selection-toolbar, .batch-combination { align-items: stretch; flex-direction: column; }.raw-table-wrap { margin: 0 16px 16px; }.score-drawer { padding: 20px 16px; }.exam-form { grid-template-columns: 1fr; }.exam-form .form-wide { grid-column: auto; }.preview-controls, .preview-footer { align-items: stretch; flex-direction: column; }.preview-footer > div { display: grid; grid-template-columns: 1fr 1fr; }.score-preview-dialog { width: calc(100vw - 20px); max-height: 91vh; padding: 16px; } }
</style>
