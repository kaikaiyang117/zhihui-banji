import { randomInt, randomUUID } from 'node:crypto';
import type { ILinkCredentials } from './models.js';

export const ILINK_APP_ID = 'bot';
export const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
export const ILINK_CHANNEL_VERSION = '2.4.6';
export const ILINK_BOT_AGENT = 'MeimeiWorkbench/1.0.0';

const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';

export class ILinkError extends Error {}

export class ILinkSessionExpiredError extends ILinkError {}

export interface ILinkConfig {
  base_url?: string;
  timeout_seconds?: number;
}

export interface HttpResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<HttpResponse>;

const defaultFetch: HttpFetch = (url, init) => fetch(url, {
  method: init.method,
  headers: init.headers,
  body: init.body,
  signal: init.signal,
});

export class ILinkClient {
  config: ILinkConfig;
  credentials: ILinkCredentials | null;
  httpClient: HttpFetch | null;
  private controller: AbortController | null = null;

  constructor(config: ILinkConfig | null = null, credentials: ILinkCredentials | null = null, httpClient: HttpFetch | null = null) {
    this.config = config ?? {};
    this.credentials = credentials;
    this.httpClient = httpClient;
  }

  setCredentials(credentials: ILinkCredentials | null): void {
    this.credentials = credentials;
    if (credentials && credentials.base_url) {
      this.config = {
        base_url: credentials.base_url.replace(/\/+$/, ''),
        timeout_seconds: this.config.timeout_seconds,
      };
    }
  }

  async getBotQrcode(botType = 3): Promise<Record<string, unknown>> {
    return this.request('GET', 'get_bot_qrcode', null, { params: { bot_type: botType }, auth: false });
  }

  async getQrcodeStatus(qrcode: string): Promise<Record<string, unknown>> {
    return this.request('GET', 'get_qrcode_status', null, { params: { qrcode }, auth: false });
  }

  async getUpdates(getUpdatesBuf = ''): Promise<Record<string, unknown>> {
    return this.request('POST', 'getupdates', { get_updates_buf: getUpdatesBuf });
  }

  async sendMessage(toUserId: string, contextToken: string, text: string): Promise<Record<string, unknown>> {
    return this.request('POST', 'sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `meimei-workbench-${randomUUID().replace(/-/g, '')}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
    });
  }

  async getConfig(ilinkUserId: string, contextToken = ''): Promise<Record<string, unknown>> {
    return this.request('POST', 'getconfig', {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
    });
  }

  async sendTyping(ilinkUserId: string, typingTicket: string, status: number): Promise<Record<string, unknown>> {
    return this.request('POST', 'sendtyping', {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
    });
  }

  abort(): void {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  async close(): Promise<void> {
    this.abort();
  }

  private async request(
    method: string,
    endpoint: string,
    body: Record<string, unknown> | null = null,
    options: { params?: Record<string, unknown> | null; auth?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
    };
    let requestBody: Record<string, unknown> | null = body;
    if (options.auth !== false) {
      if (!this.credentials || !this.credentials.bot_token) {
        throw new ILinkError('微信尚未完成扫码授权');
      }
      headers['AuthorizationType'] = 'ilink_bot_token';
      headers['Authorization'] = `Bearer ${this.credentials.bot_token}`;
      headers['X-WECHAT-UIN'] = randomUin();
      if (body !== null) {
        requestBody = {
          ...body,
          base_info: {
            channel_version: ILINK_CHANNEL_VERSION,
            bot_agent: ILINK_BOT_AGENT,
          },
        };
      }
    }
    const baseUrl = (this.config.base_url ?? DEFAULT_ILINK_BASE_URL).replace(/\/+$/, '');
    const query = options.params
      ? '?' + new URLSearchParams(
        Object.entries(options.params).map(([key, value]) => [key, String(value)] as [string, string]),
      ).toString()
      : '';
    const url = `${baseUrl}/ilink/bot/${endpoint}${query}`;
    const http = this.httpClient ?? defaultFetch;
    const controller = new AbortController();
    this.controller = controller;
    try {
      let response: HttpResponse;
      try {
        response = await http(url, {
          method,
          headers,
          body: requestBody !== null ? JSON.stringify(requestBody) : undefined,
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(Math.max(1000, Math.ceil((this.config.timeout_seconds ?? 40) * 1000))),
          ]),
        });
      } catch (error) {
        throw new ILinkError(`iLink 网络请求失败：${(error as Error).message}`);
      }
      if (response.status >= 400) {
        const text = (await response.text()).slice(0, 300);
        throw new ILinkError(`iLink 返回 HTTP ${response.status}: ${text}`);
      }
      const raw = await response.text();
      if (!raw.trim()) return {};
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new ILinkError('iLink 返回了无效 JSON');
      }
      if (typeof data === 'object' && data !== null) {
        const record = data as Record<string, unknown>;
        const ret = record.ret;
        if (ret !== undefined && ret !== null && ret !== 0) {
          const code = record.errcode ?? ret;
          const message = `iLink 错误 ${code}: ${String(record.errmsg ?? '')}`;
          if (String(code) === '-14') {
            throw new ILinkSessionExpiredError('微信 iLink 会话已过期，请重新扫码登录');
          }
          throw new ILinkError(message);
        }
      }
      return (data ?? {}) as Record<string, unknown>;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}

function randomUin(): string {
  const value = String(randomInt(2 ** 32));
  return Buffer.from(value, 'ascii').toString('base64');
}
