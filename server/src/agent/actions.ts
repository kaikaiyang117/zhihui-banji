/* AGENT-02 确认写入状态机：预览 → 明确确认（token/哈希复核）→ 备份 → 执行业务服务 → 验证 → 审计。
 * 与 backend/app/agent/actions.py 语义一致；agent_actions 表是写入授权、
 * 参数哈希、TTL、状态与幂等的权威来源（LangGraph interrupt 只负责流程暂停）。
 */
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { getDb, scopeIds } from '../services/context.js';
import { ActionError } from './agentService.js';
import { expireActions, validateArguments } from './agentService.js';
import * as workItems from '../services/workItems.js';
import * as points from '../services/points.js';
import { createCommunication, saveDailyAttendance } from '../services/p0Service.js';

export { ActionError };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function stampOf(value: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} `
    + `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function nowStamp(): string {
  return stampOf(new Date());
}

function tokenHash(token: string, argumentsHash: string): string {
  return sha256(`${token}:${argumentsHash}`);
}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function getPending(actionId: number, sessionId: string, actorId: string, conn: Database):
  { item: Record<string, unknown>; classId: number; termId: number } {
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    'SELECT * FROM agent_actions '
    + 'WHERE id=? AND class_id=? AND term_id=? AND session_id=? AND actor_id=?',
  ).get(Number(actionId), classId, termId, sessionId, actorId) as Record<string, unknown> | undefined;
  if (!row) throw new ActionError('待确认操作不存在或不属于当前会话');
  return { item: { ...row }, classId, termId };
}

function markExpired(item: Record<string, unknown>, conn: Database): Record<string, unknown> {
  if (String(item.status) === 'pending' && String(item.expires_at) < nowStamp()) {
    conn.prepare("UPDATE agent_actions SET status='expired' WHERE id=?").run(item.id);
    item.status = 'expired';
  }
  return item;
}

/** 会话当前待确认操作（已自动过期）。 */
export function pendingForSession(sessionId: string, actorId: string, conn?: Database): Record<string, unknown> | null {
  const db = connOf(conn);
  expireActions(db);
  const row = db.prepare(
    "SELECT * FROM agent_actions WHERE session_id=? AND actor_id=? AND status='pending' "
    + 'ORDER BY id DESC LIMIT 1',
  ).get(sessionId, actorId) as Record<string, unknown> | undefined;
  return row ? { ...row } : null;
}

function argsOf(item: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(item.arguments_json ?? '{}'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not-object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ActionError('待确认参数损坏，未执行写入');
  }
}

function executeOperation(
  toolName: string, args: Record<string, unknown>, actionId: number, conn: Database,
): Record<string, unknown> {
  validateArguments(toolName, args);
  const sourceKey = `agent_action:${actionId}`;
  if (toolName === 'create_task') {
    const result = workItems.createWorkItem({
      title: String(args.title ?? ''), studentId: args.student_id !== undefined
        ? Number(args.student_id) : null,
      sourceType: 'agent_action', sourceId: actionId,
      sourceLabel: 'Agent 创建待办', owner: String(args.owner ?? '班主任'),
      priority: String(args.priority ?? '普通'), scheduledAt: String(args.scheduled_at ?? ''),
      dueAt: String(args.due_at ?? ''), notes: String(args.notes ?? ''), conn,
    });
    return { task_id: result.id, created: result.created };
  }
  if (toolName === 'record_communication') {
    const result = createCommunication({
      studentId: Number(args.student_id), communicatedAt: String(args.communicated_at ?? ''),
      method: String(args.method ?? ''), reason: String(args.reason ?? ''),
      summary: String(args.summary ?? ''), feedback: String(args.feedback ?? ''),
      agreement: String(args.agreement ?? ''), followupAt: String(args.followup_at ?? ''),
      status: String(args.status ?? '已完成'),
      eventId: args.event_id !== undefined && args.event_id !== null ? Number(args.event_id) : null,
      sourceType: 'agent_action', sourceId: String(actionId), sourceKey, conn,
    });
    return result;
  }
  if (toolName === 'save_attendance') {
    return saveDailyAttendance(String(args.date ?? ''), String(args.scene ?? '常规到校'), [{
      student_id: Number(args.student_id), status: String(args.status ?? ''),
      reason: String(args.reason ?? ''), arrive: String(args.arrive ?? ''),
      leave: String(args.leave ?? ''), note: String(args.note ?? ''),
    }]);
  }
  if (toolName === 'record_points') {
    const result = points.createEntry({
      studentId: Number(args.student_id), amount: Number(args.amount),
      occurredAt: String(args.occurred_at ?? ''), category: String(args.category ?? '日常行为'),
      reason: String(args.reason ?? ''), sourceType: 'agent_action',
      sourceId: String(actionId), sourceKey, conn,
    });
    return result;
  }
  throw new ActionError('写入工具不存在');
}

