import type { FastifyInstance, FastifyReply } from 'fastify';

import { ILinkError } from '../../wechat/ilinkClient.js';
import { wechatService } from '../../wechat/service.js';

function mapError(reply: FastifyReply, status: number, error: unknown): FastifyReply | undefined {
  if (error instanceof ILinkError) {
    return reply.status(status).send({ detail: error.message });
  }
  return undefined;
}

export function registerWechatRoutes(app: FastifyInstance): void {
  app.get('/api/wechat/status', async () => wechatService.status());

  app.get('/api/wechat/config', async () => wechatService.policy());

  app.put('/api/wechat/config', async (request, reply) => {
    const body = (request.body ?? {}) as { allow_all?: boolean; allow_users?: string[] };
    if (Array.isArray(body.allow_users) && body.allow_users.length > 200) {
      return reply.status(422).send({ detail: '请求参数校验失败' });
    }
    const users: string[] = [];
    for (const userId of Array.isArray(body.allow_users) ? body.allow_users : []) {
      const normalized = String(userId).trim();
      if (normalized && !users.includes(normalized)) users.push(normalized);
    }
    return { ok: true, ...wechatService.updatePolicy(users, body.allow_all === true) };
  });

  app.post('/api/wechat/login/start', async (_request, reply) => {
    try {
      return await wechatService.startLogin();
    } catch (error) {
      const mapped = mapError(reply, 502, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/wechat/login/poll', async (_request, reply) => {
    try {
      return await wechatService.pollLogin();
    } catch (error) {
      const mapped = mapError(reply, 502, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/wechat/loop/start', async (_request, reply) => {
    try {
      return await wechatService.startLoop();
    } catch (error) {
      const mapped = mapError(reply, 409, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/wechat/loop/stop', async () => {
    await wechatService.stop();
    return { running: false };
  });

  app.post('/api/wechat/reminders/send', async (_request, reply) => {
    try {
      return await wechatService.sendPendingReminders();
    } catch (error) {
      return reply.status(400).send({ detail: `微信提醒发送失败：${(error as Error).message}` });
    }
  });
}
