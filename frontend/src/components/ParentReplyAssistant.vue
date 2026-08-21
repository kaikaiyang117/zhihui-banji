<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import {
  AlertTriangle, ArrowLeft, CheckCircle2, Clock3, Copy, FileImage,
  HelpCircle, Paperclip, RotateCcw, Save, ShieldCheck, Sparkles, UserRound,
} from 'lucide-vue-next'
import { generateParentReply, get, post, uploadEvidence } from '../api'
import { useConfirmDialog } from '../composables/confirmDialog'

const props = defineProps({
  initialStudentId: { type: Number, default: 0 },
})
const emit = defineEmits(['back', 'saved'])
const { confirm: confirmDialog } = useConfirmDialog()

const students = ref([])
const businessDate = ref(new Date().toISOString().slice(0, 10))
const loading = ref(true)
const generating = ref(false)
const saving = ref(false)
const message = ref('')
const result = ref(null)
const draft = ref('')
const screenshotFile = ref(null)
const savedCommunicationId = ref(0)

const form = ref({
  studentId: props.initialStudentId || '',
  teacherRole: '班主任',
  channel: '微信',
  parentMessage: '',
  teacherContext: '',
  replyGoal: '回应关切并明确下一步',
  feedbackDeadline: '',
  owner: '班主任',
  tone: '自然',
})

const tones = ['自然', '简洁', '更有同理心', '边界更清晰']
const selectedStudent = computed(() => students.value.find(item => Number(item.id) === Number(form.value.studentId)))
const responseClass = computed(() => `is-${result.value?.response_level || 'verify'}`)
const complianceClass = computed(() => `is-${result.value?.compliance_assessment?.state || 'no_signal'}`)
const complaintClass = computed(() => `is-${result.value?.compliance_assessment?.complaint_signal?.level || 'none'}`)
const canGenerate = computed(() => Boolean(form.value.studentId && form.value.parentMessage.trim().length >= 4))

watch(() => form.value.teacherRole, (role, previous) => {
  if (!form.value.owner || form.value.owner === previous) form.value.owner = role
})

onMounted(async () => {
  loading.value = true
  try {
    const [studentData, runtime] = await Promise.all([
      get('/api/students'),
      get('/api/system/runtime'),
    ])
    students.value = studentData.students || []
    businessDate.value = runtime.business_date || businessDate.value
  } catch (error) {
    message.value = `回复助手加载失败：${error.message}`
  } finally {
    loading.value = false
  }
})

function requestPayload() {
  return {
    student_id: Number(form.value.studentId),
    parent_message: form.value.parentMessage.trim(),
    teacher_context: form.value.teacherContext.trim(),
    reply_goal: form.value.replyGoal.trim(),
    teacher_role: form.value.teacherRole,
    feedback_deadline: form.value.feedbackDeadline,
    owner: form.value.owner.trim(),
    tone: form.value.tone,
  }
}

async function generateReply() {
  if (!canGenerate.value) return
  generating.value = true
  message.value = ''
  savedCommunicationId.value = 0
  try {
    const data = await generateParentReply(requestPayload())
    result.value = data
    draft.value = data.draft || ''
  } catch (error) {
    message.value = `生成失败：${error.message}`
  } finally {
    generating.value = false
  }
}

async function selectTone(tone) {
  form.value.tone = tone
  if (result.value) await generateReply()
}

