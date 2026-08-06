<script setup>
import { computed, ref } from 'vue'
import { onMounted } from 'vue'
import { FileUp, TrendingUp, Users } from 'lucide-vue-next'
import { get, upload } from '../api'

const summary = ref({ exams: [], subjects: [], records: [] })
const legacy = ref(null)
const loading = ref(true)
const importing = ref(false)
const message = ref('')
const fileInput = ref(null)

const latestExam = computed(() => summary.value.exams[summary.value.exams.length - 1])
const trendRows = computed(() => {
  const byStudent = new Map()
  for (const row of summary.value.records) {
    if (!byStudent.has(row.student_id)) byStudent.set(row.student_id, { student_id: row.student_id, name: row.姓名, exams: {} })
    const item = byStudent.get(row.student_id)
    item.exams[row.exam_name] ||= { total: 0, count: 0 }
    if (row.score !== null && row.score !== undefined) { item.exams[row.exam_name].total += row.score; item.exams[row.exam_name].count += 1 }
  }
  return [...byStudent.values()].map(row => {
    for (const exam of Object.values(row.exams)) exam.total = exam.count ? Math.round(exam.total * 10) / 10 : null
    return row
  })
})

async function load() {
  loading.value = true
  try {
    const [data, old] = await Promise.all([get('/api/exams/summary'), get('/api/stats/scores')])
    summary.value = data
    legacy.value = old
  } finally { loading.value = false }
}

function pickFile() { fileInput.value?.click() }

async function importFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  importing.value = true
  message.value = ''
  try {
    const result = await upload('/api/exams/import', file)
    message.value = `已导入 ${result.imported} 条，更新 ${result.updated} 条${result.errors?.length ? `，${result.errors.length} 行未匹配` : ''}`
    await load()
  } catch (e) { message.value = `导入失败：${e.message}` } finally { importing.value = false }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div><div class="page-title">成绩跟踪</div><div class="page-subtitle">按考试记录成绩，观察学生个人变化</div></div>
      <div class="toolbar" style="margin-bottom:0">
        <input ref="fileInput" type="file" accept=".xlsx,.xlsm" hidden @change="importFile">
        <button class="btn btn-primary" :disabled="importing" @click="pickFile"><FileUp :size="14" /> {{ importing ? '导入中…' : '导入成绩 Excel' }}</button>
      </div>
    </div>

    <div v-if="message" class="inline-message">{{ message }}</div>

    <div v-if="summary.exams.length" class="overview-cards">
      <div v-for="exam in summary.exams" :key="`${exam.exam_name}-${exam.exam_date}`" class="overview-card">
        <div class="oc-icon blue"><TrendingUp :size="20" /></div>
        <div><div class="oc-label">{{ exam.exam_name }}</div><strong>{{ exam.exam_date || '日期未填' }}</strong><div class="hint">{{ Object.keys(exam.subjects).length }} 个科目 · {{ exam.total }} 分</div></div>
      </div>
    </div>

    <div v-if="summary.exams.length" class="card">
      <div class="card-title"><TrendingUp :size="16" /> 学生成绩趋势</div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>学生</th><th v-for="exam in summary.exams" :key="exam.exam_name">{{ exam.exam_name }}</th><th>变化</th></tr></thead>
          <tbody>
            <tr v-for="row in trendRows" :key="row.student_id">
              <td><router-link :to="`/student/${row.student_id}`" class="table-link">{{ row.name }}</router-link></td>
              <td v-for="exam in summary.exams" :key="exam.exam_name">{{ row.exams[exam.exam_name]?.total ?? '—' }}</td>
              <td>{{ latestExam && row.exams[latestExam.exam_name] ? '已记录' : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><Users :size="16" /> 成绩明细 <span class="count">{{ summary.records.length }} 条</span></div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!summary.records.length" class="empty-state">还没有结构化成绩。可以导入包含“学号、考试名称、考试日期、语文、数学…”的 Excel。</div>
      <div v-else class="table-wrap" style="max-height:450px">
        <table class="data-table"><thead><tr><th>考试</th><th>学生</th><th>科目</th><th>分数</th><th>排名</th></tr></thead>
          <tbody><tr v-for="row in summary.records" :key="row.id"><td>{{ row.exam_name }}<small class="table-sub">{{ row.exam_date }}</small></td><td><router-link :to="`/student/${row.student_id}`" class="table-link">{{ row.姓名 }}</router-link></td><td>{{ row.subject }}</td><td><strong>{{ row.score ?? '—' }}</strong></td><td>{{ row.rank ?? '—' }}</td></tr></tbody>
        </table>
      </div>
    </div>

    <div v-if="!summary.records.length && legacy?.students?.length" class="card muted-card">
      <div class="card-title">历史成绩表仍可查看</div>
      <div class="hint">当前数据库中的旧版成绩数据有 {{ legacy.students.length }} 名学生；新导入的数据会按考试和科目形成可追踪趋势。</div>
    </div>
  </div>
</template>
