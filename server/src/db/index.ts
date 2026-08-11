/* MIG-09 数据库单例：供路由层与启动入口共用；包含备份恢复辅助。
 * entry.ts 通过 setDb() 注入实例；路由层通过 db() 访问。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { WorkbenchDb } from './connection.js';

let instance: WorkbenchDb | null = null;

export function setDb(db: WorkbenchDb | null): void {
  instance = db;
}

export function db(): WorkbenchDb {
  if (!instance) throw new Error('数据库尚未初始化');
  return instance;
}

/** 校验 SQLite 备份文件（deserialize + integrity_check），通过后替换当前库并重开。 */
export function restoreFromBuffer(data: Buffer): Record<string, unknown> {
  if (!data || data.length === 0) throw new Error('备份文件为空');
  const tempDb = path.join(process.env.TMPDIR ?? os.tmpdir(), `restore-check-${Date.now()}.db`);
  const fs2 = fs;
  fs2.writeFileSync(tempDb, data);
  const check = new Database(tempDb, { readonly: true });
  let integrity = '';
  try {
    integrity = String(check.pragma('integrity_check', { simple: true }));
  } catch (error) {
    throw new Error(`无法读取备份文件：${(error as Error).message}`);
  } finally {
    check.close();
    fs2.rmSync(tempDb, { force: true });
  }
  if (integrity !== 'ok') throw new Error('备份文件完整性检查失败');

  const target = instance;
  if (!target) throw new Error('数据库尚未初始化');
  const preRestore = target.createBackupSync('pre-restore');
  target.close();
  fs.writeFileSync(target.paths.dbPath, data);
  target.open();
  return { ok: true, pre_restore_backup: preRestore };
}
