# MIG-02 Node 服务骨架

FastAPI 迁移的第二阶段产物：可启动、可测试、无业务代码的 Node.js/TypeScript 服务骨架。
对应方案文档 `Node.js后端与凯凯小兵Agent改造方案.md` 第 10.3 节。

## 命令

```bash
npm run typecheck:server   # tsc --noEmit（strict）
npm run test:server        # Vitest 单元 + 集成测试
npm run build:server       # tsc 输出 dist/
npm run dev                # tsx 运行 src/entry.ts
node dist/entry.js         # 运行构建产物
```

## 结构

```
server/
├── src/
│   ├── entry.ts           # CLI / utilityProcess 共用入口（--lan / --host / --port / --desktop-child / --version）
│   ├── app.ts             # buildApp()：Fastify 工厂，import 无任何启动副作用
│   ├── lifecycle.ts       # 端口探测、就绪标记、信号处理、优雅退出
│   ├── config/index.ts    # 环境变量、业务日期校验、路径解析
│   └── http/errors.ts     # AppError / detail 错误映射
├── static/                # Vue 构建产物（生成目录，gitignore）
└── tests/
    ├── unit/              # 配置与端口探测
    ├── integration/       # 应用注入测试 + 子进程生命周期
    └── fixtures/static/   # 最小静态夹具（index.html / favicon / app-version.json）
```

## 行为契约（与 FastAPI 对齐）

- `GET /api/system/health` → `{app, version, ready}`；ready 由启动任务回调控制。
- `GET /api/system/runtime` → `{business_date, today}`（WORKBENCH_BUSINESS_DATE 或真实日期）。
- `GET /docs`（Swagger UI）与 `GET /openapi.json`（OpenAPI 快照）。
- 错误统一 `{detail}`：AppError→对应状态码、校验错误→422、未知→500。
- `/api/*` 404 返回 JSON；其他路径回退 SPA `index.html`（hash 路由兼容）。
- 静态资源：`WORKBENCH_STATIC_DIR` → `server/static/`（存在时）→ `backend/static/`。
- 默认只监听 `127.0.0.1:5000`；`--lan` 才监听 `0.0.0.0` 并打印配对入口。
- `--desktop-child`：单行 `WORKBENCH_URL=http://127.0.0.1:<port>`（Electron 等待契约）。
- 端口冲突自动顺延；SIGINT/SIGTERM 优雅退出（10s 超时强制），清理 `.workbench-ready` 标记。
- Pino 日志脱敏：authorization、device 凭证、cookie、api_key/token/password、监护人电话、家庭住址。

## 关键决策

- 业务日期用组件方式校验（`Date.UTC`），避免本地时区把日期偏移一天。
- 测试完全独立于 5000 端口：macOS ControlCenter 会动态占用/释放 5000，任何
  依赖 5000 空闲的断言都是 flaky 的（实测踩坑）。
- `server/static/` 尚未生成时回退 `backend/static`，测试使用 fixtures 静态目录，
  不依赖 Python 构建产物。

## 下一工作包

`AGENT-01` LangGraph Harness：状态图、检查点、计划/执行/验证/纠错（凯凯小兵）。

## AGENT-00 Agent 基线与模型层（已交付）

`src/agent/`：
- `modelConfig.ts`：OpenAI-compatible 配置（env 优先 + DB 回退、必填校验、脱敏）。
- `modelClient.ts`：`complete`/`iter_complete`（fetch + SSE 流式、reasoning/DSML、
  tool_calls、usage、超时与 401/429/5xx 单次重试退避）。
- `sessionStore.ts`：会话 CRUD/重命名/消息压缩。
- `prompt.ts`：凯凯小兵系统提示（业务日期注入）。
- `toolRegistry.ts`：16 个工具（12 只读 + 4 写入确认），渠道过滤（wechat 排除敏感）、
  参数校验（invalid_arguments）、错误码体系；与 TS 业务服务逐项映射。
- `agentService.ts`：invokeTool（渠道→确认→校验→执行→脱敏审计）、listTools/listAudits/
  usageStats、写入预览（createPendingAction：参数白名单、10 分钟过期、hash 幂等、确认码）。
- `commentDrafter.ts`/`reportDrafter.ts`：评语/报告 AI 草稿（上下文构造 + 模型调用 +
  JSON 解析回填），已接入 `/api/comments/ai/preview` 与 `/api/reports/ai/preview`
  （未配置模型返回明确 400）。

验证（tests/integration/agent00.test.ts，13 项；总 153/153）：
- 假模型 HTTP 服务下 complete/流式/DSML 解析；未配置抛 ModelNotConfigured。
- 配置保存/加载/脱敏（api_key_set/masked）。
- 工具回归：班级人数、搜索、批量查询、聚合、微信敏感拒绝、写工具 confirmation_required、
  参数错误 invalid_arguments、未知工具。
