<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as echarts from 'echarts'
import { Star, Download } from 'lucide-vue-next'
import { get, del } from '../api'
import DataTable from '../components/DataTable.vue'
import AddModal from '../components/AddModal.vue'
import { SHEET_FIELDS } from '../sheets'

const stats = ref(null)
const rows = ref([])
const headers = ref([])
const loading = ref(true)
const showAdd = ref(false)
const chartEl = ref(null)
let chart = null

async function load() {
  loading.value = true
  try {
    const [s, d] = await Promise.all([
      get('/api/stats/points'),
      get('/api/sheet/日常行为积分')
    ])
    stats.value = s
    rows.value = d.rows || []
    headers.value = d.headers || []
  } finally {
    loading.value = false
  }
  await new Promise(r => setTimeout(r, 100))
  renderChart()
}

async function removeRow(rowNo) {
  if (!confirm('确定删除这一行吗？')) return
  await del(`/api/sheet/日常行为积分/row/${rowNo}`)
  load()
}

function renderChart() {
  const dom = chartEl.value
  if (!dom || !stats.value?.students?.length) return
  chart = echarts.init(dom)
  const top5 = stats.value.students.slice(0, 5)
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: top5.map(s => s.name), bottom: 0 },
    grid: { left: '3%', right: '4%', bottom: '15%', containLabel: true },
    xAxis: { type: 'category', data: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'] },
    yAxis: { type: 'value' },
    series: top5.map(s => ({ name: s.name, type: 'line', data: s.weekly }))
  })
  window.addEventListener('resize', () => chart && chart.resize())
}

onMounted(load)
onBeforeUnmount(() => { if (chart) chart.dispose() })
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div class="page-title">行为积分</div>
      <div class="toolbar" style="margin-bottom:0">
        <button class="btn btn-primary" @click="showAdd = true"><Star :size="14" :stroke-width="2" /> 添加积分</button>
        <a class="btn btn-outline btn-export" href="/api/export/sheet/日常行为积分"><Download :size="14" :stroke-width="2" /> 导出Excel</a>
      </div>
    </div>

    <div class="card">
      <div class="card-title">积分排行榜</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
        <ul v-if="stats?.students?.length" class="rank-list">
          <li v-for="(s, i) in stats.students.slice(0, 10)" :key="i" class="rank-item">
            <div class="rank-num" :class="['gold','silver','bronze','normal'][i] || 'normal'">{{ i + 1 }}</div>
            <div class="rank-name">{{ s.name }}</div>
            <div class="rank-points">{{ s.total }} 分</div>
          </li>
        </ul>
        <div v-else class="empty-state">暂无积分数据</div>
        <div ref="chartEl" class="chart-box" style="height:300px"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">积分明细</div>
      <div v-if="loading" class="loading">加载中...</div>
      <DataTable v-else :headers="headers" :rows="rows" :max-height="400"
        :highlight="[10, 11]" @delete="removeRow($event)" />
    </div>

    <AddModal v-if="showAdd" title="添加积分" :fields="SHEET_FIELDS['日常行为积分']"
      sheet-name="日常行为积分" @success="showAdd = false; load()" @close="showAdd = false" />
  </div>
</template>