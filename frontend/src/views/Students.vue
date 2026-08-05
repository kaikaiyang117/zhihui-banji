<script setup>
import { ref, onMounted } from 'vue'
import { get, del, download } from '../api'
import DataTable from '../components/DataTable.vue'
import AddModal from '../components/AddModal.vue'

const students = ref([])
const loading = ref(true)
const showImport = ref(false)
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
        <button class="btn btn-primary" @click="showImport = true">⬆️ 导入Excel</button>
        <a class="btn btn-outline" href="/api/students/template">📋 模板下载</a>
        <a class="btn btn-outline btn-export" href="/api/students/export">📥 导出Excel</a>
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
      <DataTable v-else :headers="['学号','姓名','性别','出生年月','民族','家庭住址','监护人姓名','监护人电话','监护人职业','是否住校','特长','班级任职','备注']"
        :rows="students.map((s, i) => ({ row_no: s.id, data: [s['学号'], s['姓名'], s['性别'], s['出生年月'], s['民族'], s['家庭住址'], s['监护人姓名'], s['监护人电话'], s['监护人职业'], s['是否住校'], s['特长'], s['班级任职'], s['备注']] }))"
        @delete="rowNo => removeStudent(rowNo)" />
    </div>

    <AddModal v-if="showImport" title="导入学生信息" mode="import" @close="showImport = false" @success="showImport = false; load()" />
  </div>
</template>