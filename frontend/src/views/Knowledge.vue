<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { BookOpen, Edit3, ExternalLink, FilePlus2, RefreshCw, Save, Search, Tags, X } from 'lucide-vue-next'
import { get, post, put } from '../api'
import { renderAgentMarkdown } from '../markdown'

const notes = ref([])
const categories = ref([])
const tags = ref([])
const templates = ref([])
const meetingSources = ref([])
const activitySources = ref([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const selected = ref(null)
const showCreate = ref(false)
const conflict = ref(false)
const query = ref('')
const activeCategory = ref('')
const activeTag = ref('')
const editor = reactive({ title: '', category: '', tags: '', content: '' })
const createForm = reactive({ title: '', category: '个人成长', template: '', tags: '', link_type: '', link_id: '' })

const filteredNotes = computed(() => notes.value)

async function load() {
  loading.value = true
  try {
    const params = new URLSearchParams({ query: query.value, category: activeCategory.value, tag: activeTag.value })
    const [data, meetingData, activityData] = await Promise.all([
      get(`/api/knowledge/notes?${params}`), get('/api/education/meetings'), get('/api/education/activities'),
    ])
    notes.value = data.notes || []; categories.value = data.categories || []; tags.value = data.tags || []; templates.value = data.templates || []
    meetingSources.value = meetingData.meetings || []; activitySources.value = activityData.activities || []
    if (selected.value) {
      const latest = notes.value.find(item => item.id === selected.value.id)
      if (latest) selected.value = { ...selected.value, ...latest }
    }
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

function setEditor(note) {
  selected.value = note
  Object.assign(editor, { title: note.title, category: note.category, tags: (note.tags || []).join(', '), content: note.content || '' })
  conflict.value = note.sync_status === '文件已修改'
}

async function openNote(note) {
  error.value = ''
  try { setEditor(await get(`/api/knowledge/notes/read?path=${encodeURIComponent(note.relative_path)}`)) } catch (e) { error.value = e.message }
}

function tagsFrom(text) { return text.split(',').map(item => item.trim()).filter(Boolean).slice(0, 30) }
function previewMarkdown(content) { return renderAgentMarkdown(String(content || '').replace(/^---[\s\S]*?---\s*/, '')) }

async function createNote() {
  if (!createForm.title.trim()) return
  try {
    const links = createForm.link_type && createForm.link_id ? [{ type: createForm.link_type, id: Number(createForm.link_id) }] : []
    const result = await post('/api/knowledge/create', { title: createForm.title, category: createForm.category, template: createForm.template, tags: tagsFrom(createForm.tags), links })
    showCreate.value = false; notice.value = '知识库笔记已创建。'; await load(); setEditor(result); Object.assign(createForm, { title: '', category: '个人成长', template: '', tags: '', link_type: '', link_id: '' })
  } catch (e) { error.value = e.message }
}

async function saveNote(force = false) {
  if (!selected.value) return
  saving.value = true; error.value = ''; conflict.value = false
  try {
    const result = await put(`/api/knowledge/notes/${selected.value.id}`, { content: editor.content, title: editor.title, category: editor.category, tags: tagsFrom(editor.tags), expected_hash: selected.value.content_hash, force })
    notice.value = '笔记已保存。'; setEditor(result); await load()
  } catch (e) { error.value = e.message; if (e.status === 409) conflict.value = true } finally { saving.value = false }
}

async function adoptExternal() {
  if (!selected.value) return
  try { const result = await post(`/api/knowledge/notes/${selected.value.id}/adopt`, {}); setEditor(result); notice.value = '已采纳文件中的外部修改。'; conflict.value = false; await load() } catch (e) { error.value = e.message }
}

function openObsidian() {
  if (selected.value) window.open(`obsidian://open?vault=知识库&file=${encodeURIComponent(selected.value.relative_path.replace(/\.md$/, ''))}`, '_blank')
}

function sourceOptions() { return createForm.link_type === 'meeting' ? meetingSources.value : activitySources.value }
function sourceLabel(item) { return item.topic || item.name || '' }

onMounted(load)
</script>

<template>
  <div class="knowledge-page">
    <div class="page-title-bar"><div><div class="page-title">知识库</div><div class="page-subtitle">站内阅读、编辑和检索 Markdown，并保持与文件系统的可恢复同步</div></div><div class="toolbar" style="margin-bottom:0"><button class="btn btn-outline" @click="load"><RefreshCw :size="14" /> 同步索引</button><button class="btn btn-primary" @click="showCreate = true"><FilePlus2 :size="14" /> 新建笔记</button></div></div>
    <div v-if="notice" class="inline-message success-message">{{ notice }}</div><div v-if="error" class="inline-message error-message">{{ error }}</div>
    <div class="knowledge-toolbar"><div class="search-box"><Search :size="14" /><input v-model="query" placeholder="搜索标题、标签和正文" @keyup.enter="load"></div><select v-model="activeCategory" class="form-select" @change="load"><option value="">全部分类</option><option v-for="item in categories" :key="item">{{ item }}</option></select><select v-model="activeTag" class="form-select" @change="load"><option value="">全部标签</option><option v-for="item in tags" :key="item">{{ item }}</option></select></div>
    <div class="knowledge-layout"><div class="card note-list-card"><div class="card-title"><BookOpen :size="15" /> 笔记 <span class="count-badge">{{ filteredNotes.length }}</span></div><div v-if="loading" class="loading">加载中...</div><div v-else-if="!filteredNotes.length" class="empty-state">没有找到笔记</div><button v-for="note in filteredNotes" :key="note.id" class="note-list-item" :class="{ active: selected?.id === note.id }" @click="openNote(note)"><span class="note-list-title">{{ note.title }}</span><span class="hint">{{ note.category }} · {{ new Date(note.file_mtime * 1000).toLocaleDateString() }}</span><span class="tag-row"><span v-for="tag in note.tags" :key="tag" class="tag-pill">#{{ tag }}</span><span v-if="note.sync_status !== '同步'" class="conflict-pill">{{ note.sync_status }}</span></span></button></div><div class="card note-editor-card"><div v-if="!selected" class="empty-state editor-empty"><BookOpen :size="30" /><p>选择一篇笔记开始阅读或编辑</p></div><template v-else><div class="editor-head"><div><div class="card-title">{{ editor.title }}</div><div class="hint">{{ selected.relative_path }}</div></div><div class="toolbar" style="margin-bottom:0"><button class="btn btn-sm btn-outline" @click="openObsidian"><ExternalLink :size="13" /> Obsidian</button><button class="btn btn-sm btn-primary" :disabled="saving" @click="saveNote()"><Save :size="13" /> {{ saving ? '保存中' : '保存' }}</button></div></div><div v-if="conflict" class="conflict-box"><strong>文件发生了外部修改</strong><span>为了避免覆盖，你可以重新读取文件内容，或强制保存当前编辑内容。</span><div><button class="btn btn-sm btn-outline" @click="adoptExternal">读取外部版本</button><button class="btn btn-sm btn-danger" @click="saveNote(true)">强制保存当前版本</button></div></div><div class="editor-meta"><label>标题<input v-model="editor.title" class="form-input"></label><label>分类<input v-model="editor.category" class="form-input"></label><label class="tag-input"><Tags :size="14" /><input v-model="editor.tags" class="form-input" placeholder="标签，用逗号分隔"></label></div><div class="editor-columns"><textarea v-model="editor.content" class="markdown-editor" spellcheck="false"></textarea><div class="markdown-preview agent-markdown" v-html="previewMarkdown(editor.content)"></div></div></template></div></div>
    <div v-if="showCreate" class="modal-overlay show" @click.self="showCreate = false"><div class="modal"><div class="modal-title-row"><h3>新建知识库笔记</h3><button class="icon-btn" @click="showCreate = false"><X :size="16" /></button></div><label class="form-group">标题<input v-model="createForm.title" class="form-input" placeholder="输入标题"></label><label class="form-group">分类<input v-model="createForm.category" class="form-input" placeholder="例如：班级事务"></label><label class="form-group">模板<select v-model="createForm.template" class="form-select"><option value="">无模板</option><option v-for="item in templates" :key="item">{{ item }}</option></select></label><label class="form-group">标签<input v-model="createForm.tags" class="form-input" placeholder="班会, 复盘"></label><div class="form-grid source-link-grid"><label>关联来源<select v-model="createForm.link_type" class="form-select"><option value="">不关联</option><option value="meeting">班会</option><option value="activity">活动</option></select></label><label v-if="createForm.link_type">具体记录<select v-model="createForm.link_id" class="form-select"><option value="">请选择</option><option v-for="item in sourceOptions()" :key="item.id" :value="item.id">{{ sourceLabel(item) }}</option></select></label></div><div class="modal-actions"><button class="btn btn-outline" @click="showCreate = false">取消</button><button class="btn btn-primary" @click="createNote">创建</button></div></div></div>
  </div>
</template>

<style scoped>
.knowledge-page{max-width:1240px;margin:0 auto}.knowledge-toolbar{display:flex;gap:8px;align-items:center;margin:16px 0}.knowledge-toolbar .search-box{display:flex;align-items:center;gap:7px;flex:1;background:var(--bg-elevated);border:1px solid var(--border);border-radius:9px;padding:0 10px;color:var(--text-tertiary)}.knowledge-toolbar .search-box input{width:100%;border:0;outline:0;background:transparent;padding:9px 0;color:var(--text)}.knowledge-toolbar .form-select{width:160px}.knowledge-layout{display:grid;grid-template-columns:300px minmax(0,1fr);gap:16px}.note-list-card,.note-editor-card{min-width:0}.note-list-card>.card-title{display:flex;align-items:center;gap:6px}.note-list-item{display:flex;flex-direction:column;gap:3px;width:100%;padding:11px;border:1px solid transparent;border-radius:9px;background:transparent;text-align:left;color:var(--text);cursor:pointer}.note-list-item:hover,.note-list-item.active{background:var(--primary-bg);border-color:rgba(91,106,191,.18)}.note-list-title{font-size:13px;font-weight:600}.tag-row{display:flex;flex-wrap:wrap;gap:4px}.tag-pill,.conflict-pill{padding:2px 5px;border-radius:5px;background:var(--bg);color:var(--primary);font-size:10px}.conflict-pill{color:#9a6500;background:var(--warning-bg)}.count-badge{padding:2px 6px;border-radius:99px;background:var(--primary-bg);color:var(--primary);font-size:11px}.editor-empty{display:flex;min-height:360px;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--text-tertiary)}.editor-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;border-bottom:1px solid var(--border);padding-bottom:12px}.editor-meta{display:grid;grid-template-columns:1fr 1fr 1.5fr;gap:8px;margin:14px 0}.editor-meta label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary)}.editor-meta .form-input{min-width:0}.tag-input{padding-left:0}.editor-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px;min-height:520px}.markdown-editor{width:100%;min-height:520px;padding:12px;border:1px solid var(--border);border-radius:9px;background:#fbfbfd;color:var(--text);font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;outline:none}.markdown-editor:focus{border-color:rgba(91,106,191,.45)}.markdown-preview{min-width:0;overflow:auto;padding:5px 8px}.conflict-box{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;margin-top:12px;border:1px solid rgba(255,159,10,.3);border-radius:9px;background:var(--warning-bg);font-size:12px}.conflict-box span{color:var(--text-secondary);flex:1}.modal-title-row{display:flex;align-items:center;justify-content:space-between}.icon-btn{border:0;background:transparent;color:var(--text-secondary);cursor:pointer}
.source-link-grid{grid-template-columns:1fr 1fr}.source-link-grid .form-select{min-width:0}
@media(max-width:900px){.knowledge-layout{grid-template-columns:1fr}.editor-columns{grid-template-columns:1fr}.markdown-preview{min-height:240px;border-top:1px solid var(--border);padding-top:12px}}@media(max-width:600px){.knowledge-toolbar{flex-wrap:wrap}.knowledge-toolbar .search-box{flex-basis:100%}.knowledge-toolbar .form-select{flex:1;width:auto}.editor-meta{grid-template-columns:1fr}}
</style>
