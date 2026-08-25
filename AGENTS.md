# AGENTS.md — 美美大王工作台 v2.3

## 文档用途

本文件是本项目的 AI 开发助手协作规范。修改代码前先阅读本文件，并以仓库中的实际代码、配置和测试结果为准；如果本文件与代码现状冲突，应优先修正文档或向用户说明冲突，不要默默假设。

## 项目定位

- 这是一个面向班主任和教师的本地个人工作台，包含教师工作台、个人工作台和知识库。
- 采用“本地桌面主程序 + 局域网移动访问端”模式。结构化数据保存在本地 SQLite，知识库保存在本地 Markdown 文件，Excel 只用于导入和导出。
- 后端使用 Node.js + Fastify + TypeScript，前端使用 Vue 3 + Vite + Vue Router，桌面打包配置位于 `packaging/`。
- 详细的产品功能、完整项目结构和发布说明见 [README.md](README.md)；本文件只记录 AI 修改代码时必须遵守的规则和容易忽略的约束。

## 修改原则

- 先检查相关源码、配置和现有测试，再决定修改方案；保持改动小而集中，不顺手重构无关代码。
- 新增功能时优先复用现有组件、路由、API 封装和服务层；不要为一次性逻辑引入新的抽象层。
- 组件与依赖选型：优先复用项目已有组件和依赖；需要新增通用能力时，优先选择成熟、广泛使用、维护活跃、许可证兼容且与现有技术栈匹配的库，不重复手写已有能力。只有在原生/标准库已足够、现成库无法满足需求，或引入成本明显高于少量稳定代码时，才自行实现；选型前检查维护状态、许可证、安全风险、无障碍、性能和包体积，并在变更说明中记录取舍。
- 不要把运行时数据重新写回旧版 Excel；`班主任工作台/` 和 `健康管理/` 中的旧文件是归档数据源。
- 涉及真实数据库、知识库、批量删除、数据库恢复、依赖升级、发布、提交或推送的操作，必须以用户明确要求为前提。
- 不要自动执行 `git commit`、`git push`、发布安装包或修改远程服务。

## 环境准备与启动顺序

优先使用项目提供的环境脚本：

```bash
# macOS/Linux
./scripts/setup-dev.sh
```

```powershell
# Windows PowerShell
.\scripts\setup-dev.ps1
```

脚本会检查 Node.js 22.x，安装前端、Node 后端和 Electron 依赖，并处理 esbuild 的脚本许可；项目根目录 `.nvmrc` 是开发与流水线的 Node 版本基准。

手动安装和启动：

```bash
# 1. 前端依赖与构建
cd frontend
npm install
npm approve-scripts esbuild          # 首次安装且 npm 支持该命令时执行
npm run build                         # 输出到 ../backend/static/
npm run watch                         # 监听源码变动，自动重建到 ../backend/static/（手机等局域网设备场景）
npm run dev                           # Vite dev server（127.0.0.1:5173，HMR 热更新，自动探测后端端口）

# 2. Node 后端与桌面依赖
cd ../server && npm install && npm run build:server
cd ../desktop && npm install && npm run dev
```

桌面开发（推荐）：先在 `desktop` 执行 `npm run dev`，再另开终端在 `frontend` 执行 `npm run dev`；桌面开发命令会探测 5173 并加载 Vite dev server，获得毫秒级 HMR，`/api` 请求经 Vite 代理自动转发到实际后端端口。未启动 Vite 时回退到后端托管的静态页面。`npm run watch` 仍是局域网手机访问场景的更新方式（手机不会自动刷新，以最新一次构建为准）。

也可以双击 `启动工作台.bat` 或 `启动工作台.command` 启动源码工作台；Windows 批处理入口会自动启动 Vite 并启用前端热更新，macOS 入口仍加载本地构建页面。Windows/macOS 打包版本通过系统托盘管理后台服务：桌面快捷方式启动时不显示终端，托盘菜单提供“打开工作台”和“退出工作台”；源码启动入口保留可见终端和 `Ctrl+C` 停止方式。

