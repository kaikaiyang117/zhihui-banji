import { CredentialStore } from './credentialStore.js';
import { ILinkClient, ILinkError } from './ilinkClient.js';
import type { ILinkCredentials } from './models.js';

export interface QRLogin {
  qrcode: string;
  image_content: string;
  started_at: number;
  status: string;
}

export class AuthService {
  private current: QRLogin | null = null;

  constructor(
    private readonly client: ILinkClient,
    private readonly credentialStore: CredentialStore,
  ) {}

  async start(): Promise<Record<string, unknown>> {
    const payload = await this.client.getBotQrcode();
    const qrcode = String(payload.qrcode || '');
    if (!qrcode) throw new ILinkError('iLink 没有返回二维码标识');
    this.current = {
      qrcode,
      image_content: String(payload.qrcode_img_content || ''),
      started_at: Date.now() / 1000,
      status: 'waiting',
    };
    return this.status();
  }

  async poll(): Promise<Record<string, unknown>> {
    if (!this.current) throw new ILinkError('请先请求新的微信登录二维码');
    const payload = await this.client.getQrcodeStatus(this.current.qrcode);
    const credentials = credentialsFrom(payload);
    if (credentials) {
      this.credentialStore.save(credentials);
      this.client.setCredentials(credentials);
      this.current.status = 'confirmed';
    } else {
      this.current.status = statusFrom(payload);
    }
    const result = this.status();
    if (this.current.status === 'confirmed') {
      result.account_id = credentials ? credentials.account_id : '';
    }
    return result;
  }

  status(): Record<string, unknown> {
    if (!this.current) {
      return { status: 'idle', qrcode: '', qrcode_img_content: '' };
    }
    return {
      status: this.current.status,
      qrcode: this.current.qrcode,
      qrcode_img_content: this.current.image_content,
      started_at: this.current.started_at,
    };
  }
}

function credentialsFrom(payload: Record<string, unknown>): ILinkCredentials | null {
  const token = String(payload.bot_token || payload.ilink_bot_token || '');
  if (!token) return null;
  return {
    bot_token: token,
    base_url: String(payload.base_url || payload.baseurl || 'https://ilinkai.weixin.qq.com').replace(/\/+$/, ''),
    account_id: String(payload.ilink_bot_id || payload.account_id || ''),
    ilink_user_id: String(payload.ilink_user_id || ''),
  };
}

function statusFrom(payload: Record<string, unknown>): string {
  const value = String(payload.status || payload.state || '').toLowerCase();
  if (value === 'confirmed' || value === 'confirm' || value === '2' || value === 'logged_in') {
    return 'confirmed';
  }
  if (value === 'scanned' || value === 'scaned' || value === '1') {
    return 'scanned';
  }
  if (value === 'expired' || value === '3') {
    return 'expired';
  }
  return 'waiting';
}
