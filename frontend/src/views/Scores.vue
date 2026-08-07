<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  AlertTriangle, CheckCircle, ChevronDown, Download, FileUp, History,
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
const newSubject = ref({ name: '', full_score: 100 })
const newExam = ref({ name: '', exam_date: '', subject_ids: [] })
const newRule = ref({ name: '总分明显下降', metric: '总分下降', subject_id: null, threshold: 20, priority: '重要' })

const selectedExam = computed(() => summary.value.exams.find(item => Number(item.id) === Number(selectedExamId.value)) || null)
const selectedStudentRows = computed(() => summary.value.students.map(student => ({
  ...student,
  result: student.exams.find(item => Number(item.exam_id) === Number(selectedExamId.value))
})).filter(item => item.result?.has_any))
const selectedRecords = computed(() => summary.value.records.filter(item => Number(item.exam_id) === Number(selectedExamId.value)))
const previewRows = computed(() => preview.value?.rows || [])
const commitRows = computed(() => previewRows.value.filter(item => item.valid && item.action !== '跳过'))
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
    rules.value = ruleData.rules || []
    recentRuns.value = ruleData.recent_runs || []
    if (!selectedExamId.value || !data.exams.some(item => Number(item.id) === Number(selectedExamId.value))) {
      selectedExamId.value = data.exams.at(-1)?.id || 0
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
    newSubject.value = { name: '', full_score: 100 }
    message.value = '科目已添加'
    await load()
  } catch (error) { message.value = error.message }
}

