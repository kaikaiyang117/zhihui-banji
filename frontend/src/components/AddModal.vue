<script setup>
import { ref, reactive, computed } from 'vue'
import { Download } from 'lucide-vue-next'
import { post, put, get, download, upload } from '../api'

const props = defineProps({
  title: { type: String, default: '添加记录' },
  fields: { type: Array, default: () => [] },   // [{name,label,options?,ph?}]
  sheetName: { type: String, default: '' },      // 填写时走通用 append 接口
  // 学生导入模式：直接上传 Excel
  mode: { type: String, default: 'form' },       // 'form' | 'import' | 'knowledge' | 'student'
  // 编辑模式预填数据
  studentId: { type: Number, default: null },
  studentData: { type: Object, default: null }
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

const studentFields = [
  { name: '学号', label: '学号', ph: '如 2201' },
  { name: '姓名', label: '姓名' },
  { name: '身份证号码', label: '身份证号码' },
  { name: '性别', label: '性别', options: ['男', '女'] },
  { name: '出生年月', label: '出生日期', type: 'date' },
  { name: '民族', label: '民族', options: [
    '汉族','蒙古族','回族','藏族','维吾尔族','苗族','彝族','壮族','布依族','朝鲜族',
    '满族','侗族','瑶族','白族','土家族','哈尼族','哈萨克族','傣族','黎族','傈僳族',
    '佤族','畲族','高山族','拉祜族','水族','东乡族','纳西族','景颇族','柯尔克孜族',
    '土族','达斡尔族','仫佬族','羌族','布朗族','撒拉族','毛南族','仡佬族','锡伯族',
    '阿昌族','普米族','塔吉克族','怒族','乌孜别克族','俄罗斯族','鄂温克族','德昂族',
    '保安族','裕固族','京族','塔塔尔族','独龙族','鄂伦春族','赫哲族','门巴族','珞巴族','基诺族'
  ]},
  { name: '家庭住址', label: '家庭住址' },
  { name: '监护人姓名', label: '监护人1姓名' },
  { name: '监护人电话', label: '监护人1电话' },
  { name: '监护人关系', label: '监护人1关系', options: ['父亲','母亲','爷爷','奶奶','外公','外婆','叔伯','姑姨','其他'] },
  { name: '监护人职业', label: '监护人1职业' },
  { name: '监护人2姓名', label: '监护人2姓名' },
  { name: '监护人2电话', label: '监护人2电话' },
  { name: '监护人2关系', label: '监护人2关系', options: ['父亲','母亲','爷爷','奶奶','外公','外婆','叔伯','姑姨','其他'] },
  { name: '监护人2职业', label: '监护人2职业' },
  { name: '是否住校', label: '是否住校', options: ['住校', '走读'] },
  { name: '特长', label: '特长' },
  { name: '班级任职', label: '班级任职' },
  { name: '备注', label: '备注' },
]

const studentFieldGroups = [
  { title: '基本信息', fields: studentFields.slice(0, 7) },
  { title: '监护人1', fields: studentFields.slice(7, 11) },
  { title: '监护人2', optional: true, fields: studentFields.slice(11, 15) },
  { title: '在校信息', fields: studentFields.slice(15) },
]

const legacyDateValues = {}

function initForm() {
  if (props.mode === 'student') {
    studentFields.forEach(f => {
      const value = props.studentData?.[f.name] || ''
      if (f.type === 'date' && /^\d{4}-\d{2}$/.test(value)) {
        legacyDateValues[f.name] = value
        form[f.name] = ''
      } else {
        form[f.name] = value
      }
    })
  } else {
    props.fields.forEach(f => { form[f.name] = '' })
  }
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
    } else if (props.mode === 'student') {
      const body = {}
      studentFields.forEach(f => {
        body[f.name] = form[f.name] || legacyDateValues[f.name] || ''
      })
      if (props.studentId) {
        const res = await put(`/api/students/${props.studentId}`, body)
        if (res.ok) emit('success')
        else errorMsg.value = res.error || '保存失败'
      } else {
        const res = await post('/api/students', body)
        if (res.ok) emit('success')
        else errorMsg.value = res.error || '保存失败'
      }
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

async function previewImport() {
  const f = fileInput.value?.files?.[0]
  if (!f) { errorMsg.value = '请先选择 Excel 文件'; return }
  submitting.value = true
  errorMsg.value = ''
  try {
    const res = await upload('/api/students/import/preview', f)
    importResult.value = res
    if (res.errors?.length) errorMsg.value = `检查完成，有 ${res.errors.length} 条数据需要修正`
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    submitting.value = false
  }
}

async function commitImport() {
  if (!importResult.value?.rows?.length) return
  submitting.value = true
  errorMsg.value = ''
  try {
    const res = await post('/api/students/import/commit', {
      filename: importResult.value.filename || fileName.value,
      rows: importResult.value.rows,
    })
    if (res.errors?.length) {
      errorMsg.value = `已导入，但有 ${res.errors.length} 条数据未提交`
      importResult.value = { ...importResult.value, commitResult: res }
    } else {
      emit('success')
    }
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
          <button class="btn btn-outline" @click="downloadTemplate"><Download :size="14" :stroke-width="2" /> 下载导入模板</button>
        </div>
        <div class="form-group">
          <label>第二步：选择按模板填好的 Excel 文件</label>
          <input ref="fileInput" type="file" accept=".xlsx,.xls"
            @change="e => fileName = e.target.files[0]?.name || ''">
          <div v-if="fileName" class="hint">已选择：{{ fileName }}</div>
        </div>
        <div v-if="importResult" class="import-result">
          <div class="hint strong">检查结果：新增 {{ importResult.summary?.imported || 0 }} 人 / 更新 {{ importResult.summary?.updated || 0 }} 人 / 可导入 {{ importResult.summary?.valid || 0 }} 人 / 跳过 {{ importResult.summary?.skipped || 0 }} 人</div>
          <div v-if="importResult.rows?.length" class="import-preview">
            <div class="hint">以下为前 {{ Math.min(importResult.rows.length, 8) }} 条待导入记录，确认后才会写入数据库：</div>
            <div class="import-preview-list">
              <span v-for="item in importResult.rows.slice(0, 8)" :key="item.row" class="import-preview-item">
                {{ item.fields['学号'] }} {{ item.fields['姓名'] }} · {{ item.action }}
              </span>
            </div>
          </div>
          <ul v-if="importResult.errors?.length" class="error-list">
            <li v-for="(err, i) in importResult.errors" :key="i">第 {{ err.row }} 行：{{ err.msg }}</li>
          </ul>
          <ul v-if="importResult.commitResult?.errors?.length" class="error-list">
            <li v-for="(err, i) in importResult.commitResult.errors" :key="`commit-${i}`">第 {{ err.row }} 行：{{ err.msg }}</li>
          </ul>
          <div v-if="errorMsg" class="error-text">{{ errorMsg }}</div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="$emit('close')">关闭</button>
          <button v-if="!importResult" class="btn btn-primary" :disabled="submitting" @click="previewImport">
            {{ submitting ? '检查中...' : '检查文件' }}
          </button>
          <button v-else class="btn btn-primary" :disabled="submitting || !importResult.rows?.length" @click="commitImport">
            {{ submitting ? '导入中...' : `确认导入 ${importResult.rows?.length || 0} 条` }}
          </button>
        </div>
      </template>

      <!-- 学生信息编辑模式 -->
      <template v-else-if="mode === 'student'">
        <form @submit.prevent="submit">
          <section v-for="group in studentFieldGroups" :key="group.title" class="student-form-section">
            <div class="student-form-section-head">
              <strong>{{ group.title }}</strong>
              <span v-if="group.optional">可选</span>
            </div>
            <div class="form-row" :class="{ 'guardian-form-row': group.title.startsWith('监护人') }">
              <div v-for="f in group.fields" :key="f.name" class="form-group" style="min-width:160px">
                <label>{{ f.label }}</label>
                <select v-if="f.options" class="form-select" v-model="form[f.name]">
                  <option value="">请选择</option>
                  <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
                </select>
                <input v-else-if="f.type === 'date'" type="date" class="form-input"
                  v-model="form[f.name]">
                <input v-else class="form-input" v-model="form[f.name]" :placeholder="f.ph || ''">
                <small v-if="f.type === 'date' && legacyDateValues[f.name]" class="field-hint">原记录只有年月，请补充具体日期</small>
              </div>
            </div>
          </section>
          <div v-if="errorMsg" class="error-text">{{ errorMsg }}</div>
          <div class="modal-actions">
            <button type="button" class="btn btn-outline" @click="$emit('close')">取消</button>
            <button type="submit" class="btn btn-primary" :disabled="submitting">
              {{ submitting ? '保存中...' : '保存' }}
            </button>
          </div>
        </form>
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

<style scoped>
.student-form-section + .student-form-section {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.student-form-section-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
  color: var(--text);
  font-size: 13px;
}

.student-form-section-head span,
.field-hint {
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 400;
}

.guardian-form-row {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.field-hint {
  display: block;
  margin-top: 4px;
  line-height: 1.4;
}

@media (max-width: 640px) {
  .guardian-form-row {
    grid-template-columns: 1fr;
  }
}
</style>
