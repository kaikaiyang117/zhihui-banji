import { AgentRunner } from '../agent/runner.js';
import { SessionStore } from '../agent/sessionStore.js';
import { ModelError } from '../agent/modelClient.js';
import { getDb } from '../services/context.js';
import * as workItems from '../services/workItems.js';
import { AuthService } from './authService.js';
import { publicPolicy as configPublicPolicy, updatePolicy as savePolicy, loadConfig, type WeChatPolicy } from './config.js';
import { CredentialStore } from './credentialStore.js';
import { ILinkClient, ILinkError } from './ilinkClient.js';
import { MessageLoop } from './messageLoop.js';
import type { IncomingText } from './models.js';

const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';

export class WeChatService {
  credentials: CredentialStore;
  client: ILinkClient;
  auth: AuthService;
  loop: MessageLoop | null = null;
  loopTask: Promise<void> | null = null;
  reminderTask: Promise<void> | null = null;
  lastError = '';
  recentSenders: string[] = [];
  senderContexts: Record<string, string> = {};
  private reminderStopped = true;
  private reminderTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.credentials = new CredentialStore();
    this.client = new ILinkClient({
      base_url: (process.env.MEIMEI_WECHAT_BASE_URL ?? DEFAULT_ILINK_BASE_URL).replace(/\/+$/, ''),
    });
    this.auth = new AuthService(this.client, this.credentials);
  }

  /** 登录/循环前按最新配置（env > DB agent_settings）刷新客户端；base_url 变化时重建。 */
  private syncConfig(): void {
    const config = loadConfig();
    const envBase = (process.env.MEIMEI_WECHAT_BASE_URL ?? '').replace(/\/+$/, '');
    const target = (envBase || config.base_url || DEFAULT_ILINK_BASE_URL).replace(/\/+$/, '');
    const current = (this.client as unknown as { config?: { base_url?: string } }).config?.base_url ?? '';
    if (current.replace(/\/+$/, '') !== target) {
      this.client = new ILinkClient({ base_url: target });
      this.auth = new AuthService(this.client, this.credentials);
    }
  }

  async startLogin(): Promise<Record<string, unknown>> {
    this.syncConfig();
    return this.auth.start();
  }

  async pollLogin(): Promise<Record<string, unknown>> {
    const result = await this.auth.poll();
    if (result.status === 'confirmed') {
      await this.startLoop();
    }
    return result;
  }

  async startLoop(): Promise<Record<string, unknown>> {
    this.syncConfig();
    if (this.loopTask) return { running: true };
    const credentials = this.credentials.load();
    if (!credentials) {
      throw new ILinkError('微信尚未完成扫码授权，或未设置 MEIMEI_WECHAT_BOT_TOKEN');
    }
    this.client.setCredentials(credentials);
    this.loop = new MessageLoop(this.client, (message) => this.handleMessage(message));
    const task = this.loop.run();
    this.loopTask = task;
    task.then(() => this.clearLoopTask(task), () => this.clearLoopTask(task));
    this.reminderStopped = false;
    this.reminderTask = this.runReminderLoop();
    return { running: true };
  }

  async stop(): Promise<void> {
    if (this.loop) this.loop.stop();
    if (this.loopTask) {
      this.client.abort();
      await Promise.race([this.loopTask, sleep(2000)]);
      this.loopTask = null;
    }
    this.reminderStopped = true;
    if (this.reminderTimer) {
      clearTimeout(this.reminderTimer);
      this.reminderTimer = null;
    }
    if (this.reminderTask) {
      await Promise.race([this.reminderTask, sleep(2000)]);
      this.reminderTask = null;
    }
    await this.client.close();
  }

  status(): Record<string, unknown> {
    const credentials = this.credentials.load();
    const policy = configPublicPolicy();
    const sessionExpired = Boolean(this.loop && this.loop.sessionExpired);
    return {
      configured: Boolean(credentials),
      running: Boolean(this.loopTask),
      login: this.auth.status(),
      last_error: this.loop ? this.loop.lastError : this.lastError,
      processed: this.loop ? this.loop.processed : 0,
      needs_relogin: sessionExpired,
      account_id: credentials ? credentials.account_id : '',
      policy,
      recent_senders: [...this.recentSenders],
    };
  }

  policy(): WeChatPolicy {
    return configPublicPolicy();
  }

  updatePolicy(allowUsers: string[], allowAll: boolean): WeChatPolicy {
    return savePolicy(allowUsers, allowAll);
  }  private async handleMessage(message: IncomingText): Promise<void> {
    this.rememberSender(message.from_user_id);
    this.rememberContext(message.from_user_id, message.context_token);
    const policy = configPublicPolicy();
    if (!policy.allow_all && !policy.allow_users.includes(message.from_user_id)) {
      await this.client.sendMessage(
        message.from_user_id,
        message.context_token,
        `你尚未获得美美工作台的使用授权。请管理员将此用户 ID 加入白名单：${message.from_user_id}`,
      );
      return;
    }
    const command = message.text.trim();
    if (command === '/新会话' || command === '/清空会话') {
      new SessionStore().clearOwned(
        `wechat:${message.from_user_id}`, message.from_user_id, 'wechat');
      await this.client.sendMessage(
        message.from_user_id,
        message.context_token,
        '已清空当前对话上下文，凯凯小兵准备开始新的对话。',
      );
      return;
    }
    const typingTicket = await this.startTyping(message);
    const runner = new AgentRunner();
    let answer: string;
    try {
      answer = await runner.chat(
        `wechat:${message.from_user_id}`,
        message.text,
        { channel: 'wechat', actorId: message.from_user_id },
      );
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      answer = `凯凯小兵暂时无法回答：${error.message}`;
    } finally {
      await this.stopTyping(message, typingTicket);
    }
    await this.client.sendMessage(message.from_user_id, message.context_token, answer);
  }

  private async startTyping(message: IncomingText): Promise<string> {
    try {
      const config = await this.client.getConfig(message.from_user_id, message.context_token);
      const ticket = String(config.typing_ticket || '');
      if (ticket) {
        await this.client.sendTyping(message.from_user_id, ticket, 1);
      }
      return ticket;
    } catch (error) {
      if (error instanceof ILinkError) return '';
      throw error;
    }
  }

  private async stopTyping(message: IncomingText, ticket: string): Promise<void> {
    if (!ticket) return;
    try {
      await this.client.sendTyping(message.from_user_id, ticket, 2);
    } catch (error) {
      if (!(error instanceof ILinkError)) throw error;
    }
  }

  private rememberSender(userId: string): void {
    if (!userId) return;
    this.recentSenders = this.recentSenders.filter((item) => item !== userId);
    this.recentSenders.unshift(userId);
    this.recentSenders.length = Math.min(this.recentSenders.length, 20);
  }

  private rememberContext(userId: string, contextToken: string): void {
    if (userId && contextToken) {
      this.senderContexts[userId] = contextToken;
    }
  }

  private async runReminderLoop(): Promise<void> {
    while (!this.reminderStopped) {
      try {
        await this.sendPendingReminders();
        await this.reminderSleep(15 * 60 * 1000);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        await this.reminderSleep(60 * 1000);
      }
    }
  }

  async sendPendingReminders(): Promise<Record<string, number>> {
    const policy = configPublicPolicy();
    const recipients = policy.allow_all
      ? [...this.recentSenders]
      : [...policy.allow_users];
    const targets = recipients.filter((item) => item in this.senderContexts);
    if (targets.length === 0) return { sent: 0, skipped: 0, recipients: 0 };
    let items = workItems.listWorkItems({ bucket: 'overdue', limit: 30 });
    items = items.concat(workItems.listWorkItems({ bucket: 'today', limit: 30 }));
    const unique = new Map<number, Record<string, unknown>>();
    for (const item of items) unique.set(Number(item.id), item);
    const conn = getDb().connInstance;
    let sent = 0;
    let skipped = 0;
    for (const recipient of targets) {
      for (const item of unique.values()) {
        const reminderKey = `${String(item.status)}:${String(item.due_at || item.scheduled_at || '')}`;
        const exists = conn.prepare(
          'SELECT 1 FROM wechat_reminder_receipts '
          + 'WHERE class_id=? AND term_id=? AND task_id=? AND recipient=? AND reminder_key=?',
        ).get(item.class_id, item.term_id, item.id, recipient, reminderKey);
        if (exists) {
          skipped += 1;
          continue;
        }
        const timing = String(item.timing_state || '待处理');
        let text = `凯凯小兵提醒：${timing}有待处理事项——${String(item.title)}`;
        const webUrl = process.env.MEIMEI_WORKBENCH_WEB_URL ?? '';
        if (webUrl) {
          text += `\n网页处理：${webUrl.replace(/\/+$/, '')}/#/tasks`;
        }
        await this.client.sendMessage(recipient, this.senderContexts[recipient], text);
        conn.prepare(
          'INSERT OR IGNORE INTO wechat_reminder_receipts('
          + 'class_id, term_id, task_id, recipient, reminder_key) VALUES(?,?,?,?,?)',
        ).run(item.class_id, item.term_id, item.id, recipient, reminderKey);
        sent += 1;
      }
    }
    return { sent, skipped, recipients: targets.length };
  }

  private reminderSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.reminderTimer = setTimeout(() => {
        this.reminderTimer = null;
        resolve();
      }, ms);
    });
  }

  private clearLoopTask(task: Promise<void>): void {
    if (this.loopTask === task) this.loopTask = null;
    /* 会话过期后消息循环已停止：继续发提醒只会重复失败，同步暂停提醒。 */
    if (this.loop?.sessionExpired && !this.reminderStopped) {
      this.reminderStopped = true;
      if (this.reminderTimer) {
        clearTimeout(this.reminderTimer);
        this.reminderTimer = null;
      }
      this.lastError = '微信会话已过期，提醒已暂停，请重新扫码登录后恢复。';
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const wechatService = new WeChatService();
