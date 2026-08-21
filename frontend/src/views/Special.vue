<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { Plus, Tag, Trash2 } from 'lucide-vue-next'
import { del, get } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'
import WorkflowModal from '../components/WorkflowModal.vue'
import { useConfirmDialog } from '../composables/confirmDialog'

const focus = ref([])
const loading = ref(true)
const showAdd = ref(false)
const route = useRoute()
const sourceId = Number(route.query.source_id || 0)
const reviewDue = String(route.query.review_due || '').slice(0, 10)
const workflowTarget = ref(null)
const { confirm: confirmDialog } = useConfirmDialog()

function openWorkflow(item, initialStatus = '') {
  workflowTarget.value = { item, initialStatus, actionLabel: initialStatus === '已结束' ? '结束关注' : '更新关注进展' }
}

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
  if (!(await confirmDialog({ title: '删除关注事项？', message: `将删除“${item.topic}”并移入回收站，关联待办会一同隐藏。`, confirmText: '移入回收站' }))) return
  await del(`/api/records/focus/${item.id}`)
  await load()
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar"><div><div class="page-title">关注事项</div><div class="page-subtitle">{{ reviewDue ? `复查日期不晚于 ${reviewDue}` : '持续关注需要跟进的问题，设置下次复查，不给学生贴永久标签' }}</div></div><button class="btn btn-primary" @click="showAdd = true"><Plus :size="14" /> 添加关注</button></div>
    <div class="card">
      <div class="card-title"><Tag :size="16" /> 进行中的关注 <span class="count">{{ focus.filter(f => f.status !== '已结束').length }} 项</span></div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!focus.length" class="empty-state">暂无关注事项</div>
      <div v-else class="focus-list">
        <div v-for="item in focus" :key="item.id" class="focus-card" :class="{ ended: item.status === '已结束', 'source-highlight': item.id === sourceId }">
          <div class="focus-card-head"><div><span class="focus-topic">{{ item.topic }}</span><span class="focus-student">{{ item.student_name }}</span></div><span class="tag" :class="item.status === '已结束' ? 'tag-green' : 'tag-orange'">{{ item.status }}</span></div>
          <div class="focus-reason">{{ item.reason }}</div>
          <div class="focus-meta">下次检查：{{ item.next_review_at || '未设置' }}<span v-if="item.action_plan"> · 计划：{{ item.action_plan }}</span></div>
          <div class="record-actions"><button class="btn btn-sm btn-outline" @click="openWorkflow(item)">更新进展</button><button v-if="item.status !== '已结束'" class="btn btn-sm btn-outline" @click="openWorkflow(item, '已结束')">结束关注</button><button class="btn btn-sm btn-outline focus-trash-action" aria-label="移入回收站" @click="removeFocus(item)"><Trash2 :size="13" /> 移入回收站</button></div>
        </div>
      </div>
    </div>
    <QuickRecordModal v-if="showAdd" mode="focus" @success="showAdd = false; load()" @close="showAdd = false" />
    <WorkflowModal v-if="workflowTarget" source-type="focus" :source-id="workflowTarget.item.id" :initial-status="workflowTarget.initialStatus" :action-label="workflowTarget.actionLabel" :title="`${workflowTarget.item.student_name} · ${workflowTarget.item.topic}`" @close="workflowTarget = null" @success="workflowTarget = null; load()" />
  </div>
</template>

<style scoped>
.focus-card-head {
  align-items: baseline;
  color: var(--ds-color-ink-secondary);
  font: var(--ds-type-meta);
}

.focus-card-head > div {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  min-width: 0;
}

.focus-topic {
  color: var(--ds-color-primary);
  font: var(--ds-type-label);
}

.focus-student {
  color: var(--ds-color-ink);
  font: var(--ds-type-title);
}

.focus-reason {
  margin: 12px 0 10px;
  color: var(--ds-color-ink-secondary);
  font: var(--ds-type-body);
}

.focus-meta {
  flex-wrap: wrap;
  color: var(--ds-color-ink-muted);
  font: var(--ds-type-meta);
}

.focus-card .record-actions {
  margin-top: 14px;
}

.focus-card .record-actions .btn {
  margin-top: 0;
}
</style>
