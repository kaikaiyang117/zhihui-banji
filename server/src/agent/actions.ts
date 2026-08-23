/* AGENT-02 确认写入状态机：预览 → 明确确认（token/哈希复核）→ 备份 → 执行业务服务 → 验证 → 审计。
 * agent_actions 表是写入授权、
 * 参数哈希、TTL、状态与幂等的权威来源（LangGraph interrupt 只负责流程暂停）。
 */
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { getDb, scopeIds } from '../services/context.js';
import { ActionError } from './agentService.js';
import { expireActions, validateArguments } from './agentService.js';
import * as workItems from '../services/workItems.js';
import * as points from '../services/points.js';
import * as education from '../services/education.js';
import * as classTasks from '../services/classTasks.js';
import * as knowledge from '../services/knowledge.js';
import {
  createCommunication, createEvent, createFocus, getAttendanceRecord, getCommunication,
  getEvent, getFocus, saveDailyAttendance,
} from '../services/p0Service.js';
import { buildRollCallRecords, getSession, deleteSession } from './tools/fieldOperations.js';
import { executeImportPlan, getPlanForAccess } from '../excel/imports/importPlanService.js';

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

/** 写入工具同时兼容内部学生 ID 和教师常用的学号，统一转换为业务服务使用的内部 ID。 */
function resolveStudentId(value: unknown, conn: Database): number {
  const raw = String(value ?? '').trim();
  const numericId = Number.isInteger(Number(raw)) ? Number(raw) : -1;
  const [classId, termId] = scopeIds({ write: true, conn });
  const row = conn.prepare(
    'SELECT s.id FROM students s JOIN student_enrollments e ON e.student_id=s.id '
    + "WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at='' "
    + 'AND (s.id=? OR s.学号=?) LIMIT 1',
  ).get(classId, termId, numericId, raw) as { id: number } | undefined;
  if (!row) throw new ActionError('学生不在当前班级和学期中，或当前不是在读状态');
  return Number(row.id);
}

