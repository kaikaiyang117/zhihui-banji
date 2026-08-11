import type { Database } from 'better-sqlite3';

import { getDb } from '../services/context.js';

export class SessionError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

export class SessionStore {
  readonly max_messages: number;

  constructor(maxMessages = 40) {
    this.max_messages = Math.max(10, maxMessages);
  }

  load(sessionId: string, conn?: Database): Array<Record<string, unknown>> {
    return compactMessages(stripPrivateFields(loadAgentSession(sessionId, conn)), this.max_messages);
  }

  save(
    sessionId: string,
    messages: Array<Record<string, unknown>>,
    options: { title?: string | null; conn?: Database } = {},
  ): void {
    let title: string = String(options.title ?? '');
    if (!title) {
      for (const item of messages) {
        if (item.role === 'user') {
          title = String(item.content ?? '').trim().slice(0, 40);
          break;
        }
      }
    }
    if (!title) title = '新会话';
    saveAgentSession(sessionId, compactMessages(stripPrivateFields(capToolMessages(messages)), this.max_messages), title, options.conn);
  }

  clear(sessionId: string, conn?: Database): void {
    connOf(conn).prepare('DELETE FROM agent_sessions WHERE session_id=?').run(sessionId);
  }

  list(prefix = '', conn?: Database): Array<Record<string, unknown>> {
    const db = connOf(conn);
    const rows = prefix
      ? db.prepare(
        'SELECT session_id, title, updated_at, messages FROM agent_sessions WHERE session_id LIKE ? ORDER BY updated_at DESC',
      ).all(`${prefix}%`)
      : db.prepare(
        'SELECT session_id, title, updated_at, messages FROM agent_sessions ORDER BY updated_at DESC',
      ).all();
    const result: Array<Record<string, unknown>> = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      let messages: unknown = [];
      try {
        messages = JSON.parse(String(row.messages ?? '[]'));
      } catch {
        messages = [];
      }
      result.push({
        session_id: row.session_id,
        title: String(row.title ?? '') || '新会话',
        updated_at: row.updated_at ?? '',
        message_count: Array.isArray(messages) ? messages.length : 0,
      });
    }
    return result;
  }

  rename(sessionId: string, title: string, conn?: Database): Record<string, unknown> {
    const db = connOf(conn);
    const clean = String(title ?? '').trim().slice(0, 120);
    if (!clean) throw new SessionError('会话名称不能为空');
    const result = db.prepare(
      "UPDATE agent_sessions SET title=?, updated_at=datetime('now','localtime') WHERE session_id=?",
    ).run(clean, sessionId);
    if (result.changes === 0) throw new SessionError(`会话不存在：${sessionId}`);
    return { session_id: sessionId, title: clean };
  }
}

function loadAgentSession(sessionId: string, conn?: Database): Array<Record<string, unknown>> {
  const row = connOf(conn).prepare(
    'SELECT messages FROM agent_sessions WHERE session_id=?',
  ).get(sessionId) as { messages: string } | undefined;
  if (!row) return [];
  try {
    const value = JSON.parse(row.messages);
    return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

function saveAgentSession(
  sessionId: string,
  messages: Array<Record<string, unknown>>,
  title: string,
  conn?: Database,
): void {
  const db = connOf(conn);
  const titleValue = String(title || '新会话').trim().slice(0, 120) || '新会话';
  db.prepare(
    `INSERT INTO agent_sessions(session_id, messages, title, updated_at) VALUES(?,?,?,datetime('now','localtime'))
     ON CONFLICT(session_id) DO UPDATE SET messages=excluded.messages,
       title=CASE WHEN ? <> '新会话' THEN ? ELSE agent_sessions.title END, updated_at=excluded.updated_at`,
  ).run(sessionId, JSON.stringify(messages), titleValue, titleValue, titleValue);
}

function compactMessages(
  messages: Array<Record<string, unknown>>,
  maxMessages: number,
): Array<Record<string, unknown>> {
  if (messages.length === 0) return [];
  const systemIndex = messages.findIndex((message) => message.role === 'system');
  const system = systemIndex >= 0 ? messages[systemIndex] : null;
  const body = messages.filter((_message, index) => index !== systemIndex);
  const firstUser = body.findIndex((message) => message.role === 'user');
  if (firstUser < 0) return system ? [system] : [];
  const bodyFromUser = body.slice(firstUser);

  const turns: Array<Array<Record<string, unknown>>> = [];
  let current: Array<Record<string, unknown>> = [];
  for (const message of bodyFromUser) {
    if (message.role === 'user' && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);

  const budget = Math.max(1, maxMessages - (system ? 1 : 0));
  const selected: Array<Array<Record<string, unknown>>> = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (used + turn.length <= budget) {
      selected.unshift(turn);
      used += turn.length;
      continue;
    }
    if (selected.length === 0) {
      selected.unshift(shrinkTurn(turn));
    }
    break;
  }

  const compacted: Array<Record<string, unknown>> = [];
  for (const turn of selected) {
    for (const message of turn) compacted.push(message);
  }
  const dropped = turns.slice(0, Math.max(0, turns.length - selected.length));
  const summary = contextSummary(dropped);
  const prefix: Array<Record<string, unknown>> = system ? [system] : [];
  if (summary) {
    prefix.push({ role: 'system', content: summary, context_summary: true });
  }
  return [...prefix, ...compacted];
}

function shrinkTurn(turn: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const user = turn.find((message) => message.role === 'user');
  let final: Record<string, unknown> | null = null;
  for (let index = turn.length - 1; index >= 0; index--) {
    const message = turn[index];
    if (message.role === 'assistant' && !message.tool_calls) {
      final = message;
      break;
    }
  }
  if (user && final) return [user, final];
  return user ? [user] : [];
}

function contextSummary(turns: Array<Array<Record<string, unknown>>>): string {
  if (turns.length === 0) return '';
  const lines: string[] = [];
  for (const turn of turns.slice(-8)) {
    const user = String(turn.find((message) => message.role === 'user')?.content ?? '').trim().slice(0, 180);
    let answer = '';
    for (let index = turn.length - 1; index >= 0; index--) {
      const message = turn[index];
      if (message.role === 'assistant' && !message.tool_calls) {
        answer = String(message.content ?? '').trim().slice(0, 240);
        break;
      }
    }
    if (user) {
      let line = `用户：${user}`;
      if (answer) line += `；助手结论：${answer}`;
      lines.push(line);
    }
  }
  return lines.length > 0
    ? '历史上下文摘要（由本地会话压缩生成，仅保留用户问题和助手结论）：\n' + lines.join('\n')
    : '';
}

function stripPrivateFields(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const clean = { ...message };
    delete clean.reasoning_content;
    return clean;
  });
}

/** 单条工具结果上限：批量查询（如 500 名学生）结果可能很大，超长截断防止会话表膨胀。 */
const TOOL_MESSAGE_CAP = 8000;

function capToolMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role !== 'tool' || typeof message.content !== 'string') return message;
    if (message.content.length <= TOOL_MESSAGE_CAP) return message;
    return { ...message, content: `${message.content.slice(0, TOOL_MESSAGE_CAP)}…（工具结果过长已截断）` };
  });
}
