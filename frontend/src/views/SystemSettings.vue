<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Archive, ArrowLeft, Brain, CheckCircle, CircleAlert, Download, Save, Settings, Upload } from 'lucide-vue-next'
import { download, get, post, put, upload } from '../api'
import { useRouter } from 'vue-router'

const router = useRouter()
const schoolName = ref('')
const loading = ref(true)
const saving = ref(false)
const notice = ref('')
const error = ref('')
const fileInput = ref(null)
const migrationInput = ref(null)
const dataMessage = ref('')
let noticeTimer

function clearNoticeTimer() {
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = undefined
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const settings = await get('/api/system/settings')
    schoolName.value = settings.school_name || ''
  } catch (e) {
    error.value = e.message || '系统设置加载失败。'
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  clearNoticeTimer()
  notice.value = ''
  error.value = ''
  try {
    const result = await put('/api/system/settings', { school_name: schoolName.value.trim() })
    schoolName.value = result.school_name || schoolName.value.trim()
    window.dispatchEvent(new CustomEvent('workbench-system-settings-updated', { detail: result }))
    notice.value = '学校名称已保存。'
    noticeTimer = window.setTimeout(() => {
      notice.value = ''
      noticeTimer = undefined
    }, 3000)
  } catch (e) {
    error.value = e.message || '学校名称保存失败。'
  } finally {
    saving.value = false
  }
}

async function backup() {
  dataMessage.value = '正在生成备份…'
  try {
    const result = await post('/api/system/backup', {})
    dataMessage.value = `备份已生成：${result.filename}`
    await download(`/api/system/backup/${encodeURIComponent(result.filename)}`, result.filename)
  } catch (e) { dataMessage.value = `备份失败：${e.message}` }
}

async function restore(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || !confirm('恢复会替换当前数据。确定继续吗？')) return
  dataMessage.value = '正在恢复数据…'
  try {
    await upload('/api/system/restore', file)
    dataMessage.value = '恢复完成，页面数据已刷新'
  } catch (e) { dataMessage.value = `恢复失败：${e.message}` }
}

async function exportMigration() {
  dataMessage.value = '正在整理迁移包（数据库、附件和知识库）…'
  try {
    const result = await post('/api/system/migration/export', {})
    dataMessage.value = `迁移包已生成：${result.filename}`
    await download(`/api/system/migration/${encodeURIComponent(result.filename)}`, result.filename)
  } catch (e) { dataMessage.value = `迁移包生成失败：${e.message}` }
}

async function importMigration(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || !confirm('导入迁移包会替换当前数据库，并覆盖同名照片、附件和知识库文件。系统会先自动备份当前数据库，确定继续吗？')) return
  dataMessage.value = '正在导入迁移包…'
  try {
    await upload('/api/system/migration/import', file)
    dataMessage.value = '迁移包导入完成，请重新打开需要查看的页面'
  } catch (e) { dataMessage.value = `迁移包导入失败：${e.message}` }
}

onMounted(load)
onBeforeUnmount(clearNoticeTimer)
</script>

<template>
  <div class="system-settings-page">
    <div class="page-title-bar system-settings-titlebar">
      <div>
        <button class="btn btn-outline system-settings-back" type="button" @click="router.push('/dashboard')"><ArrowLeft :size="14" /> 返回工作台</button>
        <div class="page-title">系统设置</div>
        <div class="page-subtitle">配置工作台的学校信息和本机运行偏好</div>
      </div>
    </div>

    <div v-if="loading" class="loading">加载设置中…</div>
    <template v-else>
      <div v-if="notice" class="notice-bar"><CheckCircle :size="16" /> {{ notice }}</div>
      <div v-if="error" class="agent-error"><CircleAlert :size="16" /> {{ error }}</div>

      <div class="card system-settings-card">
        <div class="card-title"><Settings :size="16" /> 学校信息</div>
        <label class="system-settings-field">
          <span>学校名称</span>
          <input v-model="schoolName" class="form-input" maxlength="120" placeholder="请输入学校名称" @keyup.enter="save" />
          <small>会显示在左侧栏，并作为工作台统一保存的学校名称。</small>
        </label>
        <div class="toolbar system-settings-actions">
          <button class="btn btn-primary" type="button" :disabled="saving" @click="save"><Save :size="14" /> {{ saving ? '保存中…' : '保存设置' }}</button>
        </div>
      </div>

      <div class="card system-settings-card system-settings-ai-card">
        <div class="card-title"><Brain :size="16" /> AI 设置</div>
        <p class="system-settings-description">管理班小助使用的模型服务、API Key 和微信 iLink 配置。</p>
        <button class="btn btn-outline" type="button" @click="router.push('/agent')">打开 AI 设置</button>
      </div>

      <div class="card system-settings-card system-settings-data-card">
        <div class="card-title"><Archive :size="16" /> 数据安全与迁移</div>
        <p class="system-settings-description">备份、恢复和迁移只在这里进行。恢复或导入会替换当前数据，请先确认目标文件。</p>
        <div v-if="dataMessage" class="notice-bar"><CheckCircle :size="16" /> {{ dataMessage }}</div>
        <div class="toolbar system-settings-data-actions">
          <button class="btn btn-primary" type="button" @click="backup"><Download :size="14" /> 备份数据</button>
          <button class="btn btn-outline" type="button" @click="fileInput?.click()"><Upload :size="14" /> 恢复数据</button>
          <button class="btn btn-outline" type="button" @click="exportMigration"><Archive :size="14" /> 导出迁移包</button>
          <button class="btn btn-outline" type="button" @click="migrationInput?.click()"><Archive :size="14" /> 导入迁移包</button>
        </div>
        <input ref="fileInput" type="file" accept=".db" hidden @change="restore">
        <input ref="migrationInput" type="file" accept=".zip" hidden @change="importMigration">
      </div>
    </template>
  </div>
</template>

<style scoped>
.system-settings-titlebar { display:flex; align-items:flex-start; }
.system-settings-back { margin-bottom:12px; }
.system-settings-page { width: 100%; }
.system-settings-card { width: 100%; box-sizing: border-box; }
.system-settings-field { display:grid; gap:8px; max-width:620px; color:var(--text); font-weight:600; }
.system-settings-field small { color:var(--text-secondary); font-size:12px; font-weight:400; line-height:1.6; }
.system-settings-actions { margin-top:18px; }
.system-settings-ai-card { margin-top:16px; }
.system-settings-data-card { margin-top:16px; }
.system-settings-data-actions { margin-top:16px; }
.system-settings-data-actions .btn { white-space:nowrap; }
.system-settings-description { margin:0 0 16px; color:var(--text-secondary); font-size:13px; line-height:1.6; }
</style>
