'use strict';
/* 美美大王工作台 Electron 桌面壳
 *
 * 职责：单实例、窗口、托盘、Node.js 后端子进程、导航限制、
 * 下载/外部协议、更新安装协调和退出生命周期。
 * 渲染进程保持 nodeIntegration:false + contextIsolation:true + sandbox:true，
 * 仅通过 preload 暴露白名单 IPC。
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, session, utilityProcess, nativeImage } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_NAME = 'MeimeiWorkbench';
const HEALTH_TIMEOUT_MS = 90 * 1000;
const isSmoke = process.env.WORKBENCH_SMOKE === '1';

let mainWindow = null;
let tray = null;
let backendProcess = null;
let backendBaseUrl = null;
let backendLog = [];
let healthStartedAt = 0;
let quitting = false;
let smokeFailures = [];

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
 * 开发模式（未打包）使用系统 Node 子进程：server/node_modules 为系统 Node ABI，
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
  try {
    if (useUtility) {
      backendProcess = utilityProcess.fork(entry, backendArgs, {
        cwd: backendDir,
        env: backendProcessEnv(),
        stdio: 'pipe',
      });
    } else {
      backendProcess = spawn(resolveNodeCommand(), [entry, ...backendArgs], {
        cwd: backendDir,
        env: backendProcessEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
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
    mainWindow.loadURL(backendBaseUrl);
    return;
  }
  createMainWindow();
}

/* ---------------------------------------------------------------- 窗口 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
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
  mainWindow.loadURL(backendBaseUrl);
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
  mainWindow.show();
  mainWindow.focus();
}

/* 只允许加载当前后端回环地址；其余导航一律拦截。 */
function isAllowedAppUrl(url) {
  try {
    const target = new URL(url);
    const base = new URL(backendBaseUrl);
    if (target.origin !== base.origin) return false;
    return target.protocol === 'http:' || target.protocol === 'https:';
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
    const defaults = path.join(app.getPath('downloads'), item.getFilename());
    dialog.showSaveDialog(mainWindow || undefined, {
      title: '保存文件',
      defaultPath: defaults,
    }).then(result => {
      if (result.canceled || !result.filePath) {
        item.cancel();
        return;
      }
      item.setSavePath(result.filePath);
    }).catch(() => item.cancel());
  });
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开工作台', click: showMainWindow },
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
    try { proc.kill('SIGTERM'); } catch (_err) { clearTimeout(force); resolve(); }
  });
}

function quitApp() {
  if (quitting) return;
  quitting = true;
  logLine('退出工作台：正在停止后端服务…');
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
    logLine(`SMOKE_ENTRIES=${domResult.phone && domResult.update ? '1' : '0'}`);
    logLine(`SMOKE_BACKEND=${health ? 'ok' : 'fail'}`);
    if (!domResult.phone || !domResult.update) smokeFailures.push('页面缺少“手机访问”或“更新”入口');
    if (!health) smokeFailures.push('后端健康检查失败');
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
  if (!process.env.WORKBENCH_NO_TRAY) createTray();
});
