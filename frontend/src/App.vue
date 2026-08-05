<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { NAV } from './sheets'

const route = useRoute()
const activeTab = computed(() => route.path.startsWith('/p') ? 'personal' : 'teacher')
const activeNav = computed(() => NAV.find(t => t.key === activeTab.value))

function itemTo(item) {
  return activeTab.value === 'teacher' ? '/' + item.page : '/p/' + item.page
}
function isActive(item) {
  const base = activeTab.value === 'teacher' ? '/' : '/p/'
  return route.path === base + item.page
}
function tabTo(tab) {
  return tab.key === 'teacher' ? '/dashboard' : '/p/health'
}
</script>

<template>
  <div class="app">
    <div class="top-tabs">
      <router-link v-for="tab in NAV" :key="tab.key"
        :to="tabTo(tab)" class="top-tab" :class="{ active: tab.key === activeTab }">
        <span class="tab-icon">{{ tab.icon }}</span>
        <span>{{ tab.title }}</span>
      </router-link>
    </div>
    <div class="app-body">
      <aside class="sidebar">
        <div class="sidebar-header">
          <h2>{{ activeNav.title }}</h2>
          <div class="sub">{{ activeNav.school }}</div>
        </div>
        <nav class="sidebar-nav">
          <div v-for="group in activeNav.groups" :key="group.title" class="nav-group">
            <div class="nav-group-title">{{ group.title }}</div>
            <router-link v-for="item in group.items" :key="item.page"
              :to="itemTo(item)" class="nav-item" :class="{ active: isActive(item) }">
              <span class="icon">{{ item.icon }}</span>
              <span>{{ item.label }}</span>
            </router-link>
          </div>
        </nav>
        <div class="sidebar-footer">
          <span>凯凯小兵 🛡️ 为你值守</span>
        </div>
      </aside>
      <main class="main">
        <router-view />
      </main>
    </div>
  </div>
</template>