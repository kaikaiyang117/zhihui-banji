<script setup>
import { computed, onMounted, ref } from 'vue'
import { BedDouble, Check, ClipboardCheck, Pencil, Plus, RotateCcw, UserRound, X } from 'lucide-vue-next'
import { get, post, put } from '../api'
import { useConfirmDialog } from '../composables/confirmDialog'

const rooms = ref([])
const assignments = ref([])
const unassigned = ref([])
const inspections = ref([])
const loading = ref(true)
const message = ref('')
const roomForm = ref({ building: '', floor: '', room_no: '', gender_limit: '不限', capacity: 4, note: '' })
const editingRoom = ref(null)
const assignForm = ref({ student_id: '', bed_id: '', move_in_at: '', note: '' })
const moving = ref(null)
const moveForm = ref({ bed_id: '', move_in_at: '', reason: '', note: '' })
const leaderRoom = ref(null)
const leaderStudent = ref('')
const checking = ref(false)
const inspectionDetail = ref(null)
const inspectionForm = ref({ inspection_date: '', inspection_time: '20:30', inspector: '班主任', note: '', records: [] })
const selectedBedId = ref(null)
const { confirm: confirmDialog } = useConfirmDialog()

const availableBeds = computed(() => rooms.value.flatMap(room => (room.beds || []).filter(bed => !bed.assignment_id && bed.status === '可用').map(bed => ({ ...bed, room_label: `${room.building || ''}${room.room_no} · ${bed.bed_no}号床` }))))
const occupiedCount = computed(() => rooms.value.reduce((sum, room) => sum + Number(room.occupied_count || 0), 0))
const latestInspection = computed(() => inspections.value[0] || null)
const selectedBed = computed(() => {
  for (const room of rooms.value) {
    const bed = (room.beds || []).find(item => Number(item.id) === Number(selectedBedId.value))
    if (bed) return { room, bed }
  }
  return null
})
const selectedAssignment = computed(() => {
  const assignmentId = selectedBed.value?.bed.assignment_id
  return assignmentId ? assignments.value.find(item => Number(item.id) === Number(assignmentId)) : null
})

async function load() {
  loading.value = true
  try {
    const [roomData, assignmentData, unassignedData, inspectionData] = await Promise.all([
      get('/api/dormitories/rooms'), get('/api/dormitories/assignments'), get('/api/dormitories/unassigned'), get('/api/dormitories/inspections'),
    ])
    rooms.value = roomData.rooms || []
    assignments.value = assignmentData.assignments || []
    unassigned.value = unassignedData.students || []
    inspections.value = inspectionData.inspections || []
    selectedBedId.value = null
  } finally { loading.value = false }
}

function resetRoomForm() { roomForm.value = { building: '', floor: '', room_no: '', gender_limit: '不限', capacity: 4, note: '' } }

async function saveRoom() {
  if (!roomForm.value.room_no) return
  try {
    if (editingRoom.value) await put(`/api/dormitories/rooms/${editingRoom.value.id}`, roomForm.value)
    else await post('/api/dormitories/rooms', roomForm.value)
    message.value = editingRoom.value ? '宿舍信息已保存' : '宿舍已创建'
    editingRoom.value = null; resetRoomForm(); await load()
  } catch (error) { message.value = `保存失败：${error.message}` }
}

function editRoom(room) {
  editingRoom.value = room
  roomForm.value = { building: room.building, floor: room.floor, room_no: room.room_no, gender_limit: room.gender_limit, capacity: room.capacity, note: room.note || '' }
}

function cancelRoomEdit() { editingRoom.value = null; resetRoomForm() }

function openLeader(room) {
  leaderRoom.value = room
  leaderStudent.value = String(room.leader?.student_id || '')
}

async function saveLeader() {
  if (!leaderRoom.value) return
  try {
    await put(`/api/dormitories/rooms/${leaderRoom.value.id}/leader`, { student_id: leaderStudent.value ? Number(leaderStudent.value) : null, assigned_at: today() })
    message.value = leaderStudent.value ? '寝室长已指定' : '寝室长已解除'
    leaderRoom.value = null
    await load()
  } catch (error) { message.value = `保存寝室长失败：${error.message}` }
}

