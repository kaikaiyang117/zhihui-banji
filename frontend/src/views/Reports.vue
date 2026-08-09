<script setup>
import { computed, onMounted, ref } from 'vue'
import { Download, FileText, RefreshCw, Save } from 'lucide-vue-next'
import { get, post, download } from '../api'

const today = new Date()
const iso = value => value.toISOString().slice(0, 10)
const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`
const periodStart = ref(monthStart)
const periodEnd = ref(iso(new Date(today.getFullYear(), today.getMonth() + 1, 0)))
const reportType = ref('weekly')
const studentId = ref('')
const students = ref([])
const preview = ref(null)
const archives = ref([])
const selectedArchive = ref(null)
const loading = ref(false)
const error = ref('')

const typeLabel = computed(() => ({ weekly: '班级周报', monthly: '班级月报', term: '学期档案', student_growth: '学生成长报告' })[reportType.value])
const metrics = computed(() => Object.entries(preview.value?.metrics || {}))

function updatePeriodByType() {
  const now = new Date()
  if (reportType.value === 'weekly') {
    const monday = new Date(now)
    monday.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1))
    periodStart.value = iso(monday)
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6)
    periodEnd.value = iso(sunday)
  } else if (reportType.value === 'monthly') {
    periodStart.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    periodEnd.value = iso(new Date(now.getFullYear(), now.getMonth() + 1, 0))
  }
}

async function load() {
  const [studentData, archiveData] = await Promise.all([get('/api/students'), get('/api/reports/archives')])
  students.value = studentData.students || []
  archives.value = archiveData.archives || []
}

async function generate() {
  loading.value = true; error.value = ''; selectedArchive.value = null
  try {
    preview.value = await post('/api/reports/preview', {
      report_type: reportType.value,
      period_start: periodStart.value,
      period_end: periodEnd.value,
      student_id: studentId.value ? Number(studentId.value) : null,
    })
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

async function archive() {
  if (!preview.value) return
  loading.value = true; error.value = ''
  try {
    await post('/api/reports/archives', {
      report_type: reportType.value,
      period_start: periodStart.value,
      period_end: periodEnd.value,
      student_id: studentId.value ? Number(studentId.value) : null,
    })
    await load()
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

async function openArchive(id) {
  selectedArchive.value = await get(`/api/reports/archives/${id}`)
  preview.value = selectedArchive.value.payload
}

function printReport() {
  if (preview.value) window.print()
}

onMounted(async () => { updatePeriodByType(); await load() })
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div class="page-title">报告与学期档案</div>
      <button class="btn btn-outline" @click="load"><RefreshCw :size="14" /> 刷新</button>
    </div>

    <div class="card report-generator">
      <div class="card-title"><FileText :size="18" /> 生成报告</div>
      <div class="form-grid">
        <label>报告类型
          <select v-model="reportType" @change="updatePeriodByType">
            <option value="weekly">班级周报</option><option value="monthly">班级月报</option>
            <option value="term">学期档案</option><option value="student_growth">学生成长报告</option>
          </select>
        </label>
        <label v-if="reportType === 'student_growth'">学生
          <select v-model="studentId"><option value="">请选择学生</option><option v-for="s in students" :key="s.id" :value="s.id">{{ s.学号 }} · {{ s.姓名 }}</option></select>
        </label>
        <label>开始日期<input v-model="periodStart" type="date"></label>
        <label>结束日期<input v-model="periodEnd" type="date"></label>
      </div>
      <div v-if="error" class="form-error">{{ error }}</div>
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading || (reportType === 'student_growth' && !studentId)" @click="generate">{{ loading ? '生成中…' : '生成预览' }}</button>
        <button class="btn btn-outline" :disabled="!preview || loading" @click="archive"><Save :size="14" /> 保存为只读归档</button>
        <button class="btn btn-outline" :disabled="!preview" @click="printReport">打印 / 保存 PDF</button>
      </div>
    </div>

    <div v-if="preview" class="card report-preview">
      <div class="card-title">{{ preview.report_label }} <span class="count">{{ preview.period_start }} 至 {{ preview.period_end }}</span></div>
      <p class="muted">{{ preview.student ? `${preview.student.学号} · ${preview.student.姓名}` : '当前班级全部在读学生' }}。统计沿用业务模块口径，来源可在下方追溯。</p>
      <div class="report-metrics">
        <div v-for="([key, value]) in metrics" :key="key" class="metric-card"><span>{{ key }}</span><strong>{{ typeof value === 'object' ? JSON.stringify(value) : value }}</strong></div>
      </div>
      <details open class="report-sources">
        <summary>来源追溯（{{ Object.values(preview.source_refs || {}).reduce((n, rows) => n + rows.length, 0) }} 条）</summary>
        <div v-for="(rows, kind) in preview.source_refs" :key="kind" class="source-group" v-show="rows.length">
          <strong>{{ kind }}</strong><span v-for="item in rows.slice(0, 8)" :key="`${kind}-${item.id}`">#{{ item.id }} {{ item.date || item.title || '' }}</span>
          <em v-if="rows.length > 8">还有 {{ rows.length - 8 }} 条</em>
        </div>
      </details>
      <ul class="report-notes"><li v-for="note in preview.data_notes" :key="note">{{ note }}</li></ul>
    </div>

    <div class="card report-archives">
      <div class="card-title">只读归档 <span class="count">{{ archives.length }} 份</span></div>
      <div v-if="!archives.length" class="empty-state">生成并保存报告后，会在这里保留可回看的快照。</div>
      <div v-else class="archive-list">
        <div v-for="item in archives" :key="item.id" class="archive-row">
          <button class="link-button" @click="openArchive(item.id)">{{ item.title }}</button>
          <span>{{ item.period_start }} 至 {{ item.period_end }}</span><span>{{ item.archived_at }}</span>
          <button class="btn btn-sm btn-outline" @click="download(`/api/reports/archives/${item.id}/export`, `${item.title}.xlsx`)"><Download :size="13" /> 导出</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.form-grid { display:grid; grid-template-columns:repeat(4,minmax(140px,1fr)); gap:12px; }
.form-grid label { display:flex; flex-direction:column; gap:6px; color:var(--text-secondary); font-size:13px; }
.form-grid input,.form-grid select { padding:9px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--text); }
.report-metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(145px,1fr)); gap:10px; margin:16px 0; }
.metric-card { padding:12px; border:1px solid var(--border); border-radius:10px; background:var(--bg-elevated); display:flex; flex-direction:column; gap:4px; }
.metric-card span { color:var(--text-secondary); font-size:12px; }.metric-card strong { font-size:18px; }
.report-sources { border-top:1px solid var(--border); padding-top:12px; }.source-group { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; align-items:center; }.source-group span { background:var(--bg-elevated); padding:4px 7px; border-radius:6px; font-size:12px; }.source-group em { color:var(--text-secondary); font-size:12px; }.report-notes { color:var(--text-secondary); font-size:12px; padding-left:18px; }
.archive-list { display:flex; flex-direction:column; gap:8px; }.archive-row { display:grid; grid-template-columns:minmax(180px,1fr) 180px 170px auto; gap:10px; align-items:center; border-bottom:1px solid var(--border); padding:10px 0; font-size:13px; }.link-button { border:0; background:none; color:var(--primary); text-align:left; cursor:pointer; font-size:14px; }.muted { color:var(--text-secondary); }.form-error { color:var(--danger); margin:10px 0; }
@media (max-width:700px) { .form-grid { grid-template-columns:1fr 1fr; }.archive-row { grid-template-columns:1fr 1fr; } }
@media print {
  @page report-page { size: A4 portrait; margin: 14mm; }
  :global(html), :global(body), :global(.app) { min-height:0 !important; height:auto !important; background:#fff !important; }
  :global(.top-tabs), :global(.sidebar), :global(.agent-float), .report-generator, .report-archives { display:none !important; }
  :global(.app-body), :global(.main) { display:block !important; width:auto !important; max-width:none !important; min-height:0 !important; height:auto !important; overflow:visible !important; margin:0 !important; padding:0 !important; }
  .report-preview { page: report-page; border:0 !important; box-shadow:none !important; margin:0 !important; }
  .report-preview :deep(.report-sources) { break-inside:avoid; }
}
</style>
