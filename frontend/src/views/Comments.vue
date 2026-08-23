<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Check, Download, FileText, History, Pencil, Plus, RotateCcw, ShieldCheck, Sparkles } from 'lucide-vue-next'
import { download, get, post, put } from '../api'

const summary = ref({ counts: { 草稿: 0, 待审核: 0, 完成: 0, 已发送: 0, total: 0 }, coverage: { student_count: 0, generated_count: 0, missing_count: 0, completion_rate: 0, generated_student_ids: [] }, templates: [], students: [], variables: [], migration: null })
const route = useRoute()
const comments = ref([])
const loading = ref(true)
const message = ref('')
const showTemplates = ref(false)
const templateEditId = ref(null)
const showBatch = ref(false)
const editTarget = ref(null)
const transitionTarget = ref(null)
const transitionStatus = ref('')
const transitionNote = ref('')
const versionsTarget = ref(null)
const versions = ref([])
const filters = ref({ student_id: '', comment_type: '', status: '', keyword: '' })
const templateForm = ref({ name: '', comment_type: '学期评语', content: '{{姓名}}同学本学期表现认真，希望继续保持。', enabled: true })
const manualForm = ref({ student_id: '', comment_type: '学期评语', content: '', note: '' })
const batchForm = ref({ template_id: '', comment_type: '学期评语', student_ids: [] })
const batchPreview = ref(null)
const confirmMissing = ref(false)
const showAI = ref(false)
const aiBusy = ref(false)
const aiPreview = ref(null)
const aiForm = ref({ scope: 'missing', student_ids: [], tone: '温和、客观、鼓励', length: '120-160字', instruction: '' })

const selectedTemplate = computed(() => summary.value.templates.find(item => item.id === Number(batchForm.value.template_id)))
const allSelected = computed(() => summary.value.students.length > 0 && batchForm.value.student_ids.length === summary.value.students.length)

