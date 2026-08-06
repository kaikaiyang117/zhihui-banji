<script setup>
import { ref, computed, onMounted } from 'vue'
import { Download, Pencil } from 'lucide-vue-next'
import { get, post } from '../api'

const grid = ref([])
const loading = ref(true)
const editing = ref(false)
const editingCell = ref(null)
const saving = ref(false)
const columnCount = computed(() => grid.value.reduce((max, row) => Math.max(max, row.length), 0))

async function load() {
  loading.value = true
  try {
    const data = await get('/api/seating')
    grid.value = normalizeGrid(data.grid || [])
  } finally {
    loading.value = false
  }
}

function normalizeGrid(g) {
  if (!g.length) return []
  const columns = Math.max(...g.map(row => row.length))
  return g.map(row => Array.from({ length: columns }, (_, index) => row[index] || ''))
}

function cellClass(v) {
  if (!v) return 'seat-cell empty'
  if (['讲台', '前门', '后门', '过道'].includes(v)) return 'seat-cell special'
  return 'seat-cell'
}

function startEdit(ri, ci) {
  if (!editing.value) return
  editingCell.value = `${ri}-${ci}`
}

async function saveCell(ri, ci) {
  saving.value = true
  try {
    await post('/api/seating/update', { row: ri, col: ci, value: grid.value[ri][ci] || '' })
    editingCell.value = null
  } finally { saving.value = false }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div class="page-title">班级座位表</div>
      <a class="btn btn-outline btn-export" href="/api/export/sheet/座位表"><Download :size="14" :stroke-width="2" /> 导出Excel</a>
    </div>
    <div class="card">
      <div class="card-title">班级座位表 <span class="count">{{ editing ? '点击格子即可编辑' : '只读预览' }}</span><button class="btn btn-outline seat-edit-btn" @click="editing = !editing; editingCell = null"><Pencil :size="14" /> {{ editing ? '完成编辑' : '编辑座位' }}</button></div>
      <div v-if="loading" class="loading">加载中...</div>
      <div v-else-if="!grid.length" class="empty-state">座位表还是空的</div>
      <div v-else>
        <div class="seating-scroll">
          <div class="seating-grid" :style="{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }">
            <div v-for="(row, ri) in grid" :key="ri" style="display:contents">
              <div v-for="(v, ci) in row" :key="ci" :class="cellClass(v)" @click="startEdit(ri, ci)">
                <input v-if="editing && editingCell === `${ri}-${ci}`" v-model="grid[ri][ci]" class="seat-input" autofocus @keyup.enter="saveCell(ri, ci)" @blur="saveCell(ri, ci)">
                <span v-else>{{ v }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="hint" style="margin-top:10px">{{ saving ? '正在保存…' : '编辑模式下点击任意座位，回车或移开焦点即可保存' }}</div>
      </div>
    </div>
  </div>
</template>
