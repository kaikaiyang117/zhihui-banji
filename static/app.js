/**
 * 美美大王工作台 v2.1 - 前端应用
 * 双工作台（教师/个人）、导出功能、公式列修复
 */

// ================== 基础工具 ==================

const API = {
  async get(url) {
    const res = await fetch(url);
    return res.json();
  },
  async post(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },
  async put(url, data) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  }
};

function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function showLoading() {
  document.getElementById('main-content').innerHTML = '<div class="loading">加载中...</div>';
}

function renderPage(title, content, exportName) {
  let exportBtn = '';
  if (exportName) {
    exportBtn = `<button class="btn btn-outline btn-export" onclick="exportExcel('${exportName}')" title="下载原始Excel文件">📥 导出Excel</button>`;
  }
  document.getElementById('main-content').innerHTML = `
    <div class="page-title-bar">
      <div class="page-title">${title}</div>
      ${exportBtn}
    </div>
    ${content}
  `;
}

// 导出 Excel
function exportExcel(sheetName) {
  const url = `/api/export/${encodeURIComponent(sheetName)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast('正在下载...', 'info');
}

// ================== 通用表格组件 ==================

function renderTable(headers, rows, opts = {}) {
  if (!rows || rows.length === 0) {
    return '<div class="empty-state">暂无数据，开学后这里会热闹起来的 🎒</div>';
  }
  const { maxH } = opts;
  let html = '<div class="table-wrap"';
  if (maxH) html += ` style="max-height:${maxH}px"`;
  html += '><table class="data-table"><thead><tr>';
  html += '<th>#</th>';
  headers.forEach(h => html += `<th>${h}</th>`);
  html += '</tr></thead><tbody>';

  rows.forEach((row, i) => {
    html += '<tr>';
    html += `<td style="color:#999;font-size:11px">${i + 1}</td>`;
    row.forEach(cell => {
      const val = cell === null || cell === undefined ? '' : String(cell);
      html += `<td>${_escapeHtml(val)}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

function _escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ================== 通用添加弹窗 ==================

function showAddModal(title, fields, sheetName, onSuccess) {
  let formHtml = '<form id="modal-form" onsubmit="return false;">';
  fields.forEach(f => {
    formHtml += `<div class="form-group">
      <label>${f.label}</label>`;
    if (f.options) {
      formHtml += `<select class="form-select" name="${f.name}">
        <option value="">请选择</option>`;
      f.options.forEach(o => formHtml += `<option value="${o}">${o}</option>`);
      formHtml += '</select>';
    } else {
      formHtml += `<input class="form-input" name="${f.name}" placeholder="${f.placeholder || ''}">`;
    }
    formHtml += '</div>';
  });
  formHtml += '</form>';

  document.getElementById('modal-body').innerHTML = `
    <h3>${title}</h3>
    ${formHtml}
    <div class="modal-actions">
      <button class="btn btn-outline" type="button" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" type="button" id="modal-submit">保存</button>
    </div>
  `;
  document.getElementById('modal').classList.add('show');

  document.getElementById('modal-submit').onclick = async () => {
    const btn = document.getElementById('modal-submit');
    btn.disabled = true;
    btn.textContent = '保存中...';
    try {
      const form = document.getElementById('modal-form');
      const fd = new FormData(form);
      const data = [];
      fields.forEach(f => data.push(fd.get(f.name) || ''));
      const result = await API.post(`/api/sheet/${sheetName}/append`, { data });
      if (result.ok) {
        toast('添加成功！', 'success');
        closeModal();
        if (onSuccess) onSuccess();
      } else {
        toast(result.error || '添加失败', 'error');
      }
    } catch (e) {
      console.error('保存失败:', e);
      toast('网络错误，请检查后端是否运行', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '保存';
    }
  };
}

function closeModal() {
  document.getElementById('modal').classList.remove('show');
}

// ================== Tab 切换 ==================

let currentTab = 'teacher';
const TABS = {
  teacher: {
    dashboard: renderDashboard,
    students: renderStudents,
    special: renderSpecial,
    comments: renderComments,
    attendance: renderAttendance,
    scores: renderScores,
    points: renderPoints,
    seating: renderSeating,
    'parent-comm': renderParentComm,
    meetings: renderMeetings,
    fund: renderFund,
    diary: renderDiary,
    activities: renderActivities
  },
  personal: {
    health: renderHealth,
    kaoyan: renderKaoyan,
    knowledge: renderKnowledge
  }
};

// 顶部Tab点击
document.querySelectorAll('.top-tab').forEach(tab => {
  tab.addEventListener('click', function () {
    const tabName = this.dataset.tab;
    if (tabName === currentTab) return;
    switchTab(tabName);
  });
});

function switchTab(tabName) {
  currentTab = tabName;

  // 更新顶部Tab
  document.querySelectorAll('.top-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.top-tab[data-tab="${tabName}"]`).classList.add('active');

  // 切换导航面板
  document.querySelectorAll('.nav-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`nav-${tabName}`).classList.add('active');

  // 重置导航选中状态
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const firstItem = document.querySelector(`#nav-${tabName} .nav-item`);
  if (firstItem) firstItem.classList.add('active');

  // 加载默认首页
  const pages = TABS[tabName];
  const firstPage = Object.keys(pages)[0];
  showLoading();
  if (pages[firstPage]) pages[firstPage]();
}

// 侧边导航点击
document.addEventListener('click', function (e) {
  const navItem = e.target.closest('.nav-item');
  if (!navItem) return;

  const navPanel = navItem.closest('.nav-panel');
  if (!navPanel) return;

  // 只处理当前可见面板内的点击
  if (!navPanel.classList.contains('active')) return;

  document.querySelectorAll(`#nav-${currentTab} .nav-item`).forEach(el => el.classList.remove('active'));
  navItem.classList.add('active');

  const page = navItem.dataset.page;
  const pages = TABS[currentTab];
  showLoading();
  if (pages && pages[page]) pages[page]();
});

// 弹窗遮罩关闭
document.getElementById('modal').addEventListener('click', function (e) {
  if (e.target === this) closeModal();
});

// ================== 首页仪表盘 ==================

async function renderDashboard() {
  const stats = await API.get('/api/stats/dashboard');
  const balance = parseFloat(stats.class_fund_balance) || 0;

  renderPage('首页仪表盘', `
    <div class="overview-cards">
      <div class="overview-card">
        <div class="oc-icon blue">👥</div>
        <div><div class="oc-label">班级人数</div><div class="oc-value">${stats.total_students || 0}</div></div>
      </div>
      <div class="overview-card">
        <div class="oc-icon green">✅</div>
        <div><div class="oc-label">今日出勤</div><div class="oc-value">${stats.today_attendance?.['出勤'] || 0}</div></div>
      </div>
      <div class="overview-card">
        <div class="oc-icon orange">⏰</div>
        <div><div class="oc-label">今日迟到</div><div class="oc-value">${stats.today_attendance?.['迟到'] || 0}</div></div>
      </div>
      <div class="overview-card">
        <div class="oc-icon red">💰</div>
        <div><div class="oc-label">班费余额</div><div class="oc-value">¥${balance.toFixed(2)}</div></div>
      </div>
    </div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:18px;">
      <div class="card">
        <div class="card-title">积分排行榜 TOP5</div>
        ${renderRankList(stats.top_points || [])}
      </div>
      <div class="card">
        <div class="card-title">最近日志</div>
        ${stats.recent_logs?.length ? stats.recent_logs.map(l => `
          <div style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px;">
            <span style="color:#999;font-size:11px;">${l.date}</span>
            <span style="margin-left:8px;">${l.content}</span>
          </div>
        `).join('') : '<div class="empty-state">还没有日志记录</div>'}
      </div>
    </div>

    <div class="card">
      <div class="card-title">快捷操作</div>
      <div class="toolbar">
        <button class="btn btn-primary" onclick="quickAttendance()">📋 快速考勤签到</button>
        <button class="btn btn-outline" onclick="switchToPage('parent-comm')">📞 家校沟通</button>
        <button class="btn btn-outline" onclick="switchToPage('diary')">📝 写日志</button>
        <button class="btn btn-outline" onclick="switchToPage('scores')">📈 查看成绩</button>
      </div>
    </div>
  `, '班主任工作台.xlsx');
}

function switchToPage(page) {
  const pages = TABS[currentTab];
  const navItem = document.querySelector(`#nav-${currentTab} .nav-item[data-page="${page}"]`);
  if (navItem) {
    document.querySelectorAll(`#nav-${currentTab} .nav-item`).forEach(el => el.classList.remove('active'));
    navItem.classList.add('active');
  }
  showLoading();
  if (pages && pages[page]) pages[page]();
}

function renderRankList(students) {
  if (!students.length) return '<div class="empty-state">暂无积分数据</div>';
  let html = '<ul class="rank-list">';
  students.forEach((s, i) => {
    let cls = 'normal';
    if (i === 0) cls = 'gold';
    else if (i === 1) cls = 'silver';
    else if (i === 2) cls = 'bronze';
    html += `<li class="rank-item"><div class="rank-num ${cls}">${i + 1}</div><div class="rank-name">${s.name}</div><div class="rank-points">${s.points} 分</div></li>`;
  });
  html += '</ul>';
  return html;
}

function quickAttendance() {
  showAddModal('快速考勤签到', [
    { name: 'date', label: '日期', placeholder: '如 2026-09-01' },
    { name: 'weekday', label: '星期', options: ['周一', '周二', '周三', '周四', '周五'] },
    { name: 'student', label: '学生姓名' },
    { name: 'status', label: '出勤状态', options: ['出勤', '迟到', '请假', '缺勤'] },
    { name: 'reason', label: '备注' }
  ], '考勤管理', () => renderDashboard());
}

// ================== 学生信息 ==================

async function renderStudents() {
  const data = await API.get('/api/sheet/学生信息总表');
  let html = '<div class="card"><div class="card-title">学生信息总表</div>';
  html += '<div class="toolbar">';
  html += '<div class="search-box"><input type="text" placeholder="搜索学生姓名..." oninput="filterTable(this)"></div>';
  html += '</div>';
  html += renderTable(data.headers || [], data.rows || [], { maxH: 500 });
  html += '</div>';
  renderPage('学生信息', html, '班主任工作台.xlsx');
}

function filterTable(input) {
  const term = input.value.toLowerCase();
  document.querySelectorAll('.data-table tbody tr').forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(term) ? '' : 'none';
  });
}

// ================== 特殊学生档案 ==================

async function renderSpecial() {
  const data = await API.get('/api/sheet/特殊学生档案');
  renderPage('特殊学生档案',
    '<div class="card"><div class="card-title">特殊学生档案</div>' + renderTable(data.headers || [], data.rows || [], { maxH: 500 }) + '</div>',
    '班主任工作台.xlsx');
}

// ================== 评语管理 ==================

async function renderComments() {
  const data = await API.get('/api/sheet/评语管理');
  let html = '<div class="card"><div class="card-title">评语管理</div>';
  html += '<div class="toolbar">';
  html += '<button class="btn btn-primary" onclick="showAddModal(\'添加评语\',' + JSON.stringify([
    { name: 'student', label: '学生姓名' }, { name: 'term', label: '学期' },
    { name: 'type', label: '评语类型', options: ['学期评语', '毕业评语', '日常评语'] },
    { name: 'content', label: '评语内容' },
    { name: 'status', label: '完成状态', options: ['草稿', '已完成', '已发送'] }
  ]) + ',\'评语管理\',()=>renderComments())">✏️ 添加评语</button>';
  html += '</div>' + renderTable(data.headers || [], data.rows || [], { maxH: 500 }) + '</div>';
  renderPage('评语管理', html, '班主任工作台.xlsx');
}

// ================== 考勤管理 ==================

async function renderAttendance() {
  const [data, stats] = await Promise.all([
    API.get('/api/sheet/考勤管理'),
    API.get('/api/stats/attendance')
  ]);
  let html = '<div class="card"><div class="card-title">考勤管理</div>';
  html += '<div class="toolbar">';
  html += '<button class="btn btn-primary" onclick="quickAttendance()">📋 添加考勤</button>';
  html += '</div>' + renderTable(data.headers || [], data.rows || [], { maxH: 400 }) + '</div>';

  if (stats.status_count) {
    html += '<div class="card"><div class="card-title">考勤统计</div><div class="overview-cards">';
    const labels = { '出勤': 'green', '迟到': 'orange', '请假': 'blue', '缺勤': 'red' };
    for (const [k, v] of Object.entries(stats.status_count)) {
      const clr = labels[k] || 'blue';
      const icons = { '出勤': '✅', '迟到': '⏰', '请假': '📝', '缺勤': '❌' };
      html += `<div class="overview-card" style="min-width:120px;flex:0 0 auto;"><div class="oc-icon ${clr}">${icons[k] || '📊'}</div><div><div class="oc-label">${k}</div><div class="oc-value">${v}</div></div></div>`;
    }
    html += '</div></div>';
  }
  renderPage('考勤管理', html, '班主任工作台.xlsx');
}

// ================== 成绩跟踪 ==================

async function renderScores() {
  const stats = await API.get('/api/stats/scores');
  let html = '';

  if (stats.avg_scores) {
    html += '<div class="card"><div class="card-title">班级成绩概览</div><div class="overview-cards">';
    for (const subj of stats.subjects || []) {
      const yk = stats.avg_scores.yuekao1?.[subj] || '-';
      const qz = stats.avg_scores.qizhong?.[subj] || '-';
      html += `<div class="overview-card" style="min-width:140px;flex:0 0 auto;"><div class="oc-icon blue">📖</div><div><div class="oc-label">${subj}</div><div style="font-size:11px;color:#666;">月考:${yk} / 期中:${qz}</div></div></div>`;
    }
    html += '</div></div>';
  }

  html += '<div class="card"><div class="card-title">成绩分布图</div><div class="chart-box" id="score-chart"></div></div>';

  if (stats.students?.length) {
    html += '<div class="card"><div class="card-title">学生成绩明细</div><div class="table-wrap" style="max-height:450px"><table class="data-table"><thead><tr>';
    html += '<th>#</th><th>姓名</th><th>语文</th><th>数学</th><th>英语</th><th>政治</th><th>历史</th><th>地理</th><th>月考总分</th><th>期中总分</th><th>进退步</th>';
    html += '</tr></thead><tbody>';
    stats.students.forEach((s, i) => {
      html += `<tr><td>${i + 1}</td><td>${s.name}</td>`;
      for (let j = 0; j < 6; j++) html += `<td>${s.yuekao1[j] ?? '-'}</td>`;
      html += `<td><strong>${s.yuekao1_total ?? '-'}</strong></td>`;
      html += `<td><strong>${s.qizhong_total ?? '-'}</strong></td>`;
      const change = s.change;
      let changeHtml = '-';
      if (change !== null && change !== undefined) {
        const cls = change > 0 ? 'tag-green' : change < 0 ? 'tag-red' : '';
        const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
        changeHtml = `<span class="tag ${cls}">${arrow}${Math.abs(change)}</span>`;
      }
      html += `<td>${changeHtml}</td></tr>`;
    });
    html += '</tbody></table></div></div>';
  } else {
    html += '<div class="card"><div class="empty-state">还没有成绩数据</div></div>';
  }

  renderPage('成绩跟踪', html, '班主任工作台.xlsx');
  setTimeout(() => renderScoreChart(stats), 100);
}

function renderScoreChart(stats) {
  const dom = document.getElementById('score-chart');
  if (!dom || !stats.students?.length) return;
  const chart = echarts.init(dom);
  const names = stats.students.map(s => s.name);
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['月考1总分', '期中总分'], bottom: 0 },
    grid: { left: '3%', right: '4%', bottom: '12%', containLabel: true },
    xAxis: { type: 'category', data: names, axisLabel: { rotate: 30, fontSize: 10 } },
    yAxis: { type: 'value', name: '分数' },
    series: [
      { name: '月考1总分', type: 'bar', data: stats.students.map(s => s.yuekao1_total || 0), itemStyle: { color: '#5b6abf' } },
      { name: '期中总分', type: 'bar', data: stats.students.map(s => s.qizhong_total || 0), itemStyle: { color: '#7b93ff' } }
    ]
  });
  window.addEventListener('resize', () => chart.resize());
}

