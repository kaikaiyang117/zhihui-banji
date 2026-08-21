<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as echarts from 'echarts'
import { Download, Plus, Dumbbell, Moon, Utensils, Save, Bell, Edit3 } from 'lucide-vue-next'
import { get, post, put, download, scopedUrl } from '../api'
import DataTable from '../components/DataTable.vue'
import AddModal from '../components/AddModal.vue'
import { SHEET_FIELDS } from '../sheets'

const weight = ref(null); const exercise = ref(null); const sleep = ref(null); const diet = ref(null)
const goals = ref([]); const summary = ref(null); const reviews = ref([]); const reminders = ref([])
const loading = ref(true); const chartEl = ref(null); const modalKind = ref(null); let chart = null
const goalForm = ref({ id: null, metric: '', target_value: '', unit: '', note: '', enabled: true })
const reviewForm = ref({ period_type: 'month', period_start: '', period_end: '', summary: '', next_plan: '', metrics: {} })
const reminderForm = ref({ reminder_type: '每日记录提醒', enabled: false, remind_time: '21:00', message: '' })
const message = ref('')

const weightGoal = computed(() => goals.value.find(item => item.metric === '体重' && item.enabled))
const weightSummary = computed(() => {
  const rows = weight.value?.rows || []; const values = rows.map(row => Number(row.data?.[2])).filter(Number.isFinite)
  if (!values.length) return '暂无体重趋势数据。'
  const change = values[values.length - 1] - values[0]
  return `共 ${values.length} 次有效记录，最近体重 ${values[values.length - 1]} 斤，较首条${change > 0 ? '增加' : change < 0 ? '下降' : '持平'} ${Math.abs(change).toFixed(1)} 斤。`
})

async function load() {
  loading.value = true; message.value = ''
  try {
    const [w, e, s, d, g, sum, r, rem] = await Promise.all([
      get('/api/sheet/体重体脂追踪'), get('/api/sheet/运动记录'), get('/api/sheet/睡眠记录'), get('/api/sheet/饮食记录'),
      get('/api/health/goals'), get('/api/health/summary?period_type=month'), get('/api/health/reviews'), get('/api/health/reminders'),
    ])
    weight.value = w; exercise.value = e; sleep.value = s; diet.value = d; goals.value = g.goals || []; summary.value = sum; reviews.value = r.reviews || []; reminders.value = rem.reminders || []
    if (reminders.value[0]) reminderForm.value = { ...reminders.value[0] }
  } finally { loading.value = false }
  setTimeout(renderChart, 50)
}

function renderChart() {
  if (!chartEl.value || !weight.value?.rows?.length) return
  if (chart) chart.dispose(); chart = echarts.init(chartEl.value)
  const option = { tooltip: { trigger: 'axis' }, grid: { left: '3%', right: '4%', bottom: '5%', containLabel: true }, xAxis: { type: 'category', data: weight.value.rows.map(r => String(r.data[1] || '')) }, yAxis: { type: 'value', name: '体重(斤)' }, series: [{ name: '体重', type: 'line', data: weight.value.rows.map(r => parseFloat(r.data[2]) || 0), itemStyle: { color: '#1D9E75' }, areaStyle: { color: 'rgba(29,158,117,0.15)' } }] }
  if (weightGoal.value?.target_value !== null && weightGoal.value?.target_value !== undefined) option.series[0].markLine = { data: [{ yAxis: Number(weightGoal.value.target_value), name: '目标' }] }
  chart.setOption(option)
}

function editGoal(goal) { goalForm.value = { ...goal, target_value: goal.target_value ?? '' } }
function resetGoal() { goalForm.value = { id: null, metric: '', target_value: '', unit: '', note: '', enabled: true } }
async function saveGoal() {
  const body = { metric: goalForm.value.metric, target_value: goalForm.value.target_value === '' ? null : Number(goalForm.value.target_value), unit: goalForm.value.unit, note: goalForm.value.note, enabled: goalForm.value.enabled }
  if (goalForm.value.id) await put(`/api/health/goals/${goalForm.value.id}`, body); else await post('/api/health/goals', body)
  resetGoal(); await load()
}

