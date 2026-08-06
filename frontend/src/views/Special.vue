<script setup>
import { ref, onMounted } from 'vue'
import { Plus, Tag } from 'lucide-vue-next'
import { get, put } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'

const focus = ref([])
const loading = ref(true)
const showAdd = ref(false)

async function load() {
  loading.value = true
  try { focus.value = (await get('/api/focus?limit=200')).focus || [] } finally { loading.value = false }
}

async function closeFocus(item) {
  await put(`/api/focus/${item.id}`, { status: '已结束', conclusion: '已完成阶段性跟进' })
  load()
}
onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar"><div><div class="page-title">关注事项</div><div class="page-subtitle">关注的是一件具体的事，不给学生贴永久标签</div></div><button class="btn btn-primary" @click="showAdd = true"><Plus :size="14" /> 添加关注</button></div>
    <div class="card">
      <div class="card-title"><Tag :size="16" /> 进行中的关注 <span class="count">{{ focus.filter(f => f.status !== '已结束').length }} 项</span></div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!focus.length" class="empty-state">暂无关注事项</div>
      <div v-else class="focus-list">
        <div v-for="item in focus" :key="item.id" class="focus-card" :class="{ ended: item.status === '已结束' }">
          <div class="focus-card-head"><div><span class="focus-topic">{{ item.topic }}</span><span class="focus-student">{{ item.student_name }}</span></div><span class="tag" :class="item.status === '已结束' ? 'tag-green' : 'tag-orange'">{{ item.status }}</span></div>
          <div class="focus-reason">{{ item.reason }}</div>
          <div class="focus-meta">下次检查：{{ item.next_review_at || '未设置' }}<span v-if="item.action_plan"> · 计划：{{ item.action_plan }}</span></div>
          <button v-if="item.status !== '已结束'" class="btn btn-sm btn-outline" @click="closeFocus(item)">结束本次关注</button>
        </div>
      </div>
    </div>
    <QuickRecordModal v-if="showAdd" mode="focus" @success="showAdd = false; load()" @close="showAdd = false" />
  </div>
</template>
