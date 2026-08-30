/* MIG-03 Node 迁移引擎验证：schema、幂等、并发、备份和失败恢复。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { WorkbenchDb } from '../../src/db/connection.js';
import { schemaSnapshot, rowCounts } from '../../src/db/snapshot.js';
import * as schemaModule from '../../src/db/schema.js';

let tempDir: string;
const openDbs: WorkbenchDb[] = [];

function makeDb(): WorkbenchDb {
  const db = new WorkbenchDb({ dataDir: tempDir });
  openDbs.push(db);
  return db;
}

function seedStudents(db: WorkbenchDb, count = 3): void {
  for (let index = 1; index <= count; index += 1) {
    db.connInstance.prepare('INSERT INTO students(学号, 姓名) VALUES(?, ?)')
      .run(`M${String(index).padStart(3, '0')}`, `迁移学生${index}`);
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig03-'));
});

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs.length = 0;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('schema 与启动迁移', () => {
  it('新库完成全部迁移并创建默认上下文', () => {
    const db = makeDb();
    db.open();
    expect(db.schemaVersion()).toBe(38);
    const counts = rowCounts(db.connInstance);
    expect(counts.classes).toBe(1);
    expect(counts.terms).toBe(1);
    const snapshot = schemaSnapshot(db.connInstance);
    expect(snapshot.tables).toHaveProperty('students');
    expect(snapshot.tables).toHaveProperty('academic_terms');
    expect((db.connInstance.prepare('SELECT academic_term_id FROM terms WHERE id=1').get() as
      { academic_term_id: number }).academic_term_id).toBeGreaterThan(0);
    expect(db.connInstance.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('同一库重复打开不重复迁移且数据不变', () => {
    const db = makeDb();
    db.open();
    seedStudents(db);
    const first = rowCounts(db.connInstance);
    db.close();
    db.open();
    expect(db.schemaVersion()).toBe(38);
    expect(rowCounts(db.connInstance)).toEqual(first);
    expect(db.connInstance.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('高版本数据库拒绝启动', () => {
    const db = makeDb();
    fs.mkdirSync(path.dirname(db.paths.dbPath), { recursive: true });
    const raw = new Database(db.paths.dbPath);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    raw.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(99);
    raw.close();
    expect(() => db.open()).toThrow(/高于当前程序支持的版本/);
  });
});

describe('并发读取与写冲突', () => {
  it('100 次并发异步读取无错误', async () => {
    const db = makeDb();
    db.open();
    seedStudents(db);
    const tasks = Array.from({ length: 100 }, async (_unused, index) => {
      const rows = db.connInstance.prepare('SELECT 学号, 姓名 FROM students ORDER BY id LIMIT ?')
        .all(index % 3 + 1);
      return rows.length;
    });
    const results = await Promise.all(tasks);
    expect(results.every((length) => length >= 1)).toBe(true);
  });

  it('同一文件两个连接写冲突被检测为 SQLITE_BUSY', () => {
    const db = makeDb();
    db.open();
    const other = new Database(db.paths.dbPath);
    other.pragma('busy_timeout = 50');
    db.connInstance.exec("BEGIN IMMEDIATE; INSERT INTO students(学号, 姓名) VALUES('C1','x');");
    let observed = '';
    try {
      other.prepare("INSERT INTO students(学号, 姓名) VALUES('C2','y')").run();
    } catch (error) {
      observed = String((error as { code?: unknown }).code);
    }
    db.connInstance.exec('COMMIT');
    other.close();
    expect(observed).toBe('SQLITE_BUSY');
    expect((db.connInstance.prepare("SELECT COUNT(*) AS c FROM students WHERE 学号='C2'").get() as { c: number }).c).toBe(0);
  });
});

describe('备份与恢复', () => {
  it('createBackup 生成一致性备份，恢复后数据一致', async () => {
    const db = makeDb();
    db.open();
    seedStudents(db);
    const before = rowCounts(db.connInstance);
    const filename = await db.createBackup('manual');
    const backupPath = path.join(db.backupDir(), filename);
    expect(fs.existsSync(backupPath)).toBe(true);

    db.connInstance.prepare('DELETE FROM students').run();
    db.close();
    fs.copyFileSync(backupPath, db.paths.dbPath);
    db.open();
    expect(rowCounts(db.connInstance)).toEqual(before);
    expect(db.connInstance.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.connInstance.pragma('foreign_key_check').length).toBe(0);
  });

});

describe('迁移中断恢复', () => {
  it('迁移失败后版本停留在失败前，修复后重启成功', () => {
    const original36 = schemaModule.MIGRATIONS[36];
    const original37 = schemaModule.MIGRATIONS[37];
    const original38 = schemaModule.MIGRATIONS[38];
    try {
      delete schemaModule.MIGRATIONS[36];
      delete schemaModule.MIGRATIONS[37];
      delete schemaModule.MIGRATIONS[38];
      const partial = makeDb();
      partial.open();
      expect(partial.schemaVersion()).toBe(35);
      partial.close();

      schemaModule.MIGRATIONS[36] = (conn) => {
        conn.exec('CREATE TABLE failed_marker (x INTEGER)');
        throw new Error('注入的迁移失败');
      };
      const broken = makeDb();
      expect(() => broken.open()).toThrow(/注入的迁移失败/);

      const probe = new Database(broken.paths.dbPath, { readonly: true });
      expect((probe.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(35);
      probe.close();

      schemaModule.MIGRATIONS[36] = original36;
      schemaModule.MIGRATIONS[37] = original37;
      schemaModule.MIGRATIONS[38] = original38;
      const fixed = makeDb();
      fixed.open();
      expect(fixed.schemaVersion()).toBe(38);
    } finally {
      schemaModule.MIGRATIONS[36] = original36;
      schemaModule.MIGRATIONS[37] = original37;
      schemaModule.MIGRATIONS[38] = original38;
    }
  });
});

describe('withTransaction', () => {
  it('成功提交、失败回滚', () => {
    const db = makeDb();
    db.open();
    db.withTransaction(() => {
      db.connInstance.prepare("INSERT INTO students(学号, 姓名) VALUES('T1','甲')").run();
    });
    expect((db.connInstance.prepare("SELECT COUNT(*) AS c FROM students WHERE 学号='T1'").get() as { c: number }).c).toBe(1);

    expect(() => db.withTransaction(() => {
      db.connInstance.prepare("INSERT INTO students(学号, 姓名) VALUES('T2','乙')").run();
      throw new Error('回滚测试');
    })).toThrow('回滚测试');
    expect((db.connInstance.prepare("SELECT COUNT(*) AS c FROM students WHERE 学号='T2'").get() as { c: number }).c).toBe(0);
  });
});
