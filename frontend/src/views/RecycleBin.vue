<script setup>
import { computed, onMounted, ref } from 'vue'
import { History, RotateCcw, ShieldCheck, Trash2 } from 'lucide-vue-next'
import { del, get, post } from '../api'

const activeTab = ref('recycle')
const items = ref([])
const audits = ref([])
const loading = ref(true)
const typeFilter = ref('')
const purgeTarget = ref(null)
const confirmation = ref('')
const message = ref('')

const typeLabels = {
  student: '学生', event: '学生事件', work_item: '工作项', focus: '关注事项',
  communication: '家校沟通', exam: '成绩', attendance_rule: '考勤规则',
  score_rule: '成绩规则',
  class_task: '班级任务', duty_assignment: '值日安排', sheet_row: '工作表记录',
}
const actionLabels = {
  create: '新增', update: '更新', edit: '编辑', status: '状态变化',
  progress: '记录进展', delete: '移入回收站', restore: '恢复', purge: '永久删除',
  archive: '归档',
}
const filteredItems = computed(() => typeFilter.value
  ? items.value.filter(item => item.object_type === typeFilter.value)
  : items.value)

async function load() {
  loading.value = true
  message.value = ''
  try {
    if (activeTab.value === 'recycle') {
      items.value = (await get('/api/recycle-bin?status=已删除')).items || []
    } else {
      audits.value = (await get('/api/system/audit?limit=300')).items || []
    }
  } catch (error) {
    message.value = error.message
  } finally {
    loading.value = false
  }
}

async function switchTab(tab) {
  activeTab.value = tab
  await load()
}

async function restore(item) {
  if (!confirm(`恢复“${item.label || '这条记录'}”吗？`)) return
  try {
    await post(`/api/recycle-bin/${item.id}/restore`, {})
    message.value = '记录已恢复到原位置'
    await load()
  } catch (error) { message.value = error.message }
}

function openPurge(item) {
  purgeTarget.value = item
  confirmation.value = ''
}

