/* MIG-09 更新检查与安装包下载校验。
 *
 * 设计目标：网络不稳定时允许恢复，而不是每次失败都从零开始。
 * - 元数据支持可配置镜像清单 + GitHub Release 回退；
 * - 同一版本/同一 SHA-256 的多个下载 URL 可自动切换；
 * - 安装包使用 .part 文件断点续传，失败后保留已下载内容；
 * - 单源有限重试 + 指数退避；
 * - 下载进度、速度、重试次数与 ready_to_install 状态持久化；
 * - 已完成且校验通过的安装包可在进程重启后继续安装。
 *
 * 安装所有权仍归 Electron 桌面壳：本服务只负责检查、备份、下载与 SHA-256 校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { loadAppVersion, APP_NAME } from '../config/index.js';
import { WorkbenchDb } from '../db/connection.js';

const GITHUB_REPO = 'kaikaiyang117/zhihui-banji';
const CHECK_TIMEOUT_MS = 10_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const STATE_FILENAME = 'update-state.json';

export interface UpdateAsset {
  name: string;
  url: string;
  urls: string[];
  size: number;
  sha256: string;
}

export interface UpdateSourceInfo {
  source: string;
  version: string;
  release_url: string;
  release_notes: string;
  asset: UpdateAsset;
}

export interface UpdateState {
  status: string;
  message: string;
  error: string;
  asset_name: string;
  version: string;
  source: string;
  sha256: string;
  total_bytes: number;
  downloaded_bytes: number;
  progress: number;
  speed_bytes_per_second: number;
  retry_count: number;
  backup_created: boolean;
  verified: boolean;
  updated_at: string;
}

export interface UpdateCheckResult extends Omit<UpdateSourceInfo, 'version'> {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  downloadable: boolean;
  error?: string;
}

const EMPTY_STATE: UpdateState = {
  status: 'idle', message: '', error: '', asset_name: '', version: '', source: '', sha256: '',
  total_bytes: 0, downloaded_bytes: 0, progress: 0, speed_bytes_per_second: 0,
  retry_count: 0, backup_created: false, verified: false, updated_at: '',
};

let updateState: UpdateState = { ...EMPTY_STATE };
let updateRunning = false;
let hydratedDataDir = '';
let progressPersistAt = 0;

function githubApiUrl(): string {
  return process.env.WORKBENCH_UPDATE_URL
    ?? `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
}

function githubManifestUrl(): string {
  return process.env.WORKBENCH_UPDATE_MANIFEST_URL
    ?? `https://github.com/${GITHUB_REPO}/releases/latest/download/update-manifest.json`;
}

function mirrorManifestUrls(): string[] {
  const raw = process.env.WORKBENCH_UPDATE_MIRROR_MANIFEST_URLS
    ?? process.env.WORKBENCH_UPDATE_MIRROR_MANIFEST_URL
    ?? '';
  return raw.split(/[;,\n]/).map(item => item.trim()).filter(Boolean);
}

function updateDir(db: WorkbenchDb): string {
  return path.join(db.paths.dataDir, 'updates');
}

function statePath(db: WorkbenchDb): string {
  return path.join(updateDir(db), STATE_FILENAME);
}

function partPath(installerPath: string): string {
  return `${installerPath}.part`;
}

function safeNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeState(value: unknown): UpdateState {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    ...EMPTY_STATE,
    status: String(row.status ?? 'idle'),
    message: String(row.message ?? ''),
    error: String(row.error ?? ''),
    asset_name: path.basename(String(row.asset_name ?? '')),
    version: String(row.version ?? ''),
    source: String(row.source ?? ''),
    sha256: String(row.sha256 ?? '').toLowerCase(),
    total_bytes: safeNumber(row.total_bytes),
    downloaded_bytes: safeNumber(row.downloaded_bytes),
    progress: Math.max(0, Math.min(100, safeNumber(row.progress))),
    speed_bytes_per_second: safeNumber(row.speed_bytes_per_second),
    retry_count: Math.trunc(safeNumber(row.retry_count)),
    backup_created: Boolean(row.backup_created),
    verified: Boolean(row.verified),
    updated_at: String(row.updated_at ?? ''),
  };
}

function persistState(db: WorkbenchDb, force = false): void {
  const now = Date.now();
  if (!force && now - progressPersistAt < 500) return;
  progressPersistAt = now;
  const dir = updateDir(db);
  fs.mkdirSync(dir, { recursive: true });
  const target = statePath(db);
  const temporary = `${target}.tmp`;
  updateState.updated_at = new Date().toISOString();
  fs.writeFileSync(temporary, `${JSON.stringify(updateState, null, 2)}\n`, 'utf-8');
  fs.renameSync(temporary, target);
}

function hydrateState(db: WorkbenchDb): void {
  if (hydratedDataDir === db.paths.dataDir) return;
  hydratedDataDir = db.paths.dataDir;
  const target = statePath(db);
  if (!fs.existsSync(target)) {
    updateState = { ...EMPTY_STATE };
    return;
  }
  try {
    updateState = normalizeState(JSON.parse(fs.readFileSync(target, 'utf-8')));
    if (updateState.asset_name) {
      const installer = path.join(updateDir(db), path.basename(updateState.asset_name));
      const partial = partPath(installer);
      if (updateState.status === 'ready_to_install') {
        if (!updateState.verified || !fs.existsSync(installer)) {
          updateState = {
            ...updateState,
            status: 'idle', message: '', error: '', verified: false,
            downloaded_bytes: fs.existsSync(partial) ? fs.statSync(partial).size : 0,
          };
        } else if (updateState.total_bytes > 0 && fs.statSync(installer).size !== updateState.total_bytes) {
          fs.rmSync(installer, { force: true });
          updateState = { ...updateState, status: 'idle', verified: false, downloaded_bytes: 0, progress: 0 };
        }
      } else if (fs.existsSync(partial)) {
        updateState.downloaded_bytes = fs.statSync(partial).size;
        updateState.progress = updateState.total_bytes > 0
          ? Math.min(100, (updateState.downloaded_bytes / updateState.total_bytes) * 100) : 0;
        if (['checking', 'backing_up', 'downloading', 'verifying', 'starting'].includes(updateState.status)) {
          updateState.status = 'paused';
          updateState.message = '上次更新未完成，可继续下载';
          updateState.error = '';
        }
      }
    }
  } catch {
    updateState = { ...EMPTY_STATE };
  }
  persistState(db, true);
}

function patchState(db: WorkbenchDb, patch: Partial<UpdateState>, force = true): void {
  updateState = normalizeState({ ...updateState, ...patch });
  persistState(db, force);
}

async function fetchJson(url: string, options: { accept?: string } = {}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Accept: options.accept ?? 'application/json',
    'User-Agent': `${APP_NAME}-Updater`,
  };
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

function versionKey(version: string): number[] {
  const numbers = (version.match(/\d+/g) ?? []).map(Number);
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
}

function compareVersion(a: string, b: string): number {
  const left = versionKey(a);
  const right = versionKey(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function platformAsset(assets: Array<Record<string, unknown>>): Record<string, unknown> | null {
  let marker = '';
  if (process.platform === 'win32') marker = 'Setup-Windows-x64.exe';
  else if (process.platform === 'darwin') {
    if (process.arch !== 'arm64') return null;
    marker = 'macOS-arm64.dmg';
  } else return null;
  return assets.find(asset => String(asset.name ?? '').endsWith(marker)) ?? null;
}

function checksumFor(checksumText: string, filename: string): string {
  for (const line of checksumText.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 2 && path.basename(fields[fields.length - 1].replace(/^\*/, '')) === filename) {
      return fields[0].toLowerCase();
    }
  }
  return '';
}

