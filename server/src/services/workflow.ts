/* MIG-06 来源过程记录与状态联动：事件/沟通/关注的更新、幂等与工作项回写。
 * 与 backend/app/services/workflow.py 语义一致。
 */
import type { Database } from 'better-sqlite3';

import { getDb, scopeIds } from './context.js';
import * as audit from './audit.js';

export class WorkflowError extends Error {}

const SOURCES: Record<string, {
  table: string;
  statuses: Set<string>;
  closed: Set<string>;
  reopen: string;
  date_field: string;
  result_field: string;
  editable: Set<string>;
}> = {
  event: {
    table: 'student_events',
    statuses: new Set(['待处理', '处理中', '待复查', '已完成', '无需处理']),
    closed: new Set(['已完成', '无需处理']),
    reopen: '待复查',
    date_field: 'followup_due',
    result_field: 'result',
    editable: new Set(['handling', 'followup_due']),
  },
  communication: {
    table: 'communications',
    statuses: new Set(['待回访', '进行中', '已完成', '无需回访']),
    closed: new Set(['已完成', '无需回访']),
    reopen: '待回访',
    date_field: 'followup_at',
    result_field: 'result',
    editable: new Set(['feedback', 'agreement', 'followup_at']),
  },
  focus: {
    table: 'focus_items',
    statuses: new Set(['待确认', '跟进中', '情况改善', '已结束']),
    closed: new Set(['已结束']),
    reopen: '跟进中',
    date_field: 'next_review_at',
    result_field: 'conclusion',
    editable: new Set(['conclusion', 'next_review_at']),
  },
};

const SOURCE_TO_TASK: Record<string, Record<string, string>> = {
  event: { '待处理': '待处理', '处理中': '处理中', '待复查': '待复查' },
  communication: { '待回访': '待复查', '进行中': '处理中' },
  focus: { '待确认': '待处理', '跟进中': '处理中', '情况改善': '待复查' },
};

const TASK_TO_SOURCE: Record<string, Record<string, string>> = {
  event: { '待处理': '待处理', '处理中': '处理中', '待复查': '待复查' },
  communication: { '待处理': '待回访', '处理中': '进行中', '待复查': '待回访' },
  focus: { '待处理': '待确认', '处理中': '跟进中', '待复查': '情况改善' },
};

