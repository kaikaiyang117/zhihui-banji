/* MIG-02 应用工厂：创建 Fastify 实例，不产生任何隐式启动副作用。
 *
 * 约定：
 * - 本模块 import 时不监听端口、不打开数据库、不启动微信循环。
 * - 错误响应统一为 { detail }，与 FastAPI 兼容。
 * - /api/* 的 404 返回 JSON；非 API 路径回退 SPA 根入口。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, type ServerConfig } from './config/index.js';
import { AppError } from './http/errors.js';
import { installRequestContext } from './http/plugins/request-context.js';
import { registerSystemSecurityRoutes } from './http/routes/system.js';
import { registerMig05Routes } from './http/routes/mig05.js';
import { registerMig06Routes } from './http/routes/mig06.js';

/** 日志脱敏字段（与数据安全规则一致：不记录密钥、电话、地址等）。 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-workbench-device"]',
  'req.headers.cookie',
  '*.api_key',
  '*.apiKey',
  '*.token',
  '*.client_secret',
  '*.password',
  '*.监护人电话',
  '*.家庭住址',
];

export interface BuildAppOptions {
  config?: ServerConfig;
  ready?: () => boolean;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    bodyLimit: 50 * 1024 * 1024,
  });

  app.decorate('config', config);

  // ---------- 统一错误映射 ----------
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ detail: error.detail });
    }
    const record = error as Record<string, unknown>;
    if (record && typeof record === 'object' && 'validation' in record) {
      // Fastify schema 校验错误对齐 FastAPI 422
      return reply.status(422).send({ detail: '请求参数校验失败' });
    }
    if (record && typeof record === 'object' && typeof record.statusCode === 'number') {
      const status = record.statusCode;
      if (status >= 400 && status < 500) {
        return reply.status(status).send({ detail: typeof record.message === 'string' ? record.message : '请求失败' });
      }
    }
    request.log.error({ err: error }, '未处理的服务错误');
    return reply.status(500).send({ detail: '服务器内部错误' });
  });

  // ---------- 404：API 返回 JSON，其余回退 SPA ----------
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api')) {
      return reply.status(404).send({ detail: '接口不存在' });
    }
    const indexPath = path.join(config.staticDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      return reply.type('text/html; charset=utf-8').send(fs.readFileSync(indexPath));
    }
    return reply.status(404).send({ detail: '页面不存在' });
  });

  // ---------- 静态资源与 SPA ----------
  if (fs.existsSync(config.staticDir)) {
    void app.register(fastifyStatic, {
      root: config.staticDir,
      prefix: '/',
      wildcard: false,
    });
  }

  // ---------- 安全与请求上下文（MIG-04） ----------
  void app.register(fastifyCookie);
  void app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  installRequestContext(app, config);
  registerSystemSecurityRoutes(app);

  // ---------- 基础资料与通用数据（MIG-05） ----------
  registerMig05Routes(app);

  // ---------- 行动闭环（MIG-06） ----------
  registerMig06Routes(app);

  // ---------- OpenAPI 文档 ----------
  void app.register(fastifySwagger, {
    openapi: {
      info: {
        title: config.appName,
        version: config.appVersion,
      },
      tags: [{ name: 'system' }],
    },
  });
  void app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list' },
  });
  // 与 FastAPI 一致的 OpenAPI 快照地址（SPA 回退会拦截非显式路由，必须显式注册）
  app.get('/openapi.json', async () => app.swagger());

  // ---------- 系统路由（业务路由在 MIG-03+ 接入） ----------
  app.get('/api/system/health', {
    schema: {
      tags: ['system'],
      response: {
        200: {
          type: 'object',
          properties: {
            app: { type: 'string' },
            version: { type: 'string' },
            ready: { type: 'boolean' },
          },
          required: ['app', 'version', 'ready'],
        },
      },
    },
  }, async (_request, reply) => {
    return reply.send({
      app: config.appName,
      version: config.appVersion,
      ready: options.ready ? options.ready() : true,
    });
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: ServerConfig;
  }
}
