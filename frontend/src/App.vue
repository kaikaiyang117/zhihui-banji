<script setup>
import { computed, h, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAV } from './sheets'
import { getIcon } from './icons'
import { get } from './api'

const route = useRoute()
const router = useRouter()
const activeTab = computed(() => route.path.startsWith('/p/') ? 'personal' : 'teacher')
const activeNav = computed(() => NAV.find(t => t.key === activeTab.value))
const searchText = ref('')
const searchResults = ref([])
const searchOpen = ref(false)
const searching = ref(false)

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

async function runSearch() {
  if (!searchText.value.trim()) return
  searching.value = true
  searchOpen.value = true
  try {
    const data = await get(`/api/search?q=${encodeURIComponent(searchText.value.trim())}`)
    searchResults.value = data.results || []
  } finally {
    searching.value = false
  }
}

function openResult(result) {
  searchOpen.value = false
  router.push(result.path)
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
      <div class="global-search">
        <input v-model="searchText" placeholder="搜索学生、事件、成绩…" @keyup.enter="runSearch" @focus="searchOpen = !!searchResults.length" />
        <button v-if="searchText" class="search-clear" @click="searchText = ''; searchResults = []; searchOpen = false">×</button>
        <div v-if="searchOpen" class="search-popover">
          <div v-if="searching" class="search-empty">搜索中…</div>
          <div v-else-if="!searchResults.length" class="search-empty">没有找到匹配记录</div>
          <button v-for="result in searchResults" v-else :key="`${result.kind}-${result.id}`" class="search-result" @click="openResult(result)">
            <span class="search-kind">{{ result.kind }}</span>
            <span><strong>{{ result.title }}</strong><small>{{ result.summary }}</small></span>
          </button>
        </div>
      </div>
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

.global-search { position: relative; margin-left: auto; width: min(300px, 32vw); }
.global-search input { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 999px; background: rgba(255,255,255,.72); padding: 9px 32px 9px 14px; color: var(--text); outline: none; transition: border-color .2s, box-shadow .2s; }
.global-search input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(91,106,191,.12); }
.search-clear { position: absolute; right: 10px; top: 6px; border: 0; background: transparent; color: var(--text-secondary); font-size: 18px; cursor: pointer; }
.search-popover { position: absolute; z-index: 20; top: calc(100% + 8px); left: 0; right: 0; max-height: 360px; overflow: auto; padding: 7px; background: rgba(255,255,255,.96); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 14px 36px rgba(25,35,65,.14); }
.search-result { width: 100%; display: flex; gap: 9px; align-items: flex-start; padding: 10px; border: 0; border-radius: 10px; background: transparent; text-align: left; cursor: pointer; color: var(--text); }
.search-result:hover { background: var(--bg); }
.search-result span:last-child { min-width: 0; display: grid; gap: 3px; }
.search-result small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.search-kind { flex: 0 0 auto; padding: 3px 6px; border-radius: 6px; background: var(--primary-bg); color: var(--primary); font-size: 11px; }
.search-empty { padding: 18px 10px; text-align: center; color: var(--text-secondary); font-size: 13px; }

@media (max-width: 760px) { .global-search { width: 42vw; } .global-search input { font-size: 12px; } }

@media (prefers-reduced-motion: reduce) {
  .page-enter-active,
  .page-leave-active {
    transition: none !important;
  }
}
</style>