// ================== 行为积分 ==================

async function renderPoints() {
  const stats = await API.get('/api/stats/points');
  let html = '<div class="card"><div class="card-title">积分排行榜</div>';
  html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:18px;">';
  html += '<div>' + renderRankList((stats.students || []).slice(0, 10)) + '</div>';
  html += '<div class="chart-box" id="points-chart"></div>';
  html += '</div></div>';

  const data = await API.get('/api/sheet/日常行为积分');
  html += '<div class="card"><div class="card-title">积分明细</div>';
  html += '<div class="toolbar">';
  html += '<button class="btn btn-primary" onclick="showAddModal(\'添加积分\',' + JSON.stringify([
    { name: 'student', label: '学生姓名' }, { name: 'week1', label: '第1周' },
    { name: 'week2', label: '第2周' }, { name: 'week3', label: '第3周' },
    { name: 'week4', label: '第4周' }, { name: 'week5', label: '第5周' },
    { name: 'week6', label: '第6周' }, { name: 'week7', label: '第7周' }, { name: 'week8', label: '第8周' }
  ]) + ',\'日常行为积分\',()=>renderPoints())">⭐ 添加积分</button>';
  html += '</div>' + renderTable(data.headers || [], data.rows || [], { maxH: 400 }) + '</div>';

  renderPage('行为积分', html, '班主任工作台.xlsx');

  setTimeout(() => {
    const dom = document.getElementById('points-chart');
    if (!dom || !stats.students?.length) return;
    const chart = echarts.init(dom);
    const top5 = stats.students.slice(0, 5);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: top5.map(s => s.name), bottom: 0 },
      grid: { left: '3%', right: '4%', bottom: '15%', containLabel: true },
      xAxis: { type: 'category', data: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'] },
      yAxis: { type: 'value' },
      series: top5.map(s => ({ name: s.name, type: 'line', data: s.weekly }))
    });
  }, 100);
}