function queryString() {
  const params = new URLSearchParams()
  Object.entries(filters.value).forEach(([key, value]) => { if (value) params.set(key, value) })
  return params.toString()
}
async function load() {
  loading.value = true
  try {
    const result = await get(`/api/comments${queryString() ? `?${queryString()}` : ''}`)
    summary.value = result.summary || summary.value
    comments.value = result.comments || []
  } catch (error) { message.value = `加载失败：${error.message}` } finally { loading.value = false }
}
function applyFilters() { load() }
function insertVariable(token) { templateForm.value.content += token }
async function saveTemplate() {
  if (!templateForm.value.name.trim() || !templateForm.value.content.trim()) return
  try {
    if (templateEditId.value) {
      await put(`/api/comments/templates/${templateEditId.value}`, templateForm.value)
      message.value = '评语模板已更新'
    } else {
      await post('/api/comments/templates', templateForm.value)
      message.value = '评语模板已保存'
    }
    templateEditId.value = null
    templateForm.value = { name: '', comment_type: '学期评语', content: '{{姓名}}同学本学期表现认真，希望继续保持。', enabled: true }
    await load()
  } catch (error) { message.value = `模板保存失败：${error.message}` }
}
function editTemplate(item) {
  templateEditId.value = item.id
  templateForm.value = {
    name: item.name, comment_type: item.comment_type, content: item.content, enabled: Boolean(item.enabled),
  }
  showTemplates.value = true
}
function cancelTemplateEdit() {
  templateEditId.value = null
  templateForm.value = { name: '', comment_type: '学期评语', content: '{{姓名}}同学本学期表现认真，希望继续保持。', enabled: true }
}
function openBatch() {
  const template = summary.value.templates[0]
  batchForm.value = {
    template_id: template?.id || '', comment_type: template?.comment_type || '学期评语',
    student_ids: summary.value.students.map(item => item.id),
  }
  batchPreview.value = null; confirmMissing.value = false; showBatch.value = true
}
const aiStudents = computed(() => {
  const generated = new Set(summary.value.coverage?.generated_student_ids || [])
  if (aiForm.value.scope === 'missing') return summary.value.students.filter(item => !generated.has(Number(item.id)))
  return summary.value.students
})
const aiSelectedCount = computed(() => aiForm.value.scope === 'custom' ? aiForm.value.student_ids.length : aiStudents.value.length)
function openAI() {
  aiForm.value = { scope: 'missing', student_ids: [], tone: '温和、客观、鼓励', length: '120-160字', instruction: '' }
  aiPreview.value = null
  showAI.value = true
}
function selectAIScope(scope) {
  aiForm.value.scope = scope
  aiForm.value.student_ids = scope === 'custom' ? [] : aiStudents.value.map(item => Number(item.id))
  aiPreview.value = null
}
async function previewAI() {
  const studentIds = aiForm.value.scope === 'custom' ? aiForm.value.student_ids : aiStudents.value.map(item => Number(item.id))
  if (!studentIds.length) return
  aiBusy.value = true
  try {
    aiPreview.value = await post('/api/comments/ai/preview', { ...aiForm.value, student_ids: studentIds })
  } catch (error) { message.value = `AI生成失败：${error.message}` } finally { aiBusy.value = false }
}
async function saveAIDrafts() {
  if (!aiPreview.value?.rows?.length) return
  aiBusy.value = true
  try {
    const result = await post('/api/comments/ai/generate', {
      rows: aiPreview.value.rows, comment_type: aiPreview.value.comment_type,
      model: aiPreview.value.model, period: aiPreview.value.period,
    })
    message.value = `AI评语草稿已保存：新增 ${result.created} 条，更新 ${result.updated} 条，保护 ${result.protected} 条`
    showAI.value = false; aiPreview.value = null; await load()
  } catch (error) { message.value = `保存 AI 草稿失败：${error.message}` } finally { aiBusy.value = false }
}
function applyBatchTemplate() {
  if (selectedTemplate.value) batchForm.value.comment_type = selectedTemplate.value.comment_type
  batchPreview.value = null; confirmMissing.value = false
}
function toggleAll() {
  batchForm.value.student_ids = allSelected.value ? [] : summary.value.students.map(item => item.id)
  batchPreview.value = null
}
async function previewBatch() {
  if (!batchForm.value.template_id || !batchForm.value.student_ids.length) return
  try {
    batchPreview.value = await post('/api/comments/generate/preview', {
      ...batchForm.value, template_id: Number(batchForm.value.template_id),
    })
    confirmMissing.value = false
  } catch (error) { message.value = `预览失败：${error.message}` }
}
async function generateBatch() {
  if (!batchPreview.value) return
  try {
    const result = await post('/api/comments/generate', {
      ...batchForm.value, template_id: Number(batchForm.value.template_id), confirm_missing: confirmMissing.value,
    })
    message.value = `批量生成完成：新增 ${result.created} 条，更新 ${result.updated} 条，保护 ${result.protected} 条`
    showBatch.value = false; batchPreview.value = null; await load()
  } catch (error) { message.value = `生成失败：${error.message}` }
}
function openManual() { editTarget.value = { id: null }; manualForm.value = { student_id: '', comment_type: '学期评语', content: '', note: '' } }
function openEdit(item) {
  editTarget.value = item
  manualForm.value = { student_id: item.student_id, comment_type: item.comment_type, content: item.content, note: item.note || '' }
}
async function saveComment() {
  if (!manualForm.value.content.trim() || (!editTarget.value?.id && !manualForm.value.student_id)) return
  try {
    if (editTarget.value.id) await put(`/api/comments/entries/${editTarget.value.id}`, { content: manualForm.value.content, note: manualForm.value.note })
    else await post('/api/comments/entries', { ...manualForm.value, student_id: Number(manualForm.value.student_id) })
    message.value = editTarget.value.id ? '评语草稿已人工修改并保护' : '评语草稿已创建'
    editTarget.value = null; await load()
  } catch (error) { message.value = `保存失败：${error.message}` }
}
function openTransition(item, status) {
  transitionTarget.value = item; transitionStatus.value = status; transitionNote.value = ''
}
async function transition() {
  if (!transitionTarget.value) return
  try {
    await post(`/api/comments/entries/${transitionTarget.value.id}/transition`, {
      target_status: transitionStatus.value, note: transitionNote.value,
    })
    message.value = `评语已更新为“${transitionStatus.value}”`; transitionTarget.value = null; await load()
  } catch (error) { message.value = `状态更新失败：${error.message}` }
}
async function openVersions(item) {
  try {
    versionsTarget.value = item
    versions.value = (await get(`/api/comments/entries/${item.id}/versions`)).versions || []
  } catch (error) { message.value = `版本加载失败：${error.message}` }
}
function exportComments() { download('/api/export/sheet/评语管理') }
onMounted(() => {
  if (route.query.student_id) filters.value.student_id = String(route.query.student_id)
  load()
})
</script>

