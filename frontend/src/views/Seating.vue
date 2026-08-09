<script setup>
import { ref, computed, onMounted } from 'vue'
import { Download, Pencil, Printer } from 'lucide-vue-next'
import { get, post } from '../api'

const grid = ref([])
const students = ref([])
const loading = ref(true)
const editing = ref(false)
const editingCell = ref(null)
const dragSource = ref(null)
const saving = ref(false)
const columnCount = computed(() => grid.value.reduce((max, row) => Math.max(max, row.length), 0))
const specialValues = new Set(['讲台', '前门', '后门', '过道', '黑板'])
const hasFrontStage = computed(() => grid.value[0]?.some(value => ['讲台', '黑板'].includes(value)))
const studentRows = computed(() => {
  const offset = hasFrontStage.value ? 1 : 0
  return grid.value.slice(offset)
    .map((row, index) => ({ row, sourceRow: index + offset }))
    .filter(({ row }) => !(row.some(value => specialValues.has(value)) && !row.some(value => value && !specialValues.has(value))))
})
const assignedCount = computed(() => studentRows.value.flatMap(item => item.row).filter(value => value && !specialValues.has(value)).length)
const studentIdByName = computed(() => Object.fromEntries(
  students.value.map(student => [student.姓名, student.id]),
))
const studentGenderByName = computed(() => Object.fromEntries(
  students.value.map(student => [student.姓名, student.性别]),
))
const studentNoByName = computed(() => Object.fromEntries(
  students.value.map(student => [student.姓名, student.学号]),
))

async function load() {
  loading.value = true
  try {
    const [seating, roster] = await Promise.all([get('/api/seating'), get('/api/students')])
    grid.value = normalizeGrid(seating.grid || [])
    students.value = roster.students || []
  } finally {
    loading.value = false
  }
}

function normalizeGrid(value) {
  if (!value.length) return []
  const columns = Math.max(...value.map(row => row.length))
  return value.map(row => Array.from({ length: columns }, (_, index) => row[index] || ''))
}

function cellClass(value) {
  if (!value) return 'seat-cell empty'
  return 'seat-cell'
}

function genderClass(value) {
  if (studentGenderByName.value[value] === '男') return 'gender-male'
  if (studentGenderByName.value[value] === '女') return 'gender-female'
  return ''
}

function startEdit(row, col) {
  if (!editing.value) return
  editingCell.value = `${row}-${col}`
}

function startDrag(row, col) {
  if (!editing.value || !grid.value[row]?.[col]) return
  dragSource.value = { row, col }
}

async function dropSeat(row, col) {
  const source = dragSource.value
  dragSource.value = null
  if (!source || (source.row === row && source.col === col)) return

  const sourceValue = grid.value[source.row][source.col]
  grid.value[source.row][source.col] = grid.value[row][col] || ''
  grid.value[row][col] = sourceValue || ''
  saving.value = true
  try {
    await Promise.all([
      post('/api/seating/update', { row: source.row, col: source.col, value: grid.value[source.row][source.col] }),
      post('/api/seating/update', { row, col, value: grid.value[row][col] }),
    ])
  } finally {
    saving.value = false
  }
}

async function saveCell(row, col) {
  saving.value = true
  try {
    await post('/api/seating/update', { row, col, value: grid.value[row][col] || '' })
    editingCell.value = null
  } finally {
    saving.value = false
  }
}

async function autoFill() {
  if (!editing.value || !students.value.length || !window.confirm('按学号重新排列全部学生座位？当前座位顺序会被替换。')) return
  const ordered = [...students.value].sort((left, right) => String(left.学号).localeCompare(String(right.学号), 'zh-CN', { numeric: true }))
  const offset = hasFrontStage.value ? 1 : 0
  const rowsNeeded = Math.ceil(ordered.length / columnCount.value)
  const nextGrid = hasFrontStage.value ? [grid.value[0].map(value => value || '')] : []
  for (let row = 0; row < rowsNeeded; row += 1) {
    nextGrid.push(Array.from({ length: columnCount.value }, (_, col) => ordered[row * columnCount.value + col]?.姓名 || ''))
  }
  saving.value = true
  try {
    const updates = []
    for (let row = offset; row < grid.value.length; row += 1) {
      for (let col = 0; col < columnCount.value; col += 1) updates.push(post('/api/seating/update', { row, col, value: '' }))
    }
    for (let row = offset; row < nextGrid.length; row += 1) {
      for (let col = 0; col < columnCount.value; col += 1) updates.push(post('/api/seating/update', { row, col, value: nextGrid[row][col] || '' }))
    }
    await Promise.all(updates)
    grid.value = nextGrid
    editingCell.value = null
  } finally {
    saving.value = false
  }
}