function today() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function openInspection() {
  inspectionForm.value = {
    inspection_date: today(), inspection_time: '20:30', inspector: '班主任', note: '',
    records: assignments.value.map(item => ({ student_id: item.student_id, status: '在寝', note: '' })),
  }
  checking.value = true
}

async function saveInspection() {
  if (!inspectionForm.value.inspection_date || !inspectionForm.value.records.length) return
  try {
    await post('/api/dormitories/inspections', inspectionForm.value)
    message.value = '查寝记录已保存'
    checking.value = false
    await load()
  } catch (error) { message.value = `保存查寝失败：${error.message}` }
}

function inspectionRecord(studentId) {
  return inspectionForm.value.records.find(record => Number(record.student_id) === Number(studentId))
}

async function showInspection(item) {
  try {
    const data = await get(`/api/dormitories/inspections/${item.id}`)
    inspectionDetail.value = data.inspection
  } catch (error) { message.value = `加载查寝详情失败：${error.message}` }
}

async function assign() {
  if (!assignForm.value.student_id || !assignForm.value.bed_id) return
  try {
    await post('/api/dormitories/assignments', { ...assignForm.value, student_id: Number(assignForm.value.student_id), bed_id: Number(assignForm.value.bed_id) })
    message.value = '住宿安排已保存'; assignForm.value = { student_id: '', bed_id: '', move_in_at: '', note: '' }; await load()
  } catch (error) { message.value = `安排失败：${error.message}` }
}

function openMove(item) {
  moving.value = item
  moveForm.value = { bed_id: '', move_in_at: '', reason: '', note: '' }
}

function selectBed(bed) {
  if (!bed.assignment_id) return
  selectedBedId.value = Number(selectedBedId.value) === Number(bed.id) ? null : bed.id
}

async function move() {
  if (!moving.value || !moveForm.value.bed_id) return
  try {
    await post(`/api/dormitories/assignments/${moving.value.id}/move`, { ...moveForm.value, bed_id: Number(moveForm.value.bed_id) })
    message.value = '调宿已保存'; moving.value = null; await load()
  } catch (error) { message.value = `调宿失败：${error.message}` }
}

async function checkout(item) {
  if (!(await confirmDialog({ title: '确认退宿？', message: `${item.姓名} 将从当前床位退宿，历史记录会保留。`, confirmText: '确认退宿' }))) return
  try { await post(`/api/dormitories/assignments/${item.id}/checkout`, { reason: '退宿' }); message.value = '退宿已记录'; await load() } catch (error) { message.value = `退宿失败：${error.message}` }
}