async function purge() {
  if (!purgeTarget.value || confirmation.value !== '永久删除') return
  try {
    await del(`/api/recycle-bin/${purgeTarget.value.id}/purge`, { confirmation: confirmation.value })
    purgeTarget.value = null
    confirmation.value = ''
    message.value = '记录已永久删除，无法恢复'
    await load()
  } catch (error) { message.value = error.message }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div><div class="page-title">回收站与审计</div><div class="page-subtitle">恢复误删数据，查看系统业务操作记录</div></div>
    </div>

    <div class="safety-tabs" role="tablist">
      <button :class="{ active: activeTab === 'recycle' }" @click="switchTab('recycle')"><Trash2 :size="15" /> 回收站</button>
      <button :class="{ active: activeTab === 'audit' }" @click="switchTab('audit')"><ShieldCheck :size="15" /> 操作审计</button>
    </div>
    <div v-if="message" class="inline-message">{{ message }}</div>

    <div v-if="activeTab === 'recycle'" class="card">
      <div class="card-title"><Trash2 :size="16" /> 已删除记录 <span class="count">{{ filteredItems.length }} 条</span>
        <select v-model="typeFilter" class="form-select recycle-filter">
          <option value="">全部模块</option>
          <option v-for="(label, key) in typeLabels" :key="key" :value="key">{{ label }}</option>
        </select>
      </div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!filteredItems.length" class="empty-state"><RotateCcw :size="28" /><strong>回收站是空的</strong><span>删除的业务记录会保留在这里，直到恢复或永久删除。</span></div>
      <div v-else class="recycle-list">
        <div v-for="item in filteredItems" :key="item.id" class="recycle-row">
          <div class="recycle-kind">{{ typeLabels[item.object_type] || item.object_type }}</div>
          <div class="recycle-copy"><strong>{{ item.label || `记录 ${item.object_id}` }}</strong><span>{{ item.deleted_at }} · {{ item.deleted_by || '本地用户' }}</span></div>
          <div class="recycle-actions"><button class="btn btn-sm btn-outline" @click="restore(item)"><RotateCcw :size="13" /> 恢复</button><button class="danger-link" @click="openPurge(item)">永久删除</button></div>
        </div>
      </div>
    </div>

    <div v-else class="card">
      <div class="card-title"><History :size="16" /> 系统业务操作 <span class="count">最近 {{ audits.length }} 条</span></div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!audits.length" class="empty-state">还没有系统业务操作记录</div>
      <div v-else class="audit-list">
        <div v-for="item in audits" :key="item.id" class="audit-row">
          <span class="audit-status" :class="{ failed: item.status !== 'success' }"></span>
          <div><strong>{{ actionLabels[item.action] || item.action }} · {{ item.summary || item.object_type }}</strong><span>{{ item.created_at }} · {{ item.channel }} / {{ item.actor_id }} · {{ typeLabels[item.object_type] || item.object_type }} #{{ item.object_id }}</span></div>
        </div>
      </div>
    </div>

    <div v-if="purgeTarget" class="modal-overlay" @click.self="purgeTarget = null">
      <section class="purge-dialog" role="dialog" aria-modal="true" aria-labelledby="purge-title">
        <div id="purge-title" class="purge-title">永久删除记录</div>
        <p>“{{ purgeTarget.label }}”将被从数据库中移除，无法通过回收站恢复。</p>
        <label>请输入“永久删除”确认<input v-model="confirmation" class="form-input" autocomplete="off" placeholder="永久删除"></label>
        <div class="modal-actions"><button class="btn btn-outline" @click="purgeTarget = null">取消</button><button class="btn btn-danger" :disabled="confirmation !== '永久删除'" @click="purge">永久删除</button></div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.safety-tabs { display: inline-flex; gap: 4px; margin: -8px 0 18px; padding: 4px; border-radius: 11px; background: rgba(0,0,0,.045); }
.safety-tabs button { display: flex; align-items: center; gap: 6px; padding: 7px 12px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.safety-tabs button.active { background: #fff; color: var(--primary); box-shadow: var(--shadow-sm); font-weight: 600; }
.recycle-filter { width: 140px; margin-left: auto; padding: 6px 28px 6px 9px; }
.recycle-list, .audit-list { display: grid; }
.recycle-row { display: grid; grid-template-columns: 90px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 14px 2px; border-bottom: 1px solid var(--border); }
.recycle-row:last-child, .audit-row:last-child { border-bottom: 0; }
.recycle-kind { width: fit-content; padding: 4px 7px; border-radius: 7px; background: var(--primary-bg); color: var(--primary); font-size: 11px; font-weight: 600; }
.recycle-copy, .audit-row > div { min-width: 0; display: grid; gap: 3px; }
.recycle-copy strong, .audit-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.recycle-copy span, .audit-row span { color: var(--text-secondary); font-size: 11px; }
.recycle-actions { display: flex; align-items: center; gap: 10px; }
.danger-link { border: 0; background: transparent; color: var(--danger); font: inherit; font-size: 12px; cursor: pointer; }
.audit-row { display: grid; grid-template-columns: 8px minmax(0, 1fr); align-items: start; gap: 11px; padding: 13px 3px; border-bottom: 1px solid var(--border); }
.audit-status { width: 7px; height: 7px; margin-top: 6px; border-radius: 50%; background: var(--success); }
.audit-status.failed { background: var(--danger); }
.empty-state { display: grid; justify-items: center; gap: 7px; }
.empty-state strong { color: var(--text); font-size: 14px; }
.purge-dialog { width: min(420px, calc(100vw - 32px)); padding: 22px; border-radius: 18px; background: #fff; box-shadow: var(--shadow-lg); }
.purge-title { margin-bottom: 7px; font-size: 18px; font-weight: 700; }
.purge-dialog p { margin-bottom: 18px; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
.purge-dialog label { display: grid; gap: 7px; color: var(--text-secondary); font-size: 12px; }
.purge-dialog .modal-actions { margin-top: 20px; }
@media (max-width: 680px) {
  .safety-tabs { display: flex; }
  .safety-tabs button { flex: 1; justify-content: center; }
  .recycle-row { grid-template-columns: 1fr; gap: 7px; }
  .recycle-actions { justify-content: flex-start; }
  .recycle-filter { width: 125px; }
}
</style>