// ================== 座位表 ==================

async function renderSeating() {
  const data = await API.get('/api/seating');
  let html = '<div class="card"><div class="card-title">班级座位表</div>';
  let grid = data.grid || [];

  if (!grid.length || grid.length < 2) {
    html += '<div class="empty-state">座位表还是空的，在 Excel 中编辑或通过对话让我帮你排</div>';
  } else {
    let minRow = 0, maxRow = grid.length - 1, minCol = 0, maxCol = (grid[0] || []).length - 1;
    while (minRow <= maxRow && grid[minRow].every(c => !c)) minRow++;
    while (maxRow >= minRow && grid[maxRow].every(c => !c)) maxRow--;
    const actualRows = maxRow - minRow + 1, actualCols = maxCol - minCol + 1;

    if (actualRows <= 0) {
      html += '<div class="empty-state">座位表还是空的</div>';
    } else {
      html += `<div class="seating-grid" style="grid-template-columns:repeat(${actualCols},1fr);max-width:${actualCols * 70}px">`;
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          const val = (grid[r] || [])[c] || '';
          let cls = 'seat-cell';
          if (!val) cls += ' empty';
          else if (['讲台', '前门', '后门', '过道'].includes(val)) cls += ' special';
          html += `<div class="${cls}">${val}</div>`;
        }
      }
      html += '</div><div style="margin-top:10px;font-size:11px;color:#999;">修改座位请通过对话让我帮你操作</div>';
    }
  }
  html += '</div>';
  renderPage('座位表', html, '班主任工作台.xlsx');
}

