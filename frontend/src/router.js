import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', component: () => import('./views/Dashboard.vue') },
  { path: '/agent', component: () => import('./views/Agent.vue') },
  { path: '/agent/config/:profileId', component: () => import('./views/AgentConfig.vue') },
  { path: '/settings', component: () => import('./views/SystemSettings.vue') },
  { path: '/reports', component: () => import('./views/Reports.vue') },
  { path: '/recycle', component: () => import('./views/RecycleBin.vue') },
  { path: '/students', component: () => import('./views/Students.vue') },
  { path: '/student/:id', component: () => import('./views/StudentDetail.vue') },
  { path: '/events', component: () => import('./views/Events.vue') },
  { path: '/tasks', component: () => import('./views/Tasks.vue') },
  { path: '/special', component: () => import('./views/Special.vue') },
  { path: '/comments', component: () => import('./views/Comments.vue') },
  { path: '/attendance', component: () => import('./views/Attendance.vue') },
  { path: '/timetable', component: () => import('./views/Timetable.vue') },
  { path: '/scores', component: () => import('./views/Scores.vue') },
  { path: '/class-tasks', component: () => import('./views/ClassTasks.vue') },
  { path: '/school-calendar', component: () => import('./views/SchoolCalendar.vue') },
  { path: '/duty', component: () => import('./views/Duty.vue') },
  { path: '/points', component: () => import('./views/Points.vue') },
  { path: '/seating', component: () => import('./views/Seating.vue') },
  { path: '/groups', component: () => import('./views/Groups.vue') },
  { path: '/dormitories', component: () => import('./views/Dormitories.vue') },
  { path: '/parent-comm', component: () => import('./views/ParentComm.vue') },
  { path: '/meetings', component: () => import('./views/Meetings.vue') },
  { path: '/fund', component: () => import('./views/Fund.vue') },
  { path: '/diary', component: () => import('./views/Diary.vue') },
  { path: '/activities', component: () => import('./views/Activities.vue') },
  { path: '/p', redirect: '/dashboard' },
  { path: '/p/:pathMatch(.*)*', redirect: '/dashboard' },
  { path: '/tools', component: () => import('./views/Tools.vue') }
]

export default createRouter({
  history: createWebHashHistory(),
  routes
})
