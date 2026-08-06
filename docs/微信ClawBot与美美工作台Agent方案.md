# 微信 ClawBot 与美美工作台 Agent 方案

> 文档状态：方案设计，尚未实现
>
> 整理日期：2026-08-06
>
> 适用架构：本地桌面主程序 + 局域网移动访问端

## 1. 方案结论

美美工作台不强制依赖 OpenClaw，也可以直接实现自己的 Agent，并通过微信 ClawBot 接收和回复消息。

推荐的产品结构是：

```text
微信 ClawBot / iLink
        │
        ▼
美美工作台微信客户端
        │
        ▼
美美工作台 Agent
   ┌────┴────┐
   ▼         ▼
大模型 API   工作台工具层
                  │
                  ▼
          SQLite / 本地业务数据
```

MCP 不作为唯一的 Agent 运行时，而是作为统一的工具协议：

- 美美工作台内部 Agent 可以调用工作台工具；
- MCP Server 可以把相同工具暴露给 OpenClaw、Claude 或其他外部 Agent；
- 微信 ClawBot 只负责消息接入，不负责业务数据处理。

## 2. 为什么可行

腾讯官方 `openclaw-weixin` 仓库公开了微信后端协议，并明确说明二次开发者可以对接自己的后端。官方列出的核心接口包括：

- `getUpdates`：长轮询接收消息；
- `sendMessage`：发送文字、图片、视频或文件；
- `getUploadUrl`：获取媒体上传地址；
- `getConfig`：获取输入状态配置；
- `sendTyping`：发送或取消“正在输入”状态。

接口使用 HTTP + JSON，鉴权使用 `ilink_bot_token`、Bearer Token 和 `X-WECHAT-UIN` 请求头。详情见[腾讯官方微信插件后端 API 协议](https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md)。

因此，OpenClaw 是官方提供的一个 Agent/Gateway 实现和参考接入方式，但不是微信协议层面的唯一后端。

### 2.1 与 OpenClaw 的关系

官方 OpenClaw 插件安装流程要求本机存在 OpenClaw，并通过 `openclaw channels login --channel openclaw-weixin` 完成扫码登录；这是使用官方插件的方式，不代表自建后端必须复用 OpenClaw。[官方插件说明](https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md)

本方案选择：

> 美美工作台自己实现微信协议客户端和 Agent；OpenClaw 作为未来可选的外部 Agent，不作为当前产品的运行前提。

## 3. 目标与边界

### 3.1 第一阶段目标

- 在美美工作台中显示微信连接状态；
- 支持微信扫码授权；
- 接收微信文字指令；
- 将指令发送给美美工作台 Agent；
- 让 Agent 查询学生、考勤、成绩、任务和座位数据；
- 将结果回复到原微信会话；
- 保存微信账号凭证和消息游标；
- 断线后自动重连；
- 对写入数据的操作要求二次确认。

### 3.2 暂不实现

- 一开始不实现图片、语音、视频和文件处理；
- 不实现复杂群聊管理；
- 不开放删除学生和恢复数据库等高风险操作；
- 不把 OpenClaw 完整内嵌到安装包；
- 不把微信 Bot Token 暴露给局域网客户端；
- 不让 Agent 直接执行任意 Shell 命令。

## 4. 系统分层

### 4.1 微信接入层

建议新增：

```text
backend/app/wechat/
├── ilink_client.py       # iLink HTTP API 客户端
├── auth_service.py       # 扫码授权、Token 保存与更新
├── message_loop.py       # getUpdates 长轮询与断线重连
├── message_parser.py     # 微信消息解析
├── message_sender.py     # sendMessage、sendTyping
└── models.py             # 微信请求和响应数据结构
```

职责：

- 获取并展示登录二维码；
- 轮询扫码状态；
- 持久化 `bot_token`、`base_url`、账号 ID；
- 维护 `get_updates_buf`；
- 解析文本消息和会话上下文；
- 使用原会话的 `context_token` 回复消息。

### 4.2 Agent 层

建议新增：

```text
backend/app/agent/
├── agent_service.py      # Agent 主循环
├── model_client.py       # 大模型 API 适配
├── prompt.py             # 班主任 Agent 提示词
├── tool_registry.py      # 工具注册与权限
├── confirmation.py       # 写入操作确认
└── session_store.py      # 微信会话上下文
```

Agent 负责：

1. 判断用户意图；
2. 决定是否调用工作台工具；
3. 组织结构化结果；
4. 对写入操作发起确认；
5. 处理失败、超时和权限不足；
6. 将最终结果转换成适合微信阅读的文本。

### 4.3 工具层

工具层必须复用现有业务服务和数据校验，不应该让 Agent 直接拼接 SQL。

建议把工具实现抽象为普通 Python 服务函数，然后提供两种适配器：

