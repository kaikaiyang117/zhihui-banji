<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { AlertTriangle, CalendarDays, CheckCircle, Edit3, FileUp, Plus, X } from 'lucide-vue-next'
import FullCalendar from '@fullcalendar/vue3'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin from '@fullcalendar/interaction'
import zhCnLocale from '@fullcalendar/core/locales/zh-cn'
import { get, post, put, upload } from '../api'

const month = ref(new Date().toISOString().slice(0, 7))
const entries = ref([])
const scope = ref({ term_name: '', start_date: '', end_date: '' })
const summary = ref({ total: 0, school_days: 0, non_school_days: 0, events: 0 })
const loading = ref(true)
const saving = ref(false)
const importing = ref(false)
const committing = ref(false)
const error = ref('')
const notice = ref('')
const fileInput = ref(null)
const importPreview = ref(null)
const showEditor = ref(false)
const editingId = ref(null)
const calendarRef = ref(null)
const form = reactive({ calendar_date: today(), day_type: '上课日', title: '', is_school_day: true, note: '' })

const dayTypes = ['上课日', '放假日', '调休上课', '考试日', '活动日', '其他']
const monthTitle = computed(() => {
  const [year, value] = month.value.split('-')
  return `${year}年${Number(value)}月`
})
const monthEntries = computed(() => entries.value.filter(item => item.calendar_date.startsWith(month.value)))
const entryMap = computed(() => Object.fromEntries(monthEntries.value.map(item => [item.calendar_date, item])))
const calendarEvents = computed(() => entries.value.map(entry => ({
  id: String(entry.id),
  date: entry.calendar_date,
  allDay: true,
  title: entry.title || entry.day_type,
  classNames: [`school-calendar-event-${entry.day_type}`, entry.is_school_day ? 'school-calendar-event-school' : 'school-calendar-event-holiday'],
  extendedProps: { entry },
})))
const previewRows = computed(() => importPreview.value?.rows || [])
const commitRows = computed(() => previewRows.value.filter(item => item.valid && !['冲突', '跳过'].includes(item.action)))

