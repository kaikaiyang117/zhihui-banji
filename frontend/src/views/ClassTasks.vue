<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Check, ClipboardList, ListChecks, Paperclip, Plus, Trash2 } from 'lucide-vue-next'
import { del, get, post, put, upload } from '../api'

const route = useRoute()
const sourceId = Number(route.query.source_id || 0)
const students = ref([])
const tasks = ref([])
const templates = ref([])
const activeId = ref(null)
const creating = ref(false)
const managingTemplates = ref(false)
const closing = ref(false)
const saving = ref(false)
const bulkUpdating = ref(false)
const message = ref('')
const studentKeyword = ref('')
const itemFilter = ref('未提交')
const selectedItemIds = ref([])
const closeDraft = ref({ result: '', confirm_incomplete: false })
const templateForm = ref({ name: '', task_type: '材料收集', material_name: '', description: '', default_due_days: 7 })
const form = ref({ title: '', task_type: '材料收集', start_at: '', due_at: '', material_name: '', description: '', student_ids: [], template_id: null })
const activeTask = computed(() => tasks.value.find(task => task.id === activeId.value))
const filteredStudents = computed(() => {
  const keyword = studentKeyword.value.trim().toLowerCase()
  if (!keyword) return students.value
  return students.value.filter(student => `${student.姓名}${student.学号}`.toLowerCase().includes(keyword))
})
const itemCounts = computed(() => {
  const items = activeTask.value?.items || []
  return {
    all: items.length,
    未提交: items.filter(item => item.status === '未提交').length,
    已提交: items.filter(item => item.status === '已提交').length,
    免交: items.filter(item => item.status === '免交').length,
  }
})
const visibleItems = computed(() => {
  const items = activeTask.value?.items || []
  return itemFilter.value === '全部' ? items : items.filter(item => item.status === itemFilter.value)
})
const allVisibleItemsSelected = computed(() => (
  visibleItems.value.length > 0
  && visibleItems.value.every(item => selectedItemIds.value.includes(item.student_id))
))
const selectionActionLabel = computed(() => {
  if (allVisibleItemsSelected.value) return '取消选择'
  if (itemFilter.value === '全部') return '选择全部'
  return `选择${itemFilter.value}`
})

function localDate(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const pad = value => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function resetForm() {
  form.value = { title: '', task_type: '材料收集', start_at: '', due_at: '', material_name: '', description: '', student_ids: [], template_id: null }
  studentKeyword.value = ''
}

function toggleCreate() {
  creating.value = !creating.value
  if (creating.value) {
    resetForm()
    selectAllStudents()
  }
}

async function load() {
  const taskPath = sourceId ? `/api/class-tasks?source_id=${sourceId}` : '/api/class-tasks'
  const [taskData, studentData, templateData] = await Promise.all([
    get(taskPath), get('/api/students'), get('/api/class-task-templates'),
  ])
  tasks.value = taskData.tasks || []
  students.value = studentData.students || []
  templates.value = templateData.templates || []
  if ((!activeId.value || sourceId) && tasks.value.length) activeId.value = sourceId || tasks.value[0].id
}

function selectAllStudents() { form.value.student_ids = students.value.map(student => student.id) }
function selectVisibleStudents() {
  const ids = new Set(form.value.student_ids)
  filteredStudents.value.forEach(student => ids.add(student.id))
  form.value.student_ids = [...ids]
}
function clearAll() { form.value.student_ids = [] }

function applyTemplate() {
  const template = templates.value.find(item => item.id === Number(form.value.template_id))
  if (!template) return
  form.value.task_type = template.task_type
  form.value.material_name = template.material_name
  form.value.description = template.description
  form.value.due_at = localDate(template.default_due_days)
}

async function createTask() {
  if (!form.value.title.trim()) {
    message.value = '请填写任务名称'
    return
  }
  if (!form.value.student_ids.length) {
    message.value = '请至少选择一名参与学生'
    return
  }
  saving.value = true
  try {
    const result = await post('/api/class-tasks', form.value)
    message.value = '班级任务已创建'
    creating.value = false
    activeId.value = result.task_id
    resetForm()
    await load()
  } catch (error) { message.value = `创建失败：${error.message}` } finally { saving.value = false }
}

async function createTemplate() {
  if (!templateForm.value.name.trim()) return
  try {
    await post('/api/class-task-templates', templateForm.value)
    templateForm.value = { name: '', task_type: '材料收集', material_name: '', description: '', default_due_days: 7 }
    message.value = '模板已保存'
    await load()
  } catch (error) { message.value = `模板保存失败：${error.message}` }
}

async function markSubmitted(item) {
  try {
    await put(`/api/class-tasks/${item.task_id}/items/${item.student_id}`, {
      status: item.status === '已提交' ? '未提交' : '已提交', note: item.note || '',
    })
    await load()
  } catch (error) { message.value = `更新失败：${error.message}` }
}

async function uploadAttachment(event, item) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || !activeTask.value) return
  try {
    await upload(`/api/class-tasks/${activeTask.value.id}/attachments/${item.student_id}`, file)
    message.value = `${item.姓名}的材料已上传`
    await load()
  } catch (error) { message.value = `上传失败：${error.message}` }
}

