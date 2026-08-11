<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Check, ChevronLeft, ChevronRight, Plus, RotateCcw, Trash2 } from 'lucide-vue-next'
import { del, get, post, put } from '../api'
import { useConfirmDialog } from '../composables/confirmDialog'

const route = useRoute()
const sourceId = Number(route.query.source_id || 0)
const students = ref([])
const assignments = ref([])
const rules = ref([])
const selectedDate = ref(localDate())
const weekStart = ref(mondayOf(selectedDate.value))
const viewMode = ref('day')
const message = ref('')
const sourceLoaded = ref(false)
const showRules = ref(false)
const completing = ref(null)
const completionResult = ref('')
const preview = ref(null)
const form = ref({ area: '', student_id: '', status: '待完成', note: '' })
const ruleForm = ref({ name: '', area: '', start_date: localDate(), end_date: '', weekday_mask: 31, student_ids: [] })
const { confirm: confirmDialog } = useConfirmDialog()

function localDate(offset = 0) {
  const d = new Date(); d.setDate(d.getDate() + offset)
  const pad = value => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function parseDate(value) { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d) }
function dateText(date) { const pad = value => String(value).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` }
function mondayOf(value) { const date = parseDate(value); const day = date.getDay() || 7; date.setDate(date.getDate() - day + 1); return dateText(date) }
function addDays(value, count) { const date = parseDate(value); date.setDate(date.getDate() + count); return dateText(date) }
const rangeStart = computed(() => viewMode.value === 'day' ? selectedDate.value : weekStart.value)
const rangeEnd = computed(() => viewMode.value === 'day' ? selectedDate.value : addDays(weekStart.value, 6))
const dayColumns = computed(() => Array.from({ length: 7 }, (_, index) => ({ date: addDays(weekStart.value, index), label: ['一', '二', '三', '四', '五', '六', '日'][index] })))

async function load() {
  const dutyPath = sourceId && !sourceLoaded.value ? `/api/duty?source_id=${sourceId}` : `/api/duty?date_from=${rangeStart.value}&date_to=${rangeEnd.value}`
  const [studentData, dutyData, ruleData] = await Promise.all([get('/api/students'), get(dutyPath), get('/api/duty/rotation-rules')])
  students.value = studentData.students || []
  assignments.value = dutyData.assignments || []
  rules.value = ruleData.rules || []
  if (sourceId && !sourceLoaded.value && assignments.value[0]) {
    selectedDate.value = assignments.value[0].duty_date
    weekStart.value = mondayOf(selectedDate.value)
    sourceLoaded.value = true
  }
}

function forDate(date) { return assignments.value.filter(item => item.duty_date === date) }
function shiftWeek(count) { weekStart.value = addDays(weekStart.value, count * 7); load() }
function selectAllRuleMembers() { ruleForm.value.student_ids = students.value.map(student => student.id) }

async function addDuty() {
  if (!form.value.area || !form.value.student_id) return
  try {
    await post('/api/duty', { ...form.value, duty_date: selectedDate.value, student_id: Number(form.value.student_id) })
    form.value = { area: '', student_id: '', status: '待完成', note: '' }
    message.value = '值日安排已保存'; await load()
  } catch (error) { message.value = `保存失败：${error.message}` }
}

function toggle(item) {
  if (item.status === '已完成') return updateStatus(item, '待完成', '')
  completing.value = item
  completionResult.value = item.completion_result || ''
}
async function updateStatus(item, status, result) {
  try { await put(`/api/duty/${item.id}`, { status, note: item.note || '', completion_result: result }); await load() } catch (error) { message.value = `更新失败：${error.message}` }
}
async function submitCompletion() {
  if (!completionResult.value.trim() || !completing.value) return
  const item = completing.value
  completing.value = null
  await updateStatus(item, '已完成', completionResult.value)
  completionResult.value = ''
}

async function removeDuty(item) {
  if (!(await confirmDialog({ title: '删除值日安排？', message: `将删除“${item.area} · ${item.姓名}”并移入回收站。`, confirmText: '移入回收站' }))) return
  await del(`/api/records/duty_assignment/${item.id}`); await load()
}

async function createRule() {
  try {
    await post('/api/duty/rotation-rules', { ...ruleForm.value, student_ids: ruleForm.value.student_ids.map(Number) })
    message.value = '轮换规则已保存'; ruleForm.value = { name: '', area: '', start_date: localDate(), end_date: '', weekday_mask: 31, student_ids: [] }; await load()
  } catch (error) { message.value = `规则保存失败：${error.message}` }
}
async function previewRotation(rule) {
  try {
    preview.value = await post(`/api/duty/rotation-rules/${rule.id}/generate`, { date_from: weekStart.value, date_to: addDays(weekStart.value, 6), confirm: false })
  } catch (error) { message.value = `预览失败：${error.message}` }
}
async function confirmRotation() {
  if (!preview.value?.rule) return
  try {
    const result = await post(`/api/duty/rotation-rules/${preview.value.rule.id}/generate`, { date_from: weekStart.value, date_to: addDays(weekStart.value, 6), confirm: true })
    message.value = `已生成 ${result.created} 项值日安排`; preview.value = null; await load()
  } catch (error) { message.value = `生成失败：${error.message}` }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar"><div><div class="page-title">值日安排</div><div class="page-subtitle">按日期安排区域负责人，检测冲突并保留完成记录</div></div><div class="toolbar" style="margin-bottom:0"><button class="btn btn-outline" @click="showRules = !showRules">轮换规则</button><button class="btn btn-outline" @click="load"><RotateCcw :size="14" /> 刷新</button></div></div>
    <div v-if="message" class="inline-message">{{ message }}</div>

    <div class="card duty-create-card"><div class="card-title"><Plus :size="16" /> 添加值日</div><div class="duty-form"><input class="form-input" v-model="form.area" placeholder="值日区域，如：教室前排"><select class="form-select" v-model="form.student_id"><option value="">选择学生</option><option v-for="student in students" :key="student.id" :value="student.id">{{ student.姓名 }}</option></select><input class="form-input" v-model="form.note" placeholder="备注（可选）"><button class="btn btn-primary" @click="addDuty">保存安排</button></div></div>

    <div v-if="showRules" class="card duty-create-card"><div class="card-title">值日轮换规则</div><div class="form-grid"><label>规则名称<input class="form-input" v-model="ruleForm.name" placeholder="如：教室卫生轮换"></label><label>区域<input class="form-input" v-model="ruleForm.area" placeholder="教室前排"></label><label>开始日期<input class="form-input" type="date" v-model="ruleForm.start_date"></label><label>结束日期<input class="form-input" type="date" v-model="ruleForm.end_date"></label></div><div class="student-picker"><div class="picker-head"><strong>轮换学生</strong><span>{{ ruleForm.student_ids.length }} 人</span><button class="text-button" @click="selectAllRuleMembers">全选</button></div><label v-for="student in students" :key="student.id" class="student-check"><input v-model="ruleForm.student_ids" type="checkbox" :value="student.id"> {{ student.姓名 }}</label></div><div class="modal-actions"><button class="btn btn-primary" @click="createRule">保存规则</button></div><div v-for="rule in rules" :key="rule.id" class="rotation-rule-row"><div><strong>{{ rule.name }}</strong><span>{{ rule.area }} · {{ rule.members.length }}人 · {{ rule.start_date }} 起</span></div><button class="btn btn-sm btn-outline" @click="previewRotation(rule)">预览本周</button></div></div>

    <div class="card">
      <div class="duty-toolbar"><div class="segmented"><button :class="{ active: viewMode === 'day' }" @click="viewMode = 'day'; load()">单日</button><button :class="{ active: viewMode === 'week' }" @click="viewMode = 'week'; weekStart = mondayOf(selectedDate); load()">本周</button></div><label v-if="viewMode === 'day'" class="date-control">日期<input type="date" v-model="selectedDate" @change="load"></label><div v-else class="week-nav"><button class="btn btn-sm btn-outline" @click="shiftWeek(-1)"><ChevronLeft :size="14" /></button><span>{{ weekStart }} 至 {{ rangeEnd }}</span><button class="btn btn-sm btn-outline" @click="shiftWeek(1)"><ChevronRight :size="14" /></button></div></div>
      <div v-if="viewMode === 'day'" class="card-title">{{ selectedDate }} 值日清单 <span class="count">{{ assignments.length }} 项</span></div>
      <div v-if="viewMode === 'day' && !assignments.length" class="empty-state">今天还没有值日安排</div>
      <template v-if="viewMode === 'day'"><div v-for="item in assignments" :key="item.id" class="duty-row" :class="{ 'source-highlight': item.id === sourceId }"><div class="duty-area"><strong>{{ item.area }}</strong><span>{{ item.note || '无备注' }}<template v-if="item.completion_result"> · {{ item.completion_result }}</template></span></div><div class="duty-student">{{ item.姓名 }}<small>{{ item.学号 }}</small></div><div class="record-actions"><button class="tag" :class="item.status === '已完成' ? 'tag-green' : item.is_overdue ? 'tag-red' : 'tag-orange'" @click="toggle(item)"><Check v-if="item.status === '已完成'" :size="13" /> {{ item.status }}</button><button class="btn btn-sm btn-outline" aria-label="删除值日安排" @click="removeDuty(item)"><Trash2 :size="13" /></button></div></div></template>
      <div v-if="viewMode === 'week'" class="duty-week-grid"><div v-for="column in dayColumns" :key="column.date" class="duty-day-column"><div class="duty-day-head"><strong>周{{ column.label }}</strong><span>{{ column.date }}</span></div><div v-if="!forDate(column.date).length" class="hint">无安排</div><div v-for="item in forDate(column.date)" :key="item.id" class="duty-week-item"><strong>{{ item.area }}</strong><span>{{ item.姓名 }}</span><button class="tag" :class="item.status === '已完成' ? 'tag-green' : 'tag-orange'" @click="toggle(item)">{{ item.status }}</button></div></div></div>
    </div>

    <div v-if="preview" class="modal-overlay show" @click.self="preview = null"><div class="modal"><div class="modal-kicker">轮换预览</div><h3>{{ preview.rule.name }}</h3><p class="hint">将生成 {{ preview.proposals.length }} 项安排（{{ preview.rule.area }}）。确认后会写入值日清单和工作台。</p><div class="rotation-preview-list"><div v-for="item in preview.proposals" :key="item.duty_date"><span>{{ item.duty_date }}</span><strong>{{ item.姓名 }}</strong></div></div><div class="modal-actions"><button class="btn btn-outline" @click="preview = null">取消</button><button class="btn btn-primary" :disabled="!preview.can_generate" @click="confirmRotation">确认生成</button></div></div></div>
    <div v-if="completing" class="modal-overlay show" @click.self="completing = null"><div class="modal"><div class="modal-kicker">完成值日</div><h3>{{ completing.area }} · {{ completing.姓名 }}</h3><p class="hint">请留下完成记录，便于后续复盘。</p><textarea class="form-textarea" v-model="completionResult" rows="3" placeholder="如：已完成清扫并检查"></textarea><div class="modal-actions"><button class="btn btn-outline" @click="completing = null">取消</button><button class="btn btn-primary" @click="submitCompletion">确认完成</button></div></div></div>
  </div>
</template>
