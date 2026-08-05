<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  headers: { type: Array, default: () => [] },
  rows: { type: Array, default: () => [] },      // [{row_no, data:[]}]
  searchable: { type: Boolean, default: false },
  maxHeight: { type: Number, default: 500 },
  highlight: { type: Array, default: () => [] },  // 列索引 → 特殊样式
  showEdit: { type: Boolean, default: false },    // 显示编辑按钮
  colWidths: { type: Array, default: () => [] }   // 每列宽度（px 数值或 'auto'）
})
const emit = defineEmits(['delete', 'edit'])

const keyword = ref('')

const filtered = computed(() => {
  if (!keyword.value) return props.rows
  const k = keyword.value.toLowerCase()
  return props.rows.filter(r =>
    (r.data || []).some(v => v !== null && v !== undefined && String(v).toLowerCase().includes(k)))
})

function fmt(v) {
  if (v === null || v === undefined || v === '') return ''
  return String(v)
}
</script>

<template>
  <div>
    <div v-if="searchable" class="toolbar">
      <div class="search-box">
        <input type="text" placeholder="搜索..." v-model="keyword">
      </div>
    </div>
    <div v-if="!filtered.length" class="empty-state">暂无数据</div>
    <div v-else class="table-wrap" :style="{ maxHeight: maxHeight + 'px' }">
      <table class="data-table" :class="{ 'fixed-layout': colWidths.length }">
        <colgroup v-if="colWidths.length">
          <col style="width:30px">
          <col v-for="(w, i) in colWidths" :key="i" :style="{ width: typeof w === 'number' ? w + 'px' : w }">
          <col v-if="emit || showEdit" style="width:100px">
        </colgroup>
        <thead>
          <tr>
            <th>#</th>
            <th v-for="(h, i) in headers" :key="i">{{ h }}</th>
            <th v-if="$attrs.onDelete || emit || showEdit"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in filtered" :key="row.row_no">
            <td class="idx">{{ ri + 1 }}</td>
            <td v-for="(h, ci) in headers" :key="ci"
              :class="highlight.includes(ci) ? 'cell-strong' : ''">
              <span class="cell-text">{{ fmt(row.data[ci]) }}</span>
            </td>
            <td v-if="emit || showEdit" class="cell-del">
              <button v-if="showEdit" class="btn btn-sm btn-outline"
                @click="$emit('edit', row.row_no, row.data)" style="margin-right:4px">编辑</button>
              <button v-if="emit" class="btn btn-sm btn-danger"
                @click="$emit('delete', row.row_no)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>