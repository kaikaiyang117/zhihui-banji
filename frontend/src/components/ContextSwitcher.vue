<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { ChevronDown, Settings2, X } from 'lucide-vue-next'
import { clearStoredScope, get, getStoredScope, post, put, setStoredScope } from '../api'

const emit = defineEmits(['ready'])
const loading = ref(true)
const error = ref('')
const contextData = ref({ current: null, classes: [] })
const open = ref(false)
const manageOpen = ref(false)
const selectedClassId = ref('')
const selectedTermId = ref('')
const enrollments = ref([])
const directory = ref([])
const saving = ref(false)
const message = ref('')

const newClass = ref({ name: '', grade: '', term_name: '', start_date: '', end_date: '' })
const newTerm = ref({ name: '', start_date: '', end_date: '' })
const rollover = ref({ name: '', start_date: '', end_date: '' })
const addStudentId = ref('')
const transferTargets = ref({})
const triggerEl = ref(null)
const managerEl = ref(null)

const selectedClass = computed(() => contextData.value.classes.find(item => String(item.id) === String(selectedClassId.value)))
const selectedTerms = computed(() => selectedClass.value?.terms || [])
const selectedTerm = computed(() => selectedTerms.value.find(item => String(item.id) === String(selectedTermId.value)))
const currentLabel = computed(() => {
  if (loading.value) return '正在读取班级…'
  if (!selectedClass.value || !selectedTerm.value) return '选择班级与学期'
  return `${selectedClass.value.name} · ${selectedTerm.value.name}`
})
const transferOptions = computed(() => contextData.value.classes.flatMap(item =>
  (item.terms || [])
    .filter(term => term.status === '进行中' && !(String(item.id) === String(selectedClassId.value) && String(term.id) === String(selectedTermId.value)))
    .map(term => ({ value: `${item.id}:${term.id}`, label: `${item.name} · ${term.name}` }))))
const addableStudents = computed(() => {
  const currentIds = new Set(enrollments.value.map(item => item.student_id))
  return directory.value.filter(item => !currentIds.has(item.id))
})

async function fetchContext() {
  try {
    return await get('/api/context')
  } catch (err) {
    if (!getStoredScope().classId && !getStoredScope().termId) throw err
    clearStoredScope()
    return get('/api/context')
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await fetchContext()
    contextData.value = data
    const stored = getStoredScope()
    const storedClass = data.classes.find(item => String(item.id) === String(stored.classId))
    const storedTerm = storedClass?.terms?.find(item => String(item.id) === String(stored.termId))
    const current = storedTerm ? { class_id: storedClass.id, term_id: storedTerm.id } : data.current
    selectedClassId.value = String(current?.class_id || '')
    selectedTermId.value = String(current?.term_id || '')
    if (selectedClassId.value && selectedTermId.value) {
      setStoredScope(selectedClassId.value, selectedTermId.value)
    }
    const label = selectedClass.value && selectedTerm.value
      ? `${selectedClass.value.name} · ${selectedTerm.value.name}` : '选择班级与学期'
    emit('ready', { ...current, label })
  } catch (err) {
    error.value = err.message || '班级信息加载失败'
  } finally {
    loading.value = false
  }
}

function chooseClass(event) {
  selectedClassId.value = event.target.value
  const active = selectedTerms.value.find(term => term.status === '进行中') || selectedTerms.value[0]
  selectedTermId.value = String(active?.id || '')
}

function notifyContextChanged(classId = selectedClassId.value, termId = selectedTermId.value) {
  window.dispatchEvent(new CustomEvent('workbench-context-change', {
    detail: {
      classId, termId,
      label: selectedClass.value && selectedTerm.value
        ? `${selectedClass.value.name} · ${selectedTerm.value.name}` : '',
    },
  }))
}

async function applyScope() {
  if (!selectedClassId.value || !selectedTermId.value) return
  setStoredScope(selectedClassId.value, selectedTermId.value)
  open.value = false
  notifyContextChanged()
  await load()
}

async function openManager() {
  open.value = false
  manageOpen.value = true
  message.value = ''
  await loadManagerData()
  await nextTick()
  managerEl.value?.focus()
}

async function closeManager() {
  manageOpen.value = false
  await nextTick()
  triggerEl.value?.focus()
}

function handleModalKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeManager()
    return
  }
  if (event.key !== 'Tab' || !managerEl.value) return
  const focusable = [...managerEl.value.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function loadManagerData() {
  const [enrollmentData, directoryData] = await Promise.all([
    get('/api/enrollments'),
    get('/api/students/directory'),
  ])
  enrollments.value = enrollmentData.enrollments || []
  directory.value = directoryData.students || []
}

async function createClass() {
  if (!newClass.value.name.trim() || !newClass.value.term_name.trim()) return
  saving.value = true
  try {
    const result = await post('/api/classes', newClass.value)
    setStoredScope(result.class_id, result.term_id)
    manageOpen.value = false
    notifyContextChanged(result.class_id, result.term_id)
    await load()
  } catch (err) {
    message.value = err.message
  } finally {
    saving.value = false
  }
}

async function saveCurrentClass() {
  if (!selectedClass.value) return
  saving.value = true
  try {
    await put(`/api/classes/${selectedClass.value.id}`, {
      name: selectedClass.value.name,
      grade: selectedClass.value.grade || '',
    })
    message.value = '班级信息已保存'
    await load()
  } catch (err) {
    message.value = err.message
  } finally {
    saving.value = false
  }
}

async function archiveCurrentClass() {
  if (!selectedClass.value || !window.confirm(`确认归档“${selectedClass.value.name}”吗？`)) return
  saving.value = true
  try {
    await put(`/api/classes/${selectedClass.value.id}`, { status: '已归档' })
    message.value = '班级已归档'
    await load()
  } catch (err) {
    message.value = err.message
  } finally {
    saving.value = false
  }
}

async function createTerm() {
  if (!newTerm.value.name.trim() || !selectedClass.value) return
  saving.value = true
  try {
    const result = await post(`/api/classes/${selectedClass.value.id}/terms`, newTerm.value)
    setStoredScope(selectedClass.value.id, result.term_id)
    manageOpen.value = false
    notifyContextChanged(selectedClass.value.id, result.term_id)
    await load()
  } catch (err) {
    message.value = err.message
  } finally {
    saving.value = false
  }
}

async function saveCurrentTerm() {
  if (!selectedTerm.value) return
  saving.value = true
  try {
    await put(`/api/terms/${selectedTerm.value.id}`, {
      name: selectedTerm.value.name,
      start_date: selectedTerm.value.start_date || '',
      end_date: selectedTerm.value.end_date || '',
    })
    message.value = '学期信息已保存'
    await load()
  } catch (err) {
    message.value = err.message
  } finally {
    saving.value = false
  }
}

async function archiveCurrentTerm() {
  if (!selectedTerm.value || !window.confirm(`归档“${selectedTerm.value.name}”后将只能查看，确认继续吗？`)) return
  saving.value = true
  try {
    await put(`/api/terms/${selectedTerm.value.id}`, { status: '已归档' })
    message.value = '学期已归档，当前数据进入只读状态'
    await load()
  } catch (err) {
    message.value = err.message
  } finally {
    saving.value = false
  }
}

async function rolloverCurrentTerm() {
  if (!rollover.value.name.trim() || !selectedTerm.value) return
  saving.value = true
  try {
    const result = await post(`/api/terms/${selectedTerm.value.id}/rollover`, {
      ...rollover.value,
      archive_source: true,
    })
    setStoredScope(result.class_id, result.term_id)
    manageOpen.value = false
    notifyContextChanged(result.class_id, result.term_id)
    await load()
  } catch (err) {
    message.value = err.message
  } finally {
    saving.value = false
  }
}

async function updateEnrollment(item) {
  saving.value = true
  try {
    await put(`/api/enrollments/${item.id}`, { status: item.status })
    message.value = `${item.姓名}的在班状态已更新`
    await loadManagerData()
  } catch (err) {
    message.value = err.message
  } finally {
    saving.value = false
  }
}

async function addExistingStudent() {
  if (!addStudentId.value) return
  saving.value = true
  try {
    await post('/api/enrollments', { student_id: Number(addStudentId.value), status: '在读' })
    addStudentId.value = ''
    message.value = '学生已加入当前班级'
    await loadManagerData()
  } catch (err) {
    message.value = err.message
  } finally {
    saving.value = false
  }
}

async function transferStudent(item) {
  const value = transferTargets.value[item.id]
  if (!value) return
  const [targetClassId, targetTermId] = value.split(':').map(Number)
  if (!window.confirm(`确认将“${item.姓名}”转入所选班级吗？`)) return
  saving.value = true
  try {
    await post(`/api/enrollments/${item.id}/transfer`, {
      target_class_id: targetClassId,
      target_term_id: targetTermId,
    })
    message.value = `${item.姓名}已完成转班`
    await loadManagerData()
  } catch (err) {
    message.value = err.message
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="context-switcher">
    <button ref="triggerEl" class="context-trigger" type="button" :aria-expanded="open" @click="open = !open">
      <span class="context-trigger-text">{{ currentLabel }}</span>
      <span v-if="selectedTerm?.status === '已归档'" class="context-archive-badge">只读</span>
      <ChevronDown :size="14" />
    </button>

    <div v-if="open" class="context-popover">
      <div class="context-popover-title">切换工作范围</div>
      <label>
        <span>班级</span>
        <select :value="selectedClassId" @change="chooseClass">
          <option v-for="item in contextData.classes" :key="item.id" :value="item.id">
            {{ item.name }}{{ item.status === '已归档' ? '（已归档）' : '' }}
          </option>
        </select>
      </label>
      <label>
        <span>学期</span>
        <select v-model="selectedTermId">
          <option v-for="item in selectedTerms" :key="item.id" :value="String(item.id)">
            {{ item.name }} · {{ item.active_student_count }} 人{{ item.status === '已归档' ? '（只读）' : '' }}
          </option>
        </select>
      </label>
      <div v-if="error" class="context-error">{{ error }}</div>
      <button class="context-primary" type="button" :disabled="!selectedTermId" @click="applyScope">切换并刷新</button>
      <button class="context-manage-link" type="button" @click="openManager">
        <Settings2 :size="14" />管理班级、学期与在班学生
      </button>
    </div>
  </div>

  <Teleport to="body">
    <div v-if="manageOpen" class="context-modal-scrim" @click.self="closeManager">
      <section ref="managerEl" class="context-modal" role="dialog" aria-modal="true" aria-labelledby="context-manager-title" tabindex="-1" @keydown="handleModalKeydown">
      <header class="context-modal-head">
        <div>
          <h2 id="context-manager-title">班级与学期管理</h2>
          <p>{{ currentLabel }}</p>
        </div>
        <button class="context-close" type="button" aria-label="关闭" @click="closeManager"><X :size="18" /></button>
      </header>

      <div class="context-modal-body">
        <div v-if="message" class="context-message">{{ message }}</div>

        <section class="context-section">
          <div class="context-section-title">当前班级</div>
          <div class="context-form-grid">
            <label><span>班级名称</span><input v-model="selectedClass.name" :disabled="!selectedClass || saving" /></label>
            <label><span>年级</span><input v-model="selectedClass.grade" :disabled="!selectedClass || saving" /></label>
          </div>
          <div class="context-row-actions">
            <button class="context-secondary" type="button" :disabled="saving" @click="saveCurrentClass">保存班级信息</button>
            <button v-if="selectedClass?.status !== '已归档' && selectedTerms.length && selectedTerms.every(item => item.status === '已归档')" class="context-danger" type="button" :disabled="saving" @click="archiveCurrentClass">归档班级</button>
          </div>
        </section>

        <section class="context-section">
          <div class="context-section-title">当前学期</div>
          <div class="context-form-grid context-form-grid-3">
            <label><span>学期名称</span><input v-model="selectedTerm.name" :disabled="!selectedTerm || saving" /></label>
            <label><span>开始日期</span><input v-model="selectedTerm.start_date" type="date" :disabled="!selectedTerm || saving" /></label>
            <label><span>结束日期</span><input v-model="selectedTerm.end_date" type="date" :disabled="!selectedTerm || saving" /></label>
          </div>
          <div class="context-row-actions">
            <button class="context-secondary" type="button" :disabled="saving" @click="saveCurrentTerm">保存学期信息</button>
            <button v-if="selectedTerm?.status !== '已归档'" class="context-danger" type="button" :disabled="saving" @click="archiveCurrentTerm">归档当前学期</button>
          </div>
        </section>

        <section v-if="selectedClass?.status !== '已归档' && selectedTerm?.status !== '已归档'" class="context-section">
          <div class="context-section-title">学期结转</div>
          <p class="context-section-hint">复制在读学生和考勤规则，历史事件、成绩和待办不会复制；原学期将归档。</p>
          <div class="context-form-grid context-form-grid-3">
            <label><span>新学期名称</span><input v-model="rollover.name" placeholder="例如：2027 春季" /></label>
            <label><span>开始日期</span><input v-model="rollover.start_date" type="date" /></label>
            <label><span>结束日期</span><input v-model="rollover.end_date" type="date" /></label>
          </div>
          <button class="context-primary inline" type="button" :disabled="saving || !rollover.name.trim()" @click="rolloverCurrentTerm">结转并进入新学期</button>
        </section>

        <section v-if="selectedClass?.status !== '已归档'" class="context-section">
          <div class="context-section-title">新增学期</div>
          <p class="context-section-hint">只创建空学期；需要延续学生名单时请使用“学期结转”。</p>
          <div class="context-form-grid context-form-grid-3">
            <label><span>学期名称</span><input v-model="newTerm.name" /></label>
            <label><span>开始日期</span><input v-model="newTerm.start_date" type="date" /></label>
            <label><span>结束日期</span><input v-model="newTerm.end_date" type="date" /></label>
          </div>
          <button class="context-secondary" type="button" :disabled="saving || !newTerm.name.trim()" @click="createTerm">创建并切换</button>
        </section>

        <section class="context-section">
          <div class="context-section-title">在班学生</div>
          <div v-if="selectedTerm?.status !== '已归档'" class="context-add-student">
            <select v-model="addStudentId">
              <option value="">选择已有学生加入当前班级</option>
              <option v-for="item in addableStudents" :key="item.id" :value="item.id">
                {{ item.学号 }} · {{ item.姓名 }}{{ item.memberships ? `（${item.memberships}）` : '' }}
              </option>
            </select>
            <button class="context-secondary" type="button" :disabled="saving || !addStudentId" @click="addExistingStudent">加入</button>
          </div>
          <div class="context-roster">
            <div v-for="item in enrollments" :key="item.id" class="context-roster-row">
              <div><strong>{{ item.姓名 }}</strong><span>{{ item.学号 }}</span></div>
              <select v-model="item.status" :disabled="saving || selectedTerm?.status === '已归档'" @change="updateEnrollment(item)">
                <option>在读</option><option>转出</option><option>毕业</option>
              </select>
              <div v-if="item.status === '在读' && transferOptions.length && selectedTerm?.status !== '已归档'" class="context-transfer">
                <select v-model="transferTargets[item.id]">
                  <option value="">选择转入班级</option>
                  <option v-for="target in transferOptions" :key="target.value" :value="target.value">{{ target.label }}</option>
                </select>
                <button type="button" :disabled="saving || !transferTargets[item.id]" @click="transferStudent(item)">转班</button>
              </div>
            </div>
            <div v-if="!enrollments.length" class="context-empty">当前学期还没有学生。</div>
          </div>
        </section>

        <section class="context-section">
          <div class="context-section-title">新建班级</div>
          <div class="context-form-grid context-form-grid-3">
            <label><span>班级名称</span><input v-model="newClass.name" placeholder="例如：七年级二班" /></label>
            <label><span>年级</span><input v-model="newClass.grade" placeholder="例如：七年级" /></label>
            <label><span>首个学期</span><input v-model="newClass.term_name" placeholder="例如：2026 秋季" /></label>
          </div>
          <button class="context-primary inline" type="button" :disabled="saving || !newClass.name.trim() || !newClass.term_name.trim()" @click="createClass">创建并切换</button>
        </section>
      </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.context-switcher { position: relative; display: flex; align-items: center; min-width: 0; }
.context-trigger { display: inline-flex; align-items: center; gap: 6px; max-width: 260px; height: 36px; padding: 0 11px; border: 1px solid transparent; border-radius: 10px; background: var(--ds-color-surface-subtle); color: var(--ds-color-ink); font: var(--ds-type-label); cursor: pointer; transition: border-color var(--ds-duration-fast) var(--ds-ease-out), background-color var(--ds-duration-fast) var(--ds-ease-out), transform 100ms ease-out; }
.context-trigger:hover { border-color: var(--ds-color-border); background: rgba(255,255,255,.88); }
.context-trigger:active { transform: scale(.98); }
.context-trigger:focus-visible { outline: none; border-color: var(--ds-color-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ds-color-primary) 16%, transparent); }
.context-trigger-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.context-archive-badge { padding: 1px 5px; border-radius: 999px; background: var(--warning-bg); color: #9a6200; font-size: 10px; }
.context-popover { position: absolute; z-index: 320; top: 45px; left: 0; display: grid; width: min(330px, calc(100vw - 24px)); gap: 11px; padding: 16px; border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-card); background: rgba(255,255,255,.98); box-shadow: var(--ds-shadow-overlay); }
.context-popover-title { font-size: 14px; font-weight: 700; }
label { display: grid; gap: 5px; min-width: 0; }
label > span { color: var(--text-secondary); font-size: 11px; }
input, select { width: 100%; min-width: 0; height: 38px; padding: 0 10px; border: 1px solid var(--ds-color-border-strong); border-radius: var(--ds-radius-control); background: var(--ds-color-surface); color: var(--ds-color-ink); font: var(--ds-type-body); outline: none; }
input:focus, select:focus { border-color: var(--ds-color-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ds-color-primary) 16%, transparent); }
.context-primary, .context-secondary, .context-danger, .context-manage-link, .context-transfer button { min-height: 36px; padding: 0 12px; border-radius: 9px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.context-primary { border: 0; background: var(--primary); color: #fff; }
.context-primary.inline { width: fit-content; margin-top: 12px; }
.context-secondary { border: 1px solid var(--border-strong); background: #fff; color: var(--text); }
.context-danger { border: 1px solid rgba(255,59,48,.2); background: var(--danger-bg); color: var(--danger); }
button:disabled { opacity: .45; cursor: default; }
.context-manage-link { display: flex; align-items: center; justify-content: center; gap: 6px; border: 0; background: transparent; color: var(--primary); }
.context-error { color: var(--danger); font-size: 12px; }
.context-modal-scrim { position: fixed; inset: 0; z-index: 650; display: grid; place-items: center; padding: 20px; background: rgba(20,24,38,.34); backdrop-filter: blur(8px); }
.context-modal { display: flex; flex-direction: column; width: min(920px, 100%); max-height: min(820px, calc(100vh - 40px)); overflow: hidden; border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-dialog); background: var(--ds-color-surface); box-shadow: var(--ds-shadow-overlay); }
.context-modal-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 20px 22px 16px; border-bottom: 1px solid var(--border); }
.context-modal-head h2 { font-size: 20px; }
.context-modal-head p { margin-top: 3px; color: var(--text-secondary); font-size: 12px; }
.context-close { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 50%; background: var(--bg); color: var(--text-secondary); cursor: pointer; }
.context-modal-body { overflow-y: auto; padding: 4px 22px 24px; }
.context-message { margin: 14px 0 0; padding: 9px 11px; border-radius: 9px; background: var(--primary-bg); color: var(--primary); font-size: 12px; }
.context-section { padding: 18px 0; border-bottom: 1px solid var(--border); }
.context-section:last-child { border-bottom: 0; }
.context-section-title { margin-bottom: 10px; font-size: 14px; font-weight: 700; }
.context-section-hint { margin: -4px 0 12px; color: var(--text-secondary); font-size: 12px; }
.context-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; margin-bottom: 10px; }
.context-form-grid-3 { grid-template-columns: repeat(3, minmax(0,1fr)); }
.context-row-actions { display: flex; gap: 8px; }
.context-add-student { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; margin-bottom: 10px; }
.context-roster { display: grid; gap: 7px; }
.context-roster-row { display: grid; grid-template-columns: minmax(120px,1fr) 110px minmax(220px,1.4fr); align-items: center; gap: 8px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 10px; }
.context-roster-row > div:first-child { display: flex; align-items: baseline; gap: 7px; }
.context-roster-row strong { font-size: 13px; }
.context-roster-row span { color: var(--text-secondary); font-size: 11px; }
.context-transfer { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 6px; }
.context-transfer button { border: 1px solid var(--border-strong); background: #fff; }
.context-empty { padding: 18px; border-radius: 10px; background: var(--bg); color: var(--text-secondary); font-size: 12px; text-align: center; }
@media (max-width: 760px) {
  .context-switcher { flex: 1 1 auto; min-width: 0; }
  .context-trigger { width: 100%; max-width: none; justify-content: center; }
  .context-popover { position: fixed; top: 96px; left: 10px; right: 10px; width: auto; }
  .context-modal-scrim { align-items: end; padding: 0; }
  .context-modal { max-height: 92vh; border-radius: 22px 22px 0 0; }
  .context-form-grid, .context-form-grid-3 { grid-template-columns: 1fr; }
  .context-roster-row { grid-template-columns: 1fr 100px; }
  .context-transfer { grid-column: 1 / -1; }
}
</style>