- 会话 CRUD 与重命名；systemPrompt 含业务日期；AI 端点未配置模型返回 400。

## MIG-09 输出、个人与系统运维（已交付）

`src/services/`：
- `reports.ts`：周/月/学期/成长报告（指标聚合 + 来源追溯 + 数据口径）、档案快照
  （payload_json、UNIQUE upsert、只读归档、Excel 导出）。
- `health.ts`：健康目标/提醒/复盘/汇总（个人表与班级数据隔离）、多 sheet 汇总导出。
- `exportService.ts` 扩展：通用工作表/考勤/成绩/积分/班费/评语/座位/健康导出（exceljs）。
- `migrationService.ts`：迁移包导出（db+知识库 zip）与恢复（结构校验、路径穿越拒绝、
  完整性检查、备份后原子替换）。
- `update.ts`：更新检查（GitHub API + manifest 回退、平台资产选择、SHA-256 校验）、
  下载状态机（checking→backing_up→downloading→verifying→ready_to_install）、
  github-token 管理、installer-path（本机）。
- `db/index.ts`：数据库单例 + 备份恢复（deserialize 校验 + 替换 + 重开）。

`src/http/routes/mig09.ts`：报告/健康/导出/备份/恢复/迁移包/更新路由；
`/api/reports/ai/preview` 暂 503（AGENT-00 接入）。

验证（tests/integration/mig09.test.ts，12 项；总 140/140）：
- 周报指标与来源追溯、档案创建/列表/读取/导出。
- 健康目标唯一/提醒/复盘/汇总/多 sheet 导出（openpyxl 可解析）。
- 通用表/考勤导出；备份创建→修改→恢复；迁移包导出→破坏→恢复往返；
  路径穿越 zip 被拒；github-token 校验；installer-path 未就绪拒绝。
- HTTP 全端点连通（开发模式 install 拒绝 400、AI 草稿 503）。

## MIG-08 账目与教育沉淀（已交付）

`src/services/`：
- `points.ts`：积分流水/撤销/规则/周期评估（命中/重开/解除 + 工作项联动）、
  `classSummary`/`studentSummary`、旧"日常行为积分"周快照迁移（防重 + 报告）；
  注册 `sourceTransitionHooks['point_rule']`。
- `funds.ts`：班费分类/流水（未结算可改可撤、已结算只能冲正、撤销后不可操作）、
  结算/对账、凭证附件（sha256 原子写入）、旧班费表迁移。
- `comments.ts`：评语模板/条目/状态机（草稿→待审核→完成→已发送 + 版本历史）、
  模板变量渲染与缺失标记、人工编辑保护、AI 草稿保存、旧评语表迁移。
- `education.ts`：班会（行动项→统一工作项 `meeting_action`）、活动（跟进→工作项
  `activity`、附件）、日志（五类关联）、旧通用表迁移（domain4_migration_runs）。
- `knowledge.ts`：Markdown 知识库（frontmatter/标签/关联）、外部修改冲突检测
  （expected_hash/force/adopt）、目录增量同步；`WorkbenchDb` 增加 `kbDir`。

`src/http/routes/mig08.ts`：积分/班费/评语（含打印页）/教育/知识库路由；
`/api/comments/ai/preview` 暂返回 503（AGENT-00 接入模型后启用）。
`entry.ts` 启动评估补全 points/funds/comments/education/knowledge。

验证（tests/integration/mig08.test.ts，15 项；总 128/128）：
- 积分流水/撤销/汇总、规则命中→完成已处理、旧周快照迁移幂等。
- 班费撤销/冲正/结算对账业务规则（含已结算限制）。
- 评语状态机+版本历史、模板缺失变量标记。
- 班会行动项→工作项、活动附件落盘、日志关联。
- 知识库创建/读取/外部冲突/force 覆盖/重名拒绝。
- HTTP 全端点连通。

## MIG-07 高频教师业务（已交付）

`src/services/`：
- `attendance.ts`：考勤记录/统计（日/月/周/学生桶 + 出勤率）、规则 CRUD、`evaluateRules`
  （命中/新建/重开/解除/失败写 failed run）、`evaluateStartup`、`dashboardCounts`；
  注册 `sourceTransitionHooks['attendance_rule']`。
- `scores.ts` + `scoresRules.ts`：科目/考试/选科配置、长宽表导入（幂等/原子）、
  `scoreSummary`（缺考免考不计 0 分、完整总分、同分同名次、A/B/C 分层）、成绩规则评估；
  注册 `sourceTransitionHooks['score_rule']`。
