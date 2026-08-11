/* MIG-09 输出、个人与系统运维测试：报告、健康、导出、备份恢复、迁移包、更新状态。 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';
import { setDb as setDbSingleton } from '../../src/db/index.js';
import * as reports from '../../src/services/reports.js';
import * as health from '../../src/services/health.js';
import * as exportService from '../../src/services/exportService.js';
import * as migrationService from '../../src/services/migrationService.js';
import * as updateService from '../../src/services/update.js';
import { createBackup } from '../../src/db/connection.js';
import { secretPath } from '../../src/services/secretStore.js';
import ExcelJS from 'exceljs';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let db: WorkbenchDb;

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function unsafeZip(): Buffer {
  const name = Buffer.from('../../evil.txt');
  const data = Buffer.from('x');
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

function testConfig(): ReturnType<typeof loadConfig> {
  const previous = { ...process.env };
  process.env.WORKBENCH_DATA_DIR = tempDir;
  process.env.WORKBENCH_STATIC_DIR = path.join(SERVER_ROOT, 'tests', 'fixtures', 'static');
  process.env.WORKBENCH_VERSION = '9.8.7';
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  const config = loadConfig();
  process.env = previous;
  return config;
}

function seed(): void {
  const conn = db.connInstance;
  for (let index = 1; index <= 3; index += 1) {
    conn.prepare('INSERT INTO students(学号, 姓名, 性别) VALUES(?,?,?)')
      .run(`S${String(index).padStart(3, '0')}`, `运维学生${index}`, index % 2 ? '男' : '女');
  }
  conn.prepare(
    `INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status)
     SELECT id, 1, 1, '在读' FROM students`,
  ).run();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig09-'));
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
  setDbSingleton(db);
  seed();
});

afterEach(() => {
  db.close();
  setDatabase(null);
  setDbSingleton(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('报告与档案', () => {
  it('周报生成包含指标与来源追溯', () => {
    const report = reports.buildReport('weekly', {
      periodStart: '2026-04-06', periodEnd: '2026-04-12',
    }) as Record<string, unknown>;
    const payload = report.payload ?? report;
    const metrics = (payload as Record<string, unknown>).metrics as Record<string, unknown>;
    expect(metrics.student_count).toBe(3);
    expect((payload as Record<string, unknown>).sections).toBeTruthy();
    expect((payload as Record<string, unknown>).data_notes).toBeTruthy();
  });

  it('档案创建/列表/读取/导出', async () => {
    const created = reports.createArchive('weekly', {
      periodStart: '2026-04-06', periodEnd: '2026-04-12',
      classSummary: '本周整体稳定',
    }) as Record<string, unknown>;
    expect(created.id).toBeGreaterThan(0);
    const archives = reports.listArchives('weekly');
    expect(archives).toHaveLength(1);
    const archive = reports.getArchive(Number(created.id));
    expect((archive.payload as Record<string, unknown>).manual).toBeTruthy();
    const exported = await reports.exportArchive(Number(created.id));
    expect(exported.buffer.length).toBeGreaterThan(100);
  });
});

describe('健康', () => {
  it('目标/提醒/复盘/汇总', () => {
    health.createGoal({ metric: '体重', targetValue: 60, unit: 'kg' });
    expect(() => health.createGoal({ metric: '体重', targetValue: 58, unit: 'kg' }))
      .toThrow(/已存在/);
    health.saveReminder({ reminderType: 'sleep', enabled: true, remindTime: '22:30' });
    const summary = health.summary('month') as Record<string, unknown>;
    expect(summary.goals).toHaveLength(1);
    health.saveReview({
      periodType: 'month', periodStart: '2026-04-01', periodEnd: '2026-04-30',
      summaryText: '本月保持', metrics: {},
    });
    expect(health.listReviews()).toHaveLength(1);
  });

  it('汇总导出为多 sheet 工作簿', async () => {
    const result = await health.exportSummary('month');
    expect(result.filename).toContain('.xlsx');
    expect(result.buffer.length).toBeGreaterThan(500);
  });
});

describe('Excel 导出', () => {
  it('通用表/成绩/考勤导出可被 ExcelJS 解析', async () => {
    const sheet = await exportService.exportSheet('班主任日志');
    expect(sheet.buffer.length).toBeGreaterThan(100);
    const attendance = await exportService.exportAttendanceReport('2026-04-01', '2026-04-30');
    expect(attendance.buffer.length).toBeGreaterThan(100);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(sheet.buffer);
    expect(workbook.worksheets.map((worksheet) => worksheet.name)).toContain('班主任日志');
  });
});

describe('备份与恢复', () => {
  it('创建备份→修改→恢复', async () => {
    const filename = await db.createBackup('manual');
    const backupPath = path.join(db.backupDir(), filename);
    expect(fs.existsSync(backupPath)).toBe(true);

    db.connInstance.prepare('DELETE FROM students').run();
    expect((db.connInstance.prepare('SELECT COUNT(*) AS c FROM students').get() as { c: number }).c).toBe(0);

    db.close();
    fs.copyFileSync(backupPath, db.paths.dbPath);
    db.open();
    expect((db.connInstance.prepare('SELECT COUNT(*) AS c FROM students').get() as { c: number }).c).toBe(3);
  });

  it('备份列表与下载', async () => {
    await db.createBackup('manual');
    const { db: dbModule } = await import('../../src/db/index.js');
    void dbModule;
    const backupsDir = db.backupDir();
    const files = fs.readdirSync(backupsDir).filter((name) => name.endsWith('.db'));
    expect(files.length).toBe(1);
  });
});

describe('迁移包', () => {
  it('导出→恢复往返', async () => {
    const conn = db.connInstance;
    conn.prepare("INSERT INTO sheet_meta(sheet, headers) VALUES('班主任日志','[]')").run();
    const packageName = await migrationService.createPackage();
    const packagePath = path.join(db.backupDir(), packageName);
    expect(fs.existsSync(packagePath)).toBe(true);

    // 破坏数据后恢复
    conn.prepare('DELETE FROM students').run();
    conn.prepare('DELETE FROM sheet_meta').run();
    const data = fs.readFileSync(packagePath);
    const result = await migrationService.restorePackage(data);
    expect((result as Record<string, unknown>).ok).toBe(true);
    expect((db.connInstance.prepare('SELECT COUNT(*) AS c FROM students').get() as { c: number }).c).toBe(3);
  });

  it('拒绝不安全路径的迁移包', async () => {
    await expect(migrationService.restorePackage(unsafeZip()))
      .rejects.toThrow(/不安全|不合法|缺少/);
  });
});

describe('更新状态机', () => {
  it('github-token 保存与校验', () => {
    updateService.saveGithubToken('ghp_testtoken1234567890');
    expect(updateService.githubTokenConfigured()).toBe(true);
    expect(db.connInstance.prepare(
      "SELECT value FROM agent_settings WHERE key='github_token'",
    ).get()).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(secretPath('github-token.json'), 'utf8')).token)
      .toBe('ghp_testtoken1234567890');
    expect(() => updateService.saveGithubToken('bad')).toThrow(/Token 格式/);
    expect(() => updateService.saveGithubToken('')).toThrow(/不能为空/);
  });

  it('installer-path 未就绪时拒绝', () => {
    expect(() => updateService.installerPath(db)).toThrow(/没有待安装/);
  });
});

describe('更新源（Gitee 优先 / GitHub 回退）', () => {
  const INSTALLER_NAMES = [
    'MeimeiWorkbench-Setup-Windows-x64.exe',
    'MeimeiWorkbench-macOS-arm64.dmg',
    'MeimeiWorkbench-macOS-x64.dmg',
  ];
  const installerBytes = Buffer.from('fake-installer-bytes-v9.9.9');
  const installerSha = createHash('sha256').update(installerBytes).digest('hex');
  const previousEnv = { ...process.env };
  let server: http.Server;
  let base = '';
  let failGiteeDownloads = false;

  function expectedMarker(): string {
    if (process.platform === 'win32') return 'MeimeiWorkbench-Setup-Windows-x64.exe';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return `MeimeiWorkbench-macOS-${arch}.dmg`;
  }

  function withEnv(patch: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  async function waitFinished(timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = updateService.updateStatus().status;
      if (['ready_to_install', 'up_to_date', 'error'].includes(status)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const state = updateService.updateStatus();
    throw new Error(`更新状态未结束：${state.status} / ${state.error}`);
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '';
      const send = (body: string): void => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(body);
      };
      if (url.startsWith('/api/v5/repos/test/workbench/releases/latest')) {
        send(JSON.stringify({
          id: 1, tag_name: 'v9.9.9', prerelease: false,
          assets: [
            { name: 'update-manifest.json', browser_download_url: `${base}/gitee/manifest.json` },
            { name: 'v9.9.9.zip' },
          ],
        }));
        return;
      }
      if (url === '/gitee/manifest.json') {
        send(JSON.stringify({
          tag_name: 'v9.9.9',
          html_url: 'https://gitee.com/test/workbench/releases/tag/v9.9.9',
          release_notes: 'Gitee 测试发布',
          assets: INSTALLER_NAMES.map((name) => ({
            name,
            browser_download_url: `${base}/gitee/file/${name}`,
            size: installerBytes.length,
            sha256: installerSha,
          })),
        }));
        return;
      }
      if (url.startsWith('/gitee/file/')) {
        if (failGiteeDownloads) {
          res.statusCode = 404;
          send(JSON.stringify({ message: 'Not Found' }));
        } else {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(installerBytes);
        }
        return;
      }
      if (url === '/api/github/latest') {
        send(JSON.stringify({
          tag_name: 'v9.9.9',
          html_url: 'https://github.com/test/workbench/releases/tag/v9.9.9',
          body: 'GitHub 测试发布',
          assets: [
            ...INSTALLER_NAMES.map((name, index) => ({
              id: index + 1, name, url: `${base}/github/file/${name}`, size: installerBytes.length,
            })),
            { id: 99, name: 'SHA256SUMS.txt', url: `${base}/github/file/SHA256SUMS.txt` },
          ],
        }));
        return;
      }
      if (url === '/github/file/SHA256SUMS.txt') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(INSTALLER_NAMES.map((name) => `${installerSha}  ${name}`).join('\n'));
        return;
      }
      if (url.startsWith('/github/file/')) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(installerBytes);
        return;
      }
      res.statusCode = 404;
      send(JSON.stringify({ message: 'Not Found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  afterEach(() => {
    process.env = { ...previousEnv };
    failGiteeDownloads = false;
  });

  it('Gitee 源优先：GitHub 不可达时采用 Gitee 清单与校验和', async () => {
    withEnv({
      WORKBENCH_VERSION: '9.8.7',
      WORKBENCH_UPDATE_GITEE_REPO: 'test/workbench',
      WORKBENCH_UPDATE_GITEE_API: `${base}/api/v5`,
      WORKBENCH_UPDATE_URL: 'http://127.0.0.1:1/api/github/latest',
      WORKBENCH_UPDATE_MANIFEST_URL: 'http://127.0.0.1:1/api/github/manifest',
    });
    const result = await updateService.checkForUpdate();
    expect(result.source).toBe('gitee');
    expect(result.latest_version).toBe('9.9.9');
    expect(result.update_available).toBe(true);
    expect(result.downloadable).toBe(true);
    expect(result.release_url).toBe('https://gitee.com/test/workbench/releases/tag/v9.9.9');
    expect(result.asset.name).toBe(expectedMarker());
    expect(result.asset.sha256).toBe(installerSha);
  });

  it('Gitee 不可达时回退 GitHub 源', async () => {
    withEnv({
      WORKBENCH_VERSION: '9.8.7',
      WORKBENCH_UPDATE_GITEE_REPO: 'test/workbench',
      WORKBENCH_UPDATE_GITEE_API: 'http://127.0.0.1:1/api/v5',
      WORKBENCH_UPDATE_URL: `${base}/api/github/latest`,
      WORKBENCH_UPDATE_MANIFEST_URL: `${base}/api/github/manifest`,
    });
    const result = await updateService.checkForUpdate();
    expect(result.source).toBe('github');
    expect(result.update_available).toBe(true);
    expect(result.asset.sha256).toBe(installerSha);
    expect(result.release_url).toBe('https://github.com/test/workbench/releases/tag/v9.9.9');
  });

  it('全部源失败时抛出聚合错误', async () => {
    withEnv({
      WORKBENCH_UPDATE_GITEE_API: 'http://127.0.0.1:1/api/v5',
      WORKBENCH_UPDATE_URL: 'http://127.0.0.1:1/api/github/latest',
      WORKBENCH_UPDATE_MANIFEST_URL: 'http://127.0.0.1:1/api/github/manifest',
    });
    await expect(updateService.checkForUpdate()).rejects.toThrow(/所有更新源均不可用/);
  });

  it('下载失败时自动切换备用源并完成校验', async () => {
    withEnv({
      WORKBENCH_VERSION: '9.8.7',
      WORKBENCH_UPDATE_GITEE_REPO: 'test/workbench',
      WORKBENCH_UPDATE_GITEE_API: `${base}/api/v5`,
      WORKBENCH_UPDATE_URL: `${base}/api/github/latest`,
      WORKBENCH_UPDATE_MANIFEST_URL: `${base}/api/github/manifest`,
    });
    failGiteeDownloads = true;
    updateService.startUpdateWorker(db);
    await waitFinished();
    expect(updateService.updateStatus().status).toBe('ready_to_install');
    const info = updateService.installerPath(db);
    expect(path.basename(info.path)).toBe(expectedMarker());
    expect(fs.readFileSync(info.path)).toEqual(installerBytes);
  });

  it('Token 校验同时接受 GitHub 与 Gitee 格式', () => {
    updateService.saveGithubToken('ghp_testtoken1234567890');
    updateService.saveGithubToken('a'.repeat(40));
    expect(updateService.githubTokenConfigured()).toBe(true);
    expect(() => updateService.saveGithubToken('bad')).toThrow(/Token 格式/);
  });
});

describe('HTTP 冒烟', () => {
  it('迁移包只能在工作台本机管理', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: '/api/system/migration/export', remoteAddress: '192.168.31.99',
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('报告/健康/导出/备份/迁移/更新端点连通', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();

    const preview = await app.inject({
      method: 'POST', url: '/api/reports/preview',
      payload: { report_type: 'weekly', period_start: '2026-04-06', period_end: '2026-04-12' },
    });
    expect(preview.statusCode).toBe(200);

    const archive = await app.inject({
      method: 'POST', url: '/api/reports/archives',
      payload: { report_type: 'weekly', period_start: '2026-04-06', period_end: '2026-04-12' },
    });
    expect(archive.statusCode).toBe(200);

    const goal = await app.inject({
      method: 'POST', url: '/api/health/goals',
      payload: { metric: '睡眠', target_value: 8, unit: '小时' },
    });
    expect(goal.statusCode).toBe(200);

    const exportRes = await app.inject({ method: 'GET', url: '/api/export/sheet/班主任日志' });
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.headers['content-type']).toContain('spreadsheetml');

    const backup = await app.inject({ method: 'POST', url: '/api/system/backup' });
    expect(backup.statusCode).toBe(200);
    const backups = await app.inject({ method: 'GET', url: '/api/system/backups' });
    expect(backups.statusCode).toBe(200);

    const migration = await app.inject({ method: 'POST', url: '/api/system/migration/export' });
    expect(migration.statusCode).toBe(200);

    const tokenStatus = await app.inject({ method: 'GET', url: '/api/system/update/github-token' });
    expect(tokenStatus.statusCode).toBe(200);

    const tokenSave = await app.inject({
      method: 'PUT', url: '/api/system/update/github-token',
      payload: { token: 'ghp_httptesttoken1234567890' },
    });
    expect(tokenSave.statusCode).toBe(200);

    const install = await app.inject({ method: 'POST', url: '/api/system/update/install' });
    expect(install.statusCode).toBe(400); // 开发模式拒绝

    const aiStub = await app.inject({
      method: 'POST', url: '/api/reports/ai/preview',
      payload: { instruction: '总结' },
    });
    expect(aiStub.statusCode).toBe(400); // 未配置模型 → 明确错误提示
    expect(aiStub.json().detail).toContain('模型');
    await app.close();
  });
});
