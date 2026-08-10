<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  CalendarDays, CheckCircle, ClipboardList, ExternalLink,
  List as ListIcon, Pencil, Plus, RotateCcw, Search, Trash2, XCircle
} from 'lucide-vue-next'
import { del, get, put } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'

const router = useRouter()
const route = useRoute()
const tasks = ref([])
const summary = ref({})
const loading = ref(true)
const error = ref('')
const showAdd = ref(false)
const editing = ref(null)
const saving = ref(false)
const editError = ref('')
const dialog = ref(null)
let returnFocus = null
const bucket = ref('open')
const query = ref('')
const view = ref('list')
let handledRouteAction = ''

const filters = [
  { key: 'open', label: '待处理' },
  { key: 'overdue', label: '已逾期' },
  { key: 'today', label: '今天' },
  { key: 'next7', label: '未来 7 天' },
  { key: 'completed', label: '已完成' },
  { key: 'cancelled', label: '已取消' },
  { key: 'all', label: '全部' }
]

const calendarGroups = computed(() => {
  const grouped = new Map()
  for (const task of tasks.value) {
    const key = task.calendar_date || '未安排日期'
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(task)
  }
  return [...grouped.entries()].map(([date, items]) => ({ date, items }))
})

async function load() {
  loading.value = true
  error.value = ''
  const params = new URLSearchParams({ bucket: bucket.value, limit: '1000' })
  if (query.value.trim()) params.set('q', query.value.trim())
  try {
    const taskData = await get(`/api/tasks?${params}`)
    const summaryData = await get('/api/tasks/summary')
    tasks.value = taskData.tasks || []
    summary.value = summaryData.summary || {}
    openTaskFromRoute()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function selectBucket(key) {
  router.push({ path: '/tasks', query: { bucket: key } })
}

function openEditor(task, status = task.status, action = '') {
  returnFocus = document.activeElement
  editError.value = ''
  editing.value = {
    id: task.id,
    title: task.title,
    owner: task.owner || '班主任',
    priority: task.priority,
    scheduled_at: (task.scheduled_at || '').slice(0, 10),
    due_at: (task.due_at || '').slice(0, 10),
    status,
    notes: task.notes || '',
    result: status === task.status ? (task.result || '') : ''
  }
  if (action === 'postpone') {
    let base = new Date(`${editing.value.due_at || editing.value.scheduled_at || localDate()}T12:00:00`)
    if (Number.isNaN(base.getTime())) base = new Date()
    base.setDate(base.getDate() + 7)
    editing.value.due_at = localDate(base)
  }
  nextTick(() => dialog.value?.focus())
}

function localDate(value = new Date()) {
  const pad = item => String(item).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function routeBucket() {
  const value = String(route.query.bucket || 'open')
  return filters.some(item => item.key === value) ? value : 'open'
}

function openTaskFromRoute() {
  const taskId = Number(route.query.task || 0)
  if (!taskId) return
  const action = String(route.query.action || 'edit')
  const key = `${taskId}:${action}`
  if (handledRouteAction === key) return
  const task = tasks.value.find(item => item.id === taskId)
  if (!task) return
  handledRouteAction = key
  const status = action === 'complete' ? '已完成' : task.status
  openEditor(task, status, action)
}

function closeEditor() {
  if (saving.value) return
  editing.value = null
  nextTick(() => returnFocus?.focus?.())
}

function trapFocus(event) {
  const nodes = [...(dialog.value?.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])') || [])]
    .filter(node => !node.disabled)
  if (!nodes.length) return
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function saveTask() {
  if (!editing.value) return
  editError.value = ''
  if (!editing.value.title.trim()) {
    editError.value = '请填写工作项标题'
    return
  }
  if (['已完成', '已取消'].includes(editing.value.status) && !editing.value.result.trim()) {
    editError.value = editing.value.status === '已完成' ? '请填写处理结果' : '请填写取消原因'
    return
  }
  saving.value = true
  try {
    await put(`/api/tasks/${editing.value.id}`, editing.value)
    editing.value = null
    await load()
    nextTick(() => returnFocus?.focus?.())
  } catch (e) {
    editError.value = e.message
  } finally {
    saving.value = false
  }
}

async function removeTask(task) {
  if (!confirm(`删除工作项“${task.title}”并移入回收站吗？`)) return
  await del(`/api/records/work_item/${task.id}`)
  await load()
}

function goSource(task) {
  if (task.source_path) router.push(task.source_path)
}

function displayDate(value) {
  if (!value) return '未安排日期'
  const text = String(value).slice(0, 10)
  const [, month, day] = text.split('-')
  return month && day ? `${Number(month)}月${Number(day)}日` : text
}

onMounted(() => {
  bucket.value = routeBucket()
  load()
})

watch(() => [route.query.bucket, route.query.task, route.query.action], async () => {
  const nextBucket = routeBucket()
  if (nextBucket !== bucket.value) {
    bucket.value = nextBucket
    await load()
  } else {
    openTaskFromRoute()
  }
})
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div>
        <div class="page-title">待办跟进</div>
        <div class="page-subtitle">汇总需要推进的下一步行动，完成后记录结果</div>
      </div>
      <button class="btn btn-primary" @click="showAdd = true"><Plus :size="14" /> 新建工作项</button>
    </div>

    <div class="work-summary" aria-label="工作项筛选">
      <button
        v-for="item in filters" :key="item.key" type="button"
        class="work-summary-card" :class="{ active: bucket === item.key, danger: item.key === 'overdue' && summary[item.key] }"
        @click="selectBucket(item.key)"
      >
        <span>{{ item.label }}</span><strong>{{ summary[item.key] || 0 }}</strong>
      </button>
    </div>

    <div class="work-toolbar">
      <form class="work-search" @submit.prevent="load">
        <Search :size="15" />
        <input v-model="query" aria-label="搜索工作项" placeholder="搜索事项、学生或备注" />
        <button type="submit">搜索</button>
      </form>
      <div class="view-switch" aria-label="视图切换">
        <button :class="{ active: view === 'list' }" @click="view = 'list'"><ListIcon :size="14" /> 列表</button>
        <button :class="{ active: view === 'calendar' }" @click="view = 'calendar'"><CalendarDays :size="14" /> 日历</button>
      </div>
    </div>

    <div v-if="error" class="inline-message error-text">{{ error }}</div>
    <div class="card work-card">
      <div class="card-title"><ClipboardList :size="16" /> {{ filters.find(item => item.key === bucket)?.label }} <span class="count">{{ tasks.length }}</span></div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!tasks.length" class="work-empty">
        <ClipboardList :size="28" />
        <strong>这个范围内没有工作项</strong>
        <span>可新建工作项，或从事件、沟通、关注、考勤、班级任务和值日中自动生成。</span>
        <button class="btn btn-primary" @click="showAdd = true"><Plus :size="14" /> 新建工作项</button>
      </div>

      <div v-else-if="view === 'list'" class="work-list">
        <article v-for="task in tasks" :key="task.id" class="work-row" :class="{ closed: ['已完成', '已取消'].includes(task.status) }">
          <div class="work-state" :class="task.timing_state === '已逾期' ? 'overdue' : ''">
            <span></span>{{ task.timing_state }}
          </div>
          <div class="work-copy">
            <div class="work-title-line">
              <strong>{{ task.title }}</strong>
              <span class="tag" :class="task.priority === '紧急' ? 'tag-red' : task.priority === '重要' ? 'tag-orange' : ''">{{ task.priority }}</span>
            </div>
            <div class="work-meta">
              <span>{{ task.student_name || '班级事务' }}</span>
              <span v-if="task.source_path" class="work-source"><span class="work-source-label">来源：</span><button type="button" @click="goSource(task)">{{ task.source_label }} <ExternalLink :size="11" /></button></span>
              <span v-else><span class="work-source-label">来源：</span>{{ task.source_label }}</span>
              <span>负责人：{{ task.owner || '班主任' }}</span>
              <span>截止：{{ displayDate(task.due_at) }}</span>
            </div>
            <p v-if="task.result" class="work-result">处理结果：{{ task.result }}</p>
          </div>
          <div class="work-actions">
            <button v-if="!['已完成', '已取消'].includes(task.status)" class="work-complete" @click="openEditor(task, '已完成')"><CheckCircle :size="15" /> 完成</button>
            <button v-else class="work-reopen" @click="openEditor(task, '处理中')"><RotateCcw :size="14" /> 重新打开</button>
            <button class="work-edit" aria-label="编辑工作项" @click="openEditor(task)"><Pencil :size="15" /></button>
            <button class="work-edit" aria-label="删除工作项" @click="removeTask(task)"><Trash2 :size="15" /></button>
          </div>
        </article>
      </div>

      <div v-else class="work-calendar">
        <section v-for="group in calendarGroups" :key="group.date" class="calendar-day">
          <div class="calendar-date"><CalendarDays :size="15" /><strong>{{ displayDate(group.date) }}</strong><span>{{ group.items.length }} 项</span></div>
          <button v-for="task in group.items" :key="task.id" class="calendar-item" @click="openEditor(task)">
            <span :class="{ overdue: task.timing_state === '已逾期' }"></span>
            <div><strong>{{ task.title }}</strong><small>{{ task.student_name || '班级事务' }} · 来源：{{ task.source_label }}</small></div>
            <em>{{ task.status }}</em>
          </button>
        </section>
      </div>
    </div>

    <QuickRecordModal v-if="showAdd" mode="task" @success="showAdd = false; load()" @close="showAdd = false" />

    <Teleport to="body">
      <div v-if="editing" class="modal-overlay show work-modal-overlay" @click.self="closeEditor" @keydown.esc="closeEditor">
        <section ref="dialog" class="modal work-edit-modal" role="dialog" aria-modal="true" aria-labelledby="work-edit-title" tabindex="-1" @keydown.tab="trapFocus">
          <div class="modal-kicker">工作项处理</div>
          <h3 id="work-edit-title">{{ editing.status === '已完成' ? '完成工作项' : editing.status === '已取消' ? '取消工作项' : '编辑工作项' }}</h3>
          <div class="form-group"><label>事项</label><input v-model="editing.title" class="form-input" /></div>
          <div class="form-row">
            <div class="form-group"><label>状态</label><select v-model="editing.status" class="form-select"><option>待处理</option><option>处理中</option><option>待复查</option><option>已完成</option><option>已取消</option></select></div>
            <div class="form-group"><label>优先级</label><select v-model="editing.priority" class="form-select"><option>普通</option><option>重要</option><option>紧急</option></select></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>计划日期</label><input v-model="editing.scheduled_at" type="date" class="form-input" /></div>
            <div class="form-group"><label>截止日期</label><input v-model="editing.due_at" type="date" class="form-input" /></div>
          </div>
          <div class="form-group"><label>负责人</label><input v-model="editing.owner" class="form-input" /></div>
          <div class="form-group"><label>备注</label><textarea v-model="editing.notes" class="form-textarea" rows="2"></textarea></div>
          <div v-if="['已完成', '已取消'].includes(editing.status)" class="form-group">
            <label>{{ editing.status === '已完成' ? '处理结果' : '取消原因' }}</label>
            <textarea v-model="editing.result" class="form-textarea" rows="3" :placeholder="editing.status === '已完成' ? '说明做了什么、结果如何' : '说明为什么不再处理'"></textarea>
          </div>
          <div v-if="editError" class="error-text">{{ editError }}</div>
          <div class="modal-actions">
            <button v-if="!['已完成', '已取消'].includes(editing.status)" type="button" class="btn btn-outline work-cancel-action" @click="editing.status = '已取消'; editing.result = ''"><XCircle :size="14" /> 取消此项</button>
            <span></span>
            <button type="button" class="btn btn-outline" @click="closeEditor">关闭</button>
            <button type="button" class="btn btn-primary" :disabled="saving" @click="saveTask">{{ saving ? '保存中…' : '保存' }}</button>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.work-summary { display: grid; grid-template-columns: repeat(7, minmax(96px, 1fr)); gap: 9px; margin-bottom: 14px; overflow-x: auto; padding-bottom: 2px; }
.work-summary-card { display: flex; min-width: 96px; align-items: center; justify-content: space-between; padding: 12px 13px; border: 1px solid var(--border); border-radius: 13px; background: var(--surface); color: var(--text-secondary); cursor: pointer; font: inherit; font-size: 12px; }
.work-summary-card strong { color: var(--text); font-size: 18px; }
.work-summary-card.active { border-color: var(--primary); background: var(--primary-light); color: var(--primary); box-shadow: 0 4px 14px rgba(75,85,181,.1); }
.work-summary-card.danger strong { color: var(--danger); }
.work-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.work-search { display: flex; min-width: min(360px, 100%); align-items: center; gap: 8px; padding: 0 5px 0 12px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface); color: var(--text-secondary); }
.work-search input { min-width: 0; flex: 1; height: 38px; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; }
.work-search button { border: 0; border-radius: 8px; padding: 6px 10px; background: var(--bg); color: var(--text-secondary); cursor: pointer; }
.view-switch { display: flex; padding: 3px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.view-switch button { display: inline-flex; align-items: center; gap: 5px; border: 0; border-radius: 7px; padding: 7px 10px; background: transparent; color: var(--text-secondary); cursor: pointer; }
.view-switch button.active { background: var(--primary-light); color: var(--primary); }
.work-card { padding: 18px; }
.work-list { display: grid; }
.work-row { display: grid; grid-template-columns: 82px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 15px 4px; border-top: 1px solid var(--border-light); }
.work-row:first-child { border-top: 0; }
.work-row.closed { opacity: .72; }
.work-state { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 11px; }
.work-state span { width: 8px; height: 8px; border-radius: 50%; background: #70c58b; }
.work-state.overdue { color: var(--danger); }
.work-state.overdue span { background: var(--danger); }
.work-copy { min-width: 0; }
.work-title-line { display: flex; align-items: center; gap: 8px; }
.work-title-line strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.work-meta { display: flex; flex-wrap: wrap; gap: 5px 12px; margin-top: 6px; color: var(--text-secondary); font-size: 11px; }
.work-source { display: inline-flex; align-items: center; gap: 2px; }
.work-source-label { color: var(--text-tertiary); }
.work-meta button { display: inline-flex; align-items: center; gap: 3px; border: 0; padding: 0; background: transparent; color: var(--primary); cursor: pointer; font: inherit; }
.work-result { margin: 7px 0 0; color: var(--text-secondary); font-size: 12px; }
.work-actions { display: flex; align-items: center; gap: 6px; }
.work-actions button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: 9px; padding: 7px 9px; background: var(--surface); color: var(--text-secondary); cursor: pointer; }
.work-actions .work-complete { border-color: #bfe8ca; color: #208344; }
.work-actions .work-edit { padding: 7px; }
.work-empty { display: grid; justify-items: center; gap: 8px; padding: 56px 20px; color: var(--text-secondary); text-align: center; }
.work-empty strong { color: var(--text); }
.work-empty span { max-width: 520px; font-size: 12px; }
.work-empty .btn { margin-top: 8px; }
.work-calendar { display: grid; gap: 18px; }
.calendar-day { display: grid; gap: 7px; }
.calendar-date { display: flex; align-items: center; gap: 7px; padding: 0 3px 5px; color: var(--text-secondary); }
.calendar-date strong { color: var(--text); font-size: 13px; }
.calendar-date span { font-size: 11px; }
.calendar-item { display: grid; grid-template-columns: 8px 1fr auto; align-items: center; gap: 10px; width: 100%; border: 1px solid var(--border-light); border-radius: 11px; padding: 10px 12px; background: var(--surface); color: var(--text); text-align: left; cursor: pointer; }
.calendar-item > span { width: 7px; height: 7px; border-radius: 50%; background: #70c58b; }
.calendar-item > span.overdue { background: var(--danger); }
.calendar-item div { display: grid; gap: 3px; }
.calendar-item small { color: var(--text-secondary); }
.calendar-item em { color: var(--text-secondary); font-size: 11px; font-style: normal; }
.work-modal-overlay { z-index: 1000; }
.work-edit-modal { width: min(620px, calc(100vw - 28px)); }
.work-edit-modal:focus { outline: none; }
.work-edit-modal .modal-actions { display: grid; grid-template-columns: auto 1fr auto auto; }
.work-cancel-action { color: var(--danger); }
@media (max-width: 760px) {
  .work-summary { grid-template-columns: repeat(7, 112px); }
  .work-toolbar { align-items: stretch; flex-direction: column; }
  .work-search { width: 100%; }
  .view-switch { align-self: flex-end; }
  .work-row { grid-template-columns: 1fr auto; gap: 9px; }
  .work-state { grid-column: 1 / -1; }
  .work-actions { align-self: start; }
  .work-actions .work-complete, .work-actions .work-reopen { font-size: 0; }
  .work-actions .work-complete svg, .work-actions .work-reopen svg { width: 17px; height: 17px; }
  .work-edit-modal .modal-actions { grid-template-columns: 1fr 1fr; }
  .work-edit-modal .modal-actions span { display: none; }
}
</style>
