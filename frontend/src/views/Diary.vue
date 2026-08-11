<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Link2, Pencil, Plus, Trash2 } from 'lucide-vue-next'
import FullCalendar from '@fullcalendar/vue3'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin from '@fullcalendar/interaction'
import zhCnLocale from '@fullcalendar/core/locales/zh-cn'
import { del, get, post, put } from '../api'
import { useConfirmDialog } from '../composables/confirmDialog'

const businessDate = ref(new Date().toISOString().slice(0, 10))
const month = ref(businessDate.value.slice(0, 7))
const entries = ref([])
const meetings = ref([])
const activities = ref([])
const events = ref([])
const tasks = ref([])
const students = ref([])
const selectedId = ref(null)
const calendarRef = ref(null)
const showForm = ref(false)
const editingId = ref(null)
const showAdvanced = ref(false)
const saving = ref(false)
const loading = ref(true)
const error = ref('')
const notice = ref('')
const form = reactive({ diary_date: `${month.value}-01`, weather: '', work: '', event: '', reflection: '', todo: '', link_type: '', link_id: '' })
const { confirm: confirmDialog } = useConfirmDialog()

const selected = computed(() => entries.value.find(item => item.id === selectedId.value) || null)
const selectedDayEntries = computed(() => selected.value ? entriesFor(selected.value.diary_date) : [])
const formTitle = computed(() => editingId.value ? '编辑日志' : '记录今天的事')
const calendarEvents = computed(() => entries.value.map(entry => ({
  id: String(entry.id), date: entry.diary_date, allDay: true,
  title: entry.work || entry.event || entry.reflection || '日志',
  classNames: ['diary-calendar-entry'], extendedProps: { entry },
})))
const calendarOptions = computed(() => ({
  plugins: [dayGridPlugin, interactionPlugin], locales: [zhCnLocale], locale: 'zh-cn',
  initialView: 'dayGridMonth', initialDate: `${month.value}-01`, firstDay: 1,
  fixedWeekCount: false, height: 'auto', dayMaxEvents: 2,
  headerToolbar: { left: 'prev', center: 'title', right: 'businessToday next' },
  customButtons: { businessToday: { text: '今天', click: () => calendarRef.value?.getApi().gotoDate(businessDate.value) } },
  events: calendarEvents.value,
  dateClick: ({ dateStr }) => openDay(dateStr),
  eventClick: ({ event }) => { selectedId.value = Number(event.id); showForm.value = false },
  datesSet: ({ view }) => {
    if (!runtimeLoaded) return
    const date = view.currentStart
    const nextMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    if (nextMonth !== month.value) { month.value = nextMonth; load() }
  },
}))