```text
业务服务函数
   ├── Agent 内部调用适配器
   └── MCP Server 调用适配器
```

这样内部 Agent 和外部 MCP 客户端使用同一套业务逻辑，不会出现两套数据规则。

## 5. 微信消息处理流程

### 5.1 首次授权

```text
用户点击“连接微信”
        ↓
美美工作台请求登录二维码
        ↓
用户使用微信扫码并确认
        ↓
服务端返回 bot_token / base_url / account_id
        ↓
凭证加密保存到本地用户数据目录
        ↓
启动消息长轮询
```

### 5.2 接收和回复消息

```text
getUpdates 长轮询
        ↓
收到用户文本和 context_token
        ↓
消息去重、权限检查、会话恢复
        ↓
Agent 分析意图
        ↓
调用工作台工具
        ↓
生成微信可读回复
        ↓
sendMessage 携带原 context_token 回复
```

`get_updates_buf` 是消息游标，必须在成功接收后持久化，否则程序重启或重连时可能重复处理消息。`context_token` 用于关联原微信会话，回复时必须使用正确的上下文。

## 6. 第一批 Agent 工具

### 6.1 只读工具

第一阶段只开放查询工具，降低误操作风险：

| 工具名 | 作用 | 关键参数 |
|---|---|---|
| `students_search` | 按姓名或学号搜索学生 | `keyword` |
| `student_get_profile` | 查看学生基本档案 | `student_id` |
| `student_get_timeline` | 查看学生事件和成长记录 | `student_id` |
| `attendance_summary` | 查询考勤统计 | 日期范围、学生 ID |
| `scores_summary` | 查询学生或班级成绩 | 学生 ID、考试名称 |
| `tasks_list` | 查询待办和逾期事项 | 状态、日期范围 |
| `seating_get` | 查询座位安排 | 学生 ID或全部 |
| `class_overview` | 查询班级整体概况 | 无 |

### 6.2 需要确认的写入工具

写入工具必须先生成确认预览，用户明确回复“确认”后才能执行：

| 工具名 | 作用 |
|---|---|
| `task_create` | 创建班级待办 |
| `communication_create` | 记录家校沟通 |
| `attendance_save` | 保存考勤 |
| `points_add` | 增加或扣除行为积分 |
| `student_update` | 修改学生档案 |
| `backup_create` | 创建数据库备份 |

确认消息示例：

```text
我准备记录：张三，2026-08-06，状态“迟到”，备注“早读迟到”。
回复“确认”后执行，回复“取消”放弃。
```

### 6.3 初期禁止的工具

以下能力在第一版不提供给 Agent：

- `student_delete`；
- `bulk_import`；
- `database_restore`；
- `database_delete`；
- 任意 Shell、Python 或文件系统执行工具。

## 7. MCP 设计

MCP Server 的定位是“工作台能力适配层”，不是微信客户端。

建议未来提供：

```text
backend/mcp_server.py
```