function resolveStudentIds(value: unknown, conn: Database): number[] {
  if (!Array.isArray(value)) throw new ActionError('student_ids必须是学生 ID 或学号数组');
  return value.map((item) => resolveStudentId(item, conn));
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

/** Return durable action state for rebuilding conversation cards after reload. */
export function listSessionActions(
  sessionId: string, actorId: string, channel: string, conn?: Database,
): Array<Record<string, unknown>> {
  const db = connOf(conn);
  expireActions(db);
  const [classId, termId] = scopeIds({ conn: db });
  const rows = db.prepare(
    'SELECT id, class_id, term_id, session_id, channel, actor_id, tool_name, arguments_json, preview, status, '
    + 'expires_at, result_json, created_at, confirmed_at, executed_at '
    + 'FROM agent_actions WHERE session_id=? AND actor_id=? AND channel=? AND class_id=? AND term_id=? '
    + 'ORDER BY id ASC',
  ).all(sessionId, actorId, channel, classId, termId) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    let result: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(String(row.result_json ?? '{}'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed as Record<string, unknown>;
    } catch { /* ignore malformed historical result */ }
    let businessPreview: Record<string, unknown> | null = null;
    if (String(row.tool_name) === 'execute_excel_import') {
      try {
        const args = JSON.parse(String(row.arguments_json ?? '{}')) as Record<string, unknown>;
        const plan = getPlanForAccess(String(args.plan_id ?? ''), {
          ownerId: actorId, channel, sessionId, classId, termId,
        }, db);
        businessPreview = {
          plan_id: plan.id, adapter_id: plan.adapterId, artifact_id: plan.artifactId,
          preview_hash: plan.previewHash, preview: plan.preview,
        };
      } catch { /* the plan may have expired; the action status remains useful */ }
    }
    return {
      action_id: Number(row.id), tool_name: String(row.tool_name), status: String(row.status),
      preview: String(row.preview ?? ''), expires_at: String(row.expires_at ?? ''),
      created_at: String(row.created_at ?? ''), confirmed_at: String(row.confirmed_at ?? ''),
      executed_at: String(row.executed_at ?? ''), result, business_preview: businessPreview,
    };
  });
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
    const studentId = args.student_id !== undefined
      ? resolveStudentId(args.student_id, conn) : null;
    const result = workItems.createWorkItem({
      title: String(args.title ?? ''), studentId,
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
    }], { conn });
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
  if (toolName === 'update_task') {
    const result = workItems.updateWorkItem(Number(args.task_id), {
      title: args.title !== undefined ? String(args.title) : undefined,
      owner: args.owner !== undefined ? String(args.owner) : undefined,
      priority: args.priority !== undefined ? String(args.priority) : undefined,
      scheduledAt: args.scheduled_at !== undefined ? String(args.scheduled_at) : undefined,
      dueAt: args.due_at !== undefined ? String(args.due_at) : undefined,
      status: args.status !== undefined ? String(args.status) : undefined,
      notes: args.notes !== undefined ? String(args.notes) : undefined,
      result: args.result !== undefined ? String(args.result) : undefined,
      conn,
    });
    return { task_id: result.id, status: result.status, updated: true };
  }
  if (toolName === 'create_event') {
    return createEvent({
      studentId: resolveStudentId(args.student_id, conn), occurredAt: String(args.occurred_at ?? ''),
      eventType: String(args.event_type ?? ''), description: String(args.description ?? ''),
      handling: String(args.handling ?? ''), parentContacted: Boolean(args.parent_contacted),
      needsFollowup: Boolean(args.needs_followup), followupDue: String(args.followup_due ?? ''),
      status: String(args.status ?? '已完成'), conn,
    });
  }
  if (toolName === 'create_focus') {
    return createFocus({
      studentId: resolveStudentId(args.student_id, conn), topic: String(args.topic ?? ''),
      reason: String(args.reason ?? ''), evidence: String(args.evidence ?? ''),
      actionPlan: String(args.action_plan ?? ''), status: String(args.status ?? '待确认'),
      nextReviewAt: String(args.next_review_at ?? ''), conn,
    });
  }
  if (toolName === 'create_meeting') {
    const result = education.createMeeting({
      heldOn: String(args.held_on ?? ''), topic: String(args.topic ?? ''),
      format: String(args.format ?? '主题班会'), content: String(args.content ?? ''),
      participation: String(args.participation ?? ''), conclusion: String(args.conclusion ?? ''),
      status: String(args.status ?? '已记录'),
      studentIds: args.student_ids === undefined ? [] : resolveStudentIds(args.student_ids, conn),
      actionItems: Array.isArray(args.action_items) ? args.action_items as Array<Record<string, unknown>> : null,
      followupTitle: String(args.followup_title ?? ''), followupDue: String(args.followup_due ?? ''), conn,
    });
    return { meeting_id: result.id, topic: result.topic, held_on: result.held_on };
  }
  if (toolName === 'create_activity') {
    const result = education.createActivity({
      occurredOn: String(args.occurred_on ?? ''), name: String(args.name ?? ''),
      activityType: String(args.activity_type ?? '其他'), budget: args.budget,
      participantCount: args.participant_count, summary: String(args.summary ?? ''),
      result: String(args.result ?? ''), retrospective: String(args.retrospective ?? ''),
      status: String(args.status ?? '计划中'),
      studentIds: args.student_ids === undefined ? [] : resolveStudentIds(args.student_ids, conn),
      followupTitle: String(args.followup_title ?? ''), followupDue: String(args.followup_due ?? ''), conn,
    });
    return { activity_id: result.id, name: result.name, occurred_on: result.occurred_on };
  }
  if (toolName === 'create_diary') {
    const result = education.createDiary({
      diaryDate: String(args.diary_date ?? ''), weather: String(args.weather ?? ''),
      work: String(args.work ?? ''), event: String(args.event ?? ''),
      reflection: String(args.reflection ?? ''), todo: String(args.todo ?? ''), conn,
    });
    return { diary_id: result.id, diary_date: result.diary_date };
  }
  if (toolName === 'create_knowledge_note') {
    const result = knowledge.createNote({
      title: String(args.title ?? ''), category: String(args.category ?? '个人成长'),
      template: String(args.template ?? ''), content: String(args.content ?? ''),
      tags: Array.isArray(args.tags) ? args.tags.map((item) => String(item)) : [], conn,
    });
    return { note_id: result.id, title: result.title, relative_path: result.relative_path };
  }
  if (toolName === 'create_class_task') {
    const result = classTasks.createTask({
      title: String(args.title ?? ''), taskType: String(args.task_type ?? '材料收集'),
      startAt: String(args.start_at ?? ''), dueAt: String(args.due_at ?? ''),
      materialName: String(args.material_name ?? ''), description: String(args.description ?? ''),
      studentIds: resolveStudentIds(args.student_ids, conn),
      templateId: args.template_id !== undefined && args.template_id !== null ? Number(args.template_id) : null, conn,
    });
    return { class_task_id: result.id, title: result.title, student_count: result.total };
  }
  if (toolName === 'submit_roll_call_exceptions') {
    const session = getSession(String(args.session_id ?? ''));
    if (!session) throw new ActionError('点名会话不存在或已过期');
    const records = buildRollCallRecords(args);
    const result = saveDailyAttendance(session.date, session.scene, records, { conn });
    deleteSession(String(args.session_id));
    const exceptionRecords = records.filter((record) => String(record.status ?? '出勤') !== '出勤');
    return {
      ok: true,
      date: session.date,
      scene: session.scene,
      saved: result.saved,
      normal_count: session.students.length - exceptionRecords.length,
      exceptions: exceptionRecords.map((record) => ({
        student_id: Number(record.student_id),
        status: String(record.status ?? '出勤'),
        reason: String(record.reason ?? ''),
      })),
    };
  }
  throw new ActionError('写入工具不存在');
}

