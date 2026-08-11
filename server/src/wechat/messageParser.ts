import type { IncomingText } from './models.js';

export function parseTextMessages(payload: Record<string, unknown>): IncomingText[] {
  const messages: IncomingText[] = [];
  for (const raw of Array.isArray(payload.msgs) ? payload.msgs : []) {
    const message = raw as Record<string, unknown>;
    if (message.message_type === 2) continue;
    const textParts: string[] = [];
    for (const rawItem of Array.isArray(message.item_list) ? message.item_list : []) {
      const item = rawItem as Record<string, unknown>;
      if (item.type === 1) {
        const textItem = item.text_item as Record<string, unknown> | undefined;
        if (textItem && textItem.text) textParts.push(String(textItem.text));
      }
    }
    const text = textParts.join('').trim();
    if (!text) continue;
    messages.push({
      message_id: String(message.message_id || message.seq || ''),
      from_user_id: String(message.from_user_id || ''),
      to_user_id: String(message.to_user_id || ''),
      context_token: String(message.context_token || ''),
      text,
    });
  }
  return messages;
}
