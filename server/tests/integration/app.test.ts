import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { BadRequestError } from '../../src/http/errors.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_STATIC = path.join(SERVER_ROOT, 'tests', 'fixtures', 'static');

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig02-app-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function testConfig(): ReturnType<typeof loadConfig> {
  const previous = { ...process.env };
  process.env.WORKBENCH_DATA_DIR = tempDir;
  process.env.WORKBENCH_STATIC_DIR = FIXTURE_STATIC;
  process.env.WORKBENCH_VERSION = '9.8.7';
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  const config = loadConfig();
  process.env = previous;
  return config;
}

describe('应用工厂（无启动副作用）', () => {
  it('buildApp 不监听端口，可被测试直接关闭', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    expect(app.server.listening).toBe(false);
    await app.close();
  });

  it('health 返回 app/version/ready', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/system/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      app: 'MeimeiWorkbench',
      version: '9.8.7',
      ready: true,
    });
    await app.close();
  });

  it('health 的 ready 由回调控制（启动任务未完成时为 false）', async () => {
    const app = buildApp({ config: testConfig(), ready: () => false });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/system/health' });
    expect(response.json().ready).toBe(false);
    await app.close();
  });

  it('runtime 返回业务日期（Python clock.runtime 语义）', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
    try {
      const response = await app.inject({ method: 'GET', url: '/api/system/runtime' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        business_date: '2026-04-15',
        business_date_overridden: true,
        business_date_env: 'WORKBENCH_BUSINESS_DATE',
      });
    } finally {
      delete process.env.WORKBENCH_BUSINESS_DATE;
    }
    await app.close();
  });
});

describe('静态资源与 SPA 回退', () => {
  it('根路径返回 SPA 首页', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('测试静态首页');
    await app.close();
  });

  it('favicon.svg 可访问', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/svg+xml');
    await app.close();
  });

  it('SPA 深层路径回退首页（hash 路由场景）', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('测试静态首页');
    await app.close();
  });

  it('API 404 返回 JSON detail', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/students/999' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ detail: '接口不存在' });
    await app.close();
  });
});

describe('错误映射与 OpenAPI', () => {
  it('AppError 映射为 detail 与对应状态码', async () => {
    const app = buildApp({ config: testConfig() });
    app.get('/api/test/app-error', async () => {
      throw new BadRequestError('测试业务错误');
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/test/app-error' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ detail: '测试业务错误' });
    await app.close();
  });

  it('未知异常映射为 500 detail', async () => {
    const app = buildApp({ config: testConfig() });
    app.get('/api/test/crash', async () => {
      throw new Error('内部炸了');
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/test/crash' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ detail: '服务器内部错误' });
    await app.close();
  });

  it('/docs 与 /openapi.json 可用', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const docs = await app.inject({ method: 'GET', url: '/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    const spec = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(spec.statusCode).toBe(200);
    expect(spec.headers['content-type']).toContain('application/json');
    const parsed = spec.json();
    expect(parsed.info.title).toBe('MeimeiWorkbench');
    expect(parsed.info.version).toBe('9.8.7');
    expect(Object.keys(parsed.paths)).toContain('/api/system/health');
    expect(Object.keys(parsed.paths).length).toBeGreaterThan(20);
    await app.close();
  });
});
