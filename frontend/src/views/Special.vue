<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { Plus, Tag, Trash2 } from 'lucide-vue-next'
import { del, get } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'
import WorkflowModal from '../components/WorkflowModal.vue'

const focus = ref([])
const loading = ref(true)
const showAdd = ref(false)
const route = useRoute()
const sourceId = Number(route.query.source_id || 0)
const reviewDue = String(route.query.review_due || '').slice(0, 10)
const workflowTarget = ref(null)

async function load() {
  loading.value = true
  const query = sourceId ? `source_id=${sourceId}` : 'limit=200'
  try {
    const rows = (await get(`/api/focus?${query}`)).focus || []
    focus.value = reviewDue
      ? rows.filter(item => item.status !== '已结束' && item.next_review_at && String(item.next_review_at).slice(0, 10) <= reviewDue)
      : rows
  } finally { loading.value = false }
}
async function removeFocus(item) {
  if (!confirm(`删除“${item.topic}”并移入回收站吗？关联待办会一同隐藏。`)) return
  await del(`/api/records/focus/${item.id}`)
  await load()
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar"><div><div class="page-title">关注事项</div><div class="page-subtitle">{{ reviewDue ? `复查日期不晚于 ${reviewDue}` : '关注的是一件具体的事，不给学生贴永久标签' }}</div></div><button class="btn btn-primary" @click="showAdd = true"><Plus :size="14" /> 添加关注</button></div>
    <div class="card">
      <div class="card-title"><Tag :size="16" /> 进行中的关注 <span class="count">{{ focus.filter(f => f.status !== '已结束').length }} 项</span></div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!focus.length" class="empty-state">暂无关注事项</div>
      <div v-else class="focus-list">
        <div v-for="item in focus" :key="item.id" class="focus-card" :class="{ ended: item.status === '已结束', 'source-highlight': item.id === sourceId }">
          <div class="focus-card-head"><div><span class="focus-topic">{{ item.topic }}</span><span class="focus-student">{{ item.student_name }}</span></div><span class="tag" :class="item.status === '已结束' ? 'tag-green' : 'tag-orange'">{{ item.status }}</span></div>
          <div class="focus-reason">{{ item.reason }}</div>
          <div class="focus-meta">下次检查：{{ item.next_review_at || '未设置' }}<span v-if="item.action_plan"> · 计划：{{ item.action_plan }}</span></div>
          <div class="record-actions"><button class="btn btn-sm btn-outline" @click="workflowTarget = item">处理与复查</button><button class="btn btn-sm btn-outline" aria-label="删除关注事项" @click="removeFocus(item)"><Trash2 :size="13" /></button></div>
        </div>
      </div>
    </div>
    <QuickRecordModal v-if="showAdd" mode="focus" @success="showAdd = false; load()" @close="showAdd = false" />
    <WorkflowModal v-if="workflowTarget" source-type="focus" :source-id="workflowTarget.id" :title="`${workflowTarget.student_name} · ${workflowTarget.topic}`" @close="workflowTarget = null" @success="workflowTarget = null; load()" />
  </div>
</template>