- `classTasks.ts`：任务模板/材料收集/缺交例外（409 + 名单）/提醒幂等/附件（sha256 原子写入）；
  注册 `sourceTransitionHooks['class_task']`。
- `duty.ts`：值日 CRUD（同生同日跨区冲突 409）、轮换规则（preview/confirm 两段式生成）；
  注册 `sourceTransitionHooks['duty_assignment']`。
- `schoolCalendar.ts`：校历条目 CRUD、学期周次网格、矩阵/明细导入（request_id 幂等、冲突/范围外报告）。

`src/http/routes/mig07.ts`：考勤规则/成绩配置/成绩导入/成绩规则/班级任务/值日/校历/搜索路由。

联动接线：
- `p0Service.saveDailyAttendance` 保存后自动触发考勤规则评估（与 Python save_daily 一致）。
- `entry.ts` 启动任务非阻塞执行考勤/成绩 `evaluateStartup`。

验证（tests/integration/mig07.test.ts，15 项；总 114/114）：
- 考勤：阈值命中建工作项、完成→已处理、指标恢复→自动解除、停用→解除、统计口径。
- 成绩：缺考不完整总分、同分同名次 [1,1,3]、下降规则命中→完成→已处理。
- 任务：缺交完成被拒（409 语义 + 名单）、confirm_incomplete 例外关闭、附件落盘可读。
- 值日：同生同日跨区冲突、轮换按周生成。
- 校历：条目 CRUD、学期周次网格、导入 request_id 幂等。
- HTTP：全端点连通 + 缺交 409 名单。

## MIG-06 行动闭环（已交付）

`src/services/`：
- `workItems.ts`：统一工作项（创建/来源幂等 `source_key`/旧待办认领/筛选 bucket/
  状态变更/结果必填/来源回写），`sourceTransitionHooks` 注册表（MIG-07/08 填充考勤/
  成绩/任务/值日/积分回写）。
- `workflow.ts`：事件/沟通/关注的过程记录与状态联动（`update_source` request_id 幂等、
  `on_work_item_transition` 双向回写：完成/取消/重开）。
- `p0Service.ts`：事件（跟进自动建工作项）、家校沟通（回访工作项）、关注（复查工作项）、
  考勤批量保存（事务 + 审计；规则评估 MIG-07 接入）、考勤记录、学生详情与时间线
  （事件/沟通/关注/考勤异常聚合/跟进/评语/workflow 过程记录倒序 + 风险洞察；
  成绩/积分/评语摘要为轻量查询，MIG-07/08 接管完整服务）。

`src/http/routes/mig06.ts`：事件/工作项/关注/沟通/考勤/学生详情/统一流程路由。

验证（tests/integration/mig06.test.ts，19 项）：
- 来源幂等（source_key 不重复创建）、旧待办认领、状态/结果校验。
- 事件/沟通/关注 → 工作项联动；关闭来源强制指定 complete/cancel。
- 双向回写：来源完成→工作项完成；工作项完成/重开→来源状态+closed_at+过程记录。
- request_id 幂等（duplicate 不重复写记录）。
- bucket 时间筛选（逾期/今天/未来7天/完成）、source_path URL 定位、timing_state。
- 学生详情时间线倒序聚合 + 风险洞察；考勤异常可见。
- HTTP 全链路：事件→任务→完成→工作流→详情；10 并发创建事件各生成独立工作项。

## MIG-05 基础资料与通用数据（已交付）

`src/services/`：
- `context.ts` 扩展：班级/学期/在班关系 CRUD（创建/更新/归档/结转/转班）、`listContexts`、
  结转复制在读学生与规则配置（考勤/成绩/积分/班费/评语/班会/活动/任务/值日模板）。
- `students.ts`：中文字段学生档案、学号唯一（重复/回收站 409）、头像存储
  （魔术字节校验 JPG/PNG/WebP、5MB 上限、原子写入、相对路径白名单）。
- `importService.ts`：模板生成、Excel 预览（表头定位/缺失学号姓名/文件内重复报告）、
  按学号合并提交（新增+更新、**整批事务回滚**、导入批次记录）。
- `sheets.ts`：通用工作表元数据/行数据/追加/更新、个人表不隔离、
  派生列（成绩总分/积分合计排名/班费滚动余额/腰臀比）、考勤兼容视图。
- `exportService.ts` + `exportXlsx.ts`：学生导出/模板（exceljs，表头加粗填充、
  固定列宽，朴素日期序列号）。
- `recycleSheets.ts`：工作表行软删除进回收站。

`src/http/routes/mig05.ts`：context/students/sheets/seating 路由（409 冲突与归档、
400 业务、404 不存在映射）。

