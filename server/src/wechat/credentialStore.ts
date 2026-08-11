import { getDb } from '../services/context.js';
import type { ILinkCredentials } from './models.js';

const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CREDENTIALS_SETTING_KEY = 'wechat_credentials';

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
      getDb().connInstance.prepare(
        "INSERT INTO agent_settings(key, value, updated_at) VALUES(?,?,datetime('now','localtime')) "
        + 'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      ).run(CREDENTIALS_SETTING_KEY, JSON.stringify({
        bot_token: credentials.bot_token,
        base_url: credentials.base_url,
        account_id: credentials.account_id,
        ilink_user_id: credentials.ilink_user_id,
      }));
    } catch (error) {
      throw new CredentialError(`系统凭据库保存失败：${(error as Error).message}`);
    }
  }

  clear(): void {
    try {
      getDb().connInstance.prepare('DELETE FROM agent_settings WHERE key=?').run(CREDENTIALS_SETTING_KEY);
    } catch (error) {
      throw new CredentialError(`系统凭据库清理失败：${(error as Error).message}`);
    }
  }

  private readStored(): Record<string, unknown> {
    try {
      const row = getDb().connInstance.prepare(
        'SELECT value FROM agent_settings WHERE key=?',
      ).get(CREDENTIALS_SETTING_KEY) as { value: string } | undefined;
      if (!row) return {};
      const value = JSON.parse(row.value) as unknown;
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
}
