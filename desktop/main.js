'use strict';
/* 美美大王工作台 Electron 桌面壳
 *
 * 职责：单实例、窗口、托盘、Node.js 后端子进程、导航限制、
 * 下载/外部协议、更新安装协调和退出生命周期。
 * 渲染进程保持 nodeIntegration:false + contextIsolation:true + sandbox:true，
 * 仅通过 preload 暴露白名单 IPC。
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, session, utilityProcess, nativeImage } = require('electron');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_NAME = 'MeimeiWorkbench';
const HEALTH_TIMEOUT_MS = 90 * 1000;
const isSmoke = process.env.WORKBENCH_SMOKE === '1';
const useDevFrontend = process.argv.includes('--dev-frontend') && !app.isPackaged && !isSmoke;

let mainWindow = null;
let tray = null;
let backendProcess = null;
let backendBaseUrl = null;
let backendLog = [];
let healthStartedAt = 0;
let quitting = false;
let smokeFailures = [];
let petWindow = null;
let petSettings = null;
let petStateController = null;

/* ---------------------------------------------------------------- 单实例 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

/* 打包模式下使用独立的 Electron 用户数据目录，避免与后端数据目录混用。 */
if (app.isPackaged) {
  const base = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
  app.setPath('userData', path.join(base, `${APP_NAME}-Electron`));
}

app.setName(APP_NAME);

/* ---------------------------------------------------------------- 工具函数 */
function logLine(text) {
  backendLog.push(text);
  if (backendLog.length > 200) backendLog.shift();
  console.log(text);
}

function backendLogPath() {
  return path.join(app.getPath('userData'), 'backend.log');
}

function flushBackendLog() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(backendLogPath(), backendLog.join('\n'), 'utf-8');
  } catch (err) {
    console.error('无法写入后端日志文件：', err.message);
  }
}

/* ---------------------------------------------------------------- 后端进程
 * Node.js 后端运行在 Electron utilityProcess 中（MIG-10）：
 * 开发与打包共用同一入口 server/dist/entry.js，差异只来自路径和环境变量。
 * 源码运行（未打包）使用系统 Node 子进程：server/node_modules 为系统 Node ABI，
 * 无法在 utilityProcess（Electron ABI）中加载；打包模式依赖 build/server-bundle
 * 里为 Electron ABI 重建过的原生模块。
 */
const MAX_BACKEND_RESTARTS = 2;

function usingServerBundle() {
  return app.isPackaged || process.env.WORKBENCH_USE_BUNDLE === '1';
}

function bundleRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.join(__dirname, '..', 'build', 'server-bundle');
}

function resolveBackendEntry() {
  return usingServerBundle()
    ? path.join(bundleRoot(), 'dist', 'entry.js')
    : path.join(__dirname, '..', 'server', 'dist', 'entry.js');
}

function backendProcessEnv() {
  const env = { ...process.env };
  if (usingServerBundle()) {
    env.MEIMEI_PACKAGED = '1';
    env.WORKBENCH_STATIC_DIR = path.join(bundleRoot(), 'static');
  }
  return env;
}

function resolveNodeCommand() {
  if (process.env.WORKBENCH_NODE) {
    return process.env.WORKBENCH_NODE;
  }
  const candidates = [
    path.join(__dirname, '..', '.nvm', 'current', 'bin', 'node'),
  ].filter(Boolean);
  const found = candidates.find(candidate => !candidate.includes(path.sep) || fs.existsSync(candidate));
  return found || 'node';
}