/** 确认后执行：备份 → 执行业务服务 → 状态/结果落库；失败保留备份并标记 failed。 */
export function executeConfirmed(
  actionId: number, options: { sessionId: string; actorId: string; conn?: Database },
): Record<string, unknown> {
  const conn = connOf(options.conn);
  const { item } = getPending(actionId, options.sessionId, options.actorId, conn);
  if (String(item.status) === 'executed') {
    const result = JSON.parse(String(item.result_json ?? '{}')) as Record<string, unknown>;
    return { id: item.id, status: 'executed', result, duplicate: true };
  }
  if (String(item.status) !== 'confirmed') {
    throw new ActionError('操作尚未确认或已失效');
  }
  const backupFile = getDb().createBackupSync(`agent-action-${item.id}`);
  const args = argsOf(item);
  let result: Record<string, unknown>;
  try {
    result = conn.transaction(() => {
      const outcome = executeOperation(String(item.tool_name), args, Number(item.id), conn);
      conn.prepare(
        "UPDATE agent_actions SET status='executed', backup_file=?, result_json=?, executed_at=? WHERE id=?",
      ).run(backupFile, JSON.stringify(outcome), nowStamp(), item.id);
      return outcome;
    })();
  } catch (error) {
    try {
      conn.prepare(
        "UPDATE agent_actions SET status='failed', backup_file=?, result_json=?, executed_at=? WHERE id=?",
      ).run(backupFile, JSON.stringify({ error: String((error as Error).message) }), nowStamp(), item.id);
    } catch {
      // 状态落库失败不掩盖原始错误
    }
    throw new ActionError(`写入失败，已保留备份：${(error as Error).message}`);
  }
  return { id: item.id, status: 'executed', result, backup_file: backupFile, duplicate: false };
}

/** 确认（可选 token 复核）；已执行时幂等返回。 */
export function confirmAction(
  actionId: number, options: { sessionId: string; actorId: string; token?: string; conn?: Database },
): Record<string, unknown> {
  const conn = connOf(options.conn);
  const { item } = getPending(actionId, options.sessionId, options.actorId, conn);
  markExpired(item, conn);
  if (String(item.status) !== 'pending') {
    if (String(item.status) === 'executed') {
      const result = JSON.parse(String(item.result_json ?? '{}')) as Record<string, unknown>;
      return { id: item.id, status: 'executed', result, duplicate: true };
    }
    throw new ActionError('该操作已失效，请重新发起');
  }
  const token = String(options.token ?? '').trim().toUpperCase();
  if (token && tokenHash(token, String(item.arguments_hash)) !== String(item.confirmation_hash)) {
    throw new ActionError('确认码不正确，实际参数未被执行');
  }
  conn.prepare(
    "UPDATE agent_actions SET status='confirmed', confirmed_at=? WHERE id=? AND status='pending'",
  ).run(nowStamp(), item.id);
  return executeConfirmed(Number(item.id), { sessionId: options.sessionId, actorId: options.actorId, conn });
}

export function cancelAction(
  actionId: number, options: { sessionId: string; actorId: string; conn?: Database },
): Record<string, unknown> {
  const conn = connOf(options.conn);
  const { item } = getPending(actionId, options.sessionId, options.actorId, conn);
  if (String(item.status) === 'pending') {
    conn.prepare("UPDATE agent_actions SET status='cancelled' WHERE id=?").run(item.id);
  }
  return { id: item.id, status: 'cancelled' };
}


function successMessage(toolName: string, result: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    create_task: '待办已创建',
    record_communication: '家校沟通已记录',
    save_attendance: '考勤已保存',
    record_points: '行为积分已记录',
  };
  return `${labels[toolName] ?? '操作已完成'}。操作编号：${String(result.id ?? '')}`;
}

/** 处理聊天中的确认/取消；返回 (是否拦截, 用户可见回答)。 */
export function handleConfirmation(
  text: string, options: { sessionId: string; actorId: string; channel: string; conn?: Database },
): [boolean, string] {
  const conn = connOf(options.conn);
  const pending = pendingForSession(options.sessionId, options.actorId, conn);
  if (!pending) return [false, ''];
  const normalized = String(text ?? '').replace(/\s+/g, '').trim().toLowerCase();
  if (normalized === '确认' || normalized === '确认执行' || normalized === '执行'
    || normalized === 'yes' || normalized === 'y' || normalized.startsWith('确认')) {
    try {
      const result = confirmAction(Number(pending.id), {
        sessionId: options.sessionId, actorId: options.actorId, conn,
      });
      return [true, successMessage(String(pending.tool_name), result)];
    } catch (error) {
      if (error instanceof ActionError) {
        return [true, `凯凯小兵没有执行这次操作：${error.message}`];
      }
      throw error;
    }
  }
  if (normalized === '取消' || normalized === '取消执行' || normalized === '不要'
    || normalized === 'no' || normalized === 'n' || normalized.startsWith('取消')) {
    cancelAction(Number(pending.id), { sessionId: options.sessionId, actorId: options.actorId, conn });
    return [true, '已取消这次待确认操作，没有修改业务数据。'];
  }
  return [true, `${String(pending.preview ?? '')} 请先回复“确认”或“取消”。`];
}

