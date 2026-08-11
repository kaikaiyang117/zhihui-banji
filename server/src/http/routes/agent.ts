/* Agent 基础路由：状态、配置、工具、对话（含流式）、会话、审计与用量。
 * 全量会话管理与确认写入在 AGENT-02/03 扩展；本文件先提供可运行子集。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';

import { AgentRunner } from '../../agent/runner.js';
import { pendingForSession, confirmAction, cancelAction, ActionError } from '../../agent/actions.js';
import { SessionError, SessionStore } from '../../agent/sessionStore.js';
import { listTools, invokeTool, listAudits, usageStats } from '../../agent/agentService.js';
import { ToolError } from '../../agent/toolRegistry.js';
import {
  createProfile,
  deleteProfile,
  duplicateProfile,
  listProfiles,
  loadConfig,
  saveConfig,
  selectProfile,
  publicConfig,
  revealProfileKey,
  ModelConfigError,
} from '../../agent/modelConfig.js';
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
  if (error instanceof SessionError) {
    return reply.status(404).send({ detail: error.message });
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

function newWebSessionId(actorId: string): string {
  const owner = createHash('sha256').update(actorId, 'utf8').digest('hex').slice(0, 12);
  return `web:${owner}:${randomUUID()}`;
}

function isLocalConfigRequest(request: { ip: string }): boolean {
  return request.ip === '127.0.0.1' || request.ip === '::1' || request.ip === 'localhost' || request.ip === 'testclient';
}

function modelConfigPayload(): Record<string, unknown> {
  const config = loadConfig();
  return {
    ...publicConfig(config as unknown as Record<string, unknown>),
    ...listProfiles(),
  };
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
    if (!isLocalConfigRequest(request)) {
      return reply.status(403).send({ detail: '模型配置只能在工作台本机管理' });
    }
    return modelConfigPayload();
  });

  app.put('/api/agent/config', async (request, reply) => {
    if (!isLocalConfigRequest(request)) {
      return reply.status(403).send({ detail: '模型配置只能在工作台本机管理' });
    }
    const body = request.body as Record<string, unknown>;
    try {
      const saved = saveConfig({
        api_key: body.api_key === undefined || body.api_key === null ? null : String(body.api_key),
        base_url: String(body.base_url ?? ''),
        model: String(body.model ?? ''),
        thinking: String(body.thinking ?? 'disabled'),
        clear_api_key: body.clear_api_key === true,
        profile_id: body.profile_id === undefined || body.profile_id === null ? undefined : String(body.profile_id),
        profile_name: body.profile_name === undefined || body.profile_name === null ? undefined : String(body.profile_name),
      });
      return { ...saved, ...listProfiles() };
    } catch (error) {
      const mapped = mapAgentError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/agent/config/profiles', async (request, reply) => {
    if (!isLocalConfigRequest(request)) {
      return reply.status(403).send({ detail: '模型配置只能在工作台本机管理' });
    }
    const body = request.body as Record<string, unknown>;
    try {
      const created = createProfile({
        name: String(body.name ?? ''),
        api_key: body.api_key === undefined || body.api_key === null ? null : String(body.api_key),
        base_url: String(body.base_url ?? ''),
        model: String(body.model ?? ''),
        thinking: String(body.thinking ?? 'disabled'),
      });
      return { ...created, ...listProfiles() };
    } catch (error) {
      const mapped = mapAgentError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/agent/config/profiles/:profileId/select', async (request, reply) => {
    if (!isLocalConfigRequest(request)) {
      return reply.status(403).send({ detail: '模型配置只能在工作台本机管理' });
    }
    const { profileId } = request.params as { profileId: string };
    try {
      selectProfile(profileId);
      return modelConfigPayload();
    } catch (error) {
      const mapped = mapAgentError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get('/api/agent/config/profiles/:profileId/key', async (request, reply) => {
    if (!isLocalConfigRequest(request)) {
      return reply.status(403).send({ detail: '模型配置只能在工作台本机管理' });
    }
    const { profileId } = request.params as { profileId: string };
    try {
      return revealProfileKey(profileId);
    } catch (error) {
      const mapped = mapAgentError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/agent/config/profiles/:profileId/duplicate', async (request, reply) => {
    if (!isLocalConfigRequest(request)) {
      return reply.status(403).send({ detail: '模型配置只能在工作台本机管理' });
    }
    const { profileId } = request.params as { profileId: string };
    const body = request.body as Record<string, unknown>;
    try {
      const duplicated = duplicateProfile(profileId, body.name === undefined ? undefined : String(body.name));
      return { ...duplicated, ...listProfiles() };
    } catch (error) {
      const mapped = mapAgentError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.delete('/api/agent/config/profiles/:profileId', async (request, reply) => {
    if (!isLocalConfigRequest(request)) {
      return reply.status(403).send({ detail: '模型配置只能在工作台本机管理' });
    }
    const { profileId } = request.params as { profileId: string };
    try {
      deleteProfile(profileId);
      return modelConfigPayload();
    } catch (error) {
      const mapped = mapAgentError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get('/api/agent/tools', async () => {
    const { channel } = boundIdentity();
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
      new SessionStore().ensureOwned(String(body.session_id ?? ''), actorId, channel);
      const result = invokeTool(toolName, body.arguments ?? {}, {
        channel, actorId,
        sessionId: String(body.session_id ?? ''),
      });
      return { ok: true, tool: toolName, result };
    } catch (error) {
      if (error instanceof ToolError) {
        return reply.status(400).send({ detail: error.message });
      }
      if (error instanceof SessionError) {
        return reply.status(404).send({ detail: error.message });
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
      new SessionStore().ensureOwned(body.session_id, actorId, channel);
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
    try {
      new SessionStore().ensureOwned(body.session_id, actorId, channel);
    } catch (error) {
      return reply.status(404).send({ detail: (error as Error).message });
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'x-vercel-ai-ui-message-stream': 'v1',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    const runner = new AgentRunner({ sessionStore: new SessionStore() });
    const writeChunk = (chunk: Record<string, unknown>): void => {
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    const messageId = randomUUID();
    const textPartId = 'text-0';
    let textStarted = false;
    let planIndex = -1;
    let currentPlanId = '';
    let currentPlan: Record<string, unknown> | null = null;
    writeChunk({ type: 'start', messageId });
    try {
      for await (const event of runner.chatStream(body.session_id, body.message, {
        channel, actorId,
      })) {
        if (event.type === 'delta') {
          if (!textStarted) {
            writeChunk({ type: 'text-start', id: textPartId });
            textStarted = true;
          }
          writeChunk({ type: 'text-delta', id: textPartId, delta: String(event.content ?? '') });
        } else if (event.type === 'plan') {
          planIndex += 1;
          currentPlanId = `plan-${planIndex}`;
          currentPlan = { ...event };
          writeChunk({ type: 'data-agent-plan', id: currentPlanId, data: currentPlan });
        } else if (event.type === 'plan_step') {
          const plan: Record<string, unknown> | null = currentPlan;
          if (plan && Array.isArray(plan.steps)) {
            const updatedSteps: Array<Record<string, unknown>> = (plan.steps as Array<Record<string, unknown>>).map((step) => (
              String(step.id) === String(event.id)
                ? { ...step, status: event.status, ...(event.message ? { message: event.message } : {}) }
                : step
            ));
            currentPlan = Object.assign({}, plan, { steps: updatedSteps });
            writeChunk({ type: 'data-agent-plan', id: currentPlanId, data: currentPlan });
          }
        } else if (event.type === 'tool') {
          const toolCallId = String(event.id || randomUUID());
          const toolName = String(event.name || '工具');
          const input = event.input ?? {};
          if (event.status === 'running') {
            writeChunk({
              type: 'tool-input-available', toolCallId, toolName,
              input, dynamic: true, title: toolName,
            });
          } else if (event.status === 'error') {
            const error = (event.output as Record<string, unknown> | undefined)?.error as Record<string, unknown> | undefined;
            writeChunk({
              type: 'tool-output-error', toolCallId,
              errorText: String(error?.message || '工具执行失败'), dynamic: true,
            });
          } else {
            writeChunk({
              type: 'tool-output-available', toolCallId,
              output: event.output ?? {}, dynamic: true,
            });
          }
        } else if (event.type === 'error') {
          writeChunk({ type: 'error', errorText: String(event.message || 'Agent 流式响应失败') });
        }
      }
    } catch (error) {
      writeChunk({ type: 'error', errorText: (error as Error).message });
    } finally {
      if (textStarted) writeChunk({ type: 'text-end', id: textPartId });
      writeChunk({ type: 'finish', finishReason: 'stop' });
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }
    return reply;
  });

  app.post('/api/agent/sessions', async (_request, reply) => {
    const { channel, actorId } = boundIdentity();
    if (channel !== 'web' && channel !== 'lan') {
      return reply.status(403).send({ detail: '当前渠道不能主动创建网页会话' });
    }
    const sessionId = newWebSessionId(actorId);
    new SessionStore().ensureOwned(sessionId, actorId, channel);
    return { session_id: sessionId, title: '新会话' };
  });

  app.get('/api/agent/sessions', async (request) => {
    const { prefix = '' } = request.query as { prefix?: string };
    const { channel, actorId } = boundIdentity();
    const prefixValue = String(prefix ?? '');
    if ((channel === 'web' || channel === 'lan') && prefixValue && !prefixValue.startsWith('web:')) {
      return { sessions: [] };
    }
    const safePrefix = (channel === 'web' || channel === 'lan') ? 'web:' : prefixValue;
    return { sessions: new SessionStore().listOwned(actorId, channel, safePrefix) };
  });

  app.get('/api/agent/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { channel, actorId } = boundIdentity();
    const namespaceError = sessionNamespaceError(sessionId, channel);
    if (namespaceError) {
      return reply.status(404).send({ detail: '会话不存在' });
    }
    const store = new SessionStore();
    if (!store.existsOwned(sessionId, actorId, channel)) {
      return reply.status(404).send({ detail: '会话不存在' });
    }
    const messages = store.loadOwned(sessionId, actorId, channel);
    return { messages };
  });

  app.put('/api/agent/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { channel, actorId } = boundIdentity();
    const namespaceError = sessionNamespaceError(sessionId, channel);
    if (namespaceError) {
      return reply.status(404).send({ detail: '会话不存在' });
    }
    const body = request.body as { title?: string };
    try {
      const result = new SessionStore().renameOwned(
        sessionId, String(body.title ?? ''), actorId, channel);
      return result;
    } catch (error) {
      return reply.status(400).send({ detail: (error as Error).message });
    }
  });

  app.delete('/api/agent/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { channel, actorId } = boundIdentity();
    const namespaceError = sessionNamespaceError(sessionId, channel);
    if (namespaceError) {
      return reply.status(404).send({ detail: '会话不存在' });
    }
    const store = new SessionStore();
    if (!store.existsOwned(sessionId, actorId, channel)) {
      return reply.status(404).send({ detail: '会话不存在' });
    }
    store.clearOwned(sessionId, actorId, channel);
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
    const { channel, actorId } = boundIdentity();
    return { items: listAudits(Number(limit), { channel, actorId }) };
  });

  app.get('/api/agent/usage', async () => {
    const { channel, actorId } = boundIdentity();
    return usageStats({ channel, actorId });
  });
}
