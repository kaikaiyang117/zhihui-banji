import type { Database } from 'better-sqlite3';

import { record } from './audit.js';
import { getDb } from './context.js';

export const DEFAULT_SCHOOL_NAME = '我的学校';

export class SystemSettingsError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

export interface SystemSettings {
  school_name: string;
}

export function getSystemSettings(conn?: Database): SystemSettings {
  const db = connOf(conn);
  const row = db.prepare('SELECT value FROM system_settings WHERE key=?').get('school_name') as
    { value?: string } | undefined;
  return { school_name: String(row?.value || DEFAULT_SCHOOL_NAME) };
}

export function updateSystemSettings(
  input: { schoolName?: unknown },
  conn?: Database,
): SystemSettings {
  const schoolName = String(input.schoolName ?? '').trim();
  if (!schoolName) throw new SystemSettingsError('学校名称不能为空');
  if (schoolName.length > 120) throw new SystemSettingsError('学校名称不能超过 120 个字符');

  const db = connOf(conn);
  db.prepare(
    "INSERT INTO system_settings(key, value, updated_at) VALUES('school_name', ?, datetime('now','localtime')) "
      + "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  ).run(schoolName);
  record('system_setting', 'school_name', 'update', {
    summary: '更新学校名称',
    params: { school_name: schoolName },
    conn: db,
  });
  return getSystemSettings(db);
}
