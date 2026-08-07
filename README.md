# 美美大王工作台 v2.3

面向一线班主任与教师的**本地个人工作台**，集班级管理、健康管理、知识库于一体。SQLite 存数据、Excel 仅导入导出，Vue 3 前端组件化，断网可用，隐私可控。

> 页脚标语："凯凯小兵 🛡️ 为你值守"

当前桌面发布版本为 `v1.0.4`，可从 [GitHub Releases](https://github.com/aitia0718/workbench/releases/tag/v1.0.4) 下载 Windows x64、macOS Apple Silicon 和 macOS Intel 安装包。当前版本未配置代码签名证书，首次安装可能出现系统安全提示；仅建议在可信环境中使用。

产品采用“本地桌面主程序 + 局域网移动访问端”方案：电脑保存唯一 SQLite 数据，手机和平板通过同一 Wi-Fi 下的浏览器和二维码访问，不需要安装独立 App。

---

## 1. 功能总览

工作台分为两大模块（顶部 Tab 切换）：

### 🏫 教师工作台

| 功能 | 说明 |
|------|------|
| 今日工作台 | 逾期/今日/未来行动、考勤规则命中、材料进度、待复查学生和完成/延期直达 |
| 学生信息 | 学生总表 + 搜索 + **Excel 批量导入（按学号合并去重）** + 导出 |
| 特殊学生档案 | 重点关注学生档案管理 |
| 评语管理 | 学期/毕业/日常评语 |
| 考勤管理 | 五类点名场景、出勤/迟到/请假/早退/缺勤、批量备注、学生/月/周统计、异常规则自动跟进 + **日期筛选汇总报表导出** |
| 成绩跟踪 | 科目/考试配置、长宽表预览导入、缺考口径、班级均值/排名/分层、个人变化、异常跟进 + **单次考试汇总报表导出** |
| 行为积分 | 结构化加扣分流水 + 排行榜 + 周期趋势 + 异常规则 |
| 座位表 | 可视化班级座位网格（讲台/过道特殊标识） |
| 家校沟通 | 电话/微信/面谈/家访记录与跟进状态 |
| 班会记录 | 班会主题、形式、效果评估 |
| 班费管理 | 分类账、余额重算、月度结算、凭证与冲正 |
| 班主任日志 | 每日记事 + 待办 |
| 班级活动 | 活动类型、预算、总结 |
| 回收站与审计 | 核心记录软删除、原位恢复、操作追踪、脱敏日志和本机确认永久删除 |
| Excel 导出 | **每个工作表 + 成绩/考勤汇总报表**一键下载 xlsx |

### 👤 个人工作台

| 功能 | 说明 |
|------|------|
| 健康追踪 | 体重趋势图（目标线）、运动记录、睡眠记录 |
| 考研备考 | 预留页面 |
| 知识库 | Obsidian 集成 Markdown 笔记、6 种模板、分类浏览 |

---

## 2. 技术栈（v2.3）

| 层 | v2.2（旧） | v2.3（当前） |
|----|-----------|-----------|
| 后端 | Flask + openpyxl 直写 Excel | **FastAPI + Uvicorn** |
| 数据库 | Excel 文件（公式 hack） | **SQLite（WAL 模式、事务安全）** |
| Excel | 读写存储层 | **仅导入/导出层**（openpyxl） |
| 前端 | 原生 JS 拼 HTML | **Vue 3 + Vite + Vue Router + ECharts** |
| 图表 | ECharts（CDN 本地文件） | ECharts（ESM import） |
| API 文档 | 无 | **自动 OpenAPI（`/docs`）** |

---

## 3. 项目结构

```
美美大王工作台/
├── 启动工作台.bat
├── 启动工作台.command
├── docs/                           # 用户手册、发布检查和适配记录
│   ├── 用户手册.md
│   ├── 开发与发布流程.md
│   └── 发布检查清单.md
├── backend/                        # 后端
│   ├── run.py                      # uvicorn 入口
│   ├── requirements.txt            # fastapi, uvicorn, python-multipart, openpyxl
│   ├── migrate.py                  # 旧 Excel → SQLite 迁移（已执行）
│   ├── static/                     # 前端构建产物（Vite build 自动产出）
│   │   ├── index.html
│   │   └── assets/
│   └── app/
│       ├── __init__.py             # FastAPI 应用入口
│       ├── config.py               # 路径、工作表元数据
│       ├── db.py                   # SQLite 连接与通用表 CRUD
│       ├── derived.py              # 旧通用工作表兼容派生列
│       ├── export_service.py       # xlsx 导出（含座位表特例）
│       ├── import_service.py       # 学生 Excel 导入（模板生成 + 解析 + 按学号合并）
│       └── routers/
│           ├── sheets.py           # /api/sheets, /api/sheet/<name>
│           ├── students.py         # /api/students (CRUD + 导入/导出/模板)
│           ├── seating.py          # /api/seating
│           ├── stats.py            # /api/stats/* (仪表盘/考勤/成绩/积分)
│           ├── knowledge.py        # /api/knowledge (Obsidian 笔记)
│           ├── export.py           # /api/export/* (工作表导出+汇总报表)
│           ├── p0.py               # 学生详情/事件/待办/关注/沟通/批量考勤
│           ├── p1.py               # 搜索/成绩/考勤规则/班级任务/值日
│           └── system.py           # 本地备份与恢复
├── scripts/                        # 开发环境、UI 冒烟测试脚本
├── backend/tests/                  # 隔离 SQLite 后端测试与测试数据
├── packaging/                      # 桌面打包配置与构建脚本
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
浏览器 (Vue 3 SPA, Vite build)
      │  fetch /api/*
      ▼
Uvicorn :: FastAPI
      │  Pydantic 校验
      ▼
   Services
   ├── 导入/导出（openpyxl）
   ├── 结构化业务服务（成绩/考勤/积分/班费）
   ├── 旧通用工作表兼容派生计算（成绩/积分/余额/腰臀比）
   └── 知识库（文件系统）
      │
      ▼
   SQLite (WAL, per-thread connections, atomic commit)
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
| 日常行为积分 | 周期汇总/排名 | 有效流水按周期聚合 / 排序生成排名 |
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
| GET/POST | `/api/score-rules` | 查询或创建成绩异常跟进规则 |
| POST | `/api/score-rules/evaluate` | 手工重新评估成绩异常规则 |
| GET | `/api/export/sheet/<name>` | **导出任意工作表 xlsx** |
| GET | `/api/export/report/scores?exam=` | **成绩汇总报表** |
| GET | `/api/export/report/attendance?date_from=&date_to=` | **考勤汇总报表** |
| GET | `/api/seating` | 座位表 |
| GET | `/api/stats/*` | 仪表盘/考勤统计/成绩统计/积分统计 |
| GET/POST | `/api/knowledge/*` | 知识库笔记 |

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
- `/api/system/backup`、`/api/system/restore`：本地数据库备份与恢复

## 开发测试

后端 P0 工作流使用隔离 SQLite 测试数据，不会修改 `data/workbench.db`：

```bash
python -m unittest discover -s backend/tests -p 'test_*.py' -v
```

前端构建：

```bash
cd frontend
npm run build
```

浏览器冒烟测试（需要 Node.js、Chromium 和正在运行的后端依赖）：

```bash
bash scripts/smoke-ui.sh
```

当前基线包含 101 项隔离 SQLite 后端测试。CI 会自动执行后端测试、前端构建和浏览器冒烟测试；完整发布检查见 [`docs/发布检查清单.md`](docs/发布检查清单.md)。

---

## 5. 快速开始

### 环境要求
- Windows、macOS 或 Linux
- Python 3.11+
- Node.js 20+（仅首次构建前端时需要，运行时不需要）
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

这两个脚本会检查 Python/Node.js 版本，创建项目 `.venv`，安装后端依赖和前端依赖。也可以按下面步骤手动安装：

```bash
# 1. 后端依赖
cd backend
pip install -r requirements.txt

# 2. 迁移旧 Excel 数据（如已有）
python migrate.py

# 3. 前端构建（需要 Node.js + npm）
cd ../frontend
npm install
npm run build

# 4. 启动
cd ../backend
python run.py
# 浏览器打开 http://localhost:5000
```

### 日常使用
```bat
双击 启动工作台.bat
```

macOS 使用：

```bash
双击 启动工作台.command
```

如果使用 GitHub Release 安装包，则不需要安装 Python 或 Node.js，直接运行安装后的桌面程序即可。

安装包启动后默认允许同一局域网中的手机和平板访问。进入工作台后点击右上角“手机访问”，使用手机或平板扫描二维码即可打开。

### 局域网访问（开发模式）

电脑作为本地数据主机时，也可以使用以下命令启动局域网模式：

```bash
python backend/run.py --lan
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
| 无 API 文档 | FastAPI 自动生成 `/docs` |

---

## 7. 已知边界

- **考研备考**：预留页面，待实现
- **单元格编辑**：前端目前通过添加/删除管理数据，无单元格直接编辑 UI（可扩展）
- **学生导入告警**：含缺学号行提示、合并/新增计数
- **默认监听 `0.0.0.0` 以支持局域网访问**，数据不会上传云端；请勿做端口映射或在不可信网络中启动
- **手机和平板依赖电脑运行**，电脑关闭后局域网访问不可用
- **当前安装包未签名**，正式对外分发前需要配置 Windows 和 Apple 签名凭证
