<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { Clock3, History, X } from 'lucide-vue-next'
import { get, put } from '../api'

const props = defineProps({ sourceType: String, sourceId: Number, title: String, actionLabel: String, initialStatus: String })
const emit = defineEmits(['close', 'success'])
const data = ref(null)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const dialog = ref(null)
const form = ref({ status: '', progress: '', result: '', next_action_at: '', task_action: '', fields: {} })

const configs = {
  event: { next: '下次复查日期', result: '处理结论', fields: [{ key: 'handling', label: '处理情况' }] },
  communication: { next: '下次联系日期', result: '回访结论', fields: [{ key: 'feedback', label: '家长反馈' }, { key: 'agreement', label: '双方约定' }] },
  focus: { next: '下次复查日期', result: '阶段结论', fields: [] }
}
const config = computed(() => configs[props.sourceType] || configs.event)
const modalLabel = computed(() => props.actionLabel || (props.sourceType === 'focus' ? '更新关注进展' : props.sourceType === 'event' ? '查看事件跟进' : '更新沟通进展'))
const closing = computed(() => data.value?.closed_statuses?.includes(form.value.status))
const linkedOpen = computed(() => data.value?.linked_work_item && !['已完成', '已取消'].includes(data.value.linked_work_item.status))

async function load() {
  loading.value = true
  try {
    data.value = await get(`/api/workflows/${props.sourceType}/${props.sourceId}`)
    const source = data.value.source || {}
    const fields = {}
    for (const item of config.value.fields) fields[item.key] = source[item.key] || ''
    const nextKey = props.sourceType === 'event' ? 'followup_due' : props.sourceType === 'communication' ? 'followup_at' : 'next_review_at'
    form.value = {
      status: props.initialStatus || source.status, progress: '', result: source.result || source.conclusion || '',
      next_action_at: source[nextKey] || '', task_action: '', fields
    }
    nextTick(() => dialog.value?.focus())
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

async function save() {
  error.value = ''
  if (closing.value && !form.value.result.trim()) { error.value = '关闭前请填写处理结论'; return }
  if (closing.value && linkedOpen.value && !form.value.task_action) { error.value = '请选择如何处理关联工作项'; return }
  saving.value = true
  try {
    await put(`/api/workflows/${props.sourceType}/${props.sourceId}`, {
      ...form.value,
      request_id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${props.sourceId}`
    })
    emit('success')
  } catch (e) { error.value = e.message } finally { saving.value = false }
}

function statusText(item) {
  return item.status_from && item.status_from !== item.status_to
    ? `${item.status_from} → ${item.status_to}` : item.status_to
}

onMounted(load)
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay show workflow-overlay" @click.self="$emit('close')" @keydown.esc="$emit('close')">
      <section ref="dialog" class="modal workflow-modal" role="dialog" aria-modal="true" tabindex="-1">
        <button class="workflow-close" aria-label="关闭" @click="$emit('close')"><X :size="18" /></button>
        <div class="modal-kicker">{{ modalLabel }}</div>
        <h3>{{ title }}</h3>
        <div v-if="loading" class="loading">加载中…</div>
        <template v-else-if="data">
          <div class="workflow-grid">
            <div class="form-group"><label>当前状态</label><select v-model="form.status" class="form-select"><option v-for="status in data.allowed_statuses" :key="status">{{ status }}</option></select></div>
            <div class="form-group"><label>{{ config.next }}</label><input v-model="form.next_action_at" type="date" class="form-input" /></div>
          </div>
          <div v-for="item in config.fields" :key="item.key" class="form-group"><label>{{ item.label }}</label><textarea v-model="form.fields[item.key]" class="form-textarea" rows="2"></textarea></div>
          <div class="form-group"><label>本次进展</label><textarea v-model="form.progress" class="form-textarea" rows="3" placeholder="记录本次采取的行动、观察或反馈"></textarea></div>
          <div v-if="closing" class="form-group"><label>{{ config.result }}</label><textarea v-model="form.result" class="form-textarea" rows="3" placeholder="填写可以回溯的处理结论"></textarea></div>
          <div v-if="closing && linkedOpen" class="workflow-task-choice">
            <strong>关联工作项仍未关闭</strong>
            <label><input v-model="form.task_action" type="radio" value="complete" /> 同步标记为已完成</label>
            <label><input v-model="form.task_action" type="radio" value="cancel" /> 同步取消</label>
          </div>
          <div v-if="error" class="error-text">{{ error }}</div>
          <div class="workflow-history">
            <div class="workflow-history-title"><History :size="15" /> 过程记录 <span>{{ data.updates.length }}</span></div>
            <div v-if="!data.updates.length" class="hint">还没有过程记录，保存本次进展后会显示在这里。</div>
            <div v-for="item in data.updates" :key="item.id" class="workflow-history-item">
              <Clock3 :size="13" /><div><strong>{{ statusText(item) || '内容更新' }}</strong><p>{{ item.content || '更新了记录' }}</p><small>{{ item.created_at }}</small></div>
            </div>
          </div>
          <div class="modal-actions"><button class="btn btn-outline" @click="$emit('close')">取消</button><button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存进展' }}</button></div>
        </template>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.workflow-overlay { z-index: 1050; }
.workflow-modal { position: relative; width: min(660px, calc(100vw - 28px)); max-height: 88vh; overflow-y: auto; }
.workflow-modal:focus { outline: none; }
.workflow-close { position: absolute; top: 16px; right: 16px; display: grid; place-items: center; border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; }
.workflow-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.workflow-task-choice { display: flex; flex-wrap: wrap; gap: 10px 18px; margin: 12px 0; padding: 13px; border: 1px solid #f1d6a5; border-radius: 11px; background: #fff9ed; font-size: 12px; }
.workflow-task-choice strong { width: 100%; }
.workflow-task-choice label { display: flex; align-items: center; gap: 6px; }
.workflow-history { display: grid; gap: 8px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border-light); }
.workflow-history-title { display: flex; align-items: center; gap: 6px; font-weight: 700; }
.workflow-history-title span { color: var(--text-secondary); font-size: 11px; }
.workflow-history-item { display: grid; grid-template-columns: 18px 1fr; gap: 6px; padding: 9px 10px; border-radius: 9px; background: var(--bg); }
.workflow-history-item div { display: grid; gap: 2px; }
.workflow-history-item strong { font-size: 12px; }.workflow-history-item p { margin: 0; font-size: 12px; }.workflow-history-item small { color: var(--text-secondary); }
@media (max-width: 620px) { .workflow-grid { grid-template-columns: 1fr; } }
</style>
