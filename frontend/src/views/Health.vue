<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import * as echarts from 'echarts'
import { get } from '../api'
import DataTable from '../components/DataTable.vue'
import AddModal from '../components/AddModal.vue'
import { SHEET_FIELDS } from '../sheets'
import { Download, Plus, Dumbbell, Moon } from 'lucide-vue-next'

const weight = ref(null)
const exercise = ref(null)
const sleep = ref(null)
const loading = ref(true)
const chartEl = ref(null)
let chart = null
const weightSummary = computed(() => {
  const rows = weight.value?.rows || []
  if (!rows.length) return '暂无体重趋势数据。'
  const values = rows.map(row => Number(row.data?.[2])).filter(Number.isFinite)
  if (!values.length) return `已有 ${rows.length} 条记录，但没有可计算的体重数值。`
  const change = values[values.length - 1] - values[0]
  const direction = change > 0 ? '增加' : change < 0 ? '下降' : '持平'
  return `共 ${values.length} 次有效记录，最近体重 ${values[values.length - 1]} 斤，较首条${direction} ${Math.abs(change).toFixed(1)} 斤。`
})

const modalKind = ref(null)   // 'weight' | 'exercise' | 'sleep'

async function load() {
  loading.value = true
  try {
    const [w, e, s] = await Promise.all([
      get('/api/sheet/体重体脂追踪'),
      get('/api/sheet/运动记录'),
      get('/api/sheet/睡眠记录')
    ])
    weight.value = w
    exercise.value = e
    sleep.value = s
  } finally {
    loading.value = false
  }
  await new Promise(r => setTimeout(r, 100))
  renderChart()
}

function renderChart() {
  const dom = chartEl.value
  if (!dom || !weight.value?.rows?.length) return
  chart = echarts.init(dom)
  const dates = weight.value.rows.map(r => String(r.data[1] || ''))
  const weights = weight.value.rows.map(r => parseFloat(r.data[2]) || 0)
  chart.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: '3%', right: '4%', bottom: '5%', containLabel: true },
    xAxis: { type: 'category', data: dates },
    yAxis: { type: 'value', name: '体重(斤)' },
    series: [{
      name: '体重', type: 'line', data: weights,
      markLine: { data: [{ yAxis: 120, name: '目标120斤' }] },
      itemStyle: { color: '#1D9E75' },
      areaStyle: { color: 'rgba(29,158,117,0.15)' }
    }]
  })
  window.addEventListener('resize', () => chart && chart.resize())
}

onMounted(load)
onBeforeUnmount(() => { if (chart) chart.dispose(); window.removeEventListener('resize', () => chart && chart.resize()) })
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div class="page-title">健康追踪</div>
      <a class="btn btn-outline btn-export" href="/api/export/sheet/运动记录"><Download :size="14" :stroke-width="2" /> 导出Excel</a>
    </div>

    <div class="card">
      <div class="card-title">体重趋势</div>
      <p class="chart-text-summary">{{ weightSummary }}</p>
      <div v-if="loading" class="loading">加载中...</div>
      <div v-else-if="!weight?.rows?.length" class="empty-state">开始记录体重数据后这里会显示趋势图</div>
      <div v-else ref="chartEl" class="chart-box" role="img" :aria-label="weightSummary"></div>
      <div class="toolbar">
        <button class="btn btn-primary" @click="modalKind = 'weight'"><Plus :size="14" :stroke-width="2" /> 添加记录</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">运动记录</div>
      <div class="toolbar">
        <button class="btn btn-primary" @click="modalKind = 'exercise'"><Dumbbell :size="14" :stroke-width="2" /> 添加运动</button>
        <a class="btn btn-outline btn-export" href="/api/export/sheet/运动记录"><Download :size="14" :stroke-width="2" /> 导出</a>
      </div>
      <DataTable :headers="exercise?.headers || []" :rows="exercise?.rows || []" :max-height="300" />
    </div>

    <div class="card">
      <div class="card-title">睡眠记录</div>
      <div class="toolbar">
        <button class="btn btn-primary" @click="modalKind = 'sleep'"><Moon :size="14" :stroke-width="2" /> 添加睡眠</button>
        <a class="btn btn-outline btn-export" href="/api/export/sheet/睡眠记录"><Download :size="14" :stroke-width="2" /> 导出</a>
      </div>
      <DataTable :headers="sleep?.headers || []" :rows="sleep?.rows || []" :max-height="250" />
    </div>

    <AddModal v-if="modalKind" :title="modalKind === 'weight' ? '记录体重' : modalKind === 'exercise' ? '添加运动' : '添加睡眠'"
      :fields="SHEET_FIELDS[modalKind === 'weight' ? '体重体脂追踪' : modalKind === 'exercise' ? '运动记录' : '睡眠记录']"
      :sheet-name="modalKind === 'weight' ? '体重体脂追踪' : modalKind === 'exercise' ? '运动记录' : '睡眠记录'"
      @success="modalKind = null; load()" @close="modalKind = null" />
  </div>
</template>
