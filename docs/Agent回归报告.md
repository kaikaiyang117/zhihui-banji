# 美美工作台 Agent 回归报告

> 验收日期：2026-08-20
> 数据环境：临时 SQLite 数据库，未使用真实学生数据
> 当前基线：schema v33，注册表 33 个工具；网页 Agent 支持 `.xlsx` 上传识别、预览和确认导入，微信 iLink 文件消息仍待人工验收

## 固定样例集

Agent 回归测试位于 `server/tests/integration/agent*.test.ts`，使用隔离 SQLite 和 `server/tests/fixtures/` 夹具，覆盖：

- 班级人数、学生搜索、批量字段查询和学生分布聚合的结构化结果。
- 微信渠道敏感学生档案拒绝、工具白名单和参数校验。
- malformed JSON、未知工具、重复失败熔断和工具调用恢复。
- Agent 工具审计、错误状态和确认写入后的业务状态验证。
- “查看所有的学生姓名”等自然语言变体路由到批量查询；错误关键词只自动纠正一次。

## 执行结果

本次基线验证通过：

```text
cd server && npm run typecheck:server
cd server && npm run test:server       # 18 个测试文件，218 个测试
cd server && npm run build:server
cd frontend && npm run build
cd desktop && npm test
```

桌面冒烟覆盖窗口、后端健康检查、手机访问/更新入口和退出后的端口释放。真实移动设备、微信 iLink 长时间运行、断线重连和发布签名仍属于人工验收项，见 [`发布检查清单.md`](发布检查清单.md)。

## 统计口径

Agent 工具调用统计来自 `agent_audit`；模型请求统计来自 `agent_model_usage`。模型 Token 只有在兼容接口返回 `usage.prompt_tokens` 和 `usage.completion_tokens` 时才计入，供应商未返回时不估算。
