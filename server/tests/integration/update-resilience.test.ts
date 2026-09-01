import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { WorkbenchDb } from '../../src/db/connection.js';
import * as updateService from '../../src/services/update.js';

const ASSET_NAME = 'MeimeiWorkbench-macOS-arm64.dmg';
const INSTALLER = Buffer.alloc(64 * 1024, 7);
const SHA256 = createHash('sha256').update(INSTALLER).digest('hex');

let server: http.Server;
let base = '';
let tempDir = '';
let db: WorkbenchDb;
let mirrorStatus = 200;
let githubHits = 0;
let cosDownloads = 0;
let githubRanges: string[] = [];
let mirrorAssetUrls: string[] | null = null;
let mirrorSha256 = SHA256;
let mirrorVersion = '9.9.9';
const previousEnv = { ...process.env };
let platformDescriptor: PropertyDescriptor | undefined;
let archDescriptor: PropertyDescriptor | undefined;
let hostPlatform = process.platform;
let hostArch = process.arch;

function manifest(urls = mirrorAssetUrls ?? [`${base}/cos/file/${ASSET_NAME}`, `${base}/github/file/${ASSET_NAME}`]): string {
  return JSON.stringify({
    tag_name: `v${mirrorVersion}`,
    release_notes: '更新测试',
    html_url: 'https://github.com/test/workbench/releases/tag/v9.9.9',
    assets: [{ name: ASSET_NAME, size: INSTALLER.length, sha256: mirrorSha256, urls }],
  });
}

function sendJson(response: http.ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(body);
}

function sendFile(request: http.IncomingMessage, response: http.ServerResponse, source: 'cos' | 'github'): void {
  if (source === 'cos') {
    cosDownloads += 1;
    if (cosDownloads === 1) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', INSTALLER.length);
      response.write(INSTALLER.subarray(0, INSTALLER.length / 2));
      setTimeout(() => response.destroy(), 10);
      return;
    }
    response.statusCode = 503;
    response.end('temporary cos failure');
    return;
  }

  githubRanges.push(String(request.headers.range ?? ''));
  const match = /^bytes=(\d+)-$/.exec(String(request.headers.range ?? ''));
  const start = match ? Number(match[1]) : 0;
  response.statusCode = match ? 206 : 200;
  response.setHeader('Content-Type', 'application/octet-stream');
  response.setHeader('Content-Length', INSTALLER.length - start);
  if (match) response.setHeader('Content-Range', `bytes ${start}-${INSTALLER.length - 1}/${INSTALLER.length}`);
  response.end(INSTALLER.subarray(start));
}

