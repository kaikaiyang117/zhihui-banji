/* MIG-02 启动入口：CLI / Electron utilityProcess 共用。
 *
 * 用法：
 *   node dist/entry.js [--lan] [--host H] [--port N] [--desktop-child] [--version]
 *
 * --desktop-child：输出单行 WORKBENCH_URL=http://127.0.0.1:<port>（Electron 等待契约）。
 * 默认只监听 127.0.0.1；只有 --lan 才监听 0.0.0.0。
 */
import { buildApp } from './app.js';
import { loadConfig, localIp, type ServerConfig } from './config/index.js';
import { installSignalHandlers, startServer } from './lifecycle.js';
import { WorkbenchDb } from './db/connection.js';
import { setDatabase } from './services/context.js';

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function parseArgs(argv: string[]): {
  lan: boolean;
  host?: string;
  port?: number;
  desktopChild: boolean;
  version: boolean;
} {
  const args = { lan: false, desktopChild: false, version: false } as {
    lan: boolean;
    host?: string;
    port?: number;
    desktopChild: boolean;
    version: boolean;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lan') args.lan = true;
    else if (arg === '--desktop-child') args.desktopChild = true;
    else if (arg === '--version') args.version = true;
    else if (arg === '--host' && argv[i + 1]) { args.host = argv[i + 1]; i += 1; }
    else if (arg === '--port' && argv[i + 1]) { args.port = Number.parseInt(argv[i + 1], 10); i += 1; }
  }
  return args;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const config: ServerConfig = loadConfig({
    lan: args.lan,
    host: args.host,
    port: args.port,
    desktopChild: args.desktopChild,
  });

  if (args.version) {
    print(`${config.appName} ${config.appVersion}`);
    return 0;
  }

  if (config.lanMode) {
    process.env.WORKBENCH_LAN_URL_BASE = `http://${localIp()}:${config.port}`;
    config.lanUrlBase = process.env.WORKBENCH_LAN_URL_BASE;
  }

  // MIG-03：数据库初始化作为启动任务，health.ready 仅在打开成功后为 true。
  const db = new WorkbenchDb({ dataDir: config.dataDir });
  const app = buildApp({ config, ready: () => db.isOpen });
  const result = await startServer(app, config, {
    init: async () => {
      try {
        db.open();
        setDatabase(db);
        print(`数据库就绪（schema v${db.schemaVersion()}）：${db.paths.dbPath}`);
        // 启动时评估规则（失败不阻断启动，与 Python 一致）
        for (const evaluate of ['attendance', 'scores', 'points', 'funds', 'comments', 'education', 'knowledge']) {
          try {
            const module = await import(`./services/${evaluate}.js`);
            if (typeof module.evaluateStartup === 'function') {
              const results = module.evaluateStartup();
              print(`${evaluate} 启动评估完成：${results.length} 个班级`);
            }
          } catch (error) {
            print(`${evaluate} 启动评估失败（不阻断）：${(error as Error).message}`);
          }
        }
        return true;
      } catch (error) {
        print(`数据库初始化失败：${(error as Error).message}`);
        return false;
      }
    },
  });
  const close = result.close;
  result.close = async () => {
    await close();
    db.close();
  };

  // 先安装信号处理器，再输出地址，避免启动方读到地址后立即退出时命中默认信号行为。
  installSignalHandlers(() => result.close(), { log: print });

  print(`美美大王工作台启动中 -> http://localhost:${result.port}`);
  if (config.lanMode) {
    print(`局域网配对入口 -> ${config.lanUrlBase}`);
    print('请在工作台点击"手机访问"生成 5 分钟有效的单次配对二维码。');
    print('安全提示：仅在可信局域网使用，不要将此端口映射到公网。');
  }
  if (config.desktopChild) {
    print(`WORKBENCH_URL=http://127.0.0.1:${result.port}`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/dist/entry.js')) {
  main().catch((error) => {
    print(`启动失败：${(error as Error).message}`);
    process.exit(1);
  });
}
