<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as echarts from 'echarts'
import { get } from '../api'

const stats = ref(null)
const loading = ref(true)
const chartEl = ref(null)
let chart = null

async function load() {
  loading.value = true
  try {
    stats.value = await get('/api/stats/scores')
  } finally {
    loading.value = false
  }
  await new Promise(r => setTimeout(r, 100))
  renderChart()
}

function renderChart() {
  const dom = chartEl.value
  if (!dom || !stats.value?.students?.length) return
  chart = echarts.init(dom)
  const names = stats.value.students.map(s => s.name)
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['月考1总分', '期中总分'], bottom: 0 },
    grid: { left: '3%', right: '4%', bottom: '12%', containLabel: true },
    xAxis: { type: 'category', data: names, axisLabel: { rotate: 30, fontSize: 10 } },
    yAxis: { type: 'value', name: '分数' },
    series: [
      { name: '月考1总分', type: 'bar', data: stats.value.students.map(s => s.yuekao1_total || 0), itemStyle: { color: '#5b6abf' } },
      { name: '期中总分', type: 'bar', data: stats.value.students.map(s => s.qizhong_total || 0), itemStyle: { color: '#7b93ff' } }
    ]
  })
  window.addEventListener('resize', () => chart && chart.resize())
}

function exportReport(exam) {
  const a = document.createElement('a')
  a.href = `/api/export/report/scores?exam=${exam}`
  a.click()
}

onMounted(load)
onBeforeUnmount(() => {
  if (chart) chart.dispose()
  window.removeEventListener('resize', () => chart && chart.resize())
})
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div class="page-title">成绩跟踪</div>
      <div class="toolbar" style="margin-bottom:0">
        <a class="btn btn-outline btn-export" href="/api/export/sheet/成绩跟踪">📥 导出明细</a>
        <button class="btn btn-outline" @click="exportReport('月考1')">📊 月考1汇总</button>
        <button class="btn btn-outline" @click="exportReport('期中')">📊 期中汇总</button>
      </div>
    </div>

    <div v-if="stats?.avg_scores" class="card">
      <div class="card-title">班级成绩概览</div>
      <div class="overview-cards">
        <div v-for="subj in stats.subjects" :key="subj" class="overview-card" style="flex:1">
          <div class="oc-icon blue">📖</div>
          <div>
            <div class="oc-label">{{ subj }}</div>
            <div style="font-size:12px;color:#666">月考:{{ stats.avg_scores.yuekao1[subj] ?? '-' }} / 期中:{{ stats.avg_scores.qizhong[subj] ?? '-' }}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">成绩分布图</div>
      <div v-if="loading" class="loading">加载中...</div>
      <div v-else ref="chartEl" class="chart-box"></div>
    </div>

    <div class="card">
      <div class="card-title">学生成绩明细</div>
      <div v-if="!stats?.students?.length" class="empty-state">还没有成绩数据</div>
      <div v-else class="table-wrap" style="max-height:450px">
        <table class="data-table">
          <thead>
            <tr>
              <th>#</th><th>姓名</th>
              <th v-for="s in stats.subjects" :key="s" style="font-weight:400">{{ s }}</th>
              <th>月考总分</th><th>期中总分</th><th>进退步</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(s, i) in stats.students" :key="i">
              <td class="idx">{{ i + 1 }}</td>
              <td>{{ s.name }}</td>
              <td v-for="(v, j) in s.yuekao1" :key="j">{{ v ?? '-' }}</td>
              <td><strong>{{ s.yuekao1_total ?? '-' }}</strong></td>
              <td><strong>{{ s.qizhong_total ?? '-' }}</strong></td>
              <td>
                <span v-if="s.change !== null && s.change !== undefined"
                  class="tag" :class="s.change > 0 ? 'tag-green' : s.change < 0 ? 'tag-red' : ''">
                  {{ s.change > 0 ? '↑' : s.change < 0 ? '↓' : '→' }}{{ Math.abs(s.change) }}
                </span>
                <span v-else>-</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>