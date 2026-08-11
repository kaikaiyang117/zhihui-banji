/* MIG-04 核心业务记录软删除、回收站恢复与受控永久删除。
 * 与 backend/app/services/recycle.py 语义一致（含联动工作项、审计、二次确认）。
 */
import type { Database } from 'better-sqlite3';

import { getDb, scopeIds, ensureStudentInScope } from './context.js';
import * as audit from './audit.js';

export class RecycleError extends Error {}

interface ObjectConfig {
  table: string;
  label: string[];
  scoped: boolean;
}

const OBJECTS: Record<string, ObjectConfig> = {
  student: { table: 'students', label: ['学号', '姓名'], scoped: false },
  event: { table: 'student_events', label: ['event_type', 'description'], scoped: true },
  work_item: { table: 'student_tasks', label: ['title'], scoped: true },
  focus: { table: 'focus_items', label: ['topic'], scoped: true },
  communication: { table: 'communications', label: ['reason', 'summary'], scoped: true },
  exam: { table: 'exam_records', label: ['exam_name', 'subject'], scoped: true },
  attendance_rule: { table: 'attendance_rules', label: ['name'], scoped: true },
  score_rule: { table: 'score_rules', label: ['name'], scoped: true },
  class_task: { table: 'class_tasks', label: ['title'], scoped: true },
  duty_assignment: { table: 'duty_assignments', label: ['duty_date', 'area'], scoped: true },
  meeting: { table: 'meeting_records', label: ['held_on', 'topic'], scoped: true },
  activity: { table: 'activity_records', label: ['occurred_on', 'name'], scoped: true },
  diary: { table: 'diary_entries', label: ['diary_date', 'work'], scoped: true },
};

function nowString(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function label(row: Record<string, unknown>, fields: string[]): string {
  const values = fields
    .map((field) => String(row[field] ?? '').trim())
    .filter((value) => value.length > 0);
  return values.join(' · ').slice(0, 160);
}

function entry(entryId: number, options: { status?: string; conn?: Database } = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    'SELECT * FROM recycle_bin WHERE id=? AND class_id=? AND term_id=? AND status=?',
  ).get(entryId, classId, termId, options.status ?? '已删除') as Record<string, unknown> | undefined;
  if (!row) throw new RecycleError('回收站记录不存在或已处理');
  return row;
}

function loadActive(
  objectType: string, objectId: number, conn: Database,
): { row: Record<string, unknown>; classId: number; termId: number } {
  const config = OBJECTS[objectType];
  if (!config) throw new RecycleError('不支持的记录类型');
  const [classId, termId] = scopeIds({ write: true, conn });
  let row: Record<string, unknown> | undefined;
  if (objectType === 'student') {
    ensureStudentInScope(objectId, { write: true, conn });
    row = conn.prepare("SELECT * FROM students WHERE id=? AND deleted_at=''").get(objectId) as
      Record<string, unknown> | undefined;
  } else {
    row = conn.prepare(
      `SELECT * FROM ${config.table} `
      + "WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
    ).get(objectId, classId, termId) as Record<string, unknown> | undefined;
  }
  if (!row) throw new RecycleError('记录不存在或已删除');
  return { row, classId, termId };
}

