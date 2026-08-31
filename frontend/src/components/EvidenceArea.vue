<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { ImagePlus, Trash2, X, ZoomIn, Paperclip, Upload, Download, RotateCcw } from 'lucide-vue-next'
import { uploadEvidence, get, del, post, scopedUrl } from '../api'
import { useConfirmDialog } from '../composables/confirmDialog'

const props = defineProps({
  ownerType: { type: String, required: true },
  ownerId: { type: Number, required: true },
  studentId: { type: Number, default: null }
})
const emit = defineEmits(['counts-updated'])

const { confirm: confirmDialog } = useConfirmDialog()

const EVIDENCE_KIND_OPTIONS = ['请假凭证', '沟通截图', '现场照片', '证明材料']

const items = ref([])
const loading = ref(true)
const error = ref('')
const uploading = ref(false)
const previewFiles = ref([])
const previewKinds = ref([])
const lightboxItem = ref(null)
const deleteTarget = ref(null)
const deleting = ref(false)
const restoring = ref({})
const dragActive = ref(false)
const fileInput = ref(null)

const count = computed(() => items.value.filter(i => !i.deleted_at).length)

async function load() {
  if (!props.ownerId) return
  loading.value = true
  error.value = ''
  try {
    const data = await get(`/api/evidence/${props.ownerType}/${props.ownerId}?include_deleted=true`)
    items.value = data.items || data || []
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function doUpload() {
  if (!previewFiles.value.length) return
  uploading.value = true
  error.value = ''
  try {
    for (let i = 0; i < previewFiles.value.length; i++) {
      const fd = new FormData()
      fd.append('file', previewFiles.value[i])
      fd.append('owner_type', props.ownerType)
      fd.append('owner_id', String(props.ownerId))
      if (props.studentId) fd.append('student_id', String(props.studentId))
      fd.append('evidence_kind', previewKinds.value[i] || '请假凭证')
      await uploadEvidence(fd)
    }
    previewFiles.value = []
    previewKinds.value = []
    await load()
    emit('counts-updated')
  } catch (e) {
    error.value = e.message
  } finally {
    uploading.value = false
  }
}

function pickFiles(event) {
  const files = event.target.files
  if (!files?.length) return
  addPreviewFiles(files)
  event.target.value = ''
}

function addPreviewFiles(fileList) {
  for (const file of fileList) {
    if (!file.type.match(/^image\/(jpeg|png|webp)$/)) continue
    previewFiles.value.push(file)
    previewKinds.value.push(props.ownerType === 'attendance' ? '请假凭证' : '沟通截图')
  }
}

function removePreview(index) {
  previewFiles.value.splice(index, 1)
  previewKinds.value.splice(index, 1)
}

function onDragOver(event) {
  event.preventDefault()
  dragActive.value = true
}

function onDragLeave() {
  dragActive.value = false
}

function onDrop(event) {
  event.preventDefault()
  dragActive.value = false
  const files = event.dataTransfer?.files
  if (files?.length) addPreviewFiles(files)
}

async function onPaste(event) {
  const files = event.clipboardData?.files
  if (files?.length) addPreviewFiles(files)
}

function openLightbox(item) {
  lightboxItem.value = item
}

function closeLightbox() {
  lightboxItem.value = null
}

function startDelete(item) {
  deleteTarget.value = item
}

function cancelDelete() {
  deleteTarget.value = null
}

async function confirmDelete() {
  deleting.value = true
  try {
    await del(`/api/evidence/${deleteTarget.value.id}`, {})
    await load()
    emit('counts-updated')
  } catch (e) {
    error.value = e.message
  } finally {
    deleting.value = false
    deleteTarget.value = null
  }
}

async function restoreItem(item) {
  restoring.value[item.id] = true
  try {
    await post(`/api/evidence/${item.id}/restore`)
    await load()
    emit('counts-updated')
  } catch (e) {
    error.value = e.message
  } finally {
    restoring.value[item.id] = false
  }
}

function thumbnailUrl(item) {
  return scopedUrl(`/api/evidence/thumbnail/${item.id}`)
}

function originalUrl(item) {
  return scopedUrl(`/api/evidence/file/${item.id}`)
}

function downloadUrl(item) {
  return scopedUrl(`/api/evidence/file/${item.id}`)
}

function kindLabel(kind) {
  const labels = { '请假凭证': '请假凭证', '沟通截图': '沟通截图', '现场照片': '现场照片', '证明材料': '证明材料' }
  return labels[kind] || kind || '附件'
}

function channelLabel(channel) {
  const labels = { web: '网页', wechat: '微信', desktop: '桌面' }
  return labels[channel] || channel || ''
}

function formatTime(timeStr) {
  if (!timeStr) return ''
  return timeStr.replace('T', ' ').slice(0, 16)
}

function fileThumb(file) {
  if (file.type?.match(/^image\/(jpeg|png|webp)$/)) return URL.createObjectURL(file)
  return ''
}

watch(() => [props.ownerType, props.ownerId], load)
onMounted(() => {
  load()
  document.addEventListener('paste', onPaste)
})
onBeforeUnmount(() => {
  document.removeEventListener('paste', onPaste)
})
</script>

<template>
  <section class="evidence-area" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <div class="evidence-header">
      <h3><Paperclip :size="15" /> 凭证与附件 <span v-if="count" class="evidence-count-badge">{{ count }}</span></h3>
      <button class="btn btn-outline btn-sm" @click="fileInput?.click()"><Upload :size="13" /> 上传</button>
      <input ref="fileInput" type="file" multiple accept="image/jpeg,image/png,image/webp" hidden @change="pickFiles">
    </div>

    <div v-if="error" class="evidence-error">{{ error }}</div>

    <div v-if="loading" class="evidence-loading">加载中…</div>

    <div v-else-if="!items.length && !previewFiles.length" class="evidence-empty" @click="fileInput?.click()">
      <ImagePlus :size="22" />
      <span>尚无凭证，点击或拖拽上传</span>
    </div>

    <template v-else>
      <div v-if="previewFiles.length" class="evidence-preview-strip">
        <div v-for="(file, idx) in previewFiles" :key="idx" class="evidence-preview-item">
          <img v-if="fileThumb(file)" :src="fileThumb(file)" class="evidence-thumb" />
          <div v-else class="evidence-thumb evidence-thumb-file"><Paperclip :size="18" /></div>
          <select v-model="previewKinds[idx]" class="evidence-kind-select">
            <option v-for="k in EVIDENCE_KIND_OPTIONS" :key="k" :value="k">{{ k }}</option>
          </select>
          <button class="evidence-preview-remove" @click="removePreview(idx)"><X :size="12" /></button>
        </div>
        <button class="btn btn-primary btn-sm evidence-confirm-upload" :disabled="uploading" @click="doUpload">
          {{ uploading ? '上传中…' : `确认上传 ${previewFiles.length} 个文件` }}
        </button>
      </div>

      <div v-if="items.length" class="evidence-grid">
        <div v-for="item in items" :key="item.id" class="evidence-item" :class="{ 'evidence-item-deleted': item.deleted_at }">
          <div class="evidence-thumb-wrap" @click="!item.deleted_at && openLightbox(item)">
            <img v-if="item.mime_type?.startsWith('image/')" :src="thumbnailUrl(item)" class="evidence-thumb" loading="lazy" />
            <div v-else class="evidence-thumb evidence-thumb-file"><Paperclip :size="18" /></div>
            <ZoomIn v-if="!item.deleted_at && item.mime_type?.startsWith('image/')" :size="14" class="evidence-zoom-icon" />
            <span v-if="item.deleted_at" class="evidence-deleted-badge">已删除</span>
          </div>
          <button v-if="!item.deleted_at" class="evidence-delete-btn" @click="startDelete(item)" aria-label="删除凭证"><Trash2 :size="13" /></button>
          <button v-if="item.deleted_at" class="evidence-restore-btn" :disabled="restoring[item.id]" @click="restoreItem(item)" aria-label="恢复凭证"><RotateCcw :size="13" /></button>
        </div>
      </div>
    </template>

    <div v-if="deleteTarget" class="evidence-delete-overlay" @click.self="cancelDelete">
      <div class="evidence-delete-dialog">
        <h4>删除凭证</h4>
        <p>删除后凭证将标记为已删除，确定要删除吗？</p>
        <div class="evidence-delete-actions">
          <button class="btn btn-outline" @click="cancelDelete">取消</button>
          <button class="btn btn-primary" :disabled="deleting" @click="confirmDelete">{{ deleting ? '删除中…' : '确认删除' }}</button>
        </div>
      </div>
    </div>

    <div v-if="lightboxItem" class="evidence-lightbox" @click.self="closeLightbox">
      <button class="evidence-lightbox-close" @click="closeLightbox"><X :size="20" /></button>
      <img :src="originalUrl(lightboxItem)" class="evidence-lightbox-img" />
      <div class="evidence-lightbox-meta">
        <span>{{ kindLabel(lightboxItem.evidence_kind) }}</span>
        <span>{{ formatTime(lightboxItem.created_at) }}</span>
        <span v-if="lightboxItem.note">{{ lightboxItem.note }}</span>
        <a :href="downloadUrl(lightboxItem)" :download="lightboxItem.original_name || '凭证'" class="evidence-lightbox-download"><Download :size="14" /> 下载</a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.evidence-area { display: grid; gap: var(--ds-space-3); }
.evidence-header { display: flex; align-items: center; gap: var(--ds-space-2); }
.evidence-header h3 { display: flex; align-items: center; gap: var(--ds-space-2); margin: 0; color: var(--ds-color-ink); font: var(--ds-type-section); }
.evidence-count-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: var(--ds-radius-pill); background: var(--ds-color-primary); color: #fff; font: var(--ds-type-meta); font-variant-numeric: tabular-nums; }
.evidence-error { color: var(--ds-color-danger); font: var(--ds-type-meta); }
.evidence-loading { color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.evidence-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--ds-space-2); padding: var(--ds-space-6); border: 2px dashed var(--ds-color-border); border-radius: var(--ds-radius-control); background: var(--ds-color-surface-subtle); color: var(--ds-color-ink-secondary); font: var(--ds-type-body); cursor: pointer; transition: border-color var(--ds-duration-fast) var(--ds-ease-out); }
.evidence-empty:hover { border-color: var(--ds-color-primary-border); color: var(--ds-color-primary-hover); }
.evidence-preview-strip { display: flex; flex-wrap: wrap; gap: var(--ds-space-2); align-items: center; padding: var(--ds-space-3); border: 1px solid var(--ds-color-primary-border); border-radius: var(--ds-radius-control); background: var(--ds-color-primary-soft); }
.evidence-preview-item { position: relative; display: grid; gap: 4px; }
.evidence-preview-item .evidence-thumb { width: 48px; height: 48px; object-fit: cover; border-radius: var(--ds-radius-sm); }
.evidence-kind-select { width: 48px; font-size: 9px; padding: 1px 2px; border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-sm); background: var(--ds-color-surface); color: var(--ds-color-ink); }
.evidence-preview-remove { position: absolute; top: -6px; right: -6px; display: grid; place-items: center; width: 20px; height: 20px; border: 0; border-radius: var(--ds-radius-pill); background: var(--ds-color-danger); color: #fff; cursor: pointer; }
.evidence-confirm-upload { margin-left: auto; }
.evidence-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: var(--ds-space-3); }
.evidence-item { position: relative; display: block; padding: 0; border: 0; border-radius: var(--ds-radius-control); background: transparent; }
.evidence-item-deleted { opacity: .5; }
.evidence-thumb-wrap { position: relative; cursor: pointer; border: 1px solid var(--ds-color-border); border-radius: var(--ds-radius-control); overflow: hidden; background: var(--ds-color-surface); }
.evidence-thumb { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; background: var(--ds-color-surface-subtle); }
.evidence-thumb-file { display: grid; place-items: center; aspect-ratio: 1; background: var(--ds-color-surface-subtle); color: var(--ds-color-ink-secondary); }
.evidence-zoom-icon { position: absolute; bottom: 4px; right: 4px; color: #fff; filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
.evidence-deleted-badge { position: absolute; right: 6px; bottom: 6px; padding: 2px 6px; border-radius: var(--ds-radius-pill); background: rgba(255,255,255,.9); color: var(--ds-color-danger); font: var(--ds-type-meta); font-weight: 600; }
.evidence-delete-btn, .evidence-restore-btn { position: absolute; top: 4px; right: 4px; display: grid; place-items: center; width: 24px; height: 24px; border: 0; border-radius: var(--ds-radius-sm); background: var(--ds-color-surface); color: var(--ds-color-ink-secondary); cursor: pointer; opacity: 0; transition: opacity var(--ds-duration-fast) var(--ds-ease-out); }
.evidence-item:hover .evidence-delete-btn, .evidence-item:hover .evidence-restore-btn { opacity: 1; }
.evidence-delete-btn:hover { background: var(--ds-color-danger-soft); color: var(--ds-color-danger); }
.evidence-restore-btn:hover { background: var(--ds-color-primary-soft); color: var(--ds-color-primary); }
.evidence-restore-btn:disabled { opacity: .5; cursor: not-allowed; }
.evidence-delete-overlay { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: rgba(0,0,0,.4); }
.evidence-delete-dialog { width: min(360px, 90vw); padding: var(--ds-space-5); border-radius: var(--ds-radius-card); background: var(--ds-color-surface); box-shadow: var(--ds-shadow-overlay); }
.evidence-delete-dialog h4 { margin: 0 0 var(--ds-space-2); color: var(--ds-color-ink); font: var(--ds-type-section); }
.evidence-delete-dialog p { margin: 0 0 var(--ds-space-3); color: var(--ds-color-ink-secondary); font: var(--ds-type-meta); }
.evidence-delete-actions { display: flex; justify-content: flex-end; gap: var(--ds-space-2); margin-top: var(--ds-space-3); }
.evidence-lightbox { position: fixed; inset: 0; z-index: 101; display: grid; place-items: center; background: rgba(0,0,0,.85); cursor: pointer; }
.evidence-lightbox-close { position: absolute; top: 16px; right: 16px; display: grid; place-items: center; width: 40px; height: 40px; border: 0; border-radius: var(--ds-radius-control); background: rgba(255,255,255,.15); color: #fff; cursor: pointer; }
.evidence-lightbox-img { max-width: 90vw; max-height: 80vh; object-fit: contain; border-radius: var(--ds-radius-sm); }
.evidence-lightbox-meta { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: var(--ds-space-3); padding: var(--ds-space-2) var(--ds-space-3); border-radius: var(--ds-radius-control); background: rgba(0,0,0,.6); color: #fff; font: var(--ds-type-meta); }
.evidence-lightbox-download { display: inline-flex; align-items: center; gap: 4px; color: #fff; text-decoration: none; }
.evidence-lightbox-download:hover { text-decoration: underline; }
.btn-sm { min-height: 30px; padding: 0 var(--ds-space-3); font-size: 12px; }
</style>
