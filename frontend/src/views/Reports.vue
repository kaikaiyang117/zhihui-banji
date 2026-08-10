<script setup>
import { computed, onMounted, ref } from 'vue'
import { Archive, ChevronDown, Download, FileText, LockKeyhole, RefreshCw, Save, Sparkles } from 'lucide-vue-next'
import { get, post, download } from '../api'

const reportType = 'term'
const preview = ref(null)
const archives = ref([])
const selectedArchive = ref(null)
const loading = ref(false)
const error = ref('')
const classSummary = ref('')
const teacherSummary = ref('')
const nextTermPlan = ref('')
const aiBusy = ref(false)
const aiDraft = ref(null)
const aiInstruction = ref('')

const sections = computed(() => preview.value?.sections || {})
const analysis = computed(() => preview.value?.analysis || {})
const academic = computed(() => analysis.value.academic || {})
const attendance = computed(() => analysis.value.attendance || {})
const tasks = computed(() => analysis.value.tasks || {})
const classOverview = computed(() => analysis.value.class_overview || {})
const metrics = computed(() => preview.value?.metrics || {})
const termLabel = computed(() => preview.value?.scope?.term_name || '当前学期')
const classLabel = computed(() => preview.value?.scope?.class_name || '当前班级')
const sourceTotal = computed(() => Object.values(preview.value?.source_refs || {}).reduce((total, rows) => total + rows.length, 0))
const attendanceItems = computed(() => Object.entries(attendance.value.status_counts || {}).filter(([, value]) => Number(value) > 0))
const taskItems = computed(() => Object.entries(tasks.value.status_counts || {}))
const commentStudentCount = computed(() => new Set((sections.value.comments || []).map(item => item.student_id).filter(Boolean)).size)
const focusStudents = computed(() => {
  const byStudent = new Map()
  const add = (row, field) => {
    const key = row.student_id || row.student_name
    const name = row.student_name || row.姓名
    if (!key || !name) return
    const current = byStudent.get(key) || { id: row.student_id, name, attendance: 0, events: 0, communications: 0 }
    current[field] += 1
    byStudent.set(key, current)
  }
  for (const row of sections.value.attendance || []) {
    if (row.status !== '出勤') add(row, 'attendance')
  }
  for (const row of sections.value.events || []) add(row, 'events')
  for (const row of sections.value.communications || []) add(row, 'communications')
  return [...byStudent.values()]
    .filter(item => item.attendance || item.events || item.communications)
    .sort((a, b) => (b.attendance + b.events + b.communications) - (a.attendance + a.events + a.communications))
    .slice(0, 8)
})

function loadManualFields(payload) {
  classSummary.value = payload?.manual?.class_summary || ''
  teacherSummary.value = payload?.manual?.teacher_summary || ''
  nextTermPlan.value = payload?.manual?.next_term_plan || ''
}

async function load() {
  const archiveData = await get('/api/reports/archives')
  archives.value = archiveData.archives || []
}