// ================== 家校沟通 ==================

async function renderParentComm() {
  const data = await API.get('/api/sheet/家校沟通记录');
  let html = '<div class="card"><div class="card-title">家校沟通记录</div>';
  html += '<div class="toolbar">';
  html += '<button class="btn btn-primary" onclick="showAddModal(\'添加沟通\',' + JSON.stringify([
    { name: 'date', label: '日期' }, { name: 'student', label: '学生姓名' },
    { name: 'method', label: '沟通方式', options: ['电话', '微信', '面谈', '家访', '短信'] },
    { name: 'parent', label: '家长姓名' }, { name: 'topic', label: '沟通主题' },
    { name: 'summary', label: '沟通摘要' }, { name: 'followup', label: '后续跟进' },
    { name: 'status', label: '状态', options: ['待跟进', '已解决', '持续关注'] }
  ]) + ',\'家校沟通记录\',()=>renderParentComm())">📞 添加记录</button>';
  html += '</div>' + renderTable(data.headers || [], data.rows || [], { maxH: 450 }) + '</div>';
  renderPage('家校沟通', html, '班主任工作台.xlsx');
}

// ================== 班会记录 ==================

async function renderMeetings() {
  const data = await API.get('/api/sheet/班会记录');
  let html = '<div class="card"><div class="card-title">班会记录</div>';
  html += '<div class="toolbar">';
  html += '<button class="btn btn-primary" onclick="showAddModal(\'添加班会\',' + JSON.stringify([
    { name: 'date', label: '日期' }, { name: 'week', label: '第几周' }, { name: 'topic', label: '班会主题' },
    { name: 'format', label: '形式', options: ['主题班会', '事务通知', '团队活动', '安全教育', '心理健康'] },
    { name: 'host', label: '主持人' }, { name: 'summary', label: '内容摘要' },
    { name: 'effect', label: '效果评估' }, { name: 'notes', label: '备注' }
  ]) + ',\'班会记录\',()=>renderMeetings())">🎯 添加记录</button>';
  html += '</div>' + renderTable(data.headers || [], data.rows || [], { maxH: 450 }) + '</div>';
  renderPage('班会记录', html, '班主任工作台.xlsx');
}