function entriesFor(day) { return entries.value.filter(item => item.diary_date === day) }
function openNew(date = businessDate.value) {
  editingId.value = null
  showAdvanced.value = false
  resetForm(date)
  showForm.value = true
  error.value = ''
}
function openDay(day) {
  if (!day) return
  const dayEntries = entriesFor(day)
  if (dayEntries.length) {
    selectedId.value = dayEntries[0].id
    showForm.value = false
    return
  }
  openNew(day)
}
async function load() {
  loading.value = true
  try {
    if (!runtimeLoaded) {
      const runtime = await get('/api/system/runtime')
      businessDate.value = runtime.business_date || businessDate.value
      month.value = businessDate.value.slice(0, 7)
      runtimeLoaded = true
      calendarRef.value?.getApi().gotoDate(businessDate.value)
    }
    const [diaryData, meetingData, activityData, studentData, eventData, taskData] = await Promise.all([
      get(`/api/education/diary?month=${month.value}`), get('/api/education/meetings'), get('/api/education/activities'), get('/api/students'), get('/api/events?limit=500'), get('/api/tasks?limit=500'),
    ])
    entries.value = diaryData.entries || []; meetings.value = meetingData.meetings || []; activities.value = activityData.activities || []; students.value = studentData.students || []; events.value = eventData.events || []; tasks.value = taskData.tasks || []
    if (!entries.value.some(item => item.id === selectedId.value)) selectedId.value = entries.value[0]?.id || null
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

let runtimeLoaded = false
function resetForm(date = businessDate.value) { Object.assign(form, { diary_date: date, weather: '', work: '', event: '', reflection: '', todo: '', link_type: '', link_id: '' }) }
function cancelForm() { showForm.value = false; editingId.value = null; showAdvanced.value = false; resetForm(); error.value = '' }
function editSelected() {
  if (!selected.value) return
  editingId.value = selected.value.id
  Object.assign(form, {
    diary_date: selected.value.diary_date, weather: selected.value.weather || '', work: selected.value.work || '',
    event: selected.value.event || '', reflection: selected.value.reflection || '', todo: selected.value.todo || '',
    link_type: selected.value.links?.[0]?.link_type || '', link_id: selected.value.links?.[0]?.link_id || selected.value.links?.[0]?.student_id || '',
  })
  showAdvanced.value = Boolean(form.event || form.reflection || form.todo || form.link_type)
  showForm.value = true
  error.value = ''
}
function linkOptions() { if (form.link_type === 'meeting') return meetings.value; if (form.link_type === 'activity') return activities.value; if (form.link_type === 'event') return events.value; if (form.link_type === 'work_item') return tasks.value; if (form.link_type === 'student') return students.value; return [] }
function linkLabel(item) { return item.topic || item.name || item.title || item.description || `${item.姓名} · ${item.学号}` }
function linkLabelFor(link) {
  if (link.label) return link.label
  if (link.link_type === 'student') {
    const student = students.value.find(item => String(item.id) === String(link.student_id || link.link_id))
    return student ? `${student.姓名} · ${student.学号}` : `学生 #${link.student_id || link.link_id}`
  }
  const source = linkOptionsFor(link.link_type).find(item => String(item.id) === String(link.link_id))
  return source ? linkLabel(source) : `${link.link_type} #${link.link_id}`
}
function linkOptionsFor(type) { if (type === 'meeting') return meetings.value; if (type === 'activity') return activities.value; if (type === 'event') return events.value; if (type === 'work_item') return tasks.value; return [] }

async function save() {
  if (!form.work.trim() && !form.event.trim() && !form.reflection.trim() && !form.todo.trim()) {
    error.value = '请至少填写一项日志内容。'
    return
  }
  saving.value = true
  error.value = ''
  try {
    const links = form.link_type && form.link_id ? [{ type: form.link_type, id: Number(form.link_id) }] : []
    const payload = {
      diary_date: form.diary_date, weather: form.weather, work: form.work,
      event: form.event, reflection: form.reflection, todo: form.todo, links,
    }
    const result = editingId.value ? await put(`/api/education/diary/${editingId.value}`, payload) : await post('/api/education/diary', payload)
    notice.value = editingId.value ? '日志已更新。' : '日志已保存。'
    selectedId.value = result.id
    showForm.value = false
    editingId.value = null
    showAdvanced.value = false
    resetForm()
    await load()
  } catch (e) { error.value = e.message } finally { saving.value = false }
}

async function removeEntry() {
  if (!selected.value || !(await confirmDialog({ title: '删除日志？', message: '记录会进入回收站。', confirmText: '移入回收站' }))) return
  try { await del(`/api/education/diary/${selected.value.id}`); selectedId.value = null; notice.value = '日志已移入回收站。'; await load() } catch (e) { error.value = e.message }
}

onMounted(load)
</script>

<template>
  <div class="diary-page">
    <div class="page-title-bar"><div><div class="page-title">班主任日志</div><div class="page-subtitle">记录班级日常，方便回看、补充和整理学期工作</div></div><button class="btn btn-primary" @click="showForm ? cancelForm() : openNew()"><Plus :size="14" /> {{ showForm ? '关闭记录' : '写日志' }}</button></div>
    <div v-if="notice" class="inline-message success-message">{{ notice }}</div><div v-if="error" class="inline-message error-message">{{ error }}</div>
    <div class="diary-layout">
      <div class="card calendar-card"><FullCalendar ref="calendarRef" class="diary-calendar-component" :options="calendarOptions" /></div>
      <div class="card diary-detail-card">
        <div v-if="loading" class="loading">加载中...</div>
        <template v-else-if="showForm">
          <div class="detail-form-header"><div><div class="card-title">{{ formTitle }}</div><div class="hint">{{ form.diary_date }}</div></div><button class="btn btn-sm btn-outline" @click="cancelForm">取消</button></div>
          <div class="detail-form-fields"><label>日期<input v-model="form.diary_date" type="date" class="form-input"></label><label>天气（可选）<select v-model="form.weather" class="form-select"><option value="">未记录</option><option>晴</option><option>多云</option><option>阴</option><option>雨</option><option>雪</option></select></label><label class="quick-diary-field">今天发生了什么<textarea v-model="form.work" class="form-input" rows="5" placeholder="记录今天最重要的工作"></textarea></label><button class="detail-toggle" type="button" @click="showAdvanced = !showAdvanced">{{ showAdvanced ? '收起详细记录' : '补充详细记录' }}</button><div v-if="showAdvanced" class="advanced-diary-fields"><label>关联类型<select v-model="form.link_type" class="form-select"><option value="">不关联</option><option value="student">学生</option><option value="event">学生事件</option><option value="work_item">待办</option><option value="meeting">班会</option><option value="activity">活动</option></select></label><label v-if="form.link_type">关联来源<select v-model="form.link_id" class="form-select"><option value="">请选择</option><option v-for="item in linkOptions()" :key="item.id" :value="item.id">{{ linkLabel(item) }}</option></select></label><label>突发事件<textarea v-model="form.event" class="form-input" rows="3"></textarea></label><label>今日反思<textarea v-model="form.reflection" class="form-input" rows="3"></textarea></label><label>待办事项<textarea v-model="form.todo" class="form-input" rows="3"></textarea></label></div></div>
          <div class="modal-actions"><button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : (editingId ? '保存修改' : '保存日志') }}</button></div>
        </template>
        <div v-else-if="!selected" class="empty-state"><strong>选择一个日期</strong><button class="btn btn-primary btn-sm" @click="openNew()"><Plus :size="13" /> 记录今天</button></div>
        <template v-else><div v-if="selectedDayEntries.length > 1" class="detail-entry-picker"><span>当天 {{ selectedDayEntries.length }} 条日志</span><button v-for="entry in selectedDayEntries" :key="entry.id" type="button" :class="{ active: entry.id === selectedId }" @click="selectedId = entry.id">{{ entry.work || entry.event || '日志' }}</button></div><div class="detail-header"><div><div class="card-title">{{ selected.diary_date }}</div><div class="hint">{{ selected.weather || '天气未记录' }} <span v-if="selected.legacy" class="status-pill warning">旧表迁移</span></div></div><div class="detail-actions"><button class="btn btn-sm btn-outline" @click="editSelected"><Pencil :size="13" /> 编辑</button><button class="btn btn-sm btn-danger" @click="removeEntry"><Trash2 :size="13" /> 删除</button></div></div><div class="detail-block"><h4>主要工作</h4><p>{{ selected.work || '未填写' }}</p></div><div class="detail-block"><h4>突发事件</h4><p>{{ selected.event || '未填写' }}</p></div><div class="detail-block"><h4>今日反思</h4><p>{{ selected.reflection || '未填写' }}</p></div><div class="detail-block"><h4>待办事项</h4><p>{{ selected.todo || '未填写' }}</p></div><div class="detail-block"><h4><Link2 :size="14" /> 来源关联</h4><div v-if="selected.links.length" class="link-list"><span v-for="link in selected.links" :key="link.id" class="chip">{{ linkLabelFor(link) }}</span></div><span v-else class="hint">暂无关联来源</span></div></template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diary-page{max-width:1180px;margin:0 auto}.diary-layout{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(320px,.8fr);gap:16px;margin-top:16px}.diary-calendar-component :deep(.fc){--fc-border-color:#d5d8df;--fc-today-bg-color:rgba(91,106,191,.08);color:var(--text);font-size:12px}.diary-calendar-component :deep(.fc-toolbar){margin-bottom:12px}.diary-calendar-component :deep(.fc-toolbar-title){font-size:15px}.diary-calendar-component :deep(.fc-button){border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text-secondary);box-shadow:none;font-size:12px}.diary-calendar-component :deep(.fc-button:hover),.diary-calendar-component :deep(.fc-button-primary:not(:disabled).fc-button-active){border-color:var(--primary);background:var(--primary-bg);color:var(--primary)}.diary-calendar-component :deep(.fc-scrollgrid){border:1px solid #d0d3da;border-radius:10px;overflow:hidden}.diary-calendar-component :deep(.fc-col-header-cell){background:#f1f2f5}.diary-calendar-component :deep(.fc-col-header-cell-cushion){padding:8px 4px;color:#626873;font-size:11px;font-weight:600;text-decoration:none}.diary-calendar-component :deep(.fc-daygrid-day-frame){min-height:82px;padding:3px}.diary-calendar-component :deep(.fc-daygrid-day-number){padding:4px 5px;color:#626873;font-size:11px;font-weight:500;text-decoration:none}.diary-calendar-component :deep(.fc-day-other .fc-daygrid-day-number){color:#9da2ab}.diary-calendar-component :deep(.fc-day-today .fc-daygrid-day-number){color:#4053a5;font-weight:700}.diary-calendar-component :deep(.fc-daygrid-event){margin:2px 3px;padding:2px 4px;border:0;border-radius:5px;background:#e4e9ff;color:#3f51a1;font-size:10px;line-height:1.25;cursor:pointer}.diary-calendar-component :deep(.fc-event-main){color:inherit}.detail-form-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px}.detail-form-fields{display:grid;gap:12px}.detail-form-fields>label{display:grid;gap:6px;color:var(--text-secondary);font-size:12px}.quick-diary-field{display:grid!important;margin-top:4px}.quick-diary-field textarea{margin-top:0}.detail-toggle{justify-self:start;border:0;background:none;color:var(--primary);padding:0;font-size:12px;cursor:pointer}.advanced-diary-fields{display:grid;gap:12px}.advanced-diary-fields>label{display:grid;gap:6px;color:var(--text-secondary);font-size:12px}.diary-detail-card{min-width:0}.empty-state{display:flex;flex-direction:column;align-items:center;gap:10px;padding:48px 20px;text-align:center;color:var(--text-tertiary)}.empty-state strong{color:var(--text-secondary);font-size:14px}.detail-entry-picker{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding-bottom:12px;margin-bottom:14px;border-bottom:1px solid var(--border);color:var(--text-tertiary);font-size:12px}.detail-entry-picker button{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--border);border-radius:8px;background:var(--bg-elevated);padding:5px 8px;color:var(--text-secondary);cursor:pointer}.detail-entry-picker button.active{border-color:var(--primary);background:var(--primary-bg);color:var(--primary)}.detail-header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.detail-actions{display:flex;gap:6px}.detail-block{padding:14px 0;border-bottom:1px solid var(--border)}.detail-block:last-child{border-bottom:0}.detail-block h4{display:flex;align-items:center;gap:5px;font-size:13px;margin-bottom:6px}.detail-block p{white-space:pre-wrap;color:var(--text-secondary);font-size:13px}.link-list{display:flex;gap:6px;flex-wrap:wrap}.chip{padding:4px 7px;border-radius:8px;background:var(--primary-bg);color:var(--primary);font-size:12px}.status-pill{margin-left:6px;padding:2px 6px;border-radius:8px;font-size:11px}.status-pill.warning{color:#9a6500;background:var(--warning-bg)}
@media(max-width:900px){.diary-layout{grid-template-columns:1fr}}@media(max-width:560px){.diary-calendar-component :deep(.fc-daygrid-day-frame){min-height:62px}.detail-actions{flex-direction:column}}
</style>
