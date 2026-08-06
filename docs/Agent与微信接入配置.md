# Agent 与微信 iLink 接入配置

当前实现由美美工作台自己运行 Agent，不依赖 OpenClaw。模型使用 OpenAI-compatible HTTP 接口；微信使用腾讯 iLink Bot 的扫码和消息接口。

## 1. 安装依赖

```bash
pip install -r backend/requirements.txt
```

`keyring` 会把扫码得到的微信 Bot Token 保存到 macOS Keychain 或 Windows 系统凭据库。若开发环境没有可用的系统凭据库，可以改用环境变量提供 Token。

## 2. 配置模型

启动后端前设置：

```bash
export MEIMEI_MODEL_API_KEY="你的模型 API Key"
export MEIMEI_MODEL_BASE_URL="https://api.openai.com/v1"
export MEIMEI_MODEL_NAME="你的模型名称"
```

`MEIMEI_MODEL_BASE_URL` 也可以指向其他兼容 `/chat/completions` 和 tool calling 的服务。

## 3. 微信扫码授权

启动工作台后，调用：

```bash
curl -H "X-Workbench-Token: <访问令牌>" \
  -X POST http://127.0.0.1:5000/api/wechat/login/start
```

返回结果中的 `qrcode_img_content` 是微信扫码地址。扫码确认后，轮询：

```bash
curl -H "X-Workbench-Token: <访问令牌>" \
  -X POST http://127.0.0.1:5000/api/wechat/login/poll
```

返回 `status=confirmed` 后，凭证会保存到系统凭据库，并自动启动消息接收循环。

也可以通过环境变量直接提供已获得的 Token：

```bash
export MEIMEI_WECHAT_BOT_TOKEN="你的 ilink_bot_token"
export MEIMEI_WECHAT_ALLOW_USERS="微信用户ID1,微信用户ID2"
export MEIMEI_WECHAT_ENABLED=true
```

`MEIMEI_WECHAT_ALLOW_USERS` 为空时不启用白名单，适合本地测试；正式使用应填写管理员微信用户 ID。

## 4. 本地测试 Agent

```bash
curl -H "X-Workbench-Token: <访问令牌>" \
  -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:5000/api/agent/chat \
  -d '{"session_id":"local:me","message":"查询张三的基本信息"}'
```

第一版只开放查询工具，不开放修改、删除、批量导入和数据库恢复。

## 5. 运行状态

```text
GET  /api/agent/status
GET  /api/wechat/status
GET  /api/agent/tools
GET  /api/agent/audit
```

微信消息会按 `wechat:<from_user_id>` 保存 Agent 会话，iLink 的 `get_updates_buf` 和消息 ID 也会保存到 SQLite，避免程序重启后重复处理消息。
