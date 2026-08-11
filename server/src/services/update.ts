/* MIG-09 更新检查与安装包下载校验。
 * 安装所有权归 Electron 桌面壳：本服务只负责检查、备份、下载与 SHA-256 校验，
 * 校验通过后进入 ready_to_install，由 Electron 通过 installer-path 取得安装包。
 *
 * 多更新源：Gitee（国内可达，优先）→ GitHub（回退）。每个源独立检查，
 * 先返回完整结果的源被采用；下载失败时按剩余源依次重试，SHA-256 校验始终执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { getDb } from './context.js';
import { loadAppVersion, APP_NAME } from '../config/index.js';
import { WorkbenchDb } from '../db/connection.js';
import { deleteSettings, readSecret, writeSecret } from './secretStore.js';

const GITHUB_TOKEN_SECRET_FILE = 'github-token.json';

const GITHUB_REPO = 'aitia0718/workbench';
const GITEE_REPO_DEFAULT = 'kaikaiyang/work-bench';

/* 环境变量在调用时读取，便于测试注入不同更新源。 */
function giteeRepo(): string {
  return process.env.WORKBENCH_UPDATE_GITEE_REPO ?? GITEE_REPO_DEFAULT;
}

function giteeApiBase(): string {
  return process.env.WORKBENCH_UPDATE_GITEE_API ?? 'https://gitee.com/api/v5';
}

function githubApiUrl(): string {
  return process.env.WORKBENCH_UPDATE_URL
    ?? `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
}

function githubManifestUrl(): string {
  return process.env.WORKBENCH_UPDATE_MANIFEST_URL
    ?? `https://github.com/${GITHUB_REPO}/releases/latest/download/update-manifest.json`;
}

export type UpdateSourceName = 'gitee' | 'github';

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
  sha256: string;
}

