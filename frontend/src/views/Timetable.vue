<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { CalendarDays, Clock3, Download, Edit3, FileUp, Plus, RotateCcw, Save, X, Trash2, Users } from 'lucide-vue-next'
import { download, get, post, put, upload, setStoredScope, getTeacherClasses, addTeacherClass, removeTeacherClass, getTeacherTimetable, getTeacherExams } from '../api'

const activeView = ref('single')

const periods = ref([])
const entries = ref([])
const timetableScope = ref({})
const teachers = ref([])
const changes = ref([])
const daySchedule = ref(null)
const selectedDate = ref('')
const teacherFilter = ref('')
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const showEntryEditor = ref(false)
const showPeriodEditor = ref(false)
const showChangeEditor = ref(false)
const editingEntryId = ref(null)
const importPreview = ref(null)
const importing = ref(false)
const committing = ref(false)
const fileInput = ref(null)

const entryForm = reactive({ weekday: 1, period_no: 1, subject: '', teacher_name: '', room: '', session_type: '普通课', week_pattern: '全周', week_start: 1, week_end: 99, note: '' })
const periodForm = reactive({ period_no: 1, label: '', start_time: '', end_time: '', session_type: '普通课' })
const changeForm = reactive({ change_date: '', period_no: 1, action: '调课', subject: '', teacher_name: '', room: '', session_type: '普通课', note: '' })

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const sessionTypes = ['普通课', '早自习', '晚自习', '班会', '自习', '社团', '考试', '活动']
const weekPatterns = ['全周', '单周', '双周']
const changeActions = ['调课', '代课', '停课', '考试', '活动']
const subjectToneMap = {
  语文: 'subject-tone-rose', 数学: 'subject-tone-blue', 英语: 'subject-tone-mint', 政治: 'subject-tone-violet',
  历史: 'subject-tone-amber', 地理: 'subject-tone-teal', '地/生': 'subject-tone-aqua', 体育: 'subject-tone-orange',
  信息技术: 'subject-tone-cyan', 通用: 'subject-tone-slate', 班会: 'subject-tone-pink', 物理: 'subject-tone-indigo',
  化学: 'subject-tone-green', 生物: 'subject-tone-lime',
}
const fallbackSubjectTones = ['subject-tone-indigo', 'subject-tone-blue', 'subject-tone-mint', 'subject-tone-violet', 'subject-tone-teal']

const myClasses = ref([])
const allClasses = ref([])
const teacherEntries = ref([])
const teacherExamList = ref([])
const teacherLoading = ref(false)
const teacherError = ref('')
const addClassId = ref('')
const addingClass = ref(false)
const removingClassId = ref(null)
const showAddClassDialog = ref(false)

function resetEntryForm() { Object.assign(entryForm, { weekday: 1, period_no: periods.value[0]?.period_no || 1, subject: '', teacher_name: '', room: '', session_type: '普通课', week_pattern: '全周', week_start: 1, week_end: 99, note: '' }); editingEntryId.value = null }
function resetPeriodForm() { Object.assign(periodForm, { period_no: periods.value.length + 1, label: '', start_time: '', end_time: '', session_type: '普通课' }) }
function resetChangeForm() { Object.assign(changeForm, { change_date: selectedDate.value, period_no: periods.value[0]?.period_no || 1, action: '调课', subject: '', teacher_name: '', room: '', session_type: '普通课', note: '' }) }

const filteredEntries = computed(() => teacherFilter.value ? entries.value.filter(item => item.teacher_name === teacherFilter.value) : entries.value)
const previewRows = computed(() => importPreview.value?.rows || [])
const commitRows = computed(() => previewRows.value.filter(item => item.valid))
const scheduleForDate = computed(() => daySchedule.value?.entries || [])
const timetableRangeLabel = computed(() => {
  const className = timetableScope.value.class_name || '当前班级'
  const weekLabel = daySchedule.value?.week_no ? `第${daySchedule.value.week_no}周` : '当前周'
  return `${className} · ${weekLabel}课程`
})

const myClassIds = computed(() => new Set(myClasses.value.map(c => Number(c.class_id))))
const availableClasses = computed(() => allClasses.value.filter(c => !myClassIds.value.has(Number(c.id))))

const teacherAgendaGrouped = computed(() => {
  const changeItems = teacherEntries.value.filter(e => e.source === 'change')
  const dateMap = new Map()
  for (const item of teacherEntries.value) {
    if (item.source === 'change') continue
    const key = item.weekday ? `weekday-${item.weekday}` : 'other'
    if (!dateMap.has(key)) dateMap.set(key, { label: weekdays[(item.weekday || 1) - 1] || '未知', items: [] })
    dateMap.get(key).items.push(item)
  }
  for (const item of changeItems) {
    const key = item.change_date || 'undated'
    if (!dateMap.has(key)) dateMap.set(key, { label: item.change_date || '未定日期', items: [] })
    dateMap.get(key).items.push(item)
  }
  return Array.from(dateMap.values())
})

