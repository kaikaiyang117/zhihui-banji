/* MIG-02 生命周期：端口探测、监听、就绪标记、信号处理与优雅退出。 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import net from 'node:net';

import type { ServerConfig } from './config/index.js';

export interface StartupTasks {
  /** 数据库初始化等任务（MIG-03 接入）；返回 false 表示启动失败。 */
  init?: () => Promise<boolean>;
}

/** 从请求端口开始寻找可绑定端口（与 Python find_available_port 语义一致）。 */
export function findAvailablePort(host: string, requested: number, attempts = 100): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = requested;
    const tryBind = (): void => {
      if (port >= requested + attempts) {
        reject(new Error(`无法在 ${requested}-${requested + attempts - 1} 找到可用端口`));
        return;
      }
      const server = net.createServer();
      server.once('error', () => {
        port += 1;
        tryBind();
      });
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port, host);
    };
    tryBind();
  });
}

/** 写入就绪标记（Electron 等待契约的一部分，MIG-03 后由数据库初始化完成后再写入）。 */
export function writeReadyMarker(config: ServerConfig): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(config.readyMarkerPath, String(process.pid), 'utf-8');
  } catch (error) {
    throw new Error(`无法写入就绪标记 ${config.readyMarkerPath}：${(error as Error).message}`);
  }
}

export function clearReadyMarker(config: ServerConfig): void {
  try {
    fs.rmSync(config.readyMarkerPath, { force: true });
  } catch {
    // 标记清理失败不阻塞退出
  }
}

export interface StartResult {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** 启动服务：绑定端口、执行启动任务、监听；返回实际地址与关闭函数。 */
export async function startServer(
  app: FastifyInstance,
  config: ServerConfig,
  tasks: StartupTasks = {},
): Promise<StartResult> {
  const port = await findAvailablePort(config.host, config.port);
  if (port !== config.port) {
    app.log.warn({ requested: config.port, actual: port }, '端口被占用，已自动切换');
  }

  if (tasks.init) {
    const ok = await tasks.init();
    if (!ok) throw new Error('启动任务未完成，服务退出');
  }

  writeReadyMarker(config);
  await app.listen({ host: config.host, port });

  const hostForUrl = config.lanMode && config.host !== '127.0.0.1' ? config.host : '127.0.0.1';
  const url = `http://${hostForUrl}:${port}`;

  return {
    url,
    port,
    close: async () => {
      await app.close();
      clearReadyMarker(config);
    },
  };
}

/** 优雅退出：等待超时后强制退出。 */
export function installSignalHandlers(
  close: () => Promise<void>,
  options: { timeoutMs?: number; log?: (message: string) => void; controlChannel?: boolean } = {},
): void {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在优雅退出…`);
    const force = setTimeout(() => {
      log('优雅退出超时，强制退出');
      process.exit(1);
    }, timeoutMs);
    force.unref();
    void close().then(() => {
      clearTimeout(force);
      log('服务已关闭，端口已释放');
      process.exit(0);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  if (options.controlChannel) {
    const parentPort = (process as NodeJS.Process & {
      parentPort?: { on: (event: 'message', listener: (messageEvent: { data?: unknown }) => void) => void };
    }).parentPort;
    parentPort?.on('message', (messageEvent) => {
      const data = messageEvent?.data;
      if (data === 'shutdown' || (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'shutdown')) {
        shutdown('桌面进程关闭请求');
      }
    });

    if (!process.stdin.destroyed) {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        if (chunk.split(/\r?\n/).some((line) => line.trim() === 'shutdown')) {
          shutdown('桌面进程关闭请求');
        }
      });
    }
  }
}
