/* MIG-01 试验 A-Electron：在 Electron 主进程中加载 better-sqlite3（Electron ABI）。

运行前必须先对 better-sqlite3 执行 @electron/rebuild（见 scripts/run-electron-abi.sh）。
验证：原生模块在 Electron ABI 下可加载、可直读工作台数据库、事务与完整性检查正常。
*/
import { app } from 'electron';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function fail(message) {
  console.error(`EXPERIMENT_FAIL: ${message}`);
  app.exit(1);
}

app.whenReady().then(() => {
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  [electron] ${name}${detail ? ` — ${detail}` : ''}`);
  };
  try {
    const src = path.join(ROOT, 'migrate', 'baseline', 'out', 'db', 'p0_demo', 'workbench.db');
    if (!fs.existsSync(src)) throw new Error('缺少基线样本，请先运行 python migrate/baseline/02_db_baselines.py');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig01-electron-'));
    const copy = path.join(tmp, 'workbench.db');
    fs.copyFileSync(src, copy);

    check('better-sqlite3 在 Electron ABI 下加载', true, `electron ${process.versions.electron} / node ${process.versions.node} / modules ${process.versions.modules}`);

    const db = new Database(copy);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    check('迁移版本=25', version === 25, `实际 ${version}`);

    const row = db.prepare('SELECT 学号, 姓名 FROM students ORDER BY id LIMIT 1').get();
    check('中文列名直读', Boolean(row && row.学号), row ? `${row.学号}/${row.姓名}` : '无行');

    const txn = db.transaction(() => {
      db.prepare("INSERT INTO students(学号, 姓名) VALUES('E-01', 'Electron 事务测试')").run();
    });
    txn();
    check('事务提交', db.prepare("SELECT 1 FROM students WHERE 学号='E-01'").get() !== undefined);
    db.exec("BEGIN; INSERT INTO students(学号, 姓名) VALUES('E-02', 'x'); ROLLBACK;");
    check('事务回滚', db.prepare("SELECT 1 FROM students WHERE 学号='E-02'").get() === undefined);

    check('integrity_check', db.pragma('integrity_check', { simple: true }) === 'ok');
    const fk = db.pragma('foreign_key_check');
    check('foreign_key_check', Array.isArray(fk) && fk.length === 0, `${fk.length} 条`);

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });

    const passed = checks.filter((c) => c.ok).length;
    console.log(`EXPERIMENT_RESULT=${JSON.stringify({ total: checks.length, passed, ok: passed === checks.length })}`);
    app.exit(passed === checks.length ? 0 : 1);
  } catch (err) {
    fail(`${err.name}: ${err.message}`);
  }
});