function cellEntries(weekday, periodNo) {
  return filteredEntries.value.filter(item => Number(item.weekday) === weekday && Number(item.period_no) === periodNo)
}
function cellLabel(item) { return [item.subject, item.teacher_name, item.room].filter(Boolean).join(' · ') }
function cellSecondary(item) {
  if (item.room) return item.room
  if (item.session_type && item.session_type !== '普通课') return item.session_type
  return ''
}
function subjectTone(subject) {
  const name = String(subject || '').trim()
  if (subjectToneMap[name]) return subjectToneMap[name]
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) | 0
  return fallbackSubjectTones[Math.abs(hash) % fallbackSubjectTones.length]
}
function entryAccessibleLabel(item) {
  return [
    item.subject,
    item.teacher_name && `任课教师：${item.teacher_name}`,
    item.room && `教室：${item.room}`,
    item.week_pattern && item.week_pattern !== '全周' && item.week_pattern,
  ].filter(Boolean).join('，')
}
function cellAriaLabel(weekday, periodNo) {
  const period = periods.value.find(item => Number(item.period_no) === Number(periodNo))
  const label = period?.label || `${periodNo}节`
  const item = cellEntries(weekday, periodNo)[0]
  return item
    ? `编辑${weekdays[weekday - 1]}${label}：${entryAccessibleLabel(item)}`
    : `添加${weekdays[weekday - 1]}${label}课程`
}
function openEntry(entry = null, weekday = 1, periodNo = periods.value[0]?.period_no || 1) {
  editingEntryId.value = entry?.id || null
  Object.assign(entryForm, entry ? {
    weekday: entry.weekday, period_no: entry.period_no, subject: entry.subject, teacher_name: entry.teacher_name || '', room: entry.room || '', session_type: entry.session_type || '普通课', week_pattern: entry.week_pattern || '全周', week_start: entry.week_start || 1, week_end: entry.week_end || 99, note: entry.note || '',
  } : { ...entryForm, weekday, period_no: periodNo, subject: '', teacher_name: '', room: '', session_type: '普通课', week_pattern: '全周', week_start: 1, week_end: 99, note: '' })
  showEntryEditor.value = true
}
function openPeriod(period = null) {
  if (period) Object.assign(periodForm, { period_no: period.period_no, label: period.label || '', start_time: period.start_time || '', end_time: period.end_time || '', session_type: period.session_type || '普通课' })
  else resetPeriodForm()
  showPeriodEditor.value = true
}
function openChange() { resetChangeForm(); showChangeEditor.value = true }

async function load() {
  loading.value = true; error.value = ''
  try {
    if (!selectedDate.value) {
      const runtime = await get('/api/system/runtime')
      selectedDate.value = runtime.business_date || ''
      changeForm.change_date = selectedDate.value
    }
    const query = teacherFilter.value ? `?teacher_name=${encodeURIComponent(teacherFilter.value)}` : ''
    const [data, changesData, dayData] = await Promise.all([
      get(`/api/timetable${query}`), get('/api/timetable/changes'), get(`/api/timetable/day?date=${selectedDate.value}`),
    ])
    timetableScope.value = data.scope || {}; periods.value = data.periods || []; entries.value = data.entries || []; teachers.value = data.teachers || []
    changes.value = changesData.changes || []; daySchedule.value = dayData
  } catch (e) { error.value = e.message } finally { loading.value = false }
}
async function loadDay() {
  try { daySchedule.value = await get(`/api/timetable/day?date=${selectedDate.value}`) } catch (e) { error.value = e.message }
}
async function saveEntry() {
  if (!entryForm.subject.trim()) return
  saving.value = true; error.value = ''
  try {
    if (editingEntryId.value) await put(`/api/timetable/entries/${editingEntryId.value}`, { ...entryForm, weekday: Number(entryForm.weekday), period_no: Number(entryForm.period_no), week_start: Number(entryForm.week_start), week_end: Number(entryForm.week_end) })
    else await post('/api/timetable/entries', { ...entryForm, weekday: Number(entryForm.weekday), period_no: Number(entryForm.period_no), week_start: Number(entryForm.week_start), week_end: Number(entryForm.week_end) })
    notice.value = editingEntryId.value ? '课程安排已更新。' : '课程安排已添加。'; showEntryEditor.value = false; await load()
  } catch (e) { error.value = e.message } finally { saving.value = false }
}
async function savePeriod() {
  saving.value = true; error.value = ''
  try {
    const existing = periods.value.find(item => Number(item.period_no) === Number(periodForm.period_no))
    if (existing) await put(`/api/timetable/periods/${existing.id}`, { ...periodForm, period_no: Number(periodForm.period_no) })
    else await post('/api/timetable/periods', { ...periodForm, period_no: Number(periodForm.period_no) })
    notice.value = '节次设置已保存。'; showPeriodEditor.value = false; await load()
  } catch (e) { error.value = e.message } finally { saving.value = false }
}
async function saveChange() {
  saving.value = true; error.value = ''
  try { await post('/api/timetable/changes', { ...changeForm, period_no: Number(changeForm.period_no) }); notice.value = '临时课程变更已保存。'; showChangeEditor.value = false; selectedDate.value = changeForm.change_date; await load() } catch (e) { error.value = e.message } finally { saving.value = false }
}
async function cancelChange(item) {
  if (!confirm(`取消 ${item.change_date} 第${item.period_no}节的临时变更吗？`)) return
  try { await put(`/api/timetable/changes/${item.id}/cancel`, {}); notice.value = '临时变更已取消。'; await load() } catch (e) { error.value = e.message }
}
function pickFile() { fileInput.value?.click() }
async function previewFile(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
  importing.value = true; error.value = ''; importPreview.value = null
  try { importPreview.value = await upload('/api/timetable/import/preview', file) } catch (e) { error.value = e.message } finally { importing.value = false }
}
async function commitImport() {
  if (!commitRows.value.length) return
  committing.value = true; error.value = ''
  try { const id = globalThis.crypto?.randomUUID?.() || `timetable-${Date.now()}`; const result = await post('/api/timetable/import/commit', { filename: importPreview.value.filename, request_id: id, rows: commitRows.value }); notice.value = `课程表导入完成：新增 ${result.imported || 0} 项，更新 ${result.updated || 0} 项。`; importPreview.value = null; await load() } catch (e) { error.value = e.message } finally { committing.value = false }
}
function changeForPeriod(periodNo) { return changes.value.find(item => item.change_date === selectedDate.value && Number(item.period_no) === Number(periodNo)) }

