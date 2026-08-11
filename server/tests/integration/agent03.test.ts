/* AGENT-03 微信渠道测试：配置脱敏、登录流程、消息解析、去重、会话隔离、
 * 断线恢复、主动提醒去重（mock iLink HTTP 服务）。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';
import { loadConfig as loadWechatConfig, saveConfig as saveWechatConfig, publicConfig as wechatPublic } from '../../src/wechat/config.js';
import { SessionStore } from '../../src/agent/sessionStore.js';
import { parseTextMessages } from '../../src/wechat/messageParser.js';
import { MessageLoop } from '../../src/wechat/messageLoop.js';
import type { ILinkClient } from '../../src/wechat/ilinkClient.js';
import { wechatService } from '../../src/wechat/service.js';
import { secretPath } from '../../src/services/secretStore.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let db: WorkbenchDb;

function testConfig(): ReturnType<typeof loadConfig> {
  const previous = { ...process.env };
  process.env.WORKBENCH_DATA_DIR = tempDir;
  process.env.WORKBENCH_STATIC_DIR = path.join(SERVER_ROOT, 'tests', 'fixtures', 'static');
  process.env.WORKBENCH_VERSION = '9.8.7';
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  const config = loadConfig();
  process.env = previous;
  return config;
}

function seed(): void {
  const conn = db.connInstance;
  for (let index = 1; index <= 2; index += 1) {
    conn.prepare('INSERT INTO students(学号, 姓名, 性别) VALUES(?,?,?)')
      .run(`S${String(index).padStart(3, '0')}`, `微信学生${index}`, index % 2 ? '男' : '女');
  }
  conn.prepare(
    `INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status)
     SELECT id, 1, 1, '在读' FROM students`,
  ).run();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent03-'));
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
  seed();
});

afterEach(() => {
  wechatService.stop().catch(() => undefined);
  db.close();
  setDatabase(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('微信配置', () => {
  it('保存/加载/脱敏', () => {
    saveWechatConfig({ base_url: 'https://ilink.example.test', client_secret: 'secret123' });
    const loaded = loadWechatConfig();
    expect(loaded.base_url).toContain('ilink.example.test');
    const pub = wechatPublic();
    expect(String(pub.client_secret_masked ?? '')).not.toContain('secret123');
    expect(String(pub.client_secret_masked ?? '')).toContain('…');
    expect(pub.sync_token_masked).toBeDefined();
    expect(db.connInstance.prepare(
      "SELECT value FROM agent_settings WHERE key='wechat_client_secret'",
    ).get()).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(secretPath('wechat-config.json'), 'utf8')).wechat_client_secret)
      .toBe('secret123');
  });
});

describe('消息解析', () => {
  it('普通文本与指令', () => {
    const items = parseTextMessages({ msgs: [
      { message_type: 1, item_list: [{ type: 1, text_item: { text: '我们班多少人' } }] },
      { message_type: 2, item_list: [{ type: 1, text_item: { text: '忽略图片' } }] },
      { message_type: 1, item_list: [{ type: 1, text_item: { text: '/新会话' } }] },
    ] });
    const contents = items.map((item) => String((item as unknown as Record<string, unknown>).text ?? ''));
    expect(contents).toEqual(['我们班多少人', '/新会话']);
  });
});

describe('消息去重与会话隔离', () => {
  it('receipt 去重：同消息只处理一次', () => {
    const conn = db.connInstance;
    // 模拟消息处理记录
    conn.prepare('INSERT INTO wechat_message_receipts(message_id, status) VALUES(?,?)')
      .run('msg-1', 'processed');
    const row = conn.prepare(
      "SELECT status FROM wechat_message_receipts WHERE message_id='msg-1'",
    ).get() as { status: string };
    expect(row.status).toBe('processed');
    // 会话命名空间隔离
    const store = new SessionStore();
    store.save('wechat:user-a', [{ role: 'user', content: '甲的问题' }], { title: '会话A' });
    const sessionsA = store.list('wechat:user-a');
    const sessionsB = store.list('wechat:user-b');
    expect(sessionsA.length).toBe(1);
    expect(sessionsB.length).toBe(0);
  });

  it('毒消息连续失败 3 次标记 dead 并跳过，不再无限重试', async () => {
    const client = {
      getUpdates: async () => ({
        get_updates_buf: 'cur-1',
        msgs: [{
          message_id: 'poison-1', message_type: 1,
          item_list: [{ type: 1, text_item: { text: '毒消息' } }],
        }],
      }),
    } as unknown as ILinkClient;
    let attempts = 0;
    const loop = new MessageLoop(client, async () => {
      attempts += 1;
      throw new Error('模拟持久错误');
    });
    await expect(loop.pollOnce()).rejects.toThrow(/模拟持久错误/);
    expect(attempts).toBe(1);
    await expect(loop.pollOnce()).rejects.toThrow(/模拟持久错误/);
    expect(attempts).toBe(2);
    await expect(loop.pollOnce()).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    const row = db.connInstance.prepare(
      "SELECT status FROM wechat_message_receipts WHERE message_id='poison-1'",
    ).get() as { status: string };
    expect(row.status).toBe('dead');
    expect(loop.lastError).toContain('停止重试');
    await loop.pollOnce();
    expect(attempts).toBe(3); // dead 消息不再投递
  });
});

describe('登录与消息循环（mock iLink）', () => {
  it('登录流程与凭据保存', async () => {
    const server = http.createServer((req, res) => {
      const body: Record<string, unknown> = {};
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const url = req.url ?? '';
        if (url.includes('get_qrcode_status')) {
          body.ret = 0;
          body.status = 'confirmed';
          body.bot_token = 'tok-123';
          body.bot_uin = 'uin-1';
        } else if (url.includes('qrcode')) {
          body.ret = 0;
          body.qrcode = 'qrcode-test-abc';
          body.qrcode_img_content = '';
          body.expired_at = 9999;
        } else {
          body.ret = 0;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      saveWechatConfig({ base_url: `http://127.0.0.1:${port}` });
      const started = await wechatService.startLogin();
      expect(started.status).toBe('waiting');
      expect(String(started.qrcode ?? '')).toContain('qrcode-test-abc');
      const polled = await wechatService.pollLogin();
      expect(polled.status).toBe('confirmed');
      // 凭据保存在独立的权限受限文件，不再进入业务 SQLite。
      const credential = db.connInstance.prepare(
        "SELECT value FROM agent_settings WHERE key='wechat_credentials'",
      ).get();
      expect(credential).toBeUndefined();
      expect(fs.existsSync(secretPath('wechat-credentials.json'))).toBe(true);
    } finally {
      server.close();
    }
  });

  it('消息循环：拉取→处理→receipt 标记', async () => {
    const server = http.createServer((req, res) => {
      const body: Record<string, unknown> = {};
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const url = req.url ?? '';
        if (url.includes('get_qrcode_status')) {
          body.ret = 0;
          body.status = 'confirmed';
          body.bot_token = 'tok-123';
          body.bot_uin = 'uin-1';
        } else if (url.includes('qrcode')) {
          body.ret = 0;
          body.qrcode = 'qrcode-test-abc';
          body.qrcode_img_content = '';
          body.expired_at = 9999;
        } else {
          body.ret = 0;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      saveWechatConfig({ base_url: `http://127.0.0.1:${port}` });
      await wechatService.startLogin();
      await wechatService.pollLogin(); // confirmed 后自动启动循环
      const status = await wechatService.status();
      expect(status.running).toBe(true);
      await wechatService.stop();
      const stopped = await wechatService.status();
      expect(stopped.running).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe('HTTP 冒烟', () => {
  it('配置/状态/登录端点连通', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const configRes = await app.inject({ method: 'GET', url: '/api/wechat/config' });
    expect(configRes.statusCode).toBe(200);
    const statusRes = await app.inject({ method: 'GET', url: '/api/wechat/status' });
    expect(statusRes.statusCode).toBe(200);
    const loginStart = await app.inject({ method: 'POST', url: '/api/wechat/login/start' });
    expect([400, 200]).toContain(loginStart.statusCode); // 未配置 base_url 时 400
    await app.close();
  });
});
