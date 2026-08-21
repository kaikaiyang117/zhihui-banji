<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as echarts from 'echarts'
import { ArrowDown, ArrowUp, CalendarDays, Download, History, Plus, Star, X } from 'lucide-vue-next'
import { get, post, scopedUrl } from '../api'

const summary = ref({
  academic_year: '', academic_years: [], students: [], totals: {}, monthly: [], categories: [],
})
const entries = ref([])
const students = ref([])
const loading = ref(true)
const message = ref('')
const showEntry = ref(false)
const revokeTarget = ref(null)
const chartEl = ref(null)
const businessDate = ref(localDate())
const academicYear = ref(academicYearFor(businessDate.value))
const runtimeLoaded = ref(false)
const filters = ref({ date_from: '', date_to: '', status: '', student_id: '' })
const entryForm = ref({ student_id: '', amount: '', occurred_at: businessDate.value, category: '日常行为', reason: '' })
const revokeReason = ref('')
let chart = null

function localDate() {
  const now = new Date(); const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function academicYearFor(value) {
  const date = new Date(`${value}T00:00:00`)
  const startYear = date.getMonth() >= 8 ? date.getFullYear() : date.getFullYear() - 1
  return `${startYear}-${startYear + 1}`
}

function amountText(value) {
  const amount = Number(value || 0)
  return `${amount > 0 ? '+' : ''}${amount}`
}

function formatAcademicYear(value) { return `${value.replace('-', '–')} 学年` }

function yearStart(value) { return `${value.split('-')[0]}-09-01` }

const academicYearOptions = computed(() => {
  const years = new Set(summary.value.academic_years || [])
  if (academicYear.value) years.add(academicYear.value)
  return [...years].sort().reverse()
})
const totalValid = computed(() => Number(summary.value.totals?.total || 0))
const positiveTotal = computed(() => Number(summary.value.totals?.positive || 0))
const negativeTotal = computed(() => Math.abs(Number(summary.value.totals?.negative || 0)))
const leader = computed(() => summary.value.students?.[0])
const chartSummary = computed(() => leader.value
  ? `${formatAcademicYear(academicYear.value)}积分最高的是${leader.value.name}，共 ${leader.value.total} 分。`
  : `${formatAcademicYear(academicYear.value)}暂无积分趋势数据。`)
const exportUrl = computed(() => scopedUrl(`/api/export/sheet/日常行为积分?academic_year=${encodeURIComponent(academicYear.value)}`))

function queryString() {
  const params = new URLSearchParams({ academic_year: academicYear.value })
  Object.entries(filters.value).forEach(([key, value]) => { if (value) params.set(key, value) })
  return params.toString()
}

async function load() {
  loading.value = true
  try {
    const runtime = await get('/api/system/runtime')
    if (!runtimeLoaded.value && runtime.business_date) {
      businessDate.value = runtime.business_date
      academicYear.value = academicYearFor(businessDate.value)
      entryForm.value.occurred_at = businessDate.value
      runtimeLoaded.value = true
    }
    const [data, studentData] = await Promise.all([
      get(`/api/points?${queryString()}`), get('/api/students'),
    ])
    summary.value = data.summary || { academic_year: academicYear.value, academic_years: [], students: [], totals: {}, monthly: [], categories: [] }
    entries.value = data.entries || []
    students.value = studentData.students || []
    await new Promise(resolve => setTimeout(resolve, 50))
    renderChart()
  } catch (error) { message.value = `加载失败：${error.message}` } finally { loading.value = false }
}

function resetEntry() {
  entryForm.value = { student_id: '', amount: '', occurred_at: businessDate.value, category: '日常行为', reason: '' }
}

function openEntry() {
  message.value = ''
  resetEntry()
  if (academicYear.value !== academicYearFor(businessDate.value)) {
    entryForm.value.occurred_at = yearStart(academicYear.value)
    message.value = '当前查看的是历史学年，请确认发生日期后再保存'
  }
  showEntry.value = true
}

async function createEntry() {
  const amount = Number(entryForm.value.amount)
  if (!entryForm.value.student_id || !entryForm.value.occurred_at || !Number.isFinite(amount) || amount === 0 || !entryForm.value.reason.trim()) {
    message.value = '请填写学生、发生日期、非零分值和行为依据'
    return
  }
  try {
    await post('/api/points/entries', { ...entryForm.value, student_id: Number(entryForm.value.student_id), amount })
    message.value = '积分流水已记录'; showEntry.value = false; academicYear.value = academicYearFor(entryForm.value.occurred_at); resetEntry(); await load()
  } catch (error) { message.value = `记录失败：${error.message}` }
}

async function revokeEntry() {
  if (!revokeTarget.value || !revokeReason.value.trim()) {
    message.value = '请填写撤销原因'
    return
  }
  try {
    await post(`/api/points/entries/${revokeTarget.value.id}/revoke`, { reason: revokeReason.value })
    message.value = '积分已撤销，原流水仍保留'; revokeTarget.value = null; revokeReason.value = ''; await load()
  } catch (error) { message.value = `撤销失败：${error.message}` }
}

function renderChart() {
  if (!chartEl.value || !summary.value.monthly?.length) return
  if (chart) chart.dispose()
  chart = echarts.init(chartEl.value)
  const top5 = summary.value.students.slice(0, 5)
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: top5.map(item => item.name), bottom: 0 },
    grid: { left: '3%', right: '4%', bottom: '15%', containLabel: true },
    xAxis: { type: 'category', data: summary.value.monthly.map(item => item.label) },
    yAxis: { type: 'value' },
    series: top5.map(item => ({ name: item.name, type: 'line', data: item.monthly })),
  })
}

