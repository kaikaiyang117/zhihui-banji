<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Activity, AlertTriangle, ArrowLeft, ArrowUpRight, CalendarCheck, Camera, ChevronLeft, ChevronRight, ClipboardList, FileText, Flag, MessageCircle, Pencil, Plus, Tag, Trash2, UserRound, TrendingUp, X, Star } from 'lucide-vue-next'
import { del, get, upload } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'
import AddModal from '../components/AddModal.vue'
import { useConfirmDialog } from '../composables/confirmDialog'

const route = useRoute()
const router = useRouter()
const data = ref(null)
const students = ref([])
const loading = ref(true)
const errorMsg = ref('')
const modalMode = ref(null)
const showEdit = ref(false)
const photoInput = ref(null)
const photoBusy = ref(false)
const photoError = ref('')
const photoVersion = ref(0)
const photoBroken = ref(false)
const showPhotoPreview = ref(false)
const { confirm: confirmDialog } = useConfirmDialog()

const studentIndex = computed(() => students.value.findIndex(item => Number(item.id) === Number(data.value?.student?.id)))
const previousStudent = computed(() => studentIndex.value > 0 ? students.value[studentIndex.value - 1] : null)
const nextStudent = computed(() => studentIndex.value >= 0 && studentIndex.value < students.value.length - 1
  ? students.value[studentIndex.value + 1]
  : null)
const activeTasks = computed(() => (data.value?.tasks || []).filter(item => !['已完成', '已取消'].includes(item.status)))
const activeFocus = computed(() => (data.value?.focus || []).filter(item => item.status !== '已结束'))
const recentAttendance = computed(() => (data.value?.attendance || []).slice(0, 5))
const attendanceExceptions = computed(() => (data.value?.attendance || []).filter(item => ['迟到', '早退', '请假', '缺勤'].includes(item.status)))
const recentAttendanceRisks = computed(() => recentAttendance.value.filter(item => ['迟到', '早退', '请假', '缺勤'].includes(item.status)))
const normalAttendanceCount = computed(() => (data.value?.attendance || []).filter(item => item.status === '出勤').length)
const latestAttendanceException = computed(() => attendanceExceptions.value[0] || null)
const timelineItems = computed(() => {
  const raw = (data.value?.timeline || []).filter(item => !(item.kind === 'attendance' && item.status === '出勤'))
  const grouped = new Map()
  const otherItems = []
  for (const item of raw) {
    if (item.kind !== 'attendance' || item.title.startsWith('考勤异常 · ')) {
      otherItems.push(item)
      continue
    }
    const status = item.status || item.title.split('·').at(-1)?.trim() || '异常'
    if (!grouped.has(status)) grouped.set(status, [])
    grouped.get(status).push(item)
  }
  for (const [status, items] of grouped) {
    items.sort((left, right) => String(right.at || '').localeCompare(String(left.at || '')))
    const latest = items[0]
    const dates = items.slice(0, 4).map(item => item.at).filter(Boolean)
    otherItems.push(items.length === 1
      ? { ...latest, title: `考勤异常 · ${status}` }
      : {
          ...latest,
          id: `attendance-${status}`,
          title: `考勤异常 · ${status}`,
          summary: `共 ${items.length} 次，最近一次 ${latest.at}：${latest.summary || '无备注'}；记录日期：${dates.join('、')}${items.length > dates.length ? '…' : ''}`,
          status: `${items.length} 次`,
        })
  }
  return otherItems.sort((left, right) => String(right.at || '').localeCompare(String(left.at || '')))
})
const recentChanges = computed(() => timelineItems.value.slice(0, 3))
const comparableExams = computed(() => (data.value?.score_summary?.exams || []).filter(item => item.total !== null && item.total !== undefined))
const latestExam = computed(() => comparableExams.value.at(-1) || null)
const previousExam = computed(() => comparableExams.value.at(-2) || null)
const scoreChange = computed(() => latestExam.value && previousExam.value ? latestExam.value.total - previousExam.value.total : null)
const editData = computed(() => {
  const student = data.value?.student || {}
  return {
    '学号': student['学号'] ?? '', '姓名': student['姓名'] ?? '', '性别': student['性别'] ?? '',
    '出生年月': student['出生年月'] ?? '', '民族': student['民族'] ?? '', '家庭住址': student['家庭住址'] ?? '',
    '监护人姓名': student['监护人姓名'] ?? '', '监护人电话': student['监护人电话'] ?? '',
    '监护人关系': student['监护人关系'] ?? '',
    '监护人职业': student['监护人职业'] ?? '', '是否住校': student['是否住校'] ?? '',
    '特长': student['特长'] ?? '', '班级任职': student['班级任职'] ?? '', '备注': student['备注'] ?? '',
    '监护人2姓名': student['监护人2姓名'] ?? '', '监护人2电话': student['监护人2电话'] ?? '',
    '监护人2关系': student['监护人2关系'] ?? '', '监护人2职业': student['监护人2职业'] ?? '',
  }
})
const photoUrl = computed(() => {
  const url = data.value?.student?.photo_url
  return url && !photoBroken.value ? `${url}?v=${photoVersion.value}` : ''
})

