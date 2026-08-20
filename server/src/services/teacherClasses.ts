import type { Database } from 'better-sqlite3';

import { getDb } from './context.js';
import * as audit from './audit.js';

export class TeacherClassError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

const DEFAULT_TEACHER = 'default';

export function getTeacherClasses(options?: { teacherName?: string }): Array<Record<string, unknown>> {
  const conn = connOf();
  const teacherName = text(options?.teacherName) || DEFAULT_TEACHER;
  return conn.prepare(
    `SELECT tc.*, c.name AS class_name, c.grade, t.name AS term_name
     FROM teacher_classes tc
     JOIN classes c ON c.id=tc.class_id
     LEFT JOIN terms t ON t.class_id=c.id AND t.status='进行中'
     WHERE tc.teacher_name=? AND tc.enabled=1
     ORDER BY tc.sort_order, tc.id`,
  ).all(teacherName) as Array<Record<string, unknown>>;
}

export function addTeacherClass(options: {
  classId: number;
  role?: string;
  subjects?: string;
  sortOrder?: number;
}): Record<string, unknown> {
  const conn = connOf();
  const classId = Number(options.classId);
  const cls = conn.prepare('SELECT id, name, grade FROM classes WHERE id=?').get(classId) as Record<string, unknown> | undefined;
  if (!cls) throw new TeacherClassError('班级不存在');
  const teacherName = DEFAULT_TEACHER;
  const existing = conn.prepare(
    'SELECT id FROM teacher_classes WHERE teacher_name=? AND class_id=?',
  ).get(teacherName, classId) as { id: number } | undefined;
  if (existing) throw new TeacherClassError('该班级已在教师列表中');
  const role = text(options.role) || '任课教师';
  const subjects = text(options.subjects);
  const sortOrder = Number(options.sortOrder ?? 0);
  const result = conn.prepare(
    `INSERT INTO teacher_classes(teacher_name, class_id, role, subjects, sort_order)
     VALUES(?,?,?,?,?)`,
  ).run(teacherName, classId, role, subjects, sortOrder);
  const id = Number(result.lastInsertRowid);
  audit.record('teacher_class', id, 'create', {
    summary: `关联班级：${String(cls.name)}`,
    params: { class_id: classId, role, subjects },
    classId, termId: null,
  });
  return { ok: true, id, class_id: classId, class_name: cls.name, role, subjects, sort_order: sortOrder };
}