async function loadTeacherView() {
  teacherLoading.value = true; teacherError.value = ''
  try {
    const [classesData, contextData, timetableData, examsData] = await Promise.all([
      getTeacherClasses(),
      get('/api/context'),
      getTeacherTimetable(),
      getTeacherExams(),
    ])
    myClasses.value = classesData.classes || []
    allClasses.value = contextData.classes || []
    teacherEntries.value = timetableData.entries || []
    teacherExamList.value = examsData.exams || []
  } catch (e) { teacherError.value = e.message } finally { teacherLoading.value = false }
}

async function onAddClass() {
  if (!addClassId.value) return
  addingClass.value = true; teacherError.value = ''
  try {
    await addTeacherClass(Number(addClassId.value))
    addClassId.value = ''
    showAddClassDialog.value = false
    await loadTeacherView()
  } catch (e) { teacherError.value = e.message } finally { addingClass.value = false }
}

async function onRemoveClass(tcId, classId) {
  removingClassId.value = tcId
  teacherError.value = ''
  try {
    await removeTeacherClass(tcId)
    await loadTeacherView()
  } catch (e) { teacherError.value = e.message } finally { removingClassId.value = null }
}

watch(activeView, (val) => {
  if (val === 'mine' && !myClasses.value.length) loadTeacherView()
})

onMounted(load)
</script>