async function executeOperationAsync(
  toolName: string, args: Record<string, unknown>, actionId: number, conn: Database,
  action: Record<string, unknown>, sessionId: string, actorId: string,
): Promise<Record<string, unknown>> {
  if (toolName !== 'execute_excel_import') return executeOperation(toolName, args, actionId, conn);
  const classId = Number(action.class_id);
  const termId = Number(action.term_id);
  const result = await executeImportPlan({
    id: String(args.plan_id), previewHash: String(args.preview_hash),
    requestId: String(args.request_id ?? `excel-action-${actionId}`),
    access: {
      ownerId: actorId, channel: String(action.channel ?? 'web'), sessionId, classId, termId,
    }, conn,
  });
  return result;
}

function verifyOperation(
  toolName: string, args: Record<string, unknown>, outcome: Record<string, unknown>, conn: Database,
): Record<string, unknown> {
  const checks: Array<Record<string, unknown>> = [];
  const check = (name: string, passed: boolean, evidence: Record<string, unknown>): void => {
    checks.push({ name, passed, evidence });
    if (!passed) throw new ActionError(`写入结果验证失败：${name}`);
  };
  if (toolName === 'create_task') {
    const row = workItems.getWorkItem(Number(outcome.task_id), { conn });
    check('task_persisted', String(row.title) === String(args.title), {
      task_id: row.id, title: row.title, student_id: row.student_id,
    });
  } else if (toolName === 'record_communication') {
    const row = getCommunication(Number(outcome.communication_id), { conn });
    check('communication_persisted',
      Number(row.student_id) === Number(args.student_id)
      && String(row.summary) === String(args.summary), {
        communication_id: row.id, student_id: row.student_id,
      });
  } else if (toolName === 'save_attendance') {
    const row = getAttendanceRecord({
      studentId: Number(args.student_id), attendanceDate: String(args.date ?? ''),
      scene: String(args.scene ?? '常规到校'), conn,
    });
    check('attendance_persisted', String(row.status) === String(args.status), {
      attendance_id: row.id, student_id: row.student_id,
      date: row.attendance_date, scene: row.scene, status: row.status,
    });
  } else if (toolName === 'record_points') {
    const row = points.getEntry(Number(outcome.id), { conn });
    check('points_persisted',
      Number(row.student_id) === Number(args.student_id)
      && Number(row.amount) === Number(args.amount), {
      point_entry_id: row.id, student_id: row.student_id, amount: row.amount,
    });
  } else if (toolName === 'update_task') {
    const row = workItems.getWorkItem(Number(outcome.task_id), { conn });
    const matches = (key: string, rowKey = key): boolean => (
      args[key] === undefined || String(row[rowKey]) === String(args[key])
    );
    check('task_updated', matches('title') && matches('status') && matches('priority')
      && matches('due_at') && matches('result'), {
      task_id: row.id, status: row.status, title: row.title,
    });
  } else if (toolName === 'create_event') {
    const row = getEvent(Number(outcome.event_id), { conn });
    check('event_persisted', String(row.event_type) === String(args.event_type)
      && String(row.description) === String(args.description), {
      event_id: row.id, student_id: row.student_id, event_type: row.event_type,
    });
  } else if (toolName === 'create_focus') {
    const row = getFocus(Number(outcome.focus_id), { conn });
    check('focus_persisted', String(row.topic) === String(args.topic)
      && String(row.reason) === String(args.reason), {
      focus_id: row.id, student_id: row.student_id, topic: row.topic,
    });
  } else if (toolName === 'create_meeting') {
    const row = education.getMeeting(Number(outcome.meeting_id), { conn });
    check('meeting_persisted', String(row.topic) === String(args.topic)
      && String(row.held_on) === String(args.held_on), {
      meeting_id: row.id, topic: row.topic, held_on: row.held_on,
    });
  } else if (toolName === 'create_activity') {
    const row = education.getActivity(Number(outcome.activity_id), { conn });
    check('activity_persisted', String(row.name) === String(args.name)
      && String(row.occurred_on) === String(args.occurred_on), {
      activity_id: row.id, name: row.name, occurred_on: row.occurred_on,
    });
  } else if (toolName === 'create_diary') {
    const row = education.getDiary(Number(outcome.diary_id), { conn });
    check('diary_persisted', String(row.diary_date) === String(args.diary_date), {
      diary_id: row.id, diary_date: row.diary_date,
    });
  } else if (toolName === 'create_knowledge_note') {
    const row = knowledge.readNote(String(outcome.relative_path), { conn });
    check('knowledge_note_persisted', Number(row.id) === Number(outcome.note_id)
      && String(row.title) === String(args.title), {
      note_id: row.id, relative_path: row.relative_path, title: row.title,
    });
  } else if (toolName === 'create_class_task') {
    const row = classTasks.getTask(Number(outcome.class_task_id), { conn });
    check('class_task_persisted', String(row.title) === String(args.title)
      && Number(row.total) === (args.student_ids as unknown[]).length, {
      class_task_id: row.id, title: row.title, student_count: row.total,
    });
  } else if (toolName === 'submit_roll_call_exceptions') {
    const exceptions = Array.isArray(outcome.exceptions)
      ? outcome.exceptions as Array<Record<string, unknown>>
      : [];
    const date = String(outcome.date ?? '');
    const scene = String(outcome.scene ?? '常规到校');
    let verifiedCount = 0;
    for (const ex of exceptions) {
      try {
        const row = getAttendanceRecord({
          studentId: Number(ex.student_id), attendanceDate: date, scene, conn,
        });
        if (String(row.status) === String(ex.status)) verifiedCount += 1;
      } catch { /* record not found */ }
    }
    check('roll_call_exceptions_persisted', verifiedCount === exceptions.length, {
      date, scene, verified_count: verifiedCount, exception_count: exceptions.length,
    });
  } else {
    throw new ActionError('写入工具没有配置结果验证器');
  }
  return { ok: true, checks };
}