<template>
  <div>
    <div class="page-title-bar"><div><div class="page-title">评语管理</div><div class="page-subtitle">AI和模板都只生成草稿，人工确认后审核完成</div></div><div class="toolbar" style="margin-bottom:0"><button class="btn btn-primary" @click="openAI"><Sparkles :size="14" /> AI生成评语</button><button class="btn btn-outline" :disabled="!summary.templates.length" @click="openBatch"><FileText :size="14" /> 模板生成</button><button class="btn btn-outline" @click="openManual"><Plus :size="14" /> 新建评语</button><button class="btn btn-outline" @click="exportComments"><Download :size="14" /> 导出</button></div></div>
    <div v-if="message" class="inline-message">{{ message }}</div>

    <div class="overview-cards comment-overview"><div class="overview-card"><span class="overview-label">学期评语覆盖</span><strong class="overview-value">{{ summary.coverage.generated_count }} / {{ summary.coverage.student_count }}</strong><small>完成率 {{ summary.coverage.completion_rate }}% · 未生成 {{ summary.coverage.missing_count }} 人</small></div><div class="overview-card"><span class="overview-label">草稿</span><strong class="overview-value">{{ summary.counts.草稿 }}</strong><small>可继续人工修改</small></div><div class="overview-card"><span class="overview-label">待审核</span><strong class="overview-value warning">{{ summary.counts.待审核 }}</strong><small>等待审核或退回</small></div><div class="overview-card"><span class="overview-label">完成</span><strong class="overview-value positive">{{ summary.counts.完成 }}</strong><small>已完成审核</small></div></div>

    <div v-if="showTemplates" class="card comment-template-card"><div class="card-title">评语模板与变量</div><div class="comment-template-layout"><div><div class="form-grid"><label>模板名称<input class="form-input" v-model="templateForm.name" placeholder="如：学期综合表现"></label><label>评语类型<select class="form-select" v-model="templateForm.comment_type"><option>学期评语</option><option>毕业评语</option><option>日常评语</option></select></label><label class="form-grid-wide">模板内容<textarea class="form-textarea" rows="5" v-model="templateForm.content"></textarea></label></div><div class="comment-variable-list"><button v-for="item in summary.variables" :key="item.name" type="button" class="filter-pill" @click="insertVariable(item.token)">{{ item.token }}</button></div><div class="modal-actions"><button class="btn btn-primary" @click="saveTemplate">{{ templateEditId ? '更新模板' : '保存模板' }}</button><button v-if="templateEditId" class="btn btn-outline" @click="cancelTemplateEdit">取消编辑</button></div></div><div class="comment-template-list"><div v-for="item in summary.templates" :key="item.id" class="comment-template-row"><div class="comment-template-row-head"><strong>{{ item.name }}</strong><button class="btn btn-sm btn-outline" @click="editTemplate(item)"><Pencil :size="12" />编辑</button></div><span>{{ item.comment_type }} · {{ item.variables?.join('、') || '无变量' }}</span><p>{{ item.content }}</p></div><div v-if="!summary.templates.length" class="empty-state compact-empty">先创建一个模板，再批量生成学生草稿</div></div></div></div>

    <div class="card"><div class="card-title">评语清单 <span class="count">{{ comments.length }} 条</span></div><div class="comment-filters"><label>学生<select class="form-select" v-model="filters.student_id" @change="applyFilters"><option value="">全部学生</option><option v-for="student in summary.students" :key="student.id" :value="student.id">{{ student.姓名 }} · {{ student.学号 }}</option></select></label><label>类型<select class="form-select" v-model="filters.comment_type" @change="applyFilters"><option value="">全部类型</option><option>学期评语</option><option>毕业评语</option><option>日常评语</option></select></label><label>状态<select class="form-select" v-model="filters.status" @change="applyFilters"><option value="">全部状态</option><option>草稿</option><option>待审核</option><option>完成</option></select></label><label>搜索<input class="form-input" v-model="filters.keyword" placeholder="姓名、学号或内容" @keyup.enter="applyFilters"></label></div><div v-if="loading" class="loading">加载中…</div><div v-else-if="!comments.length" class="empty-state">暂无评语记录</div><div v-else class="comment-list"><article v-for="item in comments" :key="item.id" class="comment-card"><div class="comment-card-head"><div><strong>{{ item.student_name }}</strong><span>{{ item.学号 }} · {{ item.comment_type }}<template v-if="item.template_name"> · {{ item.template_name }}</template></span></div><span class="tag" :class="item.status === '已发送' || item.status === '完成' ? 'tag-green' : item.status === '待审核' ? 'tag-orange' : 'tag-gray'">{{ item.status }}</span></div><p>{{ item.content }}</p><div class="comment-card-meta"><span v-if="item.is_manually_edited"><ShieldCheck :size="13" /> 人工内容已保护</span><span>{{ item.source_label }} · {{ item.version_count }} 个版本</span></div><div class="record-actions"><button class="btn btn-sm btn-outline" @click="openVersions(item)"><History :size="12" />版本</button><button v-if="item.status === '草稿'" class="btn btn-sm btn-outline" @click="openEdit(item)"><Pencil :size="12" />编辑</button><button v-if="item.status === '草稿'" class="btn btn-sm btn-primary" @click="openTransition(item, '待审核')">提交审核</button><button v-if="item.status === '待审核'" class="btn btn-sm btn-outline" @click="openTransition(item, '草稿')"><RotateCcw :size="12" />退回</button><button v-if="item.status === '待审核'" class="btn btn-sm btn-primary" @click="openTransition(item, '完成')"><Check :size="12" />审核通过</button><button v-if="item.status === '完成'" class="btn btn-sm btn-outline" @click="openTransition(item, '待审核')">重新审核</button></div></article></div></div>
    <div v-if="summary.migration" class="hint comment-migration-note">旧版评语工作表已迁移 {{ summary.migration.imported_entries }} 条；原工作表保留为历史来源，不再直接改写。</div>

    <div v-if="showAI" class="modal-overlay show" @click.self="showAI = false"><div class="modal comment-ai-modal"><div class="modal-kicker">AI评语草稿</div><h3>生成本学期评语</h3><p class="hint">AI只参考本学期已登记的事实，生成结果需要老师检查后再进入审核。</p><div class="ai-scope-row"><strong>生成范围</strong><div class="filter-pill-group"><button type="button" class="filter-pill" :class="{ active: aiForm.scope === 'missing' }" @click="selectAIScope('missing')">未生成 {{ summary.coverage.missing_count }}</button><button type="button" class="filter-pill" :class="{ active: aiForm.scope === 'all' }" @click="selectAIScope('all')">全班 {{ summary.coverage.student_count }}</button><button type="button" class="filter-pill" :class="{ active: aiForm.scope === 'custom' }" @click="selectAIScope('custom')">自选学生</button></div></div><div class="form-grid"><label>语言风格<select class="form-select" v-model="aiForm.tone"><option>温和、客观、鼓励</option><option>简洁、正式、客观</option><option>具体、积极、突出成长</option></select></label><label>建议字数<select class="form-select" v-model="aiForm.length"><option>100-140字</option><option>120-160字</option><option>160-220字</option></select></label><label class="form-grid-wide">老师补充要求<input class="form-input" v-model="aiForm.instruction" placeholder="可选，例如：更突出班级任职和本学期进步"></label></div><div v-if="aiForm.scope === 'custom'" class="comment-ai-student-picker"><div class="comment-ai-picker-head"><strong>选择学生</strong><span>已选 {{ aiForm.student_ids.length }} 人</span></div><label v-for="student in summary.students" :key="student.id"><input type="checkbox" :value="Number(student.id)" v-model="aiForm.student_ids">{{ student.姓名 }}<small>{{ student.学号 }}</small></label></div><div v-if="!aiPreview" class="modal-actions"><button class="btn btn-outline" @click="showAI = false">取消</button><button class="btn btn-primary" :disabled="aiBusy || !aiSelectedCount" @click="previewAI">{{ aiBusy ? '正在生成…' : `生成 ${aiSelectedCount} 份草稿` }}</button></div><div v-else class="comment-ai-preview"><div class="comment-ai-preview-summary"><strong>已生成 {{ aiPreview.summary.generated }} / {{ aiPreview.summary.requested }} 份</strong><span>数据不足 {{ aiPreview.summary.low_coverage }} 人 · 有提示 {{ aiPreview.summary.warnings }} 人</span></div><div class="comment-ai-preview-list"><article v-for="row in aiPreview.rows" :key="row.student_id" class="comment-ai-preview-row"><div class="comment-ai-preview-head"><strong>{{ row.姓名 }}</strong><span>{{ row.学号 }}</span></div><textarea v-if="row.content" class="form-textarea" rows="4" v-model="row.content"></textarea><p v-else class="ai-empty-content">暂未生成内容</p><div class="comment-ai-evidence"><span v-for="item in row.evidence" :key="item">依据：{{ item }}</span><span v-for="item in row.warnings" :key="`warning-${item}`" class="warning">提示：{{ item }}</span><span v-if="!row.evidence.length && !row.warnings.length" class="warning">暂无可用事实，请人工确认后填写</span></div></article></div><div class="modal-actions"><button class="btn btn-outline" @click="aiPreview = null">重新设置</button><button class="btn btn-primary" :disabled="aiBusy || !aiPreview.summary.generated" @click="saveAIDrafts">{{ aiBusy ? '正在保存…' : '保存为草稿' }}</button></div></div></div></div>

    <div v-if="showBatch" class="modal-overlay show" @click.self="showBatch = false"><div class="modal comment-batch-modal"><div class="modal-kicker">批量生成评语草稿</div><h3>先预览，再生成</h3><div class="form-grid"><label>模板<select class="form-select" v-model="batchForm.template_id" @change="applyBatchTemplate"><option v-for="item in summary.templates" :key="item.id" :value="item.id">{{ item.name }}</option></select></label><label>类型<select class="form-select" v-model="batchForm.comment_type"><option>学期评语</option><option>毕业评语</option><option>日常评语</option></select></label></div><div class="comment-student-picker"><div><strong>选择学生</strong><button class="btn btn-sm btn-outline" @click="toggleAll">{{ allSelected ? '取消全选' : '全选' }}</button></div><label v-for="student in summary.students" :key="student.id"><input type="checkbox" :value="student.id" v-model="batchForm.student_ids">{{ student.姓名 }}<small>{{ student.学号 }}</small></label></div><div class="modal-actions"><button class="btn btn-outline" @click="showBatch = false">取消</button><button class="btn btn-primary" @click="previewBatch">生成预览</button></div><div v-if="batchPreview" class="comment-preview"><div class="comment-preview-summary">新增 {{ batchPreview.summary.creatable }} · 更新自动草稿 {{ batchPreview.summary.updatable }} · 保护 {{ batchPreview.summary.protected }} · 缺失 {{ batchPreview.summary.missing }}</div><div class="comment-preview-list"><div v-for="row in batchPreview.rows" :key="row.student_id" class="comment-preview-row" :class="{ protected: row.protected, missing: row.has_missing }"><div><strong>{{ row.姓名 }}</strong><span>{{ row.action }}</span></div><p>{{ row.content }}</p><small v-if="row.missing_variables.length">缺失：{{ row.missing_variables.join('、') }}</small></div></div><label v-if="batchPreview.summary.missing" class="comment-confirm-missing"><input type="checkbox" v-model="confirmMissing"> 我已确认缺失变量会以“未填写”标记生成</label><div class="modal-actions"><button class="btn btn-primary" :disabled="batchPreview.summary.missing && !confirmMissing" @click="generateBatch">确认生成草稿</button></div></div></div></div>

    <div v-if="editTarget" class="modal-overlay show" @click.self="editTarget = null"><div class="modal comment-edit-modal"><div class="modal-kicker">{{ editTarget.id ? '人工修改评语' : '新建评语草稿' }}</div><h3>{{ editTarget.id ? editTarget.student_name : '选择学生并填写内容' }}</h3><div class="form-grid"><label v-if="!editTarget.id">学生<select class="form-select" v-model="manualForm.student_id"><option value="">请选择</option><option v-for="student in summary.students" :key="student.id" :value="student.id">{{ student.姓名 }} · {{ student.学号 }}</option></select></label><label v-if="!editTarget.id">类型<select class="form-select" v-model="manualForm.comment_type"><option>学期评语</option><option>毕业评语</option><option>日常评语</option></select></label><label class="form-grid-wide">评语内容<textarea class="form-textarea" rows="8" v-model="manualForm.content"></textarea></label><label class="form-grid-wide">备注<input class="form-input" v-model="manualForm.note"></label></div><p v-if="editTarget.id" class="hint">保存后会标记为人工内容，后续批量生成不会覆盖。</p><div class="modal-actions"><button class="btn btn-outline" @click="editTarget = null">取消</button><button class="btn btn-primary" @click="saveComment">保存草稿</button></div></div></div>

    <div v-if="transitionTarget" class="modal-overlay show" @click.self="transitionTarget = null"><div class="modal"><div class="modal-kicker">评语状态流转</div><h3>{{ transitionTarget.student_name }} · {{ transitionTarget.status }} → {{ transitionStatus }}</h3><p class="hint">所有状态变化都会写入版本历史和系统审计。</p><label>{{ transitionStatus === '完成' ? '审核意见' : transitionStatus === '草稿' ? '退回原因' : '备注' }}<textarea class="form-textarea" rows="3" v-model="transitionNote"></textarea></label><div class="modal-actions"><button class="btn btn-outline" @click="transitionTarget = null">取消</button><button class="btn btn-primary" @click="transition">确认更新</button></div></div></div>

    <div v-if="versionsTarget" class="modal-overlay show" @click.self="versionsTarget = null"><div class="modal"><div class="modal-kicker">版本历史</div><h3>{{ versionsTarget.student_name }} · {{ versionsTarget.comment_type }}</h3><div class="comment-version-list"><div v-for="version in versions" :key="version.id"><strong>v{{ version.version_no }} · {{ version.status }}</strong><span>{{ version.change_type }} · {{ version.changed_by }} · {{ version.created_at }}</span><p>{{ version.content }}</p></div></div><div class="modal-actions"><button class="btn btn-outline" @click="versionsTarget = null">关闭</button></div></div></div>
  </div>
