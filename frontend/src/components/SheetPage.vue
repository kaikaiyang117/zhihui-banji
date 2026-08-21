<script setup>
import { ref, onMounted } from 'vue'
import { Download } from 'lucide-vue-next'
import { get, del, scopedUrl } from '../api'
import DataTable from './DataTable.vue'
import AddModal from './AddModal.vue'
import { SHEET_FIELDS } from '../sheets'
import { useConfirmDialog } from '../composables/confirmDialog'

const props = defineProps({
  title: String,          // 页面标题
  sheetName: String,      // 工作表名
  addTitle: { type: String, default: '添加记录' },
  addButton: String,
  searchable: { type: Boolean, default: false },
  highlight: { type: Array, default: () => [] },
  showDelete: { type: Boolean, default: true }
})

const headers = ref([])
const rows = ref([])
const loading = ref(true)
const showModal = ref(false)
const { confirm: confirmDialog } = useConfirmDialog()

async function load() {
  loading.value = true
  try {
    const data = await get(`/api/sheet/${props.sheetName}`)
    headers.value = data.headers || []
    rows.value = data.rows || []
  } catch (e) {
    alert('加载失败: ' + e.message)
  } finally {
    loading.value = false
  }
}

async function removeRow(rowNo) {
  if (!(await confirmDialog({ title: '删除记录？', message: '删除后记录会进入回收站，可以恢复。', confirmText: '移入回收站' }))) return
  try {
    await del(`/api/sheet/${props.sheetName}/row/${rowNo}`)
    load()
  } catch (e) {
    alert('删除失败: ' + e.message)
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div class="page-title">{{ title }}</div>
      <div class="toolbar" style="margin-bottom:0">
        <button v-if="addButton" class="btn btn-primary" @click="showModal = true">{{ addButton }}</button>
        <a class="btn btn-outline btn-export" :href="scopedUrl(`/api/export/sheet/${sheetName}`)"><Download :size="14" :stroke-width="2" /> 导出Excel</a>
      </div>
    </div>
    <div class="card">
      <div class="card-title">{{ title }}</div>
      <div v-if="loading" class="loading">加载中...</div>
      <DataTable v-else :headers="headers" :rows="rows" :searchable="searchable"
        :highlight="highlight" :show-delete="showDelete" @delete="removeRow" />
    </div>

    <AddModal v-if="showModal" :title="addTitle"
      :fields="SHEET_FIELDS[sheetName] || []" :sheet-name="sheetName"
      @success="showModal = false; load()" @close="showModal = false" />
  </div>
</template>