export function softDelete(
  objectType: string, objectId: number,
  options: { conn?: Database } = {},
): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const { row, classId, termId } = loadActive(objectType, Number(objectId), conn);
  const config = OBJECTS[objectType];
  const { actorId } = audit.currentActor();
  const deletedAt = nowString();
  let linkedIds: number[] = [];
  if (['event', 'focus', 'communication', 'attendance_rule', 'score_rule',
    'class_task', 'duty_assignment', 'activity', 'meeting'].includes(objectType)) {
    if (objectType === 'meeting') {
      linkedIds = (conn.prepare(
        `SELECT t.id FROM student_tasks t JOIN meeting_actions a ON a.work_item_id=t.id
         WHERE a.meeting_id=? AND t.class_id=? AND t.term_id=? AND t.deleted_at=''`,
      ).all(objectId, classId, termId) as Array<{ id: number }>).map((item) => Number(item.id));
    } else {
      linkedIds = (conn.prepare(
        "SELECT id FROM student_tasks WHERE class_id=? AND term_id=? "
        + "AND source_type=? AND source_id=? AND deleted_at=''",
      ).all(classId, termId, objectType, objectId) as Array<{ id: number }>)
        .map((item) => Number(item.id));
    }
    if (linkedIds.length > 0) row.__linked_work_items = linkedIds;
  }
  let cur;
  if (objectType === 'student') {
    cur = conn.prepare(
      "UPDATE students SET deleted_at=?, deleted_by=? WHERE id=? AND deleted_at=''",
    ).run(deletedAt, actorId, objectId);
  } else {
    cur = conn.prepare(
      `UPDATE ${config.table} SET deleted_at=?, deleted_by=? `
      + "WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
    ).run(deletedAt, actorId, objectId, classId, termId);
  }
  if (cur.changes === 0) throw new RecycleError('记录不存在或已删除');
  if (linkedIds.length > 0) {
    const placeholders = linkedIds.map(() => '?').join(',');
    conn.prepare(
      `UPDATE student_tasks SET deleted_at=?, deleted_by=? WHERE id IN (${placeholders})`,
    ).run(deletedAt, actorId, ...linkedIds);
  }
  const inserted = conn.prepare(
    `INSERT INTO recycle_bin(
       object_type, object_id, class_id, term_id, label, snapshot,
       status, deleted_by, deleted_at
     ) VALUES(?,?,?,?,?,?, '已删除', ?,?)`,
  ).run(
    objectType, String(objectId), classId, termId,
    label(row, config.label), JSON.stringify(row), actorId, deletedAt,
  );
  audit.record(
    objectType, objectId, 'delete', {
      summary: `移入回收站：${label(row, config.label)}`,
      params: { channel: audit.currentActor().channel },
      classId, termId, conn,
    },
  );
  return { ok: true, recycle_id: Number(inserted.lastInsertRowid) };
}

export function listEntries(
  options: { objectType?: string; status?: string; limit?: number; conn?: Database } = {},
): Array<Record<string, unknown>> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const where = ['class_id=?', 'term_id=?'];
  const params: unknown[] = [classId, termId];
  if (options.objectType) {
    where.push('object_type=?');
    params.push(options.objectType);
  }
  if (options.status) {
    where.push('status=?');
    params.push(options.status);
  }
  params.push(Math.max(1, Math.min(Number(options.limit ?? 300), 500)));
  return conn.prepare(
    'SELECT id, object_type, object_id, label, status, deleted_by, deleted_at, '
    + 'restored_at, purged_at FROM recycle_bin WHERE ' + where.join(' AND ')
    + ' ORDER BY id DESC LIMIT ?',
  ).all(...params) as Array<Record<string, unknown>>;
}

