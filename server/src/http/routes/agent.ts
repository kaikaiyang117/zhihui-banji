/* Agent 基础路由：状态、配置、工具、对话（含流式）、会话、审计与用量。
 * 全量会话管理与确认写入在 AGENT-02/03 扩展；本文件先提供可运行子集。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';

import { AgentRunner } from '../../agent/runner.js';
import { pendingForSession, confirmAction, cancelAction, ActionError } from '../../agent/actions.js';
import { SessionStore } from '../../agent/sessionStore.js';
import { listTools, invokeTool, listAudits, usageStats } from '../../agent/agentService.js';
import { ToolError } from '../../agent/toolRegistry.js';
import { loadConfig, saveConfig, publicConfig, ModelConfigError } from '../../agent/modelConfig.js';
import { ModelError, ModelNotConfigured } from '../../agent/modelClient.js';
import { wechatService } from '../../wechat/service.js';
import { currentActor } from '../../services/audit.js';

function mapAgentError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof ModelNotConfigured || error instanceof ModelError || error instanceof ModelConfigError) {
    return reply.status(400).send({ detail: (error as Error).message });
  }
  if (error instanceof ToolError) {
    return reply.status(400).send({ detail: error.message, code: error.code });
  }
  return undefined;
}

/* 身份一律来自请求上下文（request-context 插件绑定），不接受客户端在 body/query 中
 * 自行声明的 channel/actor_id，防止渠道冒充与跨身份确认写入（权限在服务端）。 */
function boundIdentity(): { channel: string; actorId: string } {
  const { channel, actorId } = currentActor();
  return { channel, actorId };
}

/** 会话命名空间校验：网页与局域网设备共用 web: 前缀，微信内部使用 wechat:。 */
function sessionNamespaceError(sessionId: string, channel: string): string | null {
  const id = String(sessionId ?? '');
  if (!id) return '缺少会话 ID';
  if (channel === 'wechat') {
    return id.startsWith('wechat:') ? null : '微信会话 ID 必须使用 wechat: 前缀';
  }
  if (channel === 'web' || channel === 'lan') {
    return id.startsWith('web:') ? null : '网页会话 ID 必须使用 web: 前缀';
  }
  return null;
}