</template>

<style scoped>
.comment-overview { grid-template-columns: minmax(280px, 1.45fr) repeat(3, minmax(150px, 1fr)); margin-bottom: 16px; }
.comment-overview .overview-card { min-width: 0; padding: 14px 16px; align-items: flex-start; flex-direction: column; gap: 4px; }
.comment-overview .overview-card:first-child { background: linear-gradient(135deg, var(--primary-bg), var(--bg-elevated) 70%); border-color: rgba(91, 106, 191, .18); }
.comment-overview .overview-label { color: var(--text-secondary); font-size: 12px; }
.comment-overview .overview-value { font-size: 24px; line-height: 1.15; letter-spacing: -.02em; }
.comment-overview small { color: var(--text-tertiary); font-size: 11px; }
.comment-template-card { margin-bottom: 16px; }
.comment-template-layout { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(260px, .9fr); gap: 20px; }
.comment-template-list { display: grid; gap: 8px; align-content: start; max-height: 330px; overflow-y: auto; }
.comment-template-row { padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
.comment-template-row-head { display: flex; align-items: center; gap: 8px; }
.comment-template-row-head strong { flex: 1; }
.comment-template-row > span { display: block; margin-top: 4px; color: var(--text-secondary); font-size: 11px; }
.comment-template-row p { margin: 8px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
.comment-variable-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.comment-variable-list .filter-pill { cursor: pointer; }
.comment-filters { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding-bottom: 14px; }
.comment-filters label, .comment-batch-modal label, .comment-edit-modal label, .modal > label { display: grid; gap: 5px; color: var(--text-secondary); font-size: 12px; font-weight: 600; }
.comment-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 10px; }
.comment-card { display: flex; min-height: 180px; box-sizing: border-box; flex-direction: column; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-elevated); }
.comment-card-head { display: flex; align-items: flex-start; gap: 12px; }
.comment-card-head > div { min-width: 0; flex: 1; }
.comment-card-head strong { display: block; font-size: 15px; }
.comment-card-head span:not(.tag) { display: block; margin-top: 3px; color: var(--text-secondary); font-size: 11px; }
.comment-card > p { margin: 12px 0; color: var(--text); font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
.comment-card-meta { display: flex; flex-wrap: wrap; gap: 10px; color: var(--text-secondary); font-size: 11px; }
.comment-card-meta span { display: inline-flex; align-items: center; gap: 4px; }
.comment-card .record-actions { margin-top: auto; padding-top: 12px; }
.comment-migration-note { display: block; margin-top: 12px; }
.comment-batch-modal { max-width: 760px; }
.comment-ai-modal { max-width: 860px; }
.ai-scope-row { display: grid; gap: 8px; margin-top: 14px; }
.filter-pill-group { display: inline-flex; flex-wrap: wrap; gap: 2px; width: fit-content; padding: 3px; border: 1px solid var(--border); border-radius: 10px; background: rgba(118, 118, 128, .1); }
.comment-ai-modal .filter-pill { appearance: none; -webkit-appearance: none; box-sizing: border-box; padding: 7px 14px; border: 0; border-radius: 8px; color: var(--text-secondary); background: transparent; cursor: pointer; font: inherit; font-size: 14px; line-height: 1.35; box-shadow: none; transition: background-color 160ms ease, color 160ms ease, box-shadow 160ms ease, transform 100ms ease-out; }
.comment-ai-modal .filter-pill:hover { color: var(--text); background: rgba(255, 255, 255, .48); }
.comment-ai-modal .filter-pill.active { color: var(--primary); background: var(--bg-elevated); font-weight: 600; box-shadow: var(--shadow-sm); }
.comment-ai-modal .filter-pill:active { transform: scale(.98); }
.comment-ai-student-picker { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; max-height: 220px; overflow-y: auto; margin-top: 14px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
.comment-ai-picker-head { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; color: var(--text-secondary); font-size: 12px; }
.comment-ai-student-picker label { display: flex; align-items: center; gap: 7px; padding: 7px 8px; border-radius: 7px; color: var(--text); font-size: 12px; font-weight: 400; }
.comment-ai-student-picker label:hover { background: var(--bg-elevated); }
.comment-ai-student-picker small { margin-left: auto; color: var(--text-tertiary); }
.comment-ai-preview { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
.comment-ai-preview-summary { display: flex; justify-content: space-between; gap: 10px; color: var(--text-secondary); font-size: 12px; }
.comment-ai-preview-list { display: grid; gap: 10px; max-height: 420px; overflow-y: auto; margin-top: 12px; }
.comment-ai-preview-row { padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
.comment-ai-preview-head { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.comment-ai-preview-head span { color: var(--text-secondary); font-size: 12px; }
.comment-ai-evidence { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.comment-ai-evidence span { padding: 4px 7px; border-radius: 6px; background: var(--success-bg); color: var(--text-secondary); font-size: 11px; }
.comment-ai-evidence span.warning { background: var(--warning-bg); color: #a65d08; }
.ai-empty-content { margin: 0; color: var(--text-secondary); font-size: 12px; }
.comment-student-picker { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin-top: 14px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
.comment-student-picker > div { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; }
.comment-student-picker label { display: flex; grid-template-columns: none; align-items: center; gap: 7px; padding: 7px 8px; border-radius: 7px; color: var(--text); font-size: 12px; font-weight: 400; }
.comment-student-picker label:hover { background: var(--bg-elevated); }
.comment-student-picker small { margin-left: auto; color: var(--text-tertiary); }
.comment-preview { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
.comment-preview-summary { color: var(--text-secondary); font-size: 12px; }
.comment-preview-list { display: grid; gap: 7px; max-height: 280px; overflow-y: auto; margin-top: 10px; }
.comment-preview-row { padding: 10px; border-left: 3px solid var(--success); border-radius: 8px; background: var(--success-bg); }
.comment-preview-row.protected { border-left-color: var(--warning); background: var(--warning-bg); }
.comment-preview-row.missing { box-shadow: inset 0 0 0 1px rgba(255,159,10,.25); }
.comment-preview-row > div { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
.comment-preview-row > div span { color: var(--text-secondary); }
.comment-preview-row p { margin: 5px 0 0; font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
.comment-preview-row small { display: block; margin-top: 4px; color: #a65d08; font-size: 11px; }
.comment-confirm-missing { display: flex !important; grid-template-columns: none !important; align-items: center; margin-top: 12px; color: var(--text) !important; font-weight: 500 !important; }
.comment-confirm-missing input { width: auto; }
.comment-version-list { display: grid; gap: 10px; max-height: 420px; overflow-y: auto; }
.comment-version-list > div { padding: 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); }
.comment-version-list strong { display: block; font-size: 12px; }
.comment-version-list span { display: block; margin-top: 3px; color: var(--text-secondary); font-size: 11px; }
.comment-version-list p { margin-top: 7px; color: var(--text); font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
.compact-empty { padding: 18px 10px; }
@media (max-width: 800px) {
  .comment-list { grid-template-columns: 1fr; }
  .comment-card { min-height: 0; }
  .comment-template-layout { grid-template-columns: 1fr; }
  .comment-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .comment-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .comment-filters, .comment-student-picker, .comment-ai-student-picker, .comment-overview { grid-template-columns: 1fr; }
  .comment-student-picker > div { grid-column: auto; }
  .comment-ai-picker-head { grid-column: auto; }
  .comment-ai-preview-summary { align-items: flex-start; flex-direction: column; }
  .comment-card-head { align-items: flex-start; }
  .comment-card-head .tag { flex-shrink: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .comment-ai-preview-row, .comment-ai-modal .filter-pill { transition: none; }
  .comment-ai-modal .filter-pill:active { transform: none; }
}
</style>