function resolveNpmCommand(nodeCommand) {
  if (path.isAbsolute(nodeCommand)) {
    const sibling = path.join(path.dirname(nodeCommand), process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (fs.existsSync(sibling)) return sibling;
  }
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function checkBetterSqlite3(nodeCommand, serverRoot) {
  const modulePath = path.join(serverRoot, 'node_modules', 'better-sqlite3');
  if (!fs.existsSync(modulePath)) {
    return { ok: false, detail: 'server/node_modules/better-sqlite3 不存在' };
  }
  const script = [
    `const Database = require(${JSON.stringify(modulePath)});`,
    "const db = new Database(':memory:');",
    'db.close();',
  ].join('');
  const result = spawnSync(nodeCommand, ['-e', script], {
    cwd: serverRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status === 0) return { ok: true, detail: '' };
  return {
    ok: false,
    detail: String(result.stderr || result.error?.message || '无法加载 better-sqlite3').trim().split(/\r?\n/).slice(-3).join(' '),
  };
}

function ensureDevNativeModules(nodeCommand, serverRoot) {
  const before = checkBetterSqlite3(nodeCommand, serverRoot);
  if (before.ok) return;

  logLine(`检测到 better-sqlite3 与当前 Node 不兼容，正在自动重建（${before.detail}）`);
  const rebuildEnv = { ...process.env, npm_config_build_from_source: 'true' };
  if (path.isAbsolute(nodeCommand)) {
    const nodeBinDir = path.dirname(nodeCommand);
    rebuildEnv.PATH = `${nodeBinDir}${path.delimiter}${process.env.PATH || ''}`;
  }
  const rebuild = spawnSync(resolveNpmCommand(nodeCommand), ['rebuild', 'better-sqlite3', '--prefix', serverRoot], {
    cwd: serverRoot,
    env: rebuildEnv,
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (rebuild.status !== 0) {
    const detail = String(rebuild.stderr || rebuild.error?.message || 'npm rebuild 执行失败').trim().split(/\r?\n/).slice(-5).join(' ');
    throw new Error(`better-sqlite3 自动重建失败：${detail}`);
  }
  const after = checkBetterSqlite3(nodeCommand, serverRoot);
  if (!after.ok) throw new Error(`better-sqlite3 重建后仍无法加载：${after.detail}`);
  logLine('better-sqlite3 已按当前 Node ABI 重建。');
}

function startBackend() {
  const entry = resolveBackendEntry();
  if (!fs.existsSync(entry)) {
    failBackend(`找不到 Node 后端入口 ${entry}，请先构建：cd server && npm run build:server`);
    return;
  }
  const backendDir = path.dirname(path.dirname(entry));
  /* 桌面壳默认开启局域网配对（手机访问），与 Electron 冒烟测试和产品定位一致。 */
  const backendArgs = ['--desktop-child', '--lan'];
  logLine(`启动 Node 后端：${entry} ${backendArgs.join(' ')}`);
  const useUtility = usingServerBundle();
  const nodeCommand = resolveNodeCommand();
  if (!useUtility) {
    try {
      ensureDevNativeModules(nodeCommand, backendDir);
    } catch (err) {
      failBackend(`后端原生依赖初始化失败：${err.message}`);
      return;
    }
  }
  try {
    if (useUtility) {
      backendProcess = utilityProcess.fork(entry, backendArgs, {
        cwd: backendDir,
        env: backendProcessEnv(),
        stdio: 'pipe',
      });
    } else {
      backendProcess = spawn(nodeCommand, [entry, ...backendArgs], {
        cwd: backendDir,
        env: backendProcessEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    }
  } catch (err) {
    failBackend(`无法启动后端进程：${err.message}`);
    return;
  }
  let stdoutBuffer = '';
  let stderrBuffer = '';
  if (backendProcess.stdout) backendProcess.stdout.on('data', chunk => { stdoutBuffer = consumeOutput(stdoutBuffer, chunk); });
  if (backendProcess.stderr) backendProcess.stderr.on('data', chunk => { stderrBuffer = consumeOutput(stderrBuffer, chunk); });
  backendProcess.on('error', err => {
    failBackend(`后端进程启动失败：${err.message}`);
  });
  backendProcess.on('exit', (code, signal) => {
    backendProcess = null;
    logLine(`后端进程已退出（code=${code} signal=${signal || 'none'}）`);
    if (!quitting && code !== 0) {
      handleBackendCrash(`后端服务意外退出（退出码 ${code}），请查看日志。`);
    }
  });
}

let backendRestartCount = 0;
function handleBackendCrash(message) {
  flushBackendLog();
  if (isSmoke) {
    failBackend(message);
    return;
  }
  if (backendRestartCount >= MAX_BACKEND_RESTARTS) {
    failBackend(message);
    return;
  }
  backendRestartCount += 1;
  logLine(`后端异常退出，尝试重启（第 ${backendRestartCount}/${MAX_BACKEND_RESTARTS} 次）……`);
  dialog.showMessageBox({
    type: 'warning',
    title: '工作台服务异常',
    message,
    detail: `完整日志：${backendLogPath()}\n\n${backendLog.slice(-30).join('\n')}`,
    buttons: ['重启服务', '退出工作台'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) {
      healthStartedAt = 0;
      backendBaseUrl = null;
      startBackend();
    } else {
      quitting = true;
      app.exit(1);
    }
  });
}

function consumeOutput(buffer, chunk) {
  buffer += chunk.toString('utf-8');
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    const text = line.replace(/\s+$/, '');
    if (!text) continue;
    logLine(text);
    const match = text.match(/^WORKBENCH_URL=(https?:\/\/[^\s]+)$/);
    if (match) {
      backendBaseUrl = match[1];
      healthStartedAt = Date.now();
      pollHealth();
    }
  }
  return buffer;
}

/* ---------------------------------------------------------------- 健康检查 */
function pollHealth() {
  if (quitting || !backendBaseUrl) return;
  const request = http.get(`${backendBaseUrl}/api/system/health`, { timeout: 3000 }, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => {
      try {
        const info = JSON.parse(body);
        if (info && info.ready) {
          logLine('后端健康检查通过，加载工作台页面。');
          onBackendReady();
          return;
        }
      } catch (_err) { /* 继续轮询 */ }
      scheduleHealthPoll();
    });
  });
  request.on('error', scheduleHealthPoll);
  request.setTimeout(3000, () => request.destroy());
}

function scheduleHealthPoll() {
  if (quitting || !backendBaseUrl) return;
  if (Date.now() - healthStartedAt > HEALTH_TIMEOUT_MS) {
    failBackend('等待后端就绪超时，请检查端口占用或防火墙设置。');
    return;
  }
  setTimeout(pollHealth, 500);
}

function failBackend(message) {
  if (quitting) return;
  logLine(`后端错误：${message}`);
  flushBackendLog();
  if (isSmoke) {
    smokeFailures.push(message);
    finishSmoke(false);
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(
      `document.body.innerHTML = '<div style="padding:40px;font-family:system-ui"><h2>工作台启动失败</h2><pre style="white-space:pre-wrap">${JSON.stringify(message)}</pre><p>完整日志：${JSON.stringify(backendLogPath())}</p></div>'`
    ).catch(() => {});
  } else {
    dialog.showMessageBox({
      type: 'error',
      title: '工作台启动失败',
      message,
      detail: `完整日志：${backendLogPath()}\n\n${backendLog.slice(-30).join('\n')}`,
      buttons: ['退出'],
    }).then(() => {
      quitting = true;
      app.exit(1);
    });
  }
}

function onBackendReady() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    loadAppPage();
    showMainWindow();
    return;
  }
  createMainWindow();
  showMainWindow();
}

/* 只有显式使用 --dev-frontend 时才探测 Vite；不带该标志时加载后端托管页面。 */
function loadAppPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (app.isPackaged || !useDevFrontend) {
    mainWindow.loadURL(backendBaseUrl);
    return;
  }
  const viteUrl = 'http://127.0.0.1:5173';
  let settled = false;
  const done = (viteUp) => {
    if (settled || !mainWindow || mainWindow.isDestroyed()) return;
    settled = true;
    if (viteUp) {
      logLine('检测到前端调试服务（5173），启用热更新…');
      mainWindow.loadURL(viteUrl);
    } else {
      mainWindow.loadURL(backendBaseUrl);
    }
  };
  const probe = http.get(viteUrl, (res) => {
    res.resume();
    done(true);
  });
  probe.setTimeout(1200, () => {
    probe.destroy();
    done(false);
  });
  probe.on('error', () => done(false));
}

/* ---------------------------------------------------------------- 窗口 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: true,
    title: APP_NAME,
    icon: windowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    /* 同源新窗口视为下载（备份、迁移包、附件）；其余交给外部链接策略。 */
    if (isAllowedAppUrl(url)) {
      mainWindow.webContents.downloadURL(url);
    } else {
      handleExternalUrl(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedAppUrl(url)) {
      event.preventDefault();
      handleExternalUrl(url);
    }
  });
  mainWindow.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('did-finish-load', () => {
    logLine('工作台页面加载完成。');
    if (isSmoke) runSmokeChecks();
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logLine(`渲染进程异常：${details.reason}`);
  });
  loadAppPage();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (backendBaseUrl) {
      createMainWindow();
      return;
    }
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (process.platform === 'darwin' && app.isReady()) {
    if (app.dock) app.dock.show();
    app.focus({ steal: true });
  }
  mainWindow.show();
  mainWindow.focus();
}

