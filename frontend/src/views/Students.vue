<script setup>
import { ref, onMounted, watch } from 'vue'
import { get, del, put } from '../api'
import DataTable from '../components/DataTable.vue'
import AddModal from '../components/AddModal.vue'
import { Plus, Upload, FileDown, Download } from 'lucide-vue-next'

const students = ref([])
const loading = ref(true)
const showImport = ref(false)
const showModal = ref(false)
const editId = ref(null)
const editData = ref(null)
const keyword = ref('')

async function load() {
  loading.value = true
  try {
    const data = await get('/api/students?keyword=' + encodeURIComponent(keyword.value))
    students.value = data.students || []
  } finally {
    loading.value = false
  }
}

function startAdd() {
  editId.value = null
  editData.value = null
  showModal.value = true
}

function startEdit(rowNo, data) {
  editId.value = rowNo
  editData.value = {
    '学号': data[0] ?? '',
    '姓名': data[1] ?? '',
    '性别': data[2] ?? '',
    '出生年月': data[3] ?? '',
    '民族': data[4] ?? '',
    '家庭住址': data[5] ?? '',
    '监护人姓名': data[6] ?? '',
    '监护人电话': data[7] ?? '',
    '监护人职业': data[8] ?? '',
    '是否住校': data[9] ?? '',
    '特长': data[10] ?? '',
    '班级任职': data[11] ?? '',
    '备注': data[12] ?? '',
    '监护人2姓名': data[13] ?? '',
    '监护人2电话': data[14] ?? '',
    '监护人2关系': data[15] ?? '',
  }
  showModal.value = true
}

async function removeStudent(id) {
  if (!confirm('确定删除该学生吗？')) return
  await del(`/api/students/${id}`)
  load()
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div class="page-title">学生信息</div>
      <div class="toolbar" style="margin-bottom:0">
        <button class="btn btn-primary" @click="startAdd"><Plus :size="14" :stroke-width="2" /> 添加学生</button>
        <button class="btn btn-primary" @click="showImport = true"><Upload :size="14" :stroke-width="2" /> 导入Excel</button>
        <a class="btn btn-outline" href="/api/students/template"><FileDown :size="14" :stroke-width="2" /> 模板下载</a>
        <a class="btn btn-outline btn-export" href="/api/students/export"><Download :size="14" :stroke-width="2" /> 导出Excel</a>
      </div>
    </div>

    <div class="card">
      <div class="card-title">学生信息总表 <span class="count">共 {{ students.length }} 人</span></div>
      <div class="toolbar">
        <div class="search-box">
          <input type="text" placeholder="搜索学号或姓名..." v-model="keyword" @keyup.enter="load">
          <button class="btn btn-outline btn-sm" style="margin-left:8px" @click="load">搜索</button>
        </div>
      </div>
      <div v-if="loading" class="loading">加载中...</div>
      <DataTable v-else :headers="['学号','姓名','性别','出生年月','民族','家庭住址','监护人1姓名','监护人1电话','监护人1职业','监护人2姓名','监护人2电话','监护人2关系','是否住校','特长','班级任职','备注']"
        :rows="students.map((s, i) => ({ row_no: s.id, data: [s['学号'], s['姓名'], s['性别'], s['出生年月'], s['民族'], s['家庭住址'], s['监护人姓名'], s['监护人电话'], s['监护人职业'], s['监护人2姓名']||'', s['监护人2电话']||'', s['监护人2关系']||'', s['是否住校'], s['特长'], s['班级任职'], s['备注']] }))"
        :col-widths="[64, 68, 46, 80, 54, 148, 76, 116, 60, 76, 116, 60, 56, 76, 76, 100]"
        :show-edit="true"
        @delete="rowNo => removeStudent(rowNo)"
        @edit="(rowNo, data) => startEdit(rowNo, data)" />
    </div>

    <AddModal v-if="showImport" title="导入学生信息" mode="import" @close="showImport = false" @success="showImport = false; load()" />
    <AddModal v-if="showModal" :title="editId ? '编辑学生信息' : '添加学生'"
      mode="student" :student-id="editId" :student-data="editData"
      @success="showModal = false; load()" @close="showModal = false" />
  </div>
</template>