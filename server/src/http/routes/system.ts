/* MIG-04 安全路由：配对、设备管理、访问信息与系统审计（与 Python system.py 对应部分一致）。 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getDb } from '../../services/context.js';
import {
  createPairing, claimPairing, listDevices, revoke, revokeAll, revokeCredential, isLocalHost,
  DeviceError, DEVICE_TTL_DAYS,
} from '../../services/devices.js';
import { listAudits } from '../../services/audit.js';
import {
  getSystemSettings, SystemSettingsError, updateSystemSettings,
} from '../../services/systemSettings.js';

function requireLocal(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!isLocalHost(request.ip)) {
    reply.status(403).send({ detail: '设备授权只能在工作台本机管理' });
    return false;
  }
  return true;
}

export function registerSystemSecurityRoutes(app: FastifyInstance): void {
  app.get('/api/system/settings', {
    schema: { tags: ['system'] },
  }, async () => getSystemSettings());

  app.put('/api/system/settings', {
    schema: {
      tags: ['system'],
      body: {
        type: 'object',
        required: ['school_name'],
        additionalProperties: false,
        properties: {
          school_name: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
    },
  }, async (request, reply) => {
    if (!requireLocal(request, reply)) return reply;
    try {
      const body = request.body as { school_name?: unknown };
      return updateSystemSettings({ schoolName: body.school_name });
    } catch (error) {
      if (error instanceof SystemSettingsError) {
        return reply.status(400).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.get('/api/system/access-info', {
    schema: { tags: ['system'] },
  }, async (request) => {
    const baseUrl = (app.config.lanUrlBase ?? '').trim();
    return {
      enabled: Boolean(baseUrl),
      can_manage: isLocalHost(request.ip),
      paired_device_count: listDevices().filter((item) => item.status === '已授权').length,
      message: baseUrl ? '请在电脑端生成短时配对二维码。' : '',
    };
  });

  app.post('/api/system/pairing/start', {
    schema: { tags: ['system'] },
  }, async (request, reply) => {
    if (!requireLocal(request, reply)) return reply;
    try {
      return createPairing(app.config.lanUrlBase);
    } catch (error) {
      if (error instanceof DeviceError) {
        return reply.status(400).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.post('/api/system/pairing/claim', {
    schema: {
      tags: ['system'],
      body: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string' },
          name: { type: 'string', default: '移动设备' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { code: string; name?: string };
    try {
      const result = claimPairing(body.code, {
        name: body.name,
        userAgent: String(request.headers['user-agent'] ?? ''),
        ip: request.ip,
      });
      const credential = String(result.device_token ?? '');
      delete result.device_token;
      reply.setCookie('workbench_device', credential, {
        maxAge: DEVICE_TTL_DAYS * 86400,
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
      });
      return result;
    } catch (error) {
      if (error instanceof DeviceError) {
        return reply.status(400).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.get('/api/system/devices', {
    schema: { tags: ['system'] },
  }, async (request, reply) => {
    if (!requireLocal(request, reply)) return reply;
    return { devices: listDevices() };
  });

  app.delete('/api/system/devices/:deviceId', {
    schema: { tags: ['system'] },
  }, async (request, reply) => {
    if (!requireLocal(request, reply)) return reply;
    const { deviceId } = request.params as { deviceId: string };
    try {
      return revoke(Number(deviceId));
    } catch (error) {
      if (error instanceof DeviceError) {
        return reply.status(404).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.post('/api/system/devices/revoke-all', {
    schema: { tags: ['system'] },
  }, async (request, reply) => {
    if (!requireLocal(request, reply)) return reply;
    return revokeAll();
  });

  app.post('/api/system/devices/logout', {
    schema: { tags: ['system'] },
  }, async (request) => {
    const credential = String(
      (request.headers['x-workbench-device'] as string | undefined)
      ?? (request.cookies?.workbench_device ?? '')
      ?? String((request.query as Record<string, unknown>).device_token ?? ''),
    );
    revokeCredential(credential);
    return { ok: true };
  });

  app.get('/api/system/audit', {
    schema: { tags: ['system'] },
  }, async (request) => {
    const { limit } = request.query as { limit?: string };
    return { items: listAudits(limit ? Number(limit) : 200) };
  });

  app.get('/api/system/runtime', {
    schema: { tags: ['system'] },
  }, async () => {
    const { runtime } = await import('../../services/clock.js');
    return runtime();
  });

  void getDb;
}
