<script setup>
import { onMounted, ref } from 'vue'
import { Check, Plus, RotateCcw } from 'lucide-vue-next'
import { get, post, put } from '../api'

const students = ref([])
const assignments = ref([])
const selectedDate = ref(localDate())
const form = ref({ area: '', student_id: '', status: '待完成', note: '' })
const message = ref('')

function localDate() {
  const d = new Date(); const pad = v => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function load() {
  const [studentData, dutyData] = await Promise.all([get('/api/students'), get(`/api/duty?duty_date=${selectedDate.value}`)])
  students.value = studentData.students || []
  assignments.value = dutyData.assignments || []
}

async function addDuty() {
  if (!form.value.area || !form.value.student_id) return
  await post('/api/duty', { ...form.value, duty_date: selectedDate.value, student_id: Number(form.value.student_id) })
  form.value.area = ''; form.value.student_id = ''; form.value.note = ''; message.value = '值日安排已保存'; await load()
}

async function toggle(item) {
  await put(`/api/duty/${item.id}`, { status: item.status === '已完成' ? '待完成' : '已完成', note: item.note || '' })
  await load()
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar"><div><div class="page-title">值日安排</div><div class="page-subtitle">按日期安排区域负责人，完成后留痕</div></div><div class="toolbar" style="margin-bottom:0"><label class="date-control">日期<input type="date" v-model="selectedDate" @change="load"></label><button class="btn btn-outline" @click="load"><RotateCcw :size="14" /> 刷新</button></div></div>
    <div v-if="message" class="inline-message">{{ message }}</div>
    <div class="card duty-create-card"><div class="card-title"><Plus :size="16" /> 添加值日</div><div class="duty-form"><input class="form-input" v-model="form.area" placeholder="值日区域，如：教室前排"><select class="form-select" v-model="form.student_id"><option value="">选择学生</option><option v-for="student in students" :key="student.id" :value="student.id">{{ student.姓名 }}</option></select><input class="form-input" v-model="form.note" placeholder="备注（可选）"><button class="btn btn-primary" @click="addDuty">保存安排</button></div></div>
    <div class="card"><div class="card-title">{{ selectedDate }} 值日清单 <span class="count">{{ assignments.length }} 项</span></div><div v-if="!assignments.length" class="empty-state">今天还没有值日安排</div><div v-for="item in assignments" :key="item.id" class="duty-row"><div class="duty-area"><strong>{{ item.area }}</strong><span>{{ item.note || '无备注' }}</span></div><div class="duty-student">{{ item.姓名 }}<small>{{ item.学号 }}</small></div><button class="tag" :class="item.status === '已完成' ? 'tag-green' : 'tag-orange'" @click="toggle(item)"><Check v-if="item.status === '已完成'" :size="13" /> {{ item.status }}</button></div></div>
  </div>
</template>