需要复现历史业务日期时，可由开发者显式设置 `WORKBENCH_BUSINESS_DATE=YYYY-MM-DD`。日常启动和生产环境不设置该变量，系统使用真实日期；该变量只覆盖业务日期，审计、凭证过期和数据库时间仍使用真实时钟。

局域网开发模式：

```bash
npm run dev -- --lan
```

局域网模式下，本机点击“手机访问”生成 5 分钟有效、仅可使用一次的配对二维码；配对成功后设备获得可撤销凭证。只能在可信局域网中使用，不要把端口映射到公网。端口冲突时，启动入口会自动寻找可用端口。

## 架构约束

### 系统功能与 Agent 的分层规则

项目开发分为“系统业务能力”和“Agent 能力”两条产品线，但代码必须遵守三层架构：

```text
系统业务能力层：services → database
Agent 核心层：planner / runner / tools / session / audit
渠道适配层：网页 Agent / 微信 iLink
```

- 系统业务能力层负责学生、成绩、考勤、待办、家校沟通、班级任务、积分、班费、评语、教育记录、报告和健康等真实业务逻辑，并同时服务于用户点击操作和 Agent 调用。
- Agent 核心层负责模型客户端、规划、工具执行、上下文、重试、权限和审计；它不复制业务逻辑。
- 渠道适配层负责网页或微信的消息收发、会话身份、输出格式和渠道限制；网页端与微信端共享同一个 Agent 核心。
- `server/src/services/` 是业务能力的唯一实现位置；Agent 工具调用业务服务，不直接调用 HTTP 路由，也不直接操作数据库。
- 业务服务不依赖 Agent、微信或前端；依赖方向只能是“渠道 → Agent → 工具 → 业务服务 → 数据库”。
- 新功能必须先完成业务服务，再实现系统 API 和页面，然后明确评估是否封装为 Agent 工具，最后接入网页和微信渠道。
- 开始新增或重构系统业务功能前，必须先读取 [docs/系统功能开发计划.md](docs/系统功能开发计划.md)，按依赖顺序选择工作包，并在全部验收条件满足后更新其状态。
- 开始实现补充功能（微信现场操作、对话式 Excel、考试提醒、多班级视角、工作入口、家校模板/会谈、图片证据或桌面宠物）前，必须读取 [docs/补充功能讨论清单.md](docs/补充功能讨论清单.md)；涉及网页、手机、微信交互或桌面宠物时，同时读取 [docs/补充功能界面设计规范.md](docs/补充功能界面设计规范.md)。
- 详细的系统能力、工具、渠道、权限和测试登记见 [docs/Agent能力矩阵.md](docs/Agent能力矩阵.md)。新增或修改能力时必须同步更新该矩阵。

### Agent 设计参考规范

