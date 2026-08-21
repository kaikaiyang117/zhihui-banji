<script setup>
import { computed, onMounted, ref } from 'vue'
import { Check, Pencil, Plus, RotateCcw, X } from 'lucide-vue-next'
import { get, post, put } from '../api'

const groupTypes = ['学习小组', '值日小组', '活动小组']
const activeType = ref('学习小组')
const groups = ref([])
const students = ref([])
const unassigned = ref([])
const loading = ref(true)
const message = ref('')
const editing = ref(null)
const form = ref({ name: '', group_type: '学习小组' })
const memberIds = ref([])
const memberRoles = ref({})

const selectedCount = computed(() => memberIds.value.length)

async function load() {
  loading.value = true
  try {
    const query = `?type=${encodeURIComponent(activeType.value)}`
    const [groupData, studentData, unassignedData] = await Promise.all([
      get(`/api/groups${query}`),
      get('/api/students'),
      get(`/api/groups/unassigned${query}`),
    ])
    groups.value = groupData.groups || []
    students.value = studentData.students || []
    unassigned.value = unassignedData.students || []
  } finally {
    loading.value = false
  }
}

function resetForm() {
  form.value = { name: '', group_type: activeType.value }
}

async function create() {
  if (!form.value.name.trim()) return
  try {
    await post('/api/groups', form.value)
    message.value = '小组已创建'
    resetForm()
    await load()
  } catch (error) { message.value = `创建失败：${error.message}` }
}

function openEditor(group) {
  editing.value = group
  form.value = { name: group.name, group_type: group.group_type }
  memberIds.value = group.members.map(member => member.student_id)
  memberRoles.value = Object.fromEntries(group.members.map(member => [member.student_id, member.role]))
}

function closeEditor() {
  editing.value = null
  memberIds.value = []
  memberRoles.value = {}
}

function toggleMember(studentId) {
  if (memberIds.value.includes(studentId)) {
    memberIds.value = memberIds.value.filter(id => id !== studentId)
    const next = { ...memberRoles.value }
    delete next[studentId]
    memberRoles.value = next
  } else {
    memberIds.value = [...memberIds.value, studentId]
    memberRoles.value = { ...memberRoles.value, [studentId]: '成员' }
  }
}

function setRole(studentId, role) {
  memberRoles.value = { ...memberRoles.value, [studentId]: role }
}

async function saveEditor() {
  if (!editing.value || !form.value.name.trim()) return
  try {
    const members = memberIds.value.map((studentId, index) => ({
      student_id: studentId,
      role: memberRoles.value[studentId] || '成员',
      sort_order: index,
    }))
    await put(`/api/groups/${editing.value.id}`, { name: form.value.name, group_type: form.value.group_type })
    await put(`/api/groups/${editing.value.id}/members`, { members })
    message.value = '小组信息已保存'
    closeEditor()
    await load()
  } catch (error) { message.value = `保存失败：${error.message}` }
}

async function archive(group) {
  if (!window.confirm(`归档“${group.name}”？归档后不会再出现在当前分组列表中。`)) return
  try {
    await put(`/api/groups/${group.id}`, { status: '已归档' })
    message.value = '小组已归档'
    await load()
  } catch (error) { message.value = `归档失败：${error.message}` }
}

