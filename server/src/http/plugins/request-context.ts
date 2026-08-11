/* MIG-04 请求上下文插件：中间件顺序与 Python local_access_guard 一致。
 *
 * 请求 ID → 本机/局域网设备鉴权 → 班级/学期范围绑定 → 渠道/操作者绑定
 * → 审计上下文 → 路由 → 缺省写操作审计 → 上下文释放
 *
 * 注意：必须使用回调风格 onRequest 钩子并在 ALS 上下文中同步调用 done()，
 * 才能让上下文传播到 handler（promise 风格钩子不会传播，见 MIG-04 实验）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ServerConfig } from '../../config/index.js';
import { bindRequestScope, resetRequestScope } from '../../services/context.js';
import { bindActor, resetActor, beginRequest, resetRequest, hasRecorded, record } from '../../services/audit.js';
import { authenticate, isLocalHost } from '../../services/devices.js';

export function isProtectedPath(url: string): boolean {
  return url.startsWith('/api/') || ['/api', '/docs', '/redoc', '/openapi.json'].includes(url);
}

export function installRequestContext(
  app: FastifyInstance,
  config: ServerConfig,
): void {
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    // 1. 设备鉴权（局域网启用且非本机时）
    const lanEnabled = Boolean(config.lanUrlBase);
    const host = request.ip;
    const localRequest = isLocalHost(host);
    const pairingClaim = request.url.startsWith('/api/system/pairing/claim');
    let authenticatedDevice: Record<string, unknown> | null = null;
    if (lanEnabled && isProtectedPath(request.url) && !localRequest && !pairingClaim) {
      const credential = String(
        (request.headers['x-workbench-device'] as string | undefined)
        ?? (request.query as Record<string, unknown>).device_token
        ?? (request.cookies?.workbench_device ?? ''),
      );
      authenticatedDevice = authenticate(credential, {
        ip: host,
        userAgent: String(request.headers['user-agent'] ?? ''),
      });
      if (!authenticatedDevice) {
        reply.status(401).send({
          detail: '此设备尚未配对、授权已过期或已被撤销，请在电脑端重新生成二维码',
        });
        return done();
      }
      (request as unknown as { workbenchDevice?: unknown }).workbenchDevice = authenticatedDevice;
    }

    // 2. 班级/学期范围绑定（与 Python 一致：header 优先于 query）
    try {
      const header = (key: string): string | null =>
        (request.headers[key] as string | undefined) ?? null;
      const queryValue = (key: string): string | null =>
        String((request.query as Record<string, unknown>)[key] ?? '') || null;
      bindRequestScope(
        header('x-workbench-class') ?? queryValue('class_id'),
        header('x-workbench-term') ?? queryValue('term_id'),
      );
    } catch (error) {
      reply.status(400).send({ detail: (error as Error).message });
      return done();
    }

    // 3. 渠道/操作者绑定（设备请求来自局域网；其余按 header 或本机用户）
    let channel: string;
    let actorId: string;
    if (authenticatedDevice) {
      channel = 'lan';
      actorId = `${String(authenticatedDevice.name)}:${String(authenticatedDevice.device_id)}`;
    } else {
      channel = (request.headers['x-workbench-channel'] as string | undefined) ?? 'web';
      actorId = (request.headers['x-workbench-actor'] as string | undefined) ?? 'local-user';
    }
    bindActor(channel, actorId);

    // 4. 审计上下文
    beginRequest();

    // 5. 路由处理完成后：缺省写操作审计 + 上下文释放
    const release = (): void => {
      resetRequest();
      resetActor();
      resetRequestScope();
    };
    reply.raw.once('finish', () => {
      const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
      const separateChannel = request.url.startsWith('/api/agent') || request.url.startsWith('/api/wechat');
      if (mutating && request.url.startsWith('/api/') && !separateChannel && !hasRecorded()) {
        try {
          record('api_request', '', request.method.toLowerCase(), {
            status: reply.statusCode < 400 ? 'success' : 'failed',
            summary: `${request.method} ${request.url}`,
            params: { query: request.query as Record<string, unknown>, status_code: reply.statusCode },
          });
        } catch {
          // 缺省审计失败不阻断响应
        }
      }
      release();
    });

    // 请求异常路径也需要释放上下文（finish 未触发时兜底）
    reply.raw.once('close', () => {
      release();
    });
    done();
  });
}
