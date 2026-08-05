<script setup>
import { ref, reactive, computed } from 'vue'
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
  { name: '性别', label: '性别', options: ['男', '女'] },
  { name: '出生年月', label: '出生年月', type: 'month' },
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
  { name: '监护人职业', label: '监护人1职业' },
  { name: '监护人2姓名', label: '监护人2姓名' },
  { name: '监护人2电话', label: '监护人2电话' },
  { name: '监护人2关系', label: '监护人2关系', options: ['父亲','母亲','爷爷','奶奶','外公','外婆','叔伯','姑姨','其他'] },
  { name: '是否住校', label: '是否住校', options: ['住校', '走读'] },
  { name: '特长', label: '特长' },
  { name: '班级任职', label: '班级任职' },
  { name: '备注', label: '备注' },
]

function initForm() {
  if (props.mode === 'student') {
    studentFields.forEach(f => { form[f.name] = props.studentData?.[f.name] || '' })
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
      studentFields.forEach(f => { body[f.name] = form[f.name] ?? '' })
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

      <!-- 学生信息编辑模式 -->
      <template v-else-if="mode === 'student'">
        <form @submit.prevent="submit">
          <div class="form-row">
            <div v-for="f in studentFields" :key="f.name" class="form-group" style="min-width:160px">
              <label>{{ f.label }}</label>
              <select v-if="f.options" class="form-select" v-model="form[f.name]">
                <option value="">请选择</option>
                <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
              </select>
              <input v-else-if="f.type === 'month'" type="month" class="form-input"
                v-model="form[f.name]">
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