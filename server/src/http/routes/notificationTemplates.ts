import type { FastifyInstance, FastifyReply } from 'fastify';

import * as nt from '../../services/notificationTemplates.js';
import { ArchivedScopeError, ScopeError } from '../../services/context.js';

function mapError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof ArchivedScopeError) return reply.status(409).send({ detail: error.message });
  if (error instanceof ScopeError) return reply.status(400).send({ detail: error.message });
  if (error instanceof nt.NotificationTemplateError) {
    const message = error.message;
    const status = /不存在/.test(message) ? 404
      : /不能/.test(message) ? 403
      : /已存在/.test(message) ? 409 : 400;
    return reply.status(status).send({ detail: message });
  }
  const record = error as { code?: unknown };
  if (record && typeof record.code === 'string' && record.code.startsWith('SQLITE_CONSTRAINT')) {
    return reply.status(409).send({ detail: '同名模板已存在' });
  }
  return undefined;
}

function wrap(reply: FastifyReply, fn: () => unknown): unknown {
  try { return fn(); } catch (error) {
    const mapped = mapError(reply, error);
    if (mapped) return mapped;
    throw error;
  }
}

export function registerNotificationTemplateRoutes(app: FastifyInstance): void {
  app.get('/api/notification-templates', async (request, reply) => wrap(reply, () => ({
    templates: nt.listTemplates({
      scene: (request.query as { scene?: string }).scene,
    }),
  })));

  app.post('/api/notification-templates/ensure', async (_request, reply) => wrap(reply, () => {
    nt.ensureSystemTemplates();
    return { ok: true };
  }));

  app.get('/api/notification-templates/:id', async (request, reply) => wrap(reply, () => ({
    template: nt.getTemplate(Number((request.params as { id: string }).id)),
  })));

  app.post('/api/notification-templates/generate', async (request, reply) => wrap(reply, () => {
    const body = request.body as { template_id?: number; variable_values?: Record<string, string> };
    return nt.generateContent({
      templateId: Number(body.template_id ?? 0),
      variableValues: body.variable_values ?? {},
    });
  }));

  app.post('/api/notification-templates', async (request, reply) => wrap(reply, () => ({
    ok: true,
    template: nt.savePersonalTemplate({
      baseTemplateId: Number((request.body as Record<string, unknown>).base_template_id ?? 0),
      name: String((request.body as Record<string, unknown>).name ?? ''),
      content: String((request.body as Record<string, unknown>).content ?? ''),
      variablesJson: (request.body as Record<string, unknown>).variables_json as string | undefined,
    }),
  })));

  app.put('/api/notification-templates/:id', async (request, reply) => wrap(reply, () => ({
    ok: true,
    template: nt.updateTemplate(Number((request.params as { id: string }).id), {
      name: (request.body as Record<string, unknown>).name as string | undefined,
      content: (request.body as Record<string, unknown>).content as string | undefined,
      variablesJson: (request.body as Record<string, unknown>).variables_json as string | undefined,
      enabled: (request.body as Record<string, unknown>).enabled as boolean | undefined,
    }),
  })));

  app.delete('/api/notification-templates/:id', async (request, reply) => wrap(reply, () => {
    nt.deleteTemplate(Number((request.params as { id: string }).id));
    return { ok: true };
  }));

  app.post('/api/notification-templates/:id/restore', async (request, reply) => wrap(reply, () => ({
    ok: true,
    template: nt.restoreTemplate(Number((request.params as { id: string }).id)),
  })));
}