验证（tests/integration/mig05.test.ts，20 项）：
- 班级/学期/在班：创建自动建学期、结转复制+归档、转班状态机、归档写保护、班级学期匹配。
- 学生：中文字段/空值、学号唯一（含回收站占用）、头像类型/大小/路径安全。
- 导入：预览故障行报告、按学号合并、**注入失败整批回滚零残留**、模板可被 openpyxl 解析。
- 工作表：跨班级/学期隔离、个人表不隔离、派生列数值、软删除进回收站、考勤兼容九列视图。
- HTTP：学生创建/列表/导出/模板、座位表读写、归档范围写入 409。

## MIG-04 请求范围与安全底座（已交付）

`src/services/`：
- `context.ts`：AsyncLocalStorage 请求级班级/学期范围（默认取"使用中"班级 + "进行中"学期）、
  `scopeIds(write)` 归档写保护（ArchivedScopeError → 409）、`ensureStudentInScope`。
- `audit.ts`：渠道/操作者上下文、敏感参数脱敏（key/token/密码/电话/地址 → `***`）、
  缺省写审计、`listAudits`。
- `devices.ts`：短时配对（5 分钟单次）、90 天设备凭证（SHA-256 哈希存储）、
  认证/过期/撤权/全部撤权、last_seen 更新；行为与 Python 逐条一致。
- `recycle.ts`：13 类核心记录软删除（联动工作项）、回收站恢复、二次确认永久删除。
- `files.ts`：`safeResolve`（拒绝绝对路径与穿越）、`atomicWrite`、`sha256`、`cleanTempFiles`。
- `clock.ts`：业务日期（WORKBENCH_BUSINESS_DATE），审计仍用真实时钟。

`src/http/plugins/request-context.ts`：中间件顺序与 Python local_access_guard 一致
（请求 ID → 设备鉴权 → 范围绑定 → 渠道/操作者 → 审计上下文 → 路由 → 缺省写审计 → 释放）。
关键实现：必须用**回调风格** onRequest 钩子并在 ALS 上下文中同步调用 `done()`，
promise 风格钩子不会传播（已实验验证）。

`src/http/routes/system.ts`：配对/claim/设备管理/撤权/登出/审计/运行时接口（本机限制 403）。

验证（tests/integration/security.test.ts，19 项）：
- 50 个并发请求的班级/学期/渠道/操作者完全隔离；无请求时回退默认范围。
- 配对全流程（生成→claim→认证→单次使用→过期→撤权→全部撤权）。
- 局域网鉴权中间件：未配对 401、配对后凭证访问、撤权后 401、非本机管理 403。
- 审计脱敏（api_key/监护人电话/家庭住址 → ***）、缺省写审计带渠道/操作者。
- 回收站软删联动工作项、恢复、二次确认永久删除。
- 业务日期、safeResolve 穿越拒绝、原子写入、临时文件清理。
- 端到端：--lan 启动后 access-info/pairing/claim/devices/audit 全链路验证。

## MIG-03 SQLite 与迁移引擎（已交付）

`src/db/`：
- `schema.ts`：基础 schema + 全部历史迁移 v2-v25 逐条移植（SQL 与 Python 一致，
  仅翻译不增加版本号）；`initSchema` 复刻 Python 逻辑（迁移表、v1 标记、高版本拒绝、
  迁移前备份、版本标记成功后写入）。
- `connection.ts`：`WorkbenchDb` 受控单连接（WAL、busy_timeout=5000、外键）、
  `withTransaction`（失败回滚）、`createBackup`（SQLite backup API，文件名与 Python 一致）、
  迁移前同步备份（checkpoint + 复制）。
- `snapshot.ts`：schema/行数快照，结构与 MIG-00 Python 基线完全一致，用于逐项比对。
- 启动接入：`entry.ts` 把数据库初始化作为启动任务，`/api/system/health` 的 ready
  仅在数据库打开成功后为 true；退出时受控关闭。

验证（tests/integration/db-migrate.test.ts，14 项）：
- 空库：Node 新库 schema 快照与 Python 基线逐字节一致；82 张表 CREATE SQL 逐条一致；
  迁移自带数据（默认班级/学期/在班关系）行数一致。
- 旧版升级：v4-sample 经 Node 引擎升级后与 Python `v4-upgraded` 基线完全一致；
  v10/v15/v20 空库升级后与 `empty-v25` 一致。
- 跨引擎：Node 升级后的库 Python 可读、integrity_check=ok、学号行数一致。
- 幂等：重复 open 不重复迁移；高版本（26）拒绝启动。
- 并发：100 次并发异步读取；同文件两连接写冲突 SQLITE_BUSY 且不静默覆盖。
- 备份：createBackup 一致性备份、恢复后数据一致、迁移前自动生成 pre-migrate-v5 备份。
- 中断恢复：注入失败迁移 → 版本停在 24，修复后重启到 25。
- withTransaction 提交/回滚。
