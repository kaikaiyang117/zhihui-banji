<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, CalendarCheck, ClipboardList, MessageCircle, Plus, Tag, UserRound } from 'lucide-vue-next'
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

    <div class="overview-cards detail-overview">
      <div class="overview-card"><div class="oc-icon blue"><CalendarCheck :size="20" /></div><div><div class="oc-label">考勤记录</div><div class="oc-value">{{ data.attendance.length }}</div></div></div>
      <div class="overview-card"><div class="oc-icon orange"><ClipboardList :size="20" /></div><div><div class="oc-label">待办事项</div><div class="oc-value">{{ data.tasks.filter(t => !['已完成','已取消'].includes(t.status)).length }}</div></div></div>
      <div class="overview-card"><div class="oc-icon green"><MessageCircle :size="20" /></div><div><div class="oc-label">家校沟通</div><div class="oc-value">{{ data.communications.length }}</div></div></div>
      <div class="overview-card"><div class="oc-icon red"><Tag :size="20" /></div><div><div class="oc-label">关注事项</div><div class="oc-value">{{ data.focus.filter(f => f.status !== '已结束').length }}</div></div></div>
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
