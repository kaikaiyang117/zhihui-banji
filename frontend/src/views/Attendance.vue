<script setup>
import { ref, reactive, onMounted } from 'vue'
import { get } from '../api'
import DataTable from '../components/DataTable.vue'
import AddModal from '../components/AddModal.vue'
import { SHEET_FIELDS } from '../sheets'
import { CheckCircle, Clock, FileEdit, XCircle, ClipboardList, Download, BarChart3 } from 'lucide-vue-next'

const data = ref(null)
const stats = ref(null)
const loading = ref(true)
const showAdd = ref(false)
const dateFrom = ref('')
const dateTo = ref('')

const STATUS_COMPONENT = { '出勤': CheckCircle, '迟到': Clock, '请假': FileEdit, '缺勤': XCircle }
const STATUS_COLOR = { '出勤': 'green', '迟到': 'orange', '请假': 'blue', '缺勤': 'red' }

async function load() {
  loading.value = true
  try {
    const [d, s] = await Promise.all([
      get('/api/sheet/考勤管理'),
      get('/api/stats/attendance')
    ])
    data.value = d
    stats.value = s
  } finally {
    loading.value = false
  }
}

function exportReport() {
  const q = new URLSearchParams()
  if (dateFrom.value) q.set('date_from', dateFrom.value)
  if (dateTo.value) q.set('date_to', dateTo.value)
  const a = document.createElement('a')
  a.href = '/api/export/report/attendance?' + q.toString()
  a.click()
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div class="page-title">考勤管理</div>
      <div class="toolbar" style="margin-bottom:0">
        <button class="btn btn-primary" @click="showAdd = true"><ClipboardList :size="14" :stroke-width="2" /> 添加考勤</button>
        <a class="btn btn-outline btn-export" href="/api/export/sheet/考勤管理"><Download :size="14" :stroke-width="2" /> 导出明细</a>
        <div class="report-bar">
          <input type="date" v-model="dateFrom" title="开始日期">
          <span>至</span>
          <input type="date" v-model="dateTo" title="结束日期">
          <button class="btn btn-outline" @click="exportReport"><BarChart3 :size="14" :stroke-width="2" /> 导出汇总报表</button>
        </div>
      </div>
    </div>

    <div v-if="stats?.status_count" class="overview-cards">
      <div v-for="(v, k) in stats.status_count" :key="k" class="overview-card" style="flex:1">
        <div class="oc-icon" :class="STATUS_COLOR[k] || 'blue'"><component :is="STATUS_COMPONENT[k] || BarChart3" :size="20" :stroke-width="2" /></div>
        <div><div class="oc-label">{{ k }}</div><div class="oc-value">{{ v }}</div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">考勤明细</div>
      <div v-if="loading" class="loading">加载中...</div>
      <DataTable v-else :headers="data?.headers || []" :rows="data?.rows || []" :max-height="400" :searchable="true" />
    </div>

    <AddModal v-if="showAdd" title="添加考勤" :fields="SHEET_FIELDS['考勤管理']"
      sheet-name="考勤管理" @success="showAdd = false; load()" @close="showAdd = false" />
  </div>
</template>