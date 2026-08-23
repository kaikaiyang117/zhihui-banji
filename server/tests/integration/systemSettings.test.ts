import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';

let tempDir: string;
let db: WorkbenchDb;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-settings-'));
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
});

afterEach(() => {
  setDatabase(null);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function testConfig(): ReturnType<typeof loadConfig> {
  const previous = { ...process.env };
  process.env.WORKBENCH_DATA_DIR = tempDir;
  process.env.WORKBENCH_STATIC_DIR = path.join(tempDir, 'static');
  const config = loadConfig();
  process.env = previous;
  return config;
}

describe('系统设置', () => {
  it('返回默认学校名称并支持本机修改', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();

    const initial = await app.inject({ method: 'GET', url: '/api/system/settings' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ school_name: '汶川县七一映秀中学' });

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/system/settings',
      payload: { school_name: '演示中学' },
      remoteAddress: '127.0.0.1',
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ school_name: '演示中学' });

    const reread = await app.inject({ method: 'GET', url: '/api/system/settings' });
    expect(reread.json()).toEqual({ school_name: '演示中学' });
    await app.close();
  });

  it('非本机不能修改学校名称', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/system/settings',
      payload: { school_name: '不应保存' },
      remoteAddress: '192.168.1.20',
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
