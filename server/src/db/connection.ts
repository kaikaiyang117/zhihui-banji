/* MIG-03 连接管理：受控单连接、PRAGMA、事务、备份、关闭。
 *
 * 约定（方案 10.4 节）：
 * - 进程内使用一个受控连接与显式事务；长时间 CPU/Excel 任务不得持有事务。
 * - withTransaction 失败自动回滚。
 * - 一致性备份使用 SQLite backup API；备份名与 Python 一致（workbench-<label>-<ts>.db）。
 * - 测试通过 openDataDir() 切换数据目录。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { initSchema, schemaVersion } from './schema.js';

export interface DbPaths {
  dataDir: string;
  dbPath: string;
  backupsDir: string;
  kbDir: string;
}

export interface WorkbenchDbOptions {
  dataDir: string;
  dbPath?: string;
  backupsDir?: string;
  kbDir?: string;
}

export class WorkbenchDb {
  readonly paths: DbPaths;
  private conn: Database.Database | null = null;
  private closed = true;

  constructor(options: WorkbenchDbOptions) {
    this.paths = {
      dataDir: options.dataDir,
      dbPath: options.dbPath ?? path.join(options.dataDir, 'workbench.db'),
      backupsDir: options.backupsDir ?? path.join(options.dataDir, 'backups'),
      kbDir: options.kbDir ?? path.join(options.dataDir, '知识库'),
    };
  }

  /** 打开连接并初始化 schema（含迁移）。existingDatabase 按文件是否存在判断。 */
  open(): void {
    if (!this.closed) return;
    fs.mkdirSync(this.paths.dataDir, { recursive: true });
    const existingDatabase = fs.existsSync(this.paths.dbPath);
    const conn = new Database(this.paths.dbPath);
    conn.pragma('journal_mode = WAL');
    conn.pragma('busy_timeout = 5000');
    conn.pragma('foreign_keys = ON');
    try {
      initSchema(conn, existingDatabase, (label) => {
        this.backupSync(conn, label);
      });
    } catch (error) {
      conn.close();
      throw error;
    }
    this.conn = conn;
    this.closed = false;
  }

  /** 同步一致性备份（迁移前与恢复前使用；checkpoint 后复制主文件，避免 WAL 丢数据）。 */
  createBackupSync(label: string): string {
    return this.backupSync(this.connInstance, label);
  }

  private backupSync(conn: Database.Database, label: string): string {
    conn.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.mkdirSync(this.paths.backupsDir, { recursive: true });
    const safeLabel = label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'backup';
    const filename = `workbench-${safeLabel}-${timestampMicro()}.db`;
    fs.copyFileSync(this.paths.dbPath, path.join(this.paths.backupsDir, filename));
    return filename;
  }

  /** 当前线程专用连接（进程内受控单连接）。 */
  get connInstance(): Database.Database {
    if (!this.conn || this.closed) {
      throw new Error('数据库尚未打开，请先调用 open()');
    }
    return this.conn;
  }

  get isOpen(): boolean {
    return !this.closed && this.conn !== null;
  }

  schemaVersion(): number {
    return schemaVersion(this.connInstance);
  }

  /** 显式事务：fn 抛错时回滚，否则提交。 */
  withTransaction<T>(fn: () => T): T {
    const conn = this.connInstance;
    const run = conn.transaction(fn);
    return run();
  }

  /** 一致性备份（SQLite backup API），返回备份文件名。 */
  async createBackup(label: string): Promise<string> {
    const conn = this.connInstance;
    fs.mkdirSync(this.paths.backupsDir, { recursive: true });
    const safeLabel = label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'backup';
    const timestamp = timestampMicro();
    const filename = `workbench-${safeLabel}-${timestamp}.db`;
    const target = path.join(this.paths.backupsDir, filename);
    await conn.backup(target);
    return filename;
  }

  backupDir(): string {
    return this.paths.backupsDir;
  }

  close(): void {
    if (this.conn) {
      try {
        this.conn.close();
      } catch {
        // 关闭失败不阻塞退出
      }
      this.conn = null;
    }
    this.closed = true;
  }
}

function timestampMicro(): string {
  const now = new Date();
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  const micro = String(Math.floor(now.getMilliseconds() * 1000)).padStart(6, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${micro}`;
}
