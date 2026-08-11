/* MIG-04 请求范围与安全底座测试。
 *
 * 覆盖：跨请求/并发上下文隔离、配对/授权/过期/撤权全流程、归档写保护、
 * 审计脱敏与缺省写审计、回收站软删除/恢复/永久删除、业务日期、文件安全工具。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase, scopeIds, getCurrentScope, ArchivedScopeError } from '../../src/services/context.js';
import {
  createPairing, claimPairing, authenticate, revoke, revokeAll, isLocalHost,
} from '../../src/services/devices.js';
import * as audit from '../../src/services/audit.js';
import { softDelete, restore, purge, listEntries } from '../../src/services/recycle.js';
import { safeResolve, atomicWrite, sha256, cleanTempFiles, FileSafetyError } from '../../src/services/files.js';
import { todayString } from '../../src/services/clock.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let db: WorkbenchDb;

function testConfig(lan = false): ReturnType<typeof loadConfig> {
  const previous = { ...process.env };
  process.env.WORKBENCH_DATA_DIR = tempDir;
  process.env.WORKBENCH_STATIC_DIR = path.join(SERVER_ROOT, 'tests', 'fixtures', 'static');
  process.env.WORKBENCH_VERSION = '9.8.7';
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  if (lan) process.env.WORKBENCH_LAN_URL_BASE = 'http://192.168.31.210:5000';
  else delete process.env.WORKBENCH_LAN_URL_BASE;
  const config = loadConfig();
  process.env = previous;
  return config;
}

function seedStudents(count = 3): void {
  const conn = db.connInstance;
  for (let index = 1; index <= count; index += 1) {
    conn.prepare('INSERT INTO students(学号, 姓名, 性别) VALUES(?,?,?)')
      .run(`S${index}`, `学生${index}`, index % 2 ? '男' : '女');
  }
  conn.prepare(
    `INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status)
     SELECT id, 1, 1, '在读' FROM students`,
  ).run();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig04-'));
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
  seedStudents();
});

afterEach(() => {
  db.close();
  setDatabase(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('请求级上下文隔离', () => {
  it('并发请求不串班级/学期与操作者（AsyncLocalStorage 隔离）', async () => {
    const conn = db.connInstance;
    for (let classId = 2; classId <= 5; classId += 1) {
      conn.prepare('INSERT INTO classes(name, grade) VALUES(?,?)').run(`班级${classId}`, '');
      const insertedClassId = Number(conn.prepare('SELECT last_insert_rowid() AS id').get()?.id ?? 0);
      conn.prepare(
        'INSERT INTO terms(class_id, name) VALUES(?,?)',
      ).run(insertedClassId, `学期${classId}`);
    }
    const app = buildApp({ config: testConfig() });
    app.get('/api/test/echo-scope', async () => {
      const [classId, termId] = scopeIds();
      const { channel, actorId } = audit.currentActor();
      return { classId, termId, channel, actorId };
    });
    await app.ready();

    const requests = Array.from({ length: 50 }, (_unused, index) => {
      const classId = (index % 5) + 1;
      const headers = {
        'x-workbench-class': String(classId),
        'x-workbench-channel': `c${index}`,
        'x-workbench-actor': `actor-${index}`,
      };
      return app.inject({ method: 'GET', url: '/api/test/echo-scope', headers });
    });
    const responses = await Promise.all(requests);
    responses.forEach((response, index) => {
      const body = response.json();
      expect(body.classId).toBe((index % 5) + 1);
      expect(body.channel).toBe(`c${index}`);
      expect(body.actorId).toBe(`actor-${index}`);
    });
    await app.close();
  });

  it('无请求上下文时回退到默认班级/学期', () => {
    const [classId, termId] = scopeIds();
    expect(classId).toBe(1);
    expect(termId).toBe(1);
  });

  it('归档范围写操作抛 ArchivedScopeError（409 语义）', async () => {
    const conn = db.connInstance;
    conn.prepare("UPDATE classes SET status='已归档' WHERE id=1").run();
    expect(() => scopeIds({ write: true })).toThrow(ArchivedScopeError);
    // 只读不受影响
    expect(getCurrentScope().class_id).toBe(1);
  });
});

describe('设备配对、授权、过期与撤权', () => {
  it('createPairing 生成 5 分钟单次配对码，claim 后设备可认证', () => {
    const pairing = createPairing('http://192.168.31.210:5000') as {
      code: string; url: string; expires_in: number;
    };
    expect(pairing.expires_in).toBe(300);
    expect(pairing.url).toContain(`pair=${pairing.code}`);
    const claimed = claimPairing(pairing.code, { name: '测试手机', ip: '192.168.31.99' });
    const credential = String(claimed.device_token);
    expect(claimed.device_id).toBeTruthy();

    const authenticated = authenticate(credential, { ip: '192.168.31.99', userAgent: 'iPhone' });
    expect(authenticated?.name).toBe('测试手机');
    expect(authenticated?.status).toBe('已授权');
  });

  it('配对码只能使用一次', () => {
    const { code } = createPairing('http://x:5000') as { code: string };
    claimPairing(code);
    expect(() => claimPairing(code)).toThrow(/无效或已经使用/);
  });

  it('过期配对码被拒绝并标记已过期', () => {
    const { code } = createPairing('http://x:5000', { ttlSeconds: 1 }) as { code: string };
    db.connInstance.prepare("UPDATE pairing_sessions SET expires_at='2020-01-01 00:00:00'").run();
    expect(() => claimPairing(code)).toThrow(/已过期/);
  });

  it('撤销设备后认证立即失败；撤销全部生效', () => {
    const { code } = createPairing('http://x:5000') as { code: string };
    const { device_id, device_token } = claimPairing(code) as {
      device_id: string; device_token: string;
    };
    expect(authenticate(device_token)).not.toBeNull();
    const devices = db.connInstance.prepare(
      "SELECT id FROM paired_devices WHERE device_id=?",
    ).get(device_id) as { id: number };
    revoke(Number(devices.id));
    expect(authenticate(device_token)).toBeNull();

    const { code: code2 } = createPairing('http://x:5000') as { code: string };
    const second = claimPairing(code2) as { device_token: string };
    expect(authenticate(second.device_token)).not.toBeNull();
    revokeAll();
    expect(authenticate(second.device_token)).toBeNull();
  });

  it('isLocalHost 识别本机地址', () => {
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('testclient')).toBe(true);
    expect(isLocalHost('192.168.31.99')).toBe(false);
  });
});

describe('局域网设备鉴权中间件', () => {
  it('启用局域网后，非本机访问未配对设备返回 401', async () => {
    const app = buildApp({ config: testConfig(true) });
    await app.ready();
    const response = await app.inject({
      method: 'GET', url: '/api/students',
      remoteAddress: '192.168.31.99',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().detail).toContain('尚未配对');
    await app.close();
  });

  it('配对成功后的设备携带凭证可访问，撤权后 401', async () => {
    const app = buildApp({ config: testConfig(true) });
    await app.ready();
    const pairing = await app.inject({ method: 'POST', url: '/api/system/pairing/start' });
    expect(pairing.statusCode).toBe(200);
    const { code } = pairing.json() as { code: string };
    const claim = await app.inject({
      method: 'POST', url: '/api/system/pairing/claim',
      payload: { code, name: '手机甲' },
    });
    expect(claim.statusCode).toBe(200);
    // 凭证通过 Set-Cookie 下发（与 Python 一致），响应体不含 device_token
    const cookie = String(claim.headers['set-cookie'] ?? '');
    const deviceToken = cookie.match(/workbench_device=([^;]+)/)?.[1] ?? '';

    const ok = await app.inject({
      method: 'GET', url: '/api/system/health',
      remoteAddress: '192.168.31.99',
      headers: { 'x-workbench-device': deviceToken },
    });
    expect(ok.statusCode).toBe(200);

    const devices = await app.inject({ method: 'GET', url: '/api/system/devices' });
    const { devices: deviceList } = devices.json() as { devices: Array<{ id: number }> };
    await app.inject({
      method: 'DELETE', url: `/api/system/devices/${deviceList[0].id}`,
    });
    const denied = await app.inject({
      method: 'GET', url: '/api/system/health',
      remoteAddress: '192.168.31.99',
      headers: { 'x-workbench-device': deviceToken },
    });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });

  it('非本机不能管理配对（403）', async () => {
    // 未启用局域网时远程请求不受 401 拦截，由路由本身拒绝（与 Python 一致）
    const app = buildApp({ config: testConfig(false) });
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: '/api/system/pairing/start',
      remoteAddress: '192.168.31.99',
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

describe('审计：脱敏与缺省写审计', () => {
  it('敏感参数被脱敏（key/token/电话/地址）', () => {
    audit.bindActor('web', 'test-user');
    audit.record('test', 1, 'update', {
      params: {
        api_key: 'sk-secret-123',
        token: 'abc',
        '监护人电话': '13800000000',
        '家庭住址': '某街道 1 号',
        note: '普通备注',
      },
    });
    const items = audit.listAudits(10);
    const latest = items[0];
    const params = latest.params_summary as Record<string, unknown>;
    expect(params.api_key).toBe('***');
    expect(params.token).toBe('***');
    expect(params['监护人电话']).toBe('***');
    expect(params['家庭住址']).toBe('***');
    expect(params.note).toBe('普通备注');
  });

  it('未显式审计的写请求由中间件补充审计（含渠道/操作者）', async () => {
    const app = buildApp({ config: testConfig() });
    app.post('/api/test/write-no-audit', async () => ({ ok: true }));
    await app.ready();
    await app.inject({
      method: 'POST', url: '/api/test/write-no-audit',
      headers: { 'x-workbench-channel': 'web', 'x-workbench-actor': '班主任甲' },
    });
    const rows = db.connInstance.prepare(
      "SELECT * FROM system_audit WHERE object_type='api_request' ORDER BY id DESC LIMIT 1",
    ).get() as Record<string, unknown>;
    expect(rows).toBeTruthy();
    expect(rows.actor_id).toBe('班主任甲');
    expect(rows.action).toBe('post');
    await app.close();
  });
});

describe('回收站：软删除、恢复、永久删除', () => {
  it('事件软删除联动工作项，恢复后原样', () => {
    const conn = db.connInstance;
    conn.prepare(
      `INSERT INTO student_events(student_id, occurred_at, event_type, description, class_id, term_id)
       VALUES(1, '2026-04-15 08:10', '迟到', '测试事件', 1, 1)`,
    ).run();
    const eventId = Number(conn.prepare('SELECT last_insert_rowid() AS id').get()?.id ?? 0);
    conn.prepare(
      `INSERT INTO student_tasks(student_id, title, source_type, source_id, source_key, class_id, term_id)
       VALUES(1, '跟进', 'event', ?, 'event:' || ?, 1, 1)`,
    ).run(eventId, eventId);
    const taskId = Number(conn.prepare('SELECT last_insert_rowid() AS id').get()?.id ?? 0);

    const result = softDelete('event', eventId);
    expect(result.ok).toBe(true);
    expect(conn.prepare("SELECT deleted_at FROM student_events WHERE id=?").get(eventId).deleted_at).not.toBe('');
    expect(conn.prepare("SELECT deleted_at FROM student_tasks WHERE id=?").get(taskId).deleted_at).not.toBe('');
    expect(listEntries().length).toBe(1);

    restore(Number(result.recycle_id));
    expect(conn.prepare("SELECT deleted_at FROM student_events WHERE id=?").get(eventId).deleted_at).toBe('');
    expect(conn.prepare("SELECT deleted_at FROM student_tasks WHERE id=?").get(taskId).deleted_at).toBe('');
  });

  it('永久删除需要二次确认且真正删除', () => {
    const conn = db.connInstance;
    conn.prepare(
      `INSERT INTO student_events(student_id, occurred_at, event_type, description, class_id, term_id)
       VALUES(1, '2026-04-15 08:10', '迟到', '待删除事件', 1, 1)`,
    ).run();
    const eventId = Number(conn.prepare('SELECT last_insert_rowid() AS id').get()?.id ?? 0);
    const result = softDelete('event', eventId);

    expect(() => purge(Number(result.recycle_id), '错误确认')).toThrow(/二次确认/);
    purge(Number(result.recycle_id), '永久删除');
    expect(conn.prepare('SELECT 1 FROM student_events WHERE id=?').get(eventId)).toBeUndefined();
    expect(listEntries({ status: '已删除' }).length).toBe(0);
  });
});

describe('业务日期与文件安全', () => {
  it('业务日期遵循 WORKBENCH_BUSINESS_DATE', () => {
    expect(todayString()).toBe('2026-04-15');
  });

  it('safeResolve 拒绝目录穿越', () => {
    const root = path.join(tempDir, 'kb');
    expect(safeResolve(root, '个人成长/笔记.md')).toContain(path.join('个人成长', '笔记.md'));
    expect(() => safeResolve(root, '../../etc/passwd')).toThrow(FileSafetyError);
    expect(() => safeResolve(root, '/abs/path')).toThrow(FileSafetyError);
  });

  it('atomicWrite 原子写入 + sha256', () => {
    const target = path.join(tempDir, 'files', 'note.md');
    atomicWrite(target, '内容');
    expect(fs.readFileSync(target, 'utf-8')).toBe('内容');
    expect(sha256('内容')).toHaveLength(64);
    const leftovers = fs.readdirSync(path.dirname(target));
    expect(leftovers.every((name) => !name.endsWith('.tmp'))).toBe(true);
  });

  it('cleanTempFiles 只清理超龄临时文件', () => {
    const dir = path.join(tempDir, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.tmp'), 'x');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
    expect(cleanTempFiles(dir, { olderThanMs: 0 })).toBe(1);
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(true);
  });
});
