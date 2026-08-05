<script setup>
import { ref, computed, onMounted } from 'vue'
import { CheckCircle, Clock, FileEdit, XCircle, ClipboardList, Download, Save, UserRound } from 'lucide-vue-next'
import { get, post } from '../api'

const students = ref([])
const existingRows = ref([])
const stats = ref(null)
const loading = ref(true)
const saving = ref(false)
const savedMessage = ref('')
const selectedDate = ref(localDate())
const records = ref({})
const dateFrom = ref('')
const dateTo = ref('')

function localDate() {
  const d = new Date()
  const pad = v => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function defaultRecord(student) {
  return { student_id: student.id, status: '出勤', reason: '', arrive: '', leave: '', note: '' }
}

async function load() {
  loading.value = true
  try {
    const [studentData, sheet, summary] = await Promise.all([
      get('/api/students'), get('/api/sheet/考勤管理'), get('/api/stats/attendance')
    ])
    students.value = studentData.students || []
    existingRows.value = sheet.rows || []
    stats.value = summary
    loadDateRecords()
  } finally { loading.value = false }
}

function loadDateRecords() {
  const byXh = new Map()
  for (const row of existingRows.value) {
    const d = row.data || []
    if (String(d[0] || '').slice(0, 10) === selectedDate.value) byXh.set(String(d[2] || '').trim(), d)
  }
  const next = {}
  for (const student of students.value) {
    const old = byXh.get(String(student.学号 || '').trim())
    next[student.id] = old
      ? { student_id: student.id, status: old[4] || '出勤', reason: old[5] || '', arrive: old[6] || '', leave: old[7] || '', note: old[8] || '' }
      : defaultRecord(student)
  }
  records.value = next
  savedMessage.value = ''
}

function setAll(status) {
  for (const student of students.value) records.value[student.id].status = status
}

const dailyCounts = computed(() => students.value.reduce((acc, student) => {
  const status = records.value[student.id]?.status || '出勤'
  acc[status] = (acc[status] || 0) + 1
  return acc
}, { 出勤: 0, 迟到: 0, 请假: 0, 早退: 0, 缺勤: 0 }))

async function saveDaily() {
  saving.value = true
  savedMessage.value = ''
  try {
    await post('/api/attendance/daily', { date: selectedDate.value, records: Object.values(records.value) })
    savedMessage.value = `已保存 ${students.value.length} 名学生的 ${selectedDate.value} 考勤`
    await load()
  } catch (e) { savedMessage.value = `保存失败：${e.message}` } finally { saving.value = false }
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
      <div><div class="page-title">考勤管理</div><div class="page-subtitle">默认全员已到，只需要标记今天的异常</div></div>
      <div class="toolbar" style="margin-bottom:0"><a class="btn btn-outline btn-export" href="/api/export/sheet/考勤管理"><Download :size="14" /> 导出明细</a><button class="btn btn-outline" @click="exportReport"><Download :size="14" /> 导出汇总</button></div>
    </div>

    <div class="attendance-hero card">
      <div class="attendance-date"><label>点名日期</label><input type="date" v-model="selectedDate" @change="loadDateRecords"></div>
      <div class="attendance-actions"><button class="btn btn-outline" @click="setAll('出勤')"><CheckCircle :size="14" /> 全员到校</button><button class="btn btn-primary" :disabled="saving" @click="saveDaily"><Save :size="14" /> {{ saving ? '保存中…' : '保存今日考勤' }}</button></div>
      <div v-if="savedMessage" class="attendance-message" :class="{ error: savedMessage.startsWith('保存失败') }">{{ savedMessage }}</div>
    </div>

    <div class="attendance-summary">
      <div class="attendance-summary-item green"><CheckCircle :size="17" /><span>出勤</span><strong>{{ dailyCounts['出勤'] }}</strong></div>
      <div class="attendance-summary-item orange"><Clock :size="17" /><span>迟到</span><strong>{{ dailyCounts['迟到'] }}</strong></div>
      <div class="attendance-summary-item blue"><FileEdit :size="17" /><span>请假</span><strong>{{ dailyCounts['请假'] }}</strong></div>
      <div class="attendance-summary-item red"><XCircle :size="17" /><span>缺勤</span><strong>{{ dailyCounts['缺勤'] }}</strong></div>
    </div>

    <div class="card">
      <div class="card-title"><UserRound :size="16" /> 全班点名 <span class="count">{{ students.length }} 人</span></div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!students.length" class="empty-state">请先导入学生名单</div>
      <div v-else class="attendance-list">
        <div v-for="student in students" :key="student.id" class="attendance-row" :class="`attendance-${records[student.id]?.status || '出勤'}`">
          <div class="attendance-student"><strong>{{ student.姓名 }}</strong><span>{{ student.学号 }}</span></div>
          <select class="form-select attendance-status" v-model="records[student.id].status"><option>出勤</option><option>迟到</option><option>请假</option><option>早退</option><option>缺勤</option></select>
          <input v-if="['迟到','请假','缺勤'].includes(records[student.id].status)" class="form-input attendance-note" v-model="records[student.id].reason" :placeholder="records[student.id].status === '请假' ? '请假原因' : '备注（可选）'">
          <input v-if="records[student.id].status === '迟到'" class="form-input attendance-time" type="time" v-model="records[student.id].arrive">
        </div>
      </div>
    </div>

    <div class="card muted-card">
      <div class="card-title">历史累计（用于趋势观察）</div>
      <div class="overview-cards compact-overview"><div v-for="(v, k) in stats?.status_count" :key="k" class="overview-card"><div class="oc-label">{{ k }}</div><div class="oc-value">{{ v }}</div></div></div>
    </div>
  </div>
</template>
