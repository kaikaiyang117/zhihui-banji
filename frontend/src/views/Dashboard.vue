<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  ArrowRight, CalendarDays, CheckCircle, ClipboardList, Clock3, FileText,
  Plus, TrendingUp
} from 'lucide-vue-next'
import { get, getUpcomingExams } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'

const stats = ref(null)
const errorMsg = ref('')
const modalMode = ref(null)
const todaySchedule = ref(null)
const upcomingExams = ref([])
let refreshTimer = null

const calendarData = computed(() => stats.value?.calendar || { upcoming: [] })
const nextLesson = computed(() => todaySchedule.value?.entries?.find(item => item.entry) || null)
const activeCountdown = computed(() => upcomingExams.value.find(item => item.exam_date) || null)

const priorityTasks = computed(() => {
  const sections = [
    { key: 'overdue', label: '已逾期', tone: 'danger' },
    { key: 'today', label: '今天', tone: 'warning' },
    { key: 'next7', label: '即将到期', tone: 'neutral' },
  ]
  const seen = new Set()
  return sections.flatMap(section => (stats.value?.work_sections?.[section.key] || []).map(task => ({
    ...task, bucket: section.key, bucketLabel: section.label, tone: section.tone,
  }))).filter(task => {
    if (seen.has(task.id)) return false
    seen.add(task.id)
    return true
  }).slice(0, 5)
})

const followUpItems = computed(() => {
  const communications = (stats.value?.pending_communications || []).map(item => ({
    key: `communication-${item.id}`, kind: '家长', tone: 'primary', title: item.student_name,
    detail: item.summary || '待完成家校沟通', meta: item.followup_at || '待安排时间',
    to: { path: '/parent-comm', query: { student_id: item.student_id } },
  }))
  const materials = (stats.value?.material_tasks || []).map(item => ({
    key: `material-${item.id}`, kind: '材料', tone: 'success', title: item.title,
    detail: `${item.submitted} / ${item.total} 已提交`,
    meta: item.total ? `还差 ${Math.max(0, item.total - item.submitted)} 人` : '尚未设置收集名单',
    to: `/class-tasks?source_id=${item.id}`,
  }))
  const reviews = (stats.value?.review_students || []).map(item => ({
    key: `review-${item.id}`, kind: '学生', tone: 'warning', title: item.student_name,
    detail: item.reason || item.topic || '需要复查', meta: item.next_review_at || '今天',
    to: `/student/${item.student_id}`,
  }))
  return [...communications, ...materials, ...reviews].slice(0, 6)
})

const agendaItems = computed(() => calendarData.value.upcoming.filter(item => item.item_count).slice(0, 7))

const attendanceSummary = computed(() => {
  const counts = stats.value?.today_attendance || {}
  const recorded = Object.values(counts).reduce((total, count) => total + Number(count || 0), 0)
  const exceptions = ['迟到', '早退', '请假', '缺勤'].reduce((total, status) => total + Number(counts[status] || 0), 0)
  return { recorded, exceptions }
})

function dateLabel(dateText) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return match ? `${match[2]}/${match[3]}` : dateText || '日期未定'
}

function taskRoute(task) {
  return { path: '/tasks', query: { bucket: task.bucket, task: task.id, action: 'edit' } }
}

async function load() {
  errorMsg.value = ''
  try {
    stats.value = await get('/api/stats/dashboard')
    try {
      todaySchedule.value = await get(`/api/timetable/day?date=${encodeURIComponent(stats.value.date)}`)
    } catch {
      todaySchedule.value = null
    }
    try {
      upcomingExams.value = (await getUpcomingExams()) || []
    } catch {
      upcomingExams.value = []
    }
  } catch (error) {
    errorMsg.value = error.message
  }
}

function finishRecord() {
  modalMode.value = null
  load()
}

onMounted(() => {
  load()
  refreshTimer = window.setInterval(load, 60_000)
})
onUnmounted(() => {
  if (refreshTimer) window.clearInterval(refreshTimer)
})
</script>

