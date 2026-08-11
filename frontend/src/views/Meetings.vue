<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { CalendarPlus, CheckCircle2, ClipboardList, FileText, Plus, Trash2, Users } from 'lucide-vue-next'
import { del, get, post } from '../api'
import { useConfirmDialog } from '../composables/confirmDialog'

const meetings = ref([])
const students = ref([])
const templates = ref([])
const selectedId = ref(null)
const showForm = ref(false)
const loading = ref(true)
const saving = ref(false)
const notice = ref('')
const error = ref('')
const templateName = ref('')
const form = reactive({
  held_on: today(), topic: '', format: '主题班会', content: '', participation: '', conclusion: '',
  student_ids: [], action_items: [],
})
const action = reactive({ title: '', due_at: '' })
const { confirm: confirmDialog } = useConfirmDialog()

function today() {
  return new Date().toISOString().slice(0, 10)
}

const selected = computed(() => meetings.value.find(item => item.id === selectedId.value) || null)

async function load() {
  loading.value = true
  try {
    const [meetingData, studentData, templateData] = await Promise.all([
      get('/api/education/meetings'), get('/api/students'), get('/api/education/templates'),
    ])
    meetings.value = meetingData.meetings || []
    students.value = studentData.students || []
    templates.value = templateData.meetings || []
    if (!selectedId.value && meetings.value.length) selectedId.value = meetings.value[0].id
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function resetForm() {
  Object.assign(form, {
    held_on: today(), topic: '', format: '主题班会', content: '', participation: '', conclusion: '',
    student_ids: [], action_items: [],
  })
  Object.assign(action, { title: '', due_at: '' })
}

function applyTemplate() {
  const item = templates.value.find(template => template.id === Number(form.template_id))
  if (!item) return
  form.format = item.format
  if (!form.content) form.content = item.content
}

function addAction() {
  if (!action.title.trim()) return
  form.action_items.push({ title: action.title.trim(), due_at: action.due_at })
  Object.assign(action, { title: '', due_at: '' })
}

function removeAction(index) {
  form.action_items.splice(index, 1)
}

function toggleStudent(id) {
  const index = form.student_ids.indexOf(id)
  if (index >= 0) form.student_ids.splice(index, 1)
  else form.student_ids.push(id)
}

async function save() {
  if (!form.topic.trim()) return
  saving.value = true
  error.value = ''
  try {
    const result = await post('/api/education/meetings', { ...form, template_id: form.template_id || null })
    notice.value = '班会记录已保存，行动项已进入待办跟进。'
    showForm.value = false
    selectedId.value = result.id
    resetForm()
    await load()
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

async function saveTemplate() {
  if (!templateName.value.trim()) return
  try {
    await post('/api/education/templates', { kind: 'meeting', name: templateName.value, format: '主题班会' })
    templateName.value = ''
    notice.value = '班会模板已保存。'
    await load()
  } catch (e) { error.value = e.message }
}

async function removeMeeting() {
  if (!selected.value || !(await confirmDialog({ title: '删除班会记录？', message: '记录会进入回收站，行动项也会一并处理。', confirmText: '移入回收站' }))) return
  try {
    await del(`/api/education/meetings/${selected.value.id}`)
    selectedId.value = null
    notice.value = '班会记录已移入回收站。'
    await load()
  } catch (e) { error.value = e.message }
}

onMounted(load)
</script>

<template>
  <div class="education-page">
    <div class="page-title-bar">
      <div><div class="page-title">班会记录</div><div class="page-subtitle">记录结论、参与学生，并把后续行动接入统一待办</div></div>
      <div class="toolbar" style="margin-bottom:0"><button class="btn btn-primary" @click="showForm = !showForm"><CalendarPlus :size="14" /> 新建班会</button></div>
    </div>
    <div v-if="notice" class="inline-message success-message">{{ notice }}</div>
    <div v-if="error" class="inline-message error-message">{{ error }}</div>

    <div v-if="showForm" class="card education-form-card">
      <div class="card-title">新建班会</div>
      <div class="form-grid education-form-grid">
        <label>日期<input v-model="form.held_on" class="form-input" type="date"></label>
        <label>主题<input v-model="form.topic" class="form-input" placeholder="例如：新学期班级规则共建"></label>
        <label>形式<select v-model="form.format" class="form-select"><option>主题班会</option><option>事务通知</option><option>团队活动</option><option>安全教育</option><option>心理健康</option></select></label>
        <label>套用模板<select v-model="form.template_id" class="form-select" @change="applyTemplate"><option value="">不套用模板</option><option v-for="item in templates" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      </div>
      <div class="form-grid education-text-grid">
        <label>主要内容<textarea v-model="form.content" class="form-input" rows="4"></textarea></label>
        <label>学生参与情况<textarea v-model="form.participation" class="form-input" rows="4"></textarea></label>
        <label>会议结论<textarea v-model="form.conclusion" class="form-input" rows="4"></textarea></label>
      </div>
      <div class="education-section-title"><Users :size="15" /> 参与学生（{{ form.student_ids.length }}）</div>
      <div class="student-check-grid">
        <label v-for="student in students" :key="student.id" class="student-check"><input type="checkbox" :checked="form.student_ids.includes(student.id)" @change="toggleStudent(student.id)"><span>{{ student.姓名 }} · {{ student.学号 }}</span></label>
      </div>
      <div class="education-section-title"><ClipboardList :size="15" /> 行动项</div>
      <div class="inline-form"><input v-model="action.title" class="form-input" placeholder="例如：下周完成家长回执统计"><input v-model="action.due_at" class="form-input" type="date"><button class="btn btn-outline" type="button" @click="addAction"><Plus :size="14" /> 添加行动</button></div>
      <div v-if="form.action_items.length" class="action-list"><div v-for="(item, index) in form.action_items" :key="`${item.title}-${index}`" class="action-row"><span>{{ item.title }}</span><span class="hint">{{ item.due_at || '未设截止日期' }}</span><button class="btn btn-sm btn-outline" @click="removeAction(index)">移除</button></div></div>
      <div class="modal-actions"><button class="btn btn-outline" @click="showForm = false">取消</button><button class="btn btn-primary" :disabled="saving || !form.topic.trim()" @click="save">{{ saving ? '保存中...' : '保存班会' }}</button></div>
    </div>

    <div class="education-layout">
      <div class="card education-list-card">
        <div class="card-title">班会历史 <span class="count-badge">{{ meetings.length }}</span></div>
        <div v-if="loading" class="loading">加载中...</div>
        <div v-else-if="!meetings.length" class="empty-state">还没有班会记录</div>
        <button v-for="item in meetings" :key="item.id" class="education-list-item" :class="{ active: selectedId === item.id }" @click="selectedId = item.id"><span class="education-list-date">{{ item.held_on }}</span><strong>{{ item.topic }}</strong><span class="hint">{{ item.format }} · {{ item.participant_count }} 人 · {{ item.actions.length }} 项行动</span></button>
      </div>
      <div class="card education-detail-card">
        <div v-if="!selected" class="empty-state">选择一条班会记录查看详情</div>
        <template v-else>
          <div class="detail-header"><div><div class="card-title">{{ selected.topic }}</div><div class="hint">{{ selected.held_on }} · {{ selected.format }} <span v-if="selected.legacy" class="status-pill warning">旧表迁移</span></div></div><button class="btn btn-sm btn-danger" @click="removeMeeting"><Trash2 :size="13" /> 删除</button></div>
          <div class="detail-block"><h4>会议内容</h4><p>{{ selected.content || '未填写' }}</p></div>
          <div class="detail-block"><h4>学生参与</h4><p>{{ selected.participation || '未填写' }}</p><div v-if="selected.participants.length" class="chip-list"><span v-for="student in selected.participants" :key="student.student_id" class="chip"><Users :size="12" /> {{ student.student_name }}</span></div></div>
          <div class="detail-block"><h4>会议结论</h4><p>{{ selected.conclusion || '未填写' }}</p></div>
          <div class="detail-block"><h4>行动项</h4><div v-if="!selected.actions.length" class="hint">暂无行动项</div><div v-for="item in selected.actions" :key="item.id" class="action-row"><span><CheckCircle2 :size="14" class="success-icon" /> {{ item.title }}</span><span class="hint">{{ item.due_at || '未设截止日期' }} · {{ item.status }}</span></div></div>
        </template>
      </div>
    </div>
    <div class="card template-strip"><div><div class="card-title">班会模板</div><div class="hint">把常用主题和形式保存下来，减少重复录入。</div></div><div class="inline-form"><input v-model="templateName" class="form-input" placeholder="模板名称"><button class="btn btn-outline" @click="saveTemplate"><FileText :size="14" /> 保存模板</button></div></div>
  </div>
</template>

<style scoped>
.education-page { max-width: 1180px; margin: 0 auto; }
.education-layout { display: grid; grid-template-columns: minmax(260px, .8fr) minmax(0, 1.6fr); gap: 16px; margin-top: 16px; }
.education-list-card, .education-detail-card { min-width: 0; }
.education-list-item { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 12px; border: 1px solid transparent; border-radius: 10px; background: transparent; text-align: left; cursor: pointer; color: var(--text); }
.education-list-item:hover, .education-list-item.active { background: var(--primary-bg); border-color: rgba(91,106,191,.18); }
.education-list-date { color: var(--primary); font-size: 12px; }
.education-form-card { margin-top: 16px; }
.education-form-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.education-text-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.education-section-title { display: flex; align-items: center; gap: 6px; margin: 16px 0 8px; font-weight: 650; font-size: 13px; }
.student-check-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.student-check { display: flex; align-items: center; gap: 6px; padding: 7px 9px; background: var(--bg); border-radius: 8px; font-size: 12px; }
.student-check input { accent-color: var(--primary); }
.inline-form { display: flex; gap: 8px; align-items: center; }
.inline-form .form-input { min-width: 0; }
.action-list { display: grid; gap: 6px; margin-top: 8px; }
.action-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; background: var(--bg); border-radius: 8px; font-size: 13px; }
.detail-header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.detail-block { padding: 14px 0; border-bottom: 1px solid var(--border); }
.detail-block:last-child { border-bottom: 0; }
.detail-block h4 { font-size: 13px; margin-bottom: 6px; }
.detail-block p { white-space: pre-wrap; color: var(--text-secondary); font-size: 13px; }
.chip-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 7px; border-radius: 99px; background: var(--primary-bg); color: var(--primary); font-size: 12px; }
.success-icon { color: var(--success); vertical-align: -2px; }
.template-strip { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 16px; }
.count-badge { padding: 2px 6px; border-radius: 99px; background: var(--primary-bg); color: var(--primary); font-size: 11px; }
.status-pill { margin-left: 6px; padding: 2px 6px; border-radius: 99px; font-size: 11px; }
.status-pill.warning { color: #9a6500; background: var(--warning-bg); }
@media (max-width: 800px) { .education-layout, .education-form-grid, .education-text-grid { grid-template-columns: 1fr; } .template-strip { align-items: stretch; flex-direction: column; } .inline-form { flex-wrap: wrap; } }
</style>
