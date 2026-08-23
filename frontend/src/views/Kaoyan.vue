<script setup>
import { BookOpen } from 'lucide-vue-next'
</script>

<template>
  <div class="kaoyan-page">
    <div class="page-title-bar">
      <div class="page-title">考研备考</div>
    </div>
    <div class="card">
      <div class="card-title">考研备考工作台</div>
      <div style="text-align:center;padding:40px">
        <BookOpen :size="48" :stroke-width="1.5" style="color:var(--primary);margin-bottom:16px" />
        <div style="font-size:16px;color:#555;margin-bottom:8px">考研备考系统即将上线</div>
        <div style="font-size:13px;color:#999">
          包含：学习计划制定、知识点追踪、真题练习、进度统计<br>
      通过对话告诉班小助你的需求，即可搭建起来
        </div>
      </div>
    </div>
  </div>
</template>
