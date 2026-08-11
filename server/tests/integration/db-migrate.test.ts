/* MIG-03 迁移引擎验证：与 MIG-00 Python 数据库基线逐项比对。
 *
 * 覆盖：空库等价、旧版样本升级等价（schema+数据）、重复启动幂等、
 * 高版本拒绝、100 次并发读取、写冲突、备份恢复、迁移中断恢复、Python 可读性。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

import { WorkbenchDb } from '../../src/db/connection.js';
import { schemaSnapshot, rowCounts } from '../../src/db/snapshot.js';
import * as schemaModule from '../../src/db/schema.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');
const BASELINE_DB = path.join(PROJECT_ROOT, 'migrate', 'baseline', 'out', 'db');

function requireBaselines(): void {
  for (const name of ['empty-v25', 'v4-sample', 'v4-upgraded', 'empty-v10', 'empty-v15', 'empty-v20']) {
    if (!fs.existsSync(path.join(BASELINE_DB, name, 'workbench.db'))) {
      throw new Error(`缺少基线样本 ${name}，请先运行 python migrate/baseline/02_db_baselines.py`);
    }
  }
}

let tempDir: string;
const openDbs: WorkbenchDb[] = [];

function makeDb(copyFrom?: string): WorkbenchDb {
  const db = new WorkbenchDb({ dataDir: tempDir });
  if (copyFrom) {
    const source = path.join(BASELINE_DB, copyFrom, 'workbench.db');
    fs.copyFileSync(source, db.paths.dbPath);
  }
  openDbs.push(db);
  return db;
}

function readJson(relative: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(BASELINE_DB, relative), 'utf-8'));
}

function pythonProbe(dbPath: string, sql: string): unknown {
  const output = execFileSync(
    process.env.WORKBENCH_PYTHON || 'python3',
    ['-c', `import sqlite3,json;c=sqlite3.connect(r'${dbPath}');c.row_factory=sqlite3.Row;print(json.dumps(${sql}))`],
    { encoding: 'utf-8' },
  ).trim();
  return JSON.parse(output);
}

beforeEach(() => {
  requireBaselines();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig03-'));
});

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs.length = 0;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('空库等价（Python 基线 empty-v25）', () => {
  it('Node 新库迁移到 v25，schema 与 Python 快照逐字节一致', () => {
    const db = makeDb();
    db.open();
    expect(db.schemaVersion()).toBe(25);
    expect(schemaSnapshot(db.connInstance)).toEqual(readJson('empty-v25/schema.json'));
  });

  it('各表 CREATE SQL 文本与 Python 完全一致（逐条核对，忽略行首缩进）', () => {
    const normalize = (sql: string): string => sql
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n');
    const node = makeDb();
    node.open();
    const python = new Database(path.join(BASELINE_DB, 'empty-v25', 'workbench.db'), { readonly: true });
    const nodeSql = new Map<string, string>();
    const pythonSql = new Map<string, string>();
    for (const db of [node.connInstance, python]) {
      const rows = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as Array<{ name: string; sql: string }>;
      const target = db === python ? pythonSql : nodeSql;
      for (const row of rows) target.set(row.name, row.sql);
    }
    python.close();
    expect([...nodeSql.keys()].sort()).toEqual([...pythonSql.keys()].sort());
    for (const [name, sql] of nodeSql) {
      expect(normalize(sql), `表 ${name} 的 CREATE SQL 不一致`).toBe(normalize(pythonSql.get(name) ?? ''));
    }
  });

  it('关键表行数与 Python 基线一致（含迁移数据插入）', () => {
    const db = makeDb();
    db.open();
    const counts = rowCounts(db.connInstance);
    const expected = readJson('empty-v25/counts.json') as Record<string, number>;
    expect(counts).toEqual(expected);
    // 迁移自带数据：默认班级/学期/在班关系
    expect(counts.classes).toBe(1);
    expect(counts.terms).toBe(1);
  });
});

describe('旧版样本升级等价', () => {
  it('v4-sample 经 Node 引擎升级到 v25，与 Python v4-upgraded 完全一致', () => {
    const db = makeDb('v4-sample');
    db.open();
    expect(db.schemaVersion()).toBe(25);
    expect(schemaSnapshot(db.connInstance)).toEqual(readJson('v4-upgraded/schema.json'));
    expect(rowCounts(db.connInstance)).toEqual(readJson('v4-upgraded/counts.json'));
  });

  it('v10/v15/v20 空库可被 Node 引擎打开并升级到 v25', () => {
    for (const version of [10, 15, 20]) {
      const db = makeDb(`empty-v${version}`);
      db.open();
      expect(db.schemaVersion()).toBe(25);
      expect(schemaSnapshot(db.connInstance)).toEqual(readJson('empty-v25/schema.json'));
    }
  });

  it('升级后的库 Python 可读且完整性通过（跨引擎验证）', () => {
    const db = makeDb('v4-sample');
    db.open();
    db.close();
    const integrity = pythonProbe(db.paths.dbPath, 'c.execute("PRAGMA integrity_check").fetchone()[0]');
    expect(integrity).toBe('ok');
    const version = pythonProbe(db.paths.dbPath, 'c.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]');
    expect(version).toBe(25);
    const students = pythonProbe(db.paths.dbPath, '[r["学号"] for r in c.execute("SELECT 学号 FROM students")]') as string[];
    const pythonExpected = readJson('v4-upgraded/counts.json') as Record<string, number>;
    expect(students.length).toBe(pythonExpected.students);
  });
});

describe('重复启动幂等与版本拒绝', () => {
  it('同一库重复 open 不重复迁移、数据不变', () => {
    const db = makeDb('v4-sample');
    db.open();
    expect(db.schemaVersion()).toBe(25);
    const first = rowCounts(db.connInstance);
    db.close();
    db.open();
    expect(db.schemaVersion()).toBe(25);
    expect(rowCounts(db.connInstance)).toEqual(first);
    expect(db.connInstance.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('高版本数据库拒绝启动', () => {
    const db = makeDb();
    fs.mkdirSync(path.dirname(db.paths.dbPath), { recursive: true });
    const raw = new Database(db.paths.dbPath);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)');
    raw.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(26);
    raw.close();
    expect(() => db.open()).toThrow(/高于当前程序支持的版本/);
  });
});

describe('并发读取与写冲突', () => {
  it('100 次并发异步读取无错误', async () => {
    const db = makeDb('v4-sample');
    db.open();
    const tasks = Array.from({ length: 100 }, async (_unused, index) => {
      const row = db.connInstance.prepare('SELECT 学号, 姓名 FROM students ORDER BY id LIMIT ?').all(index % 5 + 1);
      return row.length;
    });
    const results = await Promise.all(tasks);
    expect(results.every((length) => length >= 1)).toBe(true);
  });

  it('同一文件两个连接写冲突被检测（SQLITE_BUSY）', () => {
    const a = makeDb('v4-sample');
    a.open();
    const b = new Database(a.paths.dbPath);
    b.pragma('busy_timeout = 50');
    a.connInstance.exec("BEGIN IMMEDIATE; INSERT INTO students(学号, 姓名) VALUES('C1','x');");
    let observed = '';
    try {
      b.prepare("INSERT INTO students(学号, 姓名) VALUES('C2','y')").run();
    } catch (error) {
      observed = String((error as { code?: unknown }).code);
    }
    a.connInstance.exec('COMMIT');
    b.close();
    expect(observed).toBe('SQLITE_BUSY');
    expect((a.connInstance.prepare("SELECT COUNT(*) AS c FROM students WHERE 学号='C2'").get() as { c: number }).c).toBe(0);
  });
});

describe('备份与恢复', () => {
  it('createBackup 生成一致性备份，恢复后数据一致', async () => {
    const db = makeDb('v4-sample');
    db.open();
    const before = rowCounts(db.connInstance);
    const filename = await db.createBackup('manual');
    expect(filename).toMatch(/^workbench-manual-\d{8}-\d{6}-\d{6}\.db$/);
    const backupPath = path.join(db.backupDir(), filename);
    expect(fs.existsSync(backupPath)).toBe(true);

    db.connInstance.prepare('DELETE FROM students').run();
    expect((db.connInstance.prepare('SELECT COUNT(*) AS c FROM students').get() as { c: number }).c).toBe(0);

    // 用备份覆盖当前库后重新打开
    db.close();
    fs.copyFileSync(backupPath, db.paths.dbPath);
    db.open();
    expect(rowCounts(db.connInstance)).toEqual(before);
    expect(db.connInstance.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.connInstance.pragma('foreign_key_check').length).toBe(0);
  });

  it('迁移前自动创建 pre-migrate 备份', () => {
    const db = makeDb('v4-sample');
    db.open();
    const backups = fs.readdirSync(db.backupDir());
    expect(backups.some((name) => name.includes('pre-migrate-v5'))).toBe(true);
    const backupPath = path.join(db.backupDir(), backups[0]);
    const probe = new Database(backupPath, { readonly: true });
    expect((probe.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(4);
    probe.close();
  });
});

describe('迁移中断恢复', () => {
  it('迁移失败后版本停留在失败前，修复后重启成功', () => {
    const original25 = schemaModule.MIGRATIONS[25];
    try {
      // 先只迁移到 v24
      delete schemaModule.MIGRATIONS[25];
      const partial = makeDb();
      partial.open();
      expect(partial.schemaVersion()).toBe(24);
      partial.close();

      // 注入失败迁移
      schemaModule.MIGRATIONS[25] = (conn) => {
        conn.exec('CREATE TABLE failed_marker (x INTEGER)');
        throw new Error('注入的迁移失败');
      };
      const broken = new WorkbenchDb({ dataDir: tempDir });
      openDbs.push(broken);
      expect(() => broken.open()).toThrow(/注入的迁移失败/);

      // 失败后版本仍为 24，未写入 25 标记
      const probe = new Database(broken.paths.dbPath, { readonly: true });
      expect((probe.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(24);
      probe.close();

      // 修复后重启成功
      schemaModule.MIGRATIONS[25] = original25;
      const fixed = new WorkbenchDb({ dataDir: tempDir });
      openDbs.push(fixed);
      fixed.open();
      expect(fixed.schemaVersion()).toBe(25);
    } finally {
      schemaModule.MIGRATIONS[25] = original25;
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