// ================== 班费管理 ==================

async function renderFund() {
  const data = await API.get('/api/sheet/班费管理');
  let html = '<div class="card"><div class="card-title">班费管理</div>';
  html += '<div class="toolbar">';
  html += '<button class="btn btn-success" onclick="showAddModal(\'添加收支\',' + JSON.stringify([
    { name: 'date', label: '日期' }, { name: 'type', label: '类型', options: ['收入', '支出'] },
    { name: 'amount', label: '金额' }, { name: 'category', label: '类别' },
    { name: 'desc', label: '说明' }, { name: 'payer', label: '经手人' }
  ]) + ',\'班费管理\',()=>renderFund())">💰 添加记录</button>';
  html += '</div>' + renderTable(data.headers || [], data.rows || [], { maxH: 400 }) + '</div>';
  renderPage('班费管理', html, '班主任工作台.xlsx');
}

// ================== 班主任日志 ==================

async function renderDiary() {
  const data = await API.get('/api/sheet/班主任日志');
  let html = '<div class="card"><div class="card-title">班主任日志</div>';
  html += '<div class="toolbar">';
  html += '<button class="btn btn-primary" onclick="showAddModal(\'写日志\',' + JSON.stringify([
    { name: 'date', label: '日期' }, { name: 'weekday', label: '星期', options: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] },
    { name: 'weather', label: '天气', options: ['晴', '多云', '阴', '雨', '雪'] },
    { name: 'content', label: '今日记事' }, { name: 'good', label: '好人好事' },
    { name: 'issues', label: '存在问题' }, { name: 'plan', label: '明日计划' }
  ]) + ',\'班主任日志\',()=>renderDiary())">📝 写日志</button>';
  html += '</div>' + renderTable(data.headers || [], data.rows || [], { maxH: 450 }) + '</div>';
  renderPage('班主任日志', html, '班主任工作台.xlsx');
}

