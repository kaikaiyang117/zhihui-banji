/* MIG-04 局域网设备：短时配对、凭证校验、过期与即时撤权。
 * 负责哈希、TTL、审计和 last_seen 更新。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { getDb } from './context.js';
import * as audit from './audit.js';

export const PAIRING_TTL_SECONDS = 5 * 60;
export const DEVICE_TTL_DAYS = 90;

export class DeviceError extends Error {}

export function isLocalHost(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost', 'testclient'].includes(host);
}

export function nowString(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function hash(value: string): string {
  return createHash('sha256').update(String(value), 'utf-8').digest('hex');
}

function tokenUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

export function createPairing(
  baseUrl: string,
  options: { ttlSeconds?: number; conn?: Database } = {},
): Record<string, unknown> {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new DeviceError('当前未启用局域网访问');
  const conn = connOf(options.conn);
  const code = tokenUrlSafe(18);
  const ttl = Math.max(30, Math.floor(options.ttlSeconds ?? PAIRING_TTL_SECONDS));
  const expires = new Date(Date.now() + ttl * 1000);
  conn.prepare(
    "UPDATE pairing_sessions SET status='已过期' WHERE status='待使用' AND expires_at<=?",
  ).run(nowString());
  conn.prepare(
    'INSERT INTO pairing_sessions(code_hash, expires_at) VALUES(?,?)',
  ).run(hash(code), formatTime(expires));
  audit.record(
    'device_pairing', '', 'create', {
      summary: '创建短时设备配对码',
      params: { expires_at: formatTime(expires) },
      conn,
    },
  );
  return {
    code,
    url: `${base}/?pair=${code}`,
    expires_at: formatTime(expires),
    expires_in: ttl,
  };
}

function formatTime(value: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} `
    + `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function parseTime(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new DeviceError('配对码状态异常，请重新生成');
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return new Date(y, mo - 1, d, h, mi, s);
}

export function claimPairing(
  code: string,
  options: { name?: string; userAgent?: string; ip?: string; conn?: Database } = {},
): Record<string, unknown> {
  const value = String(code ?? '').trim();
  if (!value) throw new DeviceError('缺少配对码');
  const conn = connOf(options.conn);
  const now = new Date();
  const row = conn.prepare(
    'SELECT * FROM pairing_sessions WHERE code_hash=?',
  ).get(hash(value)) as Record<string, unknown> | undefined;
  if (!row || row.status !== '待使用') {
    throw new DeviceError('配对码无效或已经使用');
  }
  let expires: Date;
  try {
    expires = parseTime(String(row.expires_at));
  } catch (error) {
    throw new DeviceError('配对码状态异常，请重新生成');
  }
  if (expires.getTime() <= now.getTime()) {
    conn.prepare("UPDATE pairing_sessions SET status='已过期' WHERE id=?").run(row.id);
    throw new DeviceError('配对码已过期，请在电脑端重新生成');
  }

  const credential = tokenUrlSafe(32);
  const deviceId = tokenUrlSafe(12);
  const deviceName = String(options.name ?? '移动设备').trim().slice(0, 80) || '移动设备';
  const deviceExpires = new Date(now.getTime() + DEVICE_TTL_DAYS * 86400_000);
  const result = conn.prepare(
    "UPDATE pairing_sessions SET status='已使用', used_at=? WHERE id=? AND status='待使用'",
  ).run(nowString(), row.id);
  if (result.changes === 0) {
    throw new DeviceError('配对码无效或已经使用');
  }
  const inserted = conn.prepare(
    `INSERT INTO paired_devices(
       device_id, name, credential_hash, last_seen_at, expires_at,
       user_agent, last_ip
     ) VALUES(?,?,?,?,?,?,?)`,
  ).run(
    deviceId, deviceName, hash(credential), nowString(),
    formatTime(deviceExpires), String(options.userAgent ?? '').slice(0, 300),
    String(options.ip ?? '').slice(0, 80),
  );
  audit.record(
    'paired_device', Number(inserted.lastInsertRowid), 'pair', {
      summary: `授权设备：${deviceName}`,
      params: { device_id: deviceId, ip: options.ip ?? '', expires_at: formatTime(deviceExpires) },
      classId: null, termId: null, conn,
    },
  );
  return {
    device_id: deviceId,
    device_token: credential,
    name: deviceName,
    expires_at: formatTime(deviceExpires),
  };
}

export function authenticate(
  credential: string,
  options: { ip?: string; userAgent?: string; conn?: Database } = {},
): Record<string, unknown> | null {
  const value = String(credential ?? '').trim();
  if (!value) return null;
  const conn = connOf(options.conn);
  const now = nowString();
  const row = conn.prepare(
    "SELECT * FROM paired_devices WHERE credential_hash=? AND status='已授权'",
  ).get(hash(value)) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (String(row.expires_at) <= now) {
    conn.prepare("UPDATE paired_devices SET status='已过期' WHERE id=?").run(row.id);
    return null;
  }
  conn.prepare(
    'UPDATE paired_devices SET last_seen_at=?, last_ip=?, user_agent=? WHERE id=?',
  ).run(
    now, String(options.ip ?? '').slice(0, 80),
    String(options.userAgent ?? row.user_agent ?? '').slice(0, 300), row.id,
  );
  return row;
}

export function listDevices(conn?: Database): Array<Record<string, unknown>> {
  const db = connOf(conn);
  return db.prepare(
    `SELECT id, device_id, name, status, paired_at, last_seen_at,
            expires_at, revoked_at, user_agent, last_ip
     FROM paired_devices ORDER BY
       CASE WHEN status='已授权' THEN 0 ELSE 1 END,
       COALESCE(NULLIF(last_seen_at,''), paired_at) DESC, id DESC`,
  ).all() as Array<Record<string, unknown>>;
}

export function revoke(deviceId: number, conn?: Database): Record<string, unknown> {
  const db = connOf(conn);
  const row = db.prepare('SELECT * FROM paired_devices WHERE id=?').get(deviceId) as
    Record<string, unknown> | undefined;
  if (!row) throw new DeviceError('设备不存在');
  if (row.status !== '已授权') return { ok: true, changed: false };
  db.prepare("UPDATE paired_devices SET status='已撤权', revoked_at=? WHERE id=?").run(nowString(), deviceId);
  audit.record(
    'paired_device', deviceId, 'revoke', {
      summary: `撤销设备：${row.name}`,
      params: { device_id: row.device_id },
      classId: null, termId: null, conn: db,
    },
  );
  return { ok: true, changed: true };
}

export function revokeAll(conn?: Database): Record<string, unknown> {
  const db = connOf(conn);
  const result = db.prepare(
    "UPDATE paired_devices SET status='已撤权', revoked_at=? WHERE status='已授权'",
  ).run(nowString());
  audit.record(
    'paired_device', '*', 'revoke_all', {
      summary: `撤销全部设备：${result.changes} 台`,
      classId: null, termId: null, conn: db,
    },
  );
  return { ok: true, count: result.changes };
}

export function revokeCredential(credential: string, conn?: Database): boolean {
  const db = connOf(conn);
  const row = db.prepare(
    "SELECT id FROM paired_devices WHERE credential_hash=? AND status='已授权'",
  ).get(hash(credential)) as { id: number } | undefined;
  if (!row) return false;
  revoke(Number(row.id), db);
  return true;
}