/* 只允许加载后端回环地址（启用前端调试时额外放行 Vite dev server 同源）；其余导航一律拦截。 */
function isAllowedAppUrl(url) {
  try {
    const target = new URL(url);
    const candidates = [new URL(backendBaseUrl)];
    if (useDevFrontend) candidates.push(new URL('http://127.0.0.1:5173'));
    return candidates.some(base =>
      target.origin === base.origin
      && (target.protocol === 'http:' || target.protocol === 'https:'));
  } catch (_err) {
    return false;
  }
}

/* 外部链接：仅放行 http(s) 与 obsidian://，交给系统浏览器。 */
function handleExternalUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_err) {
    return;
  }
  if (parsed.username || parsed.password) return;
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'obsidian:') {
    shell.openExternal(url).catch(() => {});
  }
}

/* ---------------------------------------------------------------- 下载 */
function setupDownloads() {
  session.defaultSession.on('will-download', (_event, item) => {
    let target = '';
    try {
      /* 必须同步设置保存路径：本机后端毫秒级返回，异步 showSaveDialog 未及
       * setSavePath 时下载已经完成，文件不会写入所选位置。 */
      const defaults = path.join(app.getPath('downloads'), item.getFilename());
      const chosen = dialog.showSaveDialogSync(mainWindow || undefined, {
        title: '保存文件',
        defaultPath: defaults,
      });
      if (!chosen) {
        item.cancel();
        return;
      }
      target = chosen;
      item.setSavePath(chosen);
    } catch (error) {
      logLine(`文件保存失败：${error instanceof Error ? error.message : String(error)}`);
      item.cancel();
      return;
    }
    item.once('done', (_event, state) => {
      if (state === 'completed') {
        logLine(`文件已保存：${target}`);
      } else {
        logLine(`下载未完成（${state}）：${target || item.getFilename() || '未知文件'}`);
      }
    });
  });
}