/** 确认后执行：备份 → 执行业务服务 → 状态/结果落库；失败保留备份并标记 failed。 */
export function executeConfirmed(
  actionId: number, options: { sessionId: string; actorId: string; conn?: Database },
): Record<string, unknown> {
  const conn = connOf(options.conn);
  const { item } = getPending(actionId, options.sessionId, options.actorId, conn);
  if (String(item.status) === 'executed') {
    const result = JSON.parse(String(item.result_json ?? '{}')) as Record<string, unknown>;
    return {
      id: item.id, status: 'executed', result,
      verification: result.verification ?? null, duplicate: true,
    };
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
      const verification = verifyOperation(String(item.tool_name), args, outcome, conn);
      const verifiedResult = { ...outcome, verification };
      conn.prepare(
        "UPDATE agent_actions SET status='executed', backup_file=?, result_json=?, executed_at=? WHERE id=?",
      ).run(backupFile, JSON.stringify(verifiedResult), nowStamp(), item.id);
      return verifiedResult;
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
  return {
    id: item.id, status: 'executed', result,
    verification: result.verification ?? null,
    backup_file: backupFile, duplicate: false,
  };
}

/** 异步确认执行入口，供 Excel Artifact 适配器使用；普通 Agent 写工具继续复用同步入口。 */
export async function executeConfirmedAsync(
  actionId: number, options: { sessionId: string; actorId: string; conn?: Database },
): Promise<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const { item } = getPending(actionId, options.sessionId, options.actorId, conn);
  if (String(item.status) === 'executed') {
    const result = JSON.parse(String(item.result_json ?? '{}')) as Record<string, unknown>;
    return { id: item.id, status: 'executed', result, verification: result.verification ?? null, duplicate: true };
  }
  if (String(item.status) !== 'confirmed') throw new ActionError('操作尚未确认或已失效');
  const backupFile = getDb().createBackupSync(`agent-action-${item.id}`);
  const args = argsOf(item);
  try {
    const result = await executeOperationAsync(
      String(item.tool_name), args, Number(item.id), conn, item, options.sessionId, options.actorId,
    );
    conn.prepare(
      "UPDATE agent_actions SET status='executed', backup_file=?, result_json=?, executed_at=? WHERE id=?",
    ).run(backupFile, JSON.stringify(result), nowStamp(), item.id);
    return { id: item.id, status: 'executed', result, verification: result.verification ?? null, backup_file: backupFile, duplicate: false };
  } catch (error) {
    try {
      conn.prepare(
        "UPDATE agent_actions SET status='failed', backup_file=?, result_json=?, executed_at=? WHERE id=?",
      ).run(backupFile, JSON.stringify({ error: String((error as Error).message) }), nowStamp(), item.id);
    } catch { /* 状态落库失败不掩盖原始错误 */ }
    throw new ActionError(`写入失败，已保留备份：${(error as Error).message}`);
  }
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
      return {
        id: item.id, status: 'executed', result,
        verification: result.verification ?? null, duplicate: true,
      };
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

export async function confirmActionAsync(
  actionId: number, options: { sessionId: string; actorId: string; token?: string; conn?: Database },
): Promise<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const { item } = getPending(actionId, options.sessionId, options.actorId, conn);
  markExpired(item, conn);
  if (String(item.status) !== 'pending') {
    if (String(item.status) === 'executed') {
      const result = JSON.parse(String(item.result_json ?? '{}')) as Record<string, unknown>;
      return { id: item.id, status: 'executed', result, verification: result.verification ?? null, duplicate: true };
    }
    throw new ActionError('该操作已失效，请重新发起');
  }
  const token = String(options.token ?? '').trim().toUpperCase();
  if (token && tokenHash(token, String(item.arguments_hash)) !== String(item.confirmation_hash)) {
    throw new ActionError('确认码不正确，实际参数未被执行');
  }
  const transitioned = conn.prepare(
    "UPDATE agent_actions SET status='confirmed', confirmed_at=? WHERE id=? AND status='pending'",
  ).run(nowStamp(), item.id);
  if (transitioned.changes !== 1) {
    const current = conn.prepare('SELECT status, result_json FROM agent_actions WHERE id=?').get(item.id) as Record<string, unknown> | undefined;
    if (String(current?.status) === 'executed') {
      const result = JSON.parse(String(current?.result_json ?? '{}')) as Record<string, unknown>;
      return { id: item.id, status: 'executed', result, verification: result.verification ?? null, duplicate: true };
    }
    throw new ActionError('该操作正在处理中，请稍后查看结果');
  }
  if (String(item.tool_name) === 'execute_excel_import') {
    return executeConfirmedAsync(Number(item.id), {
      sessionId: options.sessionId, actorId: options.actorId, conn,
    });
  }
  return executeConfirmed(Number(item.id), {
    sessionId: options.sessionId, actorId: options.actorId, conn,
  });
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
    update_task: '待办已修改',
    create_event: '学生事件已记录',
    create_focus: '重点关注已创建',
    submit_roll_call_exceptions: '点名异常已保存',
  };
  const nested = result.result as Record<string, unknown> | undefined;
  const operationId = nested?.task_id ?? nested?.event_id ?? nested?.focus_id ?? nested?.meeting_id
    ?? nested?.activity_id ?? nested?.diary_id ?? nested?.note_id ?? nested?.class_task_id ?? result.id;
  return `${labels[toolName] ?? '操作已完成'}。编号：${String(operationId ?? '')}，写入校验已通过。`;
}

