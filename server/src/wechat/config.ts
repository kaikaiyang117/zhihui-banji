import { getDb } from '../services/context.js';

export const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';

export const WECHAT_SETTING_KEYS = [
  'wechat_base_url',
  'wechat_client_id',
  'wechat_client_secret',
  'wechat_sync_token',
  'wechat_allow_users',
  'wechat_allow_all',
] as const;

export interface WeChatConfig {
  base_url: string;
  client_id: string;
  client_secret: string;
  sync_token: string;
  allow_users: string[];
  allow_all: boolean;
  source: string;
}

export function getAgentSetting(key: string, fallback = ''): string {
  const row = getDb().connInstance.prepare(
    'SELECT value FROM agent_settings WHERE key=?',
  ).get(key) as { value: string } | undefined;
  return row ? String(row.value) : fallback;
}

export function setAgentSetting(key: string, value: string): void {
  getDb().connInstance.prepare(
    "INSERT INTO agent_settings(key, value, updated_at) VALUES(?,?,datetime('now','localtime')) "
    + 'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
  ).run(key, String(value));
}

export function parseUsers(value: unknown): string[] {
  let items: unknown[];
  if (typeof value === 'string') items = value.split(',');
  else if (Array.isArray(value)) items = value;
  else items = [];
  const result: string[] = [];
  for (const item of items) {
    const userId = String(item).trim();
    if (userId && !result.includes(userId)) result.push(userId);
  }
  return result.slice(0, 200);
}

function loadStored(): Record<string, string> {
  const result: Record<string, string> = {};
  const rows = getDb().connInstance.prepare(
    `SELECT key, value FROM agent_settings WHERE key IN (${WECHAT_SETTING_KEYS.map(() => '?').join(',')})`,
  ).all(...WECHAT_SETTING_KEYS) as Array<{ key: string; value: string }>;
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export function loadConfig(): WeChatConfig {
  const stored = loadStored();
  const env = (name: string): string => String(process.env[name] ?? '');
  const rawAllowUsers = env('MEIMEI_WECHAT_ALLOW_USERS');
  const fromEnv = Boolean(rawAllowUsers.trim());
  const allowUsers = parseUsers(fromEnv ? rawAllowUsers : stored['wechat_allow_users']);
  const allowAll = fromEnv ? false : stored['wechat_allow_all'] === '1';
  return {
    base_url: (env('MEIMEI_WECHAT_BASE_URL') || stored['wechat_base_url'] || DEFAULT_ILINK_BASE_URL).replace(/\/+$/, ''),
    client_id: env('MEIMEI_WECHAT_CLIENT_ID') || stored['wechat_client_id'] || '',
    client_secret: env('MEIMEI_WECHAT_CLIENT_SECRET') || stored['wechat_client_secret'] || '',
    sync_token: env('MEIMEI_WECHAT_SYNC_TOKEN') || stored['wechat_sync_token'] || '',
    allow_users: allowUsers,
    allow_all: allowAll,
    source: fromEnv ? 'environment' : 'local',
  };
}

export function saveConfig(input: Partial<WeChatConfig>): Record<string, unknown> {
  const db = getDb().connInstance;
  const values: Record<string, string> = { ...loadStored() };
  if (input.base_url !== undefined) values['wechat_base_url'] = String(input.base_url).trim().replace(/\/+$/, '');
  if (input.client_id !== undefined) values['wechat_client_id'] = String(input.client_id).trim();
  if (input.client_secret !== undefined) values['wechat_client_secret'] = String(input.client_secret).trim();
  if (input.sync_token !== undefined) values['wechat_sync_token'] = String(input.sync_token).trim();
  if (input.allow_users !== undefined) values['wechat_allow_users'] = parseUsers(input.allow_users).join(',');
  if (input.allow_all !== undefined) values['wechat_allow_all'] = input.allow_all ? '1' : '0';
  const upsert = db.prepare(
    "INSERT INTO agent_settings(key, value, updated_at) VALUES(?,?,datetime('now','localtime')) "
    + 'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
  );
  db.transaction(() => {
    for (const key of WECHAT_SETTING_KEYS) {
      upsert.run(key, values[key] ?? '');
    }
  })();
  return publicConfig();
}

export function publicConfig(): Record<string, unknown> {
  const config = loadConfig();
  return {
    base_url: config.base_url,
    client_id: config.client_id,
    client_secret_set: Boolean(config.client_secret),
    client_secret_masked: mask(config.client_secret),
    sync_token_set: Boolean(config.sync_token),
    sync_token_masked: mask(config.sync_token),
    allow_all: config.allow_all,
    allow_users: config.allow_users,
    source: config.source,
  };
}

export interface WeChatPolicy {
  allow_all: boolean;
  allow_users: string[];
  source: string;
}

export function publicPolicy(): WeChatPolicy {
  const config = loadConfig();
  return {
    allow_all: config.allow_all,
    allow_users: config.allow_users,
    source: config.source,
  };
}

export function updatePolicy(allowUsers: string[], allowAll: boolean): WeChatPolicy {
  saveConfig({ allow_users: allowUsers, allow_all: allowAll });
  return publicPolicy();
}

function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 2)}…${value.slice(-2)}`;
}
