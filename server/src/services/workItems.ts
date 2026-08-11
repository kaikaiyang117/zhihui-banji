/* MIG-06 统一工作项：创建、来源幂等、筛选、状态变更与来源回写。
 * 提供统一工作项和来源关联能力。
 * 来源特定回写（考勤/成绩/班级任务/值日/积分）通过 hooks 注册表接入，由 MIG-07/08 填充。
 */
import type { Database } from 'better-sqlite3';

import { getDb, scopeIds, ensureStudentInScope } from './context.js';
import * as audit from './audit.js';
import { todayString } from './clock.js';

export const STATUSES = new Set(['待处理', '处理中', '待复查', '已完成', '已取消']);
export const PRIORITIES = new Set(['普通', '重要', '紧急']);
export const CLOSED_STATUSES = new Set(['已完成', '已取消']);

export const SOURCE_LABELS: Record<string, string> = {
  manual: '手动创建',
  event: '学生事件',
  communication: '家校沟通',
  focus: '关注事项',
  attendance_rule: '考勤规则',
  score_rule: '成绩规则',
  class_task: '班级任务',
  duty_assignment: '值日安排',
  point_rule: '积分规则',
  meeting_action: '班会行动项',
  activity: '班级活动',
  agent_action: 'Agent 创建',
};

export const SOURCE_PATHS: Record<string, string> = {
  event: '/events',
  communication: '/parent-comm',
  focus: '/special',
  attendance_rule: '/attendance',
  score_rule: '/scores',
  class_task: '/class-tasks',
  duty_assignment: '/duty',
  point_rule: '/points',
  meeting_action: '/meetings',
  activity: '/activities',
};

export class WorkItemError extends Error {}

/** 来源特定工作项状态回写钩子：MIG-07/08 注册各自的实现。 */
export const sourceTransitionHooks: Record<string, (
  conn: Database, before: Record<string, unknown>, nextStatus: string, result: string,
) => void> = {};

