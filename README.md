# 智汇·班记 v2.3

面向一线班主任与教师的**本地个人工作台**，集班级管理、健康管理、知识库于一体。SQLite 存数据、Excel 仅导入导出，Vue 3 前端组件化，断网可用，隐私可控。

> 页脚标语："智汇·班记 · 凯凯为你值守"

当前桌面发布版本为 `v1.0.4`，可从 [GitHub Releases](https://github.com/aitia0718/workbench/releases/tag/v1.0.4) 下载 Windows x64、macOS Apple Silicon 和 macOS Intel 安装包。当前版本未配置代码签名证书，首次安装可能出现系统安全提示；仅建议在可信环境中使用。

桌面安装包基于 **Electron 桌面壳**：双击直接打开工作台窗口（不再自动打开浏览器），由 Electron 管理窗口、系统托盘、后端子进程和更新安装；手机和平板仍通过局域网二维码访问。

产品采用“本地桌面主程序 + 局域网移动访问端”方案：电脑保存唯一 SQLite 数据，手机和平板通过同一 Wi-Fi 下的浏览器和二维码访问，不需要安装独立 App。

---

## 1. 功能总览

工作台分为两大模块（顶部 Tab 切换）：

### 🏫 教师工作台

| 功能 | 说明 |
|------|------|
| 今日工作台 | 逾期/今日/未来行动、本月日历、未来 7 天安排、考勤规则命中、材料进度、待复查学生和完成/延期直达 |
| 高中课程表 | 当前班级/学期周课表、单双周、节次时间、临时调课/代课/停课/考试/活动、Excel 导入与首页今日课程 |
| 学生信息 | 学生总表 + 搜索 + **Excel 批量导入（按学号合并去重）** + 导出 |
| 特殊学生档案 | 重点关注学生档案管理 |
| 评语管理 | AI/模板生成草稿、事实依据提示、缺失值预览、人工保护、审核完成、版本历史与 Excel 导出 |
| 考勤管理 | 五类点名场景、出勤/迟到/请假/早退/缺勤、批量备注、学生/月/周统计、异常规则自动跟进 + **日期筛选汇总报表导出** |
| 成绩跟踪 | 四川`3+1+2`标准科目、学生组合批量登记、科目/考试配置、长宽表预览导入、缺考口径、班级均值/排名/分层、个人变化、异常跟进 + **单次考试汇总报表导出** |
| 行为积分 | 结构化加扣分流水 + 学年排行榜 + 月度趋势 + 分类统计 |
| 座位表 | 可视化班级座位网格（讲台/过道特殊标识） |
| 家校沟通 | 电话/微信/面谈/家访记录与跟进状态 |
| 班会记录 | 结构化班会、模板、参与学生、结论、行动项和统一工作项 |
| 班费管理 | 分类账、余额重算、月度结算、凭证与冲正 |
| 班主任日志 | 月历日志、学生/事件/待办/班会/活动关联 |
| 班级活动 | 参与学生、预算、附件、结果、复盘和跟进工作项 |
| 报告与学期档案 | 学期总结、学业与选科分析、班级运行、AI 草稿、来源追溯、只读归档和 Excel 导出 |
| 凯凯 Agent | 网页/微信 iLink 查询、规划、会话管理、统计，以及确认后低风险写入 |
| 回收站与审计 | 核心记录软删除、原位恢复、操作追踪、脱敏日志和本机确认永久删除 |
| Excel 导出 | **每个工作表 + 成绩/考勤汇总报表**一键下载 xlsx |

### 👤 个人工作台

| 功能 | 说明 |
|------|------|
| 健康追踪 | 可编辑目标、体重/运动/睡眠/饮食记录、周期汇总、复盘、提醒和汇总导出 |
| 考研备考 | 入口保留，当前暂缓开发 |
| 知识库 | 站内 Markdown 创建、搜索、标签、编辑预览、来源关联和 Obsidian 集成 |

---

## 2. 技术栈（v2.3）

| 层 | v2.2（旧） | v2.3（当前） |
|----|-----------|-----------|
| 后端 | Flask + openpyxl 直写 Excel | **Node.js + Fastify + TypeScript** |
| 数据库 | Excel 文件（公式 hack） | **SQLite（WAL 模式、事务安全）** |
| Excel | 读写存储层 | **仅导入/导出层**（ExcelJS） |
| 前端 | 原生 JS 拼 HTML | **Vue 3 + Vite + Vue Router + ECharts** |
| 图表 | ECharts（CDN 本地文件） | ECharts（ESM import） |
| API 文档 | 无 | **自动 OpenAPI（`/docs`）** |

---

## 3. 项目结构

```
智汇·班记/
├── 启动工作台.bat
├── 启动工作台.command
├── docs/                           # 用户手册、开发计划、Agent 和发布文档
│   ├── 用户手册.md                 # 教师、个人工作台和 Agent 使用说明
│   ├── 系统功能开发计划.md         # 系统业务能力的工作包与收口状态
│   ├── Agent能力矩阵.md             # Agent 工具、参数、权限与测试登记
│   ├── Agent与微信接入配置.md       # 模型、网页 Agent 和微信 iLink 配置
│   ├── Agent回归报告.md             # 固定样例和自动回归基线
│   ├── 移动端适配验收记录.md        # 响应式实现与真实设备验收项
│   ├── 开发与发布流程.md
│   ├── 发布检查清单.md
│   └── archive/                      # 已完成迁移方案等历史审计资料
├── backend/static/                 # Vite 前端构建产物
├── server/                         # Node.js/TypeScript 后端
│   ├── src/entry.ts                # CLI / Electron 共用入口
│   ├── src/app.ts                  # Fastify 应用工厂
│   ├── src/db/                     # SQLite 连接、schema 与迁移
│   ├── src/services/               # 页面和 Agent 共用业务服务
│   ├── src/agent/                  # LangGraph Agent 核心
│   ├── src/wechat/                 # 微信 iLink 渠道适配
│   └── src/http/routes/             # HTTP API 路由
├── scripts/                        # 开发环境、UI 冒烟测试脚本
├── server/tests/                   # 隔离 SQLite Node 后端测试与测试夹具
├── packaging/                      # 桌面打包配置与构建脚本
├── desktop/                        # Electron 桌面壳（窗口/托盘/Node 后端生命周期/更新安装）
│   ├── main.js / preload.js        # 主进程与受限 IPC 桥
│   ├── electron-builder.yml        # Windows/macOS 安装包配置
│   └── tests/smoke.mjs             # Electron 冒烟测试
├── frontend/                       # 前端（Vue 3 + Vite）
│   ├── package.json
│   ├── vite.config.js              # 构建到 ../backend/static
│   ├── index.html
│   └── src/
│       ├── main.js / App.vue       # 双工作台布局
│       ├── router.js               # hash 路由
│       ├── api.js                  # fetch 封装
│       ├── sheets.js               # 导航配置 + 各表字段定义
│       ├── style.css
│       ├── components/             # DataTable, AddModal, SheetPage
│       └── views/                  # 页面
│           ├── Dashboard.vue  StudentDetail.vue  Students.vue
│           ├── Events.vue  Tasks.vue  Attendance.vue  ParentComm.vue
│           ├── Special.vue  Scores.vue  Points.vue  Seating.vue
│           └── + 个人工作台与通用工作表页面
├── data/
│   └── workbench.db                # SQLite 数据库（WAL 模式）
├── 班主任工作台/                   # 旧 Excel（保留作归档）
├── 健康管理/                       # 健康文档与健康提醒工具
└── 知识库/                         # Obsidian Vault（Markdown）
```

---

## 4. 架构设计

### 4.1 总体架构

```
Electron 桌面壳（窗口/托盘/单实例/更新安装协调）
      │  启动 Node.js 后端，健康检查后加载 127.0.0.1
      ▼
浏览器 (Vue 3 SPA, Vite build) ←── 手机/平板经局域网二维码访问同一 SPA
      │  fetch /api/*
      ▼
Node.js :: Fastify
      │  TypeScript / schema 校验
      ▼
   Services
   ├── 导入/导出（ExcelJS）
   ├── 结构化业务服务（学生/成绩/考勤/任务/评语/班费等）
   ├── 旧通用工作表兼容派生计算（成绩/积分/余额/腰臀比）
   └── 知识库（文件系统）
      │
      ▼
   SQLite (WAL, per-thread connections, atomic commit)

Agent 请求路径：

```
网页 Agent / 微信 iLink
          │
          ▼
Planner → Runner → 工具注册与权限/审计 → 业务 Services → SQLite
```

网页和微信渠道共享 Agent 核心，但使用独立会话命名空间；微信当前按微信用户维持一个主会话，写入工具必须经过预览和明确确认。
```

**核心理念**：SQLite 存结构化核心业务数据和仍在过渡期的通用 JSON 行；Excel 仅作为“导入模板 + 导出报表”的外部交换格式，不再用作运行时数据库。

### 4.2 存储设计

| 存储 | 内容 | 设计 |
|------|------|------|
| `students` 表 | 学号(PK)、姓名、性别...13 列 | 结构化，学号唯一 → 导入去重的依据 |
| `attendance_records` 表 | 日期、场景、学生、状态、原因、到离校时间、备注 | 结构化考勤事实，同一学生/日期/场景唯一 |
| `attendance_rules` / `attendance_rule_runs` / `attendance_rule_hits` | 规则、执行批次、学生命中状态 | 自动评估、幂等跟进和执行历史 |
| `exam_records` 表 | 学生、考试、科目、分数、状态、排名 | 结构化成绩事实；缺考、免考和未录入不按 0 分处理 |
| `score_exams` / `score_subjects` / `score_exam_subjects` | 考试、科目、满分和应考科目 | 按班级和学期维护成绩配置 |
| `score_import_runs` / `score_rules` / `score_rule_runs` / `score_rule_hits` | 导入批次、异常规则、执行与命中 | 原子导入、幂等跟进和状态追溯 |
| `point_rules` / `point_ledger` / `point_rule_hits` | 行为积分规则、积分流水和命中 | 有效流水重算、撤销审计和异常跟进 |
| `fund_categories` / `fund_ledger` / `fund_settlements` / `fund_attachments` | 班费分类、账务、结算和凭证 | 余额重算、结算锁定、撤销/冲正和凭证追溯 |
| `sheet_meta` 表 | 工作表名 → 表头 JSON、分类 | 通用工作表元数据 |
| `sheet_rows` 表 | 工作表名 + 行号 → 行数据 JSON | 尚未结构化的通用表数据 |
| `seating` 表 | 行列座标 → 值 | 座位网格 |
| 知识库 | Markdown 文件 | Obsidian Vault（根目录 `知识库/`） |

### 4.3 派生计算层 (`derived.py`)

替代旧架构的 Excel 公式 hack，在数据读取时对以下工作表做实时计算：

| 工作表 | 计算列 | 逻辑 |
|--------|--------|------|
| 旧版成绩工作表 | 总分月考1/总分期中/进退步 | 仅保留旧通用工作表兼容；当前成绩页面由结构化成绩服务实时统计 |
| 日常行为积分 | 学年汇总/排名 | 有效流水按学年聚合 / 排序生成排名 |
| 班费管理 | 余额 | 结构化账务中未撤销记录的收入 - 支出 |
| 体重体脂追踪 | 腰臀比/与上周对比 | 腰围÷臀围 / 本周−上周 |

导出时一并写入 xlsx。

### 4.4 API 概览

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/sheets` | 列出全部工作表 |
| GET | `/api/sheet/<name>` | 读取（含派生计算列） |
| POST | `/api/sheet/<name>/append` | 追加行 |
| PUT | `/api/sheet/<name>/update` | 更新单元格 |
| DELETE | `/api/sheet/<name>/row/<row_no>` | 将工作表行移入回收站 |
| GET | `/api/students` | 学生列表（支持 keyword 搜索） |
| DELETE | `/api/students/<id>` | 将学生移入回收站 |
| DELETE | `/api/records/<object_type>/<id>` | 将核心业务记录移入回收站 |
| GET | `/api/recycle-bin` | 查看当前班级/学期回收站 |
| POST | `/api/recycle-bin/<id>/restore` | 恢复记录 |
| DELETE | `/api/recycle-bin/<id>/purge` | 本机二次确认后永久删除 |
| GET | `/api/system/audit` | 查看脱敏后的系统业务审计 |
| GET | `/api/students/template` | 下载导入模板 xlsx |
| POST | `/api/students/import` | **上传 Excel 导入（按学号合并/故障行报告）** |
| GET | `/api/students/export` | 导出学生信息 |
| GET | `/api/score-config` | 查询当前班级/学期的考试和科目配置 |
| POST | `/api/exams/import/preview` | 预览长表或宽表成绩文件，不写入数据库 |
| POST | `/api/exams/import/commit` | 再次校验并原子提交预览中的有效成绩 |
| GET | `/api/exams/summary` | 查询班级与学生成绩、排名、分层和变化统计 |
| GET/POST/PUT | `/api/school-calendar` | 查询、手工维护当前学期校历日期 |
| GET | `/api/school-calendar/term` | 返回当前班级/学期的完整周次校历视图 |
| POST | `/api/school-calendar/import/preview` | 预览学校行事历矩阵或日期明细 Excel，不写入数据库 |
| POST | `/api/school-calendar/import/commit` | 再次校验并原子提交校历预览中的有效日期 |
| GET | `/api/timetable`、`/api/timetable/day`、`/api/timetable/changes` | 查询周课表、指定日期课程和临时调课 |
| GET/POST/PUT | `/api/timetable/periods`、`/api/timetable/entries`、`/api/timetable/changes` | 维护节次、固定课程和临时课程变更 |
| POST | `/api/timetable/import/preview`、`/api/timetable/import/commit` | 预览并原子提交课程表 Excel 导入 |
| GET | `/api/timetable/template` | 下载课程表导入模板 xlsx |
| GET | `/api/stats/calendar` | 返回个人工作台当前月份和未来 7 天的校历/待办聚合 |
| GET/POST/PUT | `/api/comments/*` | 评语模板、AI/批量预览生成、人工草稿、审核流转、版本历史 |
| GET | `/api/comments/print` | 旧版评语打印接口（页面不再提供入口） |
| GET/POST | `/api/score-rules` | 查询或创建成绩异常跟进规则 |
| POST | `/api/score-rules/evaluate` | 手工重新评估成绩异常规则 |
| GET | `/api/export/sheet/<name>` | **导出任意工作表 xlsx** |
| GET | `/api/export/report/scores?exam=` | **成绩汇总报表** |
| GET | `/api/export/report/attendance?date_from=&date_to=` | **考勤汇总报表** |
| GET | `/api/seating` | 座位表 |
| GET | `/api/stats/*` | 仪表盘/考勤统计/成绩统计/积分统计 |
| GET/POST | `/api/knowledge/*` | 知识库笔记 |
| GET/POST/PUT/DELETE | `/api/education/meetings`、`/api/education/activities`、`/api/education/diary` | 班会、活动、日志与行动关联 |
| GET/POST | `/api/reports/preview`、`/api/reports/archives*`、`/api/reports/ai/preview` | 学期档案预览、AI 草稿、归档与导出；保留旧报告类型兼容 |
| GET/POST/PUT | `/api/health/*` | 个人健康目标、周期汇总、复盘、提醒和汇总导出 |
| GET/POST | `/api/agent/chat`、`/api/agent/chat/stream` | Agent 普通和 SSE 流式对话 |
| GET/POST/PUT/DELETE | `/api/agent/sessions*`、`/api/agent/usage`、`/api/agent/actions*` | Agent 会话管理、使用统计和确认写入 |
| GET/PUT/POST | `/api/agent/config`、`/api/wechat/*` | 模型配置、微信 iLink 登录、状态和消息循环 |

### P0 学生管理闭环

- `/api/students/{id}/detail`：学生全景页与成长时间线
- `/api/events`：学生事件记录，支持自动创建跟进事项
- `/api/tasks`、`/api/tasks/summary`：统一工作项、来源、时间筛选、日历、负责人、延期、完成结果和取消
- `/api/focus`：关注事项生命周期
- `/api/communications`：结构化家校沟通与回访
- `/api/workflows/{source_type}/{source_id}`：事件、沟通、关注的过程记录、复查和工作项状态联动
- `/api/attendance/daily`、`/api/attendance/records`：按日期和场景批量保存、读取全班考勤
- `/api/attendance/rules`：管理规则、查看命中状态与执行历史，支持手工补充检查
- `/api/stats/attendance`：按日期范围和场景统计学生、月份、周次及异常名单
- `/api/score-config`、`/api/exams/*`：配置考试科目、预览并提交成绩、查询结构化统计
- `/api/score-rules`：管理成绩下降规则，幂等生成工作项并联动学生时间线
- `/api/comments`：AI/模板评语草稿、缺失变量确认、人工修改保护、审核交付和版本回溯
- `/api/system/backup`、`/api/system/restore`：本地数据库备份与恢复

## 开发测试

开发启动脚本默认将业务日期设为 `2026-04-15`（春季学期内的正常上课日），用于验证今日工作台、待办、考勤和 Agent 日期判断。它不修改电脑系统时间或数据库真实时间；设置 `WORKBENCH_BUSINESS_DATE=` 可恢复使用系统日期。

补充开发/演示数据（只新增、可重复执行；默认 `demo` 写入当前数据库前会自动备份）：

```bash
node scripts/seed-demo-data.mjs --dry-run
node scripts/seed-demo-data.mjs --profile=demo
```

脚本支持三种可重复生成的数据配置：

```bash
# 隔离的最小数据：1 个班级、8 名学生、课程表、考试、考勤、待办、沟通和证据
node scripts/seed-demo-data.mjs --profile=minimal --data-dir=/path/to/test-data --no-backup

# 边界数据：在 minimal 基础上增加一个没有学生和课表的空班级
node scripts/seed-demo-data.mjs --profile=edge --data-dir=/path/to/test-data --no-backup

# 检查数据是否完整
node scripts/verify-test-data.mjs --profile=minimal --data-dir=/path/to/test-data
```

`demo` 会补齐课程表、临时调课、多班级教师关联、考试、工作入口、家校通知模板和一条明确标注的演示证据占位图片；不会删除已有数据，也不会伪造真实家长材料。`minimal` 和 `edge` 在指定目录不存在数据库时会自动初始化 schema，适合 UI 冒烟和本地回归，不会污染 `data/workbench.db`。

推荐使用根目录快捷命令：

```bash
npm run data:seed:minimal
npm run data:verify:minimal
npm run test:all
```

Node 后端使用隔离 SQLite 测试数据，不会修改 `data/workbench.db`：

```bash
cd server
npm run typecheck:server
npm run test:server
npm run build:server
```

前端构建：

```bash
cd frontend
npm run build
```

浏览器冒烟测试（脚本会自动创建隔离的 minimal 数据，不使用当前开发数据库）：

```bash
bash scripts/smoke-ui.sh
```

Electron 桌面壳冒烟测试（需要 Node.js，使用临时数据目录）：

```bash
cd desktop && npm install && npm test
```

CI 会自动执行 Node 后端测试、前端构建、浏览器冒烟和 Electron 冒烟测试；完整发布检查见 [`docs/发布检查清单.md`](docs/发布检查清单.md)。

### 文档分工

- `README.md`：项目定位、架构、目录和快速开始。
- `功能清单.md`：按系统功能盘点当前实现和后续缺口。
- `docs/系统功能开发计划.md`：系统业务能力的工作包、依赖和验收状态。
- `docs/Agent能力矩阵.md`：Agent 工具的参数、权限、渠道和测试登记，也是后续评测与预留方向的单一事实来源。
- `docs/Agent与微信接入配置.md`：模型、网页 Agent、微信 iLink 和写入确认的配置说明。
- `docs/用户手册.md`：面向教师的日常使用说明；`docs/发布检查清单.md` 保留尚未完成的实机验收项。

---

## 5. 快速开始

### 环境要求
- Windows、macOS 或 Linux
- Node.js 22.x（以项目根目录 `.nvmrc` 为准）
- Obsidian（知识库功能可选）

### 首次安装

macOS/Linux：

```bash
./scripts/setup-dev.sh
```

Windows PowerShell：

```powershell
.\scripts\setup-dev.ps1
```

这两个脚本会检查 Node.js 版本，安装前端、Node 后端和 Electron 依赖，并构建 Node 后端。也可以按下面步骤手动安装：

```bash
# 1. 前端构建
cd frontend
npm install
npm run build

# 2. Node 后端
cd ../server
npm install
npm run build:server

# 3. Electron
cd ../desktop
npm install
npm run dev
```

桌面壳开发模式（使用源码后端，打开 Electron 窗口）：

```bash
cd desktop
npm install
npm run dev
```

### 日常使用
```bat
双击 启动工作台.bat
```

macOS 使用：

```bash
双击 启动工作台.command
```

Windows 双击 `启动工作台.bat` 时会自动启动 Vite 前端调试服务并启用热更新；macOS 源码入口仍加载已经构建好的本地页面。正式长期使用仍建议安装 GitHub Release 提供的桌面安装包。

如果使用 GitHub Release 安装包，则不需要安装 Python 或 Node.js，直接运行安装后的桌面程序即可。安装包是 Electron 桌面客户端：双击打开工作台窗口，关闭窗口会隐藏到系统托盘，托盘“退出工作台”才停止服务。

安装包启动后默认允许同一局域网中的手机和平板访问。进入工作台后点击右上角“手机访问”，使用手机或平板扫描二维码即可打开。

### 局域网访问（开发模式）

电脑作为本地数据主机时，也可以使用以下命令启动局域网模式：

```bash
cd desktop
npm run dev -- --lan
```

程序默认已经监听可信局域网地址；`--lan` 用于显式指定局域网模式。点击“手机访问”后会生成 5 分钟有效、仅可使用一次的配对二维码；配对设备获得 90 天有效的本地凭证，可在电脑端查看最近访问时间、单独撤权或全部撤权，也可在移动端主动退出。凭证只保存哈希到 SQLite，服务重启后仍有效。局域网模式仅适用于可信网络，不要将端口映射到公网。桌面打包说明见 [`packaging/README.md`](packaging/README.md)。

发布前还会运行浏览器 UI 冒烟测试，检查工作台页面、二维码入口和更新入口能够加载：

```bash
npx playwright install chromium
bash scripts/smoke-ui.sh
```

### 数据备份
- 开发模式备份 `data/workbench.db`；打包模式备份系统用户数据目录中的 `workbench.db`（一个文件 = 全部结构化数据）
- 同时备份 `知识库/` 目录（Markdown 笔记）；打包模式默认位于系统用户数据目录
- 也可以在工作台首页点击“备份数据”，系统会创建带完整性校验的数据库备份
- 需要换电脑时，在首页“更多操作”中导出/导入“迁移包”；迁移包包含数据库、业务附件和知识库，会自动排除模型配置、微信凭证和旧备份
- 旧 Excel 文件在 `班主任工作台/` 和 `健康管理/` 中保留不动

---

## 6. 与旧架构的差异（v2.2 → v2.3）

| 旧 | 新 |
|----|----|
| Excel 公式列需手动 hack | SQL 实时计算，零公式 |
| 每次保存重写整个 xlsx | SQLite 事务提交，崩溃安全 |
| 原生 JS 单个 848 行文件 | 17 个 Vue SFC 组件，按路由懒加载 |
| 导出原始 xlsx 文件 | 从 SQLite 重新生成 xlsx + 汇总报表 |
| 无导入功能 | 学生信息 Excel 模板导入 + 按学号合并 |
| 无 API 文档 | Fastify 自动生成 `/docs` |

---

## 7. 已知边界

- **考研备考**：入口保留但当前明确暂缓；若未来确认有持续使用场景，另建独立需求和执行计划
- **单元格编辑**：前端目前通过添加/删除管理数据，无单元格直接编辑 UI（可扩展）
- **学生导入告警**：含缺学号行提示、合并/新增计数
- **默认监听 `0.0.0.0` 以支持局域网访问**，数据不会上传云端；请勿做端口映射或在不可信网络中启动
- **手机和平板依赖电脑运行**，电脑关闭后局域网访问不可用
- **当前安装包未签名**，正式对外分发前需要配置 Windows 和 Apple 签名凭证