async function generateReview() {
  const data = await post(`/api/health/reviews/generate?period_type=${reviewForm.value.period_type}`, {})
  reviewForm.value = { ...reviewForm.value, ...data, metrics: data.metrics || {} }
}
async function saveReview() { await post('/api/health/reviews', reviewForm.value); message.value = '健康复盘已保存'; await load() }
async function saveReminder() { await post('/api/health/reminders', reminderForm.value); message.value = '健康提醒设置已保存'; await load() }
async function exportSummary() {
  const params = new URLSearchParams({ period_type: reviewForm.value.period_type })
  await download(`/api/health/summary/export?${params}`, '个人健康汇总.xlsx')
}

onMounted(load)
onBeforeUnmount(() => { if (chart) chart.dispose() })
</script>

<template>
  <div>
    <div class="page-title-bar"><div class="page-title">健康追踪</div><a class="btn btn-outline btn-export" :href="scopedUrl('/api/export/sheet/运动记录')"><Download :size="14" /> 导出记录</a></div>
    <div v-if="message" class="success-text">{{ message }}</div>

    <div class="card">
      <div class="card-title">健康目标 <span class="count">目标由你设置</span></div>
      <div class="goal-list"><div v-for="goal in goals" :key="goal.id" class="goal-row"><span>{{ goal.metric }}：{{ goal.target_value ?? '未设置' }} {{ goal.unit }}</span><small>{{ goal.note }}</small><button class="btn btn-sm btn-outline" @click="editGoal(goal)"><Edit3 :size="13" /> 编辑</button></div></div>
      <div class="goal-form"><input v-model="goalForm.metric" placeholder="目标名称，如体重"><input v-model="goalForm.target_value" type="number" placeholder="目标值"><input v-model="goalForm.unit" placeholder="单位"><input v-model="goalForm.note" placeholder="备注"><button class="btn btn-primary" @click="saveGoal"><Save :size="14" /> {{ goalForm.id ? '保存目标' : '新增目标' }}</button><button v-if="goalForm.id" class="btn btn-outline" @click="resetGoal">取消</button></div>
    </div>

    <div class="card"><div class="card-title">体重趋势</div><p class="chart-text-summary">{{ weightSummary }}</p><div v-if="loading" class="loading">加载中...</div><div v-else-if="!weight?.rows?.length" class="empty-state">开始记录体重数据后这里会显示趋势图</div><div v-else ref="chartEl" class="chart-box" role="img" :aria-label="weightSummary"></div><div class="toolbar"><button class="btn btn-primary" @click="modalKind = 'weight'"><Plus :size="14" /> 添加体重</button></div></div>

    <div class="health-grid">
      <div class="card"><div class="card-title">运动记录</div><div class="toolbar"><button class="btn btn-primary" @click="modalKind = 'exercise'"><Dumbbell :size="14" /> 添加运动</button><a class="btn btn-outline" :href="scopedUrl('/api/export/sheet/运动记录')"><Download :size="14" /> 导出</a></div><DataTable :headers="exercise?.headers || []" :rows="exercise?.rows || []" :max-height="280" /></div>
      <div class="card"><div class="card-title">睡眠记录</div><div class="toolbar"><button class="btn btn-primary" @click="modalKind = 'sleep'"><Moon :size="14" /> 添加睡眠</button><a class="btn btn-outline" :href="scopedUrl('/api/export/sheet/睡眠记录')"><Download :size="14" /> 导出</a></div><DataTable :headers="sleep?.headers || []" :rows="sleep?.rows || []" :max-height="280" /></div>
    </div>
    <div class="card"><div class="card-title">饮食记录</div><div class="toolbar"><button class="btn btn-primary" @click="modalKind = 'diet'"><Utensils :size="14" /> 添加饮食</button><a class="btn btn-outline" :href="scopedUrl('/api/export/sheet/饮食记录')"><Download :size="14" /> 导出</a></div><DataTable :headers="diet?.headers || []" :rows="diet?.rows || []" :max-height="280" /></div>

    <div class="card"><div class="card-title">周期复盘</div><div class="review-summary" v-if="summary"><span>运动 {{ summary.exercise_days }} 天</span><span>平均睡眠 {{ summary.average_sleep_hours ?? '—' }} 小时</span><span>饮食 {{ summary.diet_days }} 天</span><span>饮水 {{ summary.average_water_ml ?? '—' }} ml</span></div><div v-if="summary?.alerts?.length" class="alert-list"><div v-for="alert in summary.alerts" :key="alert">⚠️ {{ alert }}</div></div><div class="toolbar"><select v-model="reviewForm.period_type"><option value="week">本周</option><option value="month">本月</option></select><button class="btn btn-outline" @click="generateReview">生成复盘草稿</button><button class="btn btn-outline" @click="exportSummary"><Download :size="14" /> 导出周期汇总</button></div><textarea v-model="reviewForm.summary" rows="3" placeholder="复盘总结"></textarea><textarea v-model="reviewForm.next_plan" rows="2" placeholder="下一周期计划"></textarea><button class="btn btn-primary" @click="saveReview"><Save :size="14" /> 保存复盘</button><div class="review-list"><div v-for="review in reviews" :key="review.id"><strong>{{ review.period_start }} 至 {{ review.period_end }}</strong><p>{{ review.summary }}</p><small>{{ review.next_plan }}</small></div></div></div>

    <div class="card"><div class="card-title"><Bell :size="17" /> 可选提醒</div><div class="reminder-form"><label><input type="checkbox" v-model="reminderForm.enabled"> {{ reminderForm.reminder_type }}</label><input v-model="reminderForm.remind_time" type="time"><input v-model="reminderForm.message" placeholder="提醒内容（可选）"><button class="btn btn-primary" @click="saveReminder"><Save :size="14" /> 保存</button></div></div>

    <AddModal v-if="modalKind" :title="modalKind === 'weight' ? '记录体重' : modalKind === 'exercise' ? '添加运动' : modalKind === 'sleep' ? '添加睡眠' : '添加饮食'" :fields="SHEET_FIELDS[modalKind === 'weight' ? '体重体脂追踪' : modalKind === 'exercise' ? '运动记录' : modalKind === 'sleep' ? '睡眠记录' : '饮食记录']" :sheet-name="modalKind === 'weight' ? '体重体脂追踪' : modalKind === 'exercise' ? '运动记录' : modalKind === 'sleep' ? '睡眠记录' : '饮食记录'" @success="modalKind = null; load()" @close="modalKind = null" />
  </div>
