<script setup>
import { ref, onMounted } from 'vue'
import { get } from '../api'
import AddModal from '../components/AddModal.vue'

const notes = ref([])
const categories = ref([])
const loading = ref(true)
const showCreate = ref(false)

async function load() {
  loading.value = true
  try {
    const data = await get('/api/knowledge/notes')
    notes.value = data.notes || []
    categories.value = data.categories || []
  } finally {
    loading.value = false
  }
}

function grouped() {
  const cats = [...categories.value]
  if (notes.value.some(n => !cats.includes(n.category))) cats.push('未分类')
  return cats.map(c => ({
    name: c,
    items: notes.value.filter(n => n.category === c)
  })).filter(g => g.items.length)
}

function fmtDate(ts) {
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function fmtSize(b) {
  if (!b) return '0B'
  if (b < 1024) return b + 'B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'KB'
  return (b / (1024 * 1024)).toFixed(1) + 'MB'
}

function openNote(n) {
  const file = n.relative_path.replace('.md', '').replace(/\\/g, '/')
  window.open(`obsidian://open?vault=知识库&file=${encodeURIComponent(file)}`, '_blank')
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div class="page-title">知识库</div>
    </div>

    <div class="card">
      <div class="card-title">快速创建笔记</div>
      <div class="toolbar">
        <button class="btn btn-primary" @click="showCreate = true">📝 新建笔记</button>
        <button class="btn btn-outline" @click="window.open('obsidian://open?vault=知识库')">🔗 打开 Obsidian</button>
      </div>
      <div class="toolbar">
        <button v-for="t in ['备课笔记','班会记录','班主任日志','学生档案','考研知识点','读书笔记']" :key="t"
          class="btn btn-outline" @click="() => { showCreate = true }">📖 {{ t }}</button>
      </div>
    </div>

    <div v-if="loading" class="loading">加载中...</div>
    <div v-else-if="!notes.length" class="card">
      <div class="empty-state">知识库还是空的，点击上方按钮创建第一篇笔记吧 📝</div>
    </div>

    <div v-for="g in grouped" :key="g.name" class="card">
      <div class="card-title">{{ g.name }} ({{ g.items.length }})</div>
      <div class="note-grid">
        <div v-for="n in g.items" :key="n.relative_path" class="note-card" @click="openNote(n)">
          <div class="note-name">{{ n.name }}</div>
          <div class="note-meta">{{ fmtDate(n.modified) }} · {{ fmtSize(n.size) }}</div>
          <span class="note-open" @click.stop="openNote(n)">在 Obsidian 中打开 ↗</span>
        </div>
      </div>
    </div>

    <AddModal v-if="showCreate" title="新建笔记" mode="knowledge"
      @success="showCreate = false; load()" @close="showCreate = false" />
  </div>
</template>