function openClose() {
  closeDraft.value = {
    result: activeTask.value?.missing_count ? '' : '已收齐全部材料',
    confirm_incomplete: false,
  }
  closing.value = true
}

async function submitClose() {
  if (!closeDraft.value.result.trim() || !activeTask.value) return
  try {
    await put(`/api/class-tasks/${activeTask.value.id}`, {
      status: '已完成', ...closeDraft.value,
    })
    closing.value = false
    message.value = '任务已完成并记录结果'
    await load()
  } catch (error) {
    message.value = `完成失败：${error.message}`
    if (error.detail?.missing_students) closeDraft.value.confirm_incomplete = true
  }
}

function setItemFilter(value) {
  itemFilter.value = value
  selectedItemIds.value = []
}

function toggleVisibleItems() {
  if (allVisibleItemsSelected.value) {
    const visibleIds = new Set(visibleItems.value.map(item => item.student_id))
    selectedItemIds.value = selectedItemIds.value.filter(id => !visibleIds.has(id))
    return
  }
  const ids = new Set(selectedItemIds.value)
  visibleItems.value.forEach(item => ids.add(item.student_id))
  selectedItemIds.value = [...ids]
}

async function bulkUpdateItems(status) {
  if (!activeTask.value || !selectedItemIds.value.length) return
  bulkUpdating.value = true
  try {
    const count = selectedItemIds.value.length
    await put(`/api/class-tasks/${activeTask.value.id}/items/bulk`, {
      student_ids: selectedItemIds.value, status,
    })
    message.value = `已批量标记 ${count} 名学生`
    selectedItemIds.value = []
    await load()
  } catch (error) { message.value = `批量更新失败：${error.message}`
  } finally { bulkUpdating.value = false }
}

