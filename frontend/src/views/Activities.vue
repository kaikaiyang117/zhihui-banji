<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { CalendarDays, ClipboardCheck, FileText, Paperclip, Plus, Trash2, Users } from 'lucide-vue-next'
import { del, get, post, upload, scopedUrl } from '../api'
import { useConfirmDialog } from '../composables/confirmDialog'

const activities = ref([])
const students = ref([])
const templates = ref([])
const selectedId = ref(null)
const { confirm: confirmDialog } = useConfirmDialog()
const showForm = ref(false)
const loading = ref(true)
const saving = ref(false)
const notice = ref('')
const error = ref('')
const templateName = ref('')
const form = reactive({
  occurred_on: today(), name: '', activity_type: '其他', budget: 0, participant_count: 0,
  summary: '', result: '', retrospective: '', status: '计划中', student_ids: [], followup_title: '', followup_due: '',
})

function today() { return new Date().toISOString().slice(0, 10) }
const selected = computed(() => activities.value.find(item => item.id === selectedId.value) || null)

async function load() {
  loading.value = true
  try {
    const [activityData, studentData, templateData] = await Promise.all([
      get('/api/education/activities'), get('/api/students'), get('/api/education/templates'),
    ])
    activities.value = activityData.activities || []
    students.value = studentData.students || []
    templates.value = templateData.activities || []
    if (!selectedId.value && activities.value.length) selectedId.value = activities.value[0].id
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

function resetForm() {
  Object.assign(form, { occurred_on: today(), name: '', activity_type: '其他', budget: 0, participant_count: 0, summary: '', result: '', retrospective: '', status: '计划中', student_ids: [], followup_title: '', followup_due: '' })
}

function applyTemplate() {
  const item = templates.value.find(template => template.id === Number(form.template_id))
  if (!item) return
  form.activity_type = item.activity_type
  if (!form.summary) form.summary = item.description
}

function toggleStudent(id) {
  const index = form.student_ids.indexOf(id)
  if (index >= 0) form.student_ids.splice(index, 1)
  else form.student_ids.push(id)
  form.participant_count = form.student_ids.length
}

async function save() {
  if (!form.name.trim()) return
  saving.value = true; error.value = ''
  try {
    const result = await post('/api/education/activities', { ...form, template_id: form.template_id || null })
    notice.value = '活动记录已保存。'
    showForm.value = false; selectedId.value = result.id; resetForm(); await load()
  } catch (e) { error.value = e.message } finally { saving.value = false }
}

async function saveTemplate() {
  if (!templateName.value.trim()) return
  try {
    await post('/api/education/templates', { kind: 'activity', name: templateName.value, activity_type: '其他' })
    templateName.value = ''; notice.value = '活动模板已保存。'; await load()
  } catch (e) { error.value = e.message }
}

async function handleUpload(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || !selected.value) return
  try {
    await upload(`/api/education/activities/${selected.value.id}/attachments`, file)
    notice.value = '活动材料已上传。'; await load()
  } catch (e) { error.value = e.message }
}

async function removeActivity() {
  if (!selected.value || !(await confirmDialog({ title: '删除活动记录？', message: '记录会进入回收站。', confirmText: '移入回收站' }))) return
  try { await del(`/api/education/activities/${selected.value.id}`); selectedId.value = null; notice.value = '活动记录已移入回收站。'; await load() } catch (e) { error.value = e.message }
}

onMounted(load)
</script>

<template>
  <div class="education-page">
    <div class="page-title-bar">
      <div><div class="page-title">班级活动</div><div class="page-subtitle">记录参与、预算、材料和复盘，把活动后的事情继续跟进</div></div>
      <button class="btn btn-primary" @click="showForm = !showForm"><CalendarDays :size="14" /> 新建活动</button>
    </div>
    <div v-if="notice" class="inline-message success-message">{{ notice }}</div><div v-if="error" class="inline-message error-message">{{ error }}</div>
    <div v-if="showForm" class="card education-form-card">
      <div class="card-title">新建活动</div>
      <div class="form-grid education-form-grid">
        <label>日期<input v-model="form.occurred_on" type="date" class="form-input"></label>
        <label>活动名称<input v-model="form.name" class="form-input" placeholder="例如：校园志愿服务"></label>
        <label>活动类型<select v-model="form.activity_type" class="form-select"><option>文体活动</option><option>社会实践</option><option>志愿服务</option><option>学科竞赛</option><option>节日庆祝</option><option>其他</option></select></label>
        <label>套用模板<select v-model="form.template_id" class="form-select" @change="applyTemplate"><option value="">不套用模板</option><option v-for="item in templates" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <label>预算<input v-model="form.budget" type="number" min="0" step="0.01" class="form-input"></label>
        <label>参与人数<input v-model="form.participant_count" type="number" min="0" class="form-input"></label>
        <label>状态<select v-model="form.status" class="form-select"><option>计划中</option><option>进行中</option><option>已完成</option><option>已复盘</option></select></label>
      </div>
      <div class="form-grid education-text-grid"><label>活动总结<textarea v-model="form.summary" class="form-input" rows="3"></textarea></label><label>执行结果<textarea v-model="form.result" class="form-input" rows="3"></textarea></label><label>活动复盘<textarea v-model="form.retrospective" class="form-input" rows="3"></textarea></label></div>
      <div class="education-section-title"><Users :size="15" /> 参与学生（{{ form.student_ids.length }}）</div>
      <div class="student-check-grid"><label v-for="student in students" :key="student.id" class="student-check"><input type="checkbox" :checked="form.student_ids.includes(student.id)" @change="toggleStudent(student.id)"><span>{{ student.姓名 }} · {{ student.学号 }}</span></label></div>
      <div class="education-section-title"><ClipboardCheck :size="15" /> 复盘跟进工作项（可选）</div>
      <div class="form-grid education-form-grid"><label>工作项标题<input v-model="form.followup_title" class="form-input" placeholder="例如：整理活动照片并归档"></label><label>截止日期<input v-model="form.followup_due" type="date" class="form-input"></label></div>
      <div class="modal-actions"><button class="btn btn-outline" @click="showForm = false">取消</button><button class="btn btn-primary" :disabled="saving || !form.name.trim()" @click="save">{{ saving ? '保存中...' : '保存活动' }}</button></div>
    </div>
    <div class="education-layout">
      <div class="card education-list-card"><div class="card-title">活动历史 <span class="count-badge">{{ activities.length }}</span></div><div v-if="loading" class="loading">加载中...</div><div v-else-if="!activities.length" class="empty-state">还没有活动记录</div><button v-for="item in activities" :key="item.id" class="education-list-item" :class="{ active: selectedId === item.id }" @click="selectedId = item.id"><span class="education-list-date">{{ item.occurred_on }}</span><strong>{{ item.name }}</strong><span class="hint">{{ item.activity_type }} · {{ item.participant_count }} 人 · {{ item.status }}</span></button></div>
      <div class="card education-detail-card"><div v-if="!selected" class="empty-state">选择一条活动记录查看详情</div><template v-else><div class="detail-header"><div><div class="card-title">{{ selected.name }}</div><div class="hint">{{ selected.occurred_on }} · {{ selected.activity_type }} · 预算 ¥{{ selected.budget }} <span v-if="selected.legacy" class="status-pill warning">旧表迁移</span></div></div><button class="btn btn-sm btn-danger" @click="removeActivity"><Trash2 :size="13" /> 删除</button></div><div class="detail-block"><h4>活动总结</h4><p>{{ selected.summary || '未填写' }}</p></div><div class="detail-block"><h4>执行结果</h4><p>{{ selected.result || '未填写' }}</p></div><div class="detail-block"><h4>复盘</h4><p>{{ selected.retrospective || '未填写' }}</p></div><div class="detail-block"><h4>参与学生</h4><div class="chip-list"><span v-for="student in selected.participants" :key="student.student_id" class="chip"><Users :size="12" /> {{ student.student_name }}</span><span v-if="!selected.participants.length" class="hint">仅记录参与人数，未选择具体学生</span></div></div><div class="detail-block"><h4>材料附件</h4><div class="inline-form"><label class="btn btn-outline"><Paperclip :size="14" /> 上传材料<input type="file" hidden @change="handleUpload"></label><span class="hint">单个文件不超过 20MB</span></div><div v-for="item in selected.attachments" :key="item.id" class="attachment-row"><a :href="item.download_path || scopedUrl(`/api/education/activities/attachments/${item.id}`)" target="_blank">{{ item.original_name }}</a><span class="hint">{{ Math.ceil(item.size / 1024) }}KB</span></div><div v-if="!selected.attachments.length" class="hint" style="margin-top:8px">暂无材料</div></div></template></div>
    </div>
    <div class="card template-strip"><div><div class="card-title">活动模板</div><div class="hint">保存常用活动类型和说明。</div></div><div class="inline-form"><input v-model="templateName" class="form-input" placeholder="模板名称"><button class="btn btn-outline" @click="saveTemplate"><FileText :size="14" /> 保存模板</button></div></div>
  </div>
</template>

<style scoped>
.education-page { width: 100%; }.education-layout { display: grid; grid-template-columns: minmax(260px,.8fr) minmax(0,1.6fr); gap: 16px; margin-top: 16px; }.education-list-card,.education-detail-card{min-width:0}.education-list-item{display:flex;flex-direction:column;gap:2px;width:100%;padding:12px;border:1px solid transparent;border-radius:10px;background:transparent;text-align:left;cursor:pointer;color:var(--text)}.education-list-item:hover,.education-list-item.active{background:var(--primary-bg);border-color:rgba(91,106,191,.18)}.education-list-date{color:var(--primary);font-size:12px}.education-form-card{margin-top:16px}.education-form-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.education-text-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.education-section-title{display:flex;align-items:center;gap:6px;margin:16px 0 8px;font-weight:650;font-size:13px}.student-check-grid{display:flex;flex-wrap:wrap;gap:8px}.student-check{display:flex;align-items:center;gap:6px;padding:7px 9px;background:var(--bg);border-radius:8px;font-size:12px}.student-check input{accent-color:var(--primary)}.inline-form{display:flex;gap:8px;align-items:center}.inline-form .form-input{min-width:0}.detail-header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.detail-block{padding:14px 0;border-bottom:1px solid var(--border)}.detail-block:last-child{border-bottom:0}.detail-block h4{font-size:13px;margin-bottom:6px}.detail-block p{white-space:pre-wrap;color:var(--text-secondary);font-size:13px}.chip-list{display:flex;flex-wrap:wrap;gap:6px}.chip{display:inline-flex;align-items:center;gap:4px;padding:4px 7px;border-radius:99px;background:var(--primary-bg);color:var(--primary);font-size:12px}.attachment-row{display:flex;justify-content:space-between;margin-top:8px;padding:8px 10px;background:var(--bg);border-radius:8px;font-size:13px}.template-strip{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:16px}.count-badge{padding:2px 6px;border-radius:99px;background:var(--primary-bg);color:var(--primary);font-size:11px}.status-pill{margin-left:6px;padding:2px 6px;border-radius:99px;font-size:11px}.status-pill.warning{color:#9a6500;background:var(--warning-bg)}
@media(max-width:800px){.education-layout,.education-form-grid,.education-text-grid{grid-template-columns:1fr}.template-strip{align-items:stretch;flex-direction:column}.inline-form{flex-wrap:wrap}}
</style>
