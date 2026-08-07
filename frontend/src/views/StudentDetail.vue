<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Activity, AlertTriangle, ArrowLeft, CalendarCheck, ClipboardList, Flag, MessageCircle, Plus, Tag, UserRound, TrendingUp, Star } from 'lucide-vue-next'
import { get } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'

const route = useRoute()
const router = useRouter()
const data = ref(null)
const loading = ref(true)
const errorMsg = ref('')
const modalMode = ref(null)

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    data.value = await get(`/api/students/${route.params.id}/detail`)
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

onMounted(load)
</script>

<template>
  <div v-if="loading" class="loading">正在打开学生档案…</div>
  <div v-else-if="errorMsg" class="empty-state"><div>{{ errorMsg }}</div><button class="btn btn-outline" @click="router.back()">返回</button></div>
  <div v-else-if="data" class="student-detail-page">
    <div class="page-title-bar">
      <div>
        <button class="back-button" @click="router.back()"><ArrowLeft :size="16" /> 学生列表</button>
        <div class="page-title">{{ data.student.姓名 || '未命名学生' }}</div>
        <div class="page-subtitle">{{ data.student.学号 || '暂无学号' }} · {{ data.student.班级任职 || '班级成员' }}</div>
      </div>
      <div class="toolbar" style="margin-bottom:0">
        <button class="btn btn-primary" @click="modalMode = 'event'"><Plus :size="14" /> 记录事件</button>
        <button class="btn btn-outline" @click="modalMode = 'comm'"><MessageCircle :size="14" /> 家校沟通</button>
      </div>
    </div>

    <div class="student-hero card">
      <div class="student-avatar"><UserRound :size="24" /></div>
      <div class="student-hero-info">
        <div class="student-hero-name">{{ data.student.姓名 }}</div>
        <div class="student-hero-meta">{{ data.student.性别 || '性别未填' }} · {{ data.student.是否住校 || '住宿未填' }} · {{ data.student.特长 || '暂无特长记录' }}</div>
      </div>
      <div class="student-hero-actions">
        <button class="soft-action" @click="modalMode = 'task'"><ClipboardList :size="16" /> 新建待办</button>
        <button class="soft-action" @click="modalMode = 'focus'"><Tag :size="16" /> 添加关注</button>
      </div>
    </div>

    <section class="student-insights" aria-labelledby="student-insights-title">
      <div class="section-heading">
        <div><h2 id="student-insights-title">学生当前状态</h2><p>风险、变化和下一步行动来自当前班级与学期数据</p></div>
      </div>
      <div class="student-insight-grid">
        <article class="insight-card risk" :class="`risk-${data.insights.risk_level}`">
          <div class="insight-title"><AlertTriangle :size="16" /> 当前风险 <span>{{ data.insights.risk_level }}</span></div>
          <ul><li v-for="reason in data.insights.risk_reasons" :key="reason">{{ reason }}</li></ul>
        </article>
        <article class="insight-card">
          <div class="insight-title"><ClipboardList :size="16" /> 未完成行动 <span>{{ data.insights.open_actions.length }}</span></div>
          <div v-if="!data.insights.open_actions.length" class="insight-empty">当前没有未完成行动</div>
          <router-link v-for="task in data.insights.open_actions.slice(0, 3)" :key="task.id" :to="{ path: '/tasks', query: { bucket: 'open', task: task.id, action: 'edit' } }" class="insight-row">
            <strong>{{ task.title }}</strong><span>{{ task.timing_state }} · {{ task.due_at || '未设截止日期' }}</span>
          </router-link>
        </article>
        <article class="insight-card">
          <div class="insight-title"><Activity :size="16" /> 最近变化</div>
          <div v-if="!data.insights.recent_changes.length" class="insight-empty">还没有可归纳的变化记录</div>
          <div v-for="item in data.insights.recent_changes.slice(0, 3)" :key="`${item.kind}-${item.id}`" class="insight-row">
            <strong>{{ item.title }}</strong><span>{{ item.at }} · {{ item.status }}</span>
          </div>
        </article>
        <article class="insight-card conclusion">
          <div class="insight-title"><Flag :size="16" /> 阶段结论</div>
          <p>{{ data.insights.stage_conclusion }}</p>
        </article>
      </div>
    </section>

    <div class="overview-cards detail-overview">
      <div class="overview-card"><div class="oc-icon blue"><CalendarCheck :size="20" /></div><div><div class="oc-label">考勤记录</div><div class="oc-value">{{ data.attendance.length }}</div></div></div>
      <div class="overview-card"><div class="oc-icon orange"><ClipboardList :size="20" /></div><div><div class="oc-label">待办事项</div><div class="oc-value">{{ data.tasks.filter(t => !['已完成','已取消'].includes(t.status)).length }}</div></div></div>
      <div class="overview-card"><div class="oc-icon green"><MessageCircle :size="20" /></div><div><div class="oc-label">家校沟通</div><div class="oc-value">{{ data.communications.length }}</div></div></div>
      <div class="overview-card"><div class="oc-icon red"><Tag :size="20" /></div><div><div class="oc-label">关注事项</div><div class="oc-value">{{ data.focus.filter(f => f.status !== '已结束').length }}</div></div></div>
      <div class="overview-card"><div class="oc-icon blue"><TrendingUp :size="20" /></div><div><div class="oc-label">成绩考试</div><div class="oc-value">{{ data.score_summary.exams.length }}</div></div></div>
      <div class="overview-card"><div class="oc-icon orange"><Star :size="20" /></div><div><div class="oc-label">行为积分</div><div class="oc-value">{{ data.points_summary.total }}</div></div></div>
    </div>

    <div class="student-detail-grid">
      <div class="card">
        <div class="card-title">成长时间线 <span class="count">{{ data.timeline.length }} 条记录</span></div>
        <div v-if="!data.timeline.length" class="empty-state compact-empty">还没有成长记录，先记录一次事件吧</div>
        <div v-else class="timeline">
          <div v-for="item in data.timeline" :key="`${item.kind}-${item.id}`" class="timeline-item">
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
          <div class="card-title">当前待办 <span class="count">{{ data.tasks.length }}</span></div>
          <div v-if="!data.tasks.length" class="empty-state compact-empty">暂无待办</div>
          <div v-for="task in data.tasks.slice(0, 5)" :key="task.id" class="task-row">
            <div class="task-priority" :class="`priority-${task.priority}`"></div>
            <div class="task-copy"><strong>{{ task.title }}</strong><span>{{ task.due_at || '未设置日期' }} · {{ task.status }}</span></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">关注事项 <span class="count">{{ data.focus.length }}</span></div>
          <div v-if="!data.focus.length" class="empty-state compact-empty">暂无关注事项</div>
          <div v-for="item in data.focus.slice(0, 4)" :key="item.id" class="focus-row">
            <div><strong>{{ item.topic }}</strong><div class="hint">{{ item.reason }}</div></div>
            <span class="tag" :class="item.status === '已结束' ? 'tag-green' : 'tag-orange'">{{ item.status }}</span>
          </div>
        </div>
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
        <div class="points-total">{{ data.points_summary.total }}<small>累计积分</small></div>
        <div class="weekly-points"><span v-for="(point, index) in data.points_summary.weekly" :key="index"><i :style="{ height: `${Math.max(4, Math.min(60, Number(point) || 0))}px` }"></i><small>W{{ index + 1 }}</small></span></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">基础信息</div>
      <div class="profile-grid">
        <div><span>性别</span><strong>{{ data.student.性别 || '—' }}</strong></div>
        <div><span>出生年月</span><strong>{{ data.student.出生年月 || '—' }}</strong></div>
        <div><span>民族</span><strong>{{ data.student.民族 || '—' }}</strong></div>
        <div><span>监护人</span><strong>{{ data.student.监护人姓名 || '—' }}</strong></div>
        <div><span>联系电话</span><strong>{{ data.student.监护人电话 || '—' }}</strong></div>
        <div><span>家庭住址</span><strong>{{ data.student.家庭住址 || '—' }}</strong></div>
      </div>
    </div>

    <QuickRecordModal v-if="modalMode" :mode="modalMode" :student-id="data.student.id" @success="saved" @close="modalMode = null" />
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
.chart-text-summary { margin: -2px 0 12px; color: var(--text-secondary); font-size: 12px; line-height: 1.55; }
@media (max-width: 1000px) { .student-insight-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) {
  .student-insights { padding: 14px; }
  .student-insight-grid { grid-template-columns: 1fr; }
}
</style>