async function saveSubject(subject) {
  try {
    await put(`/api/score-config/subjects/${subject.id}`, {
      name: subject.name, full_score: Number(subject.full_score || 0), enabled: subject.enabled
    })
    message.value = '科目配置已保存'
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
      <div class="score-config-grid">
        <div>
          <h3>科目</h3>
          <div class="config-create-row">
            <input v-model.trim="newSubject.name" class="form-input" placeholder="科目名称">
            <input v-model.number="newSubject.full_score" class="form-input" type="number" min="0" placeholder="满分">
            <button class="btn btn-primary" :disabled="!newSubject.name" @click="addSubject">添加</button>
          </div>
          <div class="config-list">
            <div v-for="subject in config.subjects" :key="subject.id" class="config-row">
              <input v-model="subject.name" class="form-input" aria-label="科目名称">
              <input v-model.number="subject.full_score" class="form-input" type="number" min="0" aria-label="科目满分">
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
            <thead><tr><th>科目</th><th>满分</th><th>平均分</th><th>有效成绩</th><th>缺考</th><th>未录入/免考</th></tr></thead>
            <tbody><tr v-for="item in selectedExam.subject_stats" :key="item.subject_id"><td><strong>{{ item.subject }}</strong></td><td>{{ item.full_score || '未设置' }}</td><td>{{ item.average ?? '—' }}</td><td>{{ item.recorded_count }}</td><td>{{ item.absent_count }}</td><td>{{ item.missing_count }}</td></tr></tbody>
          </table>
        </div>
      </section>
    </template>

    <section class="card">
      <div class="card-title"><TrendingUp :size="16" /> 学生成绩趋势</div>
      <p class="chart-text-summary">{{ trendSummary }}</p>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!summary.students.length || !summary.exams.length" class="empty-state">还没有结构化成绩。先配置科目与考试，再导入 Excel；导入不会跳过预览直接写库。</div>
      <div v-else class="table-wrap">
        <table class="data-table score-trend-table">
          <thead><tr><th>学生</th><th v-for="exam in summary.exams" :key="exam.id">{{ exam.name }}<small class="table-sub">总分 / 排名</small></th><th>最近变化</th></tr></thead>
          <tbody><tr v-for="student in summary.students" :key="student.student_id"><td><router-link :to="`/student/${student.student_id}`" class="table-link">{{ student.姓名 }}</router-link><small class="table-sub">{{ student.学号 }}</small></td><td v-for="exam in summary.exams" :key="exam.id"><template v-if="studentExam(student, exam.id)?.has_any"><strong>{{ studentExam(student, exam.id)?.total ?? '不完整' }}</strong><small class="table-sub">{{ studentExam(student, exam.id)?.rank ? `第 ${studentExam(student, exam.id).rank} 名 · ${studentExam(student, exam.id).stratum}` : studentExam(student, exam.id)?.missing_subjects.join('、') }}</small></template><span v-else>—</span></td><td>{{ formatChange(student.exams.at(-1)?.total_change, ' 分') }}<small class="table-sub">排名 {{ formatChange(student.exams.at(-1)?.rank_change) }}</small></td></tr></tbody>
        </table>
      </div>
    </section>

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

    <section v-if="selectedExam" class="card">
      <div class="card-title"><Users :size="16" /> {{ selectedExam.name }}学生明细 <span class="count">{{ selectedStudentRows.length }} 人</span></div>
      <div class="table-wrap">
        <table class="data-table"><thead><tr><th>学生</th><th v-for="subject in selectedExam.subject_stats" :key="subject.subject_id">{{ subject.subject }}</th><th>总分</th><th>排名</th><th>分层</th></tr></thead><tbody><tr v-for="student in selectedStudentRows" :key="student.student_id"><td><router-link :to="`/student/${student.student_id}`" class="table-link">{{ student.姓名 }}</router-link></td><td v-for="subject in selectedExam.subject_stats" :key="subject.subject_id"><template v-if="student.result.subjects[subject.subject]?.status === '正常'">{{ student.result.subjects[subject.subject].score }}</template><span v-else class="score-missing">{{ student.result.subjects[subject.subject]?.status || '未录入' }}</span></td><td><strong>{{ student.result.total ?? '—' }}</strong></td><td>{{ student.result.rank ?? '—' }}</td><td>{{ student.result.stratum }}</td></tr></tbody></table>
      </div>
    </section>

    <section class="card">
      <div class="card-title"><Users :size="16" /> 成绩记录 <span class="count">{{ selectedRecords.length }} 条</span></div>
      <div v-if="!selectedRecords.length" class="empty-state compact">当前考试还没有成绩记录</div>
      <div v-else class="table-wrap" style="max-height:420px"><table class="data-table"><thead><tr><th>学生</th><th>科目</th><th>分数/状态</th><th>备注</th><th>操作</th></tr></thead><tbody><tr v-for="row in selectedRecords" :key="row.id"><td>{{ row.姓名 }}<small class="table-sub">{{ row.学号 }}</small></td><td>{{ row.subject }}</td><td><strong>{{ row.record_status === '正常' ? row.score : row.record_status }}</strong></td><td>{{ row.note || '—' }}</td><td><button class="icon-btn danger" aria-label="删除成绩" @click="removeScore(row)"><Trash2 :size="14" /></button></td></tr></tbody></table></div>
    </section>

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
.config-create-row { display: grid; grid-template-columns: 1fr 105px auto; gap: 8px; }
.config-create-row.exam-create { grid-template-columns: 1fr 145px; }
.config-list { display: grid; gap: 7px; margin-top: 10px; }
.config-row { display: grid; grid-template-columns: 1fr 85px auto auto; align-items: center; gap: 7px; }
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
  .score-rule-create { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 680px) {
  .scores-actions { width: 100%; display: grid; grid-template-columns: 1fr 1fr; }
  .config-create-row, .config-create-row.exam-create, .config-row, .exam-edit-grid { grid-template-columns: 1fr 1fr; }
  .config-row label { align-self: center; }
  .score-rule-create { grid-template-columns: 1fr 1fr; }
  .score-rule-item { grid-template-columns: 1fr; }
  .rule-actions { flex-wrap: wrap; }
  .score-rule-hit { flex-direction: column; }
  .score-preview-dialog { width: calc(100vw - 20px); max-height: 91vh; padding: 16px; }
  .preview-controls, .preview-footer { align-items: stretch; flex-direction: column; }
  .preview-footer > div { display: grid; grid-template-columns: 1fr 1fr; }
}
</style>
