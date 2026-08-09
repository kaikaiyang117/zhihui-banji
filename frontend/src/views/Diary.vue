<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Calendar, Link2, Plus, Trash2 } from 'lucide-vue-next'
import { del, get, post } from '../api'

const month = ref(new Date().toISOString().slice(0, 7))
const entries = ref([])
const meetings = ref([])
const activities = ref([])
const events = ref([])
const tasks = ref([])
const students = ref([])
const selectedId = ref(null)
const showForm = ref(false)
const loading = ref(true)
const error = ref('')
const notice = ref('')
const form = reactive({ diary_date: `${month.value}-01`, weather: '', work: '', event: '', reflection: '', todo: '', link_type: '', link_id: '' })

const selected = computed(() => entries.value.find(item => item.id === selectedId.value) || null)
const monthTitle = computed(() => {
  const [year, value] = month.value.split('-')
  return `${year}年${Number(value)}月`
})
const calendarDays = computed(() => {
  const [year, value] = month.value.split('-').map(Number)
  const first = new Date(year, value - 1, 1)
  const offset = (first.getDay() + 6) % 7
  const total = new Date(year, value, 0).getDate()
  const days = Array.from({ length: offset }, () => null)
  for (let day = 1; day <= total; day += 1) days.push(`${year}-${String(value).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  while (days.length % 7) days.push(null)
  return days
})

function entriesFor(day) { return entries.value.filter(item => item.diary_date === day) }
function openDay(day) { if (day) { form.diary_date = day; showForm.value = true } }
function changeMonth(delta) {
  const [year, value] = month.value.split('-').map(Number)
  const date = new Date(year, value - 1 + delta, 1)
  month.value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  load()
}

async function load() {
  loading.value = true
  try {
    const [diaryData, meetingData, activityData, studentData, eventData, taskData] = await Promise.all([
      get(`/api/education/diary?month=${month.value}`), get('/api/education/meetings'), get('/api/education/activities'), get('/api/students'), get('/api/events?limit=500'), get('/api/tasks?limit=500'),
    ])
    entries.value = diaryData.entries || []; meetings.value = meetingData.meetings || []; activities.value = activityData.activities || []; students.value = studentData.students || []; events.value = eventData.events || []; tasks.value = taskData.tasks || []
    if (!selectedId.value && entries.value.length) selectedId.value = entries.value[0].id
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

function resetForm() { Object.assign(form, { diary_date: `${month.value}-01`, weather: '', work: '', event: '', reflection: '', todo: '', link_type: '', link_id: '' }) }
function linkOptions() { if (form.link_type === 'meeting') return meetings.value; if (form.link_type === 'activity') return activities.value; if (form.link_type === 'event') return events.value; if (form.link_type === 'work_item') return tasks.value; if (form.link_type === 'student') return students.value; return [] }
function linkLabel(item) { return item.topic || item.name || item.title || item.description || `${item.姓名} · ${item.学号}` }

async function save() {
  if (!form.work.trim() && !form.event.trim() && !form.reflection.trim() && !form.todo.trim()) return
  try {
    const links = form.link_type && form.link_id ? [{ type: form.link_type, id: Number(form.link_id) }] : []
    const result = await post('/api/education/diary', {
      diary_date: form.diary_date, weather: form.weather, work: form.work,
      event: form.event, reflection: form.reflection, todo: form.todo, links,
    })
    notice.value = '日志已保存。'; selectedId.value = result.id; showForm.value = false; resetForm(); await load()
  } catch (e) { error.value = e.message }
}

async function removeEntry() {
  if (!selected.value || !confirm('删除这条日志？记录会进入回收站。')) return
  try { await del(`/api/education/diary/${selected.value.id}`); selectedId.value = null; notice.value = '日志已移入回收站。'; await load() } catch (e) { error.value = e.message }
}

onMounted(load)
</script>

<template>
  <div class="diary-page">
    <div class="page-title-bar"><div><div class="page-title">班主任日志</div><div class="page-subtitle">用日历回看每天发生的事，并链接到班会、活动、学生和待办</div></div><button class="btn btn-primary" @click="showForm = !showForm"><Plus :size="14" /> 写日志</button></div>
    <div v-if="notice" class="inline-message success-message">{{ notice }}</div><div v-if="error" class="inline-message error-message">{{ error }}</div>
    <div v-if="showForm" class="card diary-form-card"><div class="card-title">写一篇日志</div><div class="form-grid diary-form-grid"><label>日期<input v-model="form.diary_date" type="date" class="form-input"></label><label>天气<select v-model="form.weather" class="form-select"><option value="">未记录</option><option>晴</option><option>多云</option><option>阴</option><option>雨</option><option>雪</option></select></label><label>关联类型<select v-model="form.link_type" class="form-select"><option value="">不关联</option><option value="student">学生</option><option value="event">学生事件</option><option value="work_item">待办</option><option value="meeting">班会</option><option value="activity">活动</option></select></label><label v-if="form.link_type">关联来源<select v-model="form.link_id" class="form-select"><option value="">请选择</option><option v-for="item in linkOptions()" :key="item.id" :value="item.id">{{ linkLabel(item) }}</option></select></label></div><div class="form-grid diary-text-grid"><label>主要工作<textarea v-model="form.work" class="form-input" rows="3"></textarea></label><label>突发事件<textarea v-model="form.event" class="form-input" rows="3"></textarea></label><label>今日反思<textarea v-model="form.reflection" class="form-input" rows="3"></textarea></label><label>待办事项<textarea v-model="form.todo" class="form-input" rows="3"></textarea></label></div><div class="modal-actions"><button class="btn btn-outline" @click="showForm = false">取消</button><button class="btn btn-primary" @click="save">保存日志</button></div></div>
    <div class="diary-layout"><div class="card calendar-card"><div class="calendar-head"><button class="btn btn-sm btn-outline" @click="changeMonth(-1)">‹</button><strong><Calendar :size="15" /> {{ monthTitle }}</strong><button class="btn btn-sm btn-outline" @click="changeMonth(1)">›</button></div><div class="weekday-row"><span v-for="day in ['一','二','三','四','五','六','日']" :key="day">周{{ day }}</span></div><div class="calendar-grid"><button v-for="(day, index) in calendarDays" :key="index" class="calendar-cell" :class="{ empty: !day, today: day === new Date().toISOString().slice(0, 10) }" :disabled="!day" @click="openDay(day)"><template v-if="day"><span class="calendar-day-number">{{ Number(day.slice(-2)) }}</span><span v-for="entry in entriesFor(day).slice(0, 2)" :key="entry.id" class="calendar-entry">{{ entry.work || entry.event || '日志' }}</span><span v-if="entriesFor(day).length > 2" class="calendar-more">+{{ entriesFor(day).length - 2 }}</span></template></button></div></div><div class="card diary-detail-card"><div v-if="loading" class="loading">加载中...</div><div v-else-if="!selected" class="empty-state">选择日历中的记录查看详情</div><template v-else><div class="detail-header"><div><div class="card-title">{{ selected.diary_date }}</div><div class="hint">{{ selected.weather || '天气未记录' }} <span v-if="selected.legacy" class="status-pill warning">旧表迁移</span></div></div><button class="btn btn-sm btn-danger" @click="removeEntry"><Trash2 :size="13" /> 删除</button></div><div class="detail-block"><h4>主要工作</h4><p>{{ selected.work || '未填写' }}</p></div><div class="detail-block"><h4>突发事件</h4><p>{{ selected.event || '未填写' }}</p></div><div class="detail-block"><h4>今日反思</h4><p>{{ selected.reflection || '未填写' }}</p></div><div class="detail-block"><h4>待办事项</h4><p>{{ selected.todo || '未填写' }}</p></div><div class="detail-block"><h4><Link2 :size="14" /> 来源关联</h4><div v-if="selected.links.length" class="link-list"><span v-for="link in selected.links" :key="link.id" class="chip">{{ link.link_type }} #{{ link.link_id }}</span></div><span v-else class="hint">暂无关联来源</span></div></template></div></div>
  </div>
</template>

<style scoped>
.diary-page{max-width:1180px;margin:0 auto}.diary-form-card{margin-top:16px}.diary-form-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.diary-text-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.diary-layout{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(280px,.8fr);gap:16px;margin-top:16px}.calendar-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}.calendar-head strong{display:flex;align-items:center;gap:7px}.weekday-row,.calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px}.weekday-row{margin-bottom:5px}.weekday-row span{color:var(--text-tertiary);font-size:11px;text-align:center}.calendar-cell{min-height:88px;padding:7px;border:1px solid var(--border);border-radius:9px;background:var(--bg-elevated);text-align:left;cursor:pointer;color:var(--text)}.calendar-cell:hover:not(:disabled){border-color:rgba(91,106,191,.35);background:var(--primary-bg)}.calendar-cell.empty{background:var(--bg);cursor:default}.calendar-cell.today{box-shadow:inset 0 0 0 1px var(--primary)}.calendar-day-number{display:block;font-size:12px;color:var(--text-secondary);margin-bottom:5px}.calendar-entry{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:3px 5px;margin-top:3px;border-radius:5px;background:var(--primary-bg);color:var(--primary);font-size:11px}.calendar-more{display:block;color:var(--text-tertiary);font-size:10px;margin-top:3px}.diary-detail-card{min-width:0}.detail-header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.detail-block{padding:14px 0;border-bottom:1px solid var(--border)}.detail-block:last-child{border-bottom:0}.detail-block h4{display:flex;align-items:center;gap:5px;font-size:13px;margin-bottom:6px}.detail-block p{white-space:pre-wrap;color:var(--text-secondary);font-size:13px}.link-list{display:flex;gap:6px;flex-wrap:wrap}.chip{padding:4px 7px;border-radius:99px;background:var(--primary-bg);color:var(--primary);font-size:12px}.status-pill{margin-left:6px;padding:2px 6px;border-radius:99px;font-size:11px}.status-pill.warning{color:#9a6500;background:var(--warning-bg)}
@media(max-width:900px){.diary-layout{grid-template-columns:1fr}.diary-form-grid,.diary-text-grid{grid-template-columns:1fr 1fr}}@media(max-width:560px){.diary-form-grid,.diary-text-grid{grid-template-columns:1fr}.calendar-cell{min-height:62px;padding:4px}.calendar-entry{font-size:10px}}
</style>
