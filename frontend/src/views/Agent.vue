<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Brain, CheckCircle, CircleAlert, Send } from 'lucide-vue-next'
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

const provider = ref('deepseek')
const config = reactive({ api_key: '', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-flash', thinking: 'disabled' })
const status = ref(null)
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const notice = ref('')
const error = ref('')
const modelOptions = computed(() => providers[provider.value].models)

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
    const [saved, current] = await Promise.all([get('/api/agent/config'), get('/api/agent/status')])
    provider.value = detectProvider(saved.base_url)
    config.base_url = saved.base_url || config.base_url
    config.model = saved.model || config.model
    config.thinking = saved.thinking || 'disabled'
    status.value = current
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  notice.value = ''
  error.value = ''
  try {
    const result = await put('/api/agent/config', {
      api_key: config.api_key.trim() || null,
      base_url: config.base_url.trim(),
      model: config.model.trim(),
      thinking: config.thinking,
    })
    config.api_key = ''
    notice.value = `配置已保存${result.api_key_masked ? `（${result.api_key_masked}）` : ''}`
    await load()
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

async function testModel() {
  testing.value = true
  notice.value = ''
  error.value = ''
  try {
    const result = await post('/api/agent/chat', {
      session_id: 'agent-settings-test',
      message: '请只回复：模型连接成功。',
      channel: 'local',
      actor_id: 'settings'
    })
    notice.value = result.answer || '模型已返回结果'
  } catch (e) {
    error.value = e.message
  } finally {
    testing.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div>
        <div class="page-title">Agent 设置</div>
        <div class="page-subtitle">配置模型，让凯凯小兵能够查询工作台数据</div>
      </div>
    </div>

    <div v-if="loading" class="loading">加载配置中…</div>
    <template v-else>
      <div v-if="notice" class="notice-bar"><CheckCircle :size="16" /> {{ notice }}</div>
      <div v-if="error" class="agent-error"><CircleAlert :size="16" /> {{ error }}</div>

      <div class="card">
        <div class="card-title"><Brain :size="16" /> 模型连接</div>
        <div class="form-grid agent-form-grid">
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
          <label class="form-grid-wide">API Key
            <input v-model="config.api_key" class="form-input" type="password" autocomplete="new-password" placeholder="留空表示保留当前 Key" />
          </label>
          <label>Thinking 模式
            <select v-model="config.thinking" class="form-select">
              <option value="disabled">关闭（推荐，工具调用更稳定）</option>
              <option value="enabled">开启（需要模型支持 reasoning_content）</option>
            </select>
          </label>
        </div>
        <div class="agent-security-note">Key 只保存到本机数据目录，不会通过接口返回，也不会写入 Git。</div>
        <div class="toolbar agent-actions">
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存配置' }}</button>
          <button class="btn btn-outline" :disabled="testing" @click="testModel"><Send :size="14" /> {{ testing ? '测试中…' : '测试模型' }}</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">当前状态</div>
        <div class="agent-status-grid">
          <div><span>模型</span><strong>{{ status?.model || '未配置' }}</strong></div>
          <div><span>模型配置</span><strong :class="status?.model_configured ? 'status-ok' : 'status-off'">{{ status?.model_configured ? '已配置' : '未配置' }}</strong></div>
          <div><span>可用工具</span><strong>{{ status?.tool_count || 0 }} 个只读工具</strong></div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.agent-form-grid { max-width: 760px; }
.agent-security-note { margin-top: 14px; color: var(--text-secondary); font-size: 12px; }
.agent-actions { margin-top: 18px; }
.agent-error { display:flex; align-items:center; gap:8px; padding:10px 14px; margin:-8px 0 18px; border-radius:var(--radius); color:#a33a32; background:var(--danger-bg); font-size:13px; }
.agent-status-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
.agent-status-grid div { display:grid; gap:4px; padding:12px; border-radius:10px; background:var(--bg); }
.agent-status-grid span { color:var(--text-secondary); font-size:12px; }
.agent-status-grid strong { font-size:14px; }
.status-ok { color:var(--success); }
.status-off { color:var(--text-secondary); }
@media (max-width: 700px) { .agent-status-grid { grid-template-columns:1fr; } }
</style>
