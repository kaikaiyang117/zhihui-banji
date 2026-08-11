/* 统计端点集成测试（与 backend/app/routers/stats.py 对应）。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_STATIC = path.join(SERVER_ROOT, 'tests', 'fixtures', 'static');

let tempDir: string;
let db: WorkbenchDb;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-stats-'));
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
});

afterEach(() => {
  db.close();
  setDatabase(null);
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

describe('统计端点（/api/stats）', () => {
  it('dashboard 返回聚合结构且无未定义值', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/stats/dashboard' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.date).toBe('2026-04-15');
    expect(body.total_students).toBe(0);
    expect(body.today_attendance).toBeTypeOf('object');
    expect(body.top_points).toEqual([]);
    expect(body.work_summary).toBeTypeOf('object');
    expect(body.work_sections).toBeTypeOf('object');
    expect(body.tasks).toEqual([]);
    expect(body.rule_hits).toEqual([]);
    expect(body.material_tasks).toEqual([]);
    expect(body.review_students).toEqual([]);
    expect(body.focus).toEqual([]);
    expect(body.recent_events).toEqual([]);
    expect(body.pending_communications).toEqual([]);
    expect(body.pending_communication_count).toBe(0);
    expect(body.calendar).toBeTypeOf('object');
    await app.close();
  });

  it('dashboard 支持自定义日期，非法日期返回 400', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const ok = await app.inject({ method: 'GET', url: '/api/stats/dashboard?date=2026-05-01' });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { date: string }).date).toBe('2026-05-01');
    const bad = await app.inject({ method: 'GET', url: '/api/stats/dashboard?date=2026/05/01' });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { detail: string }).detail).toBe('日期格式必须为 YYYY-MM-DD');
    await app.close();
  });

  it('calendar 支持月份过滤与非法月份报错', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/stats/calendar?month=2026-04' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      month: string; days: Array<Record<string, unknown>>; summary: Record<string, number>;
    };
    expect(body.month).toBe('2026-04');
    expect(body.days.length).toBe(30);
    expect(body.summary.month_tasks).toBe(0);
    const bad = await app.inject({ method: 'GET', url: '/api/stats/calendar?month=2026/04' });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { detail: string }).detail).toBe('月份格式必须为 YYYY-MM');
    await app.close();
  });

  it('attendance 统计与日期范围校验', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/stats/attendance?date_from=2026-04-01&date_to=2026-04-15' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.date_stats).toBeTypeOf('object');
    const bad = await app.inject({
      method: 'GET', url: '/api/stats/attendance?date_from=2026-04-15&date_to=2026-04-01',
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('scores / points / fund 端点连通', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    for (const url of ['/api/stats/scores', '/api/stats/points', '/api/stats/fund']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
    }
    await app.close();
  });
});
