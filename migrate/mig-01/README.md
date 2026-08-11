# MIG-01 技术试验与依赖锁定

验证 Node.js 迁移的最危险底层依赖，全部通过后才开始 MIG-02 大规模移植。
对应方案文档 `Node.js后端与凯凯小兵Agent改造方案.md` 第 10.2 节。

## 依赖锁定（2026-08-11）

| 包 | 版本 | 说明 |
|---|---|---|
| better-sqlite3 | `12.4.1`（精确） | **不能升级到 13.x**：13 要求 Node ≥22，与 Electron 33（Node 20）ABI 不兼容；12.4.1 覆盖 Node 20-24 |
| exceljs | `4.4.0` | 全部 8 个黄金工作簿语义一致 |
| @langchain/langgraph | `1.4.9` | 状态图/中断/检查点验证通过 |
| @langchain/langgraph-checkpoint-sqlite | `1.0.3` | 检查点独立库验证通过 |
| @langchain/core | `1.2.5` | 仅依赖版本锁定 |
| typescript / tsx / @electron/rebuild | 见 lockfile | strict 类型检查通过 |

MIG-10 升级 Electron 到新主版本后，重新评估 better-sqlite3 13.x。

## 运行

```bash
cd migrate/mig-01
npm install
npm test                    # typecheck + SQLite(Node) + Excel + LangGraph
npm run exp:electron        # better-sqlite3 重建为 Electron ABI → Electron 内试验 → 重建回 Node ABI
```

前置：`python migrate/baseline/02_db_baselines.py`（数据库样本）和
`python migrate/mig-01/scripts/generate-golden-excel.py`（黄金工作簿）。

CI：`.github/workflows/ci.yml` 的 `mig-01-experiments` 作业在
ubuntu/macOS(arm64)/Windows 三平台执行全部试验（含 Electron ABI）。

## 试验 A：SQLite（17/17 通过）

- better-sqlite3 直读现有 v25 库与旧版 v4 库：WAL、外键、busy_timeout=5000、中文列名、JSON 列均正常。
- 事务提交/回滚、4 线程 × 200 次并发读取、写冲突（SQLITE_BUSY，不覆盖）、
  `integrity_check`/`foreign_key_check`、backup API（行数与完整性一致）。
- **Electron ABI**：`@electron/rebuild` 后 better-sqlite3 在 Electron 33（Node 20.18.3，modules 130）
  中正常加载并完成全部检查（macOS arm64 实测；Windows/macOS x64 由 CI 矩阵提供证据）。

关键发现：
- WAL 模式下仅复制主文件会丢失 `-wal` 中已提交数据；复制前必须
  `PRAGMA wal_checkpoint(TRUNCATE)`（已修复基线工具，Node 迁移同样适用）。

## 试验 B：Excel（9/9 通过）

- exceljs 读取 8 个黄金工作簿（学生模板/导出、工作表导出、考勤/成绩汇总、评语、班费、健康）
  与 openpyxl 语义完全一致：sheet 名/顺序、维度、合并单元格、冻结窗格、列宽、
  单元格值/类型、日期、公式、加粗。
- 反向：exceljs 生成（合并/冻结/列宽/日期/公式）→ openpyxl 读回一致。

关键发现：
- **日期时区偏移**：直接写 JS `Date` 会被 exceljs 按 UTC 序列化，本地日期会偏移一天
  （4 月 15 日写成 14 日）。Node 导出服务必须按 openpyxl 约定写“朴素本地日期”序列号
  （1899-12-30 起算的本地日历分量），实验脚本 `naiveDateSerial` 即该实现。
- exceljs 对被合并单元格返回主值、openpyxl 返回空：语义提取需按合并范围归一化。
- openpyxl 默认 `number_format='General'` 与 exceljs 的 `''` 等价。

## 试验 C：LangGraph（11/11 通过）

- StateGraph + 条件边确定性路由；自定义流事件（`streamMode: ['updates','custom']`
  返回 `[mode, payload]` 数组，节点用 `config.writer` 发射）。
- SQLite checkpointer 独立临时库：线程检查点、挂起状态查询、**新图实例共享同一
  checkpointer 恢复**（模拟进程重启）、interrupt 人工确认暂停。
- **副作用幂等**：恢复后写入计数器恰好为 1；完成后状态与图版本跨实例一致。
- 并发线程隔离；检查点库只含 `checkpoints`/`writes` 表，不触碰业务表。

关键发现（LangGraph 1.x API 注意点）：
- 配置必须用 `{ configurable: { thread_id } }`（直接 `{ thread_id }` 会报错）。
- `graph.stream()` 返回 Promise，需 `await graph.stream(...)`。
- 双确认防护仍必须由业务层（`agent_actions` + 参数哈希 + TTL）承担；
  框架 interrupt 只负责流程暂停，重放防御见方案 11.4 节。

## 结论

三项试验全部通过，`server/`（MIG-02 起）技术基线成立：
better-sqlite3 12.4.1 + exceljs 4.4.0 + LangGraph 1.4.x，均可在 Node 22 与 Electron 33
下工作。下一工作包：`MIG-02` Node 服务骨架（Fastify、配置、生命周期、静态资源、错误与日志）。
