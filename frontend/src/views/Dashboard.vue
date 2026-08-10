<script setup>
import { computed, onMounted, ref } from 'vue'
import {
  AlertTriangle, ArrowRight, CalendarDays, CheckCircle, ClipboardList,
  FileText, Phone, Plus, ShieldCheck, Tag, TrendingUp, Upload, UserRound, Users
} from 'lucide-vue-next'
import FullCalendar from '@fullcalendar/vue3'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin from '@fullcalendar/interaction'
import zhCnLocale from '@fullcalendar/core/locales/zh-cn'
import { get, post, upload } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'

const stats = ref(null)
const errorMsg = ref('')
const modalMode = ref(null)
const fileInput = ref(null)
const backupMessage = ref('')
const selectedDate = ref('')

const actionSections = computed(() => {
  if (!stats.value) return []
  const sections = [
    { key: 'overdue', title: '已经逾期', hint: '优先处理，避免继续积压', tone: 'danger', items: stats.value.work_sections.overdue },
    { key: 'today', title: '今天要做', hint: '计划或截止日期在今天', tone: 'primary', items: stats.value.work_sections.today },
    { key: 'next7', title: '即将到期', hint: '未来 7 天需要安排', tone: 'neutral', items: stats.value.work_sections.next7 },
  ]
  return sections.filter(section => section.key !== 'overdue' || section.items.length)
})
const calendarData = computed(() => stats.value?.calendar || { days: [], upcoming: [], summary: {} })
const selectedDay = computed(() => calendarData.value.days.find(day => day.date === selectedDate.value) || calendarData.value.days.find(day => day.is_today) || calendarData.value.days[0] || null)
const upcomingPlans = computed(() => calendarData.value.upcoming.filter(item => item.item_count))
function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const calendarOptions = computed(() => ({
  plugins: [dayGridPlugin, interactionPlugin],
  locales: [zhCnLocale],
  locale: 'zh-cn',
  initialView: 'dayGridMonth',
  initialDate: stats.value?.date,
  firstDay: 1,
  fixedWeekCount: false,
  height: 520,
  headerToolbar: false,
  dayMaxEvents: 2,
  events: calendarData.value.days.flatMap(day => {
    const events = []
    const entry = day.school_calendar
    if (entry && (entry.title || !['上课日', '放假日'].includes(entry.day_type))) {
      events.push({ id: `calendar-${day.date}`, date: day.date, allDay: true, title: entry.title || entry.day_type, classNames: [entry.is_school_day ? 'dashboard-calendar-school' : 'dashboard-calendar-holiday'], extendedProps: { date: day.date } })
    }
    if (day.task_count) events.push({ id: `tasks-${day.date}`, date: day.date, allDay: true, title: `${day.task_count} 项待办`, classNames: ['dashboard-calendar-task'], extendedProps: { date: day.date } })
    return events
  }),
  dateClick: ({ dateStr }) => { selectedDate.value = dateStr },
  eventClick: ({ event }) => { selectedDate.value = event.extendedProps.date },
  dayCellClassNames: ({ date }) => {
    const day = calendarData.value.days.find(item => item.date === localDate(date))
    return day?.school_calendar && !day.school_calendar.is_school_day ? ['dashboard-calendar-holiday-cell'] : []
  },
}))
const attendanceSummary = computed(() => {
  const counts = stats.value?.today_attendance || {}
  const recorded = Object.values(counts).reduce((total, count) => total + Number(count || 0), 0)
  const exceptions = ['迟到', '早退', '请假', '缺勤'].reduce((total, status) => total + Number(counts[status] || 0), 0)
  return { recorded, exceptions }
})

async function load() {
  errorMsg.value = ''
  try {
    stats.value = await get('/api/stats/dashboard')
    selectedDate.value = stats.value.date
  } catch (error) {
    errorMsg.value = error.message
  }
}

async function backup() {
  backupMessage.value = '正在生成备份…'
  try {
    const result = await post('/api/system/backup', {})
    backupMessage.value = `备份已生成：${result.filename}`
    window.open(`/api/system/backup/${encodeURIComponent(result.filename)}`, '_blank')
  } catch (error) {
    backupMessage.value = `备份失败：${error.message}`
  }
}

async function restore(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || !confirm('恢复会替换当前数据。确定继续吗？')) return
  backupMessage.value = '正在恢复数据…'
  try {
    await upload('/api/system/restore', file)
    backupMessage.value = '恢复完成，页面数据已刷新'
    await load()
  } catch (error) {
    backupMessage.value = `恢复失败：${error.message}`
  }
}

function taskRoute(task, action = 'edit', bucket = 'open') {
  return { path: '/tasks', query: { bucket, task: task.id, action } }
}

function finishRecord() {
  modalMode.value = null
  load()
}

onMounted(load)
</script>

<template>
  <div v-if="errorMsg" class="empty-state">
    <div>{{ errorMsg }}</div>
    <button class="btn btn-outline" @click="load">重新加载</button>
  </div>
  <div v-else-if="stats" class="dashboard-page">
    <div class="page-title-bar">
      <div>
        <div class="page-title">今日工作台</div>
        <div class="page-subtitle">{{ stats.date }} · 从最需要处理的事情开始</div>
      </div>
      <div class="toolbar dashboard-toolbar">
        <router-link class="btn btn-primary" to="/attendance"><ClipboardList :size="14" /> 开始点名</router-link>
        <button class="btn btn-outline" @click="modalMode = 'event'"><Plus :size="14" /> 快速记录</button>
        <details class="dashboard-more-actions">
          <summary class="btn btn-outline">更多操作</summary>
          <div class="dashboard-more-menu">
            <button @click="backup"><ShieldCheck :size="14" /> 备份数据</button>
            <button @click="fileInput?.click()"><Upload :size="14" /> 恢复数据</button>
          </div>
        </details>
        <input ref="fileInput" type="file" accept=".db" hidden @change="restore">
      </div>
    </div>

    <section class="action-summary" aria-label="今日行动摘要">
      <router-link :to="{ path: '/tasks', query: { bucket: 'overdue' } }" class="action-summary-card danger">
        <AlertTriangle :size="19" />
        <span>已逾期</span><strong>{{ stats.work_summary.overdue }}</strong>
        <small>需要优先处理</small>
      </router-link>
      <router-link :to="{ path: '/tasks', query: { bucket: 'today' } }" class="action-summary-card primary">
        <CheckCircle :size="19" />
        <span>今日待办</span><strong>{{ stats.work_summary.today }}</strong>
        <small>计划今天推进</small>
      </router-link>
      <router-link to="/attendance" class="action-summary-card attendance-summary-card">
        <ClipboardList :size="19" />
        <span>今日考勤</span>
        <strong>{{ attendanceSummary.recorded ? `${attendanceSummary.recorded}/${stats.total_students}` : '未点名' }}</strong>
        <small>{{ attendanceSummary.recorded ? `${attendanceSummary.exceptions} 人异常` : '开始今日点名' }}</small>
      </router-link>
      <router-link :to="{ path: '/special', query: { review_due: stats.date } }" class="action-summary-card">
        <UserRound :size="19" />
        <span>待复查学生</span><strong>{{ stats.review_student_count }}</strong>
        <small>复查日期已到</small>
      </router-link>
    </section>

    <div v-if="backupMessage" class="notice-bar"><ShieldCheck :size="16" /> {{ backupMessage }}</div>

    <section class="action-board" aria-labelledby="action-board-title">
      <div class="section-heading">
        <div><h2 id="action-board-title">今天要做</h2><p>进入事项后可完成、延期或继续处理来源记录</p></div>
        <router-link to="/tasks">全部 {{ stats.work_summary.open }} 项 <ArrowRight :size="14" /></router-link>
      </div>
      <div class="action-columns" :class="{ 'action-columns-compact': actionSections.length < 3 }">
        <article v-for="section in actionSections" :key="section.key" class="action-column" :class="section.tone">
          <header><div><strong>{{ section.title }}</strong><span>{{ section.hint }}</span></div><em>{{ stats.work_summary[section.key] }}</em></header>
          <div v-if="!section.items.length" class="action-empty">这个时间范围内没有事项</div>
          <div v-for="task in section.items.slice(0, 4)" :key="task.id" class="dashboard-task">
            <div class="dashboard-task-copy">
              <strong>{{ task.title }}</strong>
              <span>{{ task.student_name || '班级事务' }} · {{ task.due_at || task.scheduled_at || '未设置日期' }}</span>
            </div>
            <div class="dashboard-task-actions">
              <router-link :to="taskRoute(task, 'complete', section.key)">完成</router-link>
              <router-link :to="taskRoute(task, 'postpone', section.key)">延期</router-link>
              <router-link :to="taskRoute(task, 'edit', section.key)" aria-label="处理工作项">处理 <ArrowRight :size="12" /></router-link>
            </div>
          </div>
          <router-link v-if="section.items.length" :to="{ path: '/tasks', query: { bucket: section.key } }" class="column-more">查看这一组 <ArrowRight :size="12" /></router-link>
        </article>
      </div>
    </section>

    <section class="card dashboard-calendar-card" aria-labelledby="dashboard-calendar-title">
      <div class="section-heading dashboard-calendar-heading">
        <div><h2 id="dashboard-calendar-title"><CalendarDays :size="17" /> 本月安排</h2><p>点击日期查看当天校历和待办，未来 7 天安排也会集中列在下方</p></div>
        <router-link to="/school-calendar">管理完整校历 <ArrowRight :size="13" /></router-link>
      </div>
      <div class="dashboard-calendar-layout">
        <div class="dashboard-calendar-month">
          <FullCalendar v-if="stats" class="dashboard-calendar-component" :options="calendarOptions" />
        </div>
        <aside v-if="selectedDay" class="dashboard-day-detail">
          <div class="dashboard-day-title"><strong>{{ selectedDay.date }}</strong><span>{{ selectedDay.weekday_label }}</span></div>
          <div v-if="selectedDay.school_calendar" class="dashboard-day-school" :class="{ holiday: !selectedDay.school_calendar.is_school_day }"><span>{{ selectedDay.school_calendar.title || selectedDay.school_calendar.day_type }}</span><small>{{ selectedDay.school_calendar.is_school_day ? '上课日' : '非上课日' }}</small></div>
          <div v-if="!selectedDay.school_calendar && !selectedDay.task_count" class="empty-state compact-empty">当天没有校历或待办安排</div>
          <router-link v-for="task in selectedDay.tasks" :key="task.id" :to="taskRoute(task, 'edit', 'open')" class="dashboard-day-task"><span>{{ task.title }}</span><small>{{ task.student_name || task.source_label || '班级事务' }}</small><ArrowRight :size="13" /></router-link>
        </aside>
      </div>
      <div class="dashboard-upcoming">
        <div class="dashboard-upcoming-title"><strong>未来 7 天</strong><span>{{ calendarData.summary.upcoming_items || 0 }} 项安排</span></div>
        <div v-if="!upcomingPlans.length" class="empty-state compact-empty">未来 7 天没有已安排的校历事项或待办</div>
        <router-link v-for="item in upcomingPlans" :key="item.date" :to="item.tasks[0] ? taskRoute(item.tasks[0], 'edit', 'open') : '/school-calendar'" class="dashboard-upcoming-row">
          <span class="dashboard-upcoming-date"><strong>{{ item.day }}</strong><small>{{ item.weekday_label }}</small></span>
          <span class="dashboard-upcoming-copy"><strong>{{ item.items[0]?.title || '当天有安排' }}</strong><small>{{ item.item_count > 1 ? `还有 ${item.item_count - 1} 项安排` : item.items[0]?.meta }}</small></span>
          <ArrowRight :size="13" />
        </router-link>
      </div>
    </section>

    <div class="dashboard-grid operational-grid">
      <section class="card operational-card">
        <div class="card-title"><Phone :size="16" /> 待回访家长 <span class="count">{{ stats.pending_communication_count }}</span><router-link to="/parent-comm" class="card-action">管理 <ArrowRight :size="13" /></router-link></div>
        <div v-if="!stats.pending_communications.length" class="empty-state compact-empty">暂无待回访家长</div>
        <router-link v-for="item in stats.pending_communications.slice(0, 5)" :key="item.id" :to="{ path: '/parent-comm', query: { student_id: item.student_id } }" class="compact-action-row">
          <div><strong>{{ item.student_name }}</strong><span>{{ item.summary || '待完成家校沟通' }} · {{ item.followup_at }}</span></div>
          <ArrowRight :size="14" />
        </router-link>
      </section>

      <section class="card operational-card">
        <div class="card-title"><ClipboardList :size="16" /> 材料收集进度 <span class="count">{{ stats.material_task_count }}</span><router-link to="/class-tasks" class="card-action">管理 <ArrowRight :size="13" /></router-link></div>
        <div v-if="!stats.material_tasks.length" class="empty-state compact-empty">暂无进行中的班级任务</div>
        <router-link v-for="task in stats.material_tasks.slice(0, 5)" :key="task.id" :to="`/class-tasks?source_id=${task.id}`" class="material-row">
          <div class="material-copy"><strong>{{ task.title }}</strong><span>{{ task.submitted }} / {{ task.total }} 已提交 · {{ task.due_at || '未设置截止日期' }}</span></div>
          <div class="material-progress" :aria-label="`${task.title}完成 ${task.progress}%`"><i :style="{ width: `${task.progress}%` }"></i></div>
          <em>{{ task.progress }}%</em>
        </router-link>
      </section>
    </div>

    <div class="dashboard-grid">
      <section class="card">
        <div class="card-title"><UserRound :size="16" /> 需要复查的学生 <span class="count">{{ stats.review_student_count }}</span><router-link :to="{ path: '/special', query: { review_due: stats.date } }" class="card-action">管理 <ArrowRight :size="13" /></router-link></div>
        <div v-if="!stats.review_students.length" class="empty-state compact-empty">今天没有到期的学生复查</div>
        <router-link v-for="item in stats.review_students" :key="item.id" :to="`/student/${item.student_id}`" class="focus-row linked-row">
          <div><strong>{{ item.student_name }} · {{ item.topic }}</strong><div class="hint">{{ item.reason }}</div></div>
          <span class="tag tag-orange">{{ item.next_review_at }}</span>
        </router-link>
      </section>

      <section class="card class-snapshot">
        <div class="card-title"><Users :size="16" /> 今日班级概况</div>
        <div class="snapshot-grid">
          <router-link to="/students"><span>在班学生</span><strong>{{ stats.total_students }}</strong></router-link>
          <router-link to="/attendance"><span>已点名</span><strong>{{ attendanceSummary.recorded ? `${attendanceSummary.recorded}/${stats.total_students}` : '未点名' }}</strong></router-link>
          <router-link to="/attendance"><span>考勤异常</span><strong>{{ attendanceSummary.exceptions }}</strong></router-link>
          <router-link to="/tasks"><span>全部待处理</span><strong>{{ stats.work_summary.open }}</strong></router-link>
        </div>
      </section>
    </div>

    <section class="card">
      <div class="card-title">最近动态</div>
      <div v-if="!stats.recent_events.length" class="empty-state compact-empty">记录事件后，这里会形成班级动态</div>
      <router-link v-for="item in stats.recent_events" :key="item.id" :to="`/student/${item.student_id}`" class="activity-row linked-row">
        <div class="activity-icon"><FileText :size="15" /></div>
        <div><strong>{{ item.student_name }} · {{ item.event_type }}</strong><span>{{ item.description }}</span></div>
        <time>{{ item.occurred_at }}</time>
      </router-link>
    </section>

    <section class="card dashboard-quick-actions-card">
      <div class="card-title">快捷操作</div>
      <div class="toolbar dashboard-quick-actions">
        <router-link to="/attendance" class="btn btn-primary"><ClipboardList :size="14" /> 开始点名</router-link>
        <button class="btn btn-outline" @click="modalMode = 'event'"><FileText :size="14" /> 记录学生事件</button>
        <button class="btn btn-outline" @click="modalMode = 'comm'"><Phone :size="14" /> 家校沟通</button>
        <button class="btn btn-outline" @click="modalMode = 'focus'"><Tag :size="14" /> 添加关注</button>
        <router-link to="/scores" class="btn btn-outline"><TrendingUp :size="14" /> 查看成绩</router-link>
      </div>
    </section>

    <QuickRecordModal v-if="modalMode" :mode="modalMode" :business-date="stats.date" @success="finishRecord" @close="modalMode = null" />
  </div>
  <div v-else class="loading">正在加载今日工作台…</div>