/** 处理聊天中的确认/取消；返回 (是否拦截, 用户可见回答)。
 * 确认/取消使用精确词匹配，避免“确认一下明天的安排”这类正常消息误触发写入。
 */
export function handleConfirmation(
  text: string, options: { sessionId: string; actorId: string; channel: string; conn?: Database },
): [boolean, string] {
  const conn = connOf(options.conn);
  const pending = pendingForSession(options.sessionId, options.actorId, conn);
  if (!pending) return [false, ''];
  const normalized = stripTrailingPunctuation(String(text ?? '').replace(/\s+/g, '').trim().toLowerCase());
  if (CONFIRM_WORDS.has(normalized)) {
    try {
      const result = confirmAction(Number(pending.id), {
        sessionId: options.sessionId, actorId: options.actorId, conn,
      });
      return [true, successMessage(String(pending.tool_name), result)];
    } catch (error) {
      if (error instanceof ActionError) {
        return [true, `班小助没有执行这次操作：${error.message}`];
      }
      throw error;
    }
  }
  if (CANCEL_WORDS.has(normalized)) {
    cancelAction(Number(pending.id), { sessionId: options.sessionId, actorId: options.actorId, conn });
    return [true, '已取消这次待确认操作，没有修改业务数据。'];
  }
  return [true, `${String(pending.preview ?? '')} 请先回复“确认”或“取消”。`];
}

