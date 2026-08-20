import type { FastifyInstance, FastifyReply } from 'fastify';

import * as toolLinks from '../../services/toolLinks.js';

function mapError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof toolLinks.ToolLinkError) {
    const status = /不存在/.test(error.message) ? 404
      : /已删除/.test(error.message) ? 410 : 400;
    return reply.status(status).send({ detail: error.message });
  }
  return undefined;
}

function wrap(reply: FastifyReply, fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    const mapped = mapError(reply, error);
    if (mapped) return mapped;
    throw error;
  }
}

export function registerToolLinkRoutes(app: FastifyInstance): void {
  app.get('/api/tool-links', async (request, reply) => {
    const { search, category } = request.query as { search?: string; category?: string };
    return wrap(reply, () => ({
      items: toolLinks.listToolLinks({ search, category }),
    }));
  });

  app.post('/api/tool-links', async (request, reply) => {
    const body = request.body as {
      name?: string;
      url?: string;
      category?: string;
      icon?: string;
      color?: string;
      sort_order?: number;
      pinned?: boolean;
    };
    return wrap(reply, () => {
      const result = toolLinks.createToolLink({
        name: String(body?.name ?? ''),
        url: String(body?.url ?? ''),
        category: body?.category,
        icon: body?.icon,
        color: body?.color,
        sortOrder: body?.sort_order,
        pinned: body?.pinned,
      });
      return reply.status(201).send(result);
    });
  });

  app.put('/api/tool-links/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      url?: string;
      category?: string;
      icon?: string;
      color?: string;
      sort_order?: number;
      pinned?: boolean;
    };
    return wrap(reply, () => toolLinks.updateToolLink(Number(id), {
      name: body?.name,
      url: body?.url,
      category: body?.category,
      icon: body?.icon,
      color: body?.color,
      sortOrder: body?.sort_order,
      pinned: body?.pinned,
    }));
  });

  app.delete('/api/tool-links/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    return wrap(reply, () => {
      toolLinks.deleteToolLink(Number(id));
      return { ok: true };
    });
  });

  app.post('/api/tool-links/:id/use', async (request, reply) => {
    const { id } = request.params as { id: string };
    return wrap(reply, () => {
      toolLinks.recordToolLinkUsage(Number(id));
      return { ok: true };
    });
  });
}
