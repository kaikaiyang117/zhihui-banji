<script setup>
import { ref, onMounted } from 'vue'
import { get, download } from '../api'

const stats = ref(null)

onMounted(async () => {
  stats.value = await get('/api/stats/dashboard')
})

function rankClass(i) {
  return ['gold', 'silver', 'bronze'][i] || 'normal'
}
</script>

<template>
  <div v-if="stats">
    <div class="page-title-bar">
      <div class="page-title">首页仪表盘</div>
      <a class="btn btn-outline btn-export" :href="'/api/export/sheet/' + encodeURIComponent('学生信息总表')">📥 导出Excel</a>
    </div>

    <div class="overview-cards">
      <div class="overview-card">
        <div class="oc-icon blue">👥</div>
        <div><div class="oc-label">班级人数</div><div class="oc-value">{{ stats.total_students }}</div></div>
      </div>
      <div class="overview-card">
        <div class="oc-icon green">✅</div>
        <div><div class="oc-label">出勤</div><div class="oc-value">{{ stats.today_attendance['出勤'] }}</div></div>
      </div>
      <div class="overview-card">
        <div class="oc-icon orange">⏰</div>
        <div><div class="oc-label">迟到</div><div class="oc-value">{{ stats.today_attendance['迟到'] }}</div></div>
      </div>
      <div class="overview-card">
        <div class="oc-icon red">💰</div>
        <div><div class="oc-label">班费余额</div><div class="oc-value">¥{{ Number(stats.class_fund_balance || 0).toFixed(2) }}</div></div>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="card-title">积分排行榜 TOP5</div>
        <ul v-if="stats.top_points?.length" class="rank-list">
          <li v-for="(s, i) in stats.top_points" :key="i" class="rank-item">
            <div class="rank-num" :class="rankClass(i)">{{ i + 1 }}</div>
            <div class="rank-name">{{ s.name }}</div>
            <div class="rank-points">{{ s.points }} 分</div>
          </li>
        </ul>
        <div v-else class="empty-state">暂无积分数据</div>
      </div>
      <div class="card">
        <div class="card-title">最近日志</div>
        <div v-if="stats.recent_logs?.length">
          <div v-for="(l, i) in stats.recent_logs" :key="i" class="log-line">
            <span class="log-date">{{ l.date }}</span>
            <span>{{ l.content }}</span>
          </div>
        </div>
        <div v-else class="empty-state">还没有日志记录</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">快捷操作</div>
      <div class="toolbar" style="margin-bottom:0">
        <router-link to="/attendance" class="btn btn-primary">📋 快速考勤</router-link>
        <router-link to="/parent-comm" class="btn btn-outline">📞 家校沟通</router-link>
        <router-link to="/diary" class="btn btn-outline">📝 写日志</router-link>
        <router-link to="/scores" class="btn btn-outline">📈 查看成绩</router-link>
        <router-link to="/students" class="btn btn-outline">👥 学生信息</router-link>
      </div>
    </div>
  </div>
  <div v-else class="loading">正在加载数据...</div>
</template>