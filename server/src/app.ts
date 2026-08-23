/* MIG-02 应用工厂：创建 Fastify 实例，不产生任何隐式启动副作用。
 *
 * 约定：
 * - 本模块 import 时不监听端口、不打开数据库、不启动微信循环。
 * - 错误响应统一为 { detail }。
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
import { registerMig07Routes } from './http/routes/mig07.js';
import { registerMig08Routes } from './http/routes/mig08.js';
import { registerMig09Routes } from './http/routes/mig09.js';
import { registerStatsRoutes } from './http/routes/stats.js';
import { registerRecycleRoutes } from './http/routes/recycle.js';
import { registerAgentRoutes } from './http/routes/agent.js';
import { registerWechatRoutes } from './http/routes/wechat.js';
import { registerMig10Routes } from './http/routes/mig10.js';
import { registerMig11Routes } from './http/routes/mig11.js';
import { registerEvidenceRoutes } from './http/routes/evidence.js';
import { registerTeacherClassesRoutes } from './http/routes/teacherClasses.js';
import { registerMeetingPrepRoutes } from './http/routes/meetingPrep.js';
import { registerNotificationTemplateRoutes } from './http/routes/notificationTemplates.js';
import { registerToolLinkRoutes } from './http/routes/toolLinks.js';
import { registerExcelImportRoutes } from './http/routes/excelImport.js';
import { registerExcelArtifactRoutes } from './http/routes/excelArtifacts.js';
import { registerParentReplyRoutes } from './http/routes/parentReply.js';

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
      // Fastify schema 校验统一返回 422
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

  // Swagger 必须先注册，后续业务路由才会被收集到 OpenAPI 文档。
  void app.register(fastifySwagger, {
    openapi: {
      info: {
        title: config.displayName,
        version: config.appVersion,
      },
      tags: [{ name: 'system' }],
    },
  });
  void app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list' },
  });
  app.get('/openapi.json', async () => app.swagger());

  app.after(() => {
    registerSystemSecurityRoutes(app);

    // ---------- 基础资料与通用数据（MIG-05） ----------
    registerMig05Routes(app);

    // ---------- 行动闭环（MIG-06） ----------
    registerMig06Routes(app);

    // ---------- 高频教师业务（MIG-07） ----------
    registerMig07Routes(app);

    // ---------- 账目与教育沉淀（MIG-08） ----------
    registerMig08Routes(app);

    // ---------- 输出、个人与系统运维（MIG-09） ----------
    registerMig09Routes(app);

    // ---------- 小组与宿舍管理（MIG-10） ----------
    registerMig10Routes(app);

    // ---------- 高中课程表与教学日程（MIG-11） ----------
    registerMig11Routes(app);

    // ---------- 图片证据留痕（SUP-08） ----------
    registerEvidenceRoutes(app);

    registerTeacherClassesRoutes(app);

    registerMeetingPrepRoutes(app);

    // ---------- 家长消息回复助手 ----------
    registerParentReplyRoutes(app);

    // ---------- 家校通知模板（SUP-06） ----------
    registerNotificationTemplateRoutes(app);

    registerToolLinkRoutes(app);

    // ---------- 对话式 Excel 导入（SUP-02） ----------
    registerExcelImportRoutes(app);
    registerExcelArtifactRoutes(app);

    // ---------- 统计（MIG-05 补齐） ----------
    registerStatsRoutes(app);

    // ---------- 回收站与审计（MIG-09 补齐） ----------
    registerRecycleRoutes(app);

    // ---------- Agent 基础路由（AGENT-01+） ----------
    registerAgentRoutes(app);

    // ---------- 微信渠道（AGENT-03） ----------
    registerWechatRoutes(app);

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
        app: config.displayName,
        version: config.appVersion,
        ready: options.ready ? options.ready() : true,
      });
    });
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: ServerConfig;
  }
}