/* 前端调试模式监听构建产物，变化后自动刷新窗口。 */
function setupStaticWatcher() {
  if (app.isPackaged || !useDevFrontend) return;
  const staticDir = path.join(__dirname, '..', 'backend', 'static');
  if (!fs.existsSync(staticDir)) {
    logLine('未找到前端构建目录，跳过自动刷新监听');
    return;
  }
  let timer = null;
  try {
    fs.watch(staticDir, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          logLine('检测到前端构建更新，自动刷新窗口…');
          mainWindow.webContents.reload();
        }
      }, 400);
    });
  } catch (_error) {
    logLine('前端构建目录监听失败，已跳过自动刷新');
  }
}

/* ---------------------------------------------------------------- 托盘 */
function createTray() {
  const iconPath = trayIconPath();
  if (!iconPath) return;
  const trayIcon = process.platform === 'darwin'
    ? nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 })
    : iconPath;
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip(APP_NAME);
  const petVisible = petWindow && !petWindow.isDestroyed();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开工作台', click: showMainWindow },
    { type: 'separator' },
    {
      label: petVisible ? '隐藏桌面宠物' : '显示桌面宠物',
      click: togglePetWindow,
    },
    { type: 'separator' },
    { label: '退出工作台', click: quitApp },
  ]));
  tray.on('click', showMainWindow);
}

function windowIconPath() {
  if (process.platform === 'darwin') {
    const png = path.join(__dirname, 'assets', 'icon.png');
    return fs.existsSync(png) ? png : undefined;
  }
  const ico = path.join(__dirname, 'assets', 'icon.ico');
  return fs.existsSync(ico) ? ico : undefined;
}

function trayIconPath() {
  if (process.platform === 'darwin') {
    const png = path.join(__dirname, 'assets', 'icon.png');
    if (fs.existsSync(png)) return png;
    return undefined;
  }
  const ico = path.join(__dirname, 'assets', 'icon.ico');
  if (fs.existsSync(ico)) return ico;
  return undefined;
}

/* ---------------------------------------------------------------- 桌面宠物（SUP-09） */
const PET_VALID_STATES = new Set([
  'idle', 'running', 'waving', 'jumping',
  'failed', 'waiting', 'review', 'success', 'sleep', 'reminder',
]);

const PET_STATE_PRIORITY = [
  'failed', 'waiting', 'review', 'running', 'success', 'reminder', 'idle', 'sleep',
];

const PET_TRANSIENT_STATES = new Set(['success', 'waving', 'jumping']);
const PET_TRANSIENT_MIN_MS = { success: 2500, waving: 3000, jumping: 2000 };

const PET_SIZE_MAP = { small: 72, medium: 96, large: 128 };
const PET_BUBBLE_HEIGHT = 48;

const DEFAULT_PET_SETTINGS = {
  enabled: true,
  showOnStartup: true,
  size: 'medium',
  alwaysOnTop: true,
  showBubble: true,
  reducedMotion: false,
  lastPosition: null,
};

function petResourceDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'pet')
    : path.join(__dirname, 'pet');
}