export function restore(entryId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const entryRow = entry(entryId, { conn });
  scopeIds({ write: true, conn });
  const objectType = String(entryRow.object_type);
  const snapshot = JSON.parse(String(entryRow.snapshot)) as Record<string, unknown>;
  let cur;
  if (objectType === 'sheet_row') {
    cur = conn.prepare(
      "UPDATE sheet_rows SET deleted_at='', deleted_by='' "
      + 'WHERE sheet=? AND row_no=? AND class_id=? AND term_id=? AND deleted_at<>\'\'',
    ).run(snapshot.sheet, snapshot.row_no, entryRow.class_id, entryRow.term_id);
  } else {
    const config = OBJECTS[objectType];
    if (!config) throw new RecycleError('不支持恢复该记录');
    if (objectType === 'student') {
      cur = conn.prepare(
        "UPDATE students SET deleted_at='', deleted_by='' WHERE id=? AND deleted_at<>''",
      ).run(Number(entryRow.object_id));
    } else {
      cur = conn.prepare(
        `UPDATE ${config.table} SET deleted_at='', deleted_by='' `
        + "WHERE id=? AND class_id=? AND term_id=? AND deleted_at<>''",
      ).run(Number(entryRow.object_id), entryRow.class_id, entryRow.term_id);
    }
  }
  if (cur.changes === 0) throw new RecycleError('原记录已不存在，无法恢复');
  const linkedIds = (snapshot.__linked_work_items ?? []) as number[];
  if (linkedIds.length > 0) {
    const placeholders = linkedIds.map(() => '?').join(',');
    conn.prepare(
      `UPDATE student_tasks SET deleted_at='', deleted_by='' `
      + `WHERE id IN (${placeholders}) AND class_id=? AND term_id=?`,
    ).run(...linkedIds, entryRow.class_id, entryRow.term_id);
  }
  const restoredAt = nowString();
  conn.prepare(
    "UPDATE recycle_bin SET status='已恢复', restored_at=? WHERE id=?",
  ).run(restoredAt, entryId);
  audit.record(
    objectType, String(entryRow.object_id), 'restore', {
      summary: `从回收站恢复：${entryRow.label}`,
      classId: Number(entryRow.class_id), termId: Number(entryRow.term_id), conn,
    },
  );
  return { ok: true };
}

export function purge(entryId: number, confirmation: string, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const entryRow = entry(entryId, { conn });
  scopeIds({ write: true, conn });
  if (confirmation !== '永久删除') {
    audit.record(
      String(entryRow.object_type), String(entryRow.object_id), 'purge', {
        status: 'failed',
        summary: '永久删除确认文字不正确',
        classId: Number(entryRow.class_id), termId: Number(entryRow.term_id), conn,
      },
    );
    throw new RecycleError('请输入"永久删除"完成二次确认');
  }
  const objectType = String(entryRow.object_type);
  const snapshot = JSON.parse(String(entryRow.snapshot)) as Record<string, unknown>;
  let cur;
  if (objectType === 'sheet_row') {
    cur = conn.prepare(
      "DELETE FROM sheet_rows WHERE sheet=? AND row_no=? AND class_id=? AND term_id=? AND deleted_at<>''",
    ).run(snapshot.sheet, snapshot.row_no, entryRow.class_id, entryRow.term_id);
  } else {
    const config = OBJECTS[objectType];
    if (!config) throw new RecycleError('不支持永久删除该记录');
    if (objectType === 'student') {
      cur = conn.prepare(
        "DELETE FROM students WHERE id=? AND deleted_at<>''",
      ).run(Number(entryRow.object_id));
    } else {
      const linkedIds = (snapshot.__linked_work_items ?? []) as number[];
      if (linkedIds.length > 0) {
        const placeholders = linkedIds.map(() => '?').join(',');
        conn.prepare(
          `DELETE FROM student_tasks WHERE id IN (${placeholders}) `
          + "AND class_id=? AND term_id=? AND deleted_at<>''",
        ).run(...linkedIds, entryRow.class_id, entryRow.term_id);
      }
      cur = conn.prepare(
        `DELETE FROM ${config.table} WHERE id=? AND class_id=? AND term_id=? AND deleted_at<>''`,
      ).run(Number(entryRow.object_id), entryRow.class_id, entryRow.term_id);
    }
  }
  if (cur.changes === 0) throw new RecycleError('原记录已不存在');
  const purgedAt = nowString();
  conn.prepare(
    "UPDATE recycle_bin SET status='已永久删除', purged_at=? WHERE id=?",
  ).run(purgedAt, entryId);
  audit.record(
    objectType, String(entryRow.object_id), 'purge', {
      summary: `永久删除：${entryRow.label}`,
      classId: Number(entryRow.class_id), termId: Number(entryRow.term_id), conn,
    },
  );
  return { ok: true };
}