async function load() {
  loading.value = true
  errorMsg.value = ''
  photoBroken.value = false
  showPhotoPreview.value = false
  try {
    const [detail, directory] = await Promise.all([
      get(`/api/students/${route.params.id}/detail`),
      get('/api/students'),
    ])
    data.value = detail
    students.value = directory.students || []
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    loading.value = false
  }
}

function saved() {
  modalMode.value = null
  load()
}

function goBack() {
  router.push('/students')
}

function switchStudent(student) {
  if (student) router.push(`/student/${student.id}`)
}

function choosePhoto() {
  photoInput.value?.click()
}

function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const sourceUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      const size = Math.min(image.naturalWidth, image.naturalHeight)
      const sx = (image.naturalWidth - size) / 2
      const sy = (image.naturalHeight - size) / 2
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 640
      canvas.getContext('2d').drawImage(image, sx, sy, size, size, 0, 0, 640, 640)
      canvas.toBlob(blob => {
        URL.revokeObjectURL(sourceUrl)
        if (!blob) { reject(new Error('照片处理失败')); return }
        resolve(new File([blob], 'student-photo.jpg', { type: 'image/jpeg' }))
      }, 'image/jpeg', 0.82)
    }
    image.onerror = () => { URL.revokeObjectURL(sourceUrl); reject(new Error('无法读取这张图片')) }
    image.src = sourceUrl
  })
}

async function uploadPhoto(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  photoBusy.value = true
  photoError.value = ''
  try {
    const prepared = await compressPhoto(file)
    const result = await upload(`/api/students/${data.value.student.id}/photo`, prepared)
    data.value.student.photo_url = result.photo_url
    photoBroken.value = false
    photoVersion.value += 1
  } catch (e) {
    photoError.value = e.message
  } finally {
    photoBusy.value = false
  }
}