</template>

<style scoped>
.dashboard-page { display: grid; gap: 16px; }
.dashboard-toolbar { margin-bottom: 0; }
.dashboard-page .card { box-shadow: none; }
.dashboard-more-actions { position: relative; }
.dashboard-more-actions summary { list-style: none; cursor: pointer; }
.dashboard-more-actions summary::-webkit-details-marker { display: none; }
.dashboard-more-menu { position: absolute; z-index: 5; top: calc(100% + 6px); right: 0; display: grid; min-width: 132px; padding: 5px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); box-shadow: var(--shadow-md); }
.dashboard-more-menu button { display: flex; align-items: center; gap: 7px; padding: 8px 9px; border: 0; border-radius: 7px; color: var(--text); background: transparent; cursor: pointer; font: inherit; font-size: 12px; text-align: left; }
.dashboard-more-menu button:hover { background: var(--primary-bg); color: var(--primary); }
.action-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.action-summary-card { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 5px 9px; min-height: 86px; padding: 15px 16px; border: 1px solid var(--border); border-radius: 15px; background: var(--surface); color: var(--text-secondary); text-decoration: none; box-shadow: var(--shadow-sm); }
.action-summary-card > svg { grid-row: 1 / span 2; color: var(--primary); }
.action-summary-card span { color: var(--text-secondary); font-size: 12px; }
.action-summary-card strong { color: var(--text); font-size: 25px; line-height: 1; }
.action-summary-card small { color: var(--text-tertiary); font-size: 11px; }
.action-summary-card.danger { border-color: rgba(220,64,54,.2); background: var(--danger-bg); }
.action-summary-card.danger > svg, .action-summary-card.danger strong { color: var(--danger); }
.action-summary-card.primary { border-color: rgba(91,106,191,.2); background: var(--primary-bg); }
.attendance-summary-card { border-color: rgba(45, 180, 95, .2); background: var(--success-bg); }
.attendance-summary-card > svg, .attendance-summary-card strong { color: #26834b; }
.action-board { padding: 2px 0; border: 0; background: transparent; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 13px; }
.section-heading h2 { margin: 0; color: var(--text); font-size: 16px; }
.section-heading p { margin: 4px 0 0; color: var(--text-secondary); font-size: 12px; }
.section-heading > a, .column-more { display: inline-flex; align-items: center; gap: 4px; color: var(--primary); font-size: 12px; text-decoration: none; }
.action-columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.action-columns-compact { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.action-column { min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: 13px; background: var(--bg); }
.action-column.danger { border-color: rgba(220,64,54,.16); background: rgba(255,245,244,.75); }
.action-column.primary { border-color: rgba(91,106,191,.16); background: rgba(246,247,253,.8); }
.action-column > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-bottom: 10px; }
.action-column header > div { display: grid; gap: 2px; min-width: 0; }
.action-column header strong { color: var(--text); font-size: 13px; }
.action-column header span { color: var(--text-secondary); font-size: 11px; }
.action-column header em { display: grid; place-items: center; min-width: 26px; height: 26px; border-radius: 8px; background: var(--surface); color: var(--text); font-size: 12px; font-style: normal; font-weight: 700; }
.dashboard-task { display: grid; gap: 7px; padding: 10px 0; border-top: 1px solid var(--border); }
.dashboard-task-copy { display: grid; gap: 3px; min-width: 0; }
.dashboard-task-copy strong { overflow: hidden; color: var(--text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.dashboard-task-copy span { color: var(--text-secondary); font-size: 11px; }
.dashboard-task-actions { display: flex; gap: 5px; }
.dashboard-task-actions a { display: inline-flex; min-height: 30px; box-sizing: border-box; align-items: center; gap: 2px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text-secondary); font-size: 12px; text-decoration: none; }
.dashboard-task-actions a:last-child { margin-left: auto; border-color: transparent; background: transparent; color: var(--primary); }
.action-empty { padding: 22px 4px; border-top: 1px solid var(--border); color: var(--text-tertiary); font-size: 11px; text-align: center; }
.column-more { justify-content: center; margin-top: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
.dashboard-calendar-card { padding: 16px; border: 1px solid var(--border); background: var(--surface); }
.dashboard-calendar-heading { align-items: center; margin-bottom: 12px; }
.dashboard-calendar-heading h2 { display: flex; align-items: center; gap: 7px; }
.dashboard-calendar-heading > a { display: inline-flex; align-items: center; gap: 4px; color: var(--primary); font-size: 12px; text-decoration: none; }
.dashboard-calendar-layout { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(220px, .55fr); grid-template-rows: 520px; gap: 16px; align-items: stretch; }
.dashboard-calendar-month { min-width: 0; height: 100%; }
.dashboard-calendar-component :deep(.fc) { --fc-border-color: #d5d8df; --fc-today-bg-color: rgba(91, 106, 191, .08); color: var(--text); font-size: 12px; }
.dashboard-calendar-component :deep(.fc-scrollgrid) { border: 1px solid #d0d3da; border-radius: 10px; overflow: hidden; }
.dashboard-calendar-component :deep(.fc-col-header-cell) { background: #f1f2f5; }
.dashboard-calendar-component :deep(.fc-col-header-cell-cushion) { padding: 8px 4px; color: #626873; font-size: 11px; font-weight: 600; text-decoration: none; }
.dashboard-calendar-component :deep(.fc-daygrid-day-frame) { min-height: 76px; padding: 3px; }
.dashboard-calendar-component :deep(.fc-daygrid-day-number) { padding: 4px 5px; color: #626873; font-size: 11px; font-weight: 500; text-decoration: none; }
.dashboard-calendar-component :deep(.fc-day-other .fc-daygrid-day-number) { color: #9da2ab; }
.dashboard-calendar-component :deep(.fc-day-today .fc-daygrid-day-number) { color: #4053a5; font-weight: 700; }
.dashboard-calendar-component :deep(.fc-daygrid-event) { margin: 2px 3px; padding: 2px 4px; border: 0; border-radius: 5px; font-size: 10px; line-height: 1.25; cursor: pointer; }
.dashboard-calendar-component :deep(.dashboard-calendar-school) { --fc-event-bg-color: #e4e9ff; --fc-event-border-color: #e4e9ff; --fc-event-text-color: #3f51a1; background: #e4e9ff; color: #3f51a1; }
.dashboard-calendar-component :deep(.dashboard-calendar-holiday) { --fc-event-bg-color: #ffe1e5; --fc-event-border-color: #ffe1e5; --fc-event-text-color: #a43d50; background: #ffe1e5; color: #a43d50; }
.dashboard-calendar-component :deep(.dashboard-calendar-task) { --fc-event-bg-color: #dcefe2; --fc-event-border-color: #dcefe2; --fc-event-text-color: #246b42; background: #dcefe2; color: #246b42; }
.dashboard-calendar-component :deep(.fc-event-main) { color: inherit; }
.dashboard-calendar-component :deep(.dashboard-calendar-holiday-cell) { background: #fff8f8; }
.dashboard-day-detail { display: grid; align-content: start; gap: 8px; min-width: 0; height: 100%; max-height: 100%; box-sizing: border-box; overflow-y: auto; padding: 12px; border: 1px solid var(--border-light); border-radius: 11px; background: var(--bg); }
.dashboard-day-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.dashboard-day-title strong { font-size: 14px; }
.dashboard-day-title span { color: var(--text-secondary); font-size: 11px; }
.dashboard-day-school { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px; border-radius: 8px; background: var(--primary-bg); color: var(--primary); font-size: 12px; }
.dashboard-day-school.holiday { background: rgba(235, 90, 105, .1); color: #b5465a; }
.dashboard-day-school small { font-size: 10px; }
.dashboard-day-task { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 6px; padding: 8px 0; border-top: 1px solid var(--border); color: var(--text); text-decoration: none; }
.dashboard-day-task span { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.dashboard-day-task small { color: var(--text-secondary); font-size: 10px; }
.dashboard-day-task svg { grid-column: 2; grid-row: 1 / span 2; align-self: center; color: var(--primary); }
.dashboard-upcoming { display: grid; gap: 7px; margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--border); }
.dashboard-upcoming-title { display: flex; align-items: center; gap: 7px; }
.dashboard-upcoming-title span { color: var(--text-secondary); font-size: 11px; }
.dashboard-upcoming-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 9px; border: 1px solid var(--border-light); border-radius: 8px; color: var(--text); text-decoration: none; }
.dashboard-upcoming-row:hover { border-color: rgba(91, 106, 191, .35); background: var(--primary-bg); }
.dashboard-upcoming-date { display: grid; justify-items: center; gap: 2px; color: var(--primary); }
.dashboard-upcoming-date strong { font-size: 15px; line-height: 1; }
.dashboard-upcoming-date small, .dashboard-upcoming-copy small { color: var(--text-secondary); font-size: 10px; }
.dashboard-upcoming-copy { display: grid; gap: 3px; min-width: 0; }
.dashboard-upcoming-copy strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.dashboard-upcoming-row > svg { color: var(--primary); }
.operational-grid { align-items: stretch; }
.operational-card { margin: 0; }
.compact-action-row, .material-row { display: grid; align-items: center; gap: 8px; padding: 10px 0; border-top: 1px solid var(--border); color: var(--text); text-decoration: none; }
.compact-action-row { grid-template-columns: minmax(0, 1fr) auto; }
.compact-action-row > div, .material-copy { display: grid; gap: 3px; min-width: 0; }
.compact-action-row strong, .material-row strong { font-size: 12px; }
.compact-action-row span, .material-row span { overflow: hidden; color: var(--text-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.material-row { grid-template-columns: minmax(0, 1fr) 76px 34px; }
.material-progress { height: 6px; overflow: hidden; border-radius: 999px; background: var(--border); }
.material-progress i { display: block; height: 100%; border-radius: inherit; background: var(--success); }
.material-row em { color: var(--text-secondary); font-size: 11px; font-style: normal; text-align: right; }
.linked-row { color: inherit; text-decoration: none; }
.class-snapshot { margin: 0; }
.snapshot-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.snapshot-grid a { display: grid; gap: 3px; padding: 12px; border-radius: 11px; background: var(--bg); color: var(--text-secondary); font-size: 11px; text-decoration: none; }
.snapshot-grid strong { color: var(--text); font-size: 20px; }
.dashboard-quick-actions-card { margin-top: -2px; }
.dashboard-quick-actions { margin-bottom: 0; }
@media (max-width: 900px) {
  .action-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .action-columns, .action-columns-compact { grid-template-columns: 1fr; }
  .dashboard-calendar-layout { grid-template-columns: 1fr; grid-template-rows: auto; }
  .dashboard-day-detail { height: auto; max-height: none; overflow: visible; }
}
@media (max-width: 640px) {
  .dashboard-toolbar { width: 100%; }
  .dashboard-toolbar .btn { flex: 1; justify-content: center; }
  .dashboard-more-actions { flex: 1; }
  .dashboard-more-actions summary { justify-content: center; text-align: center; }
  .action-summary { gap: 8px; }
  .action-summary-card { min-height: 78px; padding: 12px; }
  .action-summary-card strong { font-size: 22px; }
  .action-board { padding: 14px; }
  .section-heading { align-items: center; }
  .section-heading p { display: none; }
  .dashboard-calendar-card { padding: 12px; }
  .material-row { grid-template-columns: minmax(0, 1fr) 60px 30px; }
}
</style>