<template>
  <div class="timetable-page">
    <div class="page-title-bar">
      <div><div class="page-title">课程表</div><div class="page-subtitle">{{ activeView === 'single' ? '高中班级课表、早晚自习与临时调课 · ' + (daySchedule?.date || selectedDate) : '多班级教师视角，汇总所有任课班级的课程与考试' }}</div></div>
    </div>

    <div class="segmented timetable-segmented">
      <button :class="{ active: activeView === 'single' }" @click="activeView = 'single'">单班课表</button>
      <button :class="{ active: activeView === 'mine' }" @click="activeView = 'mine'">我的安排</button>
    </div>

    <div v-if="notice" class="inline-message success-message">{{ notice }}</div>
    <div v-if="error" class="inline-message error-message">{{ error }}</div>
    <div v-if="teacherError" class="inline-message error-message">{{ teacherError }}</div>

    <template v-if="activeView === 'single'">
      <div class="toolbar timetable-toolbar">
        <select v-model="teacherFilter" class="form-select" aria-label="按任课教师筛选" @change="load"><option value="">全部任课教师</option><option v-for="teacher in teachers" :key="teacher" :value="teacher">{{ teacher }}</option></select>
        <input ref="fileInput" type="file" accept=".xlsx,.xlsm" hidden @change="previewFile">
        <button class="btn btn-outline" :disabled="importing" @click="pickFile"><FileUp :size="14" /> {{ importing ? '解析中…' : '导入课表' }}</button>
        <button class="btn btn-outline" @click="download('/api/timetable/template', '课程表导入模板.xlsx')"><Download :size="14" /> 下载模板</button>
        <button class="btn btn-primary" @click="openEntry()"><Plus :size="14" /> 添加课程</button>
      </div>

      <section class="timetable-actions">
        <button class="card timetable-action-card" @click="openPeriod()"><Clock3 :size="18" /><span><strong>节次与作息</strong><small>{{ periods.length }} 个节次，维护上课和下课时间</small></span><Edit3 :size="15" /></button>
        <button class="card timetable-action-card" @click="openChange()"><CalendarDays :size="18" /><span><strong>临时调课</strong><small>{{ changes.length }} 条生效变更，停课/代课/考试均可记录</small></span><Plus :size="15" /></button>
        <button class="card timetable-action-card" @click="load"><RotateCcw :size="18" /><span><strong>刷新课程表</strong><small>当前班级和学期范围</small></span><RotateCcw :size="15" /></button>
      </section>

      <section v-if="!loading" class="card timetable-week-card">
        <div class="section-heading timetable-section-heading"><div><h2>{{ timetableRangeLabel }}</h2></div></div>
        <div v-if="!periods.length" class="empty-state">还没有配置节次。先点击"节次与作息"，再录入课程或导入Excel课表。</div>
        <div v-else class="timetable-grid-scroll" aria-label="固定周课表，可横向滚动查看">
          <div class="timetable-grid">
          <div class="timetable-grid-head timetable-period-head">节次</div><div v-for="day in weekdays" :key="day" class="timetable-grid-head">{{ day }}</div>
          <template v-for="period in periods" :key="period.id">
            <div class="timetable-period-cell"><strong>{{ period.label || `${period.period_no}节` }}</strong><small>{{ period.start_time }}<template v-if="period.end_time">–{{ period.end_time }}</template></small><em v-if="period.session_type && period.session_type !== '普通课'">{{ period.session_type }}</em></div>
            <button v-for="weekday in 7" :key="`${period.id}-${weekday}`" class="timetable-cell" :aria-label="cellAriaLabel(weekday, period.period_no)" @click="openEntry(cellEntries(weekday, period.period_no)[0], weekday, period.period_no)">
              <template v-if="cellEntries(weekday, period.period_no).length"><span v-for="item in cellEntries(weekday, period.period_no)" :key="item.id" class="timetable-entry" :class="subjectTone(item.subject)" :title="cellLabel(item)"><strong>{{ item.subject }}</strong><small v-if="cellSecondary(item)">{{ cellSecondary(item) }}</small><em v-if="item.week_pattern !== '全周'">{{ item.week_pattern }}</em></span></template>
              <span v-else class="timetable-empty" aria-hidden="true"></span>
            </button>
          </template>
          </div>
        </div>
      </section>

      <div class="timetable-lower-grid">
        <section class="card day-schedule-card">
          <div class="section-heading"><div><h2>当天课程</h2><p>校历、教学周和临时变更会在这里合并</p></div><input class="form-input date-input" type="date" v-model="selectedDate" @change="loadDay"></div>
          <div v-if="daySchedule" class="day-meta"><span>第 {{ daySchedule.week_no }} 周 · {{ daySchedule.weekday_label }}</span><span :class="daySchedule.school_day ? 'tag-green' : 'tag-gray'">{{ daySchedule.school_day ? '行课日' : '非行课日' }}</span><span v-if="daySchedule.calendar?.title">{{ daySchedule.calendar.title }}</span></div>
          <div v-if="!scheduleForDate.length" class="empty-state compact-empty">当前日期没有配置节次。</div>
          <div v-for="slot in scheduleForDate" :key="slot.id" class="day-course-row" :class="{ changed: slot.entry?.is_change, cancelled: !slot.entry && changeForPeriod(slot.period_no)?.action === '停课' }"><div class="day-course-time"><strong>{{ slot.label }}</strong><small>{{ slot.start_time }}<template v-if="slot.end_time">–{{ slot.end_time }}</template></small></div><div v-if="slot.entry" class="day-course-copy"><strong>{{ slot.entry.subject }} <em v-if="slot.entry.is_change">{{ slot.entry.action }}</em></strong><span>{{ [slot.entry.teacher_name, slot.entry.room, slot.entry.session_type].filter(Boolean).join(' · ') }}</span><small v-if="slot.entry.original_subject">原课程：{{ slot.entry.original_subject }}{{ slot.entry.original_teacher_name ? ` · ${slot.entry.original_teacher_name}` : '' }}</small></div><div v-else class="day-course-copy"><strong>{{ changeForPeriod(slot.period_no)?.action === '停课' ? '停课' : '未安排课程' }}</strong><span>{{ changeForPeriod(slot.period_no)?.note || '—' }}</span></div></div>
        </section>
        <section class="card changes-card"><div class="section-heading"><div><h2>临时变更</h2><p>按当前学期保留变更记录</p></div><button class="btn btn-outline btn-sm" @click="openChange"><Plus :size="13" /> 添加</button></div><div v-if="!changes.length" class="empty-state compact-empty">暂时没有临时调课。</div><div v-for="item in changes.slice(0, 12)" :key="item.id" class="change-row"><div><strong>{{ item.change_date }} · 第{{ item.period_no }}节 · {{ item.action }}</strong><span>{{ [item.subject, item.teacher_name, item.room].filter(Boolean).join(' · ') || '停课' }}</span></div><button class="btn btn-sm btn-outline" @click="cancelChange(item)">取消</button></div></section>
      </div>
    </template>

    <template v-if="activeView === 'mine'">
      <div v-if="teacherLoading" class="loading">加载中…</div>
      <template v-else>
        <section class="card my-classes-card">
          <div class="section-heading"><div><h2><Users :size="16" /> 我的班级</h2><p>添加你任课的班级，汇总查看所有班级的课程安排</p></div><button class="btn btn-primary btn-sm" @click="showAddClassDialog = true"><Plus :size="13" /> 添加班级</button></div>
          <div v-if="!myClasses.length" class="empty-state">还没有添加班级。点击"添加班级"，将你任课的班级加入列表，即可在"我的安排"中查看汇总课表。</div>
          <div v-else class="my-classes-list">
            <div v-for="cls in myClasses" :key="cls.id" class="my-class-row">
              <div class="my-class-info">
                <span class="my-class-name">{{ cls.class_name }}</span>
                <span class="tag tag-blue" v-if="cls.grade">{{ cls.grade }}</span>
                <span class="my-class-role" v-if="cls.role">{{ cls.role }}</span>
                <span class="my-class-subjects" v-if="cls.subjects">{{ cls.subjects }}</span>
              </div>
              <button class="btn btn-sm btn-outline my-class-remove" :disabled="removingClassId === cls.id" @click="onRemoveClass(cls.id, cls.class_id)"><Trash2 :size="13" /></button>
            </div>
          </div>
        </section>

        <section v-if="myClasses.length" class="card my-agenda-card">
          <div class="section-heading"><div><h2>汇总课表</h2><p>所有班级的固定课程与临时变更</p></div><span class="hint">{{ teacherEntries.length }} 项</span></div>
          <div v-if="!teacherEntries.length" class="empty-state">当前班级暂无课程安排。</div>
          <div v-else class="my-agenda-grouped">
            <div v-for="group in teacherAgendaGrouped" :key="group.label" class="my-agenda-date-group">
              <div class="my-agenda-date-label">{{ group.label }}</div>
              <div v-for="item in group.items" :key="`${item.class_id}-${item.weekday}-${item.period_no}-${item.subject}-${item.change_date || ''}`" class="my-agenda-item" :class="{ 'my-agenda-change': item.source === 'change' }">
                <div class="my-agenda-time">
                  <template v-if="item.source === 'change'">
                    <strong>{{ item.change_date }}</strong>
                    <small>第{{ item.period_no }}节</small>
                  </template>
                  <template v-else>
                    <strong>第{{ item.period_no }}节</strong>
                    <small>{{ weekdays[(item.weekday || 1) - 1] }}</small>
                  </template>
                </div>
                <div class="my-agenda-body">
                  <div class="my-agenda-subject-row">
                    <strong>{{ item.subject }}</strong>
                    <span class="tag tag-blue my-agenda-class-tag">{{ item.class_name }}</span>
                    <em v-if="item.source === 'change'" class="my-agenda-action">{{ item.action }}</em>
                    <em v-if="item.week_pattern && item.week_pattern !== '全周'" class="my-agenda-pattern">{{ item.week_pattern }}</em>
                  </div>
                  <div class="my-agenda-meta">{{ [item.teacher_name, item.room, item.session_type].filter(Boolean).join(' · ') }}</div>
                  <div v-if="item.note" class="my-agenda-note">{{ item.note }}</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section v-if="myClasses.length && teacherExamList.length" class="card my-exams-card">
          <div class="section-heading"><div><h2>近期考试</h2><p>所有班级的考试安排</p></div><span class="hint">{{ teacherExamList.length }} 场</span></div>
          <div class="my-exam-list">
            <div v-for="exam in teacherExamList" :key="exam.id" class="my-exam-row">
              <div class="my-exam-date"><strong>{{ exam.exam_date || '待定' }}</strong></div>
              <div class="my-exam-body">
                <strong>{{ exam.name }}</strong>
                <span class="tag tag-blue my-agenda-class-tag">{{ exam.class_name }}</span>
              </div>
            </div>
          </div>
        </section>
      </template>

      <div v-if="showAddClassDialog" class="modal-overlay show" @click.self="showAddClassDialog = false">
        <div class="modal">
          <div class="modal-title-row">
            <div><div class="modal-kicker">多班级教师视角</div><h3>添加任课班级</h3></div>
            <button class="icon-button" @click="showAddClassDialog = false"><X :size="18" /></button>
          </div>
          <div v-if="!availableClasses.length" class="empty-state">所有班级已添加，或系统中没有更多班级。请先在工作台创建班级。</div>
          <template v-else>
            <label style="display:grid;gap:5px;color:var(--text-secondary);font-size:12px">选择班级
              <select class="form-select" v-model="addClassId">
                <option value="">请选择班级</option>
                <option v-for="cls in availableClasses" :key="cls.id" :value="cls.id">{{ cls.name }}{{ cls.grade ? ` (${cls.grade})` : '' }}</option>
              </select>
            </label>
          </template>
          <div class="modal-actions">
            <button class="btn btn-outline" @click="showAddClassDialog = false">取消</button>
            <button class="btn btn-primary" :disabled="addingClass || !addClassId" @click="onAddClass">{{ addingClass ? '添加中…' : '添加' }}</button>
          </div>
        </div>
      </div>
    </template>

    <div v-if="showEntryEditor" class="modal-overlay show" @click.self="showEntryEditor = false"><div class="modal timetable-modal"><div class="modal-title-row"><div><div class="modal-kicker">固定周课表</div><h3>{{ editingEntryId ? '编辑课程安排' : '添加课程安排' }}</h3></div><button class="icon-button" @click="showEntryEditor = false"><X :size="18" /></button></div><div class="form-grid"><label>星期<select class="form-select" v-model.number="entryForm.weekday"><option v-for="(day, index) in weekdays" :key="day" :value="index + 1">{{ day }}</option></select></label><label>节次<select class="form-select" v-model.number="entryForm.period_no"><option v-for="period in periods" :key="period.id" :value="period.period_no">{{ period.label || `${period.period_no}节` }}</option></select></label><label>科目<input class="form-input" v-model="entryForm.subject" placeholder="如：数学"></label><label>任课教师<input class="form-input" v-model="entryForm.teacher_name" placeholder="可选"></label><label>教室<input class="form-input" v-model="entryForm.room" placeholder="如：高一（1）班"></label><label>时段类型<select class="form-select" v-model="entryForm.session_type"><option v-for="item in sessionTypes" :key="item">{{ item }}</option></select></label><label>单双周<select class="form-select" v-model="entryForm.week_pattern"><option v-for="item in weekPatterns" :key="item">{{ item }}</option></select></label><label>开始周<input class="form-input" type="number" min="1" max="99" v-model.number="entryForm.week_start"></label><label>结束周<input class="form-input" type="number" min="1" max="99" v-model.number="entryForm.week_end"></label><label class="form-grid-wide">备注<textarea class="form-textarea" rows="2" v-model="entryForm.note"></textarea></label></div><div class="modal-actions"><button class="btn btn-outline" @click="showEntryEditor = false">取消</button><button class="btn btn-primary" :disabled="saving || !entryForm.subject.trim()" @click="saveEntry"><Save :size="14" /> 保存课程</button></div></div></div>

    <div v-if="showPeriodEditor" class="modal-overlay show" @click.self="showPeriodEditor = false"><div class="modal timetable-modal"><div class="modal-title-row"><div><div class="modal-kicker">节次与作息</div><h3>维护课程节次</h3></div><button class="icon-button" @click="showPeriodEditor = false"><X :size="18" /></button></div><div class="period-list"><div v-for="period in periods" :key="period.id" class="period-row"><span><strong>{{ period.label || `${period.period_no}节` }}</strong><small>{{ period.start_time }}–{{ period.end_time }} · {{ period.session_type }}</small></span><button class="btn btn-sm btn-outline" @click="openPeriod(period)"><Edit3 :size="13" /> 编辑</button></div><div v-if="!periods.length" class="empty-state compact-empty">还没有节次。</div></div><div class="form-grid"><label>节次<input class="form-input" type="number" min="1" max="20" v-model.number="periodForm.period_no"></label><label>名称<input class="form-input" v-model="periodForm.label" placeholder="如：第1节"></label><label>上课时间<input class="form-input" type="time" v-model="periodForm.start_time"></label><label>下课时间<input class="form-input" type="time" v-model="periodForm.end_time"></label><label>时段类型<select class="form-select" v-model="periodForm.session_type"><option v-for="item in sessionTypes" :key="item">{{ item }}</option></select></label></div><div class="modal-actions"><button class="btn btn-primary" :disabled="saving" @click="savePeriod"><Save :size="14" /> 保存节次</button></div></div></div>

    <div v-if="showChangeEditor" class="modal-overlay show" @click.self="showChangeEditor = false"><div class="modal timetable-modal"><div class="modal-title-row"><div><div class="modal-kicker">临时课程变更</div><h3>调课、代课或停课</h3></div><button class="icon-button" @click="showChangeEditor = false"><X :size="18" /></button></div><div class="form-grid"><label>日期<input class="form-input" type="date" v-model="changeForm.change_date"></label><label>节次<select class="form-select" v-model.number="changeForm.period_no"><option v-for="period in periods" :key="period.id" :value="period.period_no">{{ period.label || `${period.period_no}节` }}</option></select></label><label>变更类型<select class="form-select" v-model="changeForm.action"><option v-for="item in changeActions" :key="item">{{ item }}</option></select></label><label>科目<input class="form-input" v-model="changeForm.subject" :placeholder="changeForm.action === '停课' ? '停课可留空' : '如：物理'"></label><label>教师<input class="form-input" v-model="changeForm.teacher_name"></label><label>教室<input class="form-input" v-model="changeForm.room"></label><label class="form-grid-wide">说明<textarea class="form-textarea" rows="2" v-model="changeForm.note" placeholder="如：与周三第2节对调"></textarea></label></div><div class="modal-actions"><button class="btn btn-outline" @click="showChangeEditor = false">取消</button><button class="btn btn-primary" :disabled="saving" @click="saveChange"><Save :size="14" /> 保存变更</button></div></div></div>

    <div v-if="importPreview" class="modal-overlay show" @click.self="importPreview = null"><div class="modal modal-wide"><div class="modal-title-row"><div><div class="modal-kicker">Excel 导入预览</div><h3>{{ importPreview.filename || '课程表' }}</h3></div><button class="icon-button" @click="importPreview = null"><X :size="18" /></button></div><div class="preview-counts"><span>共 {{ importPreview.summary.total }} 行</span><span class="success">有效 {{ importPreview.summary.valid }}</span><span class="danger" v-if="importPreview.summary.invalid">无效 {{ importPreview.summary.invalid }}</span></div><div class="table-wrap timetable-preview-table"><table class="data-table"><thead><tr><th>行</th><th>星期</th><th>节次</th><th>科目</th><th>教师</th><th>教室</th><th>单双周</th><th>动作</th><th>说明</th></tr></thead><tbody><tr v-for="row in previewRows" :key="row.row" :class="{ 'preview-error-row': !row.valid }"><td>{{ row.row }}</td><td>{{ weekdays[(row.weekday || 1) - 1] || '—' }}</td><td>{{ row.period_no }}</td><td>{{ row.subject }}</td><td>{{ row.teacher_name || '—' }}</td><td>{{ row.room || '—' }}</td><td>{{ row.week_pattern }}</td><td>{{ row.action }}</td><td>{{ row.error || '校验通过' }}</td></tr></tbody></table></div><div class="modal-actions"><button class="btn btn-outline" @click="importPreview = null">取消</button><button class="btn btn-primary" :disabled="committing || !commitRows.length" @click="commitImport">{{ committing ? '导入中…' : `确认导入 ${commitRows.length} 项` }}</button></div></div></div>
  </div>
