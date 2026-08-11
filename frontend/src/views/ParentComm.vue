<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { MessageCircle, Plus, Trash2 } from 'lucide-vue-next'
import { del, get } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'
import WorkflowModal from '../components/WorkflowModal.vue'
import { useConfirmDialog } from '../composables/confirmDialog'

const communications = ref([])
const loading = ref(true)
const showAdd = ref(false)
const route = useRoute()
const sourceId = Number(route.query.source_id || 0)
const studentId = Number(route.query.student_id || 0)
const workflowTarget = ref(null)
const { confirm: confirmDialog } = useConfirmDialog()

async function load() {
  loading.value = true
  const params = new URLSearchParams({ limit: '200' })
  if (sourceId) params.set('source_id', sourceId)
  if (studentId) params.set('student_id', studentId)
  try { communications.value = (await get(`/api/communications?${params}`)).communications || [] } finally { loading.value = false }
}
async function removeCommunication(item) {
  if (!(await confirmDialog({ title: '删除沟通记录？', message: `将删除“${item.reason}”并移入回收站，关联待办会一同隐藏。`, confirmText: '移入回收站' }))) return
  await del(`/api/records/communication/${item.id}`)
  await load()
}
onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar"><div><div class="page-title">家校沟通</div><div class="page-subtitle">记录沟通内容，也记住双方约定的下一步</div></div><button class="btn btn-primary" @click="showAdd = true"><Plus :size="14" /> 记录沟通</button></div>
    <div class="overview-cards">
      <div class="overview-card"><div class="oc-label">本页记录</div><div class="oc-value">{{ communications.length }}</div></div>
      <div class="overview-card"><div class="oc-label">需要回访</div><div class="oc-value">{{ communications.filter(c => c.followup_at && c.status !== '已完成').length }}</div></div>
      <div class="overview-card"><div class="oc-label">电话沟通</div><div class="oc-value">{{ communications.filter(c => c.method === '电话').length }}</div></div>
    </div>
    <div class="card">
      <div class="card-title"><MessageCircle :size="16" /> 沟通台账</div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!communications.length" class="empty-state">还没有沟通记录</div>
      <div v-else class="communication-list">
        <div v-for="item in communications" :key="item.id" class="communication-row" :class="{ 'source-highlight': item.id === sourceId }">
          <div class="communication-date">{{ item.communicated_at }}<span>{{ item.method }}</span></div>
          <div class="communication-copy"><strong>{{ item.student_name }} · {{ item.reason }}</strong><p>{{ item.summary }}</p><span v-if="item.agreement" class="hint">约定：{{ item.agreement }}</span></div>
          <div class="communication-status"><span class="tag" :class="item.followup_at && item.status !== '已完成' ? 'tag-orange' : 'tag-green'">{{ item.followup_at ? `回访 ${item.followup_at}` : item.status }}</span><div class="record-actions"><button class="btn btn-sm btn-outline" @click="workflowTarget = item">处理</button><button class="btn btn-sm btn-outline" aria-label="删除沟通记录" @click="removeCommunication(item)"><Trash2 :size="13" /></button></div></div>
        </div>
      </div>
    </div>
    <QuickRecordModal v-if="showAdd" mode="comm" @success="showAdd = false; load()" @close="showAdd = false" />
    <WorkflowModal v-if="workflowTarget" source-type="communication" :source-id="workflowTarget.id" :title="`${workflowTarget.student_name} · ${workflowTarget.reason}`" @close="workflowTarget = null" @success="workflowTarget = null; load()" />
  </div>
</template>