function loadPetManifest() {
  try {
    const manifestPath = path.join(petResourceDir(), 'pet.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const spritesheetPath = manifest.spritesheetPath;
    if (manifest.spriteVersionNumber !== 2 ||
        typeof spritesheetPath !== 'string' ||
        path.basename(spritesheetPath) !== spritesheetPath ||
        !fs.existsSync(path.join(petResourceDir(), spritesheetPath))) {
      return null;
    }
    return {
      id: typeof manifest.id === 'string' ? manifest.id : 'meimei',
      displayName: typeof manifest.displayName === 'string' ? manifest.displayName : '美美',
      description: typeof manifest.description === 'string' ? manifest.description : '',
      spriteVersionNumber: 2,
      spritesheetPath,
    };
  } catch (_err) {
    return null;
  }
}

class PetStateController {
  constructor() {
    this._state = 'idle';
    this._stateSetAt = 0;
    this._pendingState = null;
    this._pendingTimer = null;
  }

  get state() { return this._state; }

  requestState(newState) {
    if (!PET_VALID_STATES.has(newState)) return false;
    if (this._state === newState) return true;
    const newIdx = PET_STATE_PRIORITY.indexOf(newState);
    const curIdx = PET_STATE_PRIORITY.indexOf(this._state);
    const isTransient = PET_TRANSIENT_STATES.has(newState);
    const isIdleOrSleep = this._state === 'idle' || this._state === 'sleep';
    if (isTransient && !isIdleOrSleep && newIdx >= curIdx) {
      if (PET_TRANSIENT_STATES.has(this._state)) {
        const elapsed = Date.now() - this._stateSetAt;
        const minMs = PET_TRANSIENT_MIN_MS[this._state] || 2000;
        if (elapsed < minMs) {
          this._pendingState = newState;
          clearTimeout(this._pendingTimer);
          this._pendingTimer = setTimeout(() => {
            const pending = this._pendingState;
            this._pendingState = null;
            if (pending) this.requestState(pending);
          }, minMs - elapsed);
          return true;
        }
      } else {
        this._pendingState = newState;
        return true;
      }
    }
    this._applyState(newState);
    return true;
  }

    _applyState(newState) {
    const oldState = this._state;
    this._state = newState;
    this._stateSetAt = Date.now();
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('pet:state-change', newState);
    }
    if (PET_TRANSIENT_STATES.has(newState)) {
      const minMs = PET_TRANSIENT_MIN_MS[newState] || 2000;
      clearTimeout(this._pendingTimer);
      this._pendingTimer = setTimeout(() => {
        const pending = this._pendingState;
        this._pendingState = null;
        if (pending) {
          this.requestState(pending);
        } else if (this._state === newState) {
          this._applyState('idle');
        }
      }, minMs);
    }
    if (oldState !== newState && PET_TRANSIENT_STATES.has(oldState) && this._pendingState && !PET_TRANSIENT_STATES.has(newState)) {
      const pending = this._pendingState;
      this._pendingState = null;
      clearTimeout(this._pendingTimer);
      this.requestState(pending);
    }
  }

  reset() {
    clearTimeout(this._pendingTimer);
    this._pendingState = null;
    this._applyState('idle');
  }
}

function loadPetSettings() {
  const settingsPath = path.join(app.getPath('userData'), 'pet-settings.json');
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const saved = JSON.parse(raw);
      return { ...DEFAULT_PET_SETTINGS, ...saved };
    }
  } catch (_err) { /* use defaults */ }
  return { ...DEFAULT_PET_SETTINGS };
}

function savePetSettings() {
  if (!petSettings) return;
  const settingsPath = path.join(app.getPath('userData'), 'pet-settings.json');
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(petSettings, null, 2), 'utf-8');
  } catch (_err) { /* non-critical */ }
}

function petSizePixels() {
  const s = (petSettings && petSettings.size) || 'medium';
  const w = PET_SIZE_MAP[s] || 96;
  return { width: w, height: Math.round(w * 1.08) + PET_BUBBLE_HEIGHT };
}

function defaultPetPosition() {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const { width, height } = petSizePixels();
  return {
    x: workArea.x + workArea.width - width - 20,
    y: workArea.y + workArea.height - height - 20,
  };
}

function clampPetPosition(pos) {
  const { screen } = require('electron');
  const displays = screen.getAllDisplays();
  const { width, height } = petSizePixels();
  for (const display of displays) {
    const wa = display.workArea;
    if (pos.x >= wa.x && pos.x < wa.x + wa.width &&
        pos.y >= wa.y && pos.y < wa.y + wa.height) {
      return pos;
    }
  }
  return defaultPetPosition();
}

function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) return;
  if (!loadPetManifest()) {
    logLine('桌面宠物素材缺失或无效，本次不创建宠物窗口。');
    return;
  }
  const { width, height } = petSizePixels();
  const pos = (petSettings && petSettings.lastPosition) || defaultPetPosition();
  const clamped = clampPetPosition(pos);

  petWindow = new BrowserWindow({
    width,
    height,
    x: clamped.x,
    y: clamped.y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: (petSettings && petSettings.alwaysOnTop) !== false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: app.isPackaged
        ? path.join(process.resourcesPath, 'pet-preload.js')
        : path.join(__dirname, 'pet-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  const petHtmlPath = path.join(petResourceDir(), 'index.html');

  petWindow.loadFile(petHtmlPath).catch(err => {
    logLine(`宠物页面加载失败：${err.message}`);
  });

  petWindow.once('ready-to-show', () => {
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.showInactive();
      if (petStateController) {
        petWindow.webContents.send('pet:state-change', petStateController.state);
      }
    }
  });

  petWindow.on('closed', () => { petWindow = null; });
  petWindow.webContents.on('will-navigate', (event) => { event.preventDefault(); });
  petWindow.webContents.setWindowOpenHandler(() => { return { action: 'deny' }; });
  petWindow.webContents.on('render-process-gone', (_event, details) => {
    logLine(`宠物渲染进程异常：${details.reason}`);
    petWindow = null;
  });

  /* macOS 默认会把整个进程切换为 UIElementApplication，造成主窗口和
   * Dock 短暂隐藏；桌宠只需要跨空间显示，不应改变应用进程类型。 */
  petWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  setupPetIgnoreMouseEvents();
}

function setupPetIgnoreMouseEvents() {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.setIgnoreMouseEvents(true, { forward: true });
}

function closePetWindow() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = petWindow.getBounds();
  if (petSettings) {
    petSettings.lastPosition = { x: bounds.x, y: bounds.y };
    savePetSettings();
  }
  petWindow.destroy();
  petWindow = null;
}

