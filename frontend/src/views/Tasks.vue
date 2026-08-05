<script setup>
import { ref, onMounted } from 'vue'
import { CheckCircle, ClipboardList, Plus } from 'lucide-vue-next'
import { get, put } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'

const tasks = ref([])
const loading = ref(true)
const showAdd = ref(false)

async function load() {
  loading.value = true
  try { tasks.value = (await get('/api/tasks?limit=200')).tasks || [] } finally { loading.value = false }
}

async function complete(task) {
  await put(`/api/tasks/${task.id}`, { status: '已完成' })
  load()
}
onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar"><div><div class="page-title">待办跟进</div><div class="page-subtitle">把每件需要处理的事，收束成清晰的下一步</div></div><button class="btn btn-primary" @click="showAdd = true"><Plus :size="14" /> 新建待办</button></div>
    <div class="task-filter-strip"><span class="filter-pill active">全部 {{ tasks.length }}</span><span class="filter-pill">待处理 {{ tasks.filter(t => t.status !== '已完成' && t.status !== '已取消').length }}</span><span class="filter-pill">已完成 {{ tasks.filter(t => t.status === '已完成').length }}</span></div>
    <div class="card">
      <div class="card-title"><ClipboardList :size="16" /> 所有跟进事项</div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!tasks.length" class="empty-state">暂无待办。记录事件时可以自动生成跟进事项。</div>
      <div v-else class="task-list">
        <div v-for="task in tasks" :key="task.id" class="task-list-row" :class="{ completed: task.status === '已完成' }">
          <button class="task-check" :aria-label="task.status === '已完成' ? '已完成' : '标记完成'" @click="task.status !== '已完成' && complete(task)"><CheckCircle :size="20" /></button>
          <div class="task-list-copy"><div><strong>{{ task.title }}</strong><span class="tag" :class="task.priority === '紧急' ? 'tag-red' : task.priority === '重要' ? 'tag-orange' : ''">{{ task.priority }}</span></div><span>{{ task.student_name || '班级事务' }} · {{ task.source }} · {{ task.due_at || '未设置截止日期' }}</span></div>
          <span class="task-status">{{ task.status }}</span>
        </div>
      </div>
    </div>
    <QuickRecordModal v-if="showAdd" mode="task" @success="showAdd = false; load()" @close="showAdd = false" />
  </div>
</template>
