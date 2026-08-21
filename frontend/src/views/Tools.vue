<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { ExternalLink, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from 'lucide-vue-next'
import { listToolLinks, createToolLink, updateToolLink, deleteToolLink, recordToolLinkUsage } from '../api'
import { useConfirmDialog } from '../composables/confirmDialog'

const { confirm: confirmDialog } = useConfirmDialog()
const items = ref([])
const loading = ref(true)
const error = ref('')
const message = ref('')
const searchText = ref('')
const showEditor = ref(false)
const editorEl = ref(null)
const saving = ref(false)
const editError = ref('')
const editingId = ref(null)
const logoState = reactive(new Map())
let returnFocus = null

const CATEGORIES = ['教务系统', '教学平台', '备课资源', '班级沟通', '学校服务', '其他']

const form = ref(defaultForm())

function defaultForm() {
  return { name: '', url: '', category: '教务系统', icon: '', color: '', sort_order: 0, pinned: false }
}

const groupedItems = computed(() => {
  const list = items.value
  const pinned = list.filter(item => item.pinned)
  const byCategory = new Map()
  for (const cat of CATEGORIES) {
    const catItems = list.filter(item => item.category === cat && !item.pinned)
    if (catItems.length) byCategory.set(cat, catItems)
  }
  const uncategorized = list.filter(item => !CATEGORIES.includes(item.category) && !item.pinned)
  if (uncategorized.length) byCategory.set('其他', uncategorized)
  return { pinned, byCategory }
})

function extractDomain(url) {
  try { return new URL(url).hostname } catch { return url }
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || !host.includes('.')) return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false
  const [a, b] = parts
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function logoKey(item) {
  return `${item.id}:${item.url}`
}

function logoCandidates(item) {
  if (!isHttpUrl(item.url)) return []
  try {
    const parsed = new URL(item.url)
    const candidates = []
    if (isHttpUrl(item.icon)) candidates.push(item.icon.trim())
    candidates.push(new URL('/favicon.ico', parsed.origin).toString())
    if (!isPrivateHost(parsed.hostname)) {
      candidates.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname)}&sz=64`)
    }
    return [...new Set(candidates)]
  } catch {
    return []
  }
}

function logoSrc(item) {
  const candidates = logoCandidates(item)
  const index = logoState.get(logoKey(item)) ?? 0
  return candidates[index] || ''
}

function handleLogoError(item) {
  const key = logoKey(item)
  const candidates = logoCandidates(item)
  const nextIndex = (logoState.get(key) ?? 0) + 1
  logoState.set(key, nextIndex < candidates.length ? nextIndex : candidates.length)
}

function logoLetter(item) {
  return String(item.name || extractDomain(item.url) || '?').trim().slice(0, 1).toUpperCase()
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await listToolLinks(searchText.value.trim() || undefined)
    items.value = result.items || []
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function openCreate() {
  returnFocus = document.activeElement
  editingId.value = null
  form.value = defaultForm()
  editError.value = ''
  showEditor.value = true
  nextTick(() => editorEl.value?.querySelector('input')?.focus())
}

function openEdit(item) {
  returnFocus = document.activeElement
  editingId.value = item.id
  form.value = {
    name: item.name,
    url: item.url,
    category: item.category || '教务系统',
    icon: item.icon || '',
    color: item.color || '',
    sort_order: item.sort_order || 0,
    pinned: Boolean(item.pinned),
  }
  editError.value = ''
  showEditor.value = true
  nextTick(() => editorEl.value?.querySelector('input')?.focus())
}

function closeEditor() {
  showEditor.value = false
  nextTick(() => { if (returnFocus) returnFocus.focus(); returnFocus = null })
}

async function save() {
  saving.value = true
  editError.value = ''
  try {
    if (editingId.value) {
      await updateToolLink(editingId.value, form.value)
      message.value = '工作入口已更新'
    } else {
      await createToolLink(form.value)
      message.value = '工作入口已添加'
    }
    showEditor.value = false
    await load()
  } catch (e) {
    editError.value = e.message
  } finally {
    saving.value = false
  }
}

async function remove(item) {
  if (!await confirmDialog(`确定删除「${item.name}」吗？`)) return
  try {
    await deleteToolLink(item.id)
    message.value = '工作入口已删除'
    await load()
  } catch (e) {
    error.value = e.message
  }
}

async function togglePin(item) {
  try {
    await updateToolLink(item.id, { pinned: !item.pinned })
    await load()
  } catch (e) {
    error.value = e.message
  }
}

async function openLink(item) {
  try {
    await recordToolLinkUsage(item.id)
  } catch { /* ignore */ }
  if (window.__workbench_electron?.openExternal) {
    window.__workbench_electron.openExternal(item.url)
  } else {
    window.open(item.url, '_blank', 'noopener,noreferrer')
  }
}

function handleEditorKeydown(event) {
  if (event.key === 'Escape') { event.preventDefault(); closeEditor() }
}

let debounceTimer = null
function onSearchInput() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => load(), 300)
}

onMounted(load)
</script>

<template>
  <div class="tools-page">
    <header class="tools-header">
      <h1>工作入口</h1>
      <div class="tools-header-actions">
        <div class="tools-search">
          <Search :size="16" />
          <input v-model="searchText" type="search" placeholder="搜索入口…" enterkeyhint="search" @input="onSearchInput" @keyup.enter="load" />
        </div>
        <button class="btn btn-primary" type="button" @click="openCreate">
          <Plus :size="16" /> 新增入口
        </button>
      </div>
    </header>

    <div v-if="message" class="tools-message">{{ message }}</div>
    <div v-if="error" class="tools-error">{{ error }}</div>

    <div v-if="loading" class="tools-loading">加载中…</div>

    <template v-else-if="!items.length">
      <div class="tools-empty">
        <p>还没有添加工作入口，点击上方按钮新增</p>
      </div>
    </template>

    <template v-else>
      <section v-if="groupedItems.pinned.length" class="tools-section">
        <div class="tools-section-title">
          <Pin :size="14" /> 已置顶
        </div>
        <div class="tools-grid">
          <div v-for="item in groupedItems.pinned" :key="item.id" class="tool-card tool-card-pinned" @click="openLink(item)">
            <div class="tool-card-main">
              <span class="tool-card-logo" :style="{ '--tool-logo-color': item.color || 'var(--ds-color-primary)' }">
                <img v-if="logoSrc(item)" :src="logoSrc(item)" alt="" referrerpolicy="no-referrer" @error="handleLogoError(item)" />
                <span v-else class="tool-card-logo-fallback" aria-hidden="true">{{ logoLetter(item) }}</span>
              </span>
              <div class="tool-card-info">
                <strong>{{ item.name }}</strong>
                <span class="tool-card-domain">{{ extractDomain(item.url) }}</span>
              </div>
            </div>
            <div class="tool-card-actions" @click.stop>
              <button type="button" class="tool-action" :title="item.pinned ? '取消置顶' : '置顶'" @click="togglePin(item)">
                <PinOff v-if="item.pinned" :size="14" />
                <Pin v-else :size="14" />
              </button>
              <button type="button" class="tool-action" title="编辑" @click="openEdit(item)">
                <Pencil :size="14" />
              </button>
              <button type="button" class="tool-action tool-action-danger" title="删除" @click="remove(item)">
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section v-for="[category, catItems] in groupedItems.byCategory" :key="category" class="tools-section">
        <div class="tools-section-title">{{ category }}</div>
        <div class="tools-grid">
          <div v-for="item in catItems" :key="item.id" class="tool-card" @click="openLink(item)">
            <div class="tool-card-main">
              <span class="tool-card-logo" :style="{ '--tool-logo-color': item.color || 'var(--ds-color-primary)' }">
                <img v-if="logoSrc(item)" :src="logoSrc(item)" alt="" referrerpolicy="no-referrer" @error="handleLogoError(item)" />
                <span v-else class="tool-card-logo-fallback" aria-hidden="true">{{ logoLetter(item) }}</span>
              </span>
              <div class="tool-card-info">
                <strong>{{ item.name }}</strong>
                <span class="tool-card-domain">{{ extractDomain(item.url) }}</span>
              </div>
            </div>
            <div class="tool-card-actions" @click.stop>
              <button type="button" class="tool-action" :title="item.pinned ? '取消置顶' : '置顶'" @click="togglePin(item)">
                <PinOff v-if="item.pinned" :size="14" />
                <Pin v-else :size="14" />
              </button>
              <button type="button" class="tool-action" title="编辑" @click="openEdit(item)">
                <Pencil :size="14" />
              </button>
              <button type="button" class="tool-action tool-action-danger" title="删除" @click="remove(item)">
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </div>
      </section>
    </template>

    <transition name="tools-scrim">
      <div v-if="showEditor" class="tools-scrim" @click.self="closeEditor">
        <section ref="editorEl" class="tools-editor" role="dialog" aria-modal="true" @keydown="handleEditorKeydown">
          <header class="tools-editor-head">
            <h2>{{ editingId ? '编辑工作入口' : '新增工作入口' }}</h2>
            <button type="button" class="icon-button" aria-label="关闭" @click="closeEditor"><X :size="18" /></button>
          </header>
          <div v-if="editError" class="tools-error">{{ editError }}</div>
          <div class="tools-editor-body">
            <label class="tools-field">
              <span>名称</span>
              <input v-model="form.name" type="text" placeholder="如：教务管理系统" />
            </label>
            <label class="tools-field">
              <span>网址</span>
              <input v-model="form.url" type="url" placeholder="https://example.com" />
            </label>
            <label class="tools-field">
              <span>分类</span>
              <select v-model="form.category">
                <option v-for="cat in CATEGORIES" :key="cat" :value="cat">{{ cat }}</option>
              </select>
            </label>
            <label class="tools-field">
              <span>标记颜色</span>
              <div class="tools-color-row">
                <input v-model="form.color" type="color" class="tools-color-input" />
                <input v-model="form.color" type="text" placeholder="#4b57a2" />
              </div>
            </label>
            <label class="tools-field">
              <span>排序</span>
              <input v-model.number="form.sort_order" type="number" min="0" />
            </label>
            <label class="tools-field tools-field-check">
              <input v-model="form.pinned" type="checkbox" />
              <span>置顶显示</span>
            </label>
          </div>
          <footer class="tools-editor-foot">
            <button type="button" class="btn btn-outline" @click="closeEditor">取消</button>
            <button type="button" class="btn btn-primary" :disabled="saving || !form.name.trim() || !form.url.trim()" @click="save">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </footer>
        </section>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.tools-page { padding: 24px; max-width: 960px; margin: 0 auto; }
.tools-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
.tools-header h1 { font-size: 20px; font-weight: 700; letter-spacing: -.02em; margin: 0; }
.tools-header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tools-search { display: flex; align-items: center; gap: 6px; padding: 0 10px; height: 36px; border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-pill); background: rgba(255,255,255,.84); }
.tools-search input { border: 0; background: transparent; outline: none; font: var(--ds-type-body); color: var(--ds-color-ink); width: 140px; }
.tools-message { padding: 8px 12px; margin-bottom: 12px; border-radius: 8px; background: var(--ds-color-success-soft); color: var(--ds-color-success); font: var(--ds-type-meta); }
.tools-error { padding: 8px 12px; margin-bottom: 12px; border-radius: 8px; background: var(--ds-color-danger-soft); color: var(--ds-color-danger); font: var(--ds-type-meta); }
.tools-loading { padding: 40px; text-align: center; color: var(--ds-color-ink-secondary); }
.tools-empty { padding: 60px 20px; text-align: center; color: var(--ds-color-ink-secondary); }
.tools-section { margin-bottom: 20px; }
.tools-section-title { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 13px; font-weight: 600; color: var(--ds-color-ink-secondary); }
.tools-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
.tool-card { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border: 1px solid var(--ds-color-border); border-radius: 10px; background: rgba(255,255,255,.92); cursor: pointer; transition: border-color var(--ds-duration-fast) var(--ds-ease-out), box-shadow var(--ds-duration-fast) var(--ds-ease-out); touch-action: manipulation; }
.tool-card:hover { border-color: var(--ds-color-primary-border); box-shadow: 0 2px 8px rgba(75,87,162,.08); }
.tool-card:active { transform: scale(.99); }
.tool-card-pinned { border-color: var(--ds-color-primary-border); background: var(--ds-color-primary-soft); }
.tool-card-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.tool-card-logo { display: grid; place-items: center; flex: 0 0 32px; width: 32px; height: 32px; overflow: hidden; border: 1px solid var(--ds-color-border); border-radius: 9px; background: var(--ds-color-surface); color: var(--tool-logo-color); }
.tool-card-logo img { display: block; width: 22px; height: 22px; object-fit: contain; }
.tool-card-logo-fallback { display: grid; place-items: center; width: 100%; height: 100%; background: color-mix(in srgb, var(--tool-logo-color) 14%, white); color: var(--tool-logo-color); font-size: 14px; font-weight: 700; }
.tool-card-info { min-width: 0; }
.tool-card-info strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.tool-card-domain { font-size: 12px; color: var(--ds-color-ink-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-card-actions { display: flex; gap: 2px; }
.tool-action { display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--ds-color-ink-secondary); cursor: pointer; touch-action: manipulation; }
.tool-action:hover { background: var(--ds-color-surface-subtle); color: var(--ds-color-ink); }
.tool-action:active { transform: scale(.92); }
.tool-action-danger:hover { color: var(--ds-color-danger); }

.tools-scrim { position: fixed; inset: 0; z-index: 500; display: grid; place-items: center; padding: 20px; background: rgba(20,24,38,.28); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.tools-scrim-enter-active, .tools-scrim-leave-active { transition: opacity var(--ds-duration-fast) var(--ds-ease-out); }
.tools-scrim-enter-from, .tools-scrim-leave-to { opacity: 0; }
.tools-editor { width: min(420px, 100%); padding: 22px; border-radius: var(--ds-radius-dialog); background: rgba(255,255,255,.97); box-shadow: var(--ds-shadow-overlay); }
.tools-editor-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.tools-editor-head h2 { font-size: 16px; font-weight: 700; margin: 0; }
.icon-button { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 50%; background: var(--ds-color-surface-subtle); color: var(--ds-color-ink-secondary); cursor: pointer; touch-action: manipulation; }
.icon-button:active { transform: scale(.94); }
.tools-editor-body { display: grid; gap: 14px; }
.tools-field { display: grid; gap: 4px; }
.tools-field > span { font-size: 12px; font-weight: 600; color: var(--ds-color-ink-secondary); }
.tools-field input[type="text"], .tools-field input[type="url"], .tools-field input[type="number"], .tools-field select {
  height: 36px; padding: 0 10px; border: 1px solid var(--ds-color-border); border-radius: 8px; background: rgba(255,255,255,.84);
  font: var(--ds-type-body); color: var(--ds-color-ink); outline: none; transition: border-color var(--ds-duration-fast) var(--ds-ease-out);
}
.tools-field input:focus, .tools-field select:focus { border-color: var(--ds-color-primary); }
.tools-color-row { display: flex; gap: 8px; align-items: center; }
.tools-color-input { width: 36px; height: 36px; padding: 2px; border: 1px solid var(--ds-color-border); border-radius: 8px; background: transparent; cursor: pointer; }
.tools-field-check { flex-direction: row; align-items: center; gap: 8px; }
.tools-field-check input { width: 16px; height: 16px; accent-color: var(--ds-color-primary); }
.tools-editor-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }

@media (max-width: 600px) {
  .tools-page { padding: 16px; }
  .tools-grid { grid-template-columns: 1fr; }
  .tools-search input { width: 100px; }
}
</style>