function nowMinute(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function sourceRow(sourceType: string, sourceId: number, options: { write?: boolean; conn?: Database } = {}) {
  const conn = options.conn ?? getDb().connInstance;
  const config = SOURCES[sourceType];
  if (!config) throw new WorkflowError('不支持的来源类型');
  const [classId, termId] = scopeIds({ write: options.write, conn });
  const row = conn.prepare(
    `SELECT * FROM ${config.table} WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''`,
  ).get(sourceId, classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new WorkflowError('来源记录不存在');
  return { config, source: { ...row }, classId, termId, conn };
}

function linkedTask(conn: Database, classId: number, termId: number, sourceType: string, sourceId: number):
  Record<string, unknown> | undefined {
  return conn.prepare(
    `SELECT * FROM student_tasks
     WHERE class_id=? AND term_id=? AND source_type=? AND source_id=?
       AND deleted_at=''
     ORDER BY id LIMIT 1`,
  ).get(classId, termId, sourceType, sourceId) as Record<string, unknown> | undefined;
}

function recordUpdate(
  conn: Database, options: {
    sourceType: string; sourceId: number; studentId: number | null;
    classId: number; termId: number; action: string; content?: string;
    statusFrom?: string; statusTo?: string; nextActionAt?: string; idempotencyKey?: string;
  },
): void {
  conn.prepare(
    `INSERT INTO workflow_updates(
       source_type, source_id, student_id, class_id, term_id,
       action, content, status_from, status_to, next_action_at, idempotency_key
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    options.sourceType, options.sourceId, options.studentId, options.classId, options.termId,
    options.action, String(options.content ?? '').trim(),
    options.statusFrom ?? '', options.statusTo ?? '',
    String(options.nextActionAt ?? ''), String(options.idempotencyKey ?? ''),
  );
}

export function getWorkflow(sourceType: string, sourceId: number): Record<string, unknown> {
  const { config, source, classId, termId, conn } = sourceRow(sourceType, sourceId);
  const updates = conn.prepare(
    `SELECT * FROM workflow_updates
     WHERE class_id=? AND term_id=? AND source_type=? AND source_id=?
     ORDER BY id DESC`,
  ).all(classId, termId, sourceType, sourceId) as Array<Record<string, unknown>>;
  const linked = linkedTask(conn, classId, termId, sourceType, sourceId);
  return {
    source,
    updates,
    linked_work_item: linked ?? null,
    allowed_statuses: [...config.statuses].sort(),
    closed_statuses: [...config.closed].sort(),
  };
}

export interface UpdateSourceOptions {
  fields?: Record<string, unknown> | null;
  status?: string | null;
  progress?: string;
  result?: string;
  nextActionAt?: string | null;
  taskAction?: string | null;
  requestId?: string;
  conn?: Database;
}

export function updateSource(sourceType: string, sourceId: number, options: UpdateSourceOptions = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const { config, source, classId, termId } = sourceRow(sourceType, sourceId, { write: true, conn });
  const requestId = String(options.requestId ?? '').trim();
  if (requestId && conn.prepare(
    'SELECT 1 FROM workflow_updates WHERE class_id=? AND term_id=? AND idempotency_key=?',
  ).get(classId, termId, requestId)) {
    return { duplicate: true, ...getWorkflow(sourceType, sourceId) };
  }

  const oldStatus = String(source.status);
  const nextStatus = options.status ?? oldStatus;
  if (!config.statuses.has(nextStatus)) throw new WorkflowError('来源状态不合法');
  const closing = config.closed.has(nextStatus) && !config.closed.has(oldStatus);
  const result = String(options.result ?? '').trim();
  if (closing && !result) throw new WorkflowError('关闭来源记录时必须填写处理结论');

  const linked = linkedTask(conn, classId, termId, sourceType, sourceId);
  const linkedOpen = linked && !['已完成', '已取消'].includes(String(linked.status));
  if (closing && linkedOpen && options.taskAction !== 'complete' && options.taskAction !== 'cancel') {
    throw new WorkflowError('关闭来源记录前，请明确完成或取消关联工作项');
  }
  if (options.taskAction !== null && options.taskAction !== undefined
    && !['', 'complete', 'cancel'].includes(options.taskAction)) {
    throw new WorkflowError('关联工作项处理方式不合法');
  }

  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options.fields ?? {})) {
    if (config.editable.has(key) && value !== null && value !== undefined) {
      updates[key] = String(value);
    }
  }
  const dateField = config.date_field;
  if (options.nextActionAt !== null && options.nextActionAt !== undefined) {
    updates[dateField] = String(options.nextActionAt);
  }
  updates.status = nextStatus;
  if (result) updates[config.result_field] = result;
  if ('closed_at' in source) {
    updates.closed_at = config.closed.has(nextStatus) ? nowMinute() : '';
  }
  if (sourceType === 'focus') {
    updates.ended_at = config.closed.has(nextStatus) ? nowMinute() : '';
  }

  const assignments = Object.keys(updates).map((key) => `${key}=?`).join(', ');
  conn.prepare(
    `UPDATE ${config.table} SET ${assignments}, updated_at=datetime('now','localtime') `
    + 'WHERE id=? AND class_id=? AND term_id=?',
  ).run(...Object.values(updates), sourceId, classId, termId);

  if (linkedOpen && closing) {
    const taskStatus = options.taskAction === 'complete' ? '已完成' : '已取消';
    conn.prepare(
      `UPDATE student_tasks SET status=?, result=?, completed_at=?, cancelled_at=?,
             updated_at=datetime('now','localtime') WHERE id=?`,
    ).run(taskStatus, result,
      taskStatus === '已完成' ? nowMinute() : '',
      taskStatus === '已取消' ? nowMinute() : '', linked!.id);
  } else if (linked && !config.closed.has(nextStatus)) {
    const taskStatus = SOURCE_TO_TASK[sourceType]?.[nextStatus] ?? String(linked.status);
    const taskDue = String(updates[dateField] ?? source[dateField] ?? '');
    conn.prepare(
      `UPDATE student_tasks SET status=?, due_at=?, result='',
             completed_at='', cancelled_at='', updated_at=datetime('now','localtime')
       WHERE id=?`,
    ).run(taskStatus, taskDue, linked.id);
  }
  const action = nextStatus !== oldStatus ? 'status' : (options.progress ? 'progress' : 'edit');
  const content = options.progress || result;
  recordUpdate(conn, {
    sourceType, sourceId, studentId: source.student_id !== undefined ? Number(source.student_id) : null,
    classId, termId, action, content,
    statusFrom: oldStatus, statusTo: nextStatus,
    nextActionAt: String(updates[dateField] ?? source[dateField] ?? ''),
    idempotencyKey: requestId,
  });
  audit.record(sourceType, sourceId, action, {
    summary: `${sourceType} 状态：${oldStatus} → ${nextStatus}`,
    params: { fields: options.fields ?? {}, progress: options.progress ?? '', result,
      next_action_at: options.nextActionAt ?? '', task_action: options.taskAction ?? '' },
    classId, termId, conn,
  });
  return { duplicate: false, ...getWorkflow(sourceType, sourceId) };
}

/** 工作项状态变化时回写事件、沟通或关注；由 workItems.updateWorkItem 事务内调用。 */
export function onWorkItemTransition(
  conn: Database, before: Record<string, unknown>, nextStatus: string, result: string,
): void {
  const sourceType = String(before.source_type ?? '');
  const sourceId = before.source_id as number | null | undefined;
  const config = SOURCES[sourceType];
  if (!config || !sourceId || String(before.status) === nextStatus) return;
  const source = conn.prepare(
    `SELECT * FROM ${config.table} WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''`,
  ).get(sourceId, before.class_id, before.term_id) as Record<string, unknown> | undefined;
  if (!source) return;
  const oldSourceStatus = String(source.status);
  let targetSourceStatus = oldSourceStatus;
  if (nextStatus === '已完成') {
    targetSourceStatus = '已完成';
  } else if (!['已完成', '已取消'].includes(nextStatus)) {
    targetSourceStatus = TASK_TO_SOURCE[sourceType]?.[nextStatus] ?? oldSourceStatus;
  }
  if (['已完成', '已取消'].includes(String(before.status)) && !['已完成', '已取消'].includes(nextStatus)) {
    targetSourceStatus = config.reopen;
  }

  const assignments = ['status=?'];
  const params: unknown[] = [targetSourceStatus];
  if (nextStatus === '已完成') {
    assignments.push(`${config.result_field}=?`);
    params.push(result);
    if ('closed_at' in source) {
      assignments.push('closed_at=?');
      params.push(nowMinute());
    }
    if (sourceType === 'focus') {
      assignments.push('ended_at=?');
      params.push(nowMinute());
    }
  } else if (!config.closed.has(targetSourceStatus)) {
    if ('closed_at' in source) assignments.push("closed_at=''");
    if (sourceType === 'focus') assignments.push("ended_at=''");
  }
  params.push(sourceId, before.class_id, before.term_id);
  conn.prepare(
    `UPDATE ${config.table} SET ${assignments.join(', ')}, updated_at=datetime('now','localtime') `
    + 'WHERE id=? AND class_id=? AND term_id=?',
  ).run(...params);

  const action = nextStatus === '已完成' ? 'work_item_completed'
    : nextStatus === '已取消' ? 'work_item_cancelled' : 'work_item_reopened';
  recordUpdate(conn, {
    sourceType, sourceId: Number(sourceId),
    studentId: source.student_id !== undefined ? Number(source.student_id) : null,
    classId: Number(before.class_id), termId: Number(before.term_id),
    action, content: result,
    statusFrom: oldSourceStatus, statusTo: targetSourceStatus,
    nextActionAt: String(source[config.date_field] ?? ''),
  });
}
