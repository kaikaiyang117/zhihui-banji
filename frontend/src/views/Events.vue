<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { FileEdit, Plus, Trash2 } from 'lucide-vue-next'
import { del, get } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'
import WorkflowModal from '../components/WorkflowModal.vue'

const events = ref([])
const loading = ref(true)
const showAdd = ref(false)
const route = useRoute()
const sourceId = Number(route.query.source_id || 0)
const studentId = Number(route.query.student_id || 0)
const workflowTarget = ref(null)

async function load() {
  loading.value = true
  const params = new URLSearchParams({ limit: '100' })
  if (sourceId) params.set('source_id', sourceId)
  if (studentId) params.set('student_id', studentId)
  try { events.value = (await get(`/api/events?${params}`)).events || [] } finally { loading.value = false }
}
async function removeEvent(event) {
  if (!confirm(`删除“${event.event_type}”并移入回收站吗？关联待办会一同隐藏。`)) return
  await del(`/api/records/event/${event.id}`)
  await load()
}
onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar"><div><div class="page-title">学生事件</div><div class="page-subtitle">记录学生发生的事实；如需行动，再生成待办</div></div><button class="btn btn-primary" @click="showAdd = true"><Plus :size="14" /> 快速记录</button></div>
    <div class="card">
      <div class="card-title"><FileEdit :size="16" /> 最近事件 <span class="count">{{ events.length }} 条</span></div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!events.length" class="empty-state">还没有事件记录，记录一次日常观察吧</div>
      <div v-else class="event-list">
        <div v-for="event in events" :key="event.id" class="event-card" :class="{ 'source-highlight': event.id === sourceId }">
          <div class="event-card-top"><span class="event-type">{{ event.event_type }}</span><span>{{ event.occurred_at }}</span></div>
          <div class="event-card-name">{{ event.student_name }}</div>
          <div class="event-card-description">{{ event.description }}</div>
          <div class="event-card-bottom"><span class="tag" :class="event.status === '已完成' ? 'tag-green' : 'tag-orange'">{{ event.status }}</span><span v-if="event.followup_due" class="hint">跟进：{{ event.followup_due }}</span></div>
          <div class="record-actions"><button class="btn btn-sm btn-outline" @click="workflowTarget = event">查看跟进</button><button class="btn btn-sm btn-outline" aria-label="删除事件" @click="removeEvent(event)"><Trash2 :size="13" /></button></div>
        </div>
      </div>
    </div>
    <QuickRecordModal v-if="showAdd" mode="event" @success="showAdd = false; load()" @close="showAdd = false" />
    <WorkflowModal v-if="workflowTarget" source-type="event" :source-id="workflowTarget.id" action-label="查看事件跟进" :title="`${workflowTarget.student_name} · ${workflowTarget.event_type}`" @close="workflowTarget = null" @success="workflowTarget = null; load()" />
  </div>
</template>
