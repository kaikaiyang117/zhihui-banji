#!/usr/bin/env node
/* Electron 桌面壳冒烟测试
 *
 * 用临时 WORKBENCH_DATA_DIR / WORKBENCH_KB_DIR 启动 Electron，
 * 检查工作台页面渲染、手机访问/更新入口、后端健康检查；
 * 退出后确认后端进程与端口释放。
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import http from 'http';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = path.join(
  desktopRoot, 'node_modules', '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);

function fail(message, output = '') {
  console.error(`\nSMOKE FAIL: ${message}`);
  if (output) console.error(output);
  process.exit(1);
}

function waitForPortClosed(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const probe = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        if (Date.now() < deadline) setTimeout(probe, 300);
        else resolve(false);
      });
      socket.once('error', () => resolve(true));
    };
    probe();
  });
}

function waitHealthOk(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const probe = () => {
      if (Date.now() > deadline) return resolve(false);
      const req = http.get(`${url}/api/system/health`, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            if (JSON.parse(body).ready) return resolve(true);
          } catch {}
          setTimeout(probe, 400);
        });
      });
      req.on('error', () => setTimeout(probe, 400));
    };
    probe();
  });
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'workbench-electron-smoke-'));
console.log(`临时数据目录：${dataDir}`);

const env = {
  ...process.env,
  WORKBENCH_DATA_DIR: dataDir,
  WORKBENCH_KB_DIR: path.join(dataDir, '知识库'),
  WORKBENCH_SMOKE: '1',
  WORKBENCH_VERSION: '9.8.7',
  WORKBENCH_NO_TRAY: '1',
};

const args = ['.'];
if (process.platform === 'linux') args.push('--no-sandbox');
/* detached 进程组：超时清理时整组 kill，避免 Electron 主进程（.bin/electron 的
 * shim 子进程）孤儿化后持有单实例锁，阻塞后续测试。 */
const child = spawn(electronBin, args, { cwd: desktopRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
function killTree() {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  try { child.kill('SIGKILL'); } catch {}
}

let output = '';
let gotOk = false;
let backendUrl = null;
const markers = {
  SMOKE_TITLE: null,
  SMOKE_ENTRIES: null,
  SMOKE_BACKEND: null,
  SMOKE_OK: false,
  SMOKE_FAIL: null,
};

function handleChunk(chunk) {
  output += chunk;
  for (const line of chunk.toString('utf-8').split(/\r?\n/)) {
    const match = line.match(/^(SMOKE_\w+)=?(.*)$/);
    if (!match) continue;
    const [key, value] = [match[1], match[2]];
    if (key === 'SMOKE_OK') {
      markers.SMOKE_OK = true;
      gotOk = true;
    } else if (key === 'SMOKE_FAIL') {
      markers.SMOKE_FAIL = value;
      gotOk = true;
    } else {
      markers[key] = value;
    }
  }
  const urlMatch = output.match(/WORKBENCH_URL=(http:\/\/127\.0\.0\.1:\d+)/);
  if (urlMatch) backendUrl = urlMatch[1];
}

child.stdout.on('data', handleChunk);
child.stderr.on('data', chunk => { output += chunk; });

const deadline = Date.now() + 150000;
const waiter = new Promise((resolve, reject) => {
  child.once('error', reject);
  const timer = setInterval(() => {
    if (gotOk) {
      clearInterval(timer);
      resolve();
    } else if (Date.now() > deadline) {
      clearInterval(timer);
      reject(new Error('等待冒烟标记超时'));
    }
  }, 200);
});

let exitCode = null;
try {
  await waiter;
  const codePromise = new Promise(resolve => child.once('exit', code => resolve(code)));
  const killTimer = setTimeout(killTree, 30000);
  exitCode = await codePromise;
  clearTimeout(killTimer);
} catch (err) {
  killTree();
  fail(err.message, output);
}

if (exitCode !== 0 || !markers.SMOKE_OK) {
  fail(`Electron 退出码 ${exitCode}，${markers.SMOKE_FAIL || '未输出 SMOKE_OK'}`, output);
}
if (!markers.SMOKE_TITLE || !markers.SMOKE_TITLE.includes('美美大王')) {
  fail(`窗口标题异常：${markers.SMOKE_TITLE}`, output);
}
if (markers.SMOKE_ENTRIES !== '1') {
  fail('页面缺少“手机访问”或“更新”入口', output);
}
if (markers.SMOKE_BACKEND !== 'ok') {
  fail('后端健康检查未通过', output);
}

if (backendUrl) {
  const port = Number(new URL(backendUrl).port);
  const released = await waitForPortClosed(port);
  if (!released) fail(`退出后端口 ${port} 未释放`, output);
} else {
  fail('未捕获 WORKBENCH_URL 输出', output);
}

rmSync(dataDir, { recursive: true, force: true });
console.log('\nElectron 冒烟测试通过：窗口、页面入口、后端生命周期、端口释放均正常。');
process.exit(0);
