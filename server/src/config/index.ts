/* MIG-02 配置：路径、端口、版本、业务日期、环境变量。
 *
 * 环境变量：
 *   WORKBENCH_HOST / WORKBENCH_PORT / WORKBENCH_DATA_DIR / WORKBENCH_KB_DIR
 *   WORKBENCH_BUSINESS_DATE / WORKBENCH_VERSION / WORKBENCH_STATIC_DIR
 *   WORKBENCH_LAN_URL_BASE（由启动入口生成，本模块只读取）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'MeimeiWorkbench';
export const APP_DISPLAY_NAME = '智汇·班记';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

export interface ServerConfig {
  appName: string;
  displayName: string;
  appVersion: string;
  host: string;
  port: number;
  lanMode: boolean;
  desktopChild: boolean;
  dataDir: string;
  kbDir: string;
  staticDir: string;
  businessDate: string; // YYYY-MM-DD，空表示使用真实时钟
  lanUrlBase: string;
  logLevel: string;
  readyMarkerPath: string;
}

function env(name: string): string | undefined {
  return process.env[name] ?? undefined;
}

/** 从 app-version.json 或 WORKBENCH_VERSION 读取版本。 */
export function parseAppVersion(content: string): string | null {
  try {
    const parsed = JSON.parse(content.replace(/^\uFEFF/, '')) as { version?: string };
    return parsed.version ? String(parsed.version).replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

export function loadAppVersion(): string {
  const configured = env('WORKBENCH_VERSION');
  if (configured) return configured.replace(/^v/, '');
  const candidates = [
    path.join(SERVER_ROOT, 'static', 'app-version.json'),
    path.join(PROJECT_ROOT, 'backend', 'static', 'app-version.json'),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const version = parseAppVersion(fs.readFileSync(candidate, 'utf-8'));
    if (version) return version;
  }
  return '0.0.0-dev';
}

/** 默认数据目录：开发在项目根 data/，打包在系统用户目录。 */
function defaultDataDir(): string {
  const configured = env('WORKBENCH_DATA_DIR');
  if (configured) return path.resolve(configured);
  if (env('MEIMEI_PACKAGED') === '1') {
    if (process.platform === 'win32') {
      const base = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? os.homedir();
      return path.join(base, APP_NAME);
    }
    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
    }
    return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), APP_NAME);
  }
  return path.join(PROJECT_ROOT, 'data');
}

function defaultKbDir(dataDir: string): string {
  const configured = env('WORKBENCH_KB_DIR');
  if (configured) return path.resolve(configured);
  return env('MEIMEI_PACKAGED') === '1'
    ? path.join(dataDir, '知识库')
    : path.join(PROJECT_ROOT, '知识库');
}

/** Vue 构建产物目录：默认 server/static，开发构建时回退 backend/static。 */
function resolveStaticDir(): string {
  const configured = env('WORKBENCH_STATIC_DIR');
  if (configured) return path.resolve(configured);
  const own = path.join(SERVER_ROOT, 'static');
  if (fs.existsSync(own)) return own;
  return path.join(PROJECT_ROOT, 'backend', 'static');
}

/** 校验业务日期格式；非法时抛错。 */
export function validateBusinessDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`WORKBENCH_BUSINESS_DATE 格式不正确（应为 YYYY-MM-DD）：${value}`);
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  // 按组件构造，避免本地时区把日期偏移到前一天。
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`WORKBENCH_BUSINESS_DATE 不是有效日期：${value}`);
  }
}

/** 解析配置；启动入口在监听前调用，校验失败直接退出。 */
export function loadConfig(argv: {
  lan?: boolean;
  host?: string;
  port?: number;
  desktopChild?: boolean;
} = {}): ServerConfig {
  const businessDate = env('WORKBENCH_BUSINESS_DATE');
  if (businessDate) validateBusinessDate(businessDate);

  const lanMode = Boolean(argv.lan) || env('WORKBENCH_LAN') === '1';
  const host = argv.host ?? env('WORKBENCH_HOST') ?? (lanMode ? '0.0.0.0' : '127.0.0.1');
  const requestedPort = argv.port ?? Number.parseInt(env('WORKBENCH_PORT') || '5000', 10);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`WORKBENCH_PORT 不合法：${requestedPort}`);
  }

  const dataDir = defaultDataDir();
  const readyMarkerPath = path.join(dataDir, '.workbench-ready');

  return {
    appName: APP_NAME,
    displayName: APP_DISPLAY_NAME,
    appVersion: loadAppVersion(),
    host,
    port: requestedPort,
    lanMode,
    desktopChild: Boolean(argv.desktopChild),
    dataDir,
    kbDir: defaultKbDir(dataDir),
    staticDir: resolveStaticDir(),
    businessDate: businessDate ?? '',
    lanUrlBase: env('WORKBENCH_LAN_URL_BASE') ?? '',
    logLevel: env('WORKBENCH_LOG_LEVEL') ?? 'info',
    readyMarkerPath,
  };
}

/** 本机局域网地址（用于生成配对入口 URL）。 */
export function localIp(): string {
  const sockets = os.networkInterfaces();
  for (const entries of Object.values(sockets)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}
