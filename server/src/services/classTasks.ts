import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Database } from 'better-sqlite3';

import { getDb, scopeIds, ensureStudentInScope } from './context.js';
import * as audit from './audit.js';
import { todayString } from './clock.js';
import { ensureSourceWorkItem, updateWorkItem, sourceTransitionHooks } from './workItems.js';
import { safeResolve, atomicWrite, sha256 } from './files.js';

export const TASK_STATUSES = new Set(['进行中', '已完成', '已取消']);
export const ITEM_STATUSES = new Set(['未提交', '已提交', '免交']);
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export class ClassTaskError extends Error {}

export class IncompleteTaskError extends ClassTaskError {
  readonly missing: Array<Record<string, unknown>>;

  constructor(missing: Array<Record<string, unknown>>) {
    super(`仍有 ${missing.length} 名学生未提交材料，请确认后再完成任务`);
    this.missing = missing;
  }
}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function nowString(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function scope(options: { write?: boolean; conn?: Database } = {}): [number, number] {
  return scopeIds({ write: options.write, conn: options.conn });
}

function taskRow(taskId: number, options: { write?: boolean; conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: options.write, conn });
  const row = conn.prepare(
    "SELECT * FROM class_tasks WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(Number(taskId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new ClassTaskError('班级任务不存在');
  return row;
}

function templateRow(templateId: number, options: { write?: boolean; conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: options.write, conn });
  const row = conn.prepare(
    "SELECT * FROM class_task_templates WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(Number(templateId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new ClassTaskError('班级任务模板不存在');
  return row;
}

function itemRows(taskId: number, options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const rows = conn.prepare(
    `SELECT i.*, s.学号, s.姓名
     FROM class_task_items i JOIN students s ON s.id=i.student_id
     WHERE i.task_id=? AND s.deleted_at=''
     ORDER BY s.学号`,
  ).all(Number(taskId)) as Array<Record<string, unknown>>;
  const attachments = conn.prepare(
    `SELECT id, item_id, original_name, content_type, size_bytes, created_at
     FROM class_task_attachments WHERE task_id=? ORDER BY id`,
  ).all(Number(taskId)) as Array<Record<string, unknown>>;
  const byItem = new Map<number, Array<Record<string, unknown>>>();
  for (const attachment of attachments) {
    attachment.download_path = `/api/class-tasks/attachments/${attachment.id}`;
    const itemId = Number(attachment.item_id);
    const list = byItem.get(itemId) ?? [];
    list.push(attachment);
    byItem.set(itemId, list);
  }
  for (const item of rows) {
    item.attachments = byItem.get(Number(item.id)) ?? [];
    item.attachment_count = (item.attachments as Array<unknown>).length;
  }
  return rows;
}

function missingItems(taskId: number, options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  return itemRows(taskId, options).filter((item) => item.status === '未提交');
}

function timingState(task: Record<string, unknown>): string {
  if (['已完成', '已取消'].includes(String(task.status))) return String(task.status);
  const today = todayString();
  const due = text(task.due_at).slice(0, 10);
  const start = text(task.start_at).slice(0, 10);
  if (due && due < today) return '已逾期';
  if (start && start > today) return '待开始';
  return '进行中';
}

function roundHalfEven(value: number): number {
  const floored = Math.floor(value);
  const fraction = value - floored;
  if (fraction < 0.5) return floored;
  if (fraction > 0.5) return Math.ceil(value);
  return floored % 2 === 0 ? floored : floored + 1;
}

function serialize(task: Record<string, unknown>, options: { conn?: Database } = {}): Record<string, unknown> {
  const items = itemRows(Number(task.id), options);
  const total = items.length;
  const submitted = items.filter((item) => ['已提交', '免交'].includes(String(item.status))).length;
  const missing = items.filter((item) => item.status === '未提交');
  const result = { ...task };
  result.items = items;
  result.total = total;
  result.submitted = submitted;
  result.missing_count = missing.length;
  result.missing_students = missing.map((item) => ({
    student_id: item.student_id, 学号: item.学号, 姓名: item.姓名,
  }));
  result.progress = total ? roundHalfEven((submitted * 100) / total) : 0;
  result.timing_state = timingState(result);
  result.can_close = result.status === '进行中';
  return result;
}

export function listTasks(options: {
  status?: string; timingState?: string; sourceId?: number | null; conn?: Database;
} = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const status = options.status ?? '';
  if (status && !TASK_STATUSES.has(status)) throw new ClassTaskError('班级任务状态不合法');
  const where = ["class_id=?", "term_id=?", "deleted_at=''"];
  const params: unknown[] = [classId, termId];
  if (status) {
    where.push('status=?');
    params.push(status);
  }
  if (options.sourceId) {
    where.push('id=?');
    params.push(Number(options.sourceId));
  }
  const rows = conn.prepare(
    'SELECT * FROM class_tasks WHERE ' + where.join(' AND ')
    + " ORDER BY CASE WHEN due_at='' THEN 1 ELSE 0 END, due_at, id DESC",
  ).all(...params) as Array<Record<string, unknown>>;
  let result = rows.map((row) => serialize(row, { conn }));
  if (options.timingState) {
    result = result.filter((item) => item.timing_state === options.timingState);
  }
  return result;
}

export function getTask(taskId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  return serialize(taskRow(taskId, options), options);
}

export function listTemplates(options: { includeDisabled?: boolean; conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const where = ["class_id=?", "term_id=?", "deleted_at=''"];
  const params: unknown[] = [classId, termId];
  if (!options.includeDisabled) {
    where.push('enabled=1');
  }
  return conn.prepare(
    'SELECT * FROM class_task_templates WHERE ' + where.join(' AND ')
    + ' ORDER BY enabled DESC, name, id',
  ).all(...params) as Array<Record<string, unknown>>;
}

export function createTemplate(options: {
  name: string; taskType?: string; materialName?: string; description?: string;
  defaultDueDays?: number; enabled?: boolean; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const name = text(options.name);
  if (!name) throw new ClassTaskError('模板名称不能为空');
  const defaultDueDays = Number(options.defaultDueDays ?? 7);
  if (defaultDueDays < 0 || defaultDueDays > 366) {
    throw new ClassTaskError('默认截止天数必须在 0 到 366 天之间');
  }
  const [classId, termId] = scope({ write: true, conn });
  const templateId = conn.transaction(() => {
    const inserted = conn.prepare(
      `INSERT INTO class_task_templates(
         class_id, term_id, name, task_type, material_name,
         description, default_due_days, enabled
       ) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      classId, termId, name, text(options.taskType) || '材料收集',
      text(options.materialName), text(options.description), defaultDueDays,
      options.enabled === false ? 0 : 1,
    );
    const createdId = Number(inserted.lastInsertRowid);
    audit.record('class_task_template', createdId, 'create', {
      summary: `新增班级任务模板：${name}`,
      params: { name, task_type: options.taskType },
      classId, termId, conn,
    });
    return createdId;
  })();
  return conn.prepare('SELECT * FROM class_task_templates WHERE id=?').get(templateId) as Record<string, unknown>;
}

export function updateTemplate(templateId: number, options: {
  name?: string | null; taskType?: string | null; materialName?: string | null;
  description?: string | null; defaultDueDays?: number | null; enabled?: boolean | null;
  conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const current = templateRow(templateId, { write: true, conn });
  const values: Record<string, unknown> = {
    name: options.name !== undefined && options.name !== null ? text(options.name) : current.name,
    task_type: options.taskType !== undefined && options.taskType !== null ? text(options.taskType) : current.task_type,
    material_name: options.materialName !== undefined && options.materialName !== null ? text(options.materialName) : current.material_name,
    description: options.description !== undefined && options.description !== null ? text(options.description) : current.description,
    default_due_days: options.defaultDueDays !== undefined && options.defaultDueDays !== null ? Number(options.defaultDueDays) : current.default_due_days,
    enabled: options.enabled !== undefined && options.enabled !== null ? (options.enabled ? 1 : 0) : current.enabled,
  };
  if (!String(values.name).trim()) throw new ClassTaskError('模板名称不能为空');
  const defaultDueDays = Number(values.default_due_days);
  if (defaultDueDays < 0 || defaultDueDays > 366) {
    throw new ClassTaskError('默认截止天数必须在 0 到 366 天之间');
  }
  conn.transaction(() => {
    conn.prepare(
      `UPDATE class_task_templates SET name=?, task_type=?, material_name=?,
         description=?, default_due_days=?, enabled=?, updated_at=datetime('now','localtime')
       WHERE id=?`,
    ).run(...Object.values(values), Number(templateId));
    audit.record('class_task_template', templateId, 'update', {
      summary: `更新班级任务模板：${values.name}`,
      params: values, conn,
    });
  })();
  return conn.prepare('SELECT * FROM class_task_templates WHERE id=?').get(Number(templateId)) as Record<string, unknown>;
}

export function templateDefaults(templateId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  return templateRow(templateId, options);
}

export function createTask(options: {
  title: string; taskType?: string; startAt?: string; dueAt?: string;
  materialName?: string; description?: string; studentIds?: Array<number | string> | null;
  templateId?: number | null; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const title = text(options.title);
  const studentIds = (options.studentIds ?? []).map((item) => Number(item));
  if (!title) throw new ClassTaskError('任务名称不能为空');
  if (studentIds.length === 0) throw new ClassTaskError('至少选择一名参与学生');
  if (new Set(studentIds).size !== studentIds.length) {
    throw new ClassTaskError('参与学生不能重复');
  }
  const [classId, termId] = scope({ write: true, conn });
  if (options.templateId !== undefined && options.templateId !== null) {
    templateRow(Number(options.templateId), { write: true, conn });
  }
  for (const studentId of studentIds) {
    ensureStudentInScope(studentId, { write: true, conn });
  }
  const taskId = conn.transaction(() => {
    const inserted = conn.prepare(
      `INSERT INTO class_tasks(
         title, task_type, start_at, due_at, material_name, description,
         status, class_id, term_id, template_id
       ) VALUES(?,?,?,?,?,?, '进行中', ?,?,?)`,
    ).run(
      title, text(options.taskType) || '材料收集',
      text(options.startAt).slice(0, 19), text(options.dueAt).slice(0, 19),
      text(options.materialName), text(options.description), classId, termId,
      options.templateId !== undefined && options.templateId !== null ? Number(options.templateId) : null,
    );
    const createdId = Number(inserted.lastInsertRowid);
    const stmt = conn.prepare('INSERT INTO class_task_items(task_id, student_id) VALUES(?,?)');
    for (const studentId of studentIds) stmt.run(createdId, studentId);
    ensureSourceWorkItem({
      title, sourceType: 'class_task', sourceId: createdId,
      scheduledAt: text(options.startAt).slice(0, 19), dueAt: text(options.dueAt).slice(0, 19),
      notes: text(options.description), conn,
    });
    audit.record('class_task', createdId, 'create', {
      summary: `新增班级任务：${title}`,
      params: { task_type: options.taskType, student_count: studentIds.length, template_id: options.templateId ?? null },
      classId, termId, conn,
    });
    return createdId;
  })();
  return getTask(taskId, { conn });
}

export function updateTask(taskId: number, options: {
  status?: string | null; description?: string | null; startAt?: string | null; dueAt?: string | null;
  completionResult?: string | null; confirmIncomplete?: boolean; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const current = taskRow(taskId, { write: true, conn });
  const nextStatus = options.status ?? String(current.status);
  if (!TASK_STATUSES.has(nextStatus)) throw new ClassTaskError('班级任务状态不合法');
  const completionResult = options.completionResult !== undefined && options.completionResult !== null
    ? text(options.completionResult) : text(current.completion_result);
  const closing = ['已完成', '已取消'].includes(nextStatus)
    && !['已完成', '已取消'].includes(String(current.status));
  const missing = missingItems(taskId, { conn });
  if (closing && nextStatus === '已完成' && missing.length > 0 && !options.confirmIncomplete) {
    throw new IncompleteTaskError(missing);
  }
  if (closing && !completionResult) {
    throw new ClassTaskError('完成或取消班级任务时必须填写结果');
  }
  const values: Record<string, unknown> = {
    description: options.description !== undefined && options.description !== null ? text(options.description) : current.description,
    start_at: options.startAt !== undefined && options.startAt !== null ? text(options.startAt).slice(0, 19) : current.start_at,
    due_at: options.dueAt !== undefined && options.dueAt !== null ? text(options.dueAt).slice(0, 19) : current.due_at,
    status: nextStatus,
    completed_at: nextStatus === '已完成' ? nowString() : '',
    completion_result: ['已完成', '已取消'].includes(nextStatus) ? completionResult : '',
    closed_with_missing_count: ['已完成', '已取消'].includes(nextStatus) ? missing.length : 0,
  };
  const [classId, termId] = scope({ write: true, conn });
  conn.transaction(() => {
    conn.prepare(
      `UPDATE class_tasks SET description=?, start_at=?, due_at=?, status=?,
         completed_at=?, completion_result=?, closed_with_missing_count=?,
         updated_at=datetime('now','localtime')
       WHERE id=? AND class_id=? AND term_id=?`,
    ).run(
      values.description, values.start_at, values.due_at, values.status,
      values.completed_at, values.completion_result, values.closed_with_missing_count,
      Number(taskId), classId, termId,
    );
    syncWorkItem(current, values, conn);
    audit.record('class_task', taskId, 'update', {
      summary: `更新班级任务：${current.title}`,
      params: { status: nextStatus, completion_result: completionResult, missing_count: missing.length },
      classId, termId, conn,
    });
  })();
  return getTask(taskId, { conn });
}

function syncWorkItem(before: Record<string, unknown>, values: Record<string, unknown>, conn: Database): void {
  const linked = conn.prepare(
    `SELECT * FROM student_tasks
     WHERE class_id=? AND term_id=? AND source_type='class_task' AND source_id=?
       AND deleted_at='' ORDER BY id LIMIT 1`,
  ).get(before.class_id, before.term_id, before.id) as Record<string, unknown> | undefined;
  if (!linked) return;
  const nextStatus = values.status === '已完成' ? '已完成'
    : values.status === '已取消' ? '已取消' : '待处理';
  updateWorkItem(Number(linked.id), {
    title: String(before.title), scheduledAt: String(values.start_at), dueAt: String(values.due_at),
    status: nextStatus, notes: String(values.description), result: String(values.completion_result),
    conn, syncSource: false,
  });
}

export function updateItem(taskId: number, studentId: number, options: {
  status: string; note?: string; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const task = taskRow(taskId, { write: true, conn });
  if (task.status !== '进行中') throw new ClassTaskError('已关闭的班级任务不能修改提交状态');
  if (!ITEM_STATUSES.has(options.status)) throw new ClassTaskError('材料提交状态不合法');
  ensureStudentInScope(Number(studentId), { write: true, conn });
  const row = conn.prepare(
    'SELECT * FROM class_task_items WHERE task_id=? AND student_id=?',
  ).get(Number(taskId), Number(studentId)) as Record<string, unknown> | undefined;
  if (!row) throw new ClassTaskError('任务中没有该学生');
  const submittedAt = ['已提交', '免交'].includes(options.status) ? nowString() : '';
  conn.transaction(() => {
    conn.prepare(
      `UPDATE class_task_items SET status=?, note=?, submitted_at=?,
         updated_at=datetime('now','localtime')
       WHERE task_id=? AND student_id=?`,
    ).run(options.status, text(options.note), submittedAt, Number(taskId), Number(studentId));
    audit.record('class_task_item', Number(row.id), 'update', {
      summary: `更新材料提交状态：${options.status}`,
      params: { task_id: taskId, student_id: studentId, status: options.status },
      conn,
    });
  })();
  return getTask(taskId, { conn });
}

export function updateItems(taskId: number, studentIds: Array<number | string>, options: {
  status: string; note?: string; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const task = taskRow(taskId, { write: true, conn });
  if (task.status !== '进行中') throw new ClassTaskError('已关闭的班级任务不能修改提交状态');
  if (!ITEM_STATUSES.has(options.status)) throw new ClassTaskError('材料提交状态不合法');
  const ids = Array.from(new Set((studentIds ?? []).map((item) => Number(item))))
    .sort((a, b) => a - b);
  if (ids.length === 0) throw new ClassTaskError('至少选择一名学生');
  for (const studentId of ids) ensureStudentInScope(studentId, { write: true, conn });
  const placeholders = ids.map(() => '?').join(',');
  const rows = conn.prepare(
    `SELECT student_id FROM class_task_items WHERE task_id=? AND student_id IN (${placeholders})`,
  ).all(Number(taskId), ...ids) as Array<{ student_id: number }>;
  if (rows.length !== ids.length) throw new ClassTaskError('任务中没有所选学生');
  const submittedAt = ['已提交', '免交'].includes(options.status) ? nowString() : '';
  const [classId, termId] = scope({ write: true, conn });
  conn.transaction(() => {
    conn.prepare(
      `UPDATE class_task_items SET status=?, note=?, submitted_at=?,
         updated_at=datetime('now','localtime')
       WHERE task_id=? AND student_id IN (${placeholders})`,
    ).run(options.status, text(options.note), submittedAt, Number(taskId), ...ids);
    audit.record('class_task', taskId, 'bulk_update_items', {
      summary: `批量更新材料提交状态：${options.status}（${ids.length}名学生）`,
      params: { student_ids: ids, status: options.status },
      classId, termId, conn,
    });
  })();
  return getTask(taskId, { conn });
}

export function remind(taskId: number, studentIds: Array<number | string> | null = null, options: {
  conn?: Database;
} = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const task = taskRow(taskId, { write: true, conn });
  if (task.status !== '进行中') throw new ClassTaskError('已关闭的班级任务不能催办');
  const rows = missingItems(taskId, { conn });
  const allowed = new Set(rows.map((row) => Number(row.student_id)));
  const selectedSet = new Set<number>();
  if (studentIds === null) {
    for (const id of allowed) selectedSet.add(id);
  } else {
    for (const id of new Set(studentIds.map((item) => Number(item)))) {
      if (allowed.has(id)) selectedSet.add(id);
    }
  }
  const selected = Array.from(selectedSet).sort((a, b) => a - b);
  if (selected.length === 0) {
    return { ok: true, reminded: 0, items: [] };
  }
  const now = nowString();
  const placeholders = selected.map(() => '?').join(',');
  conn.transaction(() => {
    conn.prepare(
      `UPDATE class_task_items SET reminder_count=reminder_count+1,
         last_reminded_at=?, updated_at=datetime('now','localtime')
       WHERE task_id=? AND student_id IN (${placeholders}) AND status='未提交'`,
    ).run(now, Number(taskId), ...selected);
    audit.record('class_task', taskId, 'remind', {
      summary: `批量催办 ${selected.length} 名学生`,
      params: { student_ids: selected }, conn,
    });
  })();
  return { ok: true, reminded: selected.length, items: selected };
}

function basename(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? '';
}

function pathSuffix(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot).slice(0, 12);
}

export function saveAttachment(taskId: number, studentId: number, options: {
  filename: string; contentType: string; content: Buffer; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const task = taskRow(taskId, { write: true, conn });
  if (task.status !== '进行中') throw new ClassTaskError('已关闭的班级任务不能上传材料');
  const item = conn.prepare(
    `SELECT i.* FROM class_task_items i
     JOIN students s ON s.id=i.student_id
     WHERE i.task_id=? AND i.student_id=? AND s.deleted_at=''`,
  ).get(Number(taskId), Number(studentId)) as Record<string, unknown> | undefined;
  if (!item) throw new ClassTaskError('任务中没有该学生');
  const data = Buffer.from(options.content ?? Buffer.alloc(0));
  if (data.length === 0) throw new ClassTaskError('附件不能为空');
  if (data.length > MAX_ATTACHMENT_BYTES) throw new ClassTaskError('附件不能超过 10MB');
  const originalName = basename(text(options.filename) || '提交材料').slice(0, 160);
  const suffix = pathSuffix(originalName);
  const storedName = `${randomBytes(16).toString('hex')}${suffix}`;
  const relativePath = ['attachments', 'class-tasks', String(taskId), String(item.id), storedName].join('/');
  const target = safeResolve(getDb().paths.dataDir, relativePath);
  let attachmentId = 0;
  try {
    atomicWrite(target, data);
    const digest = sha256(data);
    conn.transaction(() => {
      const inserted = conn.prepare(
        `INSERT INTO class_task_attachments(
           task_id, item_id, original_name, stored_name, relative_path,
           content_type, size_bytes, sha256
         ) VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        Number(taskId), Number(item.id), originalName, storedName, relativePath,
        text(options.contentType) || 'application/octet-stream', data.length, digest,
      );
      attachmentId = Number(inserted.lastInsertRowid);
      audit.record('class_task_attachment', attachmentId, 'create', {
        summary: `上传材料：${originalName}`,
        params: { task_id: taskId, student_id: studentId, size_bytes: data.length },
        conn,
      });
    })();
  } catch (error) {
    fs.rmSync(target, { force: true });
    throw error;
  }
  return {
    id: attachmentId, item_id: Number(item.id), original_name: originalName,
    content_type: text(options.contentType) || 'application/octet-stream',
    size_bytes: data.length, download_path: `/api/class-tasks/attachments/${attachmentId}`,
  };
}

export function attachmentFile(attachmentId: number, options: { conn?: Database } = {}): {
  attachment: Record<string, unknown>; path: string;
} {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const row = conn.prepare(
    `SELECT a.* FROM class_task_attachments a
     JOIN class_tasks t ON t.id=a.task_id
     WHERE a.id=? AND t.class_id=? AND t.term_id=? AND t.deleted_at=''`,
  ).get(Number(attachmentId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new ClassTaskError('材料附件不存在');
  let path: string;
  try {
    path = safeResolve(getDb().paths.dataDir, String(row.relative_path));
  } catch {
    throw new ClassTaskError('材料附件文件不存在');
  }
  if (!fs.existsSync(path) || !fs.statSync(path).isFile()) {
    throw new ClassTaskError('材料附件文件不存在');
  }
  return { attachment: row, path };
}

export function onWorkItemTransition(
  conn: Database, before: Record<string, unknown>, nextStatus: string, result: string,
): void {
  const taskId = before.source_id;
  if (String(before.source_type ?? '') !== 'class_task' || !taskId) return;
  const task = conn.prepare(
    "SELECT * FROM class_tasks WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(taskId, before.class_id, before.term_id) as Record<string, unknown> | undefined;
  if (!task) return;
  if (String(task.status) === nextStatus && ['已完成', '已取消'].includes(nextStatus)) return;
  const taskStatus = nextStatus === '已完成' ? '已完成'
    : nextStatus === '已取消' ? '已取消' : '进行中';
  if (nextStatus === '已完成') {
    const missing = missingItems(Number(taskId), { conn });
    if (missing.length > 0) {
      throw new ClassTaskError('材料尚未收齐，请从班级任务页面确认未提交名单后完成');
    }
  }
  conn.prepare(
    `UPDATE class_tasks SET status=?, completed_at=?, completion_result=?,
       closed_with_missing_count=?, updated_at=datetime('now','localtime')
     WHERE id=?`,
  ).run(taskStatus, taskStatus === '已完成' ? nowString() : '', text(result), 0, taskId);
}

sourceTransitionHooks['class_task'] = onWorkItemTransition;