function showPetWindow() {
  if (!petSettings || !petSettings.enabled) return;
  createPetWindow();
}

function hidePetWindow() {
  closePetWindow();
}

function togglePetWindow() {
  if (petWindow && !petWindow.isDestroyed()) {
    hidePetWindow();
    if (petSettings) petSettings.enabled = false;
  } else {
    if (petSettings) petSettings.enabled = true;
    showPetWindow();
  }
  savePetSettings();
  updateTrayMenu();
}

function rebuildPetWindow() {
  if (!petSettings || !petSettings.enabled) return;
  if (petWindow && !petWindow.isDestroyed()) {
    const bounds = petWindow.getBounds();
    if (petSettings) petSettings.lastPosition = { x: bounds.x, y: bounds.y };
    savePetSettings();
  }
  closePetWindow();
  createPetWindow();
}

function setupPetIPC() {
  ipcMain.handle('pet:get-manifest', () => loadPetManifest());

  ipcMain.handle('pet:state-change', (_event, state) => {
    if (typeof state !== 'string' || !PET_VALID_STATES.has(state)) {
      return { ok: false, error: 'Invalid state' };
    }
    if (!petStateController) return { ok: false, error: 'Pet not initialized' };
    petStateController.requestState(state);
    return { ok: true };
  });

  ipcMain.handle('pet:bubble-text', (_event, text) => {
    if (typeof text !== 'string') return { ok: false, error: 'Invalid text' };
    const sanitized = text.slice(0, 100).replace(/[\n\r]/g, ' ');
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('pet:bubble-text', petSettings && petSettings.showBubble ? sanitized : '');
    }
    return { ok: true };
  });

  ipcMain.on('pet:mouse-move', (_event, onPet) => {
    if (!petWindow || petWindow.isDestroyed()) return;
    petWindow.setIgnoreMouseEvents(!onPet, { forward: true });
  });

  ipcMain.on('pet:double-click', () => {
    showMainWindow();
  });

  ipcMain.on('pet:right-click', (_event, x, y) => {
    if (!petWindow || petWindow.isDestroyed()) return;
    const menu = Menu.buildFromTemplate([
      { label: '打开工作台', click: showMainWindow },
      { type: 'separator' },
      {
        label: petWindow && !petWindow.isDestroyed() ? '隐藏桌面宠物' : '显示桌面宠物',
        click: togglePetWindow,
      },
      {
        label: (petSettings && petSettings.alwaysOnTop) ? '取消置顶' : '始终置顶',
        click: () => {
          if (petSettings) petSettings.alwaysOnTop = !petSettings.alwaysOnTop;
          if (petWindow && !petWindow.isDestroyed()) {
            petWindow.setAlwaysOnTop(petSettings.alwaysOnTop);
          }
          savePetSettings();
          updateTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: '小', type: 'radio', checked: (petSettings && petSettings.size) === 'small',
        click: () => { if (petSettings) { petSettings.size = 'small'; savePetSettings(); rebuildPetWindow(); } },
      },
      {
        label: '中', type: 'radio', checked: !petSettings || petSettings.size === 'medium',
        click: () => { if (petSettings) { petSettings.size = 'medium'; savePetSettings(); rebuildPetWindow(); } },
      },
      {
        label: '大', type: 'radio', checked: (petSettings && petSettings.size) === 'large',
        click: () => { if (petSettings) { petSettings.size = 'large'; savePetSettings(); rebuildPetWindow(); } },
      },
      { type: 'separator' },
      {
        label: (petSettings && petSettings.reducedMotion) ? '开启动画' : '减少动画',
        click: () => {
          if (petSettings) petSettings.reducedMotion = !petSettings.reducedMotion;
          if (petWindow && !petWindow.isDestroyed()) {
            petWindow.webContents.send('pet:reduced-motion', petSettings.reducedMotion);
          }
          savePetSettings();
        },
      },
      {
        label: '重置位置',
        click: () => {
          if (petSettings) petSettings.lastPosition = null;
          if (petWindow && !petWindow.isDestroyed()) {
            const pos = defaultPetPosition();
            petWindow.setPosition(pos.x, pos.y);
          }
          savePetSettings();
        },
      },
      { type: 'separator' },
      {
        label: '关闭桌面宠物',
        click: () => {
          if (petSettings) petSettings.enabled = false;
          hidePetWindow();
          savePetSettings();
          updateTrayMenu();
        },
      },
    ]);
    menu.popup({ window: petWindow, x: Math.round(x), y: Math.round(y) });
  });

  let dragging = false;
  let dragOffset = { x: 0, y: 0 };

  ipcMain.on('pet:drag-start', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    dragging = true;
    const winPos = petWindow.getPosition();
    const { screen } = require('electron');
    const cursorPos = screen.getCursorScreenPoint();
    dragOffset = { x: cursorPos.x - winPos[0], y: cursorPos.y - winPos[1] };
  });

  ipcMain.on('pet:drag-end', () => { dragging = false; });

  if (!mainWindow || mainWindow.isDestroyed()) {
    /* handled below in screen watcher */
  }

  function handleDragMove() {
    if (!dragging || !petWindow || petWindow.isDestroyed()) return;
    const { screen } = require('electron');
    const cursorPos = screen.getCursorScreenPoint();
    const newX = cursorPos.x - dragOffset.x;
    const newY = cursorPos.y - dragOffset.y;
    petWindow.setPosition(newX, newY);
  }

  const { screen } = require('electron');
  screen.on('screen-changed', () => {
    if (petWindow && !petWindow.isDestroyed()) {
      const bounds = petWindow.getBounds();
      const clamped = clampPetPosition({ x: bounds.x, y: bounds.y });
      if (clamped.x !== bounds.x || clamped.y !== bounds.y) {
        petWindow.setPosition(clamped.x, clamped.y);
      }
    }
  });

  setInterval(() => {
    if (dragging) handleDragMove();
  }, 16);

  ipcMain.handle('pet:get-settings', () => {
    return {
      size: (petSettings && petSettings.size) || 'medium',
      reducedMotion: !!(petSettings && petSettings.reducedMotion),
      showBubble: !!(petSettings && petSettings.showBubble),
    };
  });

  ipcMain.handle('pet:update-settings', (_event, updates) => {
    if (!updates || typeof updates !== 'object') return { ok: false };
    const allowed = ['size', 'alwaysOnTop', 'showBubble', 'reducedMotion', 'enabled', 'showOnStartup'];
    for (const key of Object.keys(updates)) {
      if (allowed.includes(key)) {
        petSettings[key] = updates[key];
      }
    }
    savePetSettings();
    if (petWindow && !petWindow.isDestroyed()) {
      if (updates.size) rebuildPetWindow();
      if (updates.alwaysOnTop !== undefined) petWindow.setAlwaysOnTop(petSettings.alwaysOnTop);
    }
    return { ok: true };
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const petVisible = petWindow && !petWindow.isDestroyed();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开工作台', click: showMainWindow },
    { type: 'separator' },
    {
      label: petVisible ? '隐藏桌面宠物' : '显示桌面宠物',
      click: togglePetWindow,
    },
    { type: 'separator' },
    { label: '退出工作台', click: quitApp },
  ]));
}