const calendarOptions = computed(() => ({
  plugins: [dayGridPlugin, interactionPlugin],
  locales: [zhCnLocale],
  locale: 'zh-cn',
  initialView: 'dayGridMonth',
  firstDay: 1,
  fixedWeekCount: false,
  height: 'auto',
  dayMaxEvents: 3,
  headerToolbar: false,
  events: calendarEvents.value,
  dateClick: ({ dateStr }) => openDay(dateStr),
  eventClick: ({ event }) => openEditor(event.extendedProps.entry),
  datesSet: ({ view }) => {
    const current = view.currentStart
    month.value = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`
  },
}))

function today() { return new Date().toISOString().slice(0, 10) }
function changeMonth(delta) {
  const api = calendarRef.value?.getApi()
  if (api) api[delta < 0 ? 'prev' : 'next']()
}
function resetForm(day = today()) {
  Object.assign(form, { calendar_date: day, day_type: '上课日', title: '', is_school_day: true, note: '' })
}
function openEditor(entry = null, day = null) {
  editingId.value = entry?.id || null
  if (entry) {
    Object.assign(form, {
      calendar_date: entry.calendar_date, day_type: entry.day_type, title: entry.title || '',
      is_school_day: Boolean(entry.is_school_day), note: entry.note || '',
    })
  } else {
    resetForm(day || today())
  }
  showEditor.value = true
}
function openDay(day) { if (day) openEditor(entryMap.value[day], day) }

async function load() {
  loading.value = true; error.value = ''
  try {
    const [data, runtime] = await Promise.all([
      get('/api/school-calendar'), get('/api/system/runtime'),
    ])
    entries.value = data.entries || []
    scope.value = data.scope || scope.value
    summary.value = data.summary || summary.value
    if (runtime.business_date) {
      month.value = runtime.business_date.slice(0, 7)
      calendarRef.value?.getApi().gotoDate(runtime.business_date)
    }
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

async function saveEntry() {
  if (!form.calendar_date) return
  saving.value = true; error.value = ''
  try {
    const body = { ...form }
    if (editingId.value) await put(`/api/school-calendar/${editingId.value}`, body)
    else await post('/api/school-calendar', body)
    notice.value = editingId.value ? '校历日期已更新。' : '校历日期已添加。'
    showEditor.value = false
    await load()
  } catch (e) { error.value = e.message } finally { saving.value = false }
}

function pickFile() { fileInput.value?.click() }
async function previewFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  importing.value = true; error.value = ''; notice.value = ''
  try {
    importPreview.value = await upload('/api/school-calendar/import/preview', file)
  } catch (e) { error.value = e.message } finally { importing.value = false }
}
function closePreview() { importPreview.value = null }
async function commitImport() {
  if (!commitRows.value.length) return
  committing.value = true; error.value = ''
  try {
    const requestId = globalThis.crypto?.randomUUID?.() || `calendar-${Date.now()}`
    const result = await post('/api/school-calendar/import/commit', {
      filename: importPreview.value.filename, request_id: requestId, rows: commitRows.value,
    })
    notice.value = `校历已导入：新增 ${result.imported} 天，更新 ${result.updated} 天，跳过 ${result.skipped} 天。`
    closePreview(); await load()
  } catch (e) { error.value = e.message } finally { committing.value = false }
}

onMounted(load)
</script>

<template>
  <div class="school-calendar-page">
    <div class="page-title-bar">
      <div><div class="page-title">校历管理</div><div class="page-subtitle">{{ scope.term_name || '当前学期' }} · 导入学校行事历，统一查看上课、放假、调休和考试安排</div></div>
      <div class="toolbar" style="margin-bottom:0">
        <input ref="fileInput" type="file" accept=".xlsx,.xlsm" hidden @change="previewFile">
        <button class="btn btn-outline" :disabled="importing" @click="pickFile"><FileUp :size="14" /> {{ importing ? '解析中…' : '导入校历' }}</button>
        <button class="btn btn-primary" @click="openEditor()"><Plus :size="14" /> 添加日期</button>
      </div>
    </div>
    <div v-if="notice" class="inline-message success-message">{{ notice }}</div>
    <div v-if="error" class="inline-message error-message">{{ error }}</div>

    <section class="calendar-summary-grid">
      <div class="card calendar-summary-item"><span>已记录日期</span><strong>{{ summary.total }}</strong><small>当前学期</small></div>
      <div class="card calendar-summary-item"><span>上课/行课日</span><strong>{{ summary.school_days }}</strong><small>包含调休、考试和活动</small></div>
      <div class="card calendar-summary-item"><span>非上课日</span><strong>{{ summary.non_school_days }}</strong><small>放假和周末安排</small></div>
      <div class="card calendar-summary-item"><span>特殊安排</span><strong>{{ summary.events }}</strong><small>带有事项说明的日期</small></div>
    </section>

    <div class="school-calendar-layout">
      <section class="card school-calendar-month-card">
        <div class="calendar-head"><button class="btn btn-sm btn-outline calendar-nav-button" aria-label="上个月" @click="changeMonth(-1)">‹</button><strong><CalendarDays :size="16" /> {{ monthTitle }}</strong><button class="btn btn-sm btn-outline calendar-nav-button" aria-label="下个月" @click="changeMonth(1)">›</button></div>
        <div v-if="loading" class="loading">加载中…</div>
        <FullCalendar v-else ref="calendarRef" class="school-calendar-component" :options="calendarOptions" />
        <div class="calendar-legend"><span><i class="legend-dot school-dot"></i>上课日</span><span><i class="legend-dot holiday-dot"></i>非上课日</span><span><i class="legend-dot event-dot"></i>特殊安排</span></div>
      </section>

      <section class="card school-calendar-list-card">
        <div class="card-title"><CalendarDays :size="16" /> 本月安排 <span class="count">{{ monthEntries.length }} 天</span></div>
        <div v-if="!monthEntries.length" class="empty-state compact">本月还没有校历记录，可以导入学校行事历或手动添加。</div>
        <div v-else class="school-calendar-list"><button v-for="entry in monthEntries" :key="entry.id" class="school-calendar-list-row" @click="openEditor(entry)"><span class="school-calendar-date">{{ entry.calendar_date.slice(5) }}</span><span class="school-calendar-list-copy"><strong>{{ entry.title || entry.day_type }}</strong><small>{{ entry.day_type }} · {{ entry.is_school_day ? '上课日' : '非上课日' }}<template v-if="entry.note"> · {{ entry.note }}</template></small></span><Edit3 :size="14" /></button></div>
      </section>
    </div>

    <section class="card calendar-import-help"><div class="card-title"><FileUp :size="16" /> 导入说明</div><p>支持参考学校常见的“月份 / 周次 / 星期一至星期日”矩阵，也支持包含“日期、类型、事项、是否上课”的明细表。导入会先预览，不会直接修改数据库；当前学期范围外的日期会单独提示。</p></section>

    <div v-if="showEditor" class="modal-overlay show" @click.self="showEditor = false"><section class="modal calendar-entry-modal"><div class="modal-title-row"><div><div class="modal-kicker">{{ editingId ? '修改校历日期' : '添加校历日期' }}</div><h3>{{ form.calendar_date || '选择日期' }}</h3></div><button class="icon-btn" aria-label="关闭" @click="showEditor = false"><X :size="18" /></button></div><div class="form-grid"><label>日期<input v-model="form.calendar_date" type="date" class="form-input"></label><label>日期类型<select v-model="form.day_type" class="form-select"><option v-for="item in dayTypes" :key="item">{{ item }}</option></select></label><label class="form-grid-wide">事项<input v-model.trim="form.title" class="form-input" placeholder="例如：端午节、期中考试、班级活动"></label><label class="calendar-school-day"><input v-model="form.is_school_day" type="checkbox"> 计为上课/行课日</label><label class="form-grid-wide">备注<textarea v-model="form.note" class="form-textarea" rows="3" placeholder="可选"></textarea></label></div><div class="modal-actions"><button class="btn btn-outline" @click="showEditor = false">取消</button><button class="btn btn-primary" :disabled="saving" @click="saveEntry">{{ saving ? '保存中…' : '保存' }}</button></div></section></div>

    <div v-if="importPreview" class="modal-overlay show" @click.self="closePreview"><section class="modal calendar-preview-modal"><div class="modal-title-row"><div><div class="modal-kicker">确认校历导入</div><h3>{{ importPreview.filename }}</h3><p class="hint">{{ importPreview.format === 'matrix' ? '已识别为学校行事历矩阵' : '已识别为日期明细表' }} · 当前范围：{{ importPreview.term.start_date || '未设置' }} 至 {{ importPreview.term.end_date || '未设置' }}</p></div><button class="icon-btn" aria-label="关闭预览" @click="closePreview"><X :size="18" /></button></div><div class="preview-counts calendar-preview-counts"><span class="ok">可提交 {{ commitRows.length }}</span><span>解析 {{ importPreview.summary.parsed }}</span><span>新增 {{ importPreview.summary.new }}</span><span>更新 {{ importPreview.summary.update }}</span><span>跳过 {{ importPreview.summary.skip }}</span><span :class="{ danger: importPreview.summary.conflict }">冲突 {{ importPreview.summary.conflict }}</span><span v-if="importPreview.summary.out_of_term" class="warning">范围外 {{ importPreview.summary.out_of_term }}</span></div><div v-if="importPreview.summary.out_of_term" class="preview-notice calendar-warning"><AlertTriangle :size="14" /> 有日期不在当前学期范围内，仍可确认导入，但建议先切换到对应学期。</div><div class="table-wrap calendar-preview-table"><table class="data-table"><thead><tr><th>Excel 行</th><th>日期</th><th>类型</th><th>事项</th><th>是否上课</th><th>动作</th><th>说明</th></tr></thead><tbody><tr v-for="(row, index) in previewRows" :key="`${row.date}-${index}`" :class="{ 'preview-error-row': !row.valid }"><td>{{ row.row }}</td><td>{{ row.date }}</td><td>{{ row.day_type }}</td><td>{{ row.title || '—' }}</td><td>{{ row.is_school_day ? '是' : '否' }}</td><td><span class="preview-action" :class="row.action">{{ row.action }}</span></td><td>{{ row.error || (row.out_of_term ? '超出当前学期范围' : '校验通过') }}</td></tr></tbody></table></div><div class="preview-footer"><p v-if="importPreview.summary.conflict"><AlertTriangle :size="14" /> 冲突日期不会提交，其余有效日期会在一个事务中写入。</p><p v-else><CheckCircle :size="14" /> 请确认日期、事项和上课状态后再写入。</p><div><button class="btn btn-outline" @click="closePreview">取消</button><button class="btn btn-primary" :disabled="!commitRows.length || committing" @click="commitImport">{{ committing ? '导入中…' : `确认导入 ${commitRows.length} 天` }}</button></div></div></section></div>
  </div>
</template>

<style scoped>
.school-calendar-page { max-width: 1220px; margin: 0 auto; }
.calendar-summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
.calendar-summary-item { display: grid; gap: 4px; padding: 14px 16px; }
.calendar-summary-item span, .calendar-summary-item small { color: var(--text-secondary); font-size: 11px; }
.calendar-summary-item strong { font-size: 24px; line-height: 1.1; }
.school-calendar-layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, .75fr); gap: 16px; margin-top: 16px; }
.calendar-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.calendar-head strong { display: flex; align-items: center; gap: 7px; }
.calendar-nav-button { min-width: 30px; padding: 0 7px; font-size: 20px; line-height: 1; }
.school-calendar-component { min-width: 0; }
.school-calendar-component :deep(.fc) { --fc-border-color: var(--border-light); --fc-today-bg-color: rgba(91, 106, 191, .055); color: var(--text); font-size: 12px; }
.school-calendar-component :deep(.fc-scrollgrid) { border: 1px solid var(--border-light); border-radius: 10px; overflow: hidden; }
.school-calendar-component :deep(.fc-col-header-cell) { background: var(--surface-subtle, #f8f8fa); }
.school-calendar-component :deep(.fc-col-header-cell-cushion) { padding: 9px 4px; color: var(--text-tertiary); font-size: 11px; font-weight: 600; text-decoration: none; }
.school-calendar-component :deep(.fc-daygrid-day-frame) { min-height: 92px; padding: 4px; }
.school-calendar-component :deep(.fc-daygrid-day-number) { padding: 4px 6px; color: var(--text-secondary); font-size: 12px; text-decoration: none; }
.school-calendar-component :deep(.fc-day-today .fc-daygrid-day-number) { color: var(--primary); font-weight: 700; }
.school-calendar-component :deep(.fc-daygrid-event) { margin: 2px 3px; padding: 3px 5px; border: 0; border-radius: 5px; font-size: 11px; line-height: 1.25; cursor: pointer; }
.school-calendar-component :deep(.school-calendar-event-school) { background: rgba(45, 180, 95, .12); color: #26834b; }
.school-calendar-component :deep(.school-calendar-event-holiday) { background: rgba(235, 90, 105, .12); color: #b5465a; }
.school-calendar-component :deep(.school-calendar-event-调休上课), .school-calendar-component :deep(.school-calendar-event-考试日), .school-calendar-component :deep(.school-calendar-event-活动日) { background: var(--primary-bg); color: var(--primary); }
.school-calendar-component :deep(.fc-more-link) { color: var(--primary); font-size: 11px; }
.school-calendar-component :deep(.fc-daygrid-day:hover) { background: rgba(91, 106, 191, .035); cursor: pointer; }
.calendar-legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 14px; color: var(--text-secondary); font-size: 11px; }
.legend-dot { display: inline-block; width: 7px; height: 7px; margin-right: 4px; border-radius: 50%; background: var(--success); }
.holiday-dot { background: var(--danger); }.event-dot { background: var(--primary); }
.school-calendar-list-card { min-width: 0; }.school-calendar-list { display: grid; gap: 6px; margin-top: 13px; max-height: 560px; overflow: auto; }
.school-calendar-list-row { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; align-items: center; gap: 10px; width: 100%; padding: 10px 9px; border: 1px solid var(--border-light); border-radius: 10px; background: var(--surface); color: var(--text); text-align: left; cursor: pointer; }
.school-calendar-list-row:hover { border-color: rgba(91, 106, 191, .35); background: var(--primary-bg); }.school-calendar-date { color: var(--primary); font-size: 12px; font-weight: 700; }.school-calendar-list-copy { display: grid; gap: 3px; min-width: 0; }.school-calendar-list-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.school-calendar-list-copy small { color: var(--text-secondary); }.calendar-import-help { margin-top: 16px; }.calendar-import-help p { margin: 8px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.6; }.calendar-entry-modal { max-width: 620px; }.calendar-preview-modal { width: min(1080px, calc(100vw - 36px)); max-height: min(86vh, 800px); display: flex; flex-direction: column; }.calendar-preview-modal h3 { margin-bottom: 4px; }.calendar-preview-counts { margin: 16px 0 10px; }.calendar-preview-counts .warning { color: var(--warning); }.calendar-warning { display: flex; align-items: center; gap: 6px; }.calendar-preview-table { flex: 1; min-height: 180px; overflow: auto; }.calendar-school-day { display: flex; align-items: center; gap: 7px; color: var(--text-secondary); font-size: 12px; }.calendar-school-day input { margin: 0; }
@media (max-width: 900px) { .calendar-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.school-calendar-layout { grid-template-columns: 1fr; } }
@media (max-width: 600px) { .calendar-summary-grid { grid-template-columns: 1fr 1fr; gap: 8px; }.school-calendar-component :deep(.fc-daygrid-day-frame) { min-height: 70px; padding: 2px; }.school-calendar-component :deep(.fc-daygrid-event) { margin: 1px; padding: 2px 3px; font-size: 10px; }.calendar-preview-modal { width: calc(100vw - 20px); max-height: 91vh; padding: 16px; } }
</style>