export function updateTeacherClass(id: number, options: {
  role?: string;
  subjects?: string;
  sortOrder?: number;
  enabled?: boolean;
}): Record<string, unknown> {
  const conn = connOf();
  const row = conn.prepare('SELECT * FROM teacher_classes WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new TeacherClassError('关联记录不存在');
  const fields: string[] = [];
  const params: unknown[] = [];
  if (options.role !== undefined) { fields.push('role=?'); params.push(text(options.role)); }
  if (options.subjects !== undefined) { fields.push('subjects=?'); params.push(text(options.subjects)); }
  if (options.sortOrder !== undefined) { fields.push('sort_order=?'); params.push(Number(options.sortOrder)); }
  if (options.enabled !== undefined) { fields.push('enabled=?'); params.push(options.enabled ? 1 : 0); }
  if (fields.length === 0) return { ok: true };
  fields.push("updated_at=datetime('now','localtime')");
  params.push(id);
  conn.prepare(`UPDATE teacher_classes SET ${fields.join(', ')} WHERE id=?`).run(...params);
  audit.record('teacher_class', id, 'update', {
    summary: '更新教师班级关联',
    params: options,
    classId: Number(row.class_id), termId: null,
  });
  return { ok: true };
}

export function removeTeacherClass(id: number): void {
  const conn = connOf();
  const row = conn.prepare('SELECT * FROM teacher_classes WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new TeacherClassError('关联记录不存在');
  conn.prepare('DELETE FROM teacher_classes WHERE id=?').run(id);
  audit.record('teacher_class', id, 'delete', {
    summary: '移除教师班级关联',
    classId: Number(row.class_id), termId: null,
  });
}

export function getTeacherTimetable(options: {
  startDate?: string;
  endDate?: string;
  conn?: Database;
}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const teacherName = DEFAULT_TEACHER;
  const classes = conn.prepare(
    'SELECT class_id FROM teacher_classes WHERE teacher_name=? AND enabled=1 ORDER BY sort_order, id',
  ).all(teacherName) as Array<{ class_id: number }>;
  if (classes.length === 0) return [];
  const startDate = text(options.startDate);
  const endDate = text(options.endDate);
  const results: Array<Record<string, unknown>> = [];
  for (const { class_id: classId } of classes) {
    const cls = conn.prepare('SELECT name, grade FROM classes WHERE id=?').get(classId) as Record<string, unknown> | undefined;
    if (!cls) continue;
    const terms = conn.prepare(
      "SELECT id, name, start_date, end_date FROM terms WHERE class_id=? AND status='进行中' ORDER BY id DESC LIMIT 1",
    ).all(classId) as Array<{ id: number; name: string; start_date: string; end_date: string }>;
    if (terms.length === 0) continue;
    const termId = terms[0].id;
    const entryWhere = ["class_id=?", "term_id=?", "status='启用'"];
    const entryParams: unknown[] = [classId, termId];
    const entries = conn.prepare(
      `SELECT weekday, period_no, subject, teacher_name, room, session_type, week_pattern, week_start, week_end
       FROM timetable_entries WHERE ${entryWhere.join(' AND ')} ORDER BY weekday, period_no`,
    ).all(...entryParams) as Array<Record<string, unknown>>;
    for (const entry of entries) {
      results.push({ ...entry, class_id: classId, class_name: cls.name, grade: cls.grade, term_id: termId, term_name: terms[0].name, source: 'timetable' });
    }
    if (startDate && endDate) {
      const changeWhere = ["class_id=?", "term_id=?", "status='生效'", "change_date>=?", "change_date<=?"];
      const changeParams: unknown[] = [classId, termId, startDate, endDate];
      const changes = conn.prepare(
        `SELECT change_date, period_no, action, subject, teacher_name, room, session_type, note
         FROM timetable_changes WHERE ${changeWhere.join(' AND ')} ORDER BY change_date, period_no`,
      ).all(...changeParams) as Array<Record<string, unknown>>;
      for (const change of changes) {
        results.push({ ...change, class_id: classId, class_name: cls.name, grade: cls.grade, term_id: termId, term_name: terms[0].name, source: 'change' });
      }
    }
  }
  return results;
}

export function getTeacherExams(options?: { limit?: number }): Array<Record<string, unknown>> {
  const conn = connOf();
  const teacherName = DEFAULT_TEACHER;
  const limit = Math.max(1, Math.min(Number(options?.limit ?? 50), 500));
  const classes = conn.prepare(
    'SELECT class_id FROM teacher_classes WHERE teacher_name=? AND enabled=1 ORDER BY sort_order, id',
  ).all(teacherName) as Array<{ class_id: number }>;
  if (classes.length === 0) return [];
  const results: Array<Record<string, unknown>> = [];
  for (const { class_id: classId } of classes) {
    const cls = conn.prepare('SELECT name, grade FROM classes WHERE id=?').get(classId) as Record<string, unknown> | undefined;
    if (!cls) continue;
    const terms = conn.prepare(
      "SELECT id, name FROM terms WHERE class_id=? AND status='进行中' ORDER BY id DESC LIMIT 1",
    ).all(classId) as Array<{ id: number; name: string }>;
    if (terms.length === 0) continue;
    const termId = terms[0].id;
    const exams = conn.prepare(
      `SELECT id, name, exam_date, enabled, sort_order
       FROM score_exams WHERE class_id=? AND term_id=? AND enabled=1
       ORDER BY CASE WHEN exam_date='' THEN 1 ELSE 0 END, exam_date DESC, sort_order LIMIT ?`,
    ).all(classId, termId, limit) as Array<Record<string, unknown>>;
    for (const exam of exams) {
      results.push({ ...exam, class_id: classId, class_name: cls.name, grade: cls.grade, term_id: termId, term_name: terms[0].name });
    }
  }
  results.sort((a, b) => {
    const da = String(a.exam_date ?? '');
    const db = String(b.exam_date ?? '');
    if (da && db) return db < da ? -1 : db > da ? 1 : 0;
    if (da) return -1;
    if (db) return 1;
    return 0;
  });
  return results.slice(0, limit);
}
