<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  AlertTriangle, BarChart3, CheckCircle, Clock, Download, FileEdit,
  History, MessageSquareText, Save, Trash2, UserRound, XCircle
} from 'lucide-vue-next'
import { del, get, post, put } from '../api'

const SCENES = ['常规到校', '早自习', '上午', '下午', '晚自习']
const STATUS_OPTIONS = ['出勤', '迟到', '请假', '早退', '缺勤']
const students = ref([])
const dayRecords = ref([])
const stats = ref(null)
const rules = ref([])
const recentRuns = ref([])
const loading = ref(true)
const saving = ref(false)
const evaluatingRules = ref(false)
const pageError = ref('')
const savedMessage = ref('')
const ruleMessage = ref('')
const selectedDate = ref(localDate())
const selectedScene = ref('常规到校')
const records = ref({})
const dateFrom = ref(monthStart())
const dateTo = ref(localDate())
const statsScene = ref('全部场景')
const batchNote = ref('')
const batchTarget = ref('异常学生')
const newRule = ref({
  name: '一周迟到提醒', metric: '迟到次数', threshold: 2,
  period_days: 7, priority: '重要', scene: '全部场景'
})
const route = useRoute()
const sourceId = Number(route.query.source_id || 0)

function localDate() {
  const d = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function monthStart() {
  return `${localDate().slice(0, 7)}-01`
}

function defaultRecord(student) {
  return { student_id: student.id, status: '出勤', reason: '', arrive: '', leave: '', note: '' }
}

function hydrateDayRecords() {
  const byStudent = new Map(dayRecords.value.map(item => [Number(item.student_id), item]))
  const next = {}
  for (const student of students.value) {
    const old = byStudent.get(Number(student.id))
    next[student.id] = old
      ? {
          student_id: student.id, status: old.status || '出勤',
          reason: old.reason || '', arrive: old.arrive_at || '',
          leave: old.leave_at || '', note: old.note || ''
        }
      : defaultRecord(student)
  }
  records.value = next
}

async function loadDayRecords() {
  const query = new URLSearchParams({ date: selectedDate.value, scene: selectedScene.value })
  dayRecords.value = (await get(`/api/attendance/records?${query}`)).records || []
  hydrateDayRecords()
}

async function loadStats() {
  const query = new URLSearchParams({
    date_from: dateFrom.value, date_to: dateTo.value, scene: statsScene.value
  })
  stats.value = await get(`/api/stats/attendance?${query}`)
}

async function loadRules() {
  const data = await get(sourceId
    ? `/api/attendance/rules?source_id=${sourceId}`
    : '/api/attendance/rules')
  rules.value = data.rules || []
  recentRuns.value = data.recent_runs || []
}

async function load() {
  loading.value = true
  pageError.value = ''
  try {
    students.value = (await get('/api/students')).students || []
    await loadDayRecords()
    await loadStats()
    await loadRules()
  } catch (error) {
    pageError.value = error.message
  } finally {
    loading.value = false
  }
}

async function changeAttendanceScope() {
  savedMessage.value = ''
  try {
    await loadDayRecords()
  } catch (error) {
    pageError.value = error.message
  }
}

async function addRule() {
  ruleMessage.value = ''
  try {
    const result = await post('/api/attendance/rules', newRule.value)
    const evaluation = result.evaluation
    ruleMessage.value = evaluation?.created_count
      ? `规则已保存，并生成 ${evaluation.created_count} 条跟进工作项`
      : '规则已保存并完成首次检查'
    await loadRules()
  } catch (error) {
    ruleMessage.value = `保存失败：${error.message}`
  }
}

async function toggleRule(rule) {
  ruleMessage.value = ''
  try {
    const result = await put(`/api/attendance/rules/${rule.id}`, { enabled: !rule.enabled })
    ruleMessage.value = !rule.enabled
      ? `规则已启用并重新检查，重开 ${result.evaluation?.reopened_count || 0} 项`
      : `规则已停用，解除 ${result.resolved_count || 0} 项提醒`
    await loadRules()
  } catch (error) {
    ruleMessage.value = error.message
  }
}

async function removeRule(rule) {
  if (!confirm(`删除规则“${rule.name}”并移入回收站吗？`)) return
  try {
    await del(`/api/records/attendance_rule/${rule.id}`)
    ruleMessage.value = '规则已移入回收站'
    await loadRules()
  } catch (error) {
    ruleMessage.value = error.message
  }
}

async function evaluateRules() {
  evaluatingRules.value = true
  ruleMessage.value = ''
  try {
    const result = await post('/api/attendance/rules/evaluate', {
      reference_date: selectedDate.value
    })
    ruleMessage.value = `检查完成：命中 ${result.hit_count}，新建 ${result.created_count}，重开 ${result.reopened_count}，解除 ${result.resolved_count}`
    await loadRules()
  } catch (error) {
    ruleMessage.value = `检查失败：${error.message}`
  } finally {
    evaluatingRules.value = false
  }
}

function setAll(status) {
  for (const student of students.value) records.value[student.id].status = status
}

function applyBatchNote() {
  const note = batchNote.value.trim()
  if (!note) return
  let applied = 0
  for (const student of students.value) {
    const record = records.value[student.id]
    if (batchTarget.value === '异常学生' && record.status === '出勤') continue
    record.note = note
    applied += 1
  }
  savedMessage.value = `已把备注填入 ${applied} 名${batchTarget.value}`
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
    const result = await post('/api/attendance/daily', {
      date: selectedDate.value, scene: selectedScene.value,
      records: Object.values(records.value)
    })
    const evaluation = result.evaluation
    const ruleText = result.evaluation_error
      ? `；规则检查失败：${result.evaluation_error}`
      : evaluation
        ? `；规则命中 ${evaluation.hit_count}，新建 ${evaluation.created_count}，重开 ${evaluation.reopened_count}，解除 ${evaluation.resolved_count}`
        : ''
    savedMessage.value = `已保存 ${result.saved} 名学生的${selectedScene.value}考勤${ruleText}`
    await loadDayRecords()
    await loadStats()
    await loadRules()
  } catch (error) {
    savedMessage.value = `保存失败：${error.message}`
  } finally {
    saving.value = false
  }
}