async function removePhoto() {
  if (!photoUrl.value || !(await confirmDialog({ title: '移除学生照片？', message: '移除后可以重新上传照片。', confirmText: '移除照片' }))) return
  photoBusy.value = true
  photoError.value = ''
  try {
    await del(`/api/students/${data.value.student.id}/photo`)
    data.value.student.photo_url = ''
    photoBroken.value = false
    showPhotoPreview.value = false
  } catch (e) {
    photoError.value = e.message
  } finally {
    photoBusy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div v-if="loading" class="loading">正在打开学生档案…</div>
  <div v-else-if="errorMsg" class="empty-state"><div>{{ errorMsg }}</div><button class="btn btn-outline" @click="goBack">返回学生列表</button></div>
  <div v-else-if="data" class="student-detail-page">
    <div class="page-title-bar">
      <div>
        <button class="back-button" @click="goBack"><ArrowLeft :size="16" /> 学生列表</button>
        <div class="page-title">{{ data.student.姓名 || '未命名学生' }}</div>
        <div class="page-subtitle">{{ data.student.学号 || '暂无学号' }} · {{ data.student.班级任职 || '班级成员' }}</div>
      </div>
      <div class="student-detail-toolbar">
        <div v-if="students.length" class="student-switcher" aria-label="切换学生">
          <button class="icon-button" :disabled="!previousStudent" title="上一位学生" aria-label="上一位学生" @click="switchStudent(previousStudent)"><ChevronLeft :size="16" /></button>
          <span>{{ studentIndex + 1 }} / {{ students.length }}</span>
          <button class="icon-button" :disabled="!nextStudent" title="下一位学生" aria-label="下一位学生" @click="switchStudent(nextStudent)"><ChevronRight :size="16" /></button>
        </div>
        <button class="btn btn-outline" @click="showEdit = true"><Pencil :size="14" /> 编辑资料</button>
        <button class="btn btn-primary" @click="modalMode = 'event'"><Plus :size="14" /> 记录事件</button>
        <button class="btn btn-outline" @click="modalMode = 'comm'"><MessageCircle :size="14" /> 家校沟通</button>
      </div>
    </div>

    <div class="student-hero card">
      <input ref="photoInput" class="photo-input" type="file" accept="image/jpeg,image/png,image/webp" @change="uploadPhoto">
      <div class="student-photo-block">
        <button class="student-avatar" :class="{ 'has-photo': photoUrl }" type="button" :aria-label="photoUrl ? '查看学生照片' : '添加学生照片'" @click="photoUrl ? showPhotoPreview = true : choosePhoto()">
          <img v-if="photoUrl" :src="photoUrl" :alt="`${data.student.姓名}的照片`" @error="photoBroken = true">
          <UserRound v-else :size="24" />
        </button>
        <button class="student-avatar-edit" type="button" :disabled="photoBusy" :aria-label="photoUrl ? '更换学生照片' : '添加学生照片'" :title="photoUrl ? '更换照片' : '添加照片'" @click="choosePhoto"><Camera :size="13" /></button>
      </div>
      <div class="student-photo-copy">
        <button class="photo-action" type="button" :disabled="photoBusy" @click="choosePhoto">{{ photoBusy ? '处理中…' : photoUrl ? '更换照片' : '添加照片' }}</button>
        <button v-if="photoUrl" class="photo-remove" type="button" :disabled="photoBusy" @click="removePhoto"><Trash2 :size="12" /> 移除</button>
        <span>支持 JPG、PNG、WebP，自动裁剪为方形</span>
        <small v-if="photoError">{{ photoError }}</small>
      </div>
      <div class="student-hero-info">
        <div class="student-hero-name">{{ data.student.姓名 }}</div>
        <div class="student-hero-meta">{{ data.student.性别 || '性别未填' }} · {{ data.student.是否住校 || '住宿未填' }} · {{ data.student.特长 || '暂无特长记录' }}</div>
      </div>
      <div class="student-hero-status">
        <div><span>当前风险</span><strong class="student-risk-value" :class="`risk-text-${data.insights.risk_level}`">{{ data.insights.risk_level }}</strong></div>
        <div><span>未完成行动</span><strong>{{ activeTasks.length }} 项</strong></div>
        <div><span>最近异常</span><strong>{{ latestAttendanceException?.status || '暂无' }}</strong></div>
      </div>
      <div class="student-hero-actions">
        <button class="soft-action" @click="modalMode = 'task'"><ClipboardList :size="16" /> 新建待办</button>
        <button class="soft-action" @click="modalMode = 'focus'"><Tag :size="16" /> 添加关注</button>
      </div>
    </div>

    <div v-if="showPhotoPreview && photoUrl" class="photo-preview-overlay" @click.self="showPhotoPreview = false">
      <div class="photo-preview-card" role="dialog" aria-label="学生照片预览">
        <button class="photo-preview-close" type="button" aria-label="关闭照片预览" @click="showPhotoPreview = false"><X :size="18" /></button>
        <img :src="photoUrl" :alt="`${data.student.姓名}的照片`">
        <div><strong>{{ data.student.姓名 }}</strong><span>{{ data.student.学号 || '暂无学号' }}</span></div>
      </div>
    </div>

    <div class="student-priority-grid">
      <router-link class="student-priority-card" :to="{ path: '/scores', query: { student_id: data.student.id } }">
        <span>最新成绩</span>
        <strong>{{ latestExam?.total ?? '—' }}<small v-if="latestExam">分</small></strong>
        <em>{{ latestExam?.exam_name || '暂无完整考试记录' }}<template v-if="scoreChange !== null"> · {{ scoreChange > 0 ? '较上次上升' : scoreChange < 0 ? '较上次下降' : '较上次持平' }} {{ Math.abs(scoreChange) }} 分</template></em>
        <ArrowUpRight :size="14" />
      </router-link>
      <router-link class="student-priority-card" :class="{ warning: recentAttendanceRisks.length }" to="/attendance">
        <span>最近考勤</span>
        <strong>{{ recentAttendance.length ? recentAttendanceRisks.length : '—' }}<small v-if="recentAttendance.length"> / {{ recentAttendance.length }} 次异常</small></strong>
        <em>{{ recentAttendance.length ? '最近 5 次记录' : '暂无考勤记录' }}</em>
        <ArrowUpRight :size="14" />
      </router-link>
      <router-link class="student-priority-card" :class="{ warning: activeTasks.length }" to="/tasks">
        <span>待处理事项</span>
        <strong>{{ activeTasks.length }}</strong>
        <em>{{ activeTasks.length ? '需要继续跟进' : '当前没有未完成事项' }}</em>
        <ArrowUpRight :size="14" />
      </router-link>
      <router-link class="student-priority-card" :to="{ path: '/parent-comm', query: { student_id: data.student.id } }">
        <span>最近家校沟通</span>
        <strong>{{ data.communications.length || '—' }}</strong>
        <em>{{ data.communications[0]?.communicated_at || '还没有沟通记录' }}</em>
        <ArrowUpRight :size="14" />
      </router-link>
    </div>

    <section class="student-insights" aria-labelledby="student-insights-title">
      <div class="section-heading">
        <div><h2 id="student-insights-title">学生当前状态</h2><p>风险、变化和下一步行动来自当前班级与学期数据</p></div>
      </div>
      <div class="student-insight-grid">
        <article class="insight-card risk" :class="`risk-${data.insights.risk_level}`">
          <div class="insight-title"><AlertTriangle :size="16" /> 当前风险 <span>{{ data.insights.risk_level }}</span></div>
          <ul><li v-for="reason in data.insights.risk_reasons" :key="reason">{{ reason }}</li></ul>
          <router-link class="insight-link" to="/attendance">查看考勤</router-link>
        </article>
        <article class="insight-card">
          <div class="insight-title"><ClipboardList :size="16" /> 未完成行动 <span>{{ data.insights.open_actions.length }}</span></div>
          <div v-if="!data.insights.open_actions.length" class="insight-empty">当前没有未完成行动</div>
          <router-link v-for="task in data.insights.open_actions.slice(0, 3)" :key="task.id" :to="{ path: '/tasks', query: { bucket: 'open', task: task.id, action: 'edit' } }" class="insight-row">
            <strong>{{ task.title }}</strong><span>{{ task.timing_state }} · {{ task.due_at || '未设截止日期' }}</span>
          </router-link>
          <router-link class="insight-link" to="/tasks">打开待办</router-link>
        </article>
        <article class="insight-card">
          <div class="insight-title"><Activity :size="16" /> 最近变化</div>
          <div v-if="!recentChanges.length" class="insight-empty">还没有可归纳的变化记录</div>
          <div v-for="item in recentChanges" :key="`${item.kind}-${item.id}`" class="insight-row">
            <strong>{{ item.title }}</strong><span>{{ item.at }} · {{ item.status }}</span>
          </div>
          <router-link class="insight-link" :to="{ path: '/events', query: { student_id: data.student.id } }">查看事件</router-link>
        </article>
        <article class="insight-card conclusion">
          <div class="insight-title"><Flag :size="16" /> 阶段结论</div>
          <p>{{ data.insights.stage_conclusion }}</p>
        </article>
      </div>
    </section>

    <div class="student-detail-grid">
      <div class="card">
        <div class="card-title">成长时间线 <span class="count">{{ timelineItems.length }} 条重要记录</span></div>
        <div v-if="!timelineItems.length" class="empty-state compact-empty">还没有重要成长记录，先记录一次事件吧</div>
        <div v-else class="timeline">
          <div v-for="item in timelineItems" :key="`${item.kind}-${item.id}`" class="timeline-item">
            <div class="timeline-dot" :class="`timeline-${item.kind}`"></div>
            <div class="timeline-main">
              <div class="timeline-head"><strong>{{ item.title }}</strong><span>{{ item.at }}</span></div>
              <div class="timeline-summary">{{ item.summary }}</div>
              <span class="tag" :class="item.status === '已完成' || item.status === '出勤' ? 'tag-green' : 'tag-orange'">{{ item.status }}</span>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card-title">当前待办 <span class="count">{{ activeTasks.length }}</span><router-link class="card-action" to="/tasks">打开 <ArrowUpRight :size="13" /></router-link></div>
          <div v-if="!activeTasks.length" class="empty-state compact-empty">暂无待办</div>
          <div v-for="task in activeTasks.slice(0, 5)" :key="task.id" class="task-row">
            <div class="task-priority" :class="`priority-${task.priority}`"></div>
            <div class="task-copy"><strong>{{ task.title }}</strong><span>{{ task.due_at || '未设置日期' }} · {{ task.status }}</span></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">关注事项 <span class="count">{{ activeFocus.length }}</span><router-link class="card-action" to="/special">打开 <ArrowUpRight :size="13" /></router-link></div>
          <div v-if="!activeFocus.length" class="empty-state compact-empty">暂无关注事项</div>
          <div v-for="item in activeFocus.slice(0, 4)" :key="item.id" class="focus-row">
            <div><strong>{{ item.topic }}</strong><div class="hint">{{ item.reason }}</div></div>
            <span class="tag" :class="item.status === '已结束' ? 'tag-green' : 'tag-orange'">{{ item.status }}</span>
          </div>
        </div>
        <div class="card">
          <div class="card-title"><FileText :size="16" /> 学生评语 <span class="count">{{ data.comments_summary.comments.length }}</span></div>
          <div v-if="!data.comments_summary.comments.length" class="empty-state compact-empty">暂无评语记录</div>
          <div v-for="item in data.comments_summary.comments.slice(0, 3)" :key="item.id" class="comment-summary-row">
            <div><strong>{{ item.comment_type }}</strong><span>{{ item.status }} · {{ item.updated_at || item.created_at }}</span></div>
            <p>{{ item.content }}</p>
          </div>
          <router-link v-if="data.comments_summary.comments.length" :to="{ path: '/comments', query: { student_id: data.student.id } }" class="detail-link">查看全部评语</router-link>
        </div>
      </div>
    </div>

    <div class="student-attendance-summary card">
      <div class="card-title"><CalendarCheck :size="16" /> 考勤摘要 <span class="count">{{ data.attendance.length }} 条记录</span><router-link class="card-action" to="/attendance">查看考勤 <ArrowUpRight :size="13" /></router-link></div>
      <div class="attendance-summary-grid">
        <div><span>正常出勤</span><strong>{{ normalAttendanceCount }}</strong><small>条记录</small></div>
        <div class="warning"><span>异常考勤</span><strong>{{ attendanceExceptions.length }}</strong><small>迟到、早退、请假或缺勤</small></div>
        <div><span>最近异常</span><strong>{{ latestAttendanceException?.status || '暂无' }}</strong><small>{{ latestAttendanceException?.date || '当前没有异常记录' }}</small></div>
      </div>
    </div>

    <div class="student-detail-grid">
      <div class="card">
        <div class="card-title"><TrendingUp :size="16" /> 成绩趋势</div>
        <p class="chart-text-summary">{{ data.score_summary.text_summary }}</p>
        <div v-if="!data.score_summary.exams.length" class="empty-state compact-empty">暂无结构化成绩记录</div>
        <div v-for="exam in data.score_summary.exams" :key="`${exam.exam_name}-${exam.exam_date}`" class="score-summary-row">
          <div><strong>{{ exam.exam_name }}</strong><span>{{ exam.exam_date || '日期未填' }}</span></div><strong>{{ exam.total }} 分</strong>
        </div>
      </div>
      <div class="card">
        <div class="card-title"><Star :size="16" /> 行为积分</div>
        <p class="chart-text-summary">{{ data.points_summary.text_summary }}</p>
        <div class="points-total">{{ data.points_summary.total }}<small>当前学期行为积分</small></div>
        <div class="weekly-points"><span v-for="(point, index) in data.points_summary.weekly" :key="index"><i :style="{ height: `${Math.max(4, Math.min(60, Number(point) || 0))}px` }"></i><small>W{{ index + 1 }}</small></span></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">基础信息</div>
      <div class="profile-grid">
        <div><span>性别</span><strong>{{ data.student.性别 || '—' }}</strong></div>
        <div><span>出生日期</span><strong>{{ data.student.出生年月 || '—' }}</strong></div>
        <div><span>民族</span><strong>{{ data.student.民族 || '—' }}</strong></div>
        <div><span>是否住校</span><strong>{{ data.student.是否住校 || '—' }}</strong></div>
        <div><span>特长</span><strong>{{ data.student.特长 || '—' }}</strong></div>
        <div><span>班级任职</span><strong>{{ data.student.班级任职 || '—' }}</strong></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">家庭联系信息</div>
      <div class="profile-grid">
        <div><span>监护人 1</span><strong>{{ data.student.监护人姓名 || '—' }}</strong></div>
        <div><span>联系电话</span><strong>{{ data.student.监护人电话 || '—' }}</strong></div>
        <div><span>关系</span><strong>{{ data.student.监护人关系 || '—' }}</strong></div>
        <div><span>职业</span><strong>{{ data.student.监护人职业 || '—' }}</strong></div>
        <template v-if="data.student.监护人2姓名 || data.student.监护人2电话 || data.student.监护人2关系 || data.student.监护人2职业">
          <div><span>监护人 2</span><strong>{{ data.student.监护人2姓名 || '—' }}</strong></div>
          <div><span>联系电话</span><strong>{{ data.student.监护人2电话 || '—' }}</strong></div>
          <div><span>关系</span><strong>{{ data.student.监护人2关系 || '—' }}</strong></div>
          <div><span>职业</span><strong>{{ data.student.监护人2职业 || '—' }}</strong></div>
        </template>
        <div><span>家庭住址</span><strong>{{ data.student.家庭住址 || '—' }}</strong></div>
      </div>
    </div>

    <QuickRecordModal v-if="modalMode" :mode="modalMode" :student-id="data.student.id" @success="saved" @close="modalMode = null" />
    <AddModal v-if="showEdit" title="编辑学生信息" mode="student" :student-id="data.student.id" :student-data="editData" @success="showEdit = false; load()" @close="showEdit = false" />
  </div>
</template>

<style scoped>
.student-insights { margin-bottom: 16px; padding: 18px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); box-shadow: var(--shadow-sm); }
.section-heading h2 { margin: 0; color: var(--text); font-size: 16px; }
.section-heading p { margin: 4px 0 14px; color: var(--text-secondary); font-size: 12px; }
.student-insight-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.insight-card { min-width: 0; padding: 13px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); }
.insight-title { display: flex; align-items: center; gap: 6px; margin-bottom: 9px; color: var(--text); font-size: 12px; font-weight: 700; }
.insight-title > span { margin-left: auto; padding: 3px 7px; border-radius: 999px; background: var(--surface); color: var(--text-secondary); font-size: 10px; }
.risk-高 { border-color: rgba(220,64,54,.22); background: var(--danger-bg); }
.risk-高 .insight-title, .risk-高 .insight-title > span { color: var(--danger); }
.risk-中 { border-color: rgba(237,143,37,.22); background: #fff9f0; }
.risk-中 .insight-title, .risk-中 .insight-title > span { color: #a65d08; }
.risk-低 { border-color: rgba(52,199,89,.2); background: var(--success-bg); }
.risk-低 .insight-title, .risk-低 .insight-title > span { color: #248a3d; }
.insight-card ul { margin: 0; padding-left: 17px; color: var(--text-secondary); font-size: 11px; line-height: 1.6; }
.insight-row { display: grid; gap: 2px; padding: 7px 0; border-top: 1px solid var(--border); color: inherit; text-decoration: none; }
.insight-row strong { overflow: hidden; color: var(--text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.insight-row span, .insight-empty { color: var(--text-secondary); font-size: 11px; }
.conclusion p { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.65; }
.student-detail-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.photo-input { display: none; }
.student-photo-block { position: relative; flex: 0 0 auto; }
.student-avatar { width: 64px; height: 64px; display: grid; place-items: center; overflow: hidden; border: 0; border-radius: 18px; color: var(--primary); background: linear-gradient(145deg, #eef0ff, #dfe4ff); cursor: pointer; }
.student-avatar img { width: 100%; height: 100%; object-fit: cover; }
.student-avatar:active, .student-avatar-edit:active, .photo-action:active, .photo-remove:active { transform: scale(.97); }
.student-avatar-edit { position: absolute; right: -5px; bottom: -5px; display: grid; place-items: center; width: 24px; height: 24px; border: 2px solid var(--surface); border-radius: 50%; color: #fff; background: var(--primary); cursor: pointer; }
.student-avatar-edit:disabled { cursor: wait; opacity: .55; }
.student-photo-copy { display: grid; flex: 0 0 128px; gap: 3px; min-width: 0; }
.photo-action, .photo-remove { display: inline-flex; align-items: center; justify-content: flex-start; gap: 4px; width: fit-content; padding: 0; border: 0; color: var(--primary); background: none; cursor: pointer; font: inherit; font-size: 12px; }
.photo-remove { color: var(--text-secondary); font-size: 11px; }
.photo-action:disabled, .photo-remove:disabled { cursor: wait; opacity: .55; }
.student-photo-copy > span { color: var(--text-tertiary); font-size: 10px; line-height: 1.35; }
.student-photo-copy > small { color: var(--danger); font-size: 10px; line-height: 1.35; }
.student-switcher { display: inline-flex; align-items: center; gap: 4px; margin-right: 4px; color: var(--text-secondary); font-size: 12px; }
.icon-button { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--border); border-radius: 8px; color: var(--text-secondary); background: var(--surface); cursor: pointer; }
.icon-button:disabled { cursor: not-allowed; opacity: .35; }
.student-priority-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
.student-priority-card { position: relative; min-width: 0; display: grid; gap: 4px; padding: 14px 36px 14px 15px; border: 1px solid var(--border); border-radius: 14px; color: inherit; background: var(--surface); text-decoration: none; box-shadow: var(--shadow-sm); transition: border-color var(--transition-fast), background var(--transition-fast), transform var(--transition-fast); }
.student-priority-card:hover { border-color: rgba(91,106,191,.35); background: var(--primary-bg); transform: translateY(-1px); }
.student-priority-card > span { color: var(--text-secondary); font-size: 11px; }
.student-priority-card strong { font-size: 24px; line-height: 1.1; letter-spacing: -0.03em; }
.student-priority-card strong small { margin-left: 3px; color: var(--text-secondary); font-size: 11px; font-weight: 500; letter-spacing: 0; }
.student-priority-card em { overflow: hidden; color: var(--text-secondary); font-size: 11px; font-style: normal; text-overflow: ellipsis; white-space: nowrap; }
.student-priority-card > svg { position: absolute; top: 15px; right: 14px; color: var(--text-tertiary); }
.student-priority-card.warning { border-color: rgba(237,143,37,.3); background: #fffaf2; }
.student-priority-card.warning strong { color: #a65d08; }
.student-attendance-summary { margin-top: 16px; }
.attendance-summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.attendance-summary-grid > div { display: grid; gap: 4px; min-width: 0; padding: 12px 14px; border-radius: 11px; background: var(--bg); }
.attendance-summary-grid span { color: var(--text-secondary); font-size: 11px; }
.attendance-summary-grid strong { font-size: 20px; line-height: 1.1; }
.attendance-summary-grid small { overflow: hidden; color: var(--text-tertiary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.attendance-summary-grid .warning { background: var(--warning-bg); }
.attendance-summary-grid .warning strong { color: #a65d08; }
.photo-preview-overlay { position: fixed; z-index: 20; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(15, 19, 30, .55); backdrop-filter: blur(8px); }
.photo-preview-card { position: relative; display: grid; gap: 10px; width: min(360px, 90vw); padding: 14px; border-radius: 18px; background: var(--surface); box-shadow: 0 20px 60px rgba(15, 19, 30, .25); }
.photo-preview-card img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 12px; background: var(--bg); }
.photo-preview-card > div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 0 2px; }
.photo-preview-card span { color: var(--text-secondary); font-size: 12px; }
.photo-preview-close { position: absolute; top: 22px; right: 22px; z-index: 1; display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 50%; color: #fff; background: rgba(0, 0, 0, .48); cursor: pointer; }
.insight-link { display: inline-flex; align-items: center; margin-top: 9px; color: var(--primary); font-size: 11px; text-decoration: none; }
.insight-link:hover, .card-action:hover { text-decoration: underline; }
.chart-text-summary { margin: -2px 0 12px; color: var(--text-secondary); font-size: 12px; line-height: 1.55; }
.comment-summary-row { padding: 8px 0; border-top: 1px solid var(--border); }
.comment-summary-row > div { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.comment-summary-row strong { color: var(--text); font-size: 12px; }
.comment-summary-row span { color: var(--text-secondary); font-size: 10px; white-space: nowrap; }
.comment-summary-row p { display: -webkit-box; overflow: hidden; margin: 4px 0 0; color: var(--text-secondary); font-size: 11px; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.detail-link { display: inline-block; margin-top: 8px; color: var(--primary); font-size: 12px; text-decoration: none; }
@media (max-width: 1000px) { .student-insight-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) {
  .student-insights { padding: 14px; }
  .student-insight-grid { grid-template-columns: 1fr; }
  .student-priority-grid { grid-template-columns: 1fr 1fr; }
  .student-detail-toolbar { justify-content: flex-start; }
  .attendance-summary-grid { grid-template-columns: 1fr; }
}
</style>