// ================== 班级活动 ==================

async function renderActivities() {
  const data = await API.get('/api/sheet/班级活动');
  let html = '<div class="card"><div class="card-title">班级活动</div>';
  html += '<div class="toolbar">';
  html += '<button class="btn btn-primary" onclick="showAddModal(\'添加活动\',' + JSON.stringify([
    { name: 'date', label: '日期' }, { name: 'name', label: '活动名称' },
    { name: 'type', label: '活动类型', options: ['文体活动', '社会实践', '志愿服务', '学科竞赛', '节日庆祝', '其他'] },
    { name: 'location', label: '地点' }, { name: 'participants', label: '参与人数' },
    { name: 'budget', label: '预算' }, { name: 'summary', label: '活动总结' }, { name: 'photos', label: '照片/附件' }
  ]) + ',\'班级活动\',()=>renderActivities())">🎉 添加活动</button>';
  html += '</div>' + renderTable(data.headers || [], data.rows || [], { maxH: 450 }) + '</div>';
  renderPage('班级活动', html, '班主任工作台.xlsx');
}

// ================== 健康管理 ==================

async function renderHealth() {
  const [weightData, exerciseData, sleepData] = await Promise.all([
    API.get('/api/sheet/体重体脂追踪'),
    API.get('/api/sheet/运动记录'),
    API.get('/api/sheet/睡眠记录')
  ]);

  let html = '';
  html += '<div class="card"><div class="card-title">体重趋势</div>';
  if (weightData.rows?.length) {
    html += '<div class="chart-box" id="weight-chart"></div>';
  } else {
    html += '<div class="empty-state">开始记录体重数据后这里会显示趋势图</div>';
  }
  html += '<div class="toolbar">';
  html += '<button class="btn btn-primary" onclick="showAddModal(\'记录体重\',' + JSON.stringify([
    { name: 'date', label: '日期' }, { name: 'weight_jin', label: '体重(斤)' },
    { name: 'weight_kg', label: '体重(kg)' }, { name: 'waist', label: '腰围(cm)' },
    { name: 'hip', label: '臀围(cm)' }, { name: 'body_fat', label: '体脂率(%)' }, { name: 'notes', label: '备注' }
  ]) + ',\'体重体脂追踪\',()=>renderHealth())">📊 添加记录</button>';
  html += '</div></div>';

  html += '<div class="card"><div class="card-title">运动记录</div>';
  html += '<div class="toolbar">';
  html += '<button class="btn btn-primary" onclick="showAddModal(\'添加运动\',' + JSON.stringify([
    { name: 'date', label: '日期' }, { name: 'time', label: '时间段' },
    { name: 'type', label: '运动类型', options: ['力量训练', '有氧', '拉伸', '散步', '其他'] },
    { name: 'duration', label: '时长(分钟)' }, { name: 'intensity', label: '强度', options: ['低', '中', '高'] },
    { name: 'calories', label: '消耗热量' }, { name: 'content', label: '具体内容' },
    { name: 'feeling', label: '感受' }, { name: 'notes', label: '备注' }
  ]) + ',\'运动记录\',()=>renderHealth())">🏃 添加记录</button>';
  html += '</div>' + renderTable(exerciseData.headers || [], exerciseData.rows || [], { maxH: 300 }) + '</div>';

  html += '<div class="card"><div class="card-title">睡眠记录</div>';
  html += '<div class="toolbar">';
  html += '<button class="btn btn-primary" onclick="showAddModal(\'添加睡眠\',' + JSON.stringify([
    { name: 'date', label: '日期' }, { name: 'bedtime', label: '入睡时间' },
    { name: 'waketime', label: '起床时间' }, { name: 'duration', label: '时长(小时)' },
    { name: 'quality', label: '睡眠质量', options: ['优', '良', '一般', '差'] },
    { name: 'dreams', label: '做梦', options: ['无梦', '有梦', '噩梦'] }, { name: 'notes', label: '备注' }
  ]) + ',\'睡眠记录\',()=>renderHealth())">😴 添加记录</button>';
  html += '</div>' + renderTable(sleepData.headers || [], sleepData.rows || [], { maxH: 250 }) + '</div>';

  renderPage('健康追踪', html, '健康追踪表.xlsx');

  if (weightData.rows?.length) {
    setTimeout(() => {
      const dom = document.getElementById('weight-chart');
      if (!dom) return;
      const chart = echarts.init(dom);
      const dates = weightData.rows.map(r => String(r[0] || ''));
      const weights = weightData.rows.map(r => parseFloat(r[1]) || 0);
      chart.setOption({
        tooltip: { trigger: 'axis' },
        grid: { left: '3%', right: '4%', bottom: '5%', containLabel: true },
        xAxis: { type: 'category', data: dates },
        yAxis: { type: 'value', name: '体重(斤)', min: val => Math.floor(val * 0.9) },
        series: [{
          name: '体重', type: 'line', data: weights,
          markLine: { data: [{ yAxis: 120, name: '目标120斤' }] },
          itemStyle: { color: '#1D9E75' },
          areaStyle: { color: 'rgba(29,158,117,0.15)' }
        }]
      });
    }, 100);
  }
}

