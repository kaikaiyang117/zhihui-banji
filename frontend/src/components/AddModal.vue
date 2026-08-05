<script setup>
import { ref, reactive, computed } from 'vue'
import { post, get, download, upload } from '../api'

const props = defineProps({
  title: { type: String, default: '添加记录' },
  fields: { type: Array, default: () => [] },   // [{name,label,options?,ph?}]
  sheetName: { type: String, default: '' },      // 填写时走通用 append 接口
  // 学生导入模式：直接上传 Excel
  mode: { type: String, default: 'form' }        // 'form' | 'import' | 'knowledge'
})
const emit = defineEmits(['success', 'close'])

const form = reactive({})
const submitting = ref(false)
const errorMsg = ref('')

const importResult = ref(null)
const fileInput = ref(null)
const fileName = ref('')

const knowledgeTemplates = ['无模板', '备课笔记', '班会记录', '班主任日志', '学生档案', '考研知识点', '读书笔记']
const importCategories = ['班主任工作', '教学资源', '考研备考', '个人成长', '心理学读书']

function initForm() {
  props.fields.forEach(f => { form[f.name] = '' })
}
initForm()

async function submit() {
  submitting.value = true
  errorMsg.value = ''
  try {
    if (props.mode === 'form') {
      const data = props.fields.map(f => form[f.name] ?? '')
      const res = await post(`/api/sheet/${props.sheetName}/append`, { data })
      if (res.ok) emit('success')
      else errorMsg.value = res.error || '保存失败'
    } else if (props.mode === 'knowledge') {
      const res = await post('/api/knowledge/create', {
        title: form.title || '',
        category: form.category || '个人成长',
        template: form.template === '无模板' ? '' : (form.template || '')
      })
      if (res.ok) { emit('success'); emit('close') }
      else errorMsg.value = res.detail || '创建失败'
    }
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    submitting.value = false
  }
}

async function doImport() {
  const f = fileInput.value?.files?.[0]
  if (!f) { errorMsg.value = '请先选择 Excel 文件'; return }
  submitting.value = true
  errorMsg.value = ''
  try {
    const res = await upload('/api/students/import', f)
    importResult.value = res
    if (res.errors?.length) errorMsg.value = `导入完成，但有 ${res.errors.length} 条错误`
    else errorMsg.value = ''
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    submitting.value = false
  }
}

function downloadTemplate() {
  download('/api/students/template')
}
</script>

<template>
  <div class="modal-overlay show" @click.self="$emit('close')">
    <div class="modal">
      <h3>{{ title }}</h3>

      <!-- 学生导入模式 -->
      <template v-if="mode === 'import'">
        <div class="form-group">
          <label>第一步：下载模板（含列名与示例）</label>
          <button class="btn btn-outline" @click="downloadTemplate">📥 下载导入模板</button>
        </div>
        <div class="form-group">
          <label>第二步：选择按模板填好的 Excel 文件</label>
          <input ref="fileInput" type="file" accept=".xlsx,.xls"
            @change="e => fileName = e.target.files[0]?.name || ''">
          <div v-if="fileName" class="hint">已选择：{{ fileName }}</div>
        </div>
        <div v-if="importResult" class="import-result">
          <div class="hint strong">导入结果：新增 {{ importResult.imported }} 人 / 更新 {{ importResult.updated }} 人 / 跳过 {{ importResult.skipped }} 人</div>
          <ul v-if="importResult.errors?.length" class="error-list">
            <li v-for="(err, i) in importResult.errors" :key="i">第 {{ err.row }} 行：{{ err.msg }}</li>
          </ul>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="$emit('close')">关闭</button>
          <button class="btn btn-primary" :disabled="submitting" @click="doImport">
            {{ submitting ? '导入中...' : '⬆️ 开始导入' }}
          </button>
        </div>
      </template>

      <!-- 知识库模式 -->
      <template v-else-if="mode === 'knowledge'">
        <div class="form-group">
          <label>笔记标题</label>
          <input class="form-input" v-model="form.title" placeholder="输入标题...">
        </div>
        <div class="form-group">
          <label>分类</label>
          <select class="form-select" v-model="form.category">
            <option v-for="c in importCategories" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>模板(可选)</label>
          <select class="form-select" v-model="form.template">
            <option v-for="t in knowledgeTemplates" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="$emit('close')">取消</button>
          <button class="btn btn-primary" :disabled="submitting" @click="submit">
            {{ submitting ? '创建中...' : '创建' }}
          </button>
        </div>
      </template>

      <!-- 通用表单模式 -->
      <template v-else>
        <form @submit.prevent="submit">
          <div class="form-row">
            <div v-for="f in fields" :key="f.name" class="form-group" style="min-width:180px">
              <label>{{ f.label }}</label>
              <select v-if="f.options" class="form-select" v-model="form[f.name]">
                <option value="">请选择</option>
                <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
              </select>
              <input v-else class="form-input" v-model="form[f.name]" :placeholder="f.ph || ''">
            </div>
          </div>
          <div v-if="errorMsg" class="error-text">{{ errorMsg }}</div>
          <div class="modal-actions">
            <button type="button" class="btn btn-outline" @click="$emit('close')">取消</button>
            <button type="submit" class="btn btn-primary" :disabled="submitting">
              {{ submitting ? '保存中...' : '保存' }}
            </button>
          </div>
        </form>
      </template>
    </div>
  </div>
</template>