async function removeTask() {
  if (!activeTask.value || !confirm(`删除“${activeTask.value.title}”并移入回收站吗？`)) return
  await del(`/api/records/class_task/${activeTask.value.id}`)
  activeId.value = null
  await load()
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div><div class="page-title">班级任务</div><div class="page-subtitle">一次布置，逐人追踪材料与完成凭证</div></div>
      <div class="toolbar" style="margin-bottom:0"><button class="btn btn-outline" @click="managingTemplates = !managingTemplates">任务模板</button><button class="btn btn-primary" @click="toggleCreate"><Plus :size="14" /> 新建任务</button></div>
    </div>
    <div v-if="message" class="inline-message">{{ message }}</div>

    <div v-if="managingTemplates" class="card task-create-card">
      <div class="card-title">常用任务模板</div>
      <div class="form-grid">
        <label>模板名称<input class="form-input" v-model="templateForm.name" placeholder="如：家长回执"></label>
        <label>任务类型<select class="form-select" v-model="templateForm.task_type"><option>材料收集</option><option>通知确认</option><option>班级活动</option></select></label>
        <label>材料名称<input class="form-input" v-model="templateForm.material_name"></label>
        <label>默认截止天数<input class="form-input" type="number" min="0" max="366" v-model.number="templateForm.default_due_days"></label>
        <label class="form-grid-wide">说明<textarea class="form-textarea" v-model="templateForm.description" rows="2"></textarea></label>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" @click="createTemplate">保存模板</button></div>
      <div v-if="templates.length" class="hint">{{ templates.map(item => item.name).join('、') }}</div>
    </div>

    <div v-if="creating" class="card task-create-card">
      <div class="card-title">新建班级任务</div>
      <div class="form-grid">
        <label>套用模板<select class="form-select" v-model="form.template_id" @change="applyTemplate"><option :value="null">不使用模板</option><option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option></select></label>
        <label>任务名称<input class="form-input" v-model="form.title" placeholder="如：收齐家长回执"></label>
        <label>任务类型<select class="form-select" v-model="form.task_type"><option>材料收集</option><option>通知确认</option><option>班级活动</option></select></label>
        <label>截止日期<input class="form-input" type="date" v-model="form.due_at"></label>
        <label>材料名称<input class="form-input" v-model="form.material_name"></label>
        <label class="form-grid-wide">说明<textarea class="form-textarea" v-model="form.description" rows="2"></textarea></label>
      </div>
      <div class="student-picker"><div class="picker-head"><strong>参与学生</strong><span>{{ form.student_ids.length }} / {{ students.length }} 人</span><button class="text-button" @click="selectVisibleStudents">选择这些</button><button class="text-button" @click="clearAll">清空选择</button></div><input v-model="studentKeyword" class="form-input task-student-search" placeholder="搜索学生姓名或学号"><div class="student-picker-list"><label v-for="student in filteredStudents" :key="student.id" class="student-check"><input v-model="form.student_ids" type="checkbox" :value="student.id"> {{ student.姓名 }}<small>{{ student.学号 }}</small></label><span v-if="!filteredStudents.length" class="hint">没有匹配的学生</span></div></div>
      <div class="modal-actions"><button class="btn btn-outline" @click="creating = false">取消</button><button class="btn btn-primary" :disabled="saving" @click="createTask">{{ saving ? '保存中…' : '创建任务' }}</button></div>
    </div>

    <div class="class-task-layout">
      <div class="card"><div class="card-title"><ClipboardList :size="16" /> 任务列表 <span class="count">{{ tasks.length }}</span></div><div v-if="!tasks.length" class="empty-state">还没有班级任务</div><button v-for="task in tasks" :key="task.id" class="class-task-row" :class="{ active: task.id === activeId, 'source-highlight': task.id === sourceId }" @click="activeId = task.id"><div><strong>{{ task.title }}</strong><small>{{ task.task_type }} · {{ task.timing_state }} · {{ task.due_at || '未设置截止日期' }}</small></div><span class="task-progress">{{ task.submitted }}/{{ task.total }}</span></button></div>
      <div class="card">
        <div v-if="activeTask" class="card-title"><span>{{ activeTask.title }}</span><span class="tag" :class="activeTask.status === '已完成' ? 'tag-green' : activeTask.timing_state === '已逾期' ? 'tag-red' : 'tag-orange'">{{ activeTask.status === '进行中' ? activeTask.timing_state : activeTask.status }}</span><button v-if="activeTask.can_close" class="btn btn-outline task-close" @click="openClose"><Check :size="14" /> 完成任务</button><button class="btn btn-outline" aria-label="删除班级任务" @click="removeTask"><Trash2 :size="14" /></button></div>
        <div v-if="activeTask" class="task-detail"><div class="hint">{{ activeTask.material_name || '无指定材料' }} · {{ activeTask.description || '无补充说明' }} · {{ activeTask.progress }}%</div><div class="task-progress-bar"><i :style="{ width: `${activeTask.progress}%` }"></i></div><div class="task-item-toolbar"><div class="task-status-tabs"><button v-for="filter in [['未提交', itemCounts.未提交], ['已提交', itemCounts.已提交], ['免交', itemCounts.免交], ['全部', itemCounts.all]]" :key="filter[0]" class="filter-pill" :class="{ active: itemFilter === filter[0] }" @click="setItemFilter(filter[0])">{{ filter[0] }} {{ filter[1] }}</button></div><div v-if="activeTask.status === '进行中' && visibleItems.length" class="task-bulk-actions"><button class="task-selection-toggle" :class="{ active: allVisibleItemsSelected }" :title="selectionActionLabel" :aria-label="selectionActionLabel" @click="toggleVisibleItems"><ListChecks :size="15" aria-hidden="true" /><span>{{ selectionActionLabel }}</span></button><span v-if="selectedItemIds.length" class="hint">已选 {{ selectedItemIds.length }} 人</span><button v-if="selectedItemIds.length" class="btn btn-sm btn-outline" :disabled="bulkUpdating" @click="bulkUpdateItems('已提交')">标记已提交</button><button v-if="selectedItemIds.length" class="btn btn-sm btn-outline" :disabled="bulkUpdating" @click="bulkUpdateItems('免交')">标记免交</button></div></div><div v-if="activeTask.closed_with_missing_count" class="hint">完成时仍有 {{ activeTask.closed_with_missing_count }} 名学生未提交，已记录为例外关闭</div><div v-for="item in visibleItems" :key="item.id" class="collection-row"><label v-if="activeTask.status === '进行中'" class="task-item-check"><input v-model="selectedItemIds" type="checkbox" :value="item.student_id" :aria-label="`选择${item.姓名}`"></label><div><strong>{{ item.姓名 }}</strong><span>{{ item.学号 }} · {{ item.note || '暂无备注' }}<template v-if="item.submitted_at"> · {{ item.submitted_at }} 提交</template></span><span v-if="item.attachments?.length"><Paperclip :size="12" /> <a v-for="attachment in item.attachments" :key="attachment.id" :href="attachment.download_path" target="_blank">{{ attachment.original_name }}</a></span></div><div class="record-actions"><label class="btn btn-sm btn-outline"><Paperclip :size="13" /> 上传<input type="file" hidden @change="uploadAttachment($event, item)"></label><button class="tag" :class="item.status === '已提交' || item.status === '免交' ? 'tag-green' : 'tag-orange'" @click="markSubmitted(item)">{{ item.status === '已提交' ? '已提交' : item.status === '免交' ? '免交' : '未提交' }}</button></div></div><div v-if="!visibleItems.length" class="empty-state">当前筛选没有学生</div></div><div v-else class="empty-state">选择一个任务查看收集进度</div>
      </div>
    </div>

    <div v-if="closing" class="modal-overlay show" @click.self="closing = false"><div class="modal"><div class="modal-kicker">完成班级任务</div><h3>{{ activeTask?.title }}</h3><p class="hint">请记录本次收集结果；未提交学生可以选择“例外关闭”，系统会保留缺交人数。</p><textarea class="form-textarea" v-model="closeDraft.result" rows="3" placeholder="如：已收齐纸质回执，缺交学生已单独联系"></textarea><label v-if="activeTask?.missing_count" class="student-check"><input type="checkbox" v-model="closeDraft.confirm_incomplete"> 我确认按当前缺交名单关闭任务（{{ activeTask.missing_count }} 人）</label><div class="modal-actions"><button class="btn btn-outline" @click="closing = false">取消</button><button class="btn btn-primary" @click="submitClose">确认完成</button></div></div></div>
  </div>
</template>
