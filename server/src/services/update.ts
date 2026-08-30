/* MIG-09 更新检查与安装包下载校验。
 * 安装所有权归 Electron 桌面壳：本服务只负责检查、备份、下载与 SHA-256 校验，
 * 校验通过后进入 ready_to_install，由 Electron 通过 installer-path 取得安装包。
 *
 * 更新源：自建更新服务器优先，GitHub Releases API / manifest 作为回退。
 * 下载失败时仍会校验 SHA-256，避免使用不完整或被篡改的安装包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { getDb } from './context.js';
import { loadAppVersion, APP_NAME } from '../config/index.js';
import { WorkbenchDb } from '../db/connection.js';
import { deleteSettings, readSecret, writeSecret } from './secretStore.js';

const GITHUB_TOKEN_SECRET_FILE = 'github-token.json';

const GITHUB_REPO = 'aitia0718/workbench';
const DEFAULT_SERVER_MANIFEST_URL = 'https://home.kaikaiyang.top/updates/update-manifest.json';
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

function serverManifestUrl(): string {
  return process.env.WORKBENCH_UPDATE_SERVER_MANIFEST_URL
    ?? DEFAULT_SERVER_MANIFEST_URL;
}

function githubApiUrl(): string {
  return process.env.WORKBENCH_UPDATE_URL
    ?? `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
}

function githubManifestUrl(): string {
  return process.env.WORKBENCH_UPDATE_MANIFEST_URL
    ?? `https://github.com/${GITHUB_REPO}/releases/latest/download/update-manifest.json`;
}

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
  sha256: string;
}

export interface UpdateSourceInfo {
  source: 'server' | 'github';
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
}

export interface UpdateCheckResult extends Omit<UpdateSourceInfo, 'version'> {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  downloadable: boolean;
  error?: string;
}

let updateState: UpdateState = { status: 'idle', message: '', error: '', asset_name: '' };
let updateRunning = false;

/** GitHub 更新源 Token。 */
function storedToken(): string {
  const envToken = process.env.WORKBENCH_GITHUB_TOKEN ?? '';
  if (envToken) return envToken;
  const storedSecret = readSecret<Record<string, unknown>>(GITHUB_TOKEN_SECRET_FILE);
  if (storedSecret?.token) return String(storedSecret.token);
  const row = getDb().connInstance.prepare(
    'SELECT value FROM agent_settings WHERE key=?',
  ).get('github_token') as { value: string } | undefined;
  if (!row) return '';
  const token = String(row.value);
  writeSecret(GITHUB_TOKEN_SECRET_FILE, { token });
  deleteSettings(getDb().connInstance, ['github_token']);
  return token;
}

export function migrateStoredGithubToken(conn?: import('better-sqlite3').Database): void {
  const db = conn ?? getDb().connInstance;
  const file = readSecret<Record<string, unknown>>(GITHUB_TOKEN_SECRET_FILE);
  const row = db.prepare('SELECT value FROM agent_settings WHERE key=?').get('github_token') as { value: string } | undefined;
  if (!file && row?.value) writeSecret(GITHUB_TOKEN_SECRET_FILE, { token: row.value });
  if (row) deleteSettings(db, ['github_token']);
}

async function fetchJson(url: string, options: {
  accept?: string;
  githubAuth?: boolean;
} = {}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Accept: options.accept ?? 'application/vnd.github+json',
    'User-Agent': `${APP_NAME}-Updater`,
  };
  const token = options.githubAuth ? storedToken() : '';
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

function versionKey(version: string): number[] {
  const numbers = (version.match(/\d+/g) ?? []).map(Number);
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
}

