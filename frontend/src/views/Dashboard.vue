<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Download, Users, CheckCircle, Clock, DollarSign, ClipboardList, Phone, FileText, TrendingUp, Plus, ShieldCheck, Upload, Tag, ArrowRight } from 'lucide-vue-next'
import { get, post, upload } from '../api'
import QuickRecordModal from '../components/QuickRecordModal.vue'

const router = useRouter()
const stats = ref(null)
const errorMsg = ref('')
const modalMode = ref(null)
const selectedDate = ref(localDate())
const fileInput = ref(null)
const backupMessage = ref('')

function localDate() {
  const d = new Date()
  const pad = v => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function load() {
  errorMsg.value = ''
  try { stats.value = await get(`/api/stats/dashboard?date=${selectedDate.value}`) } catch (e) { errorMsg.value = e.message }
}

async function backup() {
  backupMessage.value = '正在生成备份…'
  try {
    const result = await post('/api/system/backup', {})
    backupMessage.value = `备份已生成：${result.filename}`
    window.open(`/api/system/backup/${encodeURIComponent(result.filename)}`, '_blank')
  } catch (e) { backupMessage.value = `备份失败：${e.message}` }
}

async function restore(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || !confirm('恢复会替换当前数据。确定继续吗？')) return
  backupMessage.value = '正在恢复数据…'
  try { await upload('/api/system/restore', file); backupMessage.value = '恢复完成，页面数据已刷新'; await load() } catch (e) { backupMessage.value = `恢复失败：${e.message}` }
}

function rankClass(i) { return ['gold', 'silver', 'bronze'][i] || 'normal' }
function finishRecord() { modalMode.value = null; load() }
onMounted(load)
</script>

<template>
  <div v-if="errorMsg" class="empty-state"><div>{{ errorMsg }}</div><button class="btn btn-outline" @click="load">重新加载</button></div>
  <div v-else-if="stats">
    <div class="page-title-bar">
      <div><div class="page-title">今日工作台</div><div class="page-subtitle">{{ stats.date }} · 先处理最重要的事</div></div>
      <div class="toolbar" style="margin-bottom:0"><button class="btn btn-primary" @click="modalMode = 'event'"><Plus :size="14" /> 快速记录</button><button class="btn btn-outline" @click="backup"><ShieldCheck :size="14" /> 备份数据</button><button class="btn btn-outline" @click="fileInput?.click()"><Upload :size="14" /> 恢复</button><input ref="fileInput" type="file" accept=".db" hidden @change="restore"></div>
    </div>

    <div class="overview-cards dashboard-cards">
      <router-link to="/students" class="overview-card overview-link"><div class="oc-icon blue"><Users :size="20" /></div><div><div class="oc-label">班级人数</div><div class="oc-value">{{ stats.total_students }}</div></div><ArrowRight :size="16" class="card-arrow" /></router-link>
      <router-link to="/attendance" class="overview-card overview-link"><div class="oc-icon green"><CheckCircle :size="20" /></div><div><div class="oc-label">今日出勤</div><div class="oc-value">{{ stats.today_attendance['出勤'] }}</div></div><ArrowRight :size="16" class="card-arrow" /></router-link>
      <router-link to="/attendance" class="overview-card overview-link"><div class="oc-icon orange"><Clock :size="20" /></div><div><div class="oc-label">迟到 / 缺勤</div><div class="oc-value">{{ stats.today_attendance['迟到'] + stats.today_attendance['缺勤'] }}</div></div><ArrowRight :size="16" class="card-arrow" /></router-link>
      <router-link to="/tasks" class="overview-card overview-link"><div class="oc-icon red"><ClipboardList :size="20" /></div><div><div class="oc-label">待处理事项</div><div class="oc-value">{{ stats.tasks.length }}</div></div><ArrowRight :size="16" class="card-arrow" /></router-link>
    </div>

    <div v-if="backupMessage" class="notice-bar"><ShieldCheck :size="16" /> {{ backupMessage }}</div>

    <div class="dashboard-grid">
      <div class="card">
        <div class="card-title">今天先处理 <span class="count">{{ stats.tasks.length }} 项</span><router-link to="/tasks" class="card-action">查看全部 <ArrowRight :size="13" /></router-link></div>
        <div v-if="!stats.tasks.length" class="empty-state compact-empty">今天没有待处理事项，状态很好</div>
        <div v-for="task in stats.tasks.slice(0, 6)" :key="task.id" class="task-row"><div class="task-priority" :class="`priority-${task.priority}`"></div><div class="task-copy"><strong>{{ task.title }}</strong><span>{{ task.student_name || '班级事务' }} · {{ task.due_at || '未设置截止日期' }}</span></div><span class="tag" :class="task.priority === '紧急' ? 'tag-red' : task.priority === '重要' ? 'tag-orange' : ''">{{ task.priority }}</span></div>
      </div>
      <div class="card">
        <div class="card-title">持续关注 <span class="count">{{ stats.focus.length }} 项</span><router-link to="/special" class="card-action">管理 <ArrowRight :size="13" /></router-link></div>
        <div v-if="!stats.focus.length" class="empty-state compact-empty">暂无持续关注事项</div>
        <div v-for="item in stats.focus.slice(0, 5)" :key="item.id" class="focus-row"><div><strong>{{ item.student_name }} · {{ item.topic }}</strong><div class="hint">{{ item.reason }}</div></div><span class="tag tag-orange">{{ item.next_review_at || '待安排' }}</span></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">最近动态</div>
      <div v-if="!stats.recent_events.length" class="empty-state compact-empty">记录事件后，这里会形成班级动态</div>
      <div v-for="item in stats.recent_events" :key="item.id" class="activity-row"><div class="activity-icon"><FileText :size="15" /></div><div><strong>{{ item.student_name }} · {{ item.event_type }}</strong><span>{{ item.description }}</span></div><time>{{ item.occurred_at }}</time></div>
    </div>

    <div class="card">
      <div class="card-title">快捷操作</div>
      <div class="toolbar" style="margin-bottom:0"><button class="btn btn-primary" @click="modalMode = 'event'"><FileText :size="14" /> 记录学生事件</button><button class="btn btn-outline" @click="modalMode = 'comm'"><Phone :size="14" /> 家校沟通</button><button class="btn btn-outline" @click="modalMode = 'focus'"><Tag :size="14" /> 添加关注</button><router-link to="/attendance" class="btn btn-outline"><ClipboardList :size="14" /> 批量考勤</router-link><router-link to="/scores" class="btn btn-outline"><TrendingUp :size="14" /> 查看成绩</router-link></div>
    </div>
    <QuickRecordModal v-if="modalMode" :mode="modalMode" @success="finishRecord" @close="modalMode = null" />
  </div>
  <div v-else class="loading">正在加载今日工作台…</div>
</template>