</template>

<style scoped>
.goal-list { display:grid; gap:7px; margin-bottom:12px; }.goal-row { display:grid; grid-template-columns:180px 1fr auto; gap:10px; align-items:center; padding:8px 10px; background:var(--bg-elevated); border-radius:8px; font-size:13px; }.goal-row small,.muted { color:var(--text-secondary); }.goal-form,.reminder-form { display:flex; flex-wrap:wrap; gap:8px; }.goal-form input,.reminder-form input,.reminder-form select,.card textarea { border:1px solid var(--border); border-radius:8px; padding:8px 10px; background:var(--bg); color:var(--text); }.health-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }.review-summary { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:12px; }.review-summary span { padding:8px 12px; background:var(--bg-elevated); border-radius:8px; font-size:13px; }.alert-list { color:var(--warning); margin:8px 0; font-size:13px; }.card textarea { width:100%; display:block; margin:9px 0; resize:vertical; }.review-list { margin-top:15px; display:grid; gap:10px; }.review-list > div { border-top:1px solid var(--border); padding-top:10px; }.review-list p { margin:5px 0; }.review-list small { color:var(--text-secondary); }.success-text { color:var(--success); margin:0 0 10px; }
@media (max-width:700px) { .health-grid { grid-template-columns:1fr; }.goal-row { grid-template-columns:1fr auto; }.goal-row small { grid-column:1 / -1; }.goal-form > * { min-width:calc(50% - 4px); } }
</style>