第一版优先使用本地 stdio 传输，避免把 MCP 端口暴露到局域网。OpenClaw 支持使用本地命令配置 MCP Server，也支持通过 `openclaw mcp doctor --probe` 检查服务是否能启动并暴露工具。[OpenClaw MCP 文档](https://github.com/openclaw/openclaw/blob/main/docs/cli/mcp.md)

示例配置：

```json
{
  "mcp": {
    "servers": {
      "meimei-workbench": {
        "command": "/path/to/python",
        "args": [
          "/path/to/workbench/backend/mcp_server.py"
        ]
      }
    }
  }
}
```

MCP 工具必须使用最小权限和工具白名单。OpenClaw 的 MCP 工具还会受到沙箱工具策略限制，配置后需要确认工具确实被 Agent 看到。[OpenClaw 工具策略说明](https://docs.openclaw.ai/gateway/config-tools)

## 8. 安全设计

### 8.1 凭证安全

- `bot_token` 不写入 Git；
- 不通过二维码或微信消息显示 Token；
- macOS 使用 Keychain 保存敏感凭证；
- Windows 使用系统凭据存储或受保护的数据目录；
- 日志中隐藏 Token、Authorization 和完整消息凭证。

### 8.2 微信用户白名单

第一阶段应建立微信用户白名单：

- 未授权用户只能收到“未授权”提示；
- 只有管理员微信 ID 可以执行工作台工具；
- 写入操作必须再次确认；
- 可配置是否允许群聊；
- 管理员可以解除绑定和轮换 Token。

### 8.3 数据权限

Agent 不直接访问 SQLite 文件，不直接执行 SQL。所有数据访问必须经过工作台服务函数，并执行：

- 学生 ID 校验；
- 字段白名单校验；
- 写入内容校验；
- 审计日志记录；
- 数据库备份策略。

## 9. 会话和任务策略

微信消息适合短任务，因此第一阶段需要限制：

- 单次 Agent 执行时间；
- 单次工具调用次数；
- 返回消息长度；
- 并发任务数量；
- 单个微信用户的请求频率。

长任务应先回复：

```text
已收到，我正在查询并整理，完成后会继续回复。
```

任务完成后再发送结果。若任务超时，应发送失败原因，而不是让用户一直等待。

## 10. 开发阶段

### 阶段一：微信文字通道 MVP

- 实现扫码授权；
- 保存 Token 和账号信息；
- 实现 `getUpdates` 长轮询；
- 实现文本 `sendMessage`；
- 保存消息游标；
- 实现断线重连；
- 增加微信连接状态页面；
- 使用测试账号完成收发消息。

### 阶段二：班主任 Agent

- 接入一个大模型供应商；
- 实现班主任 Agent 提示词；
- 实现只读工具；
- 加入工具调用日志；
- 加入用户白名单；
- 加入超时、重试和错误提示；
- 完成“查询学生、考勤、成绩、待办”闭环。

### 阶段三：安全写入能力

- 添加任务、沟通、考勤和积分工具；
- 增加确认状态机；
- 增加确认过期时间；
- 写入前自动备份；
- 记录 Agent 操作审计；
- 增加撤销或人工恢复方案。

### 阶段四：MCP 与桌面集成

- 将工作台工具抽象成统一工具定义；
- 实现本地 stdio MCP Server；
- 支持 OpenClaw 等外部 Agent 调用；
- 在桌面端显示 MCP 和 Agent 状态；
- 增加 Agent 配置、模型配置和日志查看；
- 将微信客户端、Agent 和 MCP 的启动状态纳入桌面程序。

### 阶段五：媒体和多账号

- 图片、语音、视频和文件；
- 媒体加密上传与下载；
- 多微信账号；
- 多账号会话隔离；
- 群聊策略和群成员权限。

## 11. 验收标准

### 第一阶段验收

- 可以从工作台发起微信扫码授权；
- 授权凭证重启后仍然有效；
- 微信发送文字后，工作台能收到；
- 工作台回复后，微信能收到；
- 程序重启不会重复处理已确认消息；
- 网络断开后可以自动重连；
- Token 不出现在普通日志中。

### Agent 阶段验收

- 微信可以查询学生和班级概况；
- Agent 只能调用白名单工具；
- 查询结果使用结构化数据生成；
- 写入操作必须确认；
- 错误和超时能返回明确提示；
- 所有写入操作都有审计记录和测试数据。

### MCP 阶段验收

- `openclaw mcp doctor --probe` 可以发现工具；
- MCP 工具和内部 Agent 使用同一套业务服务；
- 禁止工具不会出现在 Agent 工具列表中；
- MCP 服务不会监听公网或局域网地址；
- 工作台关闭后，MCP 服务能正常退出。

## 12. 风险和决策记录

| 风险 | 影响 | 应对方式 |
|---|---|---|
| 微信 iLink 协议变化 | 微信收发消息失效 | 将协议客户端独立封装，保留集成测试 |
| Token 泄露 | 他人控制 Bot | 系统凭据存储、日志脱敏、支持解绑和轮换 |
| Agent 误修改数据 | 班级数据错误 | 只读优先、写入确认、操作审计、升级前备份 |
| 长任务回复失败 | 微信收不到最终结果 | 进度消息、任务超时、重试和短任务拆分 |
| 大模型返回错误 | 工具调用错误 | 参数 schema、服务端二次校验、工具白名单 |
| 桌面打包复杂 | 安装包体积和启动问题 | 第一阶段不内嵌 OpenClaw，只打包自有 Agent |

## 13. 当前状态

| 模块 | 状态 |
|---|---:|
| 微信协议客户端 | ⬜ 待实现 |
| 微信扫码授权 | ⬜ 待实现 |
| 微信文字收发 | ⬜ 待实现 |
| 美美工作台 Agent | ⬜ 待实现 |
| 工作台只读工具 | ⬜ 待实现 |
| 工作台写入工具确认 | ⬜ 待实现 |
| MCP Server | ⬜ 待实现 |
| Agent 操作审计 | ⬜ 待实现 |
| 桌面端 Agent 状态界面 | ⬜ 待实现 |

## 14. 第一批建议开发任务

1. 建立 `backend/app/wechat/` 模块和数据结构；
2. 实现微信扫码授权流程；
3. 实现文字消息长轮询和回复；
4. 增加本地 Token 安全存储；
5. 添加微信连接状态接口和前端页面；
6. 实现 `students_search`、`student_get_profile`、`attendance_summary` 三个只读工具；
7. 使用测试账号完成端到端验证；
8. 再接入大模型 Agent，不要先开放写入操作。