<template>
  <div v-if="errorMsg" class="empty-state dashboard-error">
    <div>{{ errorMsg }}</div>
    <button class="btn btn-outline ds-button" @click="load">重新加载</button>
  </div>
  <div v-else-if="stats" class="dashboard-page ds-page">
    <header class="page-title-bar ds-page-header dashboard-header">
      <div>
        <div class="page-title ds-page-title">今日工作台</div>
        <div class="page-subtitle ds-page-subtitle">{{ dateLabel(stats.date) }} · 当前班级</div>
        <p class="dashboard-intro">今天有 {{ stats.work_summary.open }} 项事情需要处理，其中 {{ stats.work_summary.overdue }} 项已逾期。</p>
      </div>
      <div class="toolbar dashboard-toolbar">
        <button class="btn btn-primary ds-button" @click="modalMode = 'event'"><Plus :size="15" /> 快速记录</button>
        <router-link class="btn btn-outline ds-button" to="/attendance"><ClipboardList :size="15" /> 开始点名</router-link>
      </div>
    </header>

    <div class="dashboard-summary" aria-label="今日行动摘要">
      <router-link :to="{ path: '/tasks', query: { bucket: 'today' } }"><strong>{{ stats.work_summary.today }}</strong><span>今日待办</span></router-link>
      <router-link class="is-danger" :to="{ path: '/tasks', query: { bucket: 'overdue' } }"><strong>{{ stats.work_summary.overdue }}</strong><span>已逾期</span></router-link>
      <router-link to="/attendance"><strong>{{ attendanceSummary.recorded ? `${attendanceSummary.recorded}/${stats.total_students}` : '未完成' }}</strong><span>今日考勤</span></router-link>
      <router-link :to="{ path: '/special', query: { review_due: stats.date } }"><strong>{{ stats.review_student_count }}</strong><span>待复查</span></router-link>
    </div>

    <div class="dashboard-top-grid">
      <section class="dashboard-focus dashboard-panel" aria-labelledby="dashboard-focus-title">
        <div class="dashboard-section-head"><div><h2 id="dashboard-focus-title">今日重点</h2><p>先处理最紧急的事项</p></div><router-link to="/tasks">查看全部 <ArrowRight :size="14" /></router-link></div>
        <div v-if="!priorityTasks.length" class="dashboard-empty"><CheckCircle :size="19" /> 今天没有待处理事项</div>
        <router-link v-for="task in priorityTasks" :key="task.id" :to="taskRoute(task)" class="priority-row">
          <span class="priority-dot" :class="task.tone" aria-hidden="true"></span>
          <div class="priority-copy"><strong>{{ task.title }}</strong><span>{{ task.student_name || '班级事务' }} · {{ task.due_at || task.scheduled_at || task.bucketLabel }}</span></div>
          <span class="priority-action">处理 <ArrowRight :size="13" /></span>
        </router-link>
        <router-link v-if="stats.work_summary.open > priorityTasks.length" to="/tasks" class="dashboard-more-link">查看全部 {{ stats.work_summary.open }} 项待办 <ArrowRight :size="14" /></router-link>
      </section>

      <aside class="dashboard-today dashboard-panel" aria-labelledby="dashboard-today-title">
        <div class="dashboard-section-head"><div><h2 id="dashboard-today-title">今天</h2><p>只看现在有用的信息</p></div></div>
        <div class="today-detail">
          <Clock3 :size="17" />
          <div><span>下一节课</span><strong v-if="nextLesson">{{ nextLesson.entry.subject }}</strong><small v-if="nextLesson">{{ nextLesson.start_time || '--:--' }} · {{ nextLesson.entry.room || '教室未填' }}</small><strong v-else>今天没有课程安排</strong></div>
        </div>
        <router-link to="/attendance" class="today-detail today-link">
          <ClipboardList :size="17" />
          <div><span>今日考勤</span><strong>{{ attendanceSummary.recorded ? `${attendanceSummary.recorded} / ${stats.total_students} 人已点名` : '尚未点名' }}</strong><small>{{ attendanceSummary.recorded ? `${attendanceSummary.exceptions} 人有异常记录` : '开始今天的点名' }}</small></div>
          <ArrowRight :size="14" />
        </router-link>
        <router-link v-if="activeCountdown" to="/scores" class="today-detail today-countdown">
          <TrendingUp :size="17" />
          <div><span>重要日期</span><strong>{{ activeCountdown.name }}</strong><small>{{ dateLabel(activeCountdown.exam_date) }} · {{ activeCountdown.countdown_label || '即将开始' }}</small></div>
        </router-link>
        <div v-else class="today-detail today-muted"><CalendarDays :size="17" /><div><span>重要日期</span><strong>暂时没有近期考试</strong></div></div>
      </aside>
    </div>

    <section class="dashboard-panel dashboard-section" aria-labelledby="dashboard-follow-title">
      <div class="dashboard-section-head"><div><h2 id="dashboard-follow-title">需要跟进</h2><p>把人和事情集中在这里处理</p></div><router-link to="/tasks">查看全部 <ArrowRight :size="14" /></router-link></div>
      <div v-if="!followUpItems.length" class="dashboard-empty">目前没有待跟进事项</div>
      <div v-else class="follow-list">
        <router-link v-for="item in followUpItems" :key="item.key" :to="item.to" class="follow-row">
          <span class="follow-kind" :class="item.tone">{{ item.kind }}</span>
          <div class="follow-copy"><strong>{{ item.title }}</strong><span>{{ item.detail }}</span></div>
          <span class="follow-meta">{{ item.meta }}</span><ArrowRight :size="14" />
        </router-link>
      </div>
    </section>

    <section class="dashboard-panel dashboard-section" aria-labelledby="dashboard-agenda-title">
      <div class="dashboard-section-head"><div><h2 id="dashboard-agenda-title">未来 7 天</h2><p>提前看到需要准备的事情</p></div><router-link to="/school-calendar">查看校历 <ArrowRight :size="14" /></router-link></div>
      <div v-if="!agendaItems.length" class="dashboard-empty">未来 7 天没有已安排的校历事项或待办</div>
      <div v-else class="agenda-list">
        <router-link v-for="item in agendaItems" :key="item.date" :to="item.tasks?.[0] ? taskRoute({ ...item.tasks[0], bucket: 'open' }) : '/school-calendar'" class="agenda-row">
          <span class="agenda-date"><strong>{{ dateLabel(item.date) }}</strong><small>{{ item.weekday_label }}</small></span>
          <div><strong>{{ item.items?.[0]?.title || '当天有安排' }}</strong><span>{{ item.item_count > 1 ? `还有 ${item.item_count - 1} 项安排` : item.items?.[0]?.meta || '校历安排' }}</span></div>
          <ArrowRight :size="14" />
        </router-link>
      </div>
    </section>

    <section v-if="stats.recent_events?.length" class="dashboard-recent" aria-labelledby="dashboard-recent-title">
      <div class="dashboard-section-head"><div><h2 id="dashboard-recent-title">最近动态</h2><p>最多保留三条最近记录</p></div></div>
      <router-link v-for="item in stats.recent_events.slice(0, 3)" :key="item.id" :to="`/student/${item.student_id}`" class="recent-row"><FileText :size="15" /><span><strong>{{ item.student_name }} · {{ item.event_type }}</strong><small>{{ item.description }}</small></span><time>{{ item.occurred_at }}</time></router-link>
    </section>

    <QuickRecordModal v-if="modalMode" :mode="modalMode" :business-date="stats.date" @success="finishRecord" @close="modalMode = null" />
  </div>
  <div v-else class="loading">正在加载今日工作台…</div>