/* ---------------------------------------------------------------- 退出 */
function stopBackend() {
  return new Promise(resolve => {
    if (!backendProcess) {
      resolve();
      return;
    }
    const proc = backendProcess;
    backendProcess = null;
    const force = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_err) { /* 已退出 */ }
      resolve();
    }, 8000);
    proc.once('exit', () => { clearTimeout(force); resolve(); });
    try {
      if (typeof proc.postMessage === 'function') {
        proc.postMessage({ type: 'shutdown' });
      } else if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write('shutdown\n');
      } else {
        proc.kill('SIGTERM');
      }
    } catch (_err) { clearTimeout(force); resolve(); }
  });
}

function quitApp() {
  if (quitting) return;
  quitting = true;
  logLine('退出工作台：正在停止后端服务…');
  closePetWindow();
  stopBackend().then(() => {
    app.quit();
  });
}

app.on('before-quit', event => {
  if (!quitting) {
    event.preventDefault();
    quitApp();
  }
});

app.on('window-all-closed', () => {
  if (quitting) app.quit();
});

app.on('activate', () => showMainWindow());

/* ---------------------------------------------------------------- 更新安装（阶段四） */
async function fetchInstallerPath() {
  if (!backendBaseUrl) throw new Error('后端尚未就绪');
  return new Promise((resolve, reject) => {
    http.get(`${backendBaseUrl}/api/system/update/installer-path`, { timeout: 5000 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const info = JSON.parse(body);
          if (response.statusCode !== 200) reject(new Error(info.detail || `状态码 ${response.statusCode}`));
          else resolve(info);
        } catch (err) {
          reject(new Error(`无法解析安装包信息：${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

function appBundlePath() {
  const exe = app.getPath('exe');
  let current = exe;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    if (current.endsWith('.app')) return current;
    current = parent;
  }
}

function installPackageAndQuit(packagePath) {
  if (process.platform === 'win32') {
    logLine(`启动 Windows 安装器：${packagePath}`);
    const child = spawn(packagePath, [], {
      cwd: path.dirname(packagePath),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } else if (process.platform === 'darwin') {
    const appPath = appBundlePath();
    if (!appPath) {
      failBackend('无法定位当前 macOS 应用目录，更新已取消。');
      return;
    }
    const helper = app.isPackaged
      ? path.join(process.resourcesPath, 'backend', 'updater', 'macos-updater.sh')
      : path.join(__dirname, '..', 'packaging', 'macos-updater.sh');
    if (!fs.existsSync(helper)) {
      failBackend('缺少 macOS 更新助手，更新已取消。');
      return;
    }
    const port = new URL(backendBaseUrl).port;
    const updateDir = path.dirname(packagePath);
    logLine(`启动 macOS 更新助手：${helper}`);
    const child = spawn('/bin/sh', [helper, packagePath, appPath, port, updateDir], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } else {
    failBackend('当前系统暂不支持桌面安装包自动更新。');
    return;
  }
  stopBackend().then(() => app.exit(0));
}

ipcMain.handle('workbench:update:install', async () => {
  try {
    const info = await fetchInstallerPath();
    if (!info || !info.path || !fs.existsSync(info.path)) {
      return { ok: false, error: '安装包不存在或已被删除，请重新下载更新。' };
    }
    installPackageAndQuit(info.path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ---------------------------------------------------------------- 冒烟测试 */
async function runSmokeChecks() {
  try {
    const title = mainWindow.getTitle();
    logLine(`SMOKE_TITLE=${title}`);
    /* Vue 挂载和接口请求是异步的，最多等待 20 秒让首页渲染完成。 */
    let domResult = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      domResult = await mainWindow.webContents.executeJavaScript(
        `({ phone: document.body.innerText.includes('手机访问'), update: document.body.innerText.includes('更新'), ready: document.body.innerText.includes('今天') })`
      );
      if (domResult.phone && domResult.update && domResult.ready) break;
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    const health = await new Promise(resolve => {
      http.get(`${backendBaseUrl}/api/system/health`, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve(body.includes('"ready":true')));
      }).on('error', () => resolve(false));
    });
    const petManifest = loadPetManifest();
    logLine(`SMOKE_ENTRIES=${domResult.phone && domResult.update ? '1' : '0'}`);
    logLine(`SMOKE_BACKEND=${health ? 'ok' : 'fail'}`);
    logLine(`SMOKE_PET=${petManifest && petManifest.spriteVersionNumber === 2 ? 'ok' : 'fail'}`);
    if (!domResult.phone || !domResult.update) smokeFailures.push('页面缺少“手机访问”或“更新”入口');
    if (!health) smokeFailures.push('后端健康检查失败');
    if (!petManifest) smokeFailures.push('桌面宠物 v2 素材缺失或无效');
    if (!domResult.ready) smokeFailures.push('首页未渲染');
    if (smokeFailures.length) {
      const snippet = await mainWindow.webContents.executeJavaScript(
        `document.body.innerText.slice(0, 500).replace(/\\s+/g, ' ').trim()`
      ).catch(() => '');
      logLine(`SMOKE_BODY=${snippet}`);
      throw new Error(smokeFailures.join('；'));
    }
    logLine('SMOKE_OK');
    finishSmoke(true);
  } catch (err) {
    logLine(`SMOKE_FAIL=${err.message}`);
    finishSmoke(false);
  }
}

function finishSmoke(ok) {
  quitting = true;
  setTimeout(() => {
    stopBackend().then(() => {
      app.exit(ok ? 0 : 1);
    });
  }, 300);
}

/* ---------------------------------------------------------------- 生命周期 */
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = path.join(__dirname, 'assets', 'icon.png');
    if (fs.existsSync(dockIcon)) app.dock.setIcon(dockIcon);
  }
  setupDownloads();
  setupStaticWatcher();
  ipcMain.handle('workbench:get-info', () => ({
    isDesktop: true,
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
  }));
  startBackend();

  petSettings = loadPetSettings();
  petStateController = new PetStateController();
  setupPetIPC();

  if (petSettings.enabled && petSettings.showOnStartup && !isSmoke) {
    app.on('browser-window-created', () => {
      setTimeout(() => {
        if (petSettings.enabled && (!petWindow || petWindow.isDestroyed())) {
          createPetWindow();
          if (petStateController) petStateController.requestState('waving');
        }
      }, 1500);
    });
  }

  if (!process.env.WORKBENCH_NO_TRAY) createTray();
});
