/* MIG-01 试验 A：better-sqlite3 对现有工作台数据库的兼容验证（Node 运行时）。

验证项：
1. 直读现有 v25 库与旧版 v4 库（WAL、外键、busy_timeout、中文列名）
2. 事务提交/回滚
3. 并发读取（Worker 线程）
4. 写冲突行为（两个连接竞争写入）
5. integrity_check / foreign_key_check
6. backup API
7. JSON 列（sheet_rows.data）读取

输入：migrate/baseline 生成的固定数据库样本；输出 stdout JSON 报告。
*/
import Database from 'better-sqlite3';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BASELINE_DB = path.join(ROOT, 'migrate', 'baseline', 'out', 'db');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mig01-sqlite-'));

const results: { checks: { name: string; ok: boolean; detail: string }[]; total?: number; passed?: number; ok?: boolean } = { checks: [] };

function check(name: string, ok: boolean, detail = '') {
  results.checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

let copyCounter = 0;

function copyBaseline(name: string, label = '') {
  const src = path.join(BASELINE_DB, name, 'workbench.db');
  if (!fs.existsSync(src)) throw new Error(`缺少基线样本 ${src}，请先运行 python migrate/baseline/02_db_baselines.py`);
  copyCounter += 1;
  const dest = path.join(TMP, `${copyCounter}-${label || name}.db`);
  fs.copyFileSync(src, dest);
  return dest;
}

function openWithPragmas(file: string) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

// ---------- 1. 直读现有库 ----------
const p0 = copyBaseline('p0_demo');
const db = openWithPragmas(p0);
check('journal_mode=WAL', db.pragma('journal_mode', { simple: true }) === 'wal', 'WAL 生效');
check('foreign_keys=ON', db.pragma('foreign_keys', { simple: true }) === 1);
check('busy_timeout=5000', db.pragma('busy_timeout', { simple: true }) === 5000);

const version = (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
check('迁移版本=25', version === 25, `实际 ${version}`);

const chineseRow = db.prepare('SELECT id, 学号, 姓名, 性别 FROM students ORDER BY id LIMIT 1').get() as { id: number; 学号: string; 姓名: string; 性别: string } | undefined;
check('中文列名查询', Boolean(chineseRow && chineseRow.学号 && chineseRow.姓名),
  chineseRow ? `${chineseRow.学号}/${chineseRow.姓名}` : '无行');

const rowCount = (db.prepare('SELECT COUNT(*) AS c FROM students').get() as { c: number }).c;
check('学生表可计数', rowCount >= 1, `${rowCount} 行`);

const jsonRow = db.prepare("SELECT data FROM sheet_rows WHERE sheet='班主任日志' LIMIT 1").get() as { data: string } | undefined;
check('JSON 列读取', jsonRow === undefined || Array.isArray(JSON.parse(jsonRow.data)), 'sheet_rows.data');

// ---------- 2. 事务提交/回滚 ----------
const txn = db.transaction(() => {
  db.prepare("INSERT INTO students(学号, 姓名, 性别) VALUES('TXN-01', '事务提交测试', '男')").run();
});
txn();
check('事务提交持久化', db.prepare("SELECT 1 FROM students WHERE 学号='TXN-01'").get() !== undefined);

db.exec("BEGIN; INSERT INTO students(学号, 姓名, 性别) VALUES('TXN-02', '事务回滚测试', '女'); ROLLBACK;");
check('事务回滚不残留', db.prepare("SELECT 1 FROM students WHERE 学号='TXN-02'").get() === undefined);

// ---------- 3. 并发读取 ----------
const workerCode = `
  const { parentPort, workerData } = require('node:worker_threads');
  const Database = require(${JSON.stringify(path.join(ROOT, 'migrate', 'mig-01', 'node_modules', 'better-sqlite3'))});
  const db = new Database(workerData.file, { readonly: true });
  db.pragma('busy_timeout = 5000');
  let rows = 0;
  for (let i = 0; i < 200; i++) {
    rows += db.prepare('SELECT COUNT(*) AS c FROM students').get().c;
  }
  parentPort.postMessage({ rows, error: null });
`;
const concurrentResults = (await Promise.all(
  Array.from({ length: 4 }, () => new Promise((resolve) => {
    const w = new Worker(workerCode, { eval: true, workerData: { file: p0 } });
    w.on('message', resolve);
    w.on('error', (e) => resolve({ error: String(e) }));
  })),
)) as Array<{ rows?: number; error?: string | null }>;
check('4 线程 × 200 次并发读取', concurrentResults.every((r) => r.error === null),
  `结果 ${concurrentResults.map((r) => r.rows ?? r.error).join(' / ')}`);

// ---------- 4. 写冲突（同一文件两个连接竞争写入） ----------
const shared = copyBaseline('p0_demo', 'conflict');
const writer1 = openWithPragmas(shared);
const writer2 = new Database(shared);
writer2.pragma('busy_timeout = 50');  // 快速失败，避免等待 5 秒
let conflictObserved = '';
writer1.exec("BEGIN IMMEDIATE; INSERT INTO students(学号, 姓名) VALUES('CONF-01', '冲突测试');");
try {
  writer2.prepare("INSERT INTO students(学号, 姓名) VALUES('CONF-02', '冲突测试')").run();
} catch (err) {
  conflictObserved = String((err as { code?: unknown; message?: unknown }).code || (err as { message?: unknown }).message);
}
check('写冲突被检测（SQLITE_BUSY，不崩溃不覆盖）', conflictObserved !== '',
  `冲突结果 ${conflictObserved || '未检测到'}`);
writer1.exec('COMMIT');
const afterConflict = (writer2.prepare("SELECT COUNT(*) AS c FROM students WHERE 学号 IN ('CONF-01','CONF-02')").get() as { c: number }).c;
check('冲突后数据一致（CONF-01 已提交，CONF-02 未写入）', afterConflict === 1, `${afterConflict} 行`);
writer1.close();
writer2.close();

// ---------- 5. 完整性检查 ----------
const integrity = db.pragma('integrity_check', { simple: true });
check('integrity_check=ok', integrity === 'ok');
const fkIssues = db.pragma('foreign_key_check') as unknown[];
check('foreign_key_check 无问题', Array.isArray(fkIssues) && fkIssues.length === 0, `${fkIssues.length} 条`);

// ---------- 6. backup API ----------
const backupTarget = path.join(TMP, 'backup.db');
await new Promise((resolve, reject) => {
  db.backup(backupTarget).then(resolve).catch(reject);
});
const backupDb = openWithPragmas(backupTarget);
const backupCount = (backupDb.prepare('SELECT COUNT(*) AS c FROM students').get() as { c: number }).c;
check('backup API 行数一致', backupCount === rowCount + 1, `${backupCount} === ${rowCount + 1}（含 TXN-01）`);
check('备份库完整性', backupDb.pragma('integrity_check', { simple: true }) === 'ok');
backupDb.close();

// ---------- 7. 旧版库直读 ----------
const v4 = openWithPragmas(copyBaseline('v4-sample'));
const v4version = (v4.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
check('旧版 v4 库可直读', v4version === 4, `实际 ${v4version}`);
v4.close();

db.close();
fs.rmSync(TMP, { recursive: true, force: true });

const passed = results.checks.filter((c) => c.ok).length;
results.total = results.checks.length;
results.passed = passed;
results.ok = passed === results.checks.length;
console.log(`\nSQLite 试验（Node）：${passed}/${results.checks.length} 通过`);
process.exit(results.ok ? 0 : 1);