</template>

<style scoped>
.dashboard-page { display: grid; gap: 20px; color: var(--ds-color-ink); }
.dashboard-header { align-items: flex-start; margin-bottom: 0; }
.dashboard-intro { margin-top: 8px; color: var(--ds-color-ink-secondary); font: var(--ds-type-body); }
.dashboard-toolbar { margin: 0; }
.dashboard-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 0; padding: 0 2px 4px; }
.dashboard-summary a { display: inline-flex; align-items: baseline; gap: 8px; padding: 0 20px; border-right: 1px solid var(--ds-color-border); color: var(--ds-color-ink-secondary); font: var(--ds-type-label); text-decoration: none; }
.dashboard-summary a:first-child { padding-left: 0; }
.dashboard-summary a:last-child { border-right: 0; }
.dashboard-summary strong { color: var(--ds-color-ink); font-size: 18px; font-variant-numeric: tabular-nums; }
.dashboard-summary .is-danger strong { color: var(--ds-color-danger); }
.dashboard-top-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, .65fr); gap: 20px; align-items: stretch; }
.dashboard-panel { border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-card); background: var(--ds-color-surface); }
.dashboard-focus, .dashboard-today, .dashboard-section { padding: 20px 24px; }
.dashboard-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.dashboard-section-head h2 { margin: 0; font: var(--ds-type-section); letter-spacing: -.02em; }
.dashboard-section-head p { margin-top: 4px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.dashboard-section-head a, .dashboard-more-link { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; color: var(--ds-color-primary); font: var(--ds-type-label); text-decoration: none; }
.priority-row, .follow-row, .agenda-row, .recent-row { display: grid; align-items: center; gap: 12px; min-width: 0; color: var(--ds-color-ink); text-decoration: none; transition: background-color var(--ds-duration-fast) var(--ds-ease-out); }
.priority-row { grid-template-columns: 10px minmax(0, 1fr) auto; min-height: 62px; padding: 8px 10px; border-top: 1px solid var(--ds-color-border); }
.priority-row:hover, .follow-row:hover, .agenda-row:hover, .recent-row:hover { background: var(--ds-color-surface-subtle); }
.priority-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ds-color-border-strong); }
.priority-dot.danger { background: var(--ds-color-danger); }
.priority-dot.warning { background: var(--ds-color-warning); }
.priority-copy, .follow-copy, .agenda-row > div, .recent-row > span { display: grid; gap: 3px; min-width: 0; }
.priority-copy strong, .follow-copy strong, .agenda-row > div strong, .recent-row strong { overflow: hidden; font: var(--ds-type-title); text-overflow: ellipsis; white-space: nowrap; }
.priority-copy span, .follow-copy span, .agenda-row > div span, .recent-row small { overflow: hidden; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); text-overflow: ellipsis; white-space: nowrap; }
.priority-action { display: inline-flex; align-items: center; gap: 3px; color: var(--ds-color-primary); font: var(--ds-type-label); }
.dashboard-more-link { justify-content: center; width: 100%; padding: 14px 0 2px; border-top: 1px solid var(--ds-color-border); }
.dashboard-empty { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 80px; color: var(--ds-color-ink-secondary); font: var(--ds-type-body); }
.today-detail { display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: start; gap: 10px; padding: 15px 0; border-top: 1px solid var(--ds-color-border); color: var(--ds-color-ink-secondary); }
.today-detail > svg { margin-top: 2px; color: var(--ds-color-primary); }
.today-detail > div { display: grid; gap: 3px; min-width: 0; }
.today-detail span { font: var(--ds-type-meta); }
.today-detail strong { overflow: hidden; color: var(--ds-color-ink); font: var(--ds-type-title); text-overflow: ellipsis; white-space: nowrap; }
.today-detail small { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.today-link { grid-template-columns: 20px minmax(0, 1fr) auto; color: var(--ds-color-ink); text-decoration: none; }
.today-link > svg:last-child { color: var(--ds-color-primary); }
.today-countdown { color: var(--ds-color-ink); text-decoration: none; }
.today-countdown strong { color: var(--ds-color-primary-hover); }
.today-muted strong { font-weight: 500; }
.follow-list, .agenda-list { display: grid; }
.follow-row { grid-template-columns: auto minmax(0, 1fr) minmax(90px, auto) auto; min-height: 58px; padding: 8px 10px; border-top: 1px solid var(--ds-color-border); }
.follow-kind { padding: 4px 7px; border-radius: var(--ds-radius-pill); font: var(--ds-type-meta); }
.follow-kind.primary { background: var(--ds-color-primary-soft); color: var(--ds-color-primary-hover); }
.follow-kind.success { background: var(--ds-color-success-soft); color: var(--ds-color-success); }
.follow-kind.warning { background: var(--ds-color-warning-soft); color: var(--ds-color-warning); }
.follow-meta { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); text-align: right; }
.follow-row > svg, .agenda-row > svg { color: var(--ds-color-primary); }
.agenda-row { grid-template-columns: 64px minmax(0, 1fr) auto; min-height: 56px; padding: 8px 10px; border-top: 1px solid var(--ds-color-border); }
.agenda-date { display: grid; gap: 2px; }
.agenda-date strong { color: var(--ds-color-primary-hover); font: var(--ds-type-title); font-variant-numeric: tabular-nums; }
.agenda-date small { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.dashboard-recent { padding: 0 2px 12px; color: var(--ds-color-ink-secondary); }
.dashboard-recent .dashboard-section-head { margin-bottom: 4px; }
.dashboard-recent .dashboard-section-head h2 { color: var(--ds-color-ink-secondary); font-size: 14px; }
.recent-row { grid-template-columns: 20px minmax(0, 1fr) auto; min-height: 48px; padding: 6px 10px; border-top: 1px solid var(--ds-color-border); }
.recent-row > svg { color: var(--ds-color-ink-muted); }
.recent-row time { color: var(--ds-color-ink-muted); font: var(--ds-type-meta); white-space: nowrap; }
.dashboard-error { display: grid; justify-items: center; gap: 12px; }
@media (max-width: 900px) { .dashboard-top-grid { grid-template-columns: 1fr; } }
@media (max-width: 640px) {
  .dashboard-page { gap: 16px; }
  .dashboard-header { display: grid; gap: 14px; }
  .dashboard-toolbar { width: 100%; }
  .dashboard-toolbar .btn { flex: 1; justify-content: center; }
  .dashboard-summary { gap: 12px 0; }
  .dashboard-summary a { padding: 0 12px; }
  .dashboard-summary a:first-child, .dashboard-summary a:nth-child(2) { padding-left: 0; }
  .dashboard-summary a:nth-child(2), .dashboard-summary a:last-child { border-right: 0; }
  .dashboard-focus, .dashboard-today, .dashboard-section { padding: 16px; }
  .dashboard-section-head { gap: 10px; }
  .follow-row { grid-template-columns: auto minmax(0, 1fr) auto; }
  .follow-meta { grid-column: 2; grid-row: 2; text-align: left; }
  .follow-row > svg { grid-column: 3; grid-row: 1 / span 2; }
  .recent-row time { display: none; }
}
</style>