function uniqueUrls(values: unknown[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const url = String(value ?? '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    output.push(url);
  }
  return output;
}

function assetUrls(asset: Record<string, unknown> | null): string[] {
  if (!asset) return [];
  const arrayUrls = Array.isArray(asset.urls) ? asset.urls : [];
  const mirrors = Array.isArray(asset.mirrors) ? asset.mirrors : [];
  return uniqueUrls([
    ...arrayUrls,
    ...mirrors,
    asset.browser_download_url,
    asset.download_url,
    asset.url,
  ]);
}

function sourceInfoFromManifest(manifest: Record<string, unknown>, source: string): UpdateSourceInfo {
  const version = String(manifest.tag_name ?? manifest.version ?? '').replace(/^v/, '');
  const assets = (manifest.assets ?? []) as Array<Record<string, unknown>>;
  const asset = platformAsset(assets);
  const urls = assetUrls(asset);
  return {
    source,
    version,
    release_url: String(manifest.html_url ?? manifest.release_url ?? ''),
    release_notes: String(manifest.release_notes ?? manifest.body ?? ''),
    asset: {
      name: String(asset?.name ?? ''),
      url: urls[0] ?? '',
      urls,
      size: safeNumber(asset?.size),
      sha256: String(asset?.sha256 ?? '').toLowerCase(),
    },
  };
}

async function checkManifestSource(url: string, source: string): Promise<UpdateSourceInfo> {
  return sourceInfoFromManifest(await fetchJson(url), source);
}

/** GitHub Release API 优先；API 不可用时退回 release 中的 update-manifest.json。 */
async function checkGitHubSource(): Promise<UpdateSourceInfo> {
  let release: Record<string, unknown>;
  try {
    release = await fetchJson(githubApiUrl(), { accept: 'application/vnd.github+json' });
  } catch (primaryError) {
    try {
      return await checkManifestSource(githubManifestUrl(), 'github');
    } catch {
      throw primaryError;
    }
  }
  const version = String(release.tag_name ?? '').replace(/^v/, '');
  const assets = (release.assets ?? []) as Array<Record<string, unknown>>;
  const asset = platformAsset(assets);
  const checksumAsset = assets.find(item => String(item.name ?? '').toUpperCase() === 'SHA256SUMS.TXT');
  let checksum = String(asset?.sha256 ?? '').toLowerCase();
  if (asset && checksumAsset) {
    const checksumUrl = assetUrls(checksumAsset)[0];
    if (checksumUrl) {
      try {
        const response = await fetch(checksumUrl, {
          headers: { Accept: 'application/octet-stream', 'User-Agent': `${APP_NAME}-Updater` },
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        if (response.ok) checksum = checksumFor(await response.text(), String(asset.name ?? ''));
      } catch { /* manifest 中已有 sha256 时继续使用 */ }
    }
  }
  const urls = assetUrls(asset);
  return {
    source: 'github', version,
    release_url: String(release.html_url ?? ''),
    release_notes: String(release.body ?? ''),
    asset: {
      name: String(asset?.name ?? ''), url: urls[0] ?? '', urls,
      size: safeNumber(asset?.size), sha256: checksum,
    },
  };
}

function compatibleAsset(a: UpdateSourceInfo, b: UpdateSourceInfo): boolean {
  return a.version === b.version
    && Boolean(a.asset.name) && a.asset.name === b.asset.name
    && Boolean(a.asset.sha256) && a.asset.sha256.toLowerCase() === b.asset.sha256.toLowerCase();
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const checks: Array<Promise<UpdateSourceInfo>> = [];
  mirrorManifestUrls().forEach((url, index) => {
    checks.push(checkManifestSource(url, `mirror-${index + 1}`));
  });
  checks.push(checkGitHubSource());

  const settled = await Promise.allSettled(checks);
  const available = settled
    .filter((item): item is PromiseFulfilledResult<UpdateSourceInfo> => item.status === 'fulfilled')
    .map(item => item.value)
    .filter(item => Boolean(item.version));
  if (!available.length) {
    const errors = settled
      .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
      .map(item => String((item.reason as Error)?.message ?? item.reason));
    throw new Error(`所有更新源均不可用${errors.length ? `：${errors.join('；')}` : ''}`);
  }

  available.sort((a, b) => compareVersion(b.version, a.version));
  const chosen = available[0];
  const compatible = available.filter(item => compatibleAsset(chosen, item));
  const urls = uniqueUrls(compatible.flatMap(item => item.asset.urls));
  const sourceNames = compatible.map(item => item.source).filter(Boolean);
  const currentVersion = loadAppVersion();
  const newer = compareVersion(chosen.version, currentVersion) > 0;
  const asset: UpdateAsset = { ...chosen.asset, url: urls[0] ?? chosen.asset.url, urls };
  return {
    source: sourceNames.join(' → ') || chosen.source,
    current_version: currentVersion,
    latest_version: chosen.version,
    update_available: Boolean(chosen.version) && newer,
    release_url: chosen.release_url,
    release_notes: chosen.release_notes,
    asset,
    downloadable: Boolean(asset.name && asset.urls.length && asset.sha256),
  };
}

export function updateStatus(db?: WorkbenchDb): UpdateState {
  if (db) hydrateState(db);
  return { ...updateState };
}

export function isBusy(): boolean {
  return updateRunning || ['starting', 'checking', 'backing_up', 'downloading', 'verifying']
    .includes(updateState.status);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sha256File(filename: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk as Buffer);
  return digest.digest('hex').toLowerCase();
}

function downloadHeaders(offset: number): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/octet-stream',
    'User-Agent': `${APP_NAME}-Updater`,
  };
  if (offset > 0) headers.Range = `bytes=${offset}-`;
  return headers;
}

async function downloadAttempt(
  db: WorkbenchDb,
  url: string,
  destination: string,
  totalBytes: number,
  sourceLabel: string,
): Promise<void> {
  const partial = partPath(destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  if (totalBytes > 0 && offset > totalBytes) {
    fs.rmSync(partial, { force: true });
    offset = 0;
  }
  if (totalBytes > 0 && offset === totalBytes) {
    patchState(db, {
      status: 'downloading', source: sourceLabel, total_bytes: totalBytes,
      downloaded_bytes: offset, progress: 100, speed_bytes_per_second: 0,
      message: '下载已完成，正在准备校验…', error: '',
    });
    return;
  }

  const controller = new AbortController();
  let idleTimer = setTimeout(() => controller.abort(new Error('下载长时间无数据')), DOWNLOAD_IDLE_TIMEOUT_MS);
  const resetIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('下载长时间无数据')), DOWNLOAD_IDLE_TIMEOUT_MS);
  };

  try {
    const response = await fetch(url, {
      headers: downloadHeaders(offset),
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('响应没有数据流');

    // 请求 Range 但服务器返回 200，说明不支持续传；保留本轮请求但从零覆盖写入。
    if (offset > 0 && response.status !== 206) {
      fs.rmSync(partial, { force: true });
      offset = 0;
    }
    if (response.status === 206) {
      const contentRange = String(response.headers.get('content-range') ?? '');
      const match = contentRange.match(/^bytes\s+(\d+)-\d+\/(\d+|\*)$/i);
      if (!match || Number(match[1]) !== offset) {
        throw new Error('服务器返回的断点范围与本地文件不一致');
      }
    }

    const responseLength = safeNumber(response.headers.get('content-length'));
    const effectiveTotal = totalBytes || (response.status === 206 ? offset + responseLength : responseLength);
    let downloaded = offset;
    let speedWindowBytes = 0;
    let speedWindowStarted = Date.now();
    patchState(db, {
      status: 'downloading', source: sourceLabel, total_bytes: effectiveTotal,
      downloaded_bytes: downloaded,
      progress: effectiveTotal > 0 ? (downloaded / effectiveTotal) * 100 : 0,
      message: offset > 0 ? '正在继续下载更新…' : '正在下载更新…', error: '',
    });

    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        resetIdleTimer();
        const bytes = Buffer.byteLength(chunk);
        downloaded += bytes;
        speedWindowBytes += bytes;
        const now = Date.now();
        const elapsed = now - speedWindowStarted;
        const speed = elapsed >= 500 ? (speedWindowBytes * 1000) / elapsed : updateState.speed_bytes_per_second;
        if (elapsed >= 500) {
          speedWindowBytes = 0;
          speedWindowStarted = now;
        }
        patchState(db, {
          downloaded_bytes: downloaded,
          total_bytes: effectiveTotal,
          progress: effectiveTotal > 0 ? Math.min(100, (downloaded / effectiveTotal) * 100) : 0,
          speed_bytes_per_second: speed,
        }, false);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as never),
      meter,
      fs.createWriteStream(partial, { flags: offset > 0 ? 'a' : 'w' }),
    );
    if (effectiveTotal > 0 && downloaded !== effectiveTotal) {
      throw new Error(`下载文件大小不完整：${downloaded}/${effectiveTotal}`);
    }
    patchState(db, {
      downloaded_bytes: downloaded,
      total_bytes: effectiveTotal,
      progress: effectiveTotal > 0 ? Math.min(100, (downloaded / effectiveTotal) * 100) : 100,
      speed_bytes_per_second: 0,
    });
  } finally {
    clearTimeout(idleTimer);
  }
}