function platformAsset(assets: Array<Record<string, unknown>>): Record<string, unknown> | null {
  let markers: string[] = [];
  if (process.platform === 'win32') {
    markers = ['Setup-Windows-x64.exe'];
  } else if (process.platform === 'darwin') {
    markers = process.arch === 'arm64'
      ? ['macOS-arm64.dmg']
      : ['macOS-x64.dmg', 'macOS-x86_64.dmg'];
  } else {
    return null;
  }
  return assets.find((asset) => markers.some((marker) =>
    String(asset.name ?? '').endsWith(marker))) ?? null;
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

function assetDownloadUrl(asset: Record<string, unknown> | null): string {
  return String(asset?.url ?? asset?.browser_download_url ?? '');
}

function isGitHubUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'github.com'
      || hostname === 'api.github.com'
      || hostname.endsWith('.github.com')
      || hostname.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

async function releaseInfo(
  release: Record<string, unknown>,
  source: UpdateSourceInfo['source'],
): Promise<UpdateSourceInfo> {
  const tagName = String(release.tag_name ?? '');
  const latestVersion = tagName.replace(/^v/, '');
  const assets = (release.assets ?? []) as Array<Record<string, unknown>>;
  const asset = platformAsset(assets);
  const checksumAsset = assets.find((item) =>
    String(item.name ?? '').toUpperCase() === 'SHA256SUMS.TXT');
  let checksum = String(asset?.sha256 ?? '').toLowerCase();
  if (asset && checksumAsset && assetDownloadUrl(checksumAsset)) {
    try {
      const headers: Record<string, string> = {
        Accept: 'application/octet-stream',
        'User-Agent': `${APP_NAME}-Updater`,
      };
      const checksumUrl = assetDownloadUrl(checksumAsset);
      const token = isGitHubUrl(checksumUrl) ? storedToken() : '';
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(checksumUrl, {
        headers, signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        checksum = checksumFor(await response.text(), String(asset.name ?? ''));
      }
    } catch {
      // 校验文件拉取失败时保留已获得的校验和
    }
  }
  return {
    source,
    version: latestVersion,
    release_url: String(release.html_url ?? ''),
    release_notes: String(release.body ?? ''),
    asset: {
      name: asset?.name ? String(asset.name) : '',
      url: assetDownloadUrl(asset),
      size: Number(asset?.size ?? 0),
      sha256: checksum,
    },
  };
}

function validatePrimarySource(info: UpdateSourceInfo): UpdateSourceInfo {
  if (!info.version) throw new Error('更新服务器清单缺少版本号');
  if (!info.asset.name || !info.asset.url || !/^[a-f0-9]{64}$/i.test(info.asset.sha256)) {
    throw new Error('更新服务器清单缺少当前系统安装包或 SHA-256');
  }
  return info;
}

/** 自建更新服务器：一个静态 manifest 即可完成检查和下载。 */
async function checkServerSource(): Promise<UpdateSourceInfo> {
  const release = await fetchJson(serverManifestUrl(), { accept: 'application/json' });
  return validatePrimarySource(await releaseInfo(release, 'server'));
}

/** GitHub 回退源：Releases API 优先，GitHub manifest 再兜底。 */
async function checkGitHubSource(): Promise<UpdateSourceInfo> {
  let release: Record<string, unknown>;
  try {
    release = await fetchJson(githubApiUrl(), { githubAuth: true });
  } catch (primaryError) {
    try {
      release = await fetchJson(githubManifestUrl(), {
        accept: 'application/json', githubAuth: true,
      });
    } catch {
      throw primaryError;
    }
  }
  return releaseInfo(release, 'github');
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  let info: UpdateSourceInfo;
  try {
    info = await checkServerSource();
  } catch {
    info = await checkGitHubSource();
  }
  const currentVersion = loadAppVersion();
  const current = versionKey(currentVersion);
  const latest = versionKey(info.version);
  const newer = latest[0] > current[0]
    || (latest[0] === current[0] && latest[1] > current[1])
    || (latest[0] === current[0] && latest[1] === current[1] && latest[2] > current[2]);
  const downloadable = Boolean(info.asset.name && info.asset.url && info.asset.sha256);
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

export function updateStatus(): UpdateState {
  return { ...updateState };
}

function setState(status: string, message = '', error = '', assetName = ''): void {
  updateState = { status, message, error, asset_name: assetName };
}

export function isBusy(): boolean {
  return updateRunning || ['starting', 'checking', 'backing_up', 'downloading', 'verifying']
    .includes(updateState.status);
}

function setRunning(value: boolean): void {
  updateRunning = value;
}

async function downloadAsset(url: string, destination: string): Promise<void> {
  const headers: Record<string, string> = {
    Accept: 'application/octet-stream',
    'User-Agent': `${APP_NAME}-Updater`,
  };
  const token = isGitHubUrl(url) ? storedToken() : '';
  let target = url;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(target, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  if (!response.body) throw new Error('下载失败：响应没有数据流');
  const temporary = `${destination}.download`;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(temporary),
    );
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* 忽略 */ }
  }
}

async function sha256File(filename: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex').toLowerCase();
}

/** 下载安装包并立即完成 SHA-256 校验。 */
async function downloadInstaller(
  info: Pick<UpdateCheckResult, 'asset'>,
  installerPath: string,
): Promise<UpdateAsset> {
  await downloadAsset(info.asset.url, installerPath);
  const digest = await sha256File(installerPath);
  if (digest !== info.asset.sha256.toLowerCase()) {
    fs.rmSync(installerPath, { force: true });
    throw new Error('下载文件 SHA-256 校验失败');
  }
  return info.asset;
}

/** 后台执行：检查 → 备份 → 下载 → SHA-256 校验 → ready_to_install。 */
export function startUpdateWorker(db: WorkbenchDb): void {
  if (isBusy()) return;
  setRunning(true);
  void (async () => {
    try {
      setState('checking', '正在检查最新版本…');
      const info = await checkForUpdate();
      if (!info.update_available) {
        setState('up_to_date', '当前已经是最新版本');
        return;
      }
      if (!info.downloadable) {
        throw new Error('找不到当前系统的安装包或 SHA-256 校验文件');
      }
      const updateDir = path.join(db.paths.dataDir, 'updates');
      fs.mkdirSync(updateDir, { recursive: true });
      setState('backing_up', '正在创建升级前数据库备份…', '', info.asset.name);
      await db.createBackup('pre-update');
      let activeAsset = info.asset;
      let installerPath = path.join(updateDir, path.basename(activeAsset.name));
      const sourceName = info.source === 'server' ? '更新服务器' : 'GitHub';
      setState('downloading', `正在从${sourceName}下载更新…`, '', activeAsset.name);
      let downloadedAsset: UpdateAsset;
      try {
        downloadedAsset = await downloadInstaller({ asset: activeAsset }, installerPath);
      } catch (primaryError) {
        if (info.source !== 'server') throw primaryError;
        const fallback = await checkGitHubSource();
        if (fallback.version !== info.latest_version || !fallback.asset.url || !fallback.asset.sha256) {
          throw primaryError;
        }
        activeAsset = fallback.asset;
        installerPath = path.join(updateDir, path.basename(activeAsset.name));
        setState('downloading', '更新服务器下载失败，正在从 GitHub 重试…', '', activeAsset.name);
        downloadedAsset = await downloadInstaller({ asset: activeAsset }, installerPath);
      }

      setState('verifying', '正在校验安装包…', '', activeAsset.name);
      if (await sha256File(installerPath) !== downloadedAsset.sha256.toLowerCase()) {
        fs.rmSync(installerPath, { force: true });
        throw new Error('安装包 SHA-256 校验失败，已删除下载文件');
      }
      // 安装所有权归 Electron 桌面壳
      setState('ready_to_install', '校验通过，请点击"安装并重启工作台"完成更新。', '', activeAsset.name);
    } catch (error) {
      setState('error', '', String((error as Error).message));
    } finally {
      setRunning(false);
    }
  })();
}

/** 仅供本机 Electron 使用：返回已校验安装包路径。 */
export function installerPath(db: WorkbenchDb): { path: string; name: string } {
  if (updateState.status !== 'ready_to_install') {
    throw new Error('当前没有待安装的更新');
  }
  const assetName = updateState.asset_name;
  if (!assetName) throw new Error('缺少安装包信息');
  const updateDir = path.join(db.paths.dataDir, 'updates');
  const target = path.resolve(updateDir, path.basename(assetName));
  if (path.dirname(target) !== path.resolve(updateDir) || !fs.existsSync(target)) {
    throw new Error('安装包不存在或已被删除，请重新下载更新');
  }
  return { path: target, name: assetName };
}

export function saveGithubToken(token: string): void {
  const value = String(token ?? '').trim();
  if (!value) throw new Error('Token 不能为空');
  if (!value.startsWith('ghp_') && !value.startsWith('github_pat_')) {
    throw new Error('Token 格式不正确，应为 GitHub ghp_ 或 github_pat_ Token');
  }
  writeSecret(GITHUB_TOKEN_SECRET_FILE, { token: value });
  deleteSettings(getDb().connInstance, ['github_token']);
}

export function githubTokenConfigured(): boolean {
  return Boolean(storedToken());
}
