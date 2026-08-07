<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as echarts from 'echarts'
import { Download, FileText, Plus, RotateCcw, Upload, X } from 'lucide-vue-next'
import { download, get, post, put, upload } from '../api'

const emptySummary = () => ({
  totals: { 收入: 0, 支出: 0, balance: 0, count: 0 },
  current_period: { month: '', 收入: 0, 支出: 0, balance: 0, count: 0 },
  monthly: [], categories: [], settlements: [], migration: null, categories_config: [],
})
const summary = ref(emptySummary())
const entries = ref([])
const loading = ref(true)
const message = ref('')
const showEntry = ref(false)
const showSettlement = ref(false)
const editingId = ref(null)
const actionTarget = ref(null)
const actionType = ref('revoke')
const actionReason = ref('')
const actionDate = ref(localDate())
const settlementTarget = ref(null)
const countedBalance = ref('')
const settlementNote = ref('')
const receiptFile = ref(null)
const chartEl = ref(null)
const filters = ref({ date_from: '', date_to: '', direction: '', status: '' })
const entryForm = ref(defaultEntry())
const settlementForm = ref({ period_key: currentMonth(), counted_balance: '', note: '' })
let chart = null

function localDate() {
  const now = new Date(); const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
function currentMonth() { return localDate().slice(0, 7) }
function defaultEntry() {
  return { occurred_at: localDate(), direction: '支出', amount: '', category_id: '', category: '', description: '', handler: '', witness: '', note: '' }
}
function money(value) { return Number(value || 0).toFixed(2) }
function signed(value) { const n = Number(value || 0); return `${n > 0 ? '+' : ''}${money(n)}` }
function categoryOptions(direction = entryForm.value.direction) {
  return (summary.value.categories_config || []).filter(item => item.direction === direction && item.enabled && !item.deleted_at)
}
const unsettledCount = computed(() => (summary.value.settlements || []).filter(item => item.status_display === '需复核').length)
const balanceTone = computed(() => Number(summary.value.totals.balance || 0) < 0 ? 'negative' : 'positive')

function queryString() {
  const params = new URLSearchParams()
  Object.entries(filters.value).forEach(([key, value]) => { if (value) params.set(key, value) })
  return params.toString()
}

async function load() {
  loading.value = true
  try {
    const result = await get(`/api/fund${queryString() ? `?${queryString()}` : ''}`)
    summary.value = result.summary || emptySummary()
    entries.value = result.entries || []
    if (!entryForm.value.category_id) selectDefaultCategory()
    await new Promise(resolve => setTimeout(resolve, 40))
    renderChart()
  } catch (error) { message.value = `加载失败：${error.message}` } finally { loading.value = false }
}

function selectDefaultCategory() {
  const option = categoryOptions()[0]
  entryForm.value.category_id = option?.id || ''
  entryForm.value.category = option?.name || ''
}
function changeDirection() { entryForm.value.category_id = ''; entryForm.value.category = ''; selectDefaultCategory() }
function openCreate() { editingId.value = null; entryForm.value = defaultEntry(); selectDefaultCategory(); receiptFile.value = null; showEntry.value = true }
function openEdit(entry) {
  if (entry.settlement_id || entry.status !== '有效') return
  editingId.value = entry.id
  entryForm.value = {
    occurred_at: entry.occurred_at, direction: entry.direction, amount: entry.amount,
    category_id: entry.category_id || '', category: entry.category || '', description: entry.description,
    handler: entry.handler || '', witness: entry.witness || '', note: entry.note || '',
  }
  receiptFile.value = null; showEntry.value = true
}
async function saveEntry() {
  if (!entryForm.value.amount || !entryForm.value.description.trim()) return
  const body = { ...entryForm.value, amount: Number(entryForm.value.amount), category_id: entryForm.value.category_id ? Number(entryForm.value.category_id) : null }
  try {
    const result = editingId.value
      ? await put(`/api/fund/entries/${editingId.value}`, body)
      : await post('/api/fund/entries', body)
    const entryId = editingId.value || result.entry.id
    if (receiptFile.value && !editingId.value) await upload(`/api/fund/entries/${entryId}/attachments`, receiptFile.value)
    message.value = editingId.value ? '班费流水已更新' : '班费流水已记录'
    showEntry.value = false; receiptFile.value = null; await load()
  } catch (error) { message.value = `保存失败：${error.message}` }
}
function selectReceipt(event) { receiptFile.value = event.target.files?.[0] || null }
function openAction(entry, type) {
  actionTarget.value = entry; actionType.value = type; actionReason.value = ''; actionDate.value = localDate()
}
async function confirmAction() {
  if (!actionTarget.value || !actionReason.value.trim()) return
  try {
    if (actionType.value === 'revoke') {
      await post(`/api/fund/entries/${actionTarget.value.id}/revoke`, { reason: actionReason.value })
      message.value = '流水已撤销，原记录仍保留'
    } else {
      await post(`/api/fund/entries/${actionTarget.value.id}/reverse`, { reason: actionReason.value, occurred_at: actionDate.value })
      message.value = '已生成冲正流水，原结算记录进入复核'
    }
    actionTarget.value = null; await load()
  } catch (error) { message.value = `处理失败：${error.message}` }
}
async function createSettlement() {
  try {
    await post('/api/fund/settlements', {
      ...settlementForm.value,
      counted_balance: settlementForm.value.counted_balance === '' ? null : Number(settlementForm.value.counted_balance),
    })
    message.value = '班费结算已保存'; showSettlement.value = false; await load()
  } catch (error) { message.value = `结算失败：${error.message}` }
}
function openReconcile(settlement) {
  settlementTarget.value = settlement; countedBalance.value = settlement.counted_balance; settlementNote.value = settlement.note || ''
}
async function reconcile() {
  if (!settlementTarget.value) return
  try {
    await post(`/api/fund/settlements/${settlementTarget.value.id}/reconcile`, {
      counted_balance: Number(countedBalance.value), note: settlementNote.value,
    })
    message.value = '结算复核已保存'; settlementTarget.value = null; await load()
  } catch (error) { message.value = `复核失败：${error.message}` }
}
async function uploadReceipt(entry, event) {
  const file = event.target.files?.[0]
  if (!file) return
  try { await upload(`/api/fund/entries/${entry.id}/attachments`, file); message.value = '凭证已上传'; await load() }
  catch (error) { message.value = `凭证上传失败：${error.message}` }
}
function renderChart() {
  if (!chartEl.value) return
  if (chart) chart.dispose()
  chart = echarts.init(chartEl.value)
  const rows = [...(summary.value.monthly || [])].reverse().slice(-8)
  chart.setOption({
    tooltip: { trigger: 'axis' }, legend: { data: ['收入', '支出'], bottom: 0 },
    grid: { left: '3%', right: '4%', bottom: '18%', containLabel: true },
    xAxis: { type: 'category', data: rows.map(item => item.month) }, yAxis: { type: 'value' },
    series: [
      { name: '收入', type: 'bar', data: rows.map(item => item.income) },
      { name: '支出', type: 'bar', data: rows.map(item => item.expense) },
    ],
  })
}
function applyFilters() { load() }
function exportLedger() { download('/api/export/sheet/班费管理', '班费分类账.xlsx') }
function resizeChart() { if (chart) chart.resize() }
onMounted(() => { load(); window.addEventListener('resize', resizeChart) })
onBeforeUnmount(() => { window.removeEventListener('resize', resizeChart); if (chart) chart.dispose() })
</script>

<template>
  <div>
    <div class="page-title-bar">
      <div><div class="page-title">班费管理</div><div class="page-subtitle">所有余额由分类账重算，结算后记录只能撤销或冲正</div></div>
      <div class="toolbar" style="margin-bottom:0"><button class="btn btn-outline" @click="showSettlement = true"><FileText :size="14" /> 月度结算</button><button class="btn btn-primary" @click="openCreate"><Plus :size="14" /> 记录收支</button><button class="btn btn-outline btn-export" @click="exportLedger"><Download :size="14" /> 导出分类账</button></div>
    </div>
    <div v-if="message" class="inline-message">{{ message }}</div>

    <div class="overview-grid fund-overview">
      <div class="overview-card"><span class="overview-label">当前余额</span><strong class="overview-value" :class="balanceTone">¥ {{ money(summary.totals.balance) }}</strong><small>累计 {{ summary.totals.count }} 笔有效账务</small></div>
      <div class="overview-card"><span class="overview-label">本月收入</span><strong class="overview-value positive">¥ {{ money(summary.current_period.收入) }}</strong><small>{{ summary.current_period.month || '本月' }}</small></div>
      <div class="overview-card"><span class="overview-label">本月支出</span><strong class="overview-value negative">¥ {{ money(summary.current_period.支出) }}</strong><small>{{ summary.current_period.count }} 笔流水</small></div>
      <div class="overview-card"><span class="overview-label">待复核结算</span><strong class="overview-value" :class="unsettledCount ? 'negative' : 'positive'">{{ unsettledCount }}</strong><small>{{ unsettledCount ? '存在账面差异' : '账目状态正常' }}</small></div>
    </div>

    <div class="fund-dashboard-grid">
      <div class="card"><div class="card-title">月度收支趋势</div><div ref="chartEl" class="chart-box fund-chart" role="img" aria-label="月度班费收支趋势"></div></div>
      <div class="card"><div class="card-title">分类汇总</div><div v-if="summary.categories.length" class="fund-category-list"><div v-for="item in summary.categories.slice(0, 8)" :key="`${item.direction}-${item.category}`" class="fund-category-row"><span><i :class="item.direction === '收入' ? 'fund-dot income' : 'fund-dot expense'"></i>{{ item.category }}<small>{{ item.count }} 笔</small></span><strong :class="item.direction === '收入' ? 'positive' : 'negative'">{{ item.direction === '收入' ? '+' : '-' }}¥ {{ money(item.total) }}</strong></div></div><div v-else class="empty-state compact-empty">暂无分类数据</div></div>
    </div>

    <div class="card"><div class="card-title">月度结算 <span class="count">{{ summary.settlements.length }} 期</span></div><div v-if="summary.settlements.length" class="fund-settlement-list"><div v-for="item in summary.settlements" :key="item.id" class="fund-settlement-row"><div><strong>{{ item.period_key }}</strong><span>账面结余 ¥ {{ money(item.closing_balance) }} · 盘点 ¥ {{ money(item.counted_balance) }}</span></div><span class="tag" :class="item.status_display === '已结算' ? 'tag-green' : 'tag-orange'">{{ item.status_display }}</span><button class="btn btn-sm btn-outline" @click="openReconcile(item)">复核</button></div></div><div v-else class="empty-state compact-empty">尚未建立月度结算</div></div>

    <div class="card"><div class="card-title">分类账明细 <span class="count">{{ entries.length }} 条</span></div><div class="fund-filters"><label>开始日期<input class="form-input" type="date" v-model="filters.date_from" @change="applyFilters"></label><label>结束日期<input class="form-input" type="date" v-model="filters.date_to" @change="applyFilters"></label><label>类型<select class="form-select" v-model="filters.direction" @change="applyFilters"><option value="">全部收支</option><option value="收入">收入</option><option value="支出">支出</option></select></label><label>状态<select class="form-select" v-model="filters.status" @change="applyFilters"><option value="">全部状态</option><option value="有效">有效</option><option value="已撤销">已撤销</option><option value="已冲正">已冲正</option></select></label></div><div v-if="loading" class="loading">加载中…</div><div v-else-if="!entries.length" class="empty-state">暂无班费流水</div><div v-else class="fund-ledger-list"><div v-for="entry in entries" :key="entry.id" class="fund-ledger-row" :class="{ inactive: entry.status !== '有效' }"><div class="fund-ledger-main"><strong>{{ entry.occurred_at || '历史记录' }} · {{ entry.category }}</strong><span>{{ entry.direction }} · {{ entry.description }}<template v-if="entry.handler"> · 经手人：{{ entry.handler }}</template><template v-if="entry.witness"> · 证明人：{{ entry.witness }}</template></span><small v-if="entry.note">备注：{{ entry.note }}</small><small v-if="entry.reversal_reason">处理原因：{{ entry.reversal_reason }}</small><span v-if="entry.attachments?.length" class="fund-attachments"><a v-for="attachment in entry.attachments" :key="attachment.id" :href="attachment.download_path" target="_blank">{{ attachment.original_name }}</a></span></div><strong class="fund-amount" :class="entry.direction === '收入' ? 'positive' : 'negative'">{{ entry.direction === '收入' ? '+' : '-' }}¥ {{ money(entry.amount) }}</strong><div class="record-actions"><span class="tag" :class="entry.status === '有效' ? 'tag-green' : entry.status === '已冲正' ? 'tag-orange' : 'tag-gray'">{{ entry.status }}</span><label v-if="entry.status === '有效'" class="btn btn-sm btn-outline"><Upload :size="12" /><input type="file" hidden @change="uploadReceipt(entry, $event)">{{ entry.attachment_count ? '补凭证' : '凭证' }}</label><button v-if="entry.status === '有效' && !entry.settlement_id" class="btn btn-sm btn-outline" @click="openEdit(entry)">编辑</button><button v-if="entry.status === '有效'" class="btn btn-sm btn-outline" @click="openAction(entry, 'revoke')"><X :size="12" />撤销</button><button v-if="entry.status === '有效' && entry.settlement_id" class="btn btn-sm btn-outline" @click="openAction(entry, 'reverse')"><RotateCcw :size="12" />冲正</button></div></div></div></div>

    <div v-if="summary.migration" class="hint fund-migration-note">旧版班费工作表已迁移 {{ summary.migration.imported_entries }} 条流水；原工作表保留为历史来源，不再允许直接改写。</div>

    <div v-if="showEntry" class="modal-overlay show" @click.self="showEntry = false"><div class="modal fund-modal"><div class="modal-kicker">{{ editingId ? '修改班费流水' : '记录班费收支' }}</div><h3>{{ editingId ? '修改未结算记录' : '新增一笔分类账' }}</h3><div class="form-grid"><label>日期<input class="form-input" type="date" v-model="entryForm.occurred_at"></label><label>收支类型<select class="form-select" v-model="entryForm.direction" @change="changeDirection"><option value="收入">收入</option><option value="支出">支出</option></select></label><label>金额<input class="form-input" type="number" min="0.01" step="0.01" v-model="entryForm.amount"></label><label>分类<select class="form-select" v-model="entryForm.category_id"><option v-for="item in categoryOptions()" :key="item.id" :value="item.id">{{ item.name }}</option></select></label><label>经手人<input class="form-input" v-model="entryForm.handler" placeholder="可选"></label><label>证明人<input class="form-input" v-model="entryForm.witness" placeholder="可选"></label><label class="form-grid-wide">用途说明<textarea class="form-textarea" v-model="entryForm.description" rows="2" placeholder="说明这笔收支的用途"></textarea></label><label class="form-grid-wide">备注<input class="form-input" v-model="entryForm.note" placeholder="可选"></label><label v-if="!editingId" class="form-grid-wide">上传凭证<input class="form-input" type="file" @change="selectReceipt"></label></div><div class="modal-actions"><button class="btn btn-outline" @click="showEntry = false">取消</button><button class="btn btn-primary" @click="saveEntry">保存流水</button></div></div></div>
    <div v-if="showSettlement" class="modal-overlay show" @click.self="showSettlement = false"><div class="modal"><div class="modal-kicker">月度结算</div><h3>建立班费结算</h3><p class="hint">结算会锁定该期间的有效流水；之后请使用撤销或冲正处理更正。</p><div class="form-grid"><label>结算月份<input class="form-input" type="month" v-model="settlementForm.period_key"></label><label>盘点余额<input class="form-input" type="number" min="0" step="0.01" v-model="settlementForm.counted_balance" placeholder="留空使用账面余额"></label><label class="form-grid-wide">结算备注<textarea class="form-textarea" rows="2" v-model="settlementForm.note"></textarea></label></div><div class="modal-actions"><button class="btn btn-outline" @click="showSettlement = false">取消</button><button class="btn btn-primary" @click="createSettlement">确认结算</button></div></div></div>
    <div v-if="actionTarget" class="modal-overlay show" @click.self="actionTarget = null"><div class="modal"><div class="modal-kicker">{{ actionType === 'revoke' ? '撤销班费流水' : '冲正已结算流水' }}</div><h3>{{ actionTarget.description }} · ¥ {{ money(actionTarget.amount) }}</h3><p class="hint">{{ actionType === 'revoke' ? '原记录会保留，但不再计入余额。' : '系统会创建相反方向的新流水，并将当前结算标记为需复核。' }}</p><label v-if="actionType === 'reverse'">冲正日期<input class="form-input" type="date" v-model="actionDate"></label><textarea class="form-textarea" v-model="actionReason" rows="3" placeholder="请输入处理原因"></textarea><div class="modal-actions"><button class="btn btn-outline" @click="actionTarget = null">取消</button><button class="btn btn-primary" @click="confirmAction">确认{{ actionType === 'revoke' ? '撤销' : '冲正' }}</button></div></div></div>
    <div v-if="settlementTarget" class="modal-overlay show" @click.self="settlementTarget = null"><div class="modal"><div class="modal-kicker">结算复核 · {{ settlementTarget.period_key }}</div><h3>账面 ¥ {{ money(settlementTarget.actual_closing_balance) }}</h3><p class="hint">当前账面与原结算结余差额：¥ {{ money(settlementTarget.drift) }}</p><label>实际盘点余额<input class="form-input" type="number" min="0" step="0.01" v-model="countedBalance"></label><textarea class="form-textarea" v-model="settlementNote" rows="2" placeholder="复核备注"></textarea><div class="modal-actions"><button class="btn btn-outline" @click="settlementTarget = null">取消</button><button class="btn btn-primary" @click="reconcile">保存复核</button></div></div></div>
  </div>
</template>