// ================== 考研备考（预留） ==================

function renderKaoyan() {
  renderPage('考研备考', `
    <div class="card">
      <div class="card-title">考研备考工作台</div>
      <div style="text-align:center;padding:40px;">
        <div style="font-size:48px;margin-bottom:16px;">📚</div>
        <div style="font-size:16px;color:#555;margin-bottom:8px;">考研备考系统即将上线</div>
        <div style="font-size:13px;color:#999;">
          包含：学习计划制定、知识点追踪、真题练习、进度统计<br>
          通过对话告诉我你的需求，我会帮你搭建起来
        </div>
      </div>
    </div>
  `);
}

// ================== 知识库 ==================

async function renderKnowledge() {
  const data = await API.get('/api/knowledge/notes');
  const notes = data.notes || [];
  const categories = data.categories || [];

  let notesByCategory = {};
  categories.forEach(c => { notesByCategory[c] = []; });
  notesByCategory['未分类'] = [];
  notes.forEach(n => {
    const cat = categories.includes(n.category) ? n.category : '未分类';
    if (!notesByCategory[cat]) notesByCategory[cat] = [];
    notesByCategory[cat].push(n);
  });

  let html = '';

  html += '<div class="card"><div class="card-title">快速创建笔记</div>';
  html += '<div class="toolbar">';
  html += '<button class="btn btn-primary" onclick="quickCreateNote()">📝 新建笔记</button>';
  const templateItems = [
    { id: '备课笔记', icon: '📖', label: '备课笔记' },
    { id: '班会记录', icon: '🎯', label: '班会记录' },
    { id: '班主任日志', icon: '📝', label: '班主任日志' },
    { id: '学生档案', icon: '👤', label: '学生档案' },
    { id: '考研知识点', icon: '📚', label: '考研知识点' },
    { id: '读书笔记', icon: '📕', label: '读书笔记' },
  ];
  templateItems.forEach(t => {
    html += `<button class="btn btn-outline" onclick="quickCreateNote('${t.id}')">${t.icon} ${t.label}</button>`;
  });
  html += '</div>';
  html += '<div class="toolbar" style="margin-top:8px;">';
  html += '<button class="btn btn-outline" onclick="window.open(\'obsidian://open?vault=知识库\')" title="在 Obsidian 中打开知识库">🔗 打开 Obsidian</button>';
  html += '</div></div>';

  for (const [cat, catNotes] of Object.entries(notesByCategory)) {
    if (catNotes.length === 0) continue;
    html += `<div class="card"><div class="card-title">${cat} (${catNotes.length})</div>`;
    html += '<div style="display:flex;flex-wrap:wrap;gap:8px;">';
    catNotes.forEach(n => {
      const d = new Date(n.modified * 1000);
      const dateStr = `${d.getMonth()+1}/${d.getDate()}`;
      const kbPath = encodeURIComponent(n.relative_path);
      html += `<div class="note-card" style="flex:0 0 auto;min-width:160px;padding:12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:all 0.2s;"
        onmouseover="this.style.borderColor='var(--primary)';this.style.background='var(--primary-light)'"
        onmouseout="this.style.borderColor='var(--border)';this.style.background='#fff'"
        onclick="openObsidianNote('${kbPath}')">
        <div style="font-size:13px;font-weight:500;margin-bottom:4px;">${_escapeHtml(n.name)}</div>
        <div style="font-size:11px;color:#999;">${dateStr} · ${formatFileSize(n.size)}</div>
        <a href="obsidian://open?vault=知识库&file=${kbPath.replace('.md','')}" style="font-size:10px;color:var(--primary);text-decoration:none;display:inline-block;margin-top:4px;" onclick="event.stopPropagation()">在 Obsidian 中打开</a>
      </div>`;
    });
    html += '</div></div>';
  }
  if (Object.values(notesByCategory).every(arr => arr.length === 0)) {
    html += '<div class="card"><div class="empty-state">知识库还是空的，点击上方按钮创建第一篇笔记吧 📝</div></div>';
  }
  renderPage('知识库', html);
}

