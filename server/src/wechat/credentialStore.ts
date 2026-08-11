import { getDb } from '../services/context.js';
import { deleteSecret, deleteSettings, readSecret, writeSecret } from '../services/secretStore.js';
import type { ILinkCredentials } from './models.js';

const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CREDENTIALS_SETTING_KEY = 'wechat_credentials';
const CREDENTIALS_SECRET_FILE = 'wechat-credentials.json';
const LEGACY_CREDENTIALS_SECRET_FILE = 'wechat-config.json';

export class CredentialError extends Error {}

export class CredentialStore {
  load(): ILinkCredentials | null {
    const token = (process.env.MEIMEI_WECHAT_BOT_TOKEN ?? '').trim();
    if (token) {
      return {
        bot_token: token,
        base_url: (process.env.MEIMEI_WECHAT_BASE_URL ?? DEFAULT_ILINK_BASE_URL).replace(/\/+$/, ''),
        account_id: process.env.MEIMEI_WECHAT_ACCOUNT_ID ?? '',
        ilink_user_id: process.env.MEIMEI_WECHAT_USER_ID ?? '',
      };
    }
    const payload = this.readStored();
    if (!payload || !payload.bot_token) return null;
    return {
      bot_token: String(payload.bot_token),
      base_url: String(payload.base_url || DEFAULT_ILINK_BASE_URL).replace(/\/+$/, ''),
      account_id: String(payload.account_id ?? ''),
      ilink_user_id: String(payload.ilink_user_id ?? ''),
    };
  }

  save(credentials: ILinkCredentials): void {
    try {
      writeSecret(CREDENTIALS_SECRET_FILE, {
        bot_token: credentials.bot_token,
        base_url: credentials.base_url,
        account_id: credentials.account_id,
        ilink_user_id: credentials.ilink_user_id,
      });
      deleteSettings(getDb().connInstance, [CREDENTIALS_SETTING_KEY]);
    } catch (error) {
      throw new CredentialError(`系统凭据库保存失败：${(error as Error).message}`);
    }
  }

  clear(): void {
    try {
      deleteSecret(CREDENTIALS_SECRET_FILE);
      deleteSettings(getDb().connInstance, [CREDENTIALS_SETTING_KEY]);
    } catch (error) {
      throw new CredentialError(`系统凭据库清理失败：${(error as Error).message}`);
    }
  }

  private readStored(): Record<string, unknown> {
    try {
      const file = readSecret<Record<string, unknown>>(CREDENTIALS_SECRET_FILE)
        ?? readSecret<Record<string, unknown>>(LEGACY_CREDENTIALS_SECRET_FILE);
      if (file) return file;
      const row = getDb().connInstance.prepare(
        'SELECT value FROM agent_settings WHERE key=?',
      ).get(CREDENTIALS_SETTING_KEY) as { value: string } | undefined;
      if (!row) return {};
      const value = JSON.parse(row.value) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
      const payload = value as Record<string, unknown>;
      writeSecret(CREDENTIALS_SECRET_FILE, payload);
      deleteSettings(getDb().connInstance, [CREDENTIALS_SETTING_KEY]);
      return payload;
    } catch {
      return {};
    }
  }

  migrateStoredCredentials(conn?: import('better-sqlite3').Database): void {
    const db = conn ?? getDb().connInstance;
    const file = readSecret<Record<string, unknown>>(CREDENTIALS_SECRET_FILE);
    const legacyFile = readSecret<Record<string, unknown>>(LEGACY_CREDENTIALS_SECRET_FILE);
    if (!file && legacyFile?.bot_token) writeSecret(CREDENTIALS_SECRET_FILE, legacyFile);
    const row = db.prepare('SELECT value FROM agent_settings WHERE key=?').get(CREDENTIALS_SETTING_KEY) as { value: string } | undefined;
    if (!file && !legacyFile && row) {
      try {
        const value = JSON.parse(row.value) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          writeSecret(CREDENTIALS_SECRET_FILE, value as Record<string, unknown>);
        }
      } catch {
        // 无法解析的旧配置由后续登录流程覆盖。
      }
    }
    if (row) deleteSettings(db, [CREDENTIALS_SETTING_KEY]);
  }
}

export function migrateStoredCredentials(conn?: import('better-sqlite3').Database): void {
  new CredentialStore().migrateStoredCredentials(conn);
}