export function registerAgentRoutes(app: FastifyInstance): void {
  app.get('/api/agent/status', async () => {
    const config = loadConfig();
    const wechatStatus = wechatService.status();
    return {
      enabled: true,
      model: config.model || 'not_configured',
      model_configured: Boolean(config.api_key && config.model && config.base_url),
      wechat: 'iLink',
      wechat_configured: Boolean(wechatStatus.configured),
      wechat_running: Boolean(wechatStatus.running),
      tool_count: listTools().length,
      message: 'Agent 工具、模型客户端和微信接入接口已就绪，是否启用取决于本地配置。',
    };
  });

  app.get('/api/agent/config', async (request, reply) => {
    const host = request.ip;
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost' && host !== 'testclient') {
      return reply.status(403).send({ detail: '模型配置只能在工作台本机管理' });
    }
    return publicConfig(loadConfig() as unknown as Record<string, unknown>);
  });

  app.put('/api/agent/config', async (request, reply) => {
    const host = request.ip;
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost' && host !== 'testclient') {
      return reply.status(403).send({ detail: '模型配置只能在工作台本机管理' });
    }
    const body = request.body as Record<string, unknown>;
    try {
      return saveConfig({
        api_key: body.api_key === undefined ? null : String(body.api_key),
        base_url: String(body.base_url ?? ''),
        model: String(body.model ?? ''),
        thinking: String(body.thinking ?? 'disabled'),
        clear_api_key: body.clear_api_key === true,
      });
    } catch (error) {
      const mapped = mapAgentError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get('/api/agent/tools', async (request) => {
    const { channel = 'local' } = request.query as { channel?: string };
    return { tools: listTools(channel) };
  });

  app.post('/api/agent/tools/:toolName', async (request, reply) => {
    const { toolName } = request.params as { toolName: string };
    const body = request.body as { arguments?: Record<string, unknown>; session_id?: string };
    const { channel, actorId } = boundIdentity();
    const namespaceError = sessionNamespaceError(String(body.session_id ?? ''), channel);
    if (namespaceError) {
      return reply.status(422).send({ detail: namespaceError });
    }
    try {
      const result = invokeTool(toolName, body.arguments ?? {}, {
        channel, actorId,
        sessionId: String(body.session_id ?? ''),
      });
      return { ok: true, tool: toolName, result };
    } catch (error) {
      if (error instanceof ToolError) {
        return reply.status(400).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.post('/api/agent/chat', async (request, reply) => {
    const body = request.body as { session_id: string; message: string };
    if (String(body.message ?? '').length < 1) {
      return reply.status(422).send({
        detail: [{
          ctx: { min_length: 1 },
          input: String(body.message ?? ''),
          loc: ['body', 'message'],
          msg: 'String should have at least 1 character',
          type: 'string_too_short',
        }],
      });
    }
    const { channel, actorId } = boundIdentity();
    const namespaceError = sessionNamespaceError(body.session_id, channel);
    if (namespaceError) {
      return reply.status(422).send({ detail: namespaceError });
    }
    try {
      const runner = new AgentRunner({ sessionStore: new SessionStore() });
      const answer = await runner.chat(body.session_id, body.message, {
        channel, actorId,
      });
      return { answer, session_id: body.session_id, ok: true };
    } catch (error) {
      const mapped = mapAgentError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/agent/chat/stream', async (request, reply) => {
    const body = request.body as { session_id: string; message: string };
    const { channel, actorId } = boundIdentity();
    const namespaceError = sessionNamespaceError(body.session_id, channel);
    if (namespaceError) {
      return reply.status(422).send({ detail: namespaceError });
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    const runner = new AgentRunner({ sessionStore: new SessionStore() });
    try {
      for await (const event of runner.chatStream(body.session_id, body.message, {
        channel, actorId,
      })) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: (error as Error).message })}\n\n`);
    } finally {
      reply.raw.write('data: {"type":"done"}\n\n');
      reply.raw.end();
    }
    return reply;
  });

  app.get('/api/agent/sessions', async (request) => {
    const { prefix = '' } = request.query as { prefix?: string };
    const { channel } = boundIdentity();
    const prefixValue = String(prefix ?? '');
    if ((channel === 'web' || channel === 'lan') && prefixValue && !prefixValue.startsWith('web:')) {
      return { sessions: [] };
    }
    return { sessions: new SessionStore().list(prefixValue) };
  });

  app.get('/api/agent/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { channel } = boundIdentity();
    const namespaceError = sessionNamespaceError(sessionId, channel);
    if (namespaceError) {
      return reply.status(404).send({ detail: '会话不存在' });
    }
    const messages = new SessionStore().load(sessionId);
    if (!messages.length) return reply.status(404).send({ detail: '会话不存在' });
    return { messages };
  });

  app.put('/api/agent/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { channel } = boundIdentity();
    const namespaceError = sessionNamespaceError(sessionId, channel);
    if (namespaceError) {
      return reply.status(404).send({ detail: '会话不存在' });
    }
    const body = request.body as { title?: string };
    try {
      const result = new SessionStore().rename(sessionId, String(body.title ?? ''));
      return result;
    } catch (error) {
      return reply.status(400).send({ detail: (error as Error).message });
    }
  });

  app.delete('/api/agent/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { channel } = boundIdentity();
    const namespaceError = sessionNamespaceError(sessionId, channel);
    if (namespaceError) {
      return reply.status(404).send({ detail: '会话不存在' });
    }
    new SessionStore().clear(sessionId);
    return { ok: true };
  });

  app.get('/api/agent/actions/pending', async (request) => {
    const { session_id } = request.query as { session_id?: string };
    const { actorId } = boundIdentity();
    const pending = pendingForSession(session_id ?? '', actorId);
    if (!pending) return { pending: null };
    return { pending };
  });

  app.post('/api/agent/actions/:actionId/confirm', async (request, reply) => {
    const { actionId } = request.params as { actionId: string };
    const body = request.body as { session_id?: string; confirmation_token?: string };
    const { channel, actorId } = boundIdentity();
    const namespaceError = sessionNamespaceError(String(body.session_id ?? ''), channel);
    if (namespaceError) {
      return reply.status(422).send({ detail: namespaceError });
    }
    try {
      const result = confirmAction(Number(actionId), {
        sessionId: body.session_id ?? '', actorId,
        token: body.confirmation_token ?? '',
      });
      return { ok: true, ...result };
    } catch (error) {
      if (error instanceof ActionError) {
        return reply.status(400).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.post('/api/agent/actions/:actionId/cancel', async (request, reply) => {
    const { actionId } = request.params as { actionId: string };
    const body = request.body as { session_id?: string };
    const { channel, actorId } = boundIdentity();
    const namespaceError = sessionNamespaceError(String(body.session_id ?? ''), channel);
    if (namespaceError) {
      return reply.status(422).send({ detail: namespaceError });
    }
    try {
      return cancelAction(Number(actionId), {
        sessionId: body.session_id ?? '', actorId,
      });
    } catch (error) {
      if (error instanceof ActionError) {
        return reply.status(400).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.get('/api/agent/audit', async (request) => {
    const { limit = '50' } = request.query as { limit?: string };
    return { items: listAudits(Number(limit)) };
  });

  app.get('/api/agent/usage', async () => usageStats());
}
