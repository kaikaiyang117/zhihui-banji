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

function mapAgentError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof ModelNotConfigured || error instanceof ModelError || error instanceof ModelConfigError) {
    return reply.status(400).send({ detail: (error as Error).message });
  }
  if (error instanceof ToolError) {
    return reply.status(400).send({ detail: error.message, code: error.code });
  }
  return undefined;
}

function toolErrorDetail(error: unknown): { message: string; code?: string } | null {
  if (error instanceof ToolError) return { message: error.message, code: error.code };
  return null;
}

export function registerAgentRoutes(app: FastifyInstance): void {
  app.get('/api/agent/status', async () => ({
    enabled: true,
    configured: Boolean(loadConfig().api_key || process.env.MEIMEI_MODEL_API_KEY),
    model: loadConfig().model,
    model_configured: Boolean(loadConfig().api_key || process.env.MEIMEI_MODEL_API_KEY),
  }));

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
    const body = request.body as { arguments?: Record<string, unknown>; channel?: string; actor_id?: string; session_id?: string };
    try {
      const result = invokeTool(toolName, body.arguments ?? {}, {
        channel: body.channel ?? 'local', actorId: body.actor_id ?? '',
        sessionId: body.session_id ?? '',
      });
      return result;
    } catch (error) {
      const mappedError = toolErrorDetail(error);
      if (mappedError) return reply.status(400).send(mappedError);
      throw error;
    }
  });

  app.post('/api/agent/chat', async (request, reply) => {
    const body = request.body as { session_id: string; message: string; channel?: string; actor_id?: string };
    try {
      const runner = new AgentRunner({ sessionStore: new SessionStore() });
      const answer = await runner.chat(body.session_id, body.message, {
        channel: body.channel ?? 'local', actorId: body.actor_id ?? '',
      });
      return { answer, session_id: body.session_id };
    } catch (error) {
      const mapped = mapAgentError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/agent/chat/stream', async (request, reply) => {
    const body = request.body as { session_id: string; message: string; channel?: string; actor_id?: string };
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const runner = new AgentRunner({ sessionStore: new SessionStore() });
    try {
      for await (const event of runner.chatStream(body.session_id, body.message, {
        channel: body.channel ?? 'local', actorId: body.actor_id ?? '',
      })) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      const message = (error as Error).message;
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', content: message })}\n\n`);
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  app.get('/api/agent/sessions', async (request) => {
    const { prefix = '' } = request.query as { prefix?: string };
    return { sessions: new SessionStore().list(prefix) };
  });

  app.get('/api/agent/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const messages = new SessionStore().load(sessionId);
    if (!messages.length) return reply.status(404).send({ detail: '会话不存在' });
    return { messages };
  });

  app.put('/api/agent/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as { title?: string };
    try {
      const result = new SessionStore().rename(sessionId, String(body.title ?? ''));
      return result;
    } catch (error) {
      return reply.status(400).send({ detail: (error as Error).message });
    }
  });

  app.delete('/api/agent/sessions/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    new SessionStore().clear(sessionId);
    return { ok: true };
  });

  app.get('/api/agent/actions/pending', async (request) => {
    const { session_id, actor_id } = request.query as { session_id?: string; actor_id?: string };
    const pending = pendingForSession(session_id ?? '', actor_id ?? '');
    if (!pending) return { pending: null };
    return { pending };
  });

  app.post('/api/agent/actions/:actionId/confirm', async (request, reply) => {
    const { actionId } = request.params as { actionId: string };
    const body = request.body as { session_id?: string; actor_id?: string; confirmation_token?: string };
    try {
      const result = confirmAction(Number(actionId), {
        sessionId: body.session_id ?? '', actorId: body.actor_id ?? '',
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
    const body = request.body as { session_id?: string; actor_id?: string };
    try {
      return cancelAction(Number(actionId), {
        sessionId: body.session_id ?? '', actorId: body.actor_id ?? '',
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
