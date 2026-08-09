# Agent 与微信 iLink 接入配置

当前实现由美美工作台自己运行 Agent，不依赖 OpenClaw。模型使用 OpenAI-compatible HTTP 接口；微信使用腾讯 iLink Bot 的扫码和消息接口。

Agent 的已完成能力和后续阶段任务见：[Agent 代理清单](Agent代理清单.md)。

## 1. 安装依赖

```bash
pip install -r backend/requirements.txt
```

`keyring` 会把扫码得到的微信 Bot Token 保存到 macOS Keychain 或 Windows 系统凭据库。若开发环境没有可用的系统凭据库，可以改用环境变量提供 Token。

## 2. 配置模型

启动工作台后打开左侧“Agent 设置”，在“模型连接”中选择 DeepSeek，填写 API Key，保存并点击“测试模型”。Key 会保存到本机 `data/agent-model.json`，不会通过接口返回，也不会进入 Git。

macOS 双击 `启动工作台.command` 启动时，会自动尝试恢复已经保存的微信授权和消息循环；首次运行没有微信凭证时会正常启动，之后可在页面中扫码连接。

也可以在启动后通过环境变量配置：

```bash
export MEIMEI_MODEL_API_KEY="你的模型 API Key"
export MEIMEI_MODEL_BASE_URL="https://api.openai.com/v1"
export MEIMEI_MODEL_NAME="你的模型名称"
```

`MEIMEI_MODEL_BASE_URL` 也可以指向其他兼容 `/chat/completions` 和 tool calling 的服务。

## 3. 微信扫码授权

推荐直接打开工作台的“Agent 设置”→“微信 iLink 连接”：

1. 点击“扫码连接微信”，在页面中用微信扫描二维码并确认。
2. 页面会自动轮询登录状态；确认后会自动启动消息循环。
3. 在“使用授权”中加入允许使用 Agent 的微信用户 ID，然后保存授权策略。
4. 回到微信发送“查询张三”等问题。

默认是白名单模式，未授权用户会收到自己的用户 ID，管理员可把这个 ID 加入页面白名单。临时联调可以勾选“允许所有微信用户”，测试完成后应关闭。

命令行方式如下：

启动工作台后，调用：

```bash
curl -X POST http://127.0.0.1:5000/api/wechat/login/start
```

返回结果中的 `qrcode_img_content` 是二维码图片内容。扫码确认后，轮询：

```bash
curl -X POST http://127.0.0.1:5000/api/wechat/login/poll
```

返回 `status=confirmed` 后，凭证会保存到系统凭据库，并自动启动消息接收循环。

也可以通过环境变量直接提供已获得的 Token：

```bash
export MEIMEI_WECHAT_BOT_TOKEN="你的 ilink_bot_token"
export MEIMEI_WECHAT_ALLOW_USERS="微信用户ID1,微信用户ID2"
export MEIMEI_WECHAT_ENABLED=true
```

界面保存的授权策略位于本机 `data/wechat-config.json`，不会进入 Git。若设置了 `MEIMEI_WECHAT_ALLOW_USERS`，环境变量优先，界面会显示“由环境变量管理”。

## 4. 本地测试 Agent

```bash
curl -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:5000/api/agent/chat \
  -d '{"session_id":"web:local-user:main","message":"查询张三的基本信息"}'
```

当前 Agent 同时提供查询工具和四个低风险确认写工具。查询工具包括学生搜索、批量学生字段查询、学生分布聚合、学生档案、学生时间线、班级学生总人数、考勤、成绩、待办和家校沟通；询问“所有学生家长的职业”“家长职业分布”等问题时，会在服务端一次批量查询或聚合，不要求模型逐个读取学生档案。写工具包括创建待办、记录家校沟通、保存单条考勤和记录行为积分。

批量学生查询只允许字段白名单，当前支持学号、姓名、性别、出生年月、民族、监护人姓名、监护人职业、第二监护人姓名/关系、是否住校、特长和班级任职，不返回监护人电话、家庭住址或备注。当前学生表只有“监护人1职业”字段，暂未提供“监护人2职业”字段。

写操作不会直接执行：Agent 先生成包含参数的操作预览，用户明确回复“确认”后才执行，回复“取消”则放弃。确认有效期为 10 分钟，确认内容会与参数绑定；写入前自动创建 SQLite 备份，并记录操作审计。当前仍不开放删除、批量写入、数据库恢复和敏感字段写入。

微信中可以使用以下命令管理当前用户的对话上下文：

```text
/新会话
/清空会话
```

两个命令效果相同，只会清空当前微信用户与“凯凯小兵”的 Agent 对话记录，不会删除工作台业务数据。

## 5. 运行状态

```text
GET  /api/agent/status
GET  /api/agent/config
PUT  /api/agent/config
GET  /api/wechat/status
GET  /api/wechat/config
PUT  /api/wechat/config
GET  /api/agent/tools
GET  /api/agent/audit
GET  /api/agent/usage
GET  /api/agent/actions/pending?session_id=...
POST /api/agent/actions/{action_id}/confirm
POST /api/agent/actions/{action_id}/cancel
```

网页端使用 `web:{用户}:{会话}` 保存会话；微信端按 `wechat:<from_user_id>` 保存每个微信用户的主会话。两个渠道不会共享会话 ID。iLink 的 `get_updates_buf` 和消息 ID 也会保存到 SQLite，避免程序重启后重复处理消息。