/** 异步聊天确认入口：Excel 导入需要等待 Artifact 读取、适配器执行和写后验证。 */
export async function handleConfirmationAsync(
  text: string, options: { sessionId: string; actorId: string; channel: string; conn?: Database },
): Promise<[boolean, string]> {
  const conn = connOf(options.conn);
  const pending = pendingForSession(options.sessionId, options.actorId, conn);
  if (!pending) return [false, ''];
  const normalized = stripTrailingPunctuation(String(text ?? '').replace(/\s+/g, '').trim().toLowerCase());
  if (CONFIRM_WORDS.has(normalized)) {
    try {
      const result = await confirmActionAsync(Number(pending.id), {
        sessionId: options.sessionId, actorId: options.actorId, conn,
      });
      return [true, successMessage(String(pending.tool_name), result)];
    } catch (error) {
      if (error instanceof ActionError) {
        return [true, `班小助没有执行这次操作：${error.message}`];
      }
      throw error;
    }
  }
  if (CANCEL_WORDS.has(normalized)) {
    cancelAction(Number(pending.id), { sessionId: options.sessionId, actorId: options.actorId, conn });
    return [true, '已取消这次待确认操作，没有修改业务数据。'];
  }
  return [true, `${String(pending.preview ?? '')} 请先回复“确认”或“取消”。`];
}

const CONFIRM_WORDS = new Set(['确认', '确认执行', '执行', 'yes', 'y']);
const CANCEL_WORDS = new Set(['取消', '取消执行', '不要', 'no', 'n']);

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[。！!？?，,、.]+$/g, '');
}