beforeAll(async () => {
  hostPlatform = process.platform;
  hostArch = process.arch;
  platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
  server = http.createServer((request, response) => {
    const url = request.url ?? '';
    if (url === '/cos/manifest') {
      sendJson(response, mirrorStatus, manifest());
      return;
    }
    if (url === '/github/latest') {
      githubHits += 1;
      sendJson(response, 200, JSON.stringify({
        tag_name: 'v9.9.9',
        assets: [{ name: ASSET_NAME, size: INSTALLER.length, sha256: SHA256, url: `${base}/github/file/${ASSET_NAME}` }],
      }));
      return;
    }
    if (url.startsWith('/cos/file/')) {
      sendFile(request, response, 'cos');
      return;
    }
    if (url.startsWith('/github/file/')) {
      sendFile(request, response, 'github');
      return;
    }
    sendJson(response, 404, JSON.stringify({ message: 'Not Found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-resilience-'));
  // 先用宿主平台加载 better-sqlite3，再模拟 darwin/arm64 选择安装包。
  // 否则 Linux CI 会尝试加载 macOS 原生扩展。
  Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: hostArch, configurable: true });
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
  mirrorStatus = 200;
  githubHits = 0;
  cosDownloads = 0;
  githubRanges = [];
  mirrorAssetUrls = null;
  mirrorSha256 = SHA256;
  mirrorVersion = '9.9.9';
  process.env.WORKBENCH_VERSION = '9.8.7';
  delete process.env.WORKBENCH_UPDATE_MIRROR_MANIFEST_URLS;
  delete process.env.WORKBENCH_UPDATE_MANIFEST_URL;
  process.env.WORKBENCH_UPDATE_MIRROR_MANIFEST_URL = `${base}/cos/manifest`;
  process.env.WORKBENCH_UPDATE_URL = `${base}/github/latest`;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.env = { ...previousEnv };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
  if (archDescriptor) Object.defineProperty(process, 'arch', archDescriptor);
});

async function waitFinished(timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = updateService.updateStatus();
    if (['ready_to_install', 'error', 'up_to_date'].includes(status.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`更新状态未结束：${JSON.stringify(updateService.updateStatus())}`);
}

function writeReadyState(version: string): string {
  const updatesDir = path.join(tempDir, 'updates');
  const installerPath = path.join(updatesDir, ASSET_NAME);
  fs.mkdirSync(updatesDir, { recursive: true });
  fs.writeFileSync(installerPath, INSTALLER);
  fs.writeFileSync(`${installerPath}.part`, INSTALLER);
  fs.writeFileSync(path.join(updatesDir, 'update-state.json'), JSON.stringify({
    status: 'ready_to_install', message: '校验通过', error: '', asset_name: ASSET_NAME,
    version, source: 'cos.ap-chengdu.myqcloud.com', sha256: SHA256,
    total_bytes: INSTALLER.length, downloaded_bytes: INSTALLER.length, progress: 100,
    retry_count: 0, backup_created: true, verified: true,
  }));
  return installerPath;
}

describe('更新源与断点恢复', () => {
  it('COS manifest 成功时不请求 GitHub', async () => {
    const result = await updateService.checkForUpdate();
    expect(result.source).toBe('cos');
    expect(result.asset.urls[0]).toContain('/cos/file/');
    expect(githubHits).toBe(0);
  });

  it('同版本或旧版本不标记为可更新', async () => {
    mirrorVersion = '9.8.7';
    expect((await updateService.checkForUpdate()).update_available).toBe(false);
    mirrorVersion = '9.8.6';
    expect((await updateService.checkForUpdate()).update_available).toBe(false);
  });

  it('COS manifest 失败时回退 GitHub', async () => {
    mirrorStatus = 503;
    const result = await updateService.checkForUpdate();
    expect(result.source).toBe('github');
    expect(result.downloadable).toBe(true);
    expect(githubHits).toBe(1);
  });

  it('COS 中断后切换 GitHub，并从同一个 Range 断点继续', async () => {
    updateService.startUpdateWorker(db);
    await waitFinished();
    expect(updateService.updateStatus().status).toBe('ready_to_install');
    expect(githubRanges).toContain(`bytes=${INSTALLER.length / 2}-`);
    const installed = updateService.installerPath(db);
    expect(fs.readFileSync(installed.path)).toEqual(INSTALLER);
    expect(fs.existsSync(`${installed.path}.part`)).toBe(false);
  });

  it('重启后把持久化的 downloading 状态恢复为 paused', () => {
    const updatesDir = path.join(tempDir, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'update-state.json'), JSON.stringify({
      status: 'downloading', message: '正在下载更新…', error: '', asset_name: ASSET_NAME,
      version: '9.9.9', source: 'cos.ap-chengdu.myqcloud.com', sha256: SHA256,
      total_bytes: INSTALLER.length, downloaded_bytes: 1234, progress: 1.88,
      retry_count: 1, backup_created: true, verified: false,
    }));
    const state = updateService.updateStatus(db);
    expect(state).toMatchObject({
      status: 'paused', downloaded_bytes: 1234, asset_name: ASSET_NAME, backup_created: true,
    });
  });

  it.each([
    ['same version', '9.8.7'],
    ['older version', '9.8.6'],
  ])('已安装版本为 %s 时清理过期更新状态和安装包', (_label, version) => {
    const installerPath = writeReadyState(version);
    const backupPath = path.join(db.backupDir(), 'keep-me.db');
    fs.mkdirSync(db.backupDir(), { recursive: true });
    fs.writeFileSync(backupPath, 'backup');

    expect(updateService.updateStatus(db).status).toBe('idle');
    expect(fs.existsSync(installerPath)).toBe(false);
    expect(fs.existsSync(`${installerPath}.part`)).toBe(false);
    expect(fs.existsSync(backupPath)).toBe(true);
  });

  it('新版本 ready_to_install 状态保留，安装包仍可用', () => {
    const installerPath = writeReadyState('9.8.8');

    expect(updateService.updateStatus(db).status).toBe('ready_to_install');
    expect(fs.existsSync(installerPath)).toBe(true);
    expect(fs.existsSync(`${installerPath}.part`)).toBe(true);
  });

  it('installer-path 拒绝同版本或旧版本安装包', () => {
    const installerPath = writeReadyState('9.8.7');

    expect(() => updateService.installerPath(db)).toThrow(/没有待安装|不高于/);
    expect(fs.existsSync(installerPath)).toBe(false);
  });

  it('完整 .part 只做本地 SHA-256 校验，不再请求网络', async () => {
    const updatesDir = path.join(tempDir, 'updates');
    const installerPath = path.join(updatesDir, ASSET_NAME);
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(`${installerPath}.part`, INSTALLER);
    fs.writeFileSync(path.join(updatesDir, 'update-state.json'), JSON.stringify({
      status: 'paused', message: '可继续下载', error: '', asset_name: ASSET_NAME,
      version: '9.9.9', source: 'cos.ap-chengdu.myqcloud.com', sha256: SHA256,
      total_bytes: INSTALLER.length, downloaded_bytes: INSTALLER.length, progress: 100,
      retry_count: 0, backup_created: true, verified: false,
    }));
    updateService.startUpdateWorker(db);
    await waitFinished();
    expect(updateService.updateStatus().status).toBe('ready_to_install');
    expect(cosDownloads).toBe(0);
    expect(fs.readFileSync(updateService.installerPath(db).path)).toEqual(INSTALLER);
  });

  it('SHA-256 错误时删除 .part 并拒绝安装', async () => {
    mirrorAssetUrls = [`${base}/github/file/${ASSET_NAME}`];
    mirrorSha256 = '0'.repeat(64);
    updateService.startUpdateWorker(db);
    await waitFinished();
    expect(updateService.updateStatus().status).toBe('error');
    expect(updateService.updateStatus().verified).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'updates', `${ASSET_NAME}.part`))).toBe(false);
    expect(() => updateService.installerPath(db)).toThrow(/没有待安装|完整性校验/);
  });
});