function roomLabel(room) { return `${room.building || ''}${room.room_no}${room.floor ? `（${room.floor}层）` : ''}` }

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar"><div><div class="page-title">宿舍管理</div><div class="page-subtitle">管理房间、床位、寝室长和当前班级学生的入住记录</div></div><button class="btn btn-outline" @click="load"><RotateCcw :size="14" /> 刷新</button></div>
    <div v-if="message" class="inline-message">{{ message }}</div>

    <div class="dorm-stats"><div class="overview-card"><span>宿舍房间</span><strong>{{ rooms.length }}</strong></div><div class="overview-card"><span>当前入住</span><strong>{{ occupiedCount }}</strong></div><div class="overview-card"><span>待安排学生</span><strong>{{ unassigned.length }}</strong></div><div class="overview-card"><span>最近查寝</span><strong>{{ latestInspection ? latestInspection.inspection_date : '未记录' }}</strong></div></div>

    <div class="card dorm-form-card"><div class="card-title"><BedDouble :size="16" /> {{ editingRoom ? '编辑宿舍' : '新增宿舍' }}</div><div class="form-grid"><label>楼栋<input v-model="roomForm.building" class="form-input" placeholder="如：一号楼"></label><label>楼层<input v-model="roomForm.floor" class="form-input" placeholder="如：1"></label><label>房间号<input v-model="roomForm.room_no" class="form-input" placeholder="如：101"></label><label>性别限制<select v-model="roomForm.gender_limit" class="form-select"><option>不限</option><option>男</option><option>女</option></select></label><label>床位数<input v-model.number="roomForm.capacity" class="form-input" type="number" min="1" max="8"><small class="field-hint">每间宿舍最多8人</small></label><label>备注<input v-model="roomForm.note" class="form-input" placeholder="可选"></label></div><div class="modal-actions"><button v-if="editingRoom" class="btn btn-outline" @click="cancelRoomEdit">取消编辑</button><button class="btn btn-primary" @click="saveRoom"><Plus v-if="!editingRoom" :size="14" /><Check v-else :size="14" /> {{ editingRoom ? '保存宿舍' : '创建宿舍' }}</button></div></div>

    <div class="card dorm-form-card"><div class="card-title">安排入住 <span class="count">当前班级 · 当前学期</span></div><div class="dorm-assign-form"><select v-model="assignForm.student_id" class="form-select"><option value="">选择待安排学生</option><option v-for="student in unassigned" :key="student.id" :value="student.id">{{ student.姓名 }} · {{ student.学号 }}</option></select><select v-model="assignForm.bed_id" class="form-select"><option value="">选择空床位</option><option v-for="bed in availableBeds" :key="bed.id" :value="bed.id">{{ bed.room_label }}</option></select><input v-model="assignForm.move_in_at" class="form-input" type="date"><button class="btn btn-primary" @click="assign">保存安排</button></div></div>

    <div class="card inspection-card"><div class="inspection-head"><div><div class="card-title"><ClipboardCheck :size="16" /> 查寝管理</div><div class="inspection-summary">记录当前入住学生的在寝、未归、晚归和请假状态</div></div><button class="btn btn-primary" @click="openInspection"><ClipboardCheck :size="14" /> 发起查寝</button></div><div v-if="!inspections.length" class="empty-inline">还没有查寝记录。</div><div v-else class="inspection-history"><button v-for="item in inspections" :key="item.id" class="inspection-history-item" @click="showInspection(item)"><span><strong>{{ item.inspection_date }} {{ item.inspection_time }}</strong><small>{{ item.inspector || '未填写查寝人' }}</small></span><span class="inspection-counts"><em>在寝 {{ item.present_count }}</em><em v-if="item.absent_count">未归 {{ item.absent_count }}</em><em v-if="item.late_count">晚归 {{ item.late_count }}</em><em v-if="item.leave_count">请假 {{ item.leave_count }}</em></span></button></div></div>

    <div v-if="loading" class="loading">加载中...</div>
    <div v-else-if="!rooms.length" class="card empty-state">还没有宿舍房间，请先创建房间和床位。</div>
    <div v-else class="dorm-room-grid"><article v-for="room in rooms" :key="room.id" class="card dorm-room-card"><div class="dorm-room-head"><div><h3>{{ roomLabel(room) }}</h3><span>{{ room.gender_limit }} · {{ room.occupied_count }}/{{ room.capacity }} 人 · {{ room.status }}</span><div class="room-leader"><UserRound :size="13" /> 寝室长：{{ room.leader?.姓名 || '未指定' }}</div></div><div class="room-head-actions"><button class="btn btn-sm btn-outline" @click="openLeader(room)"><UserRound :size="13" /> 寝室长</button><button class="btn btn-sm btn-outline" @click="editRoom(room)"><Pencil :size="13" /> 编辑</button></div></div><div class="bed-grid"><button v-for="bed in room.beds" :key="bed.id" type="button" class="bed-cell" :class="{ occupied: bed.assignment_id, unavailable: bed.status !== '可用', selected: selectedBedId === bed.id }" :disabled="!bed.assignment_id" :aria-pressed="selectedBedId === bed.id" @click="selectBed(bed)"><strong>{{ bed.bed_no }}号床</strong><span v-if="bed.assignment_id">{{ bed.姓名 }}</span><span v-else>{{ bed.status === '可用' ? '空床' : bed.status }}</span></button></div><div v-if="selectedBed && selectedBed.room.id === room.id && selectedAssignment" class="room-bed-toolbar"><div class="room-bed-selection"><span class="selection-label">已选择</span><strong>{{ selectedAssignment.姓名 }}</strong><span>{{ roomLabel(room) }} · {{ selectedBed.bed.bed_no }}号床</span></div><div class="room-bed-actions"><button class="btn btn-sm btn-outline" @click="openMove(selectedAssignment)">调宿</button><button class="btn btn-sm btn-danger" @click="checkout(selectedAssignment)">退宿</button></div></div></article></div>

    <div v-if="moving" class="modal-overlay show" @click.self="moving = null"><div class="modal"><div class="modal-kicker">调宿</div><h3>{{ moving.姓名 }} · {{ moving.room_no }}-{{ moving.bed_no }}号床</h3><div class="form-grid"><label>目标床位<select v-model="moveForm.bed_id" class="form-select"><option value="">选择空床位</option><option v-for="bed in availableBeds" :key="bed.id" :value="bed.id">{{ bed.room_label }}</option></select></label><label>入住日期<input v-model="moveForm.move_in_at" class="form-input" type="date"></label><label class="form-grid-wide">调宿原因<textarea v-model="moveForm.reason" class="form-textarea" rows="2" placeholder="如：同楼调整、班级变动"></textarea></label></div><div class="modal-actions"><button class="btn btn-outline" @click="moving = null"><X :size="14" /> 取消</button><button class="btn btn-primary" @click="move"><Check :size="14" /> 保存调宿</button></div></div></div>

    <div v-if="leaderRoom" class="modal-overlay show" @click.self="leaderRoom = null"><div class="modal"><div class="modal-kicker">寝室长</div><h3>{{ roomLabel(leaderRoom) }}</h3><label>指定入住学生<select v-model="leaderStudent" class="form-select"><option value="">暂不指定</option><option v-for="bed in leaderRoom.beds.filter(item => item.assignment_id)" :key="bed.student_id" :value="bed.student_id">{{ bed.姓名 }} · {{ bed.学号 }}</option></select></label><div class="modal-actions"><button class="btn btn-outline" @click="leaderRoom = null"><X :size="14" /> 取消</button><button class="btn btn-primary" @click="saveLeader"><Check :size="14" /> 保存</button></div></div></div>

    <div v-if="checking" class="modal-overlay show" @click.self="checking = false"><div class="modal modal-wide"><div class="modal-kicker">查寝记录</div><h3>发起查寝</h3><div class="form-grid"><label>日期<input v-model="inspectionForm.inspection_date" class="form-input" type="date"></label><label>时间<input v-model="inspectionForm.inspection_time" class="form-input" type="time"></label><label>查寝人<input v-model="inspectionForm.inspector" class="form-input" placeholder="如：班主任"></label><label class="form-grid-wide">整体备注<textarea v-model="inspectionForm.note" class="form-textarea" rows="2" placeholder="可选"></textarea></label></div><div class="inspection-record-editor"><div v-for="item in assignments" :key="item.student_id" class="inspection-record-row"><span><strong>{{ item.姓名 }}</strong><small>{{ item.room_no }}-{{ item.bed_no }}号床 · {{ item.学号 }}</small></span><select v-model="inspectionRecord(item.student_id).status" class="form-select"><option>在寝</option><option>未归</option><option>晚归</option><option>请假</option></select><input v-model="inspectionRecord(item.student_id).note" class="form-input" placeholder="备注"></div></div><div class="modal-actions"><button class="btn btn-outline" @click="checking = false"><X :size="14" /> 取消</button><button class="btn btn-primary" @click="saveInspection"><Check :size="14" /> 保存查寝</button></div></div></div>

    <div v-if="inspectionDetail" class="modal-overlay show" @click.self="inspectionDetail = null"><div class="modal modal-wide"><div class="modal-kicker">查寝详情</div><h3>{{ inspectionDetail.inspection_date }} {{ inspectionDetail.inspection_time }}</h3><p class="inspection-detail-meta">{{ inspectionDetail.inspector || '未填写查寝人' }} · {{ inspectionDetail.note || '无整体备注' }}</p><div class="inspection-detail-list"><div v-for="record in inspectionDetail.records" :key="record.id" class="inspection-record-row"><span><strong>{{ record.姓名 }}</strong><small>{{ record.room_no }}-{{ record.bed_no }}号床 · {{ record.学号 }}</small></span><span class="status-pill" :class="`status-${record.status}`">{{ record.status }}</span><span class="inspection-record-note">{{ record.note || '' }}</span></div></div><div class="modal-actions"><button class="btn btn-primary" @click="inspectionDetail = null">关闭</button></div></div></div>
  </div>
