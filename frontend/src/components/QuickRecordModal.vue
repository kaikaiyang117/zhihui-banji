<script setup>
import { reactive, ref, onMounted } from 'vue'
import { get, post } from '../api'

const props = defineProps({
  mode: { type: String, default: 'event' },
  studentId: { type: [Number, String], default: null }
})
const emit = defineEmits(['success', 'close'])

const students = ref([])
const submitting = ref(false)
const errorMsg = ref('')

function nowInput() {
  const d = new Date()
  const pad = v => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const form = reactive({
  student_id: props.studentId || '',
  occurred_at: nowInput(),
  event_type: '日常表现',
  description: '',
  handling: '',
  parent_contacted: false,
  needs_followup: false,
  followup_due: '',
  title: '',
  due_at: '',
  priority: '普通',
  notes: '',
  communicated_at: nowInput(),
  method: '电话',
  reason: '',
  summary: '',
  feedback: '',
  agreement: '',
  followup_at: '',
  topic: '',
  evidence: '',
  action_plan: '',
  next_review_at: ''
})

const titles = { event: '快速记录事件', task: '新建待办', comm: '记录家校沟通', focus: '添加关注事项' }

onMounted(async () => {
  try {
    const data = await get('/api/students')
    students.value = data.students || []
  } catch (e) {
    errorMsg.value = e.message
  }
})

async function submit() {
  errorMsg.value = ''
  if (!form.student_id && props.mode !== 'task') {
    errorMsg.value = '请选择学生'
    return
  }
  submitting.value = true
  try {
    let url = '/api/events'
    let body = { ...form, student_id: form.student_id ? Number(form.student_id) : null }
    if (props.mode === 'task') {
      url = '/api/tasks'
      body = { title: form.title, student_id: body.student_id, due_at: form.due_at,
        priority: form.priority, notes: form.notes }
    } else if (props.mode === 'comm') {
      url = '/api/communications'
      body = { student_id: body.student_id, communicated_at: form.communicated_at, method: form.method,
        reason: form.reason, summary: form.summary, feedback: form.feedback,
        agreement: form.agreement, followup_at: form.followup_at }
    } else if (props.mode === 'focus') {
      url = '/api/focus'
      body = { student_id: body.student_id, topic: form.topic, reason: form.reason,
        evidence: form.evidence, action_plan: form.action_plan, next_review_at: form.next_review_at }
    } else {
      body.occurred_at = form.occurred_at.replace('T', ' ')
    }
    await post(url, body)
    emit('success')
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="modal-overlay show" @click.self="$emit('close')">
    <div class="modal quick-record-modal">
      <div class="modal-kicker">{{ mode === 'event' ? '学生成长记录' : mode === 'task' ? '工作闭环' : mode === 'comm' ? '家校联系' : '持续关注' }}</div>
      <h3>{{ titles[mode] }}</h3>
      <form @submit.prevent="submit">
        <div class="form-group">
          <label>关联学生</label>
          <select class="form-select" v-model="form.student_id" :disabled="!!props.studentId">
            <option value="">请选择学生</option>
            <option v-for="student in students" :key="student.id" :value="student.id">
              {{ student.姓名 }}{{ student.学号 ? ` · ${student.学号}` : '' }}
            </option>
          </select>
        </div>

        <template v-if="mode === 'event'">
          <div class="form-row">
            <div class="form-group"><label>发生时间</label><input class="form-input" type="datetime-local" v-model="form.occurred_at"></div>
            <div class="form-group"><label>事件类型</label><select class="form-select" v-model="form.event_type">
              <option>日常表现</option><option>表扬</option><option>纪律问题</option><option>作业异常</option>
              <option>同伴关系</option><option>情绪状态</option><option>身体情况</option><option>活动表现</option><option>其他</option>
            </select></div>
          </div>
          <div class="form-group"><label>发生了什么</label><textarea class="form-textarea" v-model="form.description" placeholder="记录事实、场景和学生反馈"></textarea></div>
          <div class="form-group"><label>现场处理</label><textarea class="form-textarea" v-model="form.handling" placeholder="已经采取的处理方式（可选）"></textarea></div>
          <div class="check-row"><label><input type="checkbox" v-model="form.parent_contacted"> 已联系家长</label><label><input type="checkbox" v-model="form.needs_followup"> 需要后续跟进</label></div>
          <div v-if="form.needs_followup" class="form-group"><label>跟进日期</label><input class="form-input" type="date" v-model="form.followup_due"></div>
        </template>

        <template v-else-if="mode === 'task'">
          <div class="form-group"><label>事项</label><input class="form-input" v-model="form.title" placeholder="例如：周五复查近期迟到情况"></div>
          <div class="form-row">
            <div class="form-group"><label>截止日期</label><input class="form-input" type="date" v-model="form.due_at"></div>
            <div class="form-group"><label>优先级</label><select class="form-select" v-model="form.priority"><option>普通</option><option>重要</option><option>紧急</option></select></div>
          </div>
          <div class="form-group"><label>备注</label><textarea class="form-textarea" v-model="form.notes"></textarea></div>
        </template>

        <template v-else-if="mode === 'comm'">
          <div class="form-row">
            <div class="form-group"><label>沟通时间</label><input class="form-input" type="datetime-local" v-model="form.communicated_at"></div>
            <div class="form-group"><label>沟通方式</label><select class="form-select" v-model="form.method"><option>电话</option><option>微信</option><option>面谈</option><option>家访</option><option>短信</option></select></div>
          </div>
          <div class="form-group"><label>沟通原因</label><input class="form-input" v-model="form.reason"></div>
          <div class="form-group"><label>沟通内容</label><textarea class="form-textarea" v-model="form.summary"></textarea></div>
          <div class="form-group"><label>家长反馈</label><textarea class="form-textarea" v-model="form.feedback"></textarea></div>
          <div class="form-group"><label>双方约定</label><textarea class="form-textarea" v-model="form.agreement"></textarea></div>
          <div class="form-group"><label>回访日期（可选）</label><input class="form-input" type="date" v-model="form.followup_at"></div>
        </template>

        <template v-else>
          <div class="form-group"><label>关注主题</label><input class="form-input" v-model="form.topic" placeholder="例如：近期学习状态变化"></div>
          <div class="form-group"><label>关注原因</label><textarea class="form-textarea" v-model="form.reason"></textarea></div>
          <div class="form-group"><label>发现依据</label><textarea class="form-textarea" v-model="form.evidence"></textarea></div>
          <div class="form-group"><label>处理计划</label><textarea class="form-textarea" v-model="form.action_plan"></textarea></div>
          <div class="form-group"><label>下次检查日期</label><input class="form-input" type="date" v-model="form.next_review_at"></div>
        </template>

        <div v-if="errorMsg" class="error-text">{{ errorMsg }}</div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" @click="$emit('close')">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="submitting">{{ submitting ? '保存中…' : '保存记录' }}</button>
        </div>
      </form>
    </div>
  </div>
</template>
