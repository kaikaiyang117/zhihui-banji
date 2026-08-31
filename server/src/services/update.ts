/* MIG-09 更新检查与安装包下载校验。
 * 安装所有权归 Electron 桌面壳：本服务只负责检查、备份、下载与 SHA-256 校验，
 * 校验通过后进入 ready_to_install，由 Electron 通过 installer-path 取得安装包。
 *
 * 更新源：腾讯云 COS manifest 为主，GitHub Release 为灾备。
 * 下载失败时保留 .part，并在切换源时继续使用同一个断点文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { loadAppVersion, APP_NAME } from '../config/index.js';
import { WorkbenchDb } from '../db/connection.js';

const GITHUB_REPO = 'kaikaiyang117/zhihui-banji';
const DEFAULT_MIRROR_MANIFEST_URL =
  'https://zhihui-banji-update-1304673766.cos.ap-chengdu.myqcloud.com/latest/update-manifest.json';
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_RETRIES_PER_SOURCE = 3;
const RETRY_DELAY_MS = [1000, 3000];

function githubApiUrl(): string {
  return process.env.WORKBENCH_UPDATE_URL
    ?? `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
}

function githubManifestUrl(): string {
  return process.env.WORKBENCH_UPDATE_MANIFEST_URL
    ?? `https://github.com/${GITHUB_REPO}/releases/latest/download/update-manifest.json`;
}

function mirrorManifestUrls(): string[] {
  const configured = process.env.WORKBENCH_UPDATE_MIRROR_MANIFEST_URLS
    ?? process.env.WORKBENCH_UPDATE_MIRROR_MANIFEST_URL;
  if (configured?.trim()) {
    return configured.split(/[;,\n]/).map((value) => value.trim()).filter(Boolean);
  }
  return [DEFAULT_MIRROR_MANIFEST_URL];
}

export interface UpdateAsset {
  name: string;
  url: string;
  urls: string[];
  size: number;
  sha256: string;
}

export interface UpdateSourceInfo {
  source: 'cos' | 'github';
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
let statePath = '';

function stateFileFor(db: WorkbenchDb): string {
  return path.join(db.paths.dataDir, 'updates', 'update-state.json');
}

function persistState(): void {
  if (!statePath) return;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(updateState, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temporary, statePath);
  } catch (error) {
    // Windows 不允许 rename 覆盖已有目标，保留临时文件→替换的写入顺序。
    if (process.platform !== 'win32') throw error;
    fs.rmSync(statePath, { force: true });
    fs.renameSync(temporary, statePath);
  }
}

function hydrateState(db: WorkbenchDb): void {
  const nextPath = stateFileFor(db);
  if (statePath !== nextPath) {
    statePath = nextPath;
    updateState = { ...EMPTY_STATE };
  }
  if (!fs.existsSync(statePath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<UpdateState>;
    updateState = { ...EMPTY_STATE, ...parsed };
    if (!updateRunning && ['starting', 'checking', 'backing_up', 'downloading', 'verifying'].includes(updateState.status)) {
      updateState.status = 'paused';
      updateState.message = '上次更新未完成，已保留下载进度，可继续下载。';
      updateState.updated_at = new Date().toISOString();
      persistState();
    }
  } catch {
    updateState = { ...EMPTY_STATE, status: 'error', error: '更新状态文件损坏，无法恢复更新进度。' };
  }
}

async function fetchJson(url: string, options: { accept?: string } = {}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Accept: options.accept ?? 'application/vnd.github+json',
    'User-Agent': `${APP_NAME}-Updater`,
  };
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

function versionKey(version: string): number[] {
  const numbers = (version.match(/\d+/g) ?? []).map(Number);
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
}

function platformAsset(assets: Array<Record<string, unknown>>): Record<string, unknown> | null {
  let marker = '';
  if (process.platform === 'win32') {
    marker = 'Setup-Windows-x64.exe';
  } else if (process.platform === 'darwin') {
    if (process.arch !== 'arm64') return null;
    marker = 'macOS-arm64.dmg';
  } else {
    return null;
  }
  return assets.find((asset) => String(asset.name ?? '').endsWith(marker)) ?? null;
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

function validSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function normaliseUrls(values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const candidate = String(value ?? '').trim();
    if (!candidate) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(`更新清单包含无效 URL：${candidate}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`更新清单只允许 HTTP/HTTPS URL：${candidate}`);
    }
    if (!result.includes(candidate)) result.push(candidate);
  }
  return result;
}

function assetUrls(asset: Record<string, unknown>): string[] {
  if (Array.isArray(asset.urls)) return normaliseUrls(asset.urls);
  return normaliseUrls([asset.browser_download_url, asset.url]);
}

function emptyAsset(): UpdateAsset {
  return { name: '', url: '', urls: [], size: 0, sha256: '' };
}

function buildSourceInfo(
  source: 'cos' | 'github', release: Record<string, unknown>, allowMissingSha = false,
): UpdateSourceInfo {
  const assets = Array.isArray(release.assets)
    ? release.assets as Array<Record<string, unknown>> : [];
  const selected = platformAsset(assets);
  if (!selected) {
    return {
      source,
      version: String(release.tag_name ?? '').replace(/^v/, ''),
      release_url: String(release.release_url ?? release.html_url ?? ''),
      release_notes: String(release.release_notes ?? release.body ?? ''),
      asset: emptyAsset(),
    };
  }
  const urls = assetUrls(selected);
  const size = Number(selected.size ?? 0);
  const sha256 = String(selected.sha256 ?? '').toLowerCase();
  if (!selected.name || !urls.length || !Number.isSafeInteger(size) || size <= 0
    || (!allowMissingSha && !validSha256(sha256))) {
    throw new Error('更新清单缺少合法的安装包 URL、大小或 SHA-256');
  }
  return {
    source,
    version: String(release.tag_name ?? '').replace(/^v/, ''),
    release_url: String(release.release_url ?? release.html_url ?? ''),
    release_notes: String(release.release_notes ?? release.body ?? ''),
    asset: { name: String(selected.name), url: urls[0], urls, size, sha256 },
  };
}

/** GitHub 源：Releases API 优先，update-manifest.json 兜底。 */
async function checkGitHubSource(): Promise<UpdateSourceInfo> {
  let release: Record<string, unknown>;
  try {
    release = await fetchJson(githubApiUrl());
  } catch (primaryError) {
    try {
      return buildSourceInfo('github', await fetchJson(githubManifestUrl(), { accept: 'application/json' }));
    } catch {
      throw primaryError;
    }
  }

  const assets = Array.isArray(release.assets)
    ? release.assets as Array<Record<string, unknown>> : [];
  const selected = platformAsset(assets);
  if (!selected) return buildSourceInfo('github', release);
  let info = buildSourceInfo('github', {
    ...release,
    assets: assets.map((asset) => ({
      ...asset,
      urls: asset.urls ?? [asset.browser_download_url, asset.url],
    })),
  }, true);
  const checksumAsset = assets.find((item) => String(item.name ?? '').toUpperCase() === 'SHA256SUMS.TXT');
  if (checksumAsset && assetUrls(checksumAsset).length) {
    try {
      const response = await fetch(assetUrls(checksumAsset)[0], {
        headers: { Accept: 'application/octet-stream', 'User-Agent': `${APP_NAME}-Updater` },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const checksum = checksumFor(await response.text(), info.asset.name);
        if (validSha256(checksum)) info = { ...info, asset: { ...info.asset, sha256: checksum } };
      }
    } catch {
      // 校验文件拉取失败时保留 API 中已获得的校验和。
    }
  }
  return info;
}

async function checkMirrorSource(): Promise<UpdateSourceInfo> {
  let lastError: unknown = new Error('腾讯云 COS 更新源不可用');
  for (const url of mirrorManifestUrls()) {
    try {
      return buildSourceInfo('cos', await fetchJson(url, { accept: 'application/json' }));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function buildCheckResult(info: UpdateSourceInfo): UpdateCheckResult {
  const currentVersion = loadAppVersion();
  const current = versionKey(currentVersion);
  const latest = versionKey(info.version);
  const newer = latest[0] > current[0]
    || (latest[0] === current[0] && latest[1] > current[1])
    || (latest[0] === current[0] && latest[1] === current[1] && latest[2] > current[2]);
  const downloadable = Boolean(
    info.asset.name && info.asset.urls.length && info.asset.size > 0 && validSha256(info.asset.sha256),
  );
  return {
    source: info.source,
    current_version: currentVersion,
    latest_version: info.version,
    update_available: Boolean(info.version) && newer,
    release_url: info.release_url,
    release_notes: info.release_notes,
    asset: info.asset,
    downloadable,
  };
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  let info: UpdateSourceInfo;
  try {
    info = await checkMirrorSource();
  } catch (mirrorError) {
    try {
      info = await checkGitHubSource();
    } catch (githubError) {
      const mirrorMessage = String((mirrorError as Error).message ?? mirrorError);
      const githubMessage = String((githubError as Error).message ?? githubError);
      throw new Error(`更新源均不可用：COS（${mirrorMessage}）；GitHub（${githubMessage}）`);
    }
  }
  return buildCheckResult(info);
}

export function updateStatus(db?: WorkbenchDb): UpdateState {
  if (db) hydrateState(db);
  return { ...updateState };
}

function setState(
  status: string,
  message?: string,
  error?: string,
  assetName?: string,
  patch: Partial<UpdateState> = {},
): void {
  updateState = {
    ...updateState,
    status,
    message: message ?? updateState.message,
    error: error ?? updateState.error,
    asset_name: assetName ?? updateState.asset_name,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  persistState();
}

export function isBusy(): boolean {
  return updateRunning || ['starting', 'checking', 'backing_up', 'downloading', 'verifying']
    .includes(updateState.status);
}

function setRunning(value: boolean): void {
  updateRunning = value;
}

function identityMatches(state: UpdateState, version: string, asset: UpdateAsset): boolean {
  return Boolean(state.version && state.asset_name && state.sha256)
    && state.version === version
    && state.asset_name === asset.name
    && state.sha256.toLowerCase() === asset.sha256.toLowerCase();
}

function sha256FileSync(filename: string): string {
  const digest = createHash('sha256');
  digest.update(fs.readFileSync(filename));
  return digest.digest('hex').toLowerCase();
}

async function sha256File(filename: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex').toLowerCase();
}

function sourceHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function reportProgress(asset: UpdateAsset, version: string, url: string, startedAt: number, retryCount: number): void {
  const partPath = path.join(path.dirname(statePath), `${path.basename(asset.name)}.part`);
  const downloaded = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
  const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001);
  setState('downloading', '正在下载更新…', '', asset.name, {
    version,
    source: sourceHost(url),
    sha256: asset.sha256,
    total_bytes: asset.size,
    downloaded_bytes: downloaded,
    progress: Math.min((downloaded / asset.size) * 100, 100),
    speed_bytes_per_second: Math.max(0, Math.round(downloaded / elapsed)),
    retry_count: retryCount,
    verified: false,
  });
}

function contentRangeStart(value: string): { start: number; total: number } | null {
  const match = /^bytes\s+(\d+)-\d+\/(\d+|\*)$/i.exec(value.trim());
  if (!match) return null;
  return { start: Number(match[1]), total: match[2] === '*' ? 0 : Number(match[2]) };
}

async function downloadFromUrl(
  url: string,
  partPath: string,
  asset: UpdateAsset,
  version: string,
  retryCount: number,
): Promise<void> {
  const offset = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
  if (offset === asset.size) return;
  const headers: Record<string, string> = {
    Accept: 'application/octet-stream',
    'User-Agent': `${APP_NAME}-Updater`,
  };
  if (offset > 0) headers.Range = `bytes=${offset}-`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  if (!response.body) throw new Error('下载失败：响应没有数据流');

  if (offset > 0) {
    if (response.status !== 206) throw new Error('下载服务器未返回 206 Partial Content，拒绝覆盖断点文件');
    const range = contentRangeStart(response.headers.get('content-range') ?? '');
    if (!range || range.start !== offset || (range.total && range.total !== asset.size)) {
      throw new Error(`Content-Range 起始位置不匹配：期望 ${offset}`);
    }
  } else if (response.status === 206) {
    const range = contentRangeStart(response.headers.get('content-range') ?? '');
    if (!range || range.start !== 0 || (range.total && range.total !== asset.size)) {
      throw new Error('Content-Range 起始位置不匹配：期望 0');
    }
  }

  const startedAt = Date.now();
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
      reportProgress(asset, version, url, startedAt, retryCount);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    progress,
    fs.createWriteStream(partPath, { flags: offset > 0 ? 'a' : 'w' }),
  );
  const finalSize = fs.statSync(partPath).size;
  if (finalSize > asset.size) throw new Error(`下载文件大小超出预期：${finalSize}/${asset.size}`);
  if (finalSize < asset.size) throw new Error(`下载未完成：${finalSize}/${asset.size} 字节`);
}

async function waitBeforeRetry(retryNumber: number): Promise<void> {
  const delay = RETRY_DELAY_MS[retryNumber - 1];
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
}

async function downloadInstaller(
  asset: UpdateAsset,
  version: string,
  installerPath: string,
  sameIdentity: boolean,
): Promise<void> {
  const partPath = `${installerPath}.part`;
  if (!sameIdentity) {
    fs.rmSync(partPath, { force: true });
    fs.rmSync(installerPath, { force: true });
  }
  if (fs.existsSync(partPath) && fs.statSync(partPath).size > asset.size) fs.rmSync(partPath, { force: true });

  let lastError: unknown = null;
  let success = false;
  let downloadedFromUrl = asset.urls[0];
  for (const url of asset.urls) {
    for (let attempt = 1; attempt <= MAX_RETRIES_PER_SOURCE; attempt += 1) {
      try {
        const retryCount = updateState.retry_count + (attempt > 1 ? 1 : 0);
        if (attempt > 1) {
          setState('downloading', '网络中断，正在自动重试…', '', asset.name, { retry_count: retryCount });
          await waitBeforeRetry(attempt - 1);
        }
        await downloadFromUrl(url, partPath, asset, version, retryCount);
        downloadedFromUrl = url;
        success = true;
        break;
      } catch (error) {
        lastError = error;
        const retryCount = updateState.retry_count + 1;
        const downloaded = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
        setState('downloading', '网络中断，正在自动重试…', '', asset.name, {
          version, source: sourceHost(url), sha256: asset.sha256, total_bytes: asset.size,
          downloaded_bytes: downloaded, progress: (downloaded / asset.size) * 100, retry_count: retryCount,
        });
        if (attempt === MAX_RETRIES_PER_SOURCE) break;
      }
    }
    if (success) break;
  }
  if (!success) {
    throw new Error(`更新下载失败：${String((lastError as Error)?.message ?? lastError ?? '所有更新源均不可用')}`);
  }

  const downloaded = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
  if (downloaded !== asset.size) throw new Error(`下载未完成：${downloaded}/${asset.size} 字节`);
  setState('verifying', '正在校验安装包…', '', asset.name, {
    version, sha256: asset.sha256, total_bytes: asset.size,
    downloaded_bytes: downloaded, progress: 100, source: sourceHost(downloadedFromUrl),
  });
  const digest = await sha256File(partPath);
  if (digest !== asset.sha256.toLowerCase()) {
    fs.rmSync(partPath, { force: true });
    throw new Error('下载文件 SHA-256 校验失败，已删除损坏的断点文件');
  }
  fs.rmSync(installerPath, { force: true });
  fs.renameSync(partPath, installerPath);
}

/** 后台执行：检查 → 备份 → 下载 → SHA-256 校验 → ready_to_install。 */
export function startUpdateWorker(db: WorkbenchDb): void {
  hydrateState(db);
  if (isBusy()) return;
  statePath = stateFileFor(db);
  const previousState = { ...updateState };
  setRunning(true);
  void (async () => {
    try {
      setState('checking', '正在检查最新版本…');
      const info = await checkForUpdate();
      if (!info.update_available) {
        setState('up_to_date', '当前已经是最新版本', '', '', { verified: false });
        return;
      }
      if (!info.downloadable) throw new Error('找不到当前系统的安装包或合法的 SHA-256 校验值');
      const updateDir = path.join(db.paths.dataDir, 'updates');
      fs.mkdirSync(updateDir, { recursive: true });
      const installerPath = path.join(updateDir, path.basename(info.asset.name));
      const sameIdentity = identityMatches(previousState, info.latest_version, info.asset);

      if (sameIdentity && previousState.status === 'ready_to_install'
        && previousState.verified && fs.existsSync(installerPath)
        && fs.statSync(installerPath).size === info.asset.size
        && sha256FileSync(installerPath) === info.asset.sha256.toLowerCase()) {
        updateState = { ...previousState };
        setState('ready_to_install', '校验通过，请点击"安装并重启工作台"完成更新。', '', info.asset.name, {
          total_bytes: info.asset.size, downloaded_bytes: info.asset.size, progress: 100,
          sha256: info.asset.sha256, verified: true,
        });
        return;
      }

      setState('backing_up', '正在创建升级前数据库备份…', '', info.asset.name, {
        version: info.latest_version, source: info.source, sha256: info.asset.sha256,
        total_bytes: info.asset.size,
        downloaded_bytes: sameIdentity ? previousState.downloaded_bytes : 0,
        progress: sameIdentity ? previousState.progress : 0,
        retry_count: sameIdentity ? previousState.retry_count : 0,
        backup_created: sameIdentity && previousState.backup_created, verified: false,
      });
      if (!updateState.backup_created) {
        await db.createBackup('pre-update');
        setState('backing_up', '升级前数据库备份已完成。', '', info.asset.name, { backup_created: true });
      }
      setState('downloading', `正在从${info.source === 'cos' ? '腾讯云 COS' : 'GitHub'}下载更新…`, '', info.asset.name, {
        source: sourceHost(info.asset.urls[0]),
      });
      await downloadInstaller(info.asset, info.latest_version, installerPath, sameIdentity);
      setState('ready_to_install', '校验通过，请点击"安装并重启工作台"完成更新。', '', info.asset.name, {
        version: info.latest_version, sha256: info.asset.sha256, total_bytes: info.asset.size,
        downloaded_bytes: info.asset.size, progress: 100, verified: true,
      });
    } catch (error) {
      setState('error', '已保留下载进度，可点击“继续下载”重试。', String((error as Error).message), undefined, {
        verified: false,
      });
    } finally {
      setRunning(false);
    }
  })();
}

/** 仅供本机 Electron 使用：返回已校验安装包路径。 */
export function installerPath(db: WorkbenchDb): { path: string; name: string } {
  hydrateState(db);
  if (updateState.status !== 'ready_to_install') throw new Error('当前没有待安装的更新');
  const assetName = updateState.asset_name;
  if (!assetName) throw new Error('缺少安装包信息');
  const updateDir = path.join(db.paths.dataDir, 'updates');
  const target = path.resolve(updateDir, path.basename(assetName));
  if (path.dirname(target) !== path.resolve(updateDir) || !fs.existsSync(target)) {
    throw new Error('安装包不存在或已被删除，请重新下载更新');
  }
  if (!updateState.verified || (updateState.total_bytes && fs.statSync(target).size !== updateState.total_bytes)
    || (updateState.sha256 && sha256FileSync(target) !== updateState.sha256.toLowerCase())) {
    throw new Error('安装包未通过完整性校验，拒绝安装');
  }
  return { path: target, name: assetName };
}
