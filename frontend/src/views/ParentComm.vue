<script setup>
import { ref, onMounted } from 'vue'
import { MessageCircle, Plus } from 'lucide-vue-next'
import { get } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'

const communications = ref([])
const loading = ref(true)
const showAdd = ref(false)

async function load() {
  loading.value = true
  try { communications.value = (await get('/api/communications?limit=200')).communications || [] } finally { loading.value = false }
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
        <div v-for="item in communications" :key="item.id" class="communication-row">
          <div class="communication-date">{{ item.communicated_at }}<span>{{ item.method }}</span></div>
          <div class="communication-copy"><strong>{{ item.student_name }} · {{ item.reason }}</strong><p>{{ item.summary }}</p><span v-if="item.agreement" class="hint">约定：{{ item.agreement }}</span></div>
          <div class="communication-status"><span class="tag" :class="item.followup_at && item.status !== '已完成' ? 'tag-orange' : 'tag-green'">{{ item.followup_at ? `回访 ${item.followup_at}` : item.status }}</span></div>
        </div>
      </div>
    </div>
    <QuickRecordModal v-if="showAdd" mode="comm" @success="showAdd = false; load()" @close="showAdd = false" />
  </div>
</template>
