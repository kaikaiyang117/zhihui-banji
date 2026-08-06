# 美美大王工作台 v2.2

面向一线班主任与教师的**本地个人工作台**，集班级管理、健康管理、知识库于一体。SQLite 存数据、Excel 仅导入导出，Vue 3 前端组件化，断网可用，隐私可控。

> 页脚标语："凯凯小兵 🛡️ 为你值守"

---

## 1. 功能总览

工作台分为两大模块（顶部 Tab 切换）：

### 🏫 教师工作台

| 功能 | 说明 |
|------|------|
| 首页仪表盘 | 班级人数、出勤统计、班费余额、积分 TOP5、最近日志、快捷操作 |
| 学生信息 | 学生总表 + 搜索 + **Excel 批量导入（按学号合并去重）** + 导出 |
| 特殊学生档案 | 重点关注学生档案管理 |
| 评语管理 | 学期/毕业/日常评语 |
| 考勤管理 | 出勤/迟到/请假/缺勤记录 + 状态统计 + **日期筛选汇总报表导出** |
| 成绩跟踪 | 月考/期中成绩、平均分、ECharts 对比图、进退步标注 + **月考/期中汇总报表导出** |
| 行为积分 | 每周积分 + 排行榜 + TOP5 趋势折线图 |
| 座位表 | 可视化班级座位网格（讲台/过道特殊标识） |
| 家校沟通 | 电话/微信/面谈/家访记录与跟进状态 |
| 班会记录 | 班会主题、形式、效果评估 |
| 班费管理 | 收支明细、自动滚动余额 |
| 班主任日志 | 每日记事 + 待办 |
| 班级活动 | 活动类型、预算、总结 |
| Excel 导出 | **每个工作表 + 成绩/考勤汇总报表**一键下载 xlsx |

### 👤 个人工作台

| 功能 | 说明 |
|------|------|
| 健康追踪 | 体重趋势图（目标线）、运动记录、睡眠记录 |
| 考研备考 | 预留页面 |
| 知识库 | Obsidian 集成 Markdown 笔记、6 种模板、分类浏览 |

---

## 2. 技术栈（v2.2 升级）

| 层 | v2.1（旧） | v2.2（新） |
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
├── docs/                           # 用户手册与维护文档
│   ├── 用户手册.md
│   └── 移动端适配-TODO.md
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
│       ├── derived.py              # 派生计算列（成绩总分/积分排名/班费余额等）
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
   ├── 派生计算（成绩总分/积分排名/余额/腰臀比）
   └── 知识库（文件系统）
      │
      ▼
   SQLite (WAL, atomic commit)
```

**核心理念**：SQLite 存结构化数据（学生表 + 通用 JSON 行）、Excel 仅作为"导入模板 + 导出报表"的外部交换格式，不再用作运行时的数据库。

### 4.2 存储设计

| 存储 | 内容 | 设计 |
|------|------|------|
| `students` 表 | 学号(PK)、姓名、性别...13 列 | 结构化，学号唯一 → 导入去重的依据 |
| `sheet_meta` 表 | 工作表名 → 表头 JSON、分类 | 通用工作表元数据 |
| `sheet_rows` 表 | 工作表名 + 行号 → 行数据 JSON | 通用表数据（考勤/成绩/积分等） |
| `seating` 表 | 行列座标 → 值 | 座位网格 |
| 知识库 | Markdown 文件 | Obsidian Vault（根目录 `知识库/`） |

### 4.3 派生计算层 (`derived.py`)

替代旧架构的 Excel 公式 hack，在数据读取时对以下工作表做实时计算：

| 工作表 | 计算列 | 逻辑 |
|--------|--------|------|
| 成绩跟踪 | 总分月考1/总分期中/进退步 | SUM(各科) / 月考排名−期中排名 |
| 日常行为积分 | 月合计/排名 | SUM(8周) / 排序生成排名 |
| 班费管理 | 余额 | 收入+ 支出− 滚动累计 |
| 体重体脂追踪 | 腰臀比/与上周对比 | 腰围÷臀围 / 本周−上周 |

导出时一并写入 xlsx。

### 4.4 API 概览

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/sheets` | 列出全部工作表 |
| GET | `/api/sheet/<name>` | 读取（含派生计算列） |
| POST | `/api/sheet/<name>/append` | 追加行 |
| PUT | `/api/sheet/<name>/update` | 更新单元格 |
| DELETE | `/api/sheet/<name>/row/<row_no>` | 删除行 |
| GET | `/api/students` | 学生列表（支持 keyword 搜索） |
| DELETE | `/api/students/<id>` | 删除学生 |
| GET | `/api/students/template` | 下载导入模板 xlsx |
| POST | `/api/students/import` | **上传 Excel 导入（按学号合并/故障行报告）** |
| GET | `/api/students/export` | 导出学生信息 |
| GET | `/api/export/sheet/<name>` | **导出任意工作表 xlsx** |
| GET | `/api/export/report/scores?exam=` | **成绩汇总报表** |
| GET | `/api/export/report/attendance?date_from=&date_to=` | **考勤汇总报表** |
| GET | `/api/seating` | 座位表 |
| GET | `/api/stats/*` | 仪表盘/考勤统计/成绩统计/积分统计 |
| GET/POST | `/api/knowledge/*` | 知识库笔记 |

### P0 学生管理闭环

- `/api/students/{id}/detail`：学生全景页与成长时间线
- `/api/events`：学生事件记录，支持自动创建跟进事项
- `/api/tasks`：待办、截止日期、优先级和完成状态
- `/api/focus`：关注事项生命周期
- `/api/communications`：结构化家校沟通与回访
- `/api/attendance/daily`：按日期批量保存全班考勤
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

---

## 5. 快速开始

### 环境要求
- Windows
- Python 3.12+（`pip install -r backend/requirements.txt`）
- Node.js（仅首次构建前端时需要，运行时不需要）
- Obsidian（知识库功能可选）

### 首次安装
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

### 局域网访问

电脑作为本地数据主机时，可使用以下命令让同一局域网的手机和平板访问：

```bash
python backend/run.py --lan
```

默认模式只监听本机；局域网模式仅适用于可信网络，不要将端口映射到公网。桌面打包说明见 `packaging/README.md`。

### 数据备份
- 备份 `data/workbench.db`（一个文件 = 全部数据）
- 备份 `知识库/` 目录（Markdown 笔记）
- 旧 Excel 文件在 `班主任工作台/` 和 `健康管理/` 中保留不动

---

## 6. 与旧架构的差异（v2.1 → v2.2）

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
- **仅监听 127.0.0.1**，数据不出本机
