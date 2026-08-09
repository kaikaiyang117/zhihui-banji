# 凯凯小兵 Agent 回归报告

> 验收日期：2026-08-09
> 数据环境：临时 SQLite 数据库，未使用真实学生数据
> 数据库基线：schema v21；当前 Agent 仍只开放 4 个单条低风险确认写入工具

## 固定样例集

样例文件为 `backend/tests/fixtures/agent_regression.json`，由 `backend/tests/test_agent_regression.py` 自动读取并执行，当前覆盖：

- 班级人数查询和学生搜索的工具结果结构。
- 微信渠道敏感学生档案拒绝。
- malformed JSON 工具参数的结构化错误。
- Agent 工具审计和错误状态记录。
- “查看所有的学生姓名”等自然语言变体必须路由到批量学生查询，不得使用单学生搜索。
- 批量查询错误关键词返回空结果时，只允许纠正一次并重新查询。

## 安全写入回归

`backend/tests/test_agent.py` 覆盖创建待办的预览、确认、取消边界、10 分钟失效、确认参数绑定、重复确认幂等、写入前备份和失败留痕；同时覆盖网页/微信渠道权限、未知工具、模型重复失败熔断和工具调用恢复。

## 执行结果

```text
PYTHONPATH=. python -m unittest discover -s backend/tests -p 'test_*.py' -v
Ran 123 tests ...
OK
```

前端 `npm run build` 通过；报告、Agent 设置/会话管理、健康追踪页面和 390px 窄屏主流程通过浏览器验证。宽屏工作台和座位网格的可用宽度检查也已通过；真实移动设备和微信 iLink 长时间运行仍待人工验收。

## 统计口径

Agent 工具调用统计来自 `agent_audit`；模型请求统计来自 `agent_model_usage`。模型 Token 只有在兼容接口返回 `usage.prompt_tokens` 和 `usage.completion_tokens` 时才计入，供应商未返回时不估算。

## 下一轮扩展

新增工具、模型供应商或微信群聊能力时，必须先在固定样例集补充预期工具、权限和错误断言，再修改能力矩阵和发布检查清单。