async function generate() {
  loading.value = true
  error.value = ''
  selectedArchive.value = null
  try {
    preview.value = await post('/api/reports/preview', {
      report_type: reportType,
      period_start: '',
      period_end: '',
      student_id: null,
    })
    loadManualFields(preview.value)
    aiDraft.value = null
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function generateAIDraft() {
  if (!preview.value) return
  aiBusy.value = true
  error.value = ''
  try {
    aiDraft.value = await post('/api/reports/ai/preview', { instruction: aiInstruction.value })
  } catch (e) {
    error.value = `AI生成失败：${e.message}`
  } finally {
    aiBusy.value = false
  }
}

function applyAIDraft() {
  if (!aiDraft.value?.draft) return
  classSummary.value = aiDraft.value.draft.class_summary || ''
  nextTermPlan.value = aiDraft.value.draft.next_term_plan || ''
  teacherSummary.value = aiDraft.value.draft.teacher_summary || ''
  aiDraft.value = null
}

async function archive() {
  if (!preview.value) return
  loading.value = true
  error.value = ''
  try {
    selectedArchive.value = await post('/api/reports/archives', {
      report_type: reportType,
      period_start: preview.value.period_start,
      period_end: preview.value.period_end,
      student_id: null,
      class_summary: classSummary.value,
      teacher_summary: teacherSummary.value,
      next_term_plan: nextTermPlan.value,
    })
    await load()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function openArchive(id) {
  selectedArchive.value = await get(`/api/reports/archives/${id}`)
  preview.value = selectedArchive.value.payload
  loadManualFields(preview.value)
}

function printReport() {
  if (preview.value) window.print()
}

onMounted(load)
</script>

<template>
  <div class="reports-page">
    <div class="page-title-bar">
      <div>
        <div class="page-title">学期总结与档案</div>
        <p class="page-subtitle">把一学期的班级工作整理成一份可复盘、可交接的教师档案</p>
      </div>
      <button class="btn btn-outline" @click="load"><RefreshCw :size="14" /> 刷新</button>
    </div>

    <section class="card report-generator">
      <div class="generator-copy">
        <div class="eyebrow"><FileText :size="15" /> 学期档案</div>
        <h2>生成本学期总结</h2>
        <p>系统整理结构化事实，老师补充班风判断、下学期计划和总结寄语，最后保存为只读档案。</p>
      </div>
      <div class="generator-meta">
        <div><span>统计范围</span><strong>当前班级 · 当前学期</strong></div>
        <div><span>档案属性</span><strong>数据快照 + 教师总结</strong></div>
      </div>
      <div v-if="error" class="form-error">{{ error }}</div>
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading" @click="generate">{{ loading ? '整理中…' : '生成学期总结' }}</button>
        <button v-if="preview && !selectedArchive" class="btn btn-ai" :disabled="aiBusy || loading" @click="generateAIDraft"><Sparkles :size="14" /> {{ aiBusy ? 'AI整理中…' : 'AI生成三段草稿' }}</button>
        <button class="btn btn-outline" :disabled="!preview || loading" @click="archive"><Save :size="14" /> 保存为只读档案</button>
        <button v-if="preview" class="text-action" @click="printReport">打印 / 保存 PDF</button>
      </div>
    </section>

    <section v-if="preview" class="card report-document">
      <header class="document-header">
        <div>
          <div class="eyebrow"><Archive :size="15" /> 学期档案预览</div>
          <h2>{{ classLabel }} · {{ termLabel }}</h2>
          <p>{{ preview.period_start }} 至 {{ preview.period_end }} · 生成于当前数据快照</p>
        </div>
        <span class="snapshot-badge">{{ selectedArchive ? '只读档案' : '生成预览' }}</span>
      </header>

      <div v-if="aiDraft" class="ai-draft-panel">
        <div class="ai-draft-heading"><div><div class="eyebrow"><Sparkles :size="15" /> AI辅助草稿</div><p>以下内容来自当前学期事实，应用前请老师检查并修改。</p></div><span class="ai-model">{{ aiDraft.model || '已配置模型' }}</span></div>
        <label class="ai-instruction"><span>补充要求 <em>可选</em></span><input v-model="aiInstruction" placeholder="例如：更突出班级凝聚力，语气更适合期末班会"></label>
        <div class="ai-draft-grid"><label><span>班级整体表现</span><textarea v-model="aiDraft.draft.class_summary" rows="4"></textarea></label><label><span>下学期计划</span><textarea v-model="aiDraft.draft.next_term_plan" rows="4"></textarea></label><label><span>班主任总结</span><textarea v-model="aiDraft.draft.teacher_summary" rows="4"></textarea></label></div>
        <div v-if="aiDraft.warnings?.length" class="ai-warning">{{ aiDraft.warnings.join('；') }}</div>
        <div class="ai-draft-actions"><button class="btn btn-outline" @click="aiDraft = null">放弃草稿</button><button class="btn btn-primary" @click="applyAIDraft">应用到档案</button></div>
      </div>

      <section class="document-section">
        <div class="section-title"><span class="section-number">01</span><div><h3>班级整体表现</h3><p>先看班级整体，再补充班主任对班风、学风和集体表现的判断。</p></div></div>
        <div class="fact-grid">
          <div><span>在读学生</span><strong>{{ classOverview.student_count || metrics.student_count || 0 }} 人</strong></div>
          <div><span>班会与活动</span><strong>{{ (classOverview.meetings || 0) + (classOverview.activities || 0) }} 次</strong></div>
          <div><span>班级任务</span><strong>{{ tasks.total || metrics.work_items_total || 0 }} 项</strong></div>
          <div><span>学生跟进记录</span><strong>{{ (classOverview.events || 0) + (classOverview.communications || 0) }} 条</strong></div>
        </div>
        <label class="long-field"><span>班级整体表现 <em>可人工修改</em></span><textarea v-model="classSummary" rows="4" placeholder="请补充班风、学风变化，班级目标完成情况，班级荣誉或重要事务，以及值得肯定的集体行为。"></textarea></label>
      </section>

      <section class="document-section">
        <div class="section-title"><span class="section-number">02</span><div><h3>学业与选科分析</h3><p>用考试变化和选科数据说明班级学业情况，不只展示成绩记录数量。</p></div></div>
        <div v-if="academic.exams?.length" class="exam-list">
          <div class="exam-row exam-header"><span>考试</span><span>班级完整人数</span><span>班级平均总分</span><span>缺失记录</span></div>
          <div v-for="exam in academic.exams" :key="`${exam.name}-${exam.date}`" class="exam-row"><strong>{{ exam.name }}</strong><span>{{ exam.complete_count }}/{{ exam.student_count }}</span><span>{{ exam.class_average_total ?? '—' }}</span><span>{{ exam.missing_count || '—' }}</span></div>
        </div>
        <div v-else class="empty-inline">当前学期还没有可用于比较的考试数据。</div>
        <div class="academic-columns">
          <div class="subsection-card"><h4>选科组合</h4><div v-if="academic.selection_combinations?.length" class="tag-list"><span v-for="item in academic.selection_combinations" :key="item.name">{{ item.name }} · {{ item.student_count }} 人</span></div><p v-else class="muted">暂未登记学生选科组合。</p></div>
          <div class="subsection-card"><h4>最新考试科目表现</h4><div v-if="academic.latest_subjects?.length" class="subject-list"><div v-for="item in academic.latest_subjects" :key="item.subject"><span>{{ item.subject }}</span><strong>{{ item.average ?? '—' }}</strong><small>{{ item.recorded_count }}/{{ item.eligible_count }} 人有成绩</small></div></div><p v-else class="muted">暂无科目统计。</p></div>
        </div>
        <div class="private-analysis" v-if="academic.improved_students?.length || academic.declined_students?.length">
          <div class="private-heading"><LockKeyhole :size="14" /> 仅班主任可见：学业变化学生</div>
          <div class="student-change-columns">
            <div><h4>进步明显</h4><p v-for="item in academic.improved_students" :key="`up-${item.student_id}`">{{ item.student_name }} <strong>+{{ item.change }}</strong></p><span v-if="!academic.improved_students?.length" class="muted">暂无足够考试数据</span></div>
            <div><h4>需要帮助</h4><p v-for="item in academic.declined_students" :key="`down-${item.student_id}`">{{ item.student_name }} <strong>{{ item.change }}</strong></p><span v-if="!academic.declined_students?.length" class="muted">暂无持续下降数据</span></div>
          </div>
        </div>
      </section>

      <section class="document-section">
        <div class="section-title"><span class="section-number">03</span><div><h3>出勤与班级运行</h3><p>展示班级整体趋势，个别学生问题只留在班主任内部区域。</p></div></div>
        <div class="run-grid">
          <div class="run-card"><span>考勤记录</span><strong>{{ attendance.total_records || metrics.attendance_total || 0 }}</strong><small>异常 {{ attendance.exception_records || 0 }} 次 · 涉及 {{ attendance.exception_student_count || 0 }} 人</small></div>
          <div class="run-card"><span>任务完成</span><strong>{{ tasks.completed || 0 }}/{{ tasks.total || metrics.work_items_total || 0 }}</strong><small>待处理 {{ tasks.open || 0 }} 项</small></div>
          <div class="run-card"><span>教育记录</span><strong>{{ (classOverview.meetings || 0) + (classOverview.activities || 0) }}</strong><small>班会与活动</small></div>
        </div>
        <div class="breakdown-list running-breakdown"><div v-for="([status, count]) in attendanceItems" :key="status" class="breakdown-row"><span>考勤 · {{ status }}</span><strong>{{ count }}</strong></div><div v-for="([status, count]) in taskItems" :key="status" class="breakdown-row"><span>任务 · {{ status }}</span><strong>{{ count }}</strong></div></div>
        <details v-if="focusStudents.length" class="private-analysis followup-details"><summary><span><LockKeyhole :size="14" /> 仅班主任可见：下学期关注清单</span><span>{{ focusStudents.length }} 人 <ChevronDown :size="15" /></span></summary><div class="focus-table"><div class="focus-table-row focus-table-header"><span>学生</span><span>异常考勤</span><span>学生事件</span><span>家校沟通</span></div><div v-for="item in focusStudents" :key="item.id || item.name" class="focus-table-row"><strong>{{ item.name }}</strong><span>{{ item.attendance || '—' }}</span><span>{{ item.events || '—' }}</span><span>{{ item.communications || '—' }}</span></div></div></details>
      </section>

      <section class="document-section">
        <div class="section-title"><span class="section-number">04</span><div><h3>下学期计划</h3><p>把本学期发现的问题转成具体的班级目标和支持措施。</p></div></div>
        <label class="long-field"><span>下学期工作计划 <em>可人工修改</em></span><textarea v-model="nextTermPlan" rows="5" placeholder="可填写班级整体目标、学习习惯改进目标、各科提升重点、重要考试节点、班级管理调整和重点学生支持措施。"></textarea></label>
      </section>

      <section class="document-section last-section">
        <div class="section-title"><span class="section-number">05</span><div><h3>班主任总结</h3><p>记录这学期最满意的地方、遗憾的问题、对班级的判断和对学生的期待。</p></div></div>
        <label class="long-field"><span>班主任寄语与总结 <em>可人工修改</em></span><textarea v-model="teacherSummary" rows="5" placeholder="请写下准备在学期末班会上说的话，也可以先由 AI 生成草稿，再由老师修改确认。"></textarea></label>
      </section>

      <details class="report-sources"><summary><span>查看原始数据与来源</span><span>{{ sourceTotal }} 条记录 <ChevronDown :size="15" /></span></summary><p class="source-hint">用于核对和追溯，不影响档案正文阅读。</p><div v-for="(rows, kind) in preview.source_refs" :key="kind" class="source-group" v-show="rows.length"><strong>{{ kind }}</strong><span v-for="item in rows.slice(0, 8)" :key="`${kind}-${item.id}`">#{{ item.id }} {{ item.date || item.title || '' }}</span><em v-if="rows.length > 8">还有 {{ rows.length - 8 }} 条</em></div></details>
      <ul class="report-notes"><li v-for="note in preview.data_notes" :key="note">{{ note }}</li></ul>
    </section>

    <section class="card report-archives"><div class="section-heading archive-heading"><div><h2>历史学期档案</h2><span>只读快照 · {{ archives.length }} 份</span></div><span class="muted">点击档案名称查看</span></div><div v-if="!archives.length" class="empty-state">生成并保存学期总结后，会在这里保留可回看的快照。</div><div v-else class="archive-list"><div v-for="item in archives" :key="item.id" class="archive-row"><button class="link-button" @click="openArchive(item.id)">{{ item.title }}</button><span>{{ item.period_start }} 至 {{ item.period_end }}</span><span>{{ item.archived_at }}</span><button class="btn btn-sm btn-outline" @click="download(`/api/reports/archives/${item.id}/export`, `${item.title}.xlsx`)"><Download :size="13" /> 导出</button></div></div></section>
  </div>
</template>

<style scoped>
.page-subtitle { margin:4px 0 0; color:var(--text-secondary); font-size:13px; }.report-generator { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(260px,1fr); gap:20px 32px; align-items:center; }.generator-copy h2,.document-header h2,.archive-heading h2 { margin:7px 0 5px; font-size:20px; letter-spacing:-.01em; }.generator-copy p { max-width:660px; margin:0; color:var(--text-secondary); line-height:1.65; }.eyebrow { display:flex; align-items:center; gap:7px; color:var(--primary); font-size:13px; font-weight:600; }.generator-meta { display:grid; gap:10px; padding:14px 16px; border-radius:14px; background:var(--bg-elevated); }.generator-meta div { display:flex; justify-content:space-between; gap:16px; font-size:13px; }.generator-meta span { color:var(--text-secondary); }.generator-meta strong { font-weight:600; text-align:right; }.toolbar { grid-column:1 / -1; display:flex; align-items:center; gap:12px; padding-top:4px; border-top:1px solid var(--border); }.btn-ai { color:#a34778; background:#fff2f8; border-color:#f1c8db; }.btn-ai:hover { background:#ffe7f1; }.text-action { border:0; background:none; color:var(--primary); cursor:pointer; padding:8px 2px; }.form-error { grid-column:1 / -1; color:var(--danger); margin:0; }
.document-header,.section-heading,.document-section,.section-title { display:flex; }.document-header,.section-heading { justify-content:space-between; gap:16px; }.document-header p { margin:0; color:var(--text-secondary); font-size:13px; }.snapshot-badge { padding:5px 9px; border-radius:8px; background:var(--primary-soft,#eef1ff); color:var(--primary); font-size:12px; white-space:nowrap; }.document-section { flex-direction:column; gap:16px; margin-top:28px; padding-top:24px; border-top:1px solid var(--border); }.document-section.last-section { padding-bottom:4px; }.section-title { align-items:flex-start; gap:12px; }.section-title h3 { margin:0 0 5px; font-size:18px; }.section-title p { margin:0; color:var(--text-secondary); font-size:13px; }.section-number { display:inline-flex; align-items:center; justify-content:center; width:34px; height:26px; border-radius:8px; background:var(--primary-soft,#eef1ff); color:var(--primary); font-size:12px; font-weight:700; }
.ai-draft-panel { margin-top:22px; padding:18px; border:1px solid #edc6db; border-radius:16px; background:linear-gradient(135deg,#fff8fb,#f8f7ff); }.ai-draft-heading { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }.ai-draft-heading p { margin:5px 0 0; color:var(--text-secondary); font-size:12px; }.ai-model { color:var(--text-secondary); font-size:11px; }.ai-instruction,.ai-draft-grid label { display:flex; flex-direction:column; gap:7px; }.ai-instruction { margin-top:14px; }.ai-instruction span,.ai-draft-grid label > span { color:var(--text); font-size:12px; font-weight:600; }.ai-instruction em { margin-left:5px; color:var(--text-secondary); font-style:normal; font-weight:400; }.ai-instruction input,.ai-draft-grid textarea { box-sizing:border-box; width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:var(--surface); color:var(--text); font:inherit; }.ai-draft-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:12px; }.ai-draft-grid textarea { resize:vertical; line-height:1.55; }.ai-warning { margin-top:10px; color:#9a5a12; font-size:12px; }.ai-draft-actions { display:flex; justify-content:flex-end; gap:10px; margin-top:14px; }
.fact-grid,.run-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; width:100%; }.fact-grid > div,.run-card { min-height:82px; padding:14px; border-radius:14px; background:var(--bg-elevated); }.fact-grid span,.run-card span { display:block; color:var(--text-secondary); font-size:12px; }.fact-grid strong,.run-card strong { display:block; margin-top:8px; font-size:20px; }.long-field { display:flex; flex-direction:column; gap:8px; width:100%; }.long-field > span { color:var(--text); font-size:13px; font-weight:600; }.long-field em { margin-left:6px; color:var(--text-secondary); font-size:12px; font-style:normal; font-weight:400; }.long-field textarea { width:100%; box-sizing:border-box; resize:vertical; min-height:100px; padding:12px 14px; border:1px solid var(--border); border-radius:12px; background:var(--surface); color:var(--text); font:inherit; line-height:1.6; }.long-field textarea:focus { outline:2px solid color-mix(in srgb, var(--primary) 28%, transparent); border-color:var(--primary); }
.exam-list,.focus-table { width:100%; border:1px solid var(--border); border-radius:12px; overflow:hidden; }.exam-row,.focus-table-row { display:grid; grid-template-columns:minmax(180px,1.5fr) repeat(3,1fr); gap:12px; align-items:center; padding:11px 14px; border-top:1px solid var(--border); font-size:13px; }.exam-row:first-child,.focus-table-row:first-child { border-top:0; }.exam-row span,.focus-table-row span { color:var(--text-secondary); }.exam-header,.focus-table-header { border-top:0; background:var(--bg-elevated); color:var(--text-secondary); font-size:12px; }.academic-columns { display:grid; grid-template-columns:1fr 1fr; gap:14px; width:100%; }.subsection-card { padding:16px; border-radius:14px; background:var(--bg-elevated); }.subsection-card h4,.student-change-columns h4 { margin:0 0 12px; font-size:14px; }.tag-list { display:flex; flex-wrap:wrap; gap:8px; }.tag-list span { padding:6px 9px; border-radius:8px; background:var(--surface); color:var(--text-secondary); font-size:12px; }.subject-list { display:grid; gap:8px; }.subject-list > div { display:grid; grid-template-columns:1fr auto auto; gap:10px; align-items:center; font-size:13px; }.subject-list strong { font-size:16px; }.subject-list small { color:var(--text-secondary); }.muted,.empty-inline { color:var(--text-secondary); font-size:13px; }
.private-analysis { width:100%; padding:15px 16px; border:1px solid color-mix(in srgb, var(--primary) 20%, var(--border)); border-radius:14px; background:color-mix(in srgb, var(--primary) 4%, var(--surface)); }.private-heading { display:flex; align-items:center; gap:7px; color:var(--primary); font-size:13px; font-weight:600; }.student-change-columns { display:grid; grid-template-columns:1fr 1fr; gap:22px; margin-top:14px; }.student-change-columns p { display:flex; justify-content:space-between; margin:7px 0; color:var(--text-secondary); font-size:13px; }.student-change-columns strong { color:var(--text); }.run-grid { grid-template-columns:repeat(3,1fr); }.run-card small { display:block; margin-top:7px; color:var(--text-secondary); font-size:12px; }.running-breakdown { width:100%; }.breakdown-row { display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border); font-size:13px; }.breakdown-row:last-child { border-bottom:0; }.breakdown-row span { color:var(--text-secondary); }.followup-details summary { display:flex; justify-content:space-between; align-items:center; cursor:pointer; list-style:none; color:var(--primary); font-size:13px; }.followup-details summary::-webkit-details-marker { display:none; }.followup-details summary > span { display:flex; align-items:center; gap:6px; }.followup-details .focus-table { margin-top:14px; background:var(--surface); }
.report-sources { margin-top:28px; padding-top:16px; border-top:1px solid var(--border); }.report-sources summary { display:flex; justify-content:space-between; align-items:center; cursor:pointer; color:var(--primary); font-size:13px; list-style:none; }.report-sources summary::-webkit-details-marker { display:none; }.report-sources summary > span:last-child { display:flex; align-items:center; gap:5px; color:var(--text-secondary); }.source-hint { margin:10px 0 0; color:var(--text-secondary); font-size:12px; }.source-group { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; align-items:center; }.source-group strong { min-width:74px; font-size:12px; }.source-group span { background:var(--bg-elevated); padding:4px 7px; border-radius:7px; font-size:12px; }.source-group em { color:var(--text-secondary); font-size:12px; }.report-notes { color:var(--text-secondary); font-size:12px; padding-left:18px; margin-bottom:0; }.archive-heading { align-items:center; }.archive-heading h2 { margin:0 0 4px; }.archive-heading > span { white-space:nowrap; }.archive-list { display:flex; flex-direction:column; gap:0; margin-top:14px; }.archive-row { display:grid; grid-template-columns:minmax(180px,1fr) 180px 170px auto; gap:10px; align-items:center; border-top:1px solid var(--border); padding:12px 0; font-size:13px; }.link-button { border:0; background:none; color:var(--primary); text-align:left; cursor:pointer; font-size:14px; }
@media (max-width:1000px) { .fact-grid { grid-template-columns:repeat(2,1fr); }.academic-columns,.ai-draft-grid { grid-template-columns:1fr; } } @media (max-width:700px) { .report-generator { grid-template-columns:1fr; }.toolbar { grid-column:auto; flex-wrap:wrap; }.fact-grid,.run-grid { grid-template-columns:repeat(2,1fr); }.exam-row,.focus-table-row { grid-template-columns:1.3fr repeat(3,.7fr); gap:6px; padding-left:10px; padding-right:10px; }.student-change-columns { grid-template-columns:1fr; gap:10px; }.archive-row { grid-template-columns:1fr 1fr; }.archive-row .btn { justify-self:start; } }
@media print { @page report-page { size:A4 portrait; margin:14mm; } :global(html),:global(body),:global(.app) { min-height:0 !important; height:auto !important; background:#fff !important; } :global(.top-tabs),:global(.sidebar),:global(.agent-float),.report-generator,.report-archives { display:none !important; } :global(.app-body),:global(.main) { display:block !important; width:auto !important; max-width:none !important; min-height:0 !important; height:auto !important; overflow:visible !important; margin:0 !important; padding:0 !important; }.report-document { page:report-page; border:0 !important; box-shadow:none !important; margin:0 !important; }.report-sources { break-inside:avoid; } }
</style>