涉及 Agent 规划、上下文、工具、评测、记忆或多渠道适配时，先按任务读取《深入理解 AI Agent：设计原理与工程实践》的相关章节：[开源仓库](https://github.com/bojieli/ai-agent-book)。第 1 章用于理解整体架构，第 2 章用于上下文与提示设计，第 4 章用于工具设计，第 6 章用于评测和可观测性；本项目现有安全、隐私和分层约束优先于书中的通用示例。

- Agent 的设计边界遵循 `LLM + 上下文 + 工具 + Harness`：模型负责理解和决策，上下文负责提供观察与状态，工具负责访问业务环境，Harness（Planner、Runner、Session、权限、验证、纠错和审计）负责把模型能力约束为可靠流程。不要把业务逻辑复制进 Prompt 或渠道适配器。
- 每次模型决策都应明确构造上下文：系统提示词、当前渠道可用工具、用户消息、必要的历史消息、工具结果和任务状态。上下文压缩必须保留用户问题、工具调用与工具结果的配对关系、最终回答和关键状态；不得把隐式思维链作为用户可见内容或持久化数据。
- Agent 执行遵循“理解 → 规划 → 执行 → 观察 → 验证 → 回答”的闭环。工具结果是下一步决策的事实依据；可验证的操作必须在执行后自动验证，失败时返回结构化错误和可行动的修复信息。
- 工具优先采用最小、清晰、可测试的能力边界：稳定且参数复杂的业务能力使用专用工具，变化快或可组合的流程才考虑 Skill/通用执行器；相似且参数接近的工具应合并，避免工具数量和模型选择负担无谓增长。
- 感知工具必须返回结构化结果，并明确总数、分页/游标、截断和空结果含义；批量查询优先在业务服务层完成，不让模型逐条读取同一类记录。只读结果可以缓存或并行，写入操作必须考虑副作用、幂等性、取消和重试语义。
- 计划进入执行前必须经过范围、权限、参数和工具匹配校验。发现计划错误、空结果异常或工具失败时，优先定位轨迹中的第一个错误，最多自动纠正或重新规划一次；相同失败不得无限重试。
- Agent 的可靠性以轨迹和评测为准，不以单次演示为准。每个真实 bad case 都应脱敏后归因到意图、上下文、计划、工具、权限、执行或回答阶段，并补充到回归用例；修改后必须重新运行相关评测和后端测试。
- 新增 Agent 能力的完成条件是：业务服务可独立调用、工具契约和权限已登记、计划与结果有校验、网页和微信共享核心实现、审计和错误路径覆盖、回归测试通过，并同步更新能力矩阵和代理清单。

### Agent 工具、权限与渠道规则

- 新增工具必须登记：工具名称、业务能力、参数、只读/写入属性、敏感等级、允许渠道、是否需要确认、对应业务服务和测试。
- 工具注册表可以包含全部工具，但发送给模型的工具列表必须按当前渠道和权限筛选；微信默认排除敏感工具和高风险写工具。
- 查询类工具可以在权限允许时自动执行；创建、修改、删除类工具必须在执行前获得用户明确确认，微信端默认禁止高风险写操作。
- 权限校验必须在服务端 Agent 核心和工具层完成；网页或微信界面的隐藏按钮不构成安全边界。
- 网页 Agent 和微信 Agent 必须复用 Planner、Runner、工具注册、会话、审计和错误处理；渠道代码不得复制一套 Agent 逻辑。
- 网页会话和微信会话必须使用不同命名空间。网页使用 `web:{用户}:{会话}`，微信当前使用 `wechat:{微信用户}`，禁止跨渠道复用会话 ID。
- 一个微信账号下，每个已授权微信用户默认使用一个 Agent 主会话；当前不提供主动多会话能力，只有明确的产品需求才增加多会话能力。
- 会话保留用户问题、工具结果和最终回答；审计保留工具调用、参数摘要、状态和时间；不保存或展示模型隐式思维链。

### Agent 故障、模型和数据安全规则

- 模型客户端必须保持 OpenAI-compatible 抽象；模型名称、Base URL 和 API Key 来自配置，业务服务不绑定具体供应商。
- 工具失败只能有限重试；相同失败调用必须停止，规划失败最多自动重新规划一次，禁止无限循环。
- 模型不可用、微信断开或 Agent 异常时，系统页面和用户点击功能必须继续可用；返回友好提示并保留本地会话和凭证状态。
- 工具改名或下线时，优先提供兼容映射或明确的停用错误；不得让模型对停用工具持续重试。
- 审计和错误日志只记录参数摘要，不记录 API Key、监护人电话、家庭住址等完整敏感字段；测试夹具和截图必须脱敏。
- 数据库、会话结构或工具参数变化必须兼容已有数据；数据库结构使用版本迁移，旧会话和旧审计记录不得直接删除。

### Agent 专项测试规则

- 业务服务改动：运行后端全量测试。
- Agent 核心、模型客户端、规划器、工具或会话改动：运行后端全量测试，并覆盖工具调用、规划、权限、重试和流式响应。
- 网页 Agent 改动：运行前端构建；涉及主要交互时运行 UI 冒烟测试。
- 微信适配改动：运行微信测试和 Agent 测试，验证登录、消息收发、会话隔离、权限和断线恢复。
- 共享业务服务改动：同时验证用户点击、网页 Agent 和微信 Agent 的主要调用路径。
- 发布前分别检查系统功能、Agent 核心、网页渠道和微信渠道；检查项以 [docs/Agent能力矩阵.md](docs/Agent能力矩阵.md) 和 [docs/发布检查清单.md](docs/发布检查清单.md) 为准。

### Agent 文档更新规则

以下变化必须同步更新 `AGENTS.md` 或 [docs/Agent能力矩阵.md](docs/Agent能力矩阵.md)：

- 新增系统业务模块或 Agent 工具
- 修改工具参数、权限、敏感等级或渠道范围
- 新增或修改网页/微信 Agent 能力
- 修改会话、审计、确认、重试或故障回退流程
- 修改模型接入、启动、构建、测试或发布方式

### 数据与数据库

- SQLite 数据库是运行时唯一的数据源：开发模式默认是 `data/workbench.db`，打包模式位于系统用户数据目录。
- Excel 文件只由导入/导出逻辑使用，`exceljs` 不承担运行时存储职责。
- SQLite 使用 WAL 模式。Node 后端通过 `server/src/db/connection.ts` 管理连接和迁移；WAL 和 `busy_timeout` 负责连接间协调。修改连接策略前必须通过并发和迁移测试。
- 数据库结构通过 `server/src/db/schema.ts` 中的迁移机制维护。修改表结构时必须增加迁移版本、处理已有数据库，并运行 Node 后端测试；不要直接手改真实数据库结构。
- `WORKBENCH_DATA_DIR` 可以指定数据目录，测试或临时验证时应使用隔离目录，避免修改 `data/workbench.db`。
- `WORKBENCH_KB_DIR` 可以指定知识库目录。知识库是 Markdown 文件，不由 SQLite 管理。
- `WORKBENCH_BUSINESS_DATE` 可以指定开发/测试业务日期（格式 `YYYY-MM-DD`）；生产环境不应设置该变量。

### 派生数据

- 成绩总分、积分排名、班费余额、腰臀比等派生列在读取时计算，不存入数据库。
- 派生逻辑集中在 `server/src/services/sheets.ts`。新增派生列时按工作表名称添加函数，并补充对应测试。
- 导出 Excel 时才把派生列写入导出结果；不要为了导出方便把派生值持久化。

### 学生导入

- `POST /api/students/import` 按学号合并：新学生插入，已有学生更新。
- 缺少学号的行会跳过并返回错误信息；修改导入逻辑时必须保留故障行报告和导入批次记录。
- 模板接口 `/api/students/template` 负责生成预期列布局，新增学生字段时要同步检查配置、模板、导入和导出逻辑。

### 后端模块

- API 路由放在 `server/src/http/routes/`；可复用的业务逻辑放在 `server/src/services/`。
- 通用工作表逻辑集中在 `server/src/services/sheets.ts`、`server/src/config/sheets.ts` 和数据库模块，不要在多个路由中复制同一套数据逻辑。
- Agent 和微信相关代码分别位于 `server/src/agent/`、`server/src/wechat/` 及对应路由中；涉及工具调用、消息去重或审计时，保留现有本地状态记录机制。
- Fastify 自动提供 API 文档，接口修改后可通过 `/docs` 检查路由和请求结构。

### 前端模块

- `App.vue` 是页面外壳，负责侧边栏、顶部标签页和 `<router-view />`；由 `main.js` 中的 `createApp(App)` 挂载。
- 路由必须保持扁平，不能把 `App` 再作为路由组件，否则会出现嵌套渲染和重复侧边栏。当前使用 `createWebHashHistory()`。
- API 请求优先通过 `frontend/src/api.js`，以保留统一的错误处理、班级/学期上下文和局域网设备凭证。
- 导航配置和工作表字段定义集中在 `frontend/src/sheets.js`；新增工作表页面时同步检查导航、字段、后端元数据和导出逻辑。
- Vite 构建输出到 `backend/static/`，不是 `frontend/dist/`。任何前端修改后都要重新构建。

### Electron 桌面壳

- `desktop/` 是 Electron 桌面壳：窗口、托盘、单实例、后端子进程、下载/外部协议、更新安装协调和退出清理都集中在 `desktop/main.js`；`desktop/preload.js` 只暴露逐项白名单 IPC，不暴露完整 `ipcRenderer`。
- 后端以 Node.js 方式启动（`--desktop-child --lan`）：开发模式用系统 Node 运行 `server/dist/entry.js`（`server/node_modules` 为系统 Node ABI）；打包模式用 Electron `utilityProcess` 运行 `resources/server/dist/entry.js`（`build/server-bundle/` 内 better-sqlite3 已重建为打包 Electron ABI）。启动契约不变：打印单行 `WORKBENCH_URL=http://127.0.0.1:<port>` 后由 Electron 轮询 `/api/system/health` 判断就绪；异常退出最多自动重启 2 次，之后给出重启/退出选择。
- Electron 是唯一桌面宿主：托盘、退出权和更新安装权都在 Electron。退出时必须由 Electron 终止 Node 后端，等待端口释放；`--desktop-child` 模式正常退出会清理 `.workbench-ready` 标记。
- 更新所有权边界：后端只负责检查、升级前备份、下载和 SHA-256 校验，校验通过后进入 `ready_to_install` 状态；Electron 通过受限 IPC 调用 `/api/system/update/installer-path`（仅本机）取得安装包后关闭应用并启动安装器。后端不得再自行启动安装器或 `os._exit`。
- 更新源：客户端直接使用 GitHub Releases API，并在 API 不可达时使用 GitHub Release 附件中的 `update-manifest.json` 兜底；安装包始终通过 SHA-256 校验。修改 GitHub 更新接口或校验流程时，同步更新 `server/tests/integration/mig09.test.ts` 和 `docs/发布检查清单.md`。
- Electron 安全基线：`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、不关闭 `webSecurity`；主窗口只加载后端回环地址，非白名单导航一律拦截，外部链接仅放行 http(s) 与 `obsidian://`；同源 `window.open` 视为下载交给下载策略，不打开外部浏览器。
- Electron 的 `userData` 使用独立的 `MeimeiWorkbench-Electron` 目录，不能与后端数据目录（`MeimeiWorkbench`）混用；打包时 Node 后端资源（`build/server-bundle`）放在 `extraResources`，不能打进 `app.asar`。应用版本唯一来源为构建时的 `APP_VERSION`，写入 `server-bundle/static/app-version.json` 并同步 Electron 版本与安装包名称。

路由示例：

```js
// frontend/src/router.js — 正确写法
const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', component: () => import('./views/Dashboard.vue') },
  // ... 全部保持扁平，不使用 App 作为父级包装组件
]
```

## 测试与验收

根据改动范围执行检查，并在交付时说明实际执行过的命令及结果。

### 后端测试

后端测试使用隔离 SQLite 数据，不应修改真实的 `data/workbench.db`：

```bash
cd server
npm run typecheck:server
npm run test:server
npm run build:server
```

涉及数据库、API、Agent、微信、导入导出或学生管理的后端改动，至少运行这组测试。

### 前端构建

```bash
cd frontend
npm run build
```

涉及 Vue 页面、路由、API 调用、样式、导航配置或工作表字段的改动，必须执行前端构建，并确认产物写入 `backend/static/`。

### 浏览器冒烟测试

需要 Node.js、Chromium 和可用的后端依赖：

```bash
npx playwright install chromium
bash scripts/smoke-ui.sh
```

该脚本会启动临时服务并使用临时数据目录，检查工作台页面、手机访问入口和更新入口。涉及主要页面、设备配对凭证、局域网入口或桌面壳层的改动，应执行该测试。

### Electron 冒烟测试

需要 Node.js 和 Electron（首次 `cd desktop && npm install`）：

```bash
cd desktop
npm test
```

该测试用临时 `WORKBENCH_DATA_DIR`/`WORKBENCH_KB_DIR` 启动 Electron，检查窗口标题、手机访问/更新入口、Node 后端健康检查，退出后确认端口释放。涉及 `desktop/`、`server/src/entry.ts` 启动契约、健康检查或更新安装边界的改动，应执行该测试和对应 Node 后端测试。

### CI

`.github/workflows/ci.yml` 会执行后端测试、前端构建和浏览器 UI 冒烟测试；`.github/workflows/windows-installer.yml` 会在 `main` 推送或手动触发时构建 Windows x64 安装包、运行安装冒烟测试并保存 Actions Artifact；版本标签发布由 `release.yml` 负责。发布前还应参考 `docs/发布检查清单.md`，但不要把发布操作当作普通代码修改的一部分自动执行。

## 数据安全

- `data/workbench.db` 和 `知识库/` 可能包含学生、家长和个人隐私信息；不要把真实数据写入测试夹具、日志、截图、提交或公开链接。
- 运行迁移、恢复或其他可能改变大量数据的操作前，先确认目标目录，并优先创建备份。系统的数据库备份功能会生成带完整性校验的 SQLite 备份。
- 测试使用 `WORKBENCH_DATA_DIR` 指向临时目录；不要通过修改真实数据库来验证代码。
- `--lan` 只适用于可信网络。不要绕过短时配对、设备凭证校验和撤权边界，也不要把本地服务配置成公网可访问服务。
- 旧版 Excel 文件应保留为归档；除非用户明确要求迁移、导入或导出，不要覆盖或删除它们。

## 开发流程

1. 先定位需求涉及的页面、路由、API、数据表和测试。
2. 修改最少的必要文件，并保持现有命名和代码风格。
3. 对数据库或导入导出改动，检查已有数据兼容性和错误路径。
4. 根据改动范围执行后端测试、前端构建和 UI 冒烟测试。
5. 检查 `git diff`，确认没有临时文件、构建外的无关改动或隐私数据；向用户报告修改文件和验证结果。

当前没有额外的格式化工具或 lint 命令；不要为了“顺手整理”大范围改写格式。

## 批处理文件编码

`启动工作台.bat` 不要写死中文路径（使用 `cd /d "%~dp0backend"`，不要使用 `cd /d "D:\Desktop\美美...\backend"`）。Windows 的 `cmd.exe` 经常无法正确处理批处理文件中的 UTF-8 路径；使用 `%~dp0` 定位项目根目录可以避免这个问题。

## 关键文件索引

| 用途 | 路径 |
|------|------|
| 项目概览与完整结构 | `README.md` |
| 服务端入口 | `server/src/entry.ts` |
| 数据库结构、连接与迁移 | `server/src/db/connection.ts`、`server/src/db/schema.ts` |
| 应用配置与工作表元数据 | `server/src/config/index.ts`、`server/src/config/sheets.ts` |
| 派生列 | `server/src/services/sheets.ts` |
| 学生导入逻辑 | `server/src/services/importService.ts` |
| Excel 导出 | `server/src/services/exportService.ts` |
| API 路由 | `server/src/http/routes/` |
| 业务服务 | `server/src/services/` |
| 报告、教育记录和健康服务 | `server/src/services/reports.ts`、`education.ts`、`health.ts` |
| Agent 模块 | `server/src/agent/` |
| 微信模块 | `server/src/wechat/` |
| Agent 核心状态机 | `server/src/agent/graph/`、`runner.ts`、`actions.ts` |
| Agent/微信配置 | `server/src/agent/modelConfig.ts`、`server/src/wechat/config.ts` |
| Electron 桌面壳 | `desktop/main.js`、`desktop/preload.js`、`desktop/electron-builder.yml` |
| Electron 冒烟测试 | `desktop/tests/smoke.mjs` |
| 系统功能开发计划 | `docs/系统功能开发计划.md` |
| 补充功能开发执行清单 | `docs/补充功能讨论清单.md` |
| 补充功能界面设计规范 | `docs/补充功能界面设计规范.md` |
| Agent 能力矩阵 | `docs/Agent能力矩阵.md` |
| 后端测试 | `server/tests/` |
| 前端 API 封装 | `frontend/src/api.js` |
| 导航配置与工作表字段 | `frontend/src/sheets.js` |
| Vue 入口与页面外壳 | `frontend/src/main.js`、`frontend/src/App.vue` |
| Vue 路由 | `frontend/src/router.js` |
| 可复用工作表页面 | `frontend/src/components/SheetPage.vue` |
| 开发环境脚本 | `scripts/setup-dev.sh`、`scripts/setup-dev.ps1` |
| UI 冒烟测试 | `scripts/smoke-ui.sh` |
| CI 配置 | `.github/workflows/ci.yml` |
| 发布检查 | `docs/发布检查清单.md` |
| 知识库 | `知识库/`（Markdown 文件） |
| 旧版 Excel 归档 | `班主任工作台/`、`健康管理/` |