async function copyDraft() {
  if (!draft.value) return
  try {
    await navigator.clipboard.writeText(draft.value)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = draft.value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
  message.value = '已复制草稿；请在原沟通渠道中确认并发送。'
}

function onScreenshotChange(event) {
  screenshotFile.value = event.target.files?.[0] || null
}

function clipped(value, limit) {
  const text = String(value || '').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

async function saveCommunication() {
  if (!result.value || !draft.value.trim() || !selectedStudent.value || savedCommunicationId.value) return
  const confirmed = await confirmDialog({
    title: '确认已经发送？',
    message: '只有在你已通过微信、电话或其他原渠道完成沟通后，才保存为正式沟通记录。系统不会替你发送消息。',
    confirmText: '已发送，保存记录',
  })
  if (!confirmed) return
  saving.value = true
  message.value = ''
  try {
    const saved = await post('/api/communications', {
      student_id: Number(form.value.studentId),
      communicated_at: businessDate.value,
      method: form.value.channel,
      reason: '家长消息回复',
      summary: `家长反映：${clipped(form.value.parentMessage, 400)}\n教师回复：${clipped(draft.value, 1200)}`,
      feedback: form.value.parentMessage.trim(),
      agreement: result.value.follow_up || '',
      followup_at: form.value.feedbackDeadline,
      status: form.value.feedbackDeadline ? '待回访' : '已完成',
    })
    savedCommunicationId.value = Number(saved.communication_id || 0)
    if (screenshotFile.value && savedCommunicationId.value) {
      const body = new FormData()
      body.append('file', screenshotFile.value)
      body.append('owner_type', 'communication')
      body.append('owner_id', String(savedCommunicationId.value))
      body.append('student_id', String(form.value.studentId))
      body.append('evidence_kind', '沟通截图')
      body.append('note', '家长消息原始截图')
      try {
        await uploadEvidence(body)
      } catch (error) {
        message.value = `沟通记录已保存，但截图上传失败：${error.message}。可以稍后在沟通台账中补充。`
        return
      }
    }
    emit('saved')
  } catch (error) {
    message.value = `保存失败：${error.message}`
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="parent-reply-assistant">
    <div class="pr-toolbar">
      <button class="btn btn-outline btn-sm" @click="emit('back')"><ArrowLeft :size="15" /> 返回沟通记录</button>
      <div class="pr-toolbar-note"><ShieldCheck :size="16" /> 生成不会自动发送，也不会自动写入学生档案</div>
    </div>

    <div v-if="message" class="inline-message pr-message">{{ message }}</div>

    <div class="pr-layout">
      <div class="card pr-input-card">
        <div class="pr-card-heading">
          <div><span class="pr-kicker">回复前准备</span><h2>家长消息与已知情况</h2></div>
          <UserRound :size="20" aria-hidden="true" />
        </div>

        <div v-if="loading" class="loading">正在加载班级学生…</div>
        <template v-else>
          <label class="pr-field">
            <span>对应学生 <b>*</b></span>
            <select v-model="form.studentId" class="form-input" :disabled="generating">
              <option value="">请选择学生</option>
              <option v-for="student in students" :key="student.id" :value="student.id">{{ student['姓名'] }} · {{ student['学号'] }}</option>
            </select>
          </label>

          <fieldset class="pr-role-field">
            <legend>当前教师角色</legend>
            <div class="pr-choice-row">
              <button type="button" :class="{ active: form.teacherRole === '班主任' }" :disabled="generating" @click="form.teacherRole = '班主任'">班主任</button>
              <button type="button" :class="{ active: form.teacherRole === '任课教师' }" :disabled="generating" @click="form.teacherRole = '任课教师'">任课教师</button>
            </div>
          </fieldset>

          <label class="pr-field">
            <span>家长原话 <b>*</b></span>
            <textarea v-model="form.parentMessage" class="form-textarea" rows="7" maxlength="3000" :disabled="generating" placeholder="粘贴家长发送的原话。不要在这里改写或概括。"></textarea>
            <small>{{ form.parentMessage.length }}/3000</small>
          </label>

          <label class="pr-file-field">
            <Paperclip :size="16" />
            <span>{{ screenshotFile ? screenshotFile.name : '附上原始聊天截图（可选）' }}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" :disabled="generating" @change="onScreenshotChange" />
          </label>
          <div class="pr-file-help"><FileImage :size="14" /> 截图只在你确认保存沟通记录后作为证据上传；当前不会自动识别图片文字。</div>

          <label class="pr-field">
            <span>教师已知情况</span>
            <textarea v-model="form.teacherContext" class="form-textarea" rows="4" maxlength="1200" :disabled="generating" placeholder="填写已经确认的校内情况；不确定的内容不要写成事实。"></textarea>
          </label>

          <details class="pr-advanced">
            <summary>回复目标与后续安排</summary>
            <div class="pr-advanced-grid">
              <label class="pr-field">
                <span>沟通渠道</span>
                <select v-model="form.channel" class="form-input" :disabled="generating">
                  <option>微信</option>
                  <option>电话</option>
                  <option>面谈</option>
                  <option>短信</option>
                  <option>其他</option>
                </select>
              </label>
              <label class="pr-field"><span>回复目标</span><input v-model="form.replyGoal" class="form-input" maxlength="120" :disabled="generating" /></label>
              <label class="pr-field"><span>负责人</span><input v-model="form.owner" class="form-input" maxlength="40" :disabled="generating" /></label>
              <label class="pr-field"><span>预计反馈日期</span><input v-model="form.feedbackDeadline" class="form-input" type="date" :disabled="generating" /></label>
            </div>
          </details>

          <button class="btn btn-primary pr-generate" :disabled="generating || !canGenerate" @click="generateReply">
            <Sparkles :size="16" :class="{ 'pr-icon-pulse': generating }" /> {{ generating ? '正在整理回复…' : '检查并生成回复' }}
          </button>
          <div v-if="!canGenerate" class="pr-required-help">请选择学生，并粘贴完整的家长消息。</div>
        </template>
      </div>

      <div class="pr-result-column" :aria-busy="generating">
        <div v-if="generating && !result" class="card pr-generation-status" role="status" aria-live="polite">
          <span class="pr-generation-orbit" aria-hidden="true"><Sparkles :size="24" /></span>
          <div>
            <h2>正在整理回复</h2>
            <p>正在核对事实边界、标记待核实信息，并组织一份可编辑的回复。</p>
          </div>
          <div class="pr-generation-steps" aria-hidden="true">
            <span>核对已知事实</span>
            <span>匹配制度边界</span>
            <span>组织回复内容</span>
          </div>
          <small>你可以留在当前页面，完成后会自动显示结果。</small>
        </div>

        <div v-else-if="!result" class="card pr-empty-result">
          <ShieldCheck :size="32" />
          <h2>先看事实，再组织回复</h2>
          <p>系统会区分已确认事实和待核实信息，并给出“可直接回复、核实后回复、建议升级处理”三种处置建议。</p>
        </div>

        <template v-else>
          <div class="card pr-assessment-card" :class="responseClass">
            <div class="pr-assessment-heading">
              <div>
                <span class="pr-kicker">回复前检查</span>
                <h2>{{ result.response_label }}</h2>
              </div>
              <span class="pr-mode">{{ result.generation_mode === 'ai' ? 'AI 草稿' : '规则草稿' }}</span>
            </div>
            <p v-for="reason in result.risk_reasons" :key="reason" class="pr-risk-reason"><AlertTriangle :size="15" /> {{ reason }}</p>
            <p v-if="result.generation_warning" class="pr-generation-warning">{{ result.generation_warning }}</p>
          </div>

          <div v-if="result.compliance_assessment" class="card pr-compliance-card" :class="complianceClass">
            <div class="pr-compliance-heading">
              <div>
                <span class="pr-kicker">教师内部参考</span>
                <h2>制度边界辅助判断</h2>
              </div>
              <span class="pr-compliance-label">{{ result.compliance_assessment.label }}</span>
            </div>
            <p class="pr-compliance-summary">{{ result.compliance_assessment.summary }}</p>

            <div class="pr-compliance-grid">
              <section class="pr-policy-section">
                <h3>可能涉及的制度边界</h3>
                <div v-if="result.compliance_assessment.policy_findings.length" class="pr-policy-list">
                  <article v-for="finding in result.compliance_assessment.policy_findings" :key="finding.id" class="pr-policy-item">
                    <div class="pr-policy-title">
                      <strong>{{ finding.title }}</strong>
                      <span>{{ finding.category }}</span>
                      <span :class="finding.evidence_status === '已确认' ? 'is-confirmed' : 'is-reported'">{{ finding.evidence_status }}</span>
                    </div>
                    <blockquote>“{{ finding.evidence }}”</blockquote>
                    <p>{{ finding.requirement }}</p>
                    <small>依据：{{ finding.basis }}</small>
                    <details v-if="finding.missing_facts?.length" class="pr-policy-missing">
                      <summary>查看仍需核实的条件</summary>
                      <ul><li v-for="item in finding.missing_facts" :key="item">{{ item }}</li></ul>
                    </details>
                  </article>
                </div>
                <div v-else class="pr-no-policy">当前文字没有匹配到明确制度边界，但仍需以完整事实和学校制度为准。</div>
              </section>

              <div class="pr-compliance-side">
                <section class="pr-complaint-box" :class="complaintClass">
                  <h3>投诉升级信号</h3>
                  <strong>{{ result.compliance_assessment.complaint_signal.label }}</strong>
                  <p>{{ result.compliance_assessment.complaint_signal.summary }}</p>
                  <blockquote v-for="item in result.compliance_assessment.complaint_signal.evidence" :key="item">“{{ item }}”</blockquote>
                </section>
                <section class="pr-actions-box">
                  <h3>建议处置</h3>
                  <ol><li v-for="item in result.compliance_assessment.recommended_actions" :key="item">{{ item }}</li></ol>
                </section>
              </div>
            </div>
            <p class="pr-compliance-disclaimer"><ShieldCheck :size="14" />{{ result.compliance_assessment.disclaimer }}</p>
          </div>

          <div class="pr-fact-grid">
            <div class="card pr-info-card">
              <div class="pr-info-title"><CheckCircle2 :size="17" /> 已确认输入</div>
              <div v-for="fact in result.known_facts" :key="fact.id" class="pr-fact-row">
                <span>{{ fact.id }}</span><p><b>{{ fact.source }}</b>{{ fact.text }}</p>
              </div>
            </div>
            <div class="card pr-info-card">
              <div class="pr-info-title"><HelpCircle :size="17" /> 待核实</div>
              <ul><li v-for="item in result.unknowns" :key="item">{{ item }}</li></ul>
              <div v-if="!result.unknowns.length" class="hint">当前没有额外的待核实项。</div>
            </div>
          </div>

          <div class="card pr-needs-card">
            <div class="pr-info-title">家长可能在确认什么</div>
            <div class="pr-need-list"><span v-for="item in result.possible_parent_needs" :key="item">{{ item }}</span></div>
            <p>这里只表达可能性，不会作为家长画像或学生事实保存。</p>
          </div>

          <div class="card pr-draft-card" :class="{ 'is-generating': generating }">
            <div v-if="generating" class="pr-draft-loading" role="status" aria-live="polite">
              <span class="pr-generation-orbit" aria-hidden="true"><Sparkles :size="22" /></span>
              <div><strong>正在重新整理回复</strong><span>保留当前草稿，完成后自动替换。</span></div>
            </div>
            <div class="pr-draft-heading">
              <div><span class="pr-kicker">教师确认区</span><h2>可编辑回复</h2></div>
              <div class="pr-tone-row" aria-label="回复语气">
                <button v-for="tone in tones" :key="tone" :class="{ active: form.tone === tone }" :disabled="generating" @click="selectTone(tone)">{{ tone }}</button>
              </div>
            </div>
            <textarea v-model="draft" class="form-textarea pr-draft-textarea" rows="10" :disabled="generating"></textarea>
            <div class="pr-follow-up"><Clock3 :size="16" /><span>{{ result.follow_up }}</span></div>
            <div class="pr-draft-actions">
              <button class="btn btn-outline" :disabled="generating" @click="copyDraft"><Copy :size="15" /> 复制回复</button>
              <button class="btn btn-outline" :disabled="generating" @click="generateReply"><RotateCcw :size="15" :class="{ 'pr-icon-spin': generating }" /> {{ generating ? '正在重新生成…' : '重新生成' }}</button>
              <button class="btn btn-primary" :disabled="generating || saving || savedCommunicationId || !draft.trim()" @click="saveCommunication"><Save :size="15" /> {{ saving ? '保存中…' : savedCommunicationId ? '记录已保存' : '已发送，保存记录' }}</button>
            </div>
          </div>

          <details class="card pr-boundary-card">
            <summary>核实问题、系统事实与权限边界</summary>
            <div class="pr-boundary-grid">
              <section><h3>建议核实</h3><ol><li v-for="item in result.questions_to_verify" :key="item">{{ item }}</li></ol></section>
              <section><h3>不能作出的承诺</h3><ul><li v-for="item in result.prohibited_commitments" :key="item">{{ item }}</li></ul></section>
            </div>
            <section v-if="result.system_facts?.length" class="pr-system-facts">
              <h3>系统中可核对的事实</h3>
              <div v-for="fact in result.system_facts" :key="fact.id" class="pr-system-fact"><span>{{ fact.id }}</span><p>{{ fact.date ? `${fact.date} · ` : '' }}{{ fact.text }}</p></div>
            </section>
          </details>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.parent-reply-assistant { display: grid; gap: 16px; }
.pr-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.pr-toolbar-note { display: inline-flex; align-items: center; gap: 7px; color: var(--ink-secondary, #5f6673); font-size: 13px; }
.pr-message { margin: 0; }
.pr-layout { display: grid; grid-template-columns: minmax(320px, 0.78fr) minmax(0, 1.42fr); gap: 18px; align-items: start; }
.pr-input-card { position: sticky; top: 16px; display: grid; gap: 16px; }
.pr-card-heading, .pr-assessment-heading, .pr-draft-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.pr-card-heading h2, .pr-assessment-heading h2, .pr-draft-heading h2, .pr-empty-result h2 { margin: 4px 0 0; font-size: 20px; }
.pr-kicker { color: #5663b6; font-size: 12px; font-weight: 700; letter-spacing: .04em; }
.pr-field { display: grid; gap: 7px; color: #4e5562; font-size: 13px; font-weight: 600; }
.pr-field > span { display: inline-flex; align-items: center; gap: 4px; }
.pr-field b { color: #b42318; }
.pr-field small { justify-self: end; color: #858b96; font-weight: 400; }
.pr-role-field { margin: 0; padding: 0; border: 0; }
.pr-role-field legend { margin-bottom: 7px; color: #4e5562; font-size: 13px; font-weight: 600; }
.pr-choice-row, .pr-tone-row { display: flex; gap: 6px; flex-wrap: wrap; }
.pr-choice-row button, .pr-tone-row button { border: 1px solid #dfe1e5; border-radius: 999px; background: #fff; color: #5f6673; padding: 7px 12px; cursor: pointer; }
.pr-choice-row button.active, .pr-tone-row button.active { border-color: #5663b6; background: #eef0fb; color: #404b9a; }
.pr-file-field { position: relative; display: flex; align-items: center; gap: 8px; min-height: 42px; border: 1px dashed #c9cdd5; border-radius: 10px; padding: 9px 12px; color: #5663b6; cursor: pointer; }
.pr-file-field input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.pr-file-help { display: flex; align-items: flex-start; gap: 6px; margin-top: -10px; color: #767d89; font-size: 12px; line-height: 1.55; }
.pr-advanced { border-top: 1px solid #ebecef; padding-top: 12px; }
.pr-advanced summary, .pr-boundary-card summary { color: #4d5665; font-weight: 650; cursor: pointer; }
.pr-advanced-grid { display: grid; gap: 12px; margin-top: 14px; }
.pr-generate { width: 100%; justify-content: center; min-height: 44px; }
.pr-required-help { margin-top: -9px; color: #858b96; font-size: 12px; text-align: center; }
.pr-result-column { display: grid; gap: 14px; min-width: 0; }
.pr-empty-result { min-height: 360px; display: grid; place-items: center; align-content: center; gap: 8px; text-align: center; color: #6c7380; }
.pr-empty-result p { max-width: 520px; margin: 0; line-height: 1.7; }
.pr-generation-status { min-height: 360px; display: grid; place-items: center; align-content: center; gap: 18px; text-align: center; }
.pr-generation-status h2 { margin: 0; font-size: 20px; }
.pr-generation-status p { max-width: 520px; margin: 6px 0 0; color: #5f6673; line-height: 1.7; }
.pr-generation-status small { color: #767d89; font-size: 12px; }
.pr-generation-orbit { position: relative; display: grid; place-items: center; width: 58px; height: 58px; border-radius: 50%; background: #eef0fb; color: #5663b6; }
.pr-generation-orbit::after { content: ''; position: absolute; inset: -4px; border: 2px solid rgba(86, 99, 182, .16); border-top-color: #5663b6; border-radius: inherit; animation: pr-spin .9s linear infinite; }
.pr-generation-steps { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; }
.pr-generation-steps span { position: relative; border-radius: 999px; background: #f8f7f3; padding: 7px 11px 7px 24px; color: #4e5562; font-size: 12px; font-weight: 600; }
.pr-generation-steps span::before { content: ''; position: absolute; left: 10px; top: 50%; width: 6px; height: 6px; border-radius: 50%; background: #5663b6; transform: translateY(-50%); animation: pr-step-pulse 1.2s ease-in-out infinite; }
.pr-generation-steps span:nth-child(2)::before { animation-delay: .2s; }
.pr-generation-steps span:nth-child(3)::before { animation-delay: .4s; }
.pr-icon-pulse { animation: pr-icon-pulse 1.1s ease-in-out infinite; }
.pr-icon-spin { animation: pr-spin .9s linear infinite; }
.pr-assessment-card { border-left: 4px solid #c98912; }
.pr-assessment-card.is-direct { border-left-color: #237a4b; background: #f7fcf9; }
.pr-assessment-card.is-verify { border-left-color: #c98912; background: #fffaf0; }
.pr-assessment-card.is-escalate { border-left-color: #b42318; background: #fff7f6; }
.pr-mode { border-radius: 999px; padding: 5px 9px; background: rgba(255,255,255,.75); color: #5f6673; font-size: 12px; font-weight: 650; }
.pr-risk-reason { display: flex; align-items: flex-start; gap: 7px; margin: 12px 0 0; color: #5d4930; line-height: 1.55; }
.pr-generation-warning { margin: 10px 0 0; color: #8a5a00; font-size: 12px; }
.pr-compliance-card { border-top: 3px solid #9aa1ad; }
.pr-compliance-card.is-possible_conflict { border-top-color: #c98912; }
.pr-compliance-card.is-escalate { border-top-color: #b42318; }
.pr-compliance-card.is-no_signal { border-top-color: #237a4b; }
.pr-compliance-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.pr-compliance-heading h2 { margin: 4px 0 0; font-size: 18px; }
.pr-compliance-label { flex: 0 0 auto; max-width: 260px; border-radius: 999px; background: #f4f4f5; padding: 6px 10px; color: #505764; font-size: 12px; font-weight: 700; text-align: center; }
.pr-compliance-card.is-possible_conflict .pr-compliance-label { background: #fff4d6; color: #8a5a00; }
.pr-compliance-card.is-escalate .pr-compliance-label { background: #feecea; color: #9f2018; }
.pr-compliance-card.is-no_signal .pr-compliance-label { background: #eaf7ef; color: #237a4b; }
.pr-compliance-summary { margin: 12px 0 0; color: #5f6673; font-size: 13px; line-height: 1.65; }
.pr-compliance-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 16px; }
.pr-policy-section > h3, .pr-complaint-box h3, .pr-actions-box h3 { margin: 0 0 10px; color: #20242f; font-size: 14px; }
.pr-policy-list, .pr-compliance-side { display: grid; gap: 10px; }
.pr-compliance-side { align-content: start; }
.pr-policy-item, .pr-complaint-box, .pr-actions-box { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 14px; background: #fbfbfc; }
.pr-policy-title { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.pr-policy-title strong { margin-right: auto; font-size: 13px; }
.pr-policy-title span { border-radius: 999px; background: #eef0fb; padding: 3px 7px; color: #5663b6; font-size: 10px; font-weight: 700; }
.pr-policy-title span.is-confirmed { background: #eaf7ef; color: #237a4b; }
.pr-policy-title span.is-reported { background: #fff4d6; color: #8a5a00; }
.pr-policy-item blockquote, .pr-complaint-box blockquote { margin: 10px 0 0; border-left: 3px solid #cfd4df; padding-left: 9px; color: #4e5562; font-size: 12px; line-height: 1.6; }
.pr-policy-item > p, .pr-complaint-box p { margin: 9px 0 0; color: #505764; font-size: 12px; line-height: 1.65; }
.pr-policy-item > small { display: block; margin-top: 7px; color: #7b818c; font-size: 11px; line-height: 1.5; }
.pr-policy-missing { margin-top: 9px; }
.pr-policy-missing summary { color: #5663b6; font-size: 11px; font-weight: 650; cursor: pointer; }
.pr-policy-missing ul, .pr-actions-box ol { margin: 8px 0 0; padding-left: 19px; color: #505764; font-size: 12px; line-height: 1.65; }
.pr-no-policy { border: 1px dashed #d8dbe2; border-radius: 10px; padding: 14px; color: #6c7380; font-size: 12px; line-height: 1.6; }
.pr-complaint-box > strong { color: #237a4b; font-size: 13px; }
.pr-complaint-box.is-emerging > strong { color: #8a5a00; }
.pr-complaint-box.is-explicit > strong { color: #b42318; }
.pr-actions-box ol { display: grid; gap: 5px; }
.pr-compliance-disclaimer { display: flex; align-items: flex-start; gap: 7px; margin: 14px 0 0; border-top: 1px solid #ebecef; padding-top: 11px; color: #7b818c; font-size: 11px; line-height: 1.55; }
.pr-fact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.pr-info-card, .pr-needs-card { min-width: 0; }
.pr-info-title { display: flex; align-items: center; gap: 7px; margin-bottom: 12px; font-weight: 700; }
.pr-fact-row, .pr-system-fact { display: grid; grid-template-columns: 30px 1fr; gap: 8px; align-items: start; margin-top: 10px; }
.pr-fact-row > span, .pr-system-fact > span { display: grid; place-items: center; min-height: 24px; border-radius: 7px; background: #eef0fb; color: #5663b6; font-size: 11px; font-weight: 750; }
.pr-fact-row p, .pr-system-fact p { margin: 0; color: #505764; line-height: 1.55; overflow-wrap: anywhere; }
.pr-fact-row b { display: block; margin-bottom: 3px; color: #20242f; }
.pr-info-card ul, .pr-boundary-card ul, .pr-boundary-card ol { margin: 0; padding-left: 20px; color: #505764; line-height: 1.7; }
.pr-need-list { display: flex; flex-wrap: wrap; gap: 8px; }
.pr-need-list span { border-radius: 999px; background: #eef7f2; color: #237a4b; padding: 7px 10px; font-size: 12px; }
.pr-needs-card > p { margin: 11px 0 0; color: #7b818c; font-size: 12px; }
.pr-tone-row { justify-content: flex-end; }
.pr-tone-row button { padding: 5px 9px; font-size: 12px; }
.pr-draft-card { position: relative; overflow: hidden; }
.pr-draft-card.is-generating > :not(.pr-draft-loading) { opacity: .34; }
.pr-draft-loading { position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; gap: 16px; background: rgba(255, 255, 255, .82); }
.pr-draft-loading .pr-generation-orbit { width: 50px; height: 50px; flex: 0 0 auto; }
.pr-draft-loading > div { display: grid; gap: 4px; }
.pr-draft-loading strong { color: #20242f; font-size: 15px; }
.pr-draft-loading span { color: #5f6673; font-size: 13px; }
.pr-draft-textarea { margin-top: 14px; min-height: 230px; line-height: 1.75; resize: vertical; }
.pr-follow-up { display: flex; align-items: flex-start; gap: 8px; margin-top: 10px; border-radius: 9px; background: #f8f7f3; padding: 10px 12px; color: #5f6673; font-size: 13px; }
.pr-draft-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.pr-boundary-card { padding: 0; overflow: hidden; }
.pr-boundary-card > summary { padding: 16px 18px; }
.pr-boundary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; border-top: 1px solid #ebecef; padding: 16px 18px; }
.pr-boundary-card h3 { margin: 0 0 8px; font-size: 14px; }
.pr-system-facts { border-top: 1px solid #ebecef; padding: 16px 18px; }
.pr-system-facts .pr-system-fact + .pr-system-fact { margin-top: 8px; }
button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 3px solid rgba(86, 99, 182, .25); outline-offset: 2px; }

@keyframes pr-spin { to { transform: rotate(360deg); } }
@keyframes pr-icon-pulse { 50% { opacity: .42; transform: scale(.88); } }
@keyframes pr-step-pulse { 50% { opacity: .35; } }

@media (prefers-reduced-motion: reduce) {
  .pr-generation-orbit::after, .pr-generation-steps span::before, .pr-icon-pulse, .pr-icon-spin { animation: none; }
}

@media (max-width: 980px) {
  .pr-layout { grid-template-columns: 1fr; }
  .pr-input-card { position: static; }
  .pr-compliance-grid { grid-template-columns: 1fr; }
}

@media (max-width: 680px) {
  .pr-toolbar, .pr-draft-heading, .pr-compliance-heading { align-items: stretch; flex-direction: column; }
  .pr-toolbar-note { line-height: 1.5; }
  .pr-compliance-label { max-width: none; }
  .pr-fact-grid, .pr-boundary-grid { grid-template-columns: 1fr; }
  .pr-tone-row { justify-content: flex-start; }
  .pr-draft-actions { display: grid; grid-template-columns: 1fr; }
  .pr-draft-actions .btn { justify-content: center; width: 100%; }
  .pr-draft-loading { flex-direction: column; padding: 24px; text-align: center; }
}
</style>
