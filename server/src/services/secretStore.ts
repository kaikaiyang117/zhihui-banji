/* 本地敏感配置存储：不把 API Key、Token 等凭据放入业务 SQLite。 */
import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { getDb } from './context.js';

export function secretPath(filename: string): string {
  return path.join(getDb().paths.dataDir, filename);
}

export function readSecret<T extends Record<string, unknown>>(filename: string): T | null {
  try {
    const value = JSON.parse(fs.readFileSync(secretPath(filename), 'utf-8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as T : null;
  } catch {
    return null;
  }
}

export function writeSecret(filename: string, value: Record<string, unknown>): void {
  const target = secretPath(filename);
  const temporary = `${target}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.rmSync(target, { force: true });
  fs.renameSync(temporary, target);
}

export function deleteSecret(filename: string): void {
  fs.rmSync(secretPath(filename), { force: true });
}

export function deleteSettings(conn: Database.Database, keys: readonly string[]): void {
  if (keys.length === 0) return;
  const statement = conn.prepare('DELETE FROM agent_settings WHERE key=?');
  conn.transaction(() => {
    for (const key of keys) statement.run(key);
  })();
}
