<script setup>
import { computed, h } from 'vue'
import { useRoute } from 'vue-router'
import { NAV } from './sheets'
import { getIcon } from './icons'

const route = useRoute()
const activeTab = computed(() => route.path.startsWith('/p/') ? 'personal' : 'teacher')
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

function renderIcon(name) {
  const comp = getIcon(name)
  if (!comp) return null
  return h(comp, { size: 18, 'stroke-width': 2 })
}
</script>

<template>
  <div class="app">
    <header class="top-tabs">
      <router-link v-for="tab in NAV" :key="tab.key"
        :to="tabTo(tab)" class="top-tab" :class="{ active: tab.key === activeTab }">
        <component :is="renderIcon(tab.icon)" class="tab-icon" />
        <span>{{ tab.title }}</span>
      </router-link>
    </header>
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
              <component :is="renderIcon(item.icon)" class="nav-item-icon" :size="16" :stroke-width="2" />
              <span>{{ item.label }}</span>
            </router-link>
          </div>
        </nav>
        <div class="sidebar-footer">
          <span>凯凯小兵 为你值守</span>
        </div>
      </aside>
      <main class="main">
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<style>
.page-enter-active {
  transition: opacity 150ms cubic-bezier(0.25, 0.1, 0.25, 1),
              transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

.page-leave-active {
  transition: opacity 100ms cubic-bezier(0.25, 0.1, 0.25, 1);
  position: absolute;
  width: 100%;
}

.page-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.page-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .page-enter-active,
  .page-leave-active {
    transition: none !important;
  }
}
</style>