<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as echarts from 'echarts'
import { AlertTriangle, Download, History, Plus, RotateCcw, Star, X } from 'lucide-vue-next'
import { get, post } from '../api'

const summary = ref({ students: [], rules: [], hits: [], migration: null })
const entries = ref([])
const students = ref([])
const loading = ref(true)
const message = ref('')
const showEntry = ref(false)
const showRule = ref(false)
const revokeTarget = ref(null)
const chartEl = ref(null)
const filters = ref({ date_from: '', date_to: '', status: '', student_id: '' })
const entryForm = ref({ student_id: '', amount: '', occurred_at: localDate(), category: '日常行为', reason: '', rule_id: null })
const ruleForm = ref({ name: '', category: '日常行为', metric: '周期扣分', threshold: 5, period_days: 7, priority: '重要' })
const revokeReason = ref('')
let chart = null

function localDate() {
  const now = new Date(); const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
function amountText(value) { const amount = Number(value || 0); return `${amount > 0 ? '+' : ''}${amount}` }
const leader = computed(() => summary.value.students?.[0])
const totalValid = computed(() => summary.value.students?.reduce((total, item) => total + Number(item.total || 0), 0) || 0)
const activeHits = computed(() => summary.value.hits || [])
const chartSummary = computed(() => leader.value
  ? `当前积分最高的是${leader.value.name}，累计 ${leader.value.total} 分。`
  : '暂无积分趋势数据。')

function queryString() {
  const params = new URLSearchParams()
  Object.entries(filters.value).forEach(([key, value]) => { if (value) params.set(key, value) })
  return params.toString()
}

async function load() {
  loading.value = true
  try {
    const [data, studentData] = await Promise.all([
      get(`/api/points${queryString() ? `?${queryString()}` : ''}`), get('/api/students'),
    ])
    summary.value = data.summary || { students: [], rules: [], hits: [], migration: null }
    entries.value = data.entries || []
    students.value = studentData.students || []
    await new Promise(resolve => setTimeout(resolve, 50))
    renderChart()
  } catch (error) { message.value = `加载失败：${error.message}` } finally { loading.value = false }
}

function resetEntry() { entryForm.value = { student_id: '', amount: '', occurred_at: localDate(), category: '日常行为', reason: '', rule_id: null } }
async function createEntry() {
  if (!entryForm.value.student_id || !entryForm.value.amount || !entryForm.value.reason.trim()) return
  try {
    await post('/api/points/entries', { ...entryForm.value, student_id: Number(entryForm.value.student_id), amount: Number(entryForm.value.amount) })
    message.value = '积分流水已记录'; showEntry.value = false; resetEntry(); await load()
  } catch (error) { message.value = `记录失败：${error.message}` }
}

async function revokeEntry() {
  if (!revokeTarget.value || !revokeReason.value.trim()) return
  try {
    await post(`/api/points/entries/${revokeTarget.value.id}/revoke`, { reason: revokeReason.value })
    message.value = '积分已撤销，原流水仍保留'; revokeTarget.value = null; revokeReason.value = ''; await load()
  } catch (error) { message.value = `撤销失败：${error.message}` }
}

async function createRule() {
  if (!ruleForm.value.name.trim()) return
  try {
    await post('/api/points/rules', ruleForm.value)
    message.value = '积分异常规则已保存'; ruleForm.value = { name: '', category: '日常行为', metric: '周期扣分', threshold: 5, period_days: 7, priority: '重要' }; await load()
  } catch (error) { message.value = `规则保存失败：${error.message}` }
}
async function evaluateRules() {
  try {
    const result = await post('/api/points/rules/evaluate', {})
    message.value = `规则检查完成：新增 ${result.created_count} 项，解除 ${result.resolved_count} 项`; await load()
  } catch (error) { message.value = `规则检查失败：${error.message}` }
}

function renderChart() {
  if (!chartEl.value || !summary.value.students?.length) return
  if (chart) chart.dispose()
  chart = echarts.init(chartEl.value)
  const top5 = summary.value.students.slice(0, 5)
  chart.setOption({
    tooltip: { trigger: 'axis' }, legend: { data: top5.map(item => item.name), bottom: 0 },
    grid: { left: '3%', right: '4%', bottom: '15%', containLabel: true },
    xAxis: { type: 'category', data: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'] },
    yAxis: { type: 'value' }, series: top5.map(item => ({ name: item.name, type: 'line', data: item.weekly })),
  })
}
function applyFilters() { load() }

onMounted(() => { load(); window.addEventListener('resize', resizeChart) })
function resizeChart() { if (chart) chart.resize() }
onBeforeUnmount(() => { window.removeEventListener('resize', resizeChart); if (chart) chart.dispose() })
</script>

<template>
  <div>
    <div class="page-title-bar"><div><div class="page-title">行为积分</div><div class="page-subtitle">用稳定学生 ID 记录每一次加扣分，所有总分都由有效流水重算</div></div><div class="toolbar" style="margin-bottom:0"><button class="btn btn-outline" @click="showRule = !showRule">异常规则</button><button class="btn btn-primary" @click="showEntry = true"><Plus :size="14" /> 记录积分</button><a class="btn btn-outline btn-export" href="/api/export/sheet/日常行为积分"><Download :size="14" /> 导出流水</a></div></div>
    <div v-if="message" class="inline-message">{{ message }}</div>

    <div class="overview-cards points-overview"><div class="overview-card"><div class="oc-icon orange"><Star :size="20" /></div><div><div class="oc-label">有效积分合计</div><div class="oc-value">{{ totalValid }}</div></div></div><div class="overview-card"><div class="oc-icon blue"><History :size="20" /></div><div><div class="oc-label">有效流水</div><div class="oc-value">{{ summary.students.reduce((total, item) => total + item.entry_count, 0) }}</div></div></div><div class="overview-card"><div class="oc-icon red"><AlertTriangle :size="20" /></div><div><div class="oc-label">待处理异常</div><div class="oc-value">{{ activeHits.length }}</div></div></div></div>

    <div v-if="showEntry" class="card points-form-card"><div class="card-title">记录积分</div><div class="form-grid"><label>学生<select class="form-select" v-model="entryForm.student_id"><option value="">选择学生</option><option v-for="student in students" :key="student.id" :value="student.id">{{ student.姓名 }} · {{ student.学号 }}</option></select></label><label>发生日期<input class="form-input" type="date" v-model="entryForm.occurred_at"></label><label>分值<input class="form-input" type="number" step="0.5" v-model="entryForm.amount" placeholder="正数加分，负数扣分"></label><label>分类<input class="form-input" v-model="entryForm.category" placeholder="如：课堂表现"></label><label class="form-grid-wide">原因<textarea class="form-textarea" v-model="entryForm.reason" rows="2" placeholder="说明本次加扣分依据"></textarea></label></div><div class="modal-actions"><button class="btn btn-outline" @click="showEntry = false">取消</button><button class="btn btn-primary" @click="createEntry">保存流水</button></div></div>

    <div v-if="showRule" class="card points-form-card"><div class="card-title">积分异常阈值</div><div class="form-grid"><label>规则名称<input class="form-input" v-model="ruleForm.name" placeholder="如：一周扣分达到 5 分"></label><label>指标<select class="form-select" v-model="ruleForm.metric"><option value="周期扣分">周期扣分</option><option value="周期总分低于">周期总分低于</option></select></label><label>阈值<input class="form-input" type="number" min="0.1" step="0.5" v-model.number="ruleForm.threshold"></label><label>周期天数<input class="form-input" type="number" min="1" max="365" v-model.number="ruleForm.period_days"></label></div><div class="modal-actions"><button class="btn btn-outline" @click="evaluateRules"><RotateCcw :size="14" /> 立即检查</button><button class="btn btn-primary" @click="createRule">保存规则</button></div><div v-if="summary.rules.length" class="rule-list"><div v-for="rule in summary.rules" :key="rule.id" class="rule-list-row"><span>{{ rule.name }} · {{ rule.metric }} {{ rule.threshold }} / {{ rule.period_days }}天</span><span class="tag" :class="rule.enabled ? 'tag-green' : 'tag-gray'">{{ rule.enabled ? '启用' : '停用' }}</span></div></div></div>

    <div class="card"><div class="card-title">积分排行榜 <span class="count">{{ summary.students.length }} 人</span></div><p class="chart-text-summary">{{ chartSummary }}</p><div class="points-dashboard-grid"><ul v-if="summary.students.length" class="rank-list"><li v-for="(student, index) in summary.students.slice(0, 10)" :key="student.student_id" class="rank-item"><div class="rank-num" :class="['gold','silver','bronze','normal'][index] || 'normal'">{{ index + 1 }}</div><div class="rank-name">{{ student.name }}<small>{{ student.学号 }}</small></div><div class="rank-points">{{ student.total }} 分</div></li></ul><div v-else class="empty-state">暂无积分数据</div><div ref="chartEl" class="chart-box" style="height:300px" role="img" :aria-label="chartSummary"></div></div></div>

    <div class="card"><div class="card-title">流水明细 <span class="count">{{ entries.length }} 条</span></div><div class="points-filters"><label>学生<select class="form-select" v-model="filters.student_id" @change="applyFilters"><option value="">全部学生</option><option v-for="student in students" :key="student.id" :value="student.id">{{ student.姓名 }}</option></select></label><label>开始日期<input class="form-input" type="date" v-model="filters.date_from" @change="applyFilters"></label><label>结束日期<input class="form-input" type="date" v-model="filters.date_to" @change="applyFilters"></label><label>状态<select class="form-select" v-model="filters.status" @change="applyFilters"><option value="">全部</option><option value="有效">有效</option><option value="已撤销">已撤销</option></select></label></div><div v-if="loading" class="loading">加载中…</div><div v-else-if="!entries.length" class="empty-state">暂无积分流水</div><div v-else class="points-ledger-list"><div v-for="entry in entries" :key="entry.id" class="points-ledger-row" :class="{ revoked: entry.status === '已撤销' }"><div class="points-ledger-main"><strong>{{ entry.student_name }} · {{ entry.学号 }}</strong><span>{{ entry.occurred_at || '历史快照' }} · {{ entry.category }} · {{ entry.reason }}</span><small v-if="entry.reversal_reason">撤销原因：{{ entry.reversal_reason }}</small></div><strong class="points-amount" :class="entry.amount >= 0 ? 'positive' : 'negative'">{{ amountText(entry.amount) }}</strong><div class="record-actions"><span class="tag" :class="entry.status === '有效' ? 'tag-green' : 'tag-gray'">{{ entry.status }}</span><button v-if="entry.status === '有效'" class="btn btn-sm btn-outline" @click="revokeTarget = entry"><X :size="13" /> 撤销</button></div></div></div></div>

    <div v-if="summary.migration" class="hint points-migration-note">旧版积分快照已迁移 {{ summary.migration.imported_entries }} 条流水；原工作表保留为历史来源，不再允许直接删除或改写。</div>
    <div v-if="revokeTarget" class="modal-overlay show" @click.self="revokeTarget = null"><div class="modal"><div class="modal-kicker">撤销积分流水</div><h3>{{ revokeTarget.student_name }} · {{ amountText(revokeTarget.amount) }}</h3><p class="hint">撤销不会删除原记录，排行榜会立即按有效流水重算。</p><textarea class="form-textarea" v-model="revokeReason" rows="3" placeholder="请输入撤销原因"></textarea><div class="modal-actions"><button class="btn btn-outline" @click="revokeTarget = null">取消</button><button class="btn btn-primary" @click="revokeEntry">确认撤销</button></div></div></div>
  </div>
</template>