</template>

<style scoped>
.timetable-page { max-width: 1400px; margin: 0 auto; }
.timetable-segmented { margin-bottom: 16px; }
.timetable-toolbar { flex-wrap: wrap; }
.timetable-toolbar .form-select { min-width: 150px; width: auto; }
.timetable-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
.timetable-action-card { display: flex; align-items: center; gap: 11px; padding: 14px; border: 1px solid var(--border); text-align: left; color: var(--text); cursor: pointer; }
.timetable-action-card > span { display: grid; flex: 1; gap: 3px; }
.timetable-action-card small { color: var(--text-secondary); font-size: 11px; }
.timetable-week-card { overflow: hidden; }
.timetable-section-heading { align-items: center; margin-bottom: 16px; }
.timetable-section-heading h2 { margin: 0; font-size: 18px; letter-spacing: -0.02em; }
.timetable-grid-scroll { width: 100%; overflow-x: auto; overscroll-behavior-x: contain; padding-bottom: 2px; }
.timetable-grid { display: grid; grid-template-columns: 104px repeat(7, minmax(96px, 1fr)); min-width: 776px; border: 1px solid var(--border-light); border-radius: 12px; overflow: hidden; background: var(--border-light); gap: 1px; }
.timetable-grid-head { padding: 12px 8px; background: var(--surface-subtle, #f8f8fa); color: var(--text-secondary); font-size: 12px; font-weight: 650; letter-spacing: 0.02em; text-align: center; }
.timetable-period-head { color: var(--text-tertiary); }
.timetable-period-cell { display: grid; align-content: center; justify-items: center; gap: 4px; min-height: 84px; padding: 8px 6px; background: var(--surface-subtle, #f8f8fa); text-align: center; }
.timetable-period-cell strong { color: var(--text); font-size: 12px; }
.timetable-period-cell small,.timetable-period-cell em { color: var(--text-tertiary); font-size: 10px; font-style: normal; white-space: nowrap; }
.timetable-period-cell em { color: var(--primary); }
.timetable-cell { display: grid; place-items: center; min-height: 84px; padding: 8px; border: 0; background: var(--surface); color: var(--text); text-align: center; cursor: pointer; }
.timetable-cell:hover { background: var(--primary-bg); }
.timetable-cell:focus-visible { position: relative; z-index: 1; outline: 3px solid var(--primary); outline-offset: -3px; }
.timetable-entry { display: grid; justify-items: center; align-content: center; gap: 3px; width: 100%; min-width: 0; min-height: 38px; box-sizing: border-box; padding: 6px 5px; border: 1px solid var(--entry-border, rgba(86, 99, 182, 0.12)); border-radius: 9px; background: var(--entry-bg, var(--primary-bg)); text-align: center; }
.timetable-entry strong { overflow: hidden; max-width: 100%; color: var(--entry-ink, var(--text)); font-size: 13px; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
.timetable-entry small { overflow: hidden; color: var(--text-secondary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.timetable-entry em { width: max-content; max-width: 100%; padding: 1px 5px; border-radius: 5px; background: rgba(255, 255, 255, 0.58); color: var(--entry-ink, var(--primary)); font-size: 10px; font-style: normal; font-weight: 600; }
.subject-tone-rose { --entry-bg: #fff0ee; --entry-border: #f4c7be; --entry-ink: #994134; }
.subject-tone-blue { --entry-bg: #edf2ff; --entry-border: #cbd8ff; --entry-ink: #324f9c; }
.subject-tone-mint { --entry-bg: #eaf8f2; --entry-border: #c2e5d2; --entry-ink: #216044; }
.subject-tone-violet { --entry-bg: #f2edff; --entry-border: #d9caff; --entry-ink: #6547a8; }
.subject-tone-amber { --entry-bg: #fff7e5; --entry-border: #f2d79d; --entry-ink: #83580b; }
.subject-tone-teal { --entry-bg: #e8f7f6; --entry-border: #b9e1dd; --entry-ink: #17615f; }
.subject-tone-aqua { --entry-bg: #eaf7ff; --entry-border: #c1e4f7; --entry-ink: #1d5f86; }
.subject-tone-orange { --entry-bg: #fff0e6; --entry-border: #f6cbb1; --entry-ink: #9a4d1f; }
.subject-tone-cyan { --entry-bg: #eaf8fb; --entry-border: #bde5ea; --entry-ink: #1d6470; }
.subject-tone-slate { --entry-bg: #f1f3f6; --entry-border: #d6dbe4; --entry-ink: #475467; }
.subject-tone-pink { --entry-bg: #fff0f7; --entry-border: #f1c6da; --entry-ink: #8d3c65; }
.subject-tone-indigo { --entry-bg: #eef0fb; --entry-border: #ccd1f1; --entry-ink: #4b58a8; }
.subject-tone-green { --entry-bg: #eef8e9; --entry-border: #c8e1bb; --entry-ink: #3b6730; }
.subject-tone-lime { --entry-bg: #f4f8e8; --entry-border: #d9e6b3; --entry-ink: #5e711f; }
.timetable-empty { display: block; width: 100%; min-height: 32px; }
.timetable-lower-grid { display: grid; grid-template-columns: 1.3fr .7fr; gap: 16px; margin-top: 16px; }
.day-meta { display: flex; align-items: center; gap: 8px; padding: 8px 0; font-size: 13px; color: var(--text-secondary); border-bottom: 1px solid var(--border-light); margin-bottom: 8px; }
.day-course-row { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border-light); }
.day-course-row.changed { background: var(--warning-bg, #fff8e1); margin: 0 -16px; padding-left: 16px; padding-right: 16px; }
.day-course-row.cancelled { background: var(--bg); opacity: .5; }
.day-course-time { min-width: 60px; display: grid; gap: 3px; }
.day-course-time small { color: var(--text-tertiary); font-size: 10px; }
.day-course-copy { display: grid; gap: 3px; }
.day-course-copy em { color: var(--warning, #f59e0b); font-style: normal; font-size: 12px; }
.day-course-copy small { color: var(--text-tertiary); font-size: 11px; }
.change-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--border-light); }
.change-row > div { display: grid; gap: 3px; }
.change-row strong { font-size: 13px; }
.change-row span { color: var(--text-secondary); font-size: 12px; }
.period-list { margin-bottom: 14px; max-height: 260px; overflow: auto; }
.period-row { display: flex; align-items: center; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid var(--border-light); }
.period-row span { display: grid; gap: 3px; }
.period-row small { color: var(--text-secondary); font-size: 12px; }
.timetable-preview-table { max-height: 320px; overflow: auto; }
.preview-counts { display: flex; gap: 12px; margin-bottom: 10px; font-size: 13px; }
.preview-error-row { background: var(--danger-bg, #fef2f2); }
.tag-green { display: inline-block; padding: 2px 7px; border-radius: 6px; background: var(--success-bg, #ecfdf5); color: var(--success, #10b981); font-size: 11px; }
.tag-gray { display: inline-block; padding: 2px 7px; border-radius: 6px; background: var(--bg); color: var(--text-tertiary); font-size: 11px; }
.tag-blue { display: inline-block; padding: 2px 7px; border-radius: 6px; background: var(--primary-bg); color: var(--primary); font-size: 11px; }

.my-classes-card { margin-bottom: 16px; }
.my-classes-list { display: flex; flex-wrap: wrap; gap: 8px; }
.my-class-row { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
.my-class-info { display: flex; align-items: center; gap: 6px; }
.my-class-name { font-size: 13px; font-weight: 500; }
.my-class-role { color: var(--text-secondary); font-size: 11px; }
.my-class-subjects { color: var(--text-tertiary); font-size: 11px; }
.my-class-remove { padding: 4px 6px; }

.my-agenda-card { margin-bottom: 16px; }
.my-agenda-grouped { display: grid; gap: 16px; }
.my-agenda-date-group { border: 1px solid var(--border-light); border-radius: 10px; overflow: hidden; }
.my-agenda-date-label { padding: 8px 12px; background: var(--surface-subtle, #f8f8fa); font-size: 13px; font-weight: 600; color: var(--text-secondary); }
.my-agenda-item { display: flex; gap: 12px; padding: 10px 12px; border-top: 1px solid var(--border-light); }
.my-agenda-item.my-agenda-change { background: var(--warning-bg, #fff8e1); }
.my-agenda-time { min-width: 60px; display: grid; gap: 2px; }
.my-agenda-time strong { font-size: 13px; }
.my-agenda-time small { color: var(--text-tertiary); font-size: 11px; }
.my-agenda-body { display: grid; gap: 3px; }
.my-agenda-subject-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.my-agenda-subject-row strong { font-size: 13px; }
.my-agenda-class-tag { font-size: 10px; }
.my-agenda-action { color: var(--warning, #f59e0b); font-size: 11px; font-style: normal; font-weight: 500; }
.my-agenda-pattern { color: var(--primary); font-size: 11px; font-style: normal; font-weight: 500; }
.my-agenda-meta { color: var(--text-secondary); font-size: 12px; }
.my-agenda-note { color: var(--text-tertiary); font-size: 11px; }

.my-exams-card { margin-bottom: 16px; }
.my-exam-list { display: grid; gap: 8px; }
.my-exam-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border-light); }
.my-exam-date { min-width: 80px; font-size: 13px; }
.my-exam-body { display: flex; align-items: center; gap: 6px; }
.my-exam-body strong { font-size: 13px; }

@media (max-width: 800px) {
  .timetable-actions { grid-template-columns: 1fr; }
  .timetable-lower-grid { grid-template-columns: 1fr; }
  .my-classes-list { flex-direction: column; }
  .my-class-row { width: 100%; justify-content: space-between; }
}
</style>
