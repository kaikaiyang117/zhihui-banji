<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { get, del } from '../api'
import DataTable from '../components/DataTable.vue'
import AddModal from '../components/AddModal.vue'
import { Plus, Upload, FileDown, Download } from 'lucide-vue-next'
import { useConfirmDialog } from '../composables/confirmDialog'

const students = ref([])
const loading = ref(true)
const showImport = ref(false)
const showModal = ref(false)
const editId = ref(null)
const editData = ref(null)
const keyword = ref('')
const router = useRouter()
const { confirm: confirmDialog } = useConfirmDialog()
const studentHeaders = ['学号', '姓名', '性别', '出生年月', '民族', '是否住校', '班级任职', '监护人']
const studentColWidths = [72, 76, 48, 86, 58, 72, 88, 100]

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

function openStudent(row) {
  const student = students.value.find(item => item.id === row.row_no)
  if (student) router.push(`/student/${student.id}`)
}

function guardianSummary(student) {
  const guardians = [
    ['监护人姓名', '监护人电话'],
    ['监护人2姓名', '监护人2电话']
  ].filter(fields => fields.some(field => student[field]))
  return guardians.length ? `${guardians.length} 人已登记` : '未登记'
}

function startEdit(rowNo) {
  const student = students.value.find(item => item.id === rowNo)
  if (!student) return
  editId.value = rowNo
  editData.value = {
    '学号': student['学号'] ?? '',
    '姓名': student['姓名'] ?? '',
    '性别': student['性别'] ?? '',
    '出生年月': student['出生年月'] ?? '',
    '民族': student['民族'] ?? '',
    '家庭住址': student['家庭住址'] ?? '',
    '监护人姓名': student['监护人姓名'] ?? '',
    '监护人电话': student['监护人电话'] ?? '',
    '监护人职业': student['监护人职业'] ?? '',
    '是否住校': student['是否住校'] ?? '',
    '特长': student['特长'] ?? '',
    '班级任职': student['班级任职'] ?? '',
    '备注': student['备注'] ?? '',
    '监护人2姓名': student['监护人2姓名'] ?? '',
    '监护人2电话': student['监护人2电话'] ?? '',
    '监护人2关系': student['监护人2关系'] ?? '',
  }
  showModal.value = true
}

async function removeStudent(id) {
  if (!(await confirmDialog({ title: '删除学生？', message: '学生会进入回收站，相关记录不会丢失。', confirmText: '移入回收站' }))) return
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
      <div class="card-title">学生信息总表 <span class="count">共 {{ students.length }} 人 · 点击学生行查看完整档案</span></div>
      <div class="toolbar">
        <div class="search-box">
          <input type="text" placeholder="搜索学号或姓名..." v-model="keyword" @keyup.enter="load">
          <button class="btn btn-outline btn-sm" style="margin-left:8px" @click="load">搜索</button>
        </div>
      </div>
      <div v-if="loading" class="loading">加载中...</div>
      <DataTable v-else :headers="studentHeaders"
        :rows="students.map(s => ({ row_no: s.id, data: [s['学号'], s['姓名'], s['性别'], s['出生年月'], s['民族'], s['是否住校'], s['班级任职'], guardianSummary(s)] }))"
        :col-widths="studentColWidths"
        :show-edit="true" :show-delete="true"
        @delete="rowNo => removeStudent(rowNo)"
        @edit="rowNo => startEdit(rowNo)"
        @row-click="openStudent" />
    </div>

    <AddModal v-if="showImport" title="导入学生信息" mode="import" @close="showImport = false" @success="showImport = false; load()" />
    <AddModal v-if="showModal" :title="editId ? '编辑学生信息' : '添加学生'"
      mode="student" :student-id="editId" :student-data="editData"
      @success="showModal = false; load()" @close="showModal = false" />
  </div>
</template>