function switchType(type) {
  activeType.value = type
  resetForm()
  load()
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div><div class="page-title">小组管理</div><div class="page-subtitle">按当前班级和学期安排学习、值日或活动小组</div></div>
      <button class="btn btn-outline" @click="load"><RotateCcw :size="14" /> 刷新</button>
    </div>
    <div v-if="message" class="inline-message">{{ message }}</div>

    <div class="card group-toolbar-card">
      <div class="segmented">
        <button v-for="type in groupTypes" :key="type" :class="{ active: activeType === type }" @click="switchType(type)">{{ type }}</button>
      </div>
      <form class="group-create-form" @submit.prevent="create">
        <input v-model="form.name" class="form-input" placeholder="新小组名称，如：第一组">
        <button class="btn btn-primary" type="submit"><Plus :size="14" /> 创建小组</button>
      </form>
    </div>

    <div class="group-summary">
      <span>{{ groups.length }} 个小组</span><span>{{ unassigned.length }} 名学生尚未分组</span>
    </div>

    <div v-if="loading" class="loading">加载中...</div>
    <div v-else-if="!groups.length" class="card empty-state">还没有{{ activeType }}，先创建一个小组吧。</div>
    <div v-else class="groups-grid">
      <article v-for="group in groups" :key="group.id" class="card group-card">
        <div class="group-card-head"><div><h3>{{ group.name }}</h3><span>{{ group.member_count }} 人</span></div><div class="record-actions"><button class="btn btn-sm btn-outline" @click="openEditor(group)"><Pencil :size="13" /> 编辑</button><button class="btn btn-sm btn-outline" @click="archive(group)">归档</button></div></div>
        <div v-if="!group.members.length" class="hint">暂未安排成员</div>
        <div v-else class="group-member-list">
          <div v-for="member in group.members" :key="member.student_id" class="group-member-row"><span>{{ member.姓名 }} <small>{{ member.学号 }}</small></span><em>{{ member.role }}</em></div>
        </div>
      </article>
    </div>

    <div v-if="editing" class="modal-overlay show" @click.self="closeEditor">
      <div class="modal group-editor-modal">
        <div class="modal-kicker">编辑小组</div><h3>{{ editing.name }}</h3>
        <div class="form-grid"><label>小组名称<input v-model="form.name" class="form-input"></label><label>小组类型<select v-model="form.group_type" class="form-select"><option v-for="type in groupTypes" :key="type" :value="type">{{ type }}</option></select></label></div>
        <div class="student-picker"><div class="picker-head"><strong>小组成员</strong><span>{{ selectedCount }} 人</span></div><div class="group-picker-list"><label v-for="student in students" :key="student.id" class="group-picker-row"><input type="checkbox" :checked="memberIds.includes(student.id)" @change="toggleMember(student.id)"><span>{{ student.姓名 }} <small>{{ student.学号 }}</small></span><select v-if="memberIds.includes(student.id)" class="form-select form-select-sm" :value="memberRoles[student.id] || '成员'" @change="setRole(student.id, $event.target.value)"><option>成员</option><option>组长</option></select></label></div></div>
        <div class="modal-actions"><button class="btn btn-outline" @click="closeEditor"><X :size="14" /> 取消</button><button class="btn btn-primary" @click="saveEditor"><Check :size="14" /> 保存</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.group-toolbar-card { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:14px; }
.group-create-form { display:flex; gap:8px; width:min(420px,100%); }
.group-summary { display:flex; gap:16px; color:var(--text-secondary); font-size:12px; margin:0 0 12px; }
.groups-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:12px; }
.group-card { min-height:150px; }
.group-card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:12px; }
.group-card-head h3 { margin:0 0 4px; font-size:16px; }
.group-card-head span,.group-member-row small,.group-picker-row small { color:var(--text-secondary); font-size:11px; }
.group-member-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; }
.group-member-row { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; padding:8px 10px; background:var(--bg); border-radius:8px; font-size:13px; }
.group-member-row span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.group-member-row em { color:var(--primary); font-size:11px; font-style:normal; }
.group-editor-modal { max-width:720px; }
.group-picker-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px 12px; max-height:300px; overflow:auto; }
.group-picker-row { display:flex; align-items:center; gap:7px; min-width:0; font-size:13px; }
.group-picker-row span { flex:1; min-width:0; }
.form-select-sm { width:auto; min-width:70px; padding:5px 7px; }
@media (max-width:640px) { .group-toolbar-card { align-items:stretch; flex-direction:column; } .group-create-form { width:100%; } .group-member-list, .group-picker-list { grid-template-columns:1fr; } }
</style>
