<script setup>
import { ref, onMounted } from 'vue'
import { get } from '../api'

const grid = ref([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const data = await get('/api/seating')
    grid.value = trimGrid(data.grid || [])
  } finally {
    loading.value = false
  }
}

function trimGrid(g) {
  if (!g.length) return []
  let minRow = 0, maxRow = g.length - 1
  while (minRow <= maxRow && g[minRow].every(c => !c)) minRow++
  while (maxRow >= minRow && g[maxRow].every(c => !c)) maxRow--
  if (maxRow < minRow) return []
  return g.slice(minRow, maxRow + 1).map(row => {
    while (row.length && !row[row.length - 1]) row.pop()
    return row
  })
}

function cellClass(v) {
  if (!v) return 'seat-cell empty'
  if (['讲台', '前门', '后门', '过道'].includes(v)) return 'seat-cell special'
  return 'seat-cell'
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div class="page-title">班级座位表</div>
      <a class="btn btn-outline btn-export" href="/api/export/sheet/座位表">📥 导出Excel</a>
    </div>
    <div class="card">
      <div class="card-title">班级座位表</div>
      <div v-if="loading" class="loading">加载中...</div>
      <div v-else-if="!grid.length" class="empty-state">座位表还是空的</div>
      <div v-else>
        <div class="seating-grid" :style="{ gridTemplateColumns: `repeat(${grid[0].length}, 1fr)`, maxWidth: grid[0].length * 70 + 'px' }">
          <div v-for="(row, ri) in grid" :key="ri" style="display:contents">
            <div v-for="(v, ci) in row" :key="ci" :class="cellClass(v)">{{ v }}</div>
          </div>
        </div>
        <div class="hint" style="margin-top:10px">修改座位请通过对话让凯凯小兵操作，或直接在 Excel 中编辑</div>
      </div>
    </div>
  </div>
</template>