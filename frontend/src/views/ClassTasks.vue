<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Check, ClipboardList, Plus, Trash2 } from 'lucide-vue-next'
import { del, get, post, put } from '../api'

const students = ref([])
const tasks = ref([])
const activeId = ref(null)
const creating = ref(false)
const saving = ref(false)
const message = ref('')
const route = useRoute()
const sourceId = Number(route.query.source_id || 0)
const form = ref({ title: '', task_type: '材料收集', start_at: '', due_at: '', material_name: '', description: '', student_ids: [] })
const activeTask = computed(() => tasks.value.find(task => task.id === activeId.value))

async function load() {
  const taskPath = sourceId ? `/api/class-tasks?source_id=${sourceId}` : '/api/class-tasks'
  const [taskData, studentData] = await Promise.all([get(taskPath), get('/api/students')])
  tasks.value = taskData.tasks || []
  students.value = studentData.students || []
  if ((!activeId.value || sourceId) && tasks.value.length) activeId.value = sourceId || tasks.value[0].id
}

function selectAll() { form.value.student_ids = students.value.map(student => student.id) }
function clearAll() { form.value.student_ids = [] }

async function createTask() {
  if (!form.value.title.trim()) return
  saving.value = true
  try {
    const result = await post('/api/class-tasks', form.value)
    message.value = '班级任务已创建'
    creating.value = false
    activeId.value = result.task_id
    form.value = { title: '', task_type: '材料收集', start_at: '', due_at: '', material_name: '', description: '', student_ids: [] }
    await load()
  } catch (e) { message.value = `创建失败：${e.message}` } finally { saving.value = false }
}

async function markSubmitted(item) {
  await put(`/api/class-tasks/${item.task_id}/items/${item.student_id}`, { status: item.status === '已提交' ? '未提交' : '已提交', note: item.note || '' })
  await load()
}

async function closeTask() {
  if (!activeTask.value) return
  await put(`/api/class-tasks/${activeTask.value.id}`, { status: '已完成' })
  await load()
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
    <div class="page-title-bar"><div><div class="page-title">班级任务</div><div class="page-subtitle">一次布置，逐人追踪材料和完成情况</div></div><button class="btn btn-primary" @click="creating = !creating"><Plus :size="14" /> 新建任务</button></div>
    <div v-if="message" class="inline-message">{{ message }}</div>

    <div v-if="creating" class="card task-create-card">
      <div class="card-title">新建班级任务</div>
      <div class="form-grid">
        <label>任务名称<input class="form-input" v-model="form.title" placeholder="如：收齐家长回执"></label>
        <label>任务类型<select class="form-select" v-model="form.task_type"><option>材料收集</option><option>通知确认</option><option>班级活动</option></select></label>
        <label>截止日期<input class="form-input" type="date" v-model="form.due_at"></label>
        <label>材料名称<input class="form-input" v-model="form.material_name" placeholder="如：家长回执"></label>
        <label class="form-grid-wide">说明<textarea class="form-textarea" v-model="form.description" rows="2"></textarea></label>
      </div>
      <div class="student-picker"><div class="picker-head"><strong>参与学生</strong><span>{{ form.student_ids.length }} / {{ students.length }} 人</span><button class="text-button" @click="selectAll">全选</button><button class="text-button" @click="clearAll">清空</button></div><label v-for="student in students" :key="student.id" class="student-check"><input v-model="form.student_ids" type="checkbox" :value="student.id"> {{ student.姓名 }}</label></div>
      <div class="modal-actions"><button class="btn btn-outline" @click="creating = false">取消</button><button class="btn btn-primary" :disabled="saving" @click="createTask">{{ saving ? '保存中…' : '创建任务' }}</button></div>
    </div>

    <div class="class-task-layout">
      <div class="card"><div class="card-title"><ClipboardList :size="16" /> 任务列表 <span class="count">{{ tasks.length }}</span></div><div v-if="!tasks.length" class="empty-state">还没有班级任务</div><button v-for="task in tasks" :key="task.id" class="class-task-row" :class="{ active: task.id === activeId, 'source-highlight': task.id === sourceId }" @click="activeId = task.id"><div><strong>{{ task.title }}</strong><small>{{ task.task_type }} · {{ task.due_at || '未设置截止日期' }}</small></div><span class="task-progress">{{ task.submitted }}/{{ task.total }}</span></button></div>
      <div class="card"><div v-if="activeTask" class="card-title">{{ activeTask.title }} <span class="tag" :class="activeTask.status === '已完成' ? 'tag-green' : 'tag-orange'">{{ activeTask.status }}</span><button v-if="activeTask.status !== '已完成'" class="btn btn-outline task-close" @click="closeTask"><Check :size="14" /> 完成任务</button><button class="btn btn-outline" aria-label="删除班级任务" @click="removeTask"><Trash2 :size="14" /></button></div><div v-if="activeTask" class="task-detail"><div class="hint">{{ activeTask.material_name || '无指定材料' }} · {{ activeTask.description || '无补充说明' }}</div><div class="task-progress-bar"><i :style="{ width: `${activeTask.total ? activeTask.submitted / activeTask.total * 100 : 0}%` }"></i></div><div v-for="item in activeTask.items" :key="item.id" class="collection-row"><div><strong>{{ item.姓名 }}</strong><span>{{ item.学号 }} · {{ item.note || '暂无备注' }}</span></div><button class="tag" :class="item.status === '已提交' ? 'tag-green' : 'tag-orange'" @click="markSubmitted(item)">{{ item.status === '已提交' ? '已提交' : '未提交' }}</button></div></div><div v-else class="empty-state">选择一个任务查看收集进度</div></div>
    </div>
  </div>
</template>