function formatFileSize(bytes) {
  if (!bytes) return '0B';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + 'KB';
  return (bytes/(1024*1024)).toFixed(1) + 'MB';
}

function openObsidianNote(relpath) {
  const vault = '知识库';
  const file = relpath.replace('.md', '').replace(/\\/g, '/');
  window.open(`obsidian://open?vault=${vault}&file=${encodeURIComponent(file)}`, '_blank');
}

function quickCreateNote(templateLabel) {
  const categories = (window._kbCategories && window._kbCategories.length > 0)
    ? window._kbCategories
    : ['班主任工作', '教学资源', '考研备考', '个人成长', '心理学读书'];

  let fields = [
    { name: 'title', label: '笔记标题', placeholder: '输入标题...' },
    { name: 'category', label: '分类', options: categories }
  ];

  if (templateLabel) {
    fields.push({ name: 'template', label: '模板', options: [templateLabel] });
  } else {
    fields.push({ name: 'template', label: '模板(可选)', options: ['无模板','备课笔记','班会记录','班主任日志','学生档案','考研知识点','读书笔记'] });
  }

  showAddModal(
    templateLabel ? `新建${templateLabel}` : '新建笔记',
    fields,
    null,
    null
  );

  const origSubmit = document.getElementById('modal-submit').onclick;
  document.getElementById('modal-submit').onclick = async () => {
    const btn = document.getElementById('modal-submit');
    btn.disabled = true;
    btn.textContent = '创建中...';
    try {
      const form = document.getElementById('modal-form');
      const fd = new FormData(form);
      const title = fd.get('title');
      const category = fd.get('category');
      const tmpl = fd.get('template');
      const result = await API.post('/api/knowledge/create', {
        title: title || '',
        category: category || '个人成长',
        template: tmpl === '无模板' ? '' : (tmpl || '')
      });
      if (result.ok) {
        toast('笔记创建成功！', 'success');
        closeModal();
        renderKnowledge();
      } else {
        toast(result.error || '创建失败', 'error');
      }
    } catch (e) {
      console.error('创建笔记失败:', e);
      toast('网络错误', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '保存';
    }
  };
}

// 预加载知识库分类
(async function preloadCategories() {
  try {
    const data = await API.get('/api/knowledge/notes');
    window._kbCategories = data.categories || [];
  } catch (e) {}
})();

// ================== 启动 ==================
renderDashboard();
