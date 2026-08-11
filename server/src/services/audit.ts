/* MIG-04 系统审计：渠道/操作者上下文、敏感参数脱敏、缺省写审计。
 * 列表截断 20 项、字符串截断 200 字符。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from 'better-sqlite3';

import { getDb } from './context.js';

const actorStore = new AsyncLocalStorage<{ channel: string; actorId: string }>();
const recordedStore = new AsyncLocalStorage<boolean>();

const SENSITIVE_MARKERS = [
  'key', 'token', 'secret', 'password', 'credential', 'authorization',
  '密码', '电话', '手机', '地址', '住址',
];

export interface Actor {
  channel: string;
  actorId: string;
}

export function bindActor(channel: string | null, actorId: string | null): void {
  actorStore.enterWith({
    channel: String(channel ?? 'web').slice(0, 30),
    actorId: String(actorId ?? 'local-user').slice(0, 80),
  });
}

export function resetActor(): void {
  actorStore.enterWith({ channel: 'web', actorId: 'local-user' });
}

export function currentActor(): Actor {
  return actorStore.getStore() ?? { channel: 'web', actorId: 'local-user' };
}

export function beginRequest(): void {
  recordedStore.enterWith(false);
}

export function resetRequest(): void {
  recordedStore.enterWith(false);
}

export function hasRecorded(): boolean {
  return recordedStore.getStore() === true;
}

function sanitize(value: unknown, key = ''): unknown {
  if (SENSITIVE_MARKERS.some((marker) => key.toLowerCase().includes(marker.toLowerCase()))) {
    return '***';
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const result: Record<string, unknown> = {};
    for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
      result[String(innerKey)] = sanitize(innerValue, String(innerKey));
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitize(item));
  }
  /* Python str() 的布尔值为 True/False；JS String(false) 为 'false'，对齐 Python。 */
  const text = value === null || value === undefined ? ''
    : typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value);
  return text.slice(0, 200);
}

export interface AuditOptions {
  status?: string;
  summary?: string;
  params?: Record<string, unknown> | null;
  classId?: number | null;
  termId?: number | null;
  conn?: Database;
  commit?: boolean;
}

export function record(
  objectType: string,
  objectId: string | number = '',
  action = '',
  options: AuditOptions = {},
): void {
  const conn = options.conn ?? getDb().connInstance;
  recordedStore.enterWith(true);
  let classId = options.classId ?? null;
  let termId = options.termId ?? null;
  if (classId === null || termId === null) {
    try {
      [classId, termId] = contextModule.scopeIds({ conn });
    } catch {
      classId = null;
      termId = null;
    }
  }
  const { channel, actorId } = currentActor();
  conn.prepare(
    'INSERT INTO system_audit('
    + 'channel, actor_id, object_type, object_id, action, status, '
    + 'summary, params_summary, class_id, term_id'
    + ') VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(
    channel, actorId, objectType, String(objectId), action,
    options.status ?? 'success', String(options.summary ?? '').slice(0, 300),
    JSON.stringify(sanitize(options.params ?? {})), classId, termId,
  );
  // better-sqlite3 语句自动提交；commit 参数仅保留 API 兼容语义。
  void options.commit;
}

// 循环依赖处理：audit → context（scopeIds）；context 不依赖 audit。
import * as contextModule from './context.js';

export function listAudits(limit = 200, conn?: Database): Array<Record<string, unknown>> {
  const db = conn ?? getDb().connInstance;
  const [classId, termId] = contextModule.scopeIds({ conn: db });
  const rows = db.prepare(
    'SELECT * FROM system_audit '
    + 'WHERE (class_id=? AND term_id=?) OR class_id IS NULL '
    + 'ORDER BY id DESC LIMIT ?',
  ).all(classId, termId, Math.max(1, Math.min(Number(limit), 500))) as Array<Record<string, unknown>>;
  const result: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const item = { ...row };
    try {
      item.params_summary = JSON.parse(String(item.params_summary ?? '{}'));
    } catch {
      // 保持原样
    }
    result.push(item);
  }
  return result;
}
