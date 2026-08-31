import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';
import { setDb as setDbSingleton } from '../../src/db/index.js';
import * as updateService from '../../src/services/update.js';

const previousEnv = { ...process.env };
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');

let tempDir = '';
let db: WorkbenchDb;
let server: http.Server;
let base = '';
let requests = 0;
let rangeRequests = 0;
let failFirstDownload = false;

const installerName = 'MeimeiWorkbench-macOS-arm64.dmg';
const installerBytes = Buffer.alloc(256 * 1024, 7);
const installerSha = createHash('sha256').update(installerBytes).digest('hex');

function manifest(downloadUrls: string[]): Record<string, unknown> {
  return {
    tag_name: 'v9.9.9',
    html_url: `${base}/release`,
    release_notes: 'resumable updater test',
    assets: [{
      name: installerName,
      browser_download_url: downloadUrls[0],
      urls: downloadUrls,
      size: installerBytes.length,
      sha256: installerSha,
    }],
  };
}

async function waitFinished(timeoutMs = 12_000): Promise<ReturnType<typeof updateService.updateStatus>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = updateService.updateStatus(db);
    if (['ready_to_install', 'up_to_date', 'error'].includes(state.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`updater timeout: ${JSON.stringify(updateService.updateStatus(db))}`);
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-resilience-'));
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
  setDbSingleton(db);
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
  requests = 0;
  rangeRequests = 0;
  failFirstDownload = false;

  server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url === '/manifest') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(manifest([`${base}/installer`])));
      return;
    }
    if (url === '/broken-manifest') {
      res.statusCode = 503;
      res.end('unavailable');
      return;
    }
    if (url === '/installer') {
      requests += 1;
      const range = String(req.headers.range || '');
      let start = 0;
      const match = range.match(/^bytes=(\d+)-$/);
      if (match) {
        start = Number(match[1]);
        rangeRequests += 1;
      }
      if (start > 0) {
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${installerBytes.length - 1}/${installerBytes.length}`);
      }
      const payload = installerBytes.subarray(start);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', payload.length);
      if (failFirstDownload && requests === 1 && start === 0) {
        const midpoint = Math.floor(payload.length / 2);
        res.write(payload.subarray(0, midpoint));
        setTimeout(() => res.destroy(), 5);
        return;
      }
      res.end(payload);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.WORKBENCH_VERSION = '9.8.7';
  process.env.WORKBENCH_UPDATE_URL = 'http://127.0.0.1:1/github-disabled';
  process.env.WORKBENCH_UPDATE_MANIFEST_URL = 'http://127.0.0.1:1/github-manifest-disabled';
  process.env.WORKBENCH_UPDATE_MIRROR_MANIFEST_URL = `${base}/manifest`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
  setDatabase(null);
  setDbSingleton(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.env = { ...previousEnv };
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalArch) Object.defineProperty(process, 'arch', originalArch);
});

describe('resumable updater', () => {
  it('prefers an independent mirror manifest when GitHub is unavailable', async () => {
    const result = await updateService.checkForUpdate();
    expect(result.source).toContain('mirror-1');
    expect(result.update_available).toBe(true);
    expect(result.asset.sha256).toBe(installerSha);
  });

  it('keeps a partial file and resumes with HTTP Range after the connection breaks', async () => {
    failFirstDownload = true;
    updateService.startUpdateWorker(db);
    const state = await waitFinished();
    expect(state.status).toBe('ready_to_install');
    expect(state.retry_count).toBeGreaterThan(0);
    expect(rangeRequests).toBeGreaterThan(0);
    const info = updateService.installerPath(db);
    expect(fs.readFileSync(info.path)).toEqual(installerBytes);
    expect(fs.existsSync(`${info.path}.part`)).toBe(false);
  });

  it('persists ready_to_install metadata next to the cached installer', async () => {
    updateService.startUpdateWorker(db);
    const state = await waitFinished();
    expect(state.status).toBe('ready_to_install');
    const stateFile = path.join(tempDir, 'updates', 'update-state.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(persisted.status).toBe('ready_to_install');
    expect(persisted.verified).toBe(true);
    expect(persisted.progress).toBe(100);
  });

  it('does not depend on a second SHA-256 download pass and exposes progress fields', async () => {
    updateService.startUpdateWorker(db);
    const state = await waitFinished();
    expect(state.total_bytes).toBe(installerBytes.length);
    expect(state.downloaded_bytes).toBe(installerBytes.length);
    expect(state.progress).toBe(100);
    expect(state.error).toBe('');
  });
});
