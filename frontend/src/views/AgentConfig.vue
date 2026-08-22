<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Brain, CheckCircle, CircleAlert, Eye, EyeOff, Save } from 'lucide-vue-next'
import { get, post, put } from '../api'

const providers = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro']
  },
  custom: {
    label: '自定义 OpenAI-compatible',
    baseUrl: '',
    models: []
  }
}

const route = useRoute()
const router = useRouter()
const isNew = computed(() => route.params.profileId === 'new')
const profileId = ref(isNew.value ? '' : String(route.params.profileId || ''))
const provider = ref('deepseek')
const profileName = ref('新模型配置')
const config = reactive({ api_key: '', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-flash', thinking: 'disabled' })
const apiKeyMasked = ref('')
const apiKeyEditing = ref(false)
const showApiKey = ref(false)
const revealingApiKey = ref(false)
const loading = ref(true)
const saving = ref(false)
const notice = ref('')
const error = ref('')
const modelOptions = computed(() => providers[provider.value].models)
const apiKeyFieldValue = computed(() => (
  apiKeyEditing.value ? config.api_key : (apiKeyMasked.value ? '•'.repeat(32) : '')
))

function detectProvider(baseUrl) {
  return baseUrl?.includes('api.deepseek.com') ? 'deepseek' : 'custom'
}

function selectProvider() {
  const selected = providers[provider.value]
  if (provider.value === 'deepseek') {
    config.base_url = selected.baseUrl
    if (!selected.models.includes(config.model)) config.model = selected.models[0]
  } else if (config.base_url === providers.deepseek.baseUrl) {
    config.base_url = ''
    config.model = ''
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const saved = await get('/api/agent/config')
    if (isNew.value) {
      profileId.value = ''
      provider.value = 'deepseek'
      profileName.value = '新模型配置'
      config.base_url = providers.deepseek.baseUrl
      config.model = providers.deepseek.models[0]
      config.thinking = 'disabled'
      apiKeyMasked.value = ''
      showApiKey.value = false
      return
    }
    const profile = (saved.profiles || []).find((item) => item.profile_id === profileId.value)
      || (saved.profile_id === profileId.value ? saved : null)
    if (!profile) throw new Error('配置档案不存在或已被删除')
    provider.value = detectProvider(profile.base_url)
    profileName.value = profile.profile_name || '模型配置'
    config.base_url = profile.base_url || providers.deepseek.baseUrl
    config.model = profile.model || (provider.value === 'deepseek' ? providers.deepseek.models[0] : '')
    config.thinking = profile.thinking || 'disabled'
    apiKeyMasked.value = profile.api_key_masked || ''
    apiKeyEditing.value = false
    showApiKey.value = false
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function beginApiKeyEdit() {
  if (apiKeyEditing.value) return
  apiKeyEditing.value = true
  config.api_key = ''
}

function toggleApiKeyVisibility() {
  if (showApiKey.value || apiKeyEditing.value || !apiKeyMasked.value || !profileId.value) {
    showApiKey.value = !showApiKey.value
    return
  }
  revealingApiKey.value = true
  get(`/api/agent/config/profiles/${encodeURIComponent(profileId.value)}/key`)
    .then((result) => {
      config.api_key = result.api_key || ''
      apiKeyEditing.value = true
      showApiKey.value = true
    })
    .catch((e) => { error.value = e.message })
    .finally(() => { revealingApiKey.value = false })
}

async function save() {
  saving.value = true
  notice.value = ''
  error.value = ''
  try {
    const payload = {
      api_key: config.api_key.trim() || null,
      base_url: config.base_url.trim(),
      model: config.model.trim(),
      thinking: config.thinking,
    }
    const result = isNew.value
      ? await post('/api/agent/config/profiles', { ...payload, name: profileName.value.trim() })
      : await put('/api/agent/config', { ...payload, profile_id: profileId.value, profile_name: profileName.value.trim() })
    config.api_key = ''
    apiKeyEditing.value = false
    showApiKey.value = false
    revealingApiKey.value = false
    apiKeyMasked.value = result.api_key_masked || apiKeyMasked.value
    notice.value = '配置已保存。'
    if (isNew.value && result.profile_id) {
      profileId.value = String(result.profile_id)
      await router.replace(`/agent/config/${encodeURIComponent(profileId.value)}`)
    }
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

function goBack() {
  router.push('/agent')
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar agent-config-titlebar">
      <div>
        <button class="btn btn-outline agent-back-button" type="button" @click="goBack"><ArrowLeft :size="14" /> 配置档案</button>
        <div class="page-title">{{ isNew ? '新建配置' : '编辑配置' }}</div>
        <div class="page-subtitle">配置模型服务和 API Key，保存后供凯凯使用</div>
      </div>
    </div>

    <div v-if="loading" class="loading">加载配置中…</div>
    <template v-else>
      <div v-if="notice" class="notice-bar"><CheckCircle :size="16" /> {{ notice }}</div>
      <div v-if="error" class="agent-error"><CircleAlert :size="16" /> {{ error }}</div>

      <div class="card agent-config-card">
        <div class="card-title"><Brain :size="16" /> {{ profileName }}</div>
        <div class="form-grid agent-config-form">
          <label class="form-grid-wide">配置名称
            <input v-model="profileName" class="form-input" placeholder="例如 DeepSeek 主账号" />
          </label>
          <label>模型服务
            <select v-model="provider" class="form-select" @change="selectProvider">
              <option v-for="(item, key) in providers" :key="key" :value="key">{{ item.label }}</option>
            </select>
          </label>
          <label>模型名称
            <select v-if="provider === 'deepseek'" v-model="config.model" class="form-select">
              <option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option>
            </select>
            <input v-else v-model="config.model" class="form-input" placeholder="例如 deepseek-v4-flash" />
          </label>
          <label class="form-grid-wide">API Base URL
            <input v-model="config.base_url" class="form-input" placeholder="https://api.deepseek.com" />
          </label>
          <label class="form-grid-wide">API Key <span v-if="apiKeyMasked" class="agent-key-status">（当前：{{ apiKeyMasked }}）</span>
            <span class="api-key-input-wrap">
              <input :value="apiKeyFieldValue" class="form-input api-key-input" :type="showApiKey ? 'text' : 'password'" autocomplete="new-password"
                :placeholder="apiKeyMasked ? '点击后输入新的 Key；直接保存会保留当前 Key' : '请输入 API Key'"
                @focus="beginApiKeyEdit" @input="config.api_key = $event.target.value" />
              <button class="api-key-toggle" type="button" :disabled="revealingApiKey" :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'"
                :title="showApiKey ? '隐藏 API Key' : '显示 API Key'" @mousedown.prevent @click.stop="toggleApiKeyVisibility">
                <EyeOff v-if="showApiKey" :size="16" />
                <Eye v-else :size="16" />
              </button>
            </span>
          </label>
          <label>Thinking 模式
            <select v-model="config.thinking" class="form-select">
              <option value="disabled">关闭（推荐，工具调用更稳定）</option>
              <option value="enabled">开启（需要模型支持 reasoning_content）</option>
            </select>
          </label>
        </div>
        <div class="toolbar agent-config-actions">
          <button class="btn btn-primary" type="button" :disabled="saving" @click="save"><Save :size="14" /> {{ saving ? '保存中…' : '保存配置' }}</button>
          <button class="btn btn-outline" type="button" @click="goBack">返回配置列表</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.agent-config-titlebar { display:flex; align-items:flex-start; }
.agent-back-button { margin-bottom:12px; }
.agent-config-card { max-width:900px; }
.agent-config-form { max-width:760px; }
.agent-config-actions { margin-top:18px; }
.agent-key-status { color:var(--success); font-size:12px; font-weight:400; }
.api-key-input-wrap { position:relative; display:block; }
.api-key-input { padding-right:42px; }
.api-key-toggle { position:absolute; top:50%; right:10px; display:grid; place-items:center; width:26px; height:26px; padding:0; transform:translateY(-50%); border:0; border-radius:6px; color:var(--text-secondary); background:transparent; cursor:pointer; }
.api-key-toggle:disabled { cursor:wait; opacity:.55; }
.api-key-toggle:hover { color:var(--text); background:var(--bg-muted); }
.api-key-toggle:focus-visible { outline:2px solid var(--primary); outline-offset:1px; }
@media (max-width:700px) { .agent-config-card { padding:16px; } }
</style>
