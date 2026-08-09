<script setup>
import { computed, onMounted, ref } from 'vue'
import {
  AlertTriangle, ArrowRight, CalendarClock, CheckCircle, ClipboardList,
  FileText, Phone, Plus, ShieldCheck, Tag, TrendingUp, Upload, UserRound, Users
} from 'lucide-vue-next'
import { get, post, upload } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'

const stats = ref(null)
const errorMsg = ref('')
const modalMode = ref(null)
const fileInput = ref(null)
const backupMessage = ref('')

const actionSections = computed(() => stats.value ? [
  { key: 'overdue', title: '已经逾期', hint: '优先处理，避免继续积压', tone: 'danger', items: stats.value.work_sections.overdue },
  { key: 'today', title: '今天要做', hint: '计划或截止日期在今天', tone: 'primary', items: stats.value.work_sections.today },
  { key: 'next7', title: '即将到期', hint: '未来 7 天需要安排', tone: 'neutral', items: stats.value.work_sections.next7 },
] : [])

async function load() {
  errorMsg.value = ''
  try {
    stats.value = await get('/api/stats/dashboard')
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
        <button class="btn btn-primary" @click="modalMode = 'event'"><Plus :size="14" /> 快速记录</button>
        <button class="btn btn-outline" @click="backup"><ShieldCheck :size="14" /> 备份数据</button>
        <button class="btn btn-outline" @click="fileInput?.click()"><Upload :size="14" /> 恢复</button>
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
        <span>今天</span><strong>{{ stats.work_summary.today }}</strong>
        <small>计划今天推进</small>
      </router-link>
      <router-link :to="{ path: '/tasks', query: { bucket: 'next7' } }" class="action-summary-card">
        <CalendarClock :size="19" />
        <span>未来 7 天</span><strong>{{ stats.work_summary.next7 }}</strong>
        <small>提前安排时间</small>
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
        <div><h2 id="action-board-title">行动队列</h2><p>进入事项后可完成、延期或继续处理来源记录</p></div>
        <router-link to="/tasks">全部 {{ stats.work_summary.open }} 项 <ArrowRight :size="14" /></router-link>
      </div>
      <div class="action-columns">
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

    <div class="dashboard-grid operational-grid">
      <section class="card operational-card">
        <div class="card-title"><AlertTriangle :size="16" /> 考勤规则命中 <span class="count">{{ stats.rule_hit_count }}</span><router-link to="/attendance" class="card-action">查看规则 <ArrowRight :size="13" /></router-link></div>
        <div v-if="!stats.rule_hits.length" class="empty-state compact-empty">暂无待处理的考勤规则提醒</div>
        <router-link v-for="task in stats.rule_hits.slice(0, 5)" :key="task.id" :to="taskRoute(task)" class="compact-action-row">
          <div><strong>{{ task.student_name || '班级事务' }}</strong><span>{{ task.notes || task.title }}</span></div>
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
          <router-link to="/attendance"><span>今日出勤</span><strong>{{ stats.today_attendance['出勤'] }}</strong></router-link>
          <router-link to="/attendance"><span>迟到 / 缺勤</span><strong>{{ stats.today_attendance['迟到'] + stats.today_attendance['缺勤'] }}</strong></router-link>
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

    <section class="card">
      <div class="card-title">快捷操作</div>
      <div class="toolbar dashboard-quick-actions">
        <button class="btn btn-primary" @click="modalMode = 'event'"><FileText :size="14" /> 记录学生事件</button>
        <button class="btn btn-outline" @click="modalMode = 'comm'"><Phone :size="14" /> 家校沟通</button>
        <button class="btn btn-outline" @click="modalMode = 'focus'"><Tag :size="14" /> 添加关注</button>
        <router-link to="/attendance" class="btn btn-outline"><ClipboardList :size="14" /> 批量考勤</router-link>
        <router-link to="/scores" class="btn btn-outline"><TrendingUp :size="14" /> 查看成绩</router-link>
      </div>
    </section>

    <QuickRecordModal v-if="modalMode" :mode="modalMode" @success="finishRecord" @close="modalMode = null" />
  </div>
  <div v-else class="loading">正在加载今日工作台…</div>
</template>

<style scoped>
.dashboard-page { display: grid; gap: 16px; }
.dashboard-toolbar { margin-bottom: 0; }
.dashboard-page .card { box-shadow: none; }
.dashboard-page > section.card { padding: 2px 0; border: 0; margin-bottom: 0; background: transparent; }
.action-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.action-summary-card { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 5px 9px; min-height: 86px; padding: 15px 16px; border: 1px solid var(--border); border-radius: 15px; background: var(--surface); color: var(--text-secondary); text-decoration: none; box-shadow: var(--shadow-sm); }
.action-summary-card > svg { grid-row: 1 / span 2; color: var(--primary); }
.action-summary-card span { color: var(--text-secondary); font-size: 12px; }
.action-summary-card strong { color: var(--text); font-size: 25px; line-height: 1; }
.action-summary-card small { color: var(--text-tertiary); font-size: 11px; }
.action-summary-card.danger { border-color: rgba(220,64,54,.2); background: var(--danger-bg); }
.action-summary-card.danger > svg, .action-summary-card.danger strong { color: var(--danger); }
.action-summary-card.primary { border-color: rgba(91,106,191,.2); background: var(--primary-bg); }
.action-board { padding: 2px 0; border: 0; background: transparent; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 13px; }
.section-heading h2 { margin: 0; color: var(--text); font-size: 16px; }
.section-heading p { margin: 4px 0 0; color: var(--text-secondary); font-size: 12px; }
.section-heading > a, .column-more { display: inline-flex; align-items: center; gap: 4px; color: var(--primary); font-size: 12px; text-decoration: none; }
.action-columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
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
.dashboard-quick-actions { margin-bottom: 0; }
@media (max-width: 900px) {
  .action-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .action-columns { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .dashboard-toolbar { width: 100%; }
  .dashboard-toolbar .btn { flex: 1; justify-content: center; }
  .action-summary { gap: 8px; }
  .action-summary-card { min-height: 78px; padding: 12px; }
  .action-summary-card strong { font-size: 22px; }
  .action-board { padding: 14px; }
  .section-heading { align-items: center; }
  .section-heading p { display: none; }
  .material-row { grid-template-columns: minmax(0, 1fr) 60px 30px; }
}
</style>
