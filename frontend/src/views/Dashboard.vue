<script setup>
import { computed, onMounted, ref } from 'vue'
import {
  AlertTriangle, Archive, ArrowRight, CalendarDays, CheckCircle, ClipboardList,
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
const migrationInput = ref(null)
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

async function exportMigration() {
  backupMessage.value = '正在整理迁移包（数据库、附件和知识库）…'
  try {
    const result = await post('/api/system/migration/export', {})
    backupMessage.value = `迁移包已生成：${result.filename}`
    window.open(`/api/system/migration/${encodeURIComponent(result.filename)}`, '_blank')
  } catch (error) {
    backupMessage.value = `迁移包生成失败：${error.message}`
  }
}

async function importMigration(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || !confirm('导入迁移包会替换当前数据库，并覆盖同名照片、附件和知识库文件。系统会先自动备份当前数据库，确定继续吗？')) return
  backupMessage.value = '正在导入迁移包…'
  try {
    await upload('/api/system/migration/import', file)
    backupMessage.value = '迁移包导入完成，页面数据已刷新'
    await load()
  } catch (error) {
    backupMessage.value = `迁移包导入失败：${error.message}`
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
    <button class="btn btn-outline ds-button" @click="load">重新加载</button>
  </div>
  <div v-else-if="stats" class="dashboard-page ds-page">
    <div class="page-title-bar ds-page-header">
      <div>
        <div class="page-title ds-page-title">今日工作台</div>
        <div class="page-subtitle ds-page-subtitle">{{ stats.date }} · 从最需要处理的事情开始</div>
      </div>
      <div class="toolbar dashboard-toolbar">
        <router-link class="btn btn-primary ds-button" to="/attendance"><ClipboardList :size="14" /> 开始点名</router-link>
        <button class="btn btn-outline ds-button" @click="modalMode = 'event'"><Plus :size="14" /> 快速记录</button>
        <details class="dashboard-more-actions">
          <summary class="btn btn-outline ds-button">更多操作</summary>
          <div class="dashboard-more-menu">
            <button @click="backup"><ShieldCheck :size="14" /> 备份数据</button>
            <button @click="fileInput?.click()"><Upload :size="14" /> 恢复数据</button>
            <button @click="exportMigration" title="包含数据库、业务附件和知识库，不包含模型密钥和微信凭证"><Archive :size="14" /> 导出迁移包</button>
            <button @click="migrationInput?.click()"><Archive :size="14" /> 导入迁移包</button>
          </div>
        </details>
        <input ref="fileInput" type="file" accept=".db" hidden @change="restore">
        <input ref="migrationInput" type="file" accept=".zip" hidden @change="importMigration">
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
      <div class="section-heading ds-section-heading">
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

    <section class="card ds-card dashboard-calendar-card" aria-labelledby="dashboard-calendar-title">
      <div class="section-heading ds-section-heading dashboard-calendar-heading">
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
      <section class="card ds-card operational-card">
        <div class="card-title"><Phone :size="16" /> 待回访家长 <span class="count">{{ stats.pending_communication_count }}</span><router-link to="/parent-comm" class="card-action">管理 <ArrowRight :size="13" /></router-link></div>
        <div v-if="!stats.pending_communications.length" class="empty-state compact-empty">暂无待回访家长</div>
        <router-link v-for="item in stats.pending_communications.slice(0, 5)" :key="item.id" :to="{ path: '/parent-comm', query: { student_id: item.student_id } }" class="compact-action-row">
          <div><strong>{{ item.student_name }}</strong><span>{{ item.summary || '待完成家校沟通' }} · {{ item.followup_at }}</span></div>
          <ArrowRight :size="14" />
        </router-link>
      </section>

      <section class="card ds-card operational-card">
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
      <section class="card ds-card">
        <div class="card-title"><UserRound :size="16" /> 需要复查的学生 <span class="count">{{ stats.review_student_count }}</span><router-link :to="{ path: '/special', query: { review_due: stats.date } }" class="card-action">管理 <ArrowRight :size="13" /></router-link></div>
        <div v-if="!stats.review_students.length" class="empty-state compact-empty">今天没有到期的学生复查</div>
        <router-link v-for="item in stats.review_students" :key="item.id" :to="`/student/${item.student_id}`" class="focus-row linked-row">
          <div><strong>{{ item.student_name }} · {{ item.topic }}</strong><div class="hint">{{ item.reason }}</div></div>
          <span class="tag tag-orange">{{ item.next_review_at }}</span>
        </router-link>
      </section>

      <section class="card ds-card class-snapshot">
        <div class="card-title"><Users :size="16" /> 今日班级概况</div>
        <div class="snapshot-grid">
          <router-link to="/students"><span>在班学生</span><strong>{{ stats.total_students }}</strong></router-link>
          <router-link to="/attendance"><span>已点名</span><strong>{{ attendanceSummary.recorded ? `${attendanceSummary.recorded}/${stats.total_students}` : '未点名' }}</strong></router-link>
          <router-link to="/attendance"><span>考勤异常</span><strong>{{ attendanceSummary.exceptions }}</strong></router-link>
          <router-link to="/tasks"><span>全部待处理</span><strong>{{ stats.work_summary.open }}</strong></router-link>
        </div>
      </section>
    </div>

    <section class="card ds-card">
      <div class="card-title">最近动态</div>
      <div v-if="!stats.recent_events.length" class="empty-state compact-empty">记录事件后，这里会形成班级动态</div>
      <router-link v-for="item in stats.recent_events" :key="item.id" :to="`/student/${item.student_id}`" class="activity-row linked-row">
        <div class="activity-icon"><FileText :size="15" /></div>
        <div><strong>{{ item.student_name }} · {{ item.event_type }}</strong><span>{{ item.description }}</span></div>
        <time>{{ item.occurred_at }}</time>
      </router-link>
    </section>

    <section class="card ds-card dashboard-quick-actions-card">
      <div class="card-title">快捷操作</div>
      <div class="toolbar dashboard-quick-actions">
        <router-link to="/attendance" class="btn btn-primary ds-button"><ClipboardList :size="14" /> 开始点名</router-link>
        <button class="btn btn-outline ds-button" @click="modalMode = 'event'"><FileText :size="14" /> 记录学生事件</button>
        <button class="btn btn-outline ds-button" @click="modalMode = 'comm'"><Phone :size="14" /> 家校沟通</button>
        <button class="btn btn-outline ds-button" @click="modalMode = 'focus'"><Tag :size="14" /> 添加关注</button>
        <router-link to="/scores" class="btn btn-outline ds-button"><TrendingUp :size="14" /> 查看成绩</router-link>
      </div>
    </section>

    <QuickRecordModal v-if="modalMode" :mode="modalMode" :business-date="stats.date" @success="finishRecord" @close="modalMode = null" />
  </div>
  <div v-else class="loading">正在加载今日工作台…</div>
</template>

<style scoped>
.dashboard-page { display: grid; gap: var(--ds-space-6); color: var(--ds-color-ink); }
.dashboard-page .page-title-bar { margin-bottom: 0; }
.dashboard-toolbar { margin-bottom: 0; }
.dashboard-page .card { margin: 0; padding: var(--ds-space-6); box-shadow: none; }
.dashboard-page .card-title { margin-bottom: var(--ds-space-4); color: var(--ds-color-ink); font: var(--ds-type-section); letter-spacing: -.015em; }
.dashboard-page .card-title::before { display: none; }
.dashboard-page .count { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.dashboard-page .card-action { color: var(--ds-color-primary); font: var(--ds-type-label); }
.dashboard-page .empty-state { color: var(--ds-color-ink-secondary); font: var(--ds-type-body); }
.dashboard-more-actions { position: relative; }
.dashboard-more-actions summary { list-style: none; cursor: pointer; }
.dashboard-more-actions summary::-webkit-details-marker { display: none; }
.dashboard-more-menu { position: absolute; z-index: 5; top: calc(100% + var(--ds-space-2)); right: 0; display: grid; min-width: 152px; padding: var(--ds-space-2); border-radius: var(--ds-radius-control); background: var(--ds-color-surface); box-shadow: var(--ds-shadow-raised); }
.dashboard-more-menu button { display: flex; align-items: center; gap: var(--ds-space-2); min-height: 36px; padding: 0 var(--ds-space-3); border: 0; border-radius: var(--ds-radius-sm); color: var(--ds-color-ink); background: transparent; cursor: pointer; font: var(--ds-type-label); text-align: left; }
.dashboard-more-menu button:hover { background: var(--ds-color-primary-soft); color: var(--ds-color-primary-hover); }
.action-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--ds-space-3); }
.action-summary-card { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--ds-space-2) var(--ds-space-3); min-height: 98px; padding: var(--ds-space-4) 18px; border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-card); background: var(--ds-color-surface); color: var(--ds-color-ink-secondary); text-decoration: none; transition: border-color var(--ds-duration-fast) var(--ds-ease-out), background-color var(--ds-duration-fast) var(--ds-ease-out); }
.action-summary-card:hover { border-color: var(--ds-color-primary-border); background: var(--ds-color-surface-subtle); }
.action-summary-card > svg { grid-row: 1 / span 2; color: var(--ds-color-primary); }
.action-summary-card span { color: var(--ds-color-ink-secondary); font: var(--ds-type-label); }
.action-summary-card strong { color: var(--ds-color-ink); font: var(--ds-type-metric); font-variant-numeric: tabular-nums; }
.action-summary-card small { color: var(--ds-color-ink-muted); font: var(--ds-type-meta); }
.action-summary-card.danger { border-color: var(--ds-color-danger-border); background: var(--ds-color-danger-soft); }
.action-summary-card.danger > svg, .action-summary-card.danger strong { color: var(--ds-color-danger); }
.action-summary-card.primary { border-color: var(--ds-color-primary-border); background: var(--ds-color-primary-soft); }
.attendance-summary-card { border-color: var(--ds-color-success-border); background: var(--ds-color-success-soft); }
.attendance-summary-card > svg, .attendance-summary-card strong { color: var(--ds-color-success); }
.action-board { padding: var(--ds-space-6); border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-card); background: var(--ds-color-surface); }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--ds-space-4); margin-bottom: var(--ds-space-4); }
.section-heading h2 { margin: 0; }
.section-heading p { margin: var(--ds-space-1) 0 0; }
.section-heading > a, .column-more { display: inline-flex; align-items: center; gap: var(--ds-space-1); color: var(--ds-color-primary); font: var(--ds-type-label); text-decoration: none; }
.action-columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--ds-space-3); }
.action-columns-compact { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.action-column { min-width: 0; padding: var(--ds-space-4); border-radius: var(--ds-radius-control); background: var(--ds-color-surface-subtle); }
.action-column.danger, .action-column.primary { background: var(--ds-color-surface-subtle); }
.action-column > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-bottom: 10px; }
.action-column header > div { display: grid; gap: 2px; min-width: 0; }
.action-column header strong { color: var(--ds-color-ink); font: var(--ds-type-title); }
.action-column header span { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.action-column header em { display: grid; place-items: center; min-width: 28px; height: 28px; border-radius: var(--ds-radius-sm); background: var(--ds-color-surface); color: var(--ds-color-ink); font: var(--ds-type-label); font-style: normal; font-variant-numeric: tabular-nums; }
.action-column.danger header em { background: var(--ds-color-danger-soft); color: var(--ds-color-danger); }
.action-column.primary header em { background: var(--ds-color-primary-soft); color: var(--ds-color-primary-hover); }
.dashboard-task { display: grid; gap: var(--ds-space-2); padding: var(--ds-space-3) 0; border-top: 1px solid color-mix(in srgb, var(--ds-color-border) 82%, transparent); }
.dashboard-task-copy { display: grid; gap: 3px; min-width: 0; }
.dashboard-task-copy strong { overflow: hidden; color: var(--ds-color-ink); font: var(--ds-type-title); text-overflow: ellipsis; white-space: nowrap; }
.dashboard-task-copy span { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.dashboard-task-actions { display: flex; gap: 5px; }
.dashboard-task-actions a { display: inline-flex; min-height: 32px; box-sizing: border-box; align-items: center; gap: 2px; padding: 5px var(--ds-space-2); border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-sm); background: var(--ds-color-surface); color: var(--ds-color-ink-secondary); font: var(--ds-type-label); text-decoration: none; }
.dashboard-task-actions a:hover { border-color: var(--ds-color-primary-border); color: var(--ds-color-primary-hover); }
.dashboard-task-actions a:last-child { margin-left: auto; border-color: transparent; background: transparent; color: var(--ds-color-primary); }
.action-empty { padding: var(--ds-space-6) var(--ds-space-1); border-top: 1px solid var(--ds-color-border); color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); text-align: center; }
.column-more { justify-content: center; margin-top: var(--ds-space-2); padding-top: var(--ds-space-3); border-top: 1px solid var(--ds-color-border); }
.dashboard-calendar-card { background: var(--ds-color-surface); }
.dashboard-calendar-heading { align-items: center; margin-bottom: var(--ds-space-4); }
.dashboard-calendar-heading h2 { display: flex; align-items: center; gap: 7px; }
.dashboard-calendar-heading > a { display: inline-flex; align-items: center; gap: var(--ds-space-1); color: var(--ds-color-primary); font: var(--ds-type-label); text-decoration: none; }
.dashboard-calendar-layout { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(240px, .55fr); grid-template-rows: 520px; gap: var(--ds-space-4); align-items: stretch; }
.dashboard-calendar-month { min-width: 0; height: 100%; }
.dashboard-calendar-component :deep(.fc) { --fc-border-color: var(--ds-color-border); --fc-today-bg-color: var(--ds-color-primary-soft); color: var(--ds-color-ink); font: var(--ds-type-meta); }
.dashboard-calendar-component :deep(.fc-scrollgrid) { border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-control); overflow: hidden; }
.dashboard-calendar-component :deep(.fc-col-header-cell) { background: var(--ds-color-surface-subtle); }
.dashboard-calendar-component :deep(.fc-col-header-cell-cushion) { padding: 8px 4px; color: var(--ds-color-ink-secondary); font: var(--ds-type-label); text-decoration: none; }
.dashboard-calendar-component :deep(.fc-daygrid-day-frame) { min-height: 76px; padding: 3px; }
.dashboard-calendar-component :deep(.fc-daygrid-day-number) { padding: 4px 5px; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); text-decoration: none; }
.dashboard-calendar-component :deep(.fc-day-other .fc-daygrid-day-number) { color: var(--ds-color-ink-muted); }
.dashboard-calendar-component :deep(.fc-day-today .fc-daygrid-day-number) { color: var(--ds-color-primary-hover); font-weight: 700; }
.dashboard-calendar-component :deep(.fc-daygrid-event) { margin: 2px 3px; padding: 2px 4px; border: 0; border-radius: var(--ds-radius-sm); font: var(--ds-type-meta); line-height: 1.3; cursor: pointer; }
.dashboard-calendar-component :deep(.dashboard-calendar-school) { --fc-event-bg-color: var(--ds-color-primary-soft); --fc-event-border-color: var(--ds-color-primary-soft); --fc-event-text-color: var(--ds-color-primary-hover); background: var(--ds-color-primary-soft); color: var(--ds-color-primary-hover); }
.dashboard-calendar-component :deep(.dashboard-calendar-holiday) { --fc-event-bg-color: var(--ds-color-danger-soft); --fc-event-border-color: var(--ds-color-danger-soft); --fc-event-text-color: var(--ds-color-danger); background: var(--ds-color-danger-soft); color: var(--ds-color-danger); }
.dashboard-calendar-component :deep(.dashboard-calendar-task) { --fc-event-bg-color: var(--ds-color-success-soft); --fc-event-border-color: var(--ds-color-success-soft); --fc-event-text-color: var(--ds-color-success); background: var(--ds-color-success-soft); color: var(--ds-color-success); }
.dashboard-calendar-component :deep(.fc-event-main) { color: inherit; }
.dashboard-calendar-component :deep(.dashboard-calendar-holiday-cell) { background: var(--ds-color-danger-soft); }
.dashboard-day-detail { display: grid; align-content: start; gap: var(--ds-space-2); min-width: 0; height: 100%; max-height: 100%; box-sizing: border-box; overflow-y: auto; padding: var(--ds-space-4); border-radius: var(--ds-radius-control); background: var(--ds-color-surface-subtle); }
.dashboard-day-title { display: flex; align-items: baseline; justify-content: space-between; gap: var(--ds-space-2); padding-bottom: var(--ds-space-2); border-bottom: 1px solid var(--ds-color-border); }
.dashboard-day-title strong { font: var(--ds-type-title); }
.dashboard-day-title span { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.dashboard-day-school { display: flex; align-items: center; justify-content: space-between; gap: var(--ds-space-2); padding: 9px var(--ds-space-3); border-radius: var(--ds-radius-control); background: var(--ds-color-primary-soft); color: var(--ds-color-primary-hover); font: var(--ds-type-label); }
.dashboard-day-school.holiday { background: var(--ds-color-danger-soft); color: var(--ds-color-danger); }
.dashboard-day-school small { font: var(--ds-type-meta); }
.dashboard-day-task { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 6px; padding: var(--ds-space-2) 0; border-top: 1px solid var(--ds-color-border); color: var(--ds-color-ink); text-decoration: none; }
.dashboard-day-task span { overflow: hidden; font: var(--ds-type-label); text-overflow: ellipsis; white-space: nowrap; }
.dashboard-day-task small { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.dashboard-day-task svg { grid-column: 2; grid-row: 1 / span 2; align-self: center; color: var(--ds-color-primary); }
.dashboard-upcoming { display: grid; gap: var(--ds-space-2); margin-top: var(--ds-space-4); padding-top: var(--ds-space-4); border-top: 1px solid var(--ds-color-border); }
.dashboard-upcoming-title { display: flex; align-items: center; gap: 7px; }
.dashboard-upcoming-title span { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.dashboard-upcoming-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: center; gap: var(--ds-space-3); padding: var(--ds-space-2) var(--ds-space-3); border-radius: var(--ds-radius-control); background: var(--ds-color-surface-subtle); color: var(--ds-color-ink); text-decoration: none; }
.dashboard-upcoming-row:hover { background: var(--ds-color-primary-soft); }
.dashboard-upcoming-date { display: grid; justify-items: center; gap: 2px; color: var(--ds-color-primary-hover); }
.dashboard-upcoming-date strong { font-size: 15px; line-height: 1; }
.dashboard-upcoming-date small, .dashboard-upcoming-copy small { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.dashboard-upcoming-copy { display: grid; gap: 3px; min-width: 0; }
.dashboard-upcoming-copy strong { overflow: hidden; font: var(--ds-type-label); text-overflow: ellipsis; white-space: nowrap; }
.dashboard-upcoming-row > svg { color: var(--ds-color-primary); }
.operational-grid { align-items: stretch; }
.operational-card { margin: 0; }
.compact-action-row, .material-row { display: grid; align-items: center; gap: var(--ds-space-2); padding: var(--ds-space-3) 0; border-top: 1px solid var(--ds-color-border); color: var(--ds-color-ink); text-decoration: none; }
.compact-action-row { grid-template-columns: minmax(0, 1fr) auto; }
.compact-action-row > div, .material-copy { display: grid; gap: 3px; min-width: 0; }
.compact-action-row strong, .material-row strong { font: var(--ds-type-title); }
.compact-action-row span, .material-row span { overflow: hidden; color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); text-overflow: ellipsis; white-space: nowrap; }
.material-row { grid-template-columns: minmax(0, 1fr) 76px 34px; }
.material-progress { height: 6px; overflow: hidden; border-radius: var(--ds-radius-pill); background: var(--ds-color-surface-sunken); }
.material-progress i { display: block; height: 100%; border-radius: inherit; background: var(--ds-color-success); transform-origin: left center; }
.material-row em { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); font-style: normal; text-align: right; }
.linked-row { color: inherit; text-decoration: none; }
.class-snapshot { margin: 0; }
.snapshot-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.snapshot-grid a { display: grid; gap: var(--ds-space-1); padding: var(--ds-space-3); border-radius: var(--ds-radius-control); background: var(--ds-color-surface-subtle); color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); text-decoration: none; }
.snapshot-grid strong { color: var(--ds-color-ink); font: var(--ds-type-section); font-variant-numeric: tabular-nums; }
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
  .dashboard-page { gap: var(--ds-space-4); }
  .dashboard-page .card { padding: var(--ds-space-4); }
  .action-summary { gap: var(--ds-space-2); }
  .action-summary-card { grid-template-columns: minmax(0, 1fr) auto; min-height: 88px; padding: var(--ds-space-3); gap: var(--ds-space-1) var(--ds-space-2); }
  .action-summary-card > svg { display: none; }
  .action-summary-card span, .action-summary-card strong { white-space: nowrap; }
  .action-summary-card small { grid-column: 1 / -1; }
  .action-summary-card strong { font-size: 23px; }
  .action-board { padding: var(--ds-space-4); }
  .section-heading { align-items: flex-start; }
  .section-heading p { display: block; }
  .dashboard-calendar-card { padding: var(--ds-space-4); }
  .material-row { grid-template-columns: minmax(0, 1fr) 60px 30px; }
}
</style>