function printSeating() {
  editing.value = false
  editingCell.value = null
  dragSource.value = null
  const printStyle = document.createElement('style')
  printStyle.dataset.workbenchPrint = 'seating'
  printStyle.textContent = '@page { size: A4 landscape; margin: 10mm; }'
  document.head.appendChild(printStyle)
  const cleanup = () => printStyle.remove()
  window.addEventListener('afterprint', cleanup, { once: true })
  requestAnimationFrame(() => window.print())
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div>
        <div class="page-title">班级座位表</div>
        <div class="page-subtitle">座位从上到下、从左到右编号，学生面向上方讲台</div>
      </div>
      <a class="btn btn-outline btn-export" href="/api/export/sheet/座位表"><Download :size="14" :stroke-width="2" /> 导出Excel</a>
    </div>
    <div class="card seating-card">
      <div class="card-title seating-card-title">
        <div><span>班级座位表</span><span class="count">{{ assignedCount }}/{{ students.length || assignedCount }} 已排座</span></div>
        <div class="seating-card-actions">
          <button class="btn btn-outline seating-print-button" @click="printSeating"><Printer :size="14" /> 打印 / 保存 PDF</button>
          <button v-if="editing" class="btn btn-outline" @click="autoFill">按学号自动排座</button>
          <button class="btn btn-outline seat-edit-btn" @click="editing = !editing; editingCell = null; dragSource = null"><Pencil :size="14" /> {{ editing ? '完成编辑' : '编辑座位' }}</button>
        </div>
      </div>
      <div v-if="loading" class="loading">加载中...</div>
      <div v-else-if="!grid.length" class="empty-state">座位表还是空的</div>
      <div v-else>
        <div class="seating-scroll">
          <div class="seating-board" :style="{ '--seat-columns': columnCount }">
            <div class="seating-direction"><span>前方</span><strong>教师讲台 / 黑板</strong><span>学生面向此处</span></div>
            <div class="seating-legend" aria-label="性别颜色图例"><span><i class="legend-male"></i>男生</span><span><i class="legend-female"></i>女生</span><span><i class="legend-neutral"></i>未标记</span></div>
            <div class="seating-front" :style="{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }">
              <div class="seating-blackboard">黑板</div>
              <div class="seating-podium" :style="{ gridColumn: columnCount > 2 ? '3 / span 2' : '1 / -1' }">讲台</div>
            </div>
            <div class="seating-grid" :style="{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }">
              <div v-for="(seatRow, rowIndex) in studentRows" :key="seatRow.sourceRow" style="display:contents">
                <div
                  v-for="(value, col) in seatRow.row"
                  :key="col"
                  :class="[cellClass(value), genderClass(value)]"
                  :draggable="editing && Boolean(value) && !specialValues.has(value)"
                  @click="startEdit(seatRow.sourceRow, col)"
                  @dragstart="startDrag(seatRow.sourceRow, col)"
                  @dragover.prevent
                  @drop="dropSeat(seatRow.sourceRow, col)"
                  @dragend="dragSource = null"
                >
                  <input v-if="editing && editingCell === `${seatRow.sourceRow}-${col}`" v-model="grid[seatRow.sourceRow][col]" class="seat-input" autofocus @keyup.enter="saveCell(seatRow.sourceRow, col)" @blur="saveCell(seatRow.sourceRow, col)">
                  <template v-else>
                    <span class="seat-number">{{ rowIndex + 1 }}-{{ col + 1 }}</span>
                    <router-link v-if="value && studentIdByName[value] && !editing" :to="`/student/${studentIdByName[value]}`" class="seat-name">{{ value }}</router-link>
                    <strong v-else-if="value" class="seat-name">{{ value }}</strong>
                    <small v-if="value && studentNoByName[value]" class="seat-student-no">{{ studentNoByName[value] }}</small>
                    <span v-else class="seat-empty-label">空座</span>
                  </template>
                </div>
              </div>
            </div>
            <div class="seating-back"><span>后门</span><span>后排</span><span>后门</span></div>
          </div>
        </div>
        <div class="hint" style="margin-top:10px">{{ saving ? '正在保存…' : editing ? '点击座位修改姓名；拖动学生卡片可直接换座，回车或移开焦点即可保存' : '学生面向上方讲台，编辑模式支持拖拽换座' }}</div>
      </div>
    </div>
  </div>
</template>
