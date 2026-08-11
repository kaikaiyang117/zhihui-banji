import { getDb } from '../services/context.js';
import { getAgentSetting, setAgentSetting } from './config.js';
import { ILinkClient, ILinkSessionExpiredError } from './ilinkClient.js';
import { parseTextMessages } from './messageParser.js';
import type { IncomingText } from './models.js';

export type MessageHandler = (message: IncomingText) => Promise<void>;

export class MessageLoop {
  client: ILinkClient;
  handler: MessageHandler;
  cursor: string;
  stopEvent = false;
  lastError = '';
  processed = 0;
  sessionExpired = false;
  private waiters: Array<() => void> = [];
  private failures = new Map<string, number>();

  constructor(client: ILinkClient, handler: MessageHandler) {
    this.client = client;
    this.handler = handler;
    this.cursor = getAgentSetting('wechat.get_updates_buf');
  }

  async run(): Promise<void> {
    let delay = 1.0;
    while (!this.stopEvent) {
      try {
        await this.pollOnce();
        delay = 1.0;
      } catch (error) {
        if (error instanceof ILinkSessionExpiredError) {
          this.lastError = error.message;
          this.sessionExpired = true;
          break;
        }
        this.lastError = error instanceof Error ? error.message : String(error);
        await this.sleepOrStop(delay);
        delay = Math.min(delay * 2, 30.0);
      }
    }
  }

  async pollOnce(): Promise<void> {
    const payload = await this.client.getUpdates(this.cursor);
    for (const message of parseTextMessages(payload)) {
      if (!claimWechatMessage(message.message_id)) continue;
      try {
        await this.handler(message);
      } catch (error) {
        markWechatMessage(message.message_id, 'error');
        const key = failureKey(message);
        const attempts = (this.failures.get(key) ?? 0) + 1;
        if (attempts >= MAX_MESSAGE_RETRIES) {
          /* 连续失败达到上限：标记死信并跳过，不再无限重试同一条消息。 */
          markWechatMessage(message.message_id, 'dead');
          this.failures.delete(key);
          this.lastError = `消息已停止重试（连续失败 ${attempts} 次）：${error instanceof Error ? error.message : String(error)}`;
          continue;
        }
        this.failures.set(key, attempts);
        throw error;
      }
      if (message.message_id) this.failures.delete(message.message_id);
      markWechatMessage(message.message_id, 'processed');
      this.processed += 1;
    }
    const cursor = String(payload.get_updates_buf || '');
    if (cursor) {
      this.cursor = cursor;
      setAgentSetting('wechat.get_updates_buf', cursor);
    }
  }

  stop(): void {
    this.stopEvent = true;
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private async sleepOrStop(seconds: number): Promise<void> {
    if (this.stopEvent) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve();
      }, Math.max(1, Math.round(seconds * 1000)));
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(waiter);
    });
  }
}

function claimWechatMessage(messageId: string): boolean {
  if (!messageId) return true;
  const conn = getDb().connInstance;
  const existing = conn.prepare(
    'SELECT status FROM wechat_message_receipts WHERE message_id=?',
  ).get(messageId) as { status: string } | undefined;
  if (existing && (existing.status === 'processed' || existing.status === 'dead')) return false;
  if (existing) {
    conn.prepare(
      "UPDATE wechat_message_receipts SET status='processing', updated_at=datetime('now','localtime') WHERE message_id=?",
    ).run(messageId);
    return true;
  }
  const inserted = conn.prepare('INSERT INTO wechat_message_receipts(message_id) VALUES(?)').run(messageId);
  return inserted.changes === 1;
}

function markWechatMessage(messageId: string, status: string): void {
  if (!messageId) return;
  getDb().connInstance.prepare(
    "UPDATE wechat_message_receipts SET status=?, updated_at=datetime('now','localtime') WHERE message_id=?",
  ).run(status, messageId);
}

/** 连续失败上限：达到后标记死信并跳过，避免毒消息导致循环卡死。 */
const MAX_MESSAGE_RETRIES = 3;

function failureKey(message: IncomingText): string {
  return message.message_id || `text:${String(message.text ?? '').slice(0, 64)}`;
}