</template>

<style scoped>
.dorm-stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-bottom:14px; }
.dorm-stats .overview-card { min-height:86px; padding:15px 18px; display:grid; gap:6px; }
.dorm-stats span,.dorm-room-head span { color:var(--text-secondary); font-size:12px; }
.dorm-stats strong { font-size:24px; line-height:1; }
.dorm-form-card { margin-bottom:14px; }
.inspection-card { margin-bottom:14px; }
.inspection-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.inspection-summary, .empty-inline, .inspection-detail-meta { color:var(--text-secondary); font-size:12px; }
.inspection-history { display:grid; gap:6px; margin-top:12px; }
.inspection-history-item { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; border:1px solid var(--border); border-radius:9px; background:var(--bg); color:var(--text); text-align:left; cursor:pointer; }
.inspection-history-item:hover { border-color:var(--primary); background:var(--primary-bg); }
.inspection-history-item span:first-child { display:grid; gap:3px; }
.inspection-history-item small { color:var(--text-secondary); }
.inspection-counts { display:flex; flex-wrap:wrap; gap:7px; justify-content:flex-end; }
.inspection-counts em { color:var(--text-secondary); font-size:11px; font-style:normal; }
.dorm-assign-form { display:grid; grid-template-columns:1fr 1fr 170px auto; gap:8px; }
.dorm-room-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:12px; }
.dorm-room-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:14px; }
.dorm-room-head h3 { margin:0 0 4px; font-size:16px; }
.room-head-actions { display:flex; gap:6px; }
.room-leader { display:flex; align-items:center; gap:4px; margin-top:6px; color:var(--primary); font-size:12px; }
.bed-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(100px,1fr)); gap:8px; }
.bed-cell { min-height:86px; width:100%; padding:10px; display:flex; flex-direction:column; gap:4px; border:1px solid var(--border); border-radius:10px; background:var(--bg); color:var(--text); font:inherit; font-size:12px; text-align:left; appearance:none; }
.bed-cell.occupied { border-color:rgba(91,106,191,.35); background:var(--primary-bg); }
.bed-cell.occupied { cursor:pointer; }
.bed-cell.occupied:hover, .bed-cell.selected { border-color:var(--primary); }
.bed-cell.selected { box-shadow:0 0 0 3px var(--primary-bg); }
.bed-cell:focus-visible { outline:3px solid var(--primary); outline-offset:2px; }
.bed-cell.unavailable { opacity:.6; }
.bed-cell span { color:var(--text-secondary); }
.room-bed-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:10px; padding:10px 12px; border:1px solid rgba(91,106,191,.2); border-radius:10px; background:var(--primary-bg); }
.room-bed-selection { display:flex; align-items:baseline; flex-wrap:wrap; gap:4px 9px; min-width:0; }
.room-bed-selection span { color:var(--text-secondary); font-size:12px; }
.room-bed-selection .selection-label { color:var(--primary); font-size:11px; font-weight:600; }
.room-bed-selection strong { font-size:13px; }
.room-bed-actions { display:flex; flex-shrink:0; gap:7px; }
.danger-link { color:var(--danger); }
.modal-wide { width:min(760px, calc(100vw - 30px)); }
.inspection-record-editor, .inspection-detail-list { max-height:420px; overflow:auto; margin-top:14px; border-top:1px solid var(--border); }
.inspection-record-row { display:grid; grid-template-columns:minmax(150px, 1fr) 110px minmax(120px, 1fr); gap:8px; align-items:center; padding:8px 0; border-bottom:1px solid var(--border); }
.inspection-record-row > span:first-child { display:grid; gap:2px; }
.inspection-record-row small { color:var(--text-secondary); font-size:11px; }
.inspection-record-note { color:var(--text-secondary); font-size:12px; }
.status-pill { justify-self:start; padding:4px 8px; border-radius:999px; font-size:11px; background:var(--primary-bg); color:var(--primary); }
.status-未归 { background:#fff1f0; color:#c53b32; }
.status-晚归 { background:#fff7e6; color:#ad6800; }
.status-请假 { background:#f5f5f5; color:var(--text-secondary); }
@media (max-width:900px) { .dorm-stats { grid-template-columns:1fr 1fr; } }
@media (max-width:720px) { .dorm-stats .overview-card:last-child { grid-column:1 / -1; } .dorm-assign-form { grid-template-columns:1fr; } .inspection-head, .inspection-history-item { align-items:flex-start; flex-direction:column; } .inspection-counts { justify-content:flex-start; } .room-head-actions { flex-direction:column; } .room-bed-toolbar { align-items:flex-start; flex-direction:column; } .inspection-record-row { grid-template-columns:1fr; gap:5px; } }
</style>
