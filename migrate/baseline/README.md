# MIG-00 回归与契约基线

本目录是 Node.js 迁移（`Node.js后端与凯凯小兵Agent改造方案.md`）的 `MIG-00` 工作包工具。
用途：在改写代码前建立可重复、可比较的旧系统（FastAPI）行为基线，供后续 Node.js 差异执行器逐项比对。

## 约束

- 所有脚本只使用临时数据目录和固定夹具，**绝不触碰** `data/workbench.db`、真实知识库和真实附件。
- 只读旧行为；不修改任何运行时代码（`backend/`、`frontend/`、`desktop/` 不改一行）。
- 输出统一写入 `out/`（已 gitignore），可随时删除后重建。

## 运行顺序

```bash
source .venv/bin/activate

python migrate/baseline/01_openapi.py        # OpenAPI 快照 + 路由清单
python migrate/baseline/02_db_baselines.py   # 数据库基线样本 + schema/计数快照
python migrate/baseline/03_api_golden.py     # API 黄金用例（21 个模块，152 个用例）
python migrate/baseline/04_agent_baseline.py # Agent 黄金轨迹（回归/对话/流式/渠道拒绝）
python migrate/baseline/00_state.py          # 仓库状态 + 四套回归命令结果
```

## 产物

| 路径 | 内容 |
|---|---|
| `out/api/openapi.json` | FastAPI OpenAPI 全量快照（189 个路径） |
| `out/api/routes-inventory.json` | 233 条路由：方法、路径、状态码、所属模块 |
| `out/api/golden-cases.json` | 152 个黄金用例：请求 + 实际状态 + 规范化响应 + 二进制摘要 |
| `out/db/` | 9 个数据库基线（每个含 `workbench.db`、`schema.json`、`counts.json`、`meta.json`） |
| `out/agent/agent-baseline.json` | Agent 轨迹：固定回归、对话、SSE 事件、渠道拒绝 |
| `out/regression.json` | 后端全量测试、前端构建、Electron 冒烟、UI 冒烟结果 |
| `out/logs/` | 上述四套命令的完整日志 |

## 数据库基线

| 基线 | 说明 |
|---|---|
| `empty-v4/10/15/20/25` | 通过限定迁移集重建的历史空库 |
| `v4-sample` | 固定旧版 SQL 样本（`backend/tests/fixtures/migration_v4.sql`） |
| `v4-upgraded` | v4 样本经当前迁移引擎升级到 v25 的结果 |
| `p0_demo` / `p1_demo` | 当前版本 + 固定夹具数据 |

`schema.json` 记录每张表的列、索引、外键、触发器和迁移版本；`counts.json` 记录每张表行数。
Node 迁移完成后，用同一脚本对 Node 库执行相同快照，逐键 diff 即为迁移验证依据。

## API 黄金用例覆盖

全部 21 个路由模块均有读取、写入和错误用例；权限/归档用例覆盖：
归档学期/班级只读放行、归档范围写入 409、本机接口 403 语义（见用例注释）、
学生唯一学号 409、状态机流转限制（评语、班费）、旧行为缺陷（如删除不存在记录返回 500）。

响应规范化允许的字段：自增 ID、时间戳、备份文件名、size。其余字段必须逐字一致。

## 已记录的旧行为缺陷（迁移时需决策）

1. `DELETE /api/education/diary/9999`（及其他 recycle 路径）：`RecycleError` 未映射为
   HTTP 错误，实际返回 500 而不是 404/400（用例 `education-08` 记录 actual=500）。
2. `PUT /api/wechat/config` 接受空配置（用例 `wechat-03` 记录 200）。
3. `POST /api/students` 重复学号返回 409（`students-04`）。
4. 学生服务不做归档写保护（归档写入拒绝只在调用 `scope_ids(write=True)` 的服务生效，
   如事件创建；用例 `context-10` 以事件验证 409）。

## 确定性验证

基线可重复：删除 `out/` 后重跑全部脚本，`golden-cases.json`、`agent-baseline.json`
和 `regression.json` 应逐字节一致（`00_state.py` 的日志和工具版本除外）。
后续差异执行器直接比较规范化 JSON，不需要重启 Python 服务。