function nowMinute(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function validate(status: string, priority: string): void {
  if (!STATUSES.has(status)) throw new WorkItemError('工作项状态不合法');
  if (!PRIORITIES.has(priority)) throw new WorkItemError('优先级不合法');
}

export function sourceKey(sourceType: string, sourceId: number | null, studentId: number | null = null): string {
  if (sourceType === 'manual' || sourceId === null) return '';
  let key = `${sourceType}:${Number(sourceId)}`;
  if (['attendance_rule', 'score_rule', 'point_rule'].includes(sourceType) && studentId !== null) {
    key += `:student:${Number(studentId)}`;
  }
  return key;
}

export function decorate(row: Record<string, unknown>): Record<string, unknown> {
  const item = { ...row };
  const sourceType = String(item.source_type ?? '');
  item.source_label = SOURCE_LABELS[sourceType] ?? item.source ?? '其他';
  const path = SOURCE_PATHS[sourceType] ?? '';
  item.source_path = path && item.source_id
    ? `${path}?source_id=${item.source_id}` : path;
  item.calendar_date = String(item.scheduled_at ?? item.due_at ?? '').slice(0, 10);
  const today = todayString();
  if (CLOSED_STATUSES.has(String(item.status))) {
    item.timing_state = item.status;
  } else {
    const due = String(item.due_at ?? '').slice(0, 10);
    if (due && due < today) item.timing_state = '已逾期';
    else if (item.calendar_date === today) item.timing_state = '今天';
    else item.timing_state = '待安排';
  }
  return item;
}

export interface CreateWorkItemOptions {
  title: string;
  studentId?: number | null;
  sourceType?: string;
  sourceId?: number | null;
  sourceLabel?: string | null;
  owner?: string;
  priority?: string;
  scheduledAt?: string;
  dueAt?: string;
  status?: string;
  notes?: string;
  conn?: Database;
}

export function createWorkItem(options: CreateWorkItemOptions): { id: number; created: boolean } {
  const conn = options.conn ?? getDb().connInstance;
  const title = String(options.title ?? '').trim();
  if (!title) throw new WorkItemError('工作项标题不能为空');
  const status = options.status ?? '待处理';
  const priority = options.priority ?? '普通';
  validate(status, priority);
  const [classId, termId] = scopeIds({ write: true, conn });
  if (options.studentId !== undefined && options.studentId !== null) {
    ensureStudentInScope(Number(options.studentId), { write: true, conn });
  }
  const sourceType = String(options.sourceType ?? 'manual').trim() || 'manual';
  const key = sourceKey(sourceType, options.sourceId ?? null, options.studentId ?? null);
  if (key) {
    const existing = conn.prepare(
      "SELECT id FROM student_tasks WHERE class_id=? AND term_id=? AND source_key=? AND deleted_at=''",
    ).get(classId, termId, key) as { id: number } | undefined;
    if (existing) return { id: Number(existing.id), created: false };
  }
  const source = String(options.sourceLabel ?? SOURCE_LABELS[sourceType] ?? sourceType).trim();
  const inserted = conn.prepare(
    `INSERT INTO student_tasks(
       student_id, title, source, source_type, source_id, source_key,
       owner, priority, scheduled_at, due_at, status, notes, class_id, term_id
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).get(
    options.studentId ?? null, title, source, sourceType, options.sourceId ?? null, key,
    String(options.owner ?? '班主任').trim() || '班主任', priority,
    options.scheduledAt ?? '', options.dueAt ?? '', status, String(options.notes ?? ''),
    classId, termId,
  ) as { id: number };
  const itemId = Number(inserted.id);
  audit.record('work_item', itemId, 'create', {
    summary: `新增工作项：${title}`,
    params: { title, owner: options.owner, priority, scheduled_at: options.scheduledAt ?? '',
      due_at: options.dueAt ?? '', source_type: sourceType, source_id: options.sourceId ?? null },
    classId, termId, conn,
  });
  return { id: itemId, created: true };
}

export interface EnsureSourceWorkItemOptions extends CreateWorkItemOptions {
  legacyTitle?: string;
}

export function ensureSourceWorkItem(options: EnsureSourceWorkItemOptions): { id: number; created: boolean } {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  const sourceType = options.sourceType ?? 'manual';
  const key = sourceKey(sourceType, options.sourceId ?? null, options.studentId ?? null);
  if (key) {
    const existing = conn.prepare(
      "SELECT id FROM student_tasks WHERE class_id=? AND term_id=? AND source_key=? AND deleted_at=''",
    ).get(classId, termId, key) as { id: number } | undefined;
    if (existing) return { id: Number(existing.id), created: false };
    if (options.legacyTitle) {
      const legacy = conn.prepare(
        `SELECT id FROM student_tasks
         WHERE class_id=? AND term_id=? AND title=?
           AND COALESCE(source_key, '')=''
           AND deleted_at=''
           AND status NOT IN ('已完成','已取消')
         ORDER BY id LIMIT 1`,
      ).get(classId, termId, options.legacyTitle) as { id: number } | undefined;
      if (legacy) {
        conn.prepare(
          `UPDATE student_tasks
           SET source=?, source_type=?, source_id=?, source_key=?,
               updated_at=datetime('now','localtime') WHERE id=?`,
        ).run(
          options.sourceLabel ?? SOURCE_LABELS[sourceType] ?? sourceType,
          sourceType, options.sourceId ?? null, key, legacy.id,
        );
        return { id: Number(legacy.id), created: false };
      }
    }
  }
  return createWorkItem(options);
}

export function listWorkItems(options: {
  status?: string | null;
  bucket?: string;
  studentId?: number | null;
  sourceType?: string | null;
  query?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  conn?: Database;
} = {}): Array<Record<string, unknown>> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const today = todayString();
  const actionDate = "substr(COALESCE(NULLIF(t.scheduled_at,''), NULLIF(t.due_at,''), ''),1,10)";
  const where = ["t.class_id=?", "t.term_id=?", "t.deleted_at=''",
    "(t.student_id IS NULL OR COALESCE(s.deleted_at, '')='')"];
  const params: unknown[] = [classId, termId];
  const bucket = options.bucket ?? 'all';
  if (options.status) {
    if (!STATUSES.has(options.status)) throw new WorkItemError('工作项状态不合法');
    where.push('t.status=?');
    params.push(options.status);
  }
  if (options.studentId) {
    where.push('t.student_id=?');
    params.push(options.studentId);
  }
  if (options.sourceType) {
    where.push('t.source_type=?');
    params.push(options.sourceType);
  }
  if ((options.query ?? '').trim()) {
    where.push("(t.title LIKE ? OR t.notes LIKE ? OR COALESCE(s.姓名,'') LIKE ?)");
    const like = `%${options.query!.trim()}%`;
    params.push(like, like, like);
  }
  if (options.dateFrom) {
    where.push(`${actionDate}>=?`);
    params.push(options.dateFrom.slice(0, 10));
  }
  if (options.dateTo) {
    where.push(`${actionDate}<=?`);
    params.push(options.dateTo.slice(0, 10));
  }
  if (bucket === 'open') {
    where.push("t.status NOT IN ('已完成','已取消')");
  } else if (bucket === 'overdue') {
    where.push("t.status NOT IN ('已完成','已取消')", "t.due_at<>''", 'substr(t.due_at,1,10)<?');
    params.push(today);
  } else if (bucket === 'today') {
    where.push("t.status NOT IN ('已完成','已取消')", `(${actionDate}=? OR substr(t.due_at,1,10)=?)`);
    params.push(today, today);
  } else if (bucket === 'next7') {
    where.push("t.status NOT IN ('已完成','已取消')", `${actionDate}>?`, `${actionDate}<=?`);
    const next = new Date(`${today}T00:00:00`);
    next.setDate(next.getDate() + 7);
    params.push(today, next.toISOString().slice(0, 10));
  } else if (bucket === 'completed') {
    where.push("t.status='已完成'");
  } else if (bucket === 'cancelled') {
    where.push("t.status='已取消'");
  } else if (bucket !== 'all') {
    throw new WorkItemError('不支持的工作项筛选');
  }
  const limit = Math.max(1, Math.min(Number(options.limit ?? 500), 1_000_000));
  const sql = [
    'SELECT t.*, s.姓名 AS student_name FROM student_tasks t ',
    'LEFT JOIN students s ON s.id=t.student_id WHERE ', where.join(' AND '),
    " ORDER BY CASE WHEN t.status IN ('已完成','已取消') THEN 1 ELSE 0 END, ",
    "CASE WHEN t.due_at<>'' AND substr(t.due_at,1,10)<? THEN 0 ELSE 1 END, ",
    "CASE t.priority WHEN '紧急' THEN 0 WHEN '重要' THEN 1 ELSE 2 END, ",
    `CASE WHEN ${actionDate}='' THEN 1 ELSE 0 END, ${actionDate}, t.id DESC LIMIT ?`,
  ].join('');
  const rows = conn.prepare(sql).all(...params, today, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => decorate(row));
}

export function workItemSummary(options: { conn?: Database } = {}): Record<string, number> {
  const result: Record<string, number> = {};
  for (const bucket of ['all', 'open', 'overdue', 'today', 'next7', 'completed', 'cancelled']) {
    result[bucket] = listWorkItems({ bucket, limit: 1_000_000, conn: options.conn }).length;
  }
  return result;
}

export interface UpdateWorkItemOptions {
  title?: string | null;
  owner?: string | null;
  priority?: string | null;
  scheduledAt?: string | null;
  dueAt?: string | null;
  status?: string | null;
  notes?: string | null;
  result?: string | null;
  conn?: Database;
  syncSource?: boolean;
}

export function updateWorkItem(itemId: number, options: UpdateWorkItemOptions = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  const row = conn.prepare(
    "SELECT * FROM student_tasks WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(itemId, classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new WorkItemError('工作项不存在');
  const nextStatus = options.status ?? String(row.status);
  const nextPriority = options.priority ?? String(row.priority);
  validate(nextStatus, nextPriority);
  const nextResult = String(options.result !== undefined && options.result !== null
    ? options.result : (row.result ?? '')).trim();
  if (CLOSED_STATUSES.has(nextStatus) && !nextResult) {
    throw new WorkItemError('完成或取消工作项时必须填写处理结果');
  }
  if (options.title !== undefined && options.title !== null && !String(options.title).trim()) {
    throw new WorkItemError('工作项标题不能为空');
  }

  if (nextStatus === String(row.status)
    && CLOSED_STATUSES.has(nextStatus)
    && nextResult === String(row.result ?? '').trim()
    && [options.title, options.owner, options.priority, options.scheduledAt, options.dueAt, options.notes]
      .every((value) => value === undefined || value === null)) {
    const current = conn.prepare(
      'SELECT t.*, s.姓名 AS student_name FROM student_tasks t '
      + "LEFT JOIN students s ON s.id=t.student_id WHERE t.id=? AND t.deleted_at=''",
    ).get(itemId) as Record<string, unknown>;
    return decorate(current);
  }

  const values: Record<string, unknown> = {
    title: options.title !== undefined && options.title !== null ? String(options.title).trim() : row.title,
    owner: options.owner !== undefined && options.owner !== null ? String(options.owner).trim() : row.owner,
    priority: nextPriority,
    scheduled_at: options.scheduledAt !== undefined && options.scheduledAt !== null ? options.scheduledAt : row.scheduled_at,
    due_at: options.dueAt !== undefined && options.dueAt !== null ? options.dueAt : row.due_at,
    status: nextStatus,
    notes: options.notes !== undefined && options.notes !== null ? options.notes : row.notes,
    result: CLOSED_STATUSES.has(nextStatus) ? nextResult : '',
    completed_at: nextStatus === '已完成' ? nowMinute() : '',
    cancelled_at: nextStatus === '已取消' ? nowMinute() : '',
  };
  conn.prepare(
    `UPDATE student_tasks SET
       title=@title, owner=@owner, priority=@priority,
       scheduled_at=@scheduled_at, due_at=@due_at, status=@status,
       notes=@notes, result=@result, completed_at=@completed_at,
       cancelled_at=@cancelled_at, updated_at=datetime('now','localtime')
     WHERE id=@id AND class_id=@class_id AND term_id=@term_id`,
  ).run({ ...values, id: itemId, class_id: classId, term_id: termId });

  const { onWorkItemTransition } = awaitWorkflowTransition();
  onWorkItemTransition(conn, row, nextStatus, values.result as string);
  const hook = sourceTransitionHooks[String(row.source_type ?? '')];
  if (hook) {
    hook(conn, row, nextStatus, values.result as string);
  }
  audit.record('work_item', itemId, 'update', {
    summary: `更新工作项：${values.title}`,
    params: values, classId, termId, conn,
  });
  const updated = conn.prepare(
    'SELECT t.*, s.姓名 AS student_name FROM student_tasks t '
    + "LEFT JOIN students s ON s.id=t.student_id WHERE t.id=? AND t.deleted_at=''",
  ).get(itemId) as Record<string, unknown>;
  return decorate(updated);
}

function awaitWorkflowTransition(): { onWorkItemTransition: (
  conn: Database, before: Record<string, unknown>, nextStatus: string, result: string,
) => void } {
  // 延迟导入避免循环依赖
  return { onWorkItemTransition: workflowModule.onWorkItemTransition };
}

// 循环依赖处理：workItems → workflow（onWorkItemTransition）；workflow 不依赖 workItems。
import * as workflowModule from './workflow.js';