function applyFilters() { load() }
function applyAcademicYear() { filters.value.date_from = ''; filters.value.date_to = ''; showEntry.value = false; load() }

onMounted(() => { load(); window.addEventListener('resize', resizeChart) })
function resizeChart() { if (chart) chart.resize() }
onBeforeUnmount(() => { window.removeEventListener('resize', resizeChart); if (chart) chart.dispose() })
</script>

<template>
  <div>
    <div class="page-title-bar points-title-bar">
      <div>
        <div class="page-title">行为积分</div>
        <div class="page-subtitle">记录学生行为，并按学年汇总有效积分</div>
      </div>
      <div class="toolbar points-toolbar">
        <label class="points-year-picker"><CalendarDays :size="14" />
          <span>统计学年</span>
          <select class="form-select" v-model="academicYear" @change="applyAcademicYear" aria-label="统计学年">
            <option v-for="year in academicYearOptions" :key="year" :value="year">{{ formatAcademicYear(year) }}</option>
          </select>
        </label>
        <button class="btn btn-primary" @click="openEntry"><Plus :size="14" /> 记录积分</button>
        <a class="btn btn-outline btn-export" :href="exportUrl"><Download :size="14" /> 导出流水</a>
      </div>
    </div>
    <div class="hint points-scope-note">统计范围：{{ formatAcademicYear(academicYear) }}（{{ summary.academic_year_start || '9月1日' }} 至 {{ summary.academic_year_end || '次年8月31日' }}）</div>
    <div v-if="message" class="inline-message">{{ message }}</div>

    <div class="overview-cards points-overview">
      <div class="overview-card"><div class="oc-icon orange"><Star :size="20" /></div><div><div class="oc-label">学年有效积分</div><div class="oc-value">{{ totalValid }}</div></div></div>
      <div class="overview-card"><div class="oc-icon green"><ArrowUp :size="20" /></div><div><div class="oc-label">加分总计</div><div class="oc-value">{{ positiveTotal }}</div></div></div>
      <div class="overview-card"><div class="oc-icon red"><ArrowDown :size="20" /></div><div><div class="oc-label">扣分总计</div><div class="oc-value">{{ negativeTotal }}</div></div></div>
      <div class="overview-card"><div class="oc-icon blue"><History :size="20" /></div><div><div class="oc-label">有效流水</div><div class="oc-value">{{ summary.totals?.valid_entries || 0 }}</div></div></div>
    </div>

    <div v-if="showEntry" class="card points-form-card">
      <div class="card-title">记录积分</div>
      <div class="form-grid">
        <label>学生<select class="form-select" v-model="entryForm.student_id" required><option value="">选择学生</option><option v-for="student in students" :key="student.id" :value="student.id">{{ student.姓名 }} · {{ student.学号 }}</option></select></label>
        <label>发生日期<input class="form-input" type="date" v-model="entryForm.occurred_at" required></label>
        <label>分值<input class="form-input" type="number" step="0.5" v-model="entryForm.amount" placeholder="正数加分，负数扣分" required></label>
        <label>分类<input class="form-input" v-model="entryForm.category" placeholder="如：课堂表现" required></label>
        <label class="form-grid-wide">行为依据<textarea class="form-textarea" v-model="entryForm.reason" rows="2" placeholder="说明本次加扣分依据" required></textarea></label>
      </div>
      <div class="modal-actions"><button class="btn btn-outline" @click="showEntry = false">取消</button><button class="btn btn-primary" @click="createEntry">保存流水</button></div>
    </div>

    <div class="card">
      <div class="card-title">学年积分排行 <span class="count">{{ summary.students.length }} 人</span></div>
      <p class="chart-text-summary">{{ chartSummary }}</p>
      <div class="points-dashboard-grid">
        <ul v-if="summary.students.length" class="rank-list"><li v-for="(student, index) in summary.students.slice(0, 10)" :key="student.student_id" class="rank-item"><div class="rank-num" :class="['gold','silver','bronze','normal'][index] || 'normal'">{{ index + 1 }}</div><div class="rank-name">{{ student.name }}<small>{{ student.学号 }} · {{ student.entry_count }} 条</small></div><div class="rank-points">{{ student.total }} 分</div></li></ul><div v-else class="empty-state">该学年暂无积分数据</div>
        <div ref="chartEl" class="chart-box" style="height:300px" role="img" :aria-label="chartSummary"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">行为分类统计 <span class="count">{{ summary.categories?.length || 0 }} 类</span></div>
      <div v-if="summary.categories?.length" class="points-category-list"><div v-for="item in summary.categories" :key="item.category" class="points-category-row"><div><strong>{{ item.category }}</strong><small>加分 {{ item.positive }} · 扣分 {{ Math.abs(item.negative) }}</small></div><strong :class="item.total >= 0 ? 'positive' : 'negative'">{{ amountText(item.total) }}</strong></div></div><div v-else class="empty-state">该学年暂无分类数据</div>
    </div>

    <div class="card">
      <div class="card-title">学年流水明细 <span class="count">{{ entries.length }} 条</span></div>
      <div class="points-filters"><label>学生<select class="form-select" v-model="filters.student_id" @change="applyFilters"><option value="">全部学生</option><option v-for="student in students" :key="student.id" :value="student.id">{{ student.姓名 }}</option></select></label><label>开始日期<input class="form-input" type="date" v-model="filters.date_from" @change="applyFilters"></label><label>结束日期<input class="form-input" type="date" v-model="filters.date_to" @change="applyFilters"></label><label>状态<select class="form-select" v-model="filters.status" @change="applyFilters"><option value="">全部</option><option value="有效">有效</option><option value="已撤销">已撤销</option></select></label></div>
      <div v-if="loading" class="loading">加载中…</div><div v-else-if="!entries.length" class="empty-state">该学年暂无积分流水</div>
      <div v-else class="points-ledger-list"><div v-for="entry in entries" :key="entry.id" class="points-ledger-row" :class="{ revoked: entry.status === '已撤销' }"><div class="points-ledger-main"><strong>{{ entry.student_name }} · {{ entry.学号 }}</strong><span>{{ entry.occurred_at || '未填写日期' }} · {{ entry.category }} · {{ entry.reason }}</span><small>{{ entry.term_name || '当前学期' }}<template v-if="entry.reversal_reason"> · 撤销原因：{{ entry.reversal_reason }}</template></small></div><strong class="points-amount" :class="entry.amount >= 0 ? 'positive' : 'negative'">{{ amountText(entry.amount) }}</strong><div class="record-actions"><span class="tag" :class="entry.status === '有效' ? 'tag-green' : 'tag-gray'">{{ entry.status }}</span><button v-if="entry.status === '有效' && entry.can_revoke !== false" class="btn btn-sm btn-outline" @click="revokeTarget = entry"><X :size="13" /> 撤销</button><span v-else-if="entry.status === '有效'" class="tag tag-gray">历史学期</span></div></div></div>
    </div>

    <div v-if="revokeTarget" class="modal-overlay show" tabindex="-1" @keydown.esc="revokeTarget = null" @click.self="revokeTarget = null"><div class="modal"><div class="modal-kicker">撤销积分流水</div><h3>{{ revokeTarget.student_name }} · {{ amountText(revokeTarget.amount) }}</h3><p class="hint">撤销不会删除原记录，{{ formatAcademicYear(academicYear) }}统计会立即重算。</p><textarea class="form-textarea" v-model="revokeReason" rows="3" placeholder="请输入撤销原因"></textarea><div class="modal-actions"><button class="btn btn-outline" @click="revokeTarget = null">取消</button><button class="btn btn-primary" @click="revokeEntry">确认撤销</button></div></div></div>
  </div>
</template>