async function downloadWithRecovery(
  db: WorkbenchDb,
  info: UpdateCheckResult,
  installerPath: string,
): Promise<void> {
  const urls = uniqueUrls(info.asset.urls.length ? info.asset.urls : [info.asset.url]);
  if (!urls.length) throw new Error('没有可用的安装包下载地址');
  let lastError: Error | null = null;
  let retryCount = updateState.retry_count;

  for (let sourceIndex = 0; sourceIndex < urls.length; sourceIndex += 1) {
    const url = urls[sourceIndex];
    const hostname = (() => { try { return new URL(url).hostname; } catch { return `源${sourceIndex + 1}`; } })();
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) {
        retryCount += 1;
        const wait = RETRY_DELAYS_MS[attempt - 1];
        patchState(db, {
          status: 'retry_wait', retry_count: retryCount, source: hostname,
          message: `网络中断，${Math.round(wait / 1000)} 秒后继续下载（第 ${retryCount} 次重试）`,
          error: lastError?.message ?? '', speed_bytes_per_second: 0,
        });
        await sleep(wait);
      }
      try {
        await downloadAttempt(db, url, installerPath, info.asset.size, hostname);
        return;
      } catch (error) {
        lastError = error as Error;
        patchState(db, {
          status: 'retry_wait', source: hostname, error: lastError.message,
          message: sourceIndex + 1 < urls.length ? '当前下载源不稳定，准备重试或切换备用源…' : '下载中断，准备继续…',
          speed_bytes_per_second: 0,
        });
      }
    }
  }
  throw lastError ?? new Error('所有下载源均失败');
}