function exportReport() {
  const query = new URLSearchParams()
  if (dateFrom.value) query.set('date_from', dateFrom.value)
  if (dateTo.value) query.set('date_to', dateTo.value)
  const anchor = document.createElement('a')
  anchor.href = `/api/export/report/attendance?${query}`
  anchor.click()
}

function runLabel(trigger) {
  return ({ save: '保存后自动检查', startup: '启动检查', manual: '手动检查', rule_change: '规则变更检查' })[trigger] || trigger
}

onMounted(load)
</script>

<template>
  <div class="attendance-page">
    <div class="page-title-bar">
      <div>
        <div class="page-title">考勤管理</div>
        <div class="page-subtitle">按场景完成点名，保存后自动识别需要跟进的异常</div>
      </div>
      <div class="toolbar attendance-export-actions">
        <a class="btn btn-outline btn-export" href="/api/export/sheet/考勤管理"><Download :size="14" /> 导出明细</a>
        <button class="btn btn-outline" @click="exportReport"><Download :size="14" /> 导出汇总</button>
      </div>
    </div>

    <div v-if="pageError" class="empty-state">
      <AlertTriangle :size="28" />
      <strong>考勤数据加载失败</strong><span>{{ pageError }}</span>
      <button class="btn btn-outline" @click="load">重新加载</button>
    </div>
    <template v-else>
      <section class="attendance-hero card" aria-label="考勤场次">
        <label class="attendance-date">点名日期<input type="date" v-model="selectedDate" @change="changeAttendanceScope"></label>
        <label class="attendance-date">考勤场景<select class="form-select" v-model="selectedScene" @change="changeAttendanceScope"><option v-for="scene in SCENES" :key="scene">{{ scene }}</option></select></label>
        <div class="attendance-actions">
          <button class="btn btn-outline" @click="setAll('出勤')"><CheckCircle :size="14" /> 全员到校</button>
          <button class="btn btn-primary" :disabled="saving || loading" @click="saveDaily"><Save :size="14" /> {{ saving ? '保存中…' : `保存${selectedScene}考勤` }}</button>
        </div>
        <div v-if="savedMessage" class="attendance-message" :class="{ error: savedMessage.startsWith('保存失败') }">{{ savedMessage }}</div>
      </section>

      <section class="attendance-summary" aria-label="当前场次人数统计">
        <div class="attendance-summary-item green"><CheckCircle :size="17" /><span>出勤</span><strong>{{ dailyCounts['出勤'] }}</strong></div>
        <div class="attendance-summary-item orange"><Clock :size="17" /><span>迟到</span><strong>{{ dailyCounts['迟到'] }}</strong></div>
        <div class="attendance-summary-item blue"><FileEdit :size="17" /><span>请假</span><strong>{{ dailyCounts['请假'] }}</strong></div>
        <div class="attendance-summary-item purple"><Clock :size="17" /><span>早退</span><strong>{{ dailyCounts['早退'] }}</strong></div>
        <div class="attendance-summary-item red"><XCircle :size="17" /><span>缺勤</span><strong>{{ dailyCounts['缺勤'] }}</strong></div>
      </section>

      <section class="card">
        <div class="card-title"><UserRound :size="16" /> 全班点名 <span class="count">{{ students.length }} 人 · {{ selectedScene }}</span></div>
        <div class="batch-note-row">
          <MessageSquareText :size="15" />
          <select v-model="batchTarget" class="form-select"><option>异常学生</option><option>全班</option></select>
          <input v-model="batchNote" class="form-input" placeholder="填写批量备注，例如：暴雨天气统一延迟到校">
          <button class="btn btn-outline" :disabled="!batchNote.trim()" @click="applyBatchNote">应用备注</button>
        </div>
        <div v-if="loading" class="loading">加载中…</div>
        <div v-else-if="!students.length" class="empty-state">请先导入学生名单</div>
        <div v-else class="attendance-list">
          <div v-for="student in students" :key="student.id" class="attendance-row" :class="`attendance-${records[student.id]?.status || '出勤'}`">
            <div class="attendance-student"><strong>{{ student.姓名 }}</strong><span>{{ student.学号 }}</span></div>
            <select :aria-label="`${student.姓名}考勤状态`" class="form-select attendance-status" v-model="records[student.id].status"><option v-for="status in STATUS_OPTIONS" :key="status">{{ status }}</option></select>
            <input v-if="records[student.id].status !== '出勤'" :aria-label="`${student.姓名}异常原因`" class="form-input attendance-note" v-model="records[student.id].reason" :placeholder="records[student.id].status === '请假' ? '请假原因' : '异常原因（可选）'">
            <input v-if="records[student.id].status === '迟到'" :aria-label="`${student.姓名}到校时间`" class="form-input attendance-time" type="time" v-model="records[student.id].arrive">
            <input :aria-label="`${student.姓名}考勤备注`" class="form-input attendance-note" v-model="records[student.id].note" placeholder="备注（可选）">
          </div>
        </div>
      </section>

      <section class="card attendance-rules-card">
        <div class="card-title"><Clock :size="16" /> 考勤规则 <span class="count">保存考勤和启动应用时自动检查</span><button class="btn btn-outline rule-evaluate" :disabled="evaluatingRules" @click="evaluateRules">{{ evaluatingRules ? '检查中…' : '立即检查' }}</button></div>
        <div class="rule-create-row">
          <input class="form-input" v-model="newRule.name" placeholder="规则名称">
          <select class="form-select" v-model="newRule.metric"><option>迟到次数</option><option>请假次数</option><option>缺勤次数</option><option>连续缺勤天数</option></select>
          <select class="form-select" v-model="newRule.scene"><option>全部场景</option><option v-for="scene in SCENES" :key="scene">{{ scene }}</option></select>
          <input aria-label="规则阈值" class="form-input rule-number" type="number" min="1" v-model.number="newRule.threshold"><span>次 /</span>
          <input aria-label="统计天数" class="form-input rule-number" type="number" min="1" max="365" v-model.number="newRule.period_days"><span>天</span>
          <select aria-label="规则优先级" class="form-select" v-model="newRule.priority"><option>普通</option><option>重要</option><option>紧急</option></select>
          <button class="btn btn-primary" @click="addRule">新增规则</button>
        </div>
        <div v-if="ruleMessage" class="inline-message">{{ ruleMessage }}</div>
        <div v-if="!rules.length" class="empty-state compact-empty">还没有考勤规则，新增后会立即执行首次检查</div>
        <article v-for="rule in rules" :key="rule.id" class="rule-card" :class="{ 'source-highlight': rule.id === sourceId }">
          <div class="rule-card-head">
            <div><strong>{{ rule.name }}</strong><span>{{ rule.metric }} ≥ {{ rule.threshold }} · 最近 {{ rule.period_days }} 天 · {{ rule.scene }} · {{ rule.priority }}</span><small>{{ rule.last_run_at ? `最近执行：${rule.last_run_at}` : '尚未执行' }}</small></div>
            <div class="record-actions"><span class="tag" :class="rule.active_hit_count ? 'tag-orange' : 'tag-green'">待处理 {{ rule.active_hit_count }}</span><span v-if="rule.handled_hit_count" class="tag">已处理 {{ rule.handled_hit_count }}</span><button class="tag" :class="rule.enabled ? 'tag-green' : ''" @click="toggleRule(rule)">{{ rule.enabled ? '已启用' : '已停用' }}</button><button class="btn btn-sm btn-outline" aria-label="删除考勤规则" @click="removeRule(rule)"><Trash2 :size="13" /></button></div>
          </div>
          <div v-if="rule.hits.length" class="rule-hit-list">
            <router-link v-for="hit in rule.hits.slice(0, 6)" :key="hit.id" :to="hit.task_id ? `/tasks?bucket=all&task=${hit.task_id}&action=edit` : `/student/${hit.student_id}`" class="rule-hit-row">
              <span><strong>{{ hit.student_name }}</strong> · 当前值 {{ hit.current_value }}</span>
              <em :class="{ active: hit.status === '待处理' }">{{ hit.status }}<template v-if="hit.task_status"> · {{ hit.task_status }}</template></em>
            </router-link>
          </div>
        </article>
        <details v-if="recentRuns.length" class="rule-run-history">
          <summary><History :size="14" /> 最近执行历史</summary>
          <div v-for="run in recentRuns.slice(0, 8)" :key="run.id" class="rule-run-row"><span>{{ run.created_at }} · {{ runLabel(run.trigger_type) }}</span><span>规则 {{ run.rules_evaluated }} · 命中 {{ run.hit_count }} · 新建 {{ run.created_count }} · 重开 {{ run.reopened_count }} · 解除 {{ run.resolved_count }}</span></div>
        </details>
      </section>

      <section class="card attendance-analysis">
        <div class="card-title"><BarChart3 :size="16" /> 考勤统计与异常名单</div>
        <div class="attendance-filter-row">
          <label>开始日期<input type="date" v-model="dateFrom"></label>
          <label>结束日期<input type="date" v-model="dateTo"></label>
          <label>场景<select class="form-select" v-model="statsScene"><option>全部场景</option><option v-for="scene in SCENES" :key="scene">{{ scene }}</option></select></label>
          <button class="btn btn-outline" @click="loadStats">更新统计</button>
        </div>
        <p class="stats-definition">{{ stats?.definition }}</p>
        <div class="overview-cards compact-overview attendance-period-summary">
          <div class="overview-card"><div class="oc-label">总记录</div><div class="oc-value">{{ stats?.total_records || 0 }}</div></div>
          <div v-for="status in STATUS_OPTIONS" :key="status" class="overview-card"><div class="oc-label">{{ status }}</div><div class="oc-value">{{ stats?.status_count?.[status] || 0 }}</div></div>
        </div>
        <div class="attendance-analysis-grid">
          <div class="attendance-table-panel">
            <h3>学生统计</h3>
            <div v-if="!stats?.student_stats?.length" class="empty-state compact-empty">当前范围没有考勤记录</div>
            <div v-else class="table-scroll"><table><thead><tr><th>学生</th><th>总记录</th><th>迟到</th><th>请假</th><th>早退</th><th>缺勤</th><th>出勤率</th></tr></thead><tbody><tr v-for="item in stats.student_stats" :key="item.student_id"><td><router-link :to="`/student/${item.student_id}`">{{ item.student_name }}</router-link></td><td>{{ item['总记录'] }}</td><td>{{ item['迟到'] }}</td><td>{{ item['请假'] }}</td><td>{{ item['早退'] }}</td><td>{{ item['缺勤'] }}</td><td>{{ item.attendance_rate }}%</td></tr></tbody></table></div>
          </div>
          <div class="attendance-table-panel">
            <h3>异常名单</h3>
            <div v-if="!stats?.anomalies?.length" class="empty-state compact-empty">当前范围没有异常记录</div>
            <div v-else class="anomaly-list"><router-link v-for="item in stats.anomalies.slice(0, 50)" :key="item.id" :to="`/student/${item.student_id}`" class="anomaly-row"><span><strong>{{ item.student_name }}</strong> · {{ item.date }} · {{ item.scene }}</span><span><em>{{ item.status }}</em>{{ item.reason || item.note || '无备注' }}</span></router-link></div>
          </div>
        </div>
        <div class="attendance-period-grid">
          <div><h3>按月</h3><div v-for="item in stats?.month_stats || []" :key="item.label" class="period-row"><strong>{{ item.label }}</strong><span>{{ item['总记录'] }} 条 · 异常 {{ item['异常'] }}</span></div><div v-if="!stats?.month_stats?.length" class="hint">暂无月度数据</div></div>
          <div><h3>按周次</h3><div v-for="item in stats?.week_stats || []" :key="item.label" class="period-row"><strong>{{ item.label }}</strong><span>{{ item['总记录'] }} 条 · 异常 {{ item['异常'] }}</span></div><div v-if="!stats?.week_stats?.length" class="hint">暂无周次数据</div></div>
        </div>
      </section>
    </template>
  </div>
</template>
