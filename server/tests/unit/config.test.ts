import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, parseAppVersion, validateBusinessDate } from '../../src/config/index.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

const SAVED_ENV: Record<string, string | undefined> = {};

function saveEnv(keys: string[]): void {
  for (const key of keys) SAVED_ENV[key] = process.env[key];
}

function restoreEnv(keys: string[]): void {
  for (const key of keys) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
}

const ENV_KEYS = ['WORKBENCH_HOST', 'WORKBENCH_PORT', 'WORKBENCH_DATA_DIR', 'WORKBENCH_KB_DIR',
  'WORKBENCH_BUSINESS_DATE', 'WORKBENCH_VERSION', 'WORKBENCH_STATIC_DIR', 'WORKBENCH_LAN',
  'MEIMEI_PACKAGED'];

afterEach(() => restoreEnv(ENV_KEYS));

describe('config 默认值', () => {
  it('默认本机监听 127.0.0.1:5000，非 lan 模式', () => {
    saveEnv(ENV_KEYS);
    const config = loadConfig();
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(5000);
    expect(config.lanMode).toBe(false);
    expect(config.desktopChild).toBe(false);
  });

  it('默认数据目录为项目根 data/（开发模式）', () => {
    saveEnv(ENV_KEYS);
    const config = loadConfig();
    const expectedDataDir = path.join(PROJECT_ROOT, 'data');
    expect(config.dataDir).toBe(expectedDataDir);
    expect(config.readyMarkerPath).toBe(path.join(expectedDataDir, '.workbench-ready'));
  });
});

describe('应用版本文件解析', () => {
  it('兼容 Windows PowerShell UTF-8 BOM', () => {
    expect(parseAppVersion('\uFEFF{"version":"v2.3.9"}')).toBe('2.3.9');
  });

  it('无效内容返回 null', () => {
    expect(parseAppVersion('{invalid')).toBeNull();
  });
});

describe('config 环境变量覆盖', () => {
  it('--lan 切换 0.0.0.0，WORKBENCH_HOST 可覆盖', () => {
    saveEnv(ENV_KEYS);
    delete process.env.WORKBENCH_HOST;
    expect(loadConfig({ lan: true }).host).toBe('0.0.0.0');
    process.env.WORKBENCH_HOST = '192.168.1.5';
    expect(loadConfig({ lan: true }).host).toBe('192.168.1.5');
  });

  it('端口与版本来自环境变量', () => {
    saveEnv(ENV_KEYS);
    process.env.WORKBENCH_PORT = '6100';
    process.env.WORKBENCH_VERSION = 'v2.3.1';
    const config = loadConfig();
    expect(config.port).toBe(6100);
    expect(config.appVersion).toBe('2.3.1');
  });

  it('非法端口抛错', () => {
    saveEnv(ENV_KEYS);
    process.env.WORKBENCH_PORT = 'abc';
    expect(() => loadConfig()).toThrow(/WORKBENCH_PORT/);
  });
});

describe('业务日期校验', () => {
  it('接受合法日期', () => {
    expect(() => validateBusinessDate('2026-04-15')).not.toThrow();
  });

  it('拒绝非法格式与不存在的日期', () => {
    expect(() => validateBusinessDate('2026/04/15')).toThrow();
    expect(() => validateBusinessDate('2026-02-30')).toThrow();
    expect(() => validateBusinessDate('not-a-date')).toThrow();
  });

  it('非法业务日期导致 loadConfig 抛错（启动校验）', () => {
    saveEnv(ENV_KEYS);
    process.env.WORKBENCH_BUSINESS_DATE = '2026-13-01';
    expect(() => loadConfig()).toThrow(/WORKBENCH_BUSINESS_DATE/);
  });
});

describe('static 目录解析', () => {
  it('优先 server/static，缺失时回退 backend/static', () => {
    saveEnv(ENV_KEYS);
    const own = path.join(SERVER_ROOT, 'static');
    const config = loadConfig();
    if (require('node:fs').existsSync(own)) {
      expect(config.staticDir).toBe(own);
    } else {
      expect(config.staticDir.endsWith(path.join('backend', 'static'))).toBe(true);
    }
  });
});