async function verifiedCachedInstaller(info: UpdateCheckResult, installerPath: string): Promise<boolean> {
  if (!fs.existsSync(installerPath)) return false;
  if (info.asset.size > 0 && fs.statSync(installerPath).size !== info.asset.size) return false;
  return await sha256File(installerPath) === info.asset.sha256.toLowerCase();
}

/** 后台执行：检查 → 备份 → 可恢复下载 → SHA-256 校验 → ready_to_install。 */
export function startUpdateWorker(db: WorkbenchDb): void {
  hydrateState(db);
  if (isBusy()) return;
  updateRunning = true;
  void (async () => {
    try {
      patchState(db, { status: 'checking', message: '正在检查最新版本…', error: '', speed_bytes_per_second: 0 });
      const info = await checkForUpdate();
      if (!info.update_available) {
        patchState(db, { ...EMPTY_STATE, status: 'up_to_date', message: '当前已经是最新版本' });
        return;
      }
      if (!info.downloadable) throw new Error('找不到当前系统的安装包或 SHA-256 校验信息');

      const dir = updateDir(db);
      fs.mkdirSync(dir, { recursive: true });
      const installer = path.join(dir, path.basename(info.asset.name));
      const sameUpdate = updateState.version === info.latest_version
        && updateState.asset_name === path.basename(info.asset.name)
        && updateState.sha256 === info.asset.sha256.toLowerCase();
      if (!sameUpdate) {
        // 新版本与上次缓存不是同一个文件，旧 .part 不允许继续拼接。
        if (updateState.asset_name) {
          const oldInstaller = path.join(dir, path.basename(updateState.asset_name));
          fs.rmSync(partPath(oldInstaller), { force: true });
        }
        patchState(db, {
          ...EMPTY_STATE,
          status: 'checking', message: '正在准备更新…',
          asset_name: path.basename(info.asset.name), version: info.latest_version,
          source: info.source, sha256: info.asset.sha256.toLowerCase(),
          total_bytes: info.asset.size,
        });
      } else {
        patchState(db, {
          status: 'checking', message: '正在恢复上次更新任务…', error: '',
          source: info.source, total_bytes: info.asset.size || updateState.total_bytes,
        });
      }

      if (await verifiedCachedInstaller(info, installer)) {
        fs.rmSync(partPath(installer), { force: true });
        patchState(db, {
          status: 'ready_to_install', message: '更新已下载并校验，可以安装。',
          downloaded_bytes: info.asset.size || fs.statSync(installer).size,
          total_bytes: info.asset.size || fs.statSync(installer).size,
          progress: 100, verified: true, speed_bytes_per_second: 0,
        });
        return;
      }
      fs.rmSync(installer, { force: true });

      if (!updateState.backup_created) {
        patchState(db, { status: 'backing_up', message: '正在创建升级前数据库备份…', error: '' });
        await db.createBackup('pre-update');
        patchState(db, { backup_created: true });
      }

      await downloadWithRecovery(db, info, installer);
      const partial = partPath(installer);
      if (!fs.existsSync(partial)) throw new Error('下载完成后未找到临时安装包');
      if (info.asset.size > 0 && fs.statSync(partial).size !== info.asset.size) {
        throw new Error(`下载文件大小不完整：${fs.statSync(partial).size}/${info.asset.size}`);
      }

      patchState(db, { status: 'verifying', message: '正在校验安装包完整性…', error: '', speed_bytes_per_second: 0 });
      const digest = await sha256File(partial);
      if (digest !== info.asset.sha256.toLowerCase()) {
        fs.rmSync(partial, { force: true });
        patchState(db, { downloaded_bytes: 0, progress: 0, verified: false });
        throw new Error('安装包 SHA-256 校验失败，已删除损坏文件');
      }
      fs.rmSync(installer, { force: true });
      fs.renameSync(partial, installer);
      patchState(db, {
        status: 'ready_to_install',
        message: '校验通过，请点击“安装并重启工作台”完成更新。',
        downloaded_bytes: info.asset.size || fs.statSync(installer).size,
        total_bytes: info.asset.size || fs.statSync(installer).size,
        progress: 100, verified: true, speed_bytes_per_second: 0, error: '',
      });
    } catch (error) {
      patchState(db, {
        status: 'error', message: '更新未完成，已保留可恢复的下载进度。',
        error: String((error as Error).message), speed_bytes_per_second: 0, verified: false,
      });
    } finally {
      updateRunning = false;
    }
  })();
}

/** 仅供本机 Electron 使用：返回已校验安装包路径。 */
export function installerPath(db: WorkbenchDb): { path: string; name: string } {
  hydrateState(db);
  if (updateState.status !== 'ready_to_install' || !updateState.verified) {
    throw new Error('当前没有待安装的更新');
  }
  const assetName = path.basename(updateState.asset_name);
  if (!assetName) throw new Error('缺少安装包信息');
  const dir = path.resolve(updateDir(db));
  const target = path.resolve(dir, assetName);
  if (path.dirname(target) !== dir || !fs.existsSync(target)) {
    throw new Error('安装包不存在或已被删除，请重新下载更新');
  }
  if (updateState.total_bytes > 0 && fs.statSync(target).size !== updateState.total_bytes) {
    throw new Error('安装包大小发生变化，请重新下载更新');
  }
  return { path: target, name: assetName };
}
