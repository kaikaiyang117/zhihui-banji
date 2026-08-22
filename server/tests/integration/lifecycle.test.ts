import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(SERVER_ROOT, 'src', 'entry.ts');
// 直接调用 tsx 的 ESM 入口，避免 Windows 把 .cmd shim 当成 JavaScript 交给 Node。
const TSX = path.join(SERVER_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const FIXTURE_STATIC = path.join(SERVER_ROOT, 'tests', 'fixtures', 'static');

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  children.length = 0;
  for (const dir of tempDirs) {
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig02-proc-'));
  tempDirs.push(dir);
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

function waitHealth(url: string, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const probe = (): void => {
      if (Date.now() > deadline) { resolve(false); return; }
      const request = http.get(`${url}/api/system/health`, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try {
            if (JSON.parse(body).ready) { resolve(true); return; }
          } catch { /* 继续轮询 */ }
          setTimeout(probe, 300);
        });
      });
      request.on('error', () => setTimeout(probe, 300));
    };
    probe();
  });
}

async function waitForUrlLine(child: ChildProcess, timeoutMs = 30000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`等待 WORKBENCH_URL 超时：\n${buffer}`));
      }
    }, 500);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf-8');
      const match = buffer.match(/WORKBENCH_URL=(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearInterval(timer);
        child.stdout?.off('data', onData);
        child.stderr?.off('data', onData);
        resolve(match[1]);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
  });
}

function spawnServer(env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [TSX, ENTRY, '--desktop-child'], {
    env: { ...process.env, PYTHONUNBUFFERED: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

describe('子进程生命周期', () => {
  it('desktop-child 输出 WORKBENCH_URL 并可健康检查', async () => {
    const dir = makeTempDir();
    const port = await freePort();
    const child = spawnServer({
      WORKBENCH_DATA_DIR: dir,
      WORKBENCH_STATIC_DIR: FIXTURE_STATIC,
      WORKBENCH_VERSION: '9.8.7',
      WORKBENCH_PORT: String(port),
    });
    const url = await waitForUrlLine(child);
    expect(url).toBe(`http://127.0.0.1:${port}`);
    expect(await waitHealth(url)).toBe(true);
  });

  it('端口被占用时自动切换并输出实际地址', async () => {
    const dir = makeTempDir();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address() as net.AddressInfo;
    const child = spawnServer({
      WORKBENCH_DATA_DIR: dir,
      WORKBENCH_STATIC_DIR: FIXTURE_STATIC,
      WORKBENCH_PORT: String(address.port),
    });
    try {
      const url = await waitForUrlLine(child);
      const actualPort = Number(new URL(url).port);
      expect(actualPort).not.toBe(address.port);
      expect(await waitHealth(url)).toBe(true);
      expect(await portOpen(address.port)).toBe(true); // 占用者不受影响
    } finally {
      blocker.close();
    }
  });

  it('SIGTERM 优雅退出：退出码 0、端口释放、就绪标记清理', async () => {
    const dir = makeTempDir();
    const port = await freePort();
    const child = spawnServer({
      WORKBENCH_DATA_DIR: dir,
      WORKBENCH_STATIC_DIR: FIXTURE_STATIC,
      WORKBENCH_PORT: String(port),
    });
    const url = await waitForUrlLine(child);
    const actualPort = Number(new URL(url).port);
    expect(actualPort).toBe(port);
    expect(await waitHealth(url)).toBe(true);
    const marker = path.join(dir, '.workbench-ready');
    expect(fs.existsSync(marker)).toBe(true);

    const exitPromise = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    if (process.platform === 'win32') child.stdin?.write('shutdown\n');
    else child.kill('SIGTERM');
    const code = await exitPromise;
    expect(code).toBe(0);

    // 端口释放与标记清理（退出后立即检查）
    // 等待端口真正释放（进程退出后监听套接字关闭有短暂窗口）
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && await portOpen(actualPort)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await portOpen(actualPort)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('--version 输出版本', async () => {
    const child = spawn(process.execPath, [TSX, ENTRY, '--version'], {
      env: { ...process.env, WORKBENCH_VERSION: '9.8.7' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(0);
    expect(output.trim()).toBe('智汇·班记 9.8.7');
  });
});
