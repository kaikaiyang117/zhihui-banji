/* MIG-09 更新检查与安装包下载校验（与 backend/app/routers/system.py 对应部分一致）。
 * 安装所有权归 Electron 桌面壳：本服务只负责检查、备份、下载与 SHA-256 校验，
 * 校验通过后进入 ready_to_install，由 Electron 通过 installer-path 取得安装包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { getDb } from './context.js';
import { loadAppVersion, APP_NAME } from '../config/index.js';
import { WorkbenchDb } from '../db/connection.js';
import { deleteSettings, readSecret, writeSecret } from './secretStore.js';

const GITHUB_TOKEN_SECRET_FILE = 'github-token.json';

const UPDATE_API_URL = process.env.WORKBENCH_UPDATE_URL
  ?? 'https://api.github.com/repos/aitia0718/workbench/releases/latest';
const UPDATE_MANIFEST_URL = process.env.WORKBENCH_UPDATE_MANIFEST_URL
  ?? 'https://github.com/aitia0718/workbench/releases/latest/download/update-manifest.json';

export interface UpdateState {
  status: string;
  message: string;
  error: string;
  asset_name: string;
}

let updateState: UpdateState = { status: 'idle', message: '', error: '', asset_name: '' };
let updateRunning = false;

function githubToken(): string {
  const env = process.env.WORKBENCH_GITHUB_TOKEN ?? '';
  if (env) return env;
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

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `${APP_NAME}-Updater`,
  };
  const token = githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function fetchRelease(): Promise<Record<string, unknown>> {
  try {
    return await fetchJson(UPDATE_API_URL);
  } catch (primaryError) {
    try {
      return await fetchJson(UPDATE_MANIFEST_URL);
    } catch {
      throw primaryError;
    }
  }
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

export interface UpdateCheckResult {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_url: string;
  release_notes: string;
  asset: Record<string, unknown>;
  downloadable: boolean;
  error?: string;
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const release = await fetchRelease();
  const latestVersion = String(release.tag_name ?? '').replace(/^v/, '');
  const assets = (release.assets ?? []) as Array<Record<string, unknown>>;
  const asset = platformAsset(assets);
  const checksumAsset = assets.find((item) =>
    String(item.name ?? '').toUpperCase() === 'SHA256SUMS.TXT');
  let checksum = String(asset?.sha256 ?? '').toLowerCase();
  if (asset && checksumAsset && checksumAsset.url) {
    const headers: Record<string, string> = {
      Accept: 'application/octet-stream',
      'User-Agent': `${APP_NAME}-Updater`,
    };
    const token = githubToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(String(checksumAsset.url), {
      headers, signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      checksum = checksumFor(await response.text(), String(asset.name ?? ''));
    }
  }
  const currentVersion = loadAppVersion();
  const current = versionKey(currentVersion);
  const latest = versionKey(latestVersion);
  const newer = latest[0] > current[0]
    || (latest[0] === current[0] && latest[1] > current[1])
    || (latest[0] === current[0] && latest[1] === current[1] && latest[2] > current[2]);
  return {
    current_version: currentVersion,
    latest_version: latestVersion,
    update_available: Boolean(latestVersion) && newer,
    release_url: String(release.html_url ?? ''),
    release_notes: String(release.body ?? ''),
    asset: {
      name: asset?.name ?? '',
      url: asset?.url ?? '',
      size: Number(asset?.size ?? 0),
      sha256: checksum,
    },
    downloadable: Boolean(asset && checksum),
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
  const token = githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
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
      const asset = info.asset as Record<string, string>;
      const updateDir = path.join(db.paths.dataDir, 'updates');
      fs.mkdirSync(updateDir, { recursive: true });
      const installerPath = path.join(updateDir, path.basename(asset.name));
      setState('backing_up', '正在创建升级前数据库备份…', '', asset.name);
      await db.createBackup('pre-update');
      setState('downloading', '备份已完成，正在下载更新…', '', asset.name);
      await downloadAsset(asset.url, installerPath);

      setState('verifying', '正在校验安装包…', '', asset.name);
      const digest = createHash('sha256');
      digest.update(fs.readFileSync(installerPath));
      if (digest.digest('hex').toLowerCase() !== String(asset.sha256).toLowerCase()) {
        fs.rmSync(installerPath, { force: true });
        throw new Error('安装包 SHA-256 校验失败，已删除下载文件');
      }
      // 安装所有权归 Electron 桌面壳
      setState('ready_to_install', '校验通过，请点击"安装并重启工作台"完成更新。', '', asset.name);
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
    throw new Error('Token 格式不正确，应为 ghp_ 或 github_pat_ 开头');
  }
  writeSecret(GITHUB_TOKEN_SECRET_FILE, { token: value });
  deleteSettings(getDb().connInstance, ['github_token']);
}

export function githubTokenConfigured(): boolean {
  return Boolean(githubToken());
}
