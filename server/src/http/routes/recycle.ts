/* 回收站与审计路由（与 backend/app/routers/recycle.py 对应）。 */
import type { FastifyInstance, FastifyReply } from 'fastify';

import * as recycle from '../../services/recycle.js';

function isLocalHost(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost', 'testclient'].includes(host);
}

function mapError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof recycle.RecycleError) {
    return reply.status(400).send({ detail: (error as Error).message });
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

export function registerRecycleRoutes(app: FastifyInstance): void {
  app.get('/api/recycle-bin', async (request) => {
    const { object_type = '', status = '已删除', limit = 300 } = request.query as {
      object_type?: string; status?: string; limit?: string | number;
    };
    return {
      items: recycle.listEntries({
        objectType: String(object_type),
        status: String(status),
        limit: Number(limit),
      }),
    };
  });

  app.delete('/api/records/:objectType/:objectId', async (request, reply) => {
    const { objectType, objectId } = request.params as { objectType: string; objectId: string };
    return wrap(reply, () => recycle.softDelete(objectType, Number(objectId)));
  });

  app.post('/api/recycle-bin/:entryId/restore', async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    return wrap(reply, () => recycle.restore(Number(entryId)));
  });

  app.delete('/api/recycle-bin/:entryId/purge', async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    if (!isLocalHost(request.ip)) {
      return reply.status(403).send({ detail: '永久删除只能在工作台本机操作' });
    }
    const body = (request.body ?? {}) as { confirmation?: string };
    return wrap(reply, () => recycle.purge(Number(entryId), String(body.confirmation ?? '')));
  });
}