export interface UpdateSourceInfo {
  source: UpdateSourceName;
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

/** 更新源 Token：支持 GitHub（ghp_/github_pat_）与 Gitee（十六进制）。 */
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

function isGiteeToken(token: string): boolean {
  return /^[a-f0-9]{32,}$/i.test(token);
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
  bearerToken?: boolean;
} = {}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Accept: options.accept ?? 'application/vnd.github+json',
    'User-Agent': `${APP_NAME}-Updater`,
  };
  const token = storedToken();
  if (token && options.bearerToken !== false && !isGiteeToken(token)) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (token && isGiteeToken(token) && new URL(url).hostname.endsWith('gitee.com')) {
    const parsed = new URL(url);
    parsed.searchParams.set('access_token', token);
    url = parsed.toString();
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

/** Gitee API 路径（访问令牌由 fetchJson 统一附加）。 */
function giteeApiUrl(pathname: string): string {
  return `${giteeApiBase()}${pathname}`;
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
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    marker = `macOS-${arch}.dmg`;
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

/** GitHub 源：releases API 优先，update-manifest.json 兜底（应对 API 被墙或限流）。 */
async function checkGitHubSource(): Promise<UpdateSourceInfo> {
  let release: Record<string, unknown>;
  try {
    release = await fetchJson(githubApiUrl());
  } catch (primaryError) {
    try {
      release = await fetchJson(githubManifestUrl(), { accept: 'application/json' });
    } catch {
      throw primaryError;
    }
  }
  const tagName = String(release.tag_name ?? '');
  const latestVersion = tagName.replace(/^v/, '');
  const assets = (release.assets ?? []) as Array<Record<string, unknown>>;
  const asset = platformAsset(assets);
  const checksumAsset = assets.find((item) =>
    String(item.name ?? '').toUpperCase() === 'SHA256SUMS.TXT');
  let checksum = String(asset?.sha256 ?? '').toLowerCase();
  if (asset && checksumAsset && checksumAsset.url) {
    try {
      const headers: Record<string, string> = {
        Accept: 'application/octet-stream',
        'User-Agent': `${APP_NAME}-Updater`,
      };
      const token = storedToken();
      if (token && !isGiteeToken(token)) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(String(checksumAsset.url), {
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
    source: 'github',
    version: latestVersion,
    release_url: String(release.html_url ?? ''),
    release_notes: String(release.body ?? ''),
    asset: {
      name: asset?.name ? String(asset.name) : '',
      url: asset?.url ? String(asset.url) : '',
      size: Number(asset?.size ?? 0),
      sha256: checksum,
    },
  };
}

/** Gitee 源：releases/latest → update-manifest.json（内含各安装包的下载地址与 SHA-256）。 */
async function checkGiteeSource(): Promise<UpdateSourceInfo> {
  const release = await fetchJson(
    giteeApiUrl(`/repos/${giteeRepo()}/releases/latest`),
    { accept: 'application/json' },
  );
  const tagName = String(release.tag_name ?? '').replace(/^v/, '');
  if (!tagName) throw new Error('Gitee 没有可用的发布版本');
  const manifestAsset = ((release.assets ?? []) as Array<Record<string, unknown>>).find((item) =>
    String(item.name ?? '') === 'update-manifest.json');
  if (!manifestAsset?.browser_download_url) {
    throw new Error('Gitee 发行版缺少 update-manifest.json');
  }
  const manifest = await fetchJson(String(manifestAsset.browser_download_url), { accept: 'application/json' });
  const assets = (manifest.assets ?? []) as Array<Record<string, unknown>>;
  const asset = platformAsset(assets);
  if (!asset) throw new Error('Gitee 发行版缺少当前平台的安装包');
  const releaseUrl = String(manifest.html_url ?? '')
    || `https://gitee.com/${giteeRepo()}/releases/tag/${tagName}`;
  return {
    source: 'gitee',
    version: tagName,
    release_url: releaseUrl,
    release_notes: String(manifest.release_notes ?? release.body ?? ''),
    asset: {
      name: String(asset.name ?? ''),
      url: String(asset.browser_download_url ?? ''),
      size: Number(asset.size ?? 0),
      sha256: String(asset.sha256 ?? '').toLowerCase(),
    },
  };
}

/** 更新源列表：Gitee 优先（国内直连），GitHub 回退。 */
const SOURCES: Array<{ name: UpdateSourceName; check: () => Promise<UpdateSourceInfo> }> = [
  { name: 'gitee', check: checkGiteeSource },
  { name: 'github', check: checkGitHubSource },
];

export async function checkForUpdate(options: {
  skipSource?: UpdateSourceName;
} = {}): Promise<UpdateCheckResult> {
  const errors: string[] = [];
  for (const source of SOURCES) {
    if (source.name === options.skipSource) continue;
    try {
      const info = await source.check();
      const currentVersion = loadAppVersion();
      const current = versionKey(currentVersion);
      const latest = versionKey(info.version);
      const newer = latest[0] > current[0]
        || (latest[0] === current[0] && latest[1] > current[1])
        || (latest[0] === current[0] && latest[1] === current[1] && latest[2] > current[2]);
      return {
        source: info.source,
        current_version: currentVersion,
        latest_version: info.version,
        update_available: Boolean(info.version) && newer,
        release_url: info.release_url,
        release_notes: info.release_notes,
        asset: info.asset,
        downloadable: Boolean(info.asset.name && info.asset.url && info.asset.sha256),
      };
    } catch (error) {
      errors.push(`${source.name}: ${(error as Error).message}`);
    }
  }
  throw new Error(`所有更新源均不可用：${errors.join('；')}`);
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
  const token = storedToken();
  let target = url;
  if (token && isGiteeToken(token) && new URL(target).hostname.endsWith('gitee.com')) {
    const parsed = new URL(target);
    parsed.searchParams.set('access_token', token);
    target = parsed.toString();
  } else if (token && !isGiteeToken(token)) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(target, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const temporary = `${destination}.download`;
  try {
    fs.writeFileSync(temporary, buffer);
    fs.renameSync(temporary, destination);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* 忽略 */ }
  }
}

/** 下载安装包：先试采用源，失败后按剩余更新源重试。 */
async function downloadInstaller(
  info: Pick<UpdateSourceInfo, 'source' | 'asset'>,
  installerPath: string,
): Promise<void> {
  const urls = [info.asset.url];
  for (const source of SOURCES) {
    if (source.name === info.source) continue;
    try {
      const alternate = await source.check();
      if (alternate.asset.name === info.asset.name && alternate.asset.url && !urls.includes(alternate.asset.url)) {
        urls.push(alternate.asset.url);
      }
    } catch {
      // 备用源不可用时忽略，主源下载失败后再统一报错
    }
  }
  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      await downloadAsset(url, installerPath);
      return;
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw lastError ?? new Error('下载安装包失败');
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
      const installerPath = path.join(updateDir, path.basename(info.asset.name));
      setState('backing_up', '正在创建升级前数据库备份…', '', info.asset.name);
      await db.createBackup('pre-update');
      setState('downloading', `正在从${info.source === 'gitee' ? 'Gitee' : 'GitHub'}下载更新…`, '', info.asset.name);
      await downloadInstaller(info, installerPath);

      setState('verifying', '正在校验安装包…', '', info.asset.name);
      const digest = createHash('sha256');
      digest.update(fs.readFileSync(installerPath));
      if (digest.digest('hex').toLowerCase() !== info.asset.sha256.toLowerCase()) {
        fs.rmSync(installerPath, { force: true });
        throw new Error('安装包 SHA-256 校验失败，已删除下载文件');
      }
      // 安装所有权归 Electron 桌面壳
      setState('ready_to_install', '校验通过，请点击"安装并重启工作台"完成更新。', '', info.asset.name);
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
  if (!value.startsWith('ghp_') && !value.startsWith('github_pat_') && !isGiteeToken(value)) {
    throw new Error('Token 格式不正确，应为 GitHub ghp_/github_pat_ 或 Gitee 访问令牌');
  }
  writeSecret(GITHUB_TOKEN_SECRET_FILE, { token: value });
  deleteSettings(getDb().connInstance, ['github_token']);
}

export function githubTokenConfigured(): boolean {
  return Boolean(storedToken());
}
