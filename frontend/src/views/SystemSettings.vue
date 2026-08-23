<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowLeft, Brain, CheckCircle, CircleAlert, Save, Settings } from 'lucide-vue-next'
import { get, put } from '../api'
import { useRouter } from 'vue-router'

const router = useRouter()
const schoolName = ref('')
const loading = ref(true)
const saving = ref(false)
const notice = ref('')
const error = ref('')
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

onMounted(load)
onBeforeUnmount(clearNoticeTimer)
</script>

<template>
  <div>
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
    </template>
  </div>
</template>

<style scoped>
.system-settings-titlebar { display:flex; align-items:flex-start; }
.system-settings-back { margin-bottom:12px; }
.system-settings-card { max-width:760px; }
.system-settings-field { display:grid; gap:8px; max-width:620px; color:var(--text); font-weight:600; }
.system-settings-field small { color:var(--text-secondary); font-size:12px; font-weight:400; line-height:1.6; }
.system-settings-actions { margin-top:18px; }
.system-settings-ai-card { margin-top:16px; }
.system-settings-description { margin:0 0 16px; color:var(--text-secondary); font-size:13px; line-height:1.6; }
</style>
