import type { Database } from 'better-sqlite3';

import { getCurrentScope, getDb } from './context.js';
import * as audit from './audit.js';

export class TeacherClassError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

const DEFAULT_TEACHER = 'default';

function parseSubjects(value: unknown): string[] {
  return [...new Set(text(value).split(/[、,，/；;|]+/).map((item) => item.trim()).filter(Boolean))];
}

function subjectMatches(subject: unknown, subjects: string[]): boolean {
  return subjects.includes(text(subject));
}

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

function scheduleInteger(value: unknown, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new TeacherClassError(`${label}必须在 ${min} 到 ${max} 之间`);
  }
  return parsed;
}

function activeClassTerm(conn: Database, classIdValue: unknown): { class_id: number; term_id: number } {
  const classId = scheduleInteger(classIdValue, '班级', 1, Number.MAX_SAFE_INTEGER);
  const row = conn.prepare(
    `SELECT c.id AS class_id, t.id AS term_id
     FROM classes c JOIN terms t ON t.class_id=c.id
     WHERE c.id=? AND c.status='使用中' AND t.status='进行中'
     ORDER BY t.id DESC LIMIT 1`,
  ).get(classId) as { class_id: number; term_id: number } | undefined;
  if (!row) throw new TeacherClassError('班级不存在或当前学期不可用');
  return row;
}

function teacherScheduleEntry(conn: Database, id: number): Record<string, unknown> {
  const row = conn.prepare(
    `SELECT e.*, c.name AS class_name, c.grade, t.name AS term_name
     FROM teacher_schedule_entries e
     JOIN classes c ON c.id=e.class_id
     JOIN terms t ON t.id=e.term_id
     WHERE e.id=?`,
  ).get(id) as Record<string, unknown> | undefined;
  if (!row) throw new TeacherClassError('授课安排不存在');
  return row;
}

function ensureTeacherSlotAvailable(conn: Database, weekday: number, periodNo: number, excludeId?: number): void {
  const params: unknown[] = [DEFAULT_TEACHER, weekday, periodNo];
  let sql = "SELECT id FROM teacher_schedule_entries WHERE teacher_name=? AND weekday=? AND period_no=? AND status='启用'";
  if (excludeId) { sql += ' AND id<>?'; params.push(excludeId); }
  if (conn.prepare(sql).get(...params)) throw new TeacherClassError('该时间已有授课安排');
}

export function getTeacherSchedule(options?: { conn?: Database }): Record<string, unknown> {
  const conn = connOf(options?.conn);
  const current = getCurrentScope({ conn });
  const classes = conn.prepare(
    `SELECT c.id, c.name, c.grade, t.id AS term_id, t.name AS term_name
     FROM classes c JOIN terms t ON t.class_id=c.id
     WHERE c.status='使用中' AND t.status='进行中'
     ORDER BY c.id, t.id DESC`,
  ).all() as Array<Record<string, unknown>>;
  const entries = conn.prepare(
    `SELECT e.*, c.name AS class_name, c.grade, t.name AS term_name
     FROM teacher_schedule_entries e
     JOIN classes c ON c.id=e.class_id
     JOIN terms t ON t.id=e.term_id
     WHERE e.teacher_name=? AND e.status='启用' AND c.status='使用中' AND t.status='进行中'
     ORDER BY e.period_no, e.weekday, e.id`,
  ).all(DEFAULT_TEACHER) as Array<Record<string, unknown>>;
  const configuredPeriods = conn.prepare(
    `SELECT period_no, label, start_time, end_time, session_type
     FROM timetable_periods
     WHERE class_id=? AND term_id=? AND enabled=1 ORDER BY period_no`,
  ).all(current.class_id, current.term_id) as Array<Record<string, unknown>>;
  const configuredByNo = new Map(configuredPeriods.map((item) => [Number(item.period_no), item]));
  const maxPeriod = Math.max(8, ...configuredPeriods.map(item => Number(item.period_no)), ...entries.map(item => Number(item.period_no)));
  const periods = Array.from({ length: maxPeriod }, (_, index) => {
    const periodNo = index + 1;
    return configuredByNo.get(periodNo) ?? {
      period_no: periodNo, label: `第${periodNo}节`, start_time: '', end_time: '', session_type: '普通课',
    };
  });
  return { periods, entries, classes };
}

export function createTeacherScheduleEntry(options: {
  classId: number; weekday: number; periodNo: number; subject?: string; room?: string; note?: string;
}): Record<string, unknown> {
  const conn = connOf();
  const weekday = scheduleInteger(options.weekday, '星期', 1, 7);
  const periodNo = scheduleInteger(options.periodNo, '节次', 1, 20);
  const classTerm = activeClassTerm(conn, options.classId);
  ensureTeacherSlotAvailable(conn, weekday, periodNo);
  const result = conn.prepare(
    `INSERT INTO teacher_schedule_entries
       (teacher_name, class_id, term_id, weekday, period_no, subject, room, note)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(DEFAULT_TEACHER, classTerm.class_id, classTerm.term_id, weekday, periodNo,
    text(options.subject), text(options.room), text(options.note));
  const id = Number(result.lastInsertRowid);
  audit.record('teacher_schedule_entry', id, 'create', {
    summary: `新增个人授课安排：周${weekday}第${periodNo}节`,
    params: { class_id: classTerm.class_id, weekday, period_no: periodNo, subject: text(options.subject) },
    classId: classTerm.class_id, termId: classTerm.term_id, conn,
  });
  return teacherScheduleEntry(conn, id);
}

export function updateTeacherScheduleEntry(id: number, options: {
  classId?: number; weekday?: number; periodNo?: number; subject?: string; room?: string; note?: string;
}): Record<string, unknown> {
  const conn = connOf();
  const current = teacherScheduleEntry(conn, id);
  if (current.status !== '启用') throw new TeacherClassError('授课安排不存在');
  const weekday = scheduleInteger(options.weekday ?? current.weekday, '星期', 1, 7);
  const periodNo = scheduleInteger(options.periodNo ?? current.period_no, '节次', 1, 20);
  const classTerm = activeClassTerm(conn, options.classId ?? current.class_id);
  ensureTeacherSlotAvailable(conn, weekday, periodNo, id);
  const subject = options.subject === undefined ? text(current.subject) : text(options.subject);
  const room = options.room === undefined ? text(current.room) : text(options.room);
  const note = options.note === undefined ? text(current.note) : text(options.note);
  conn.prepare(
    `UPDATE teacher_schedule_entries
     SET class_id=?, term_id=?, weekday=?, period_no=?, subject=?, room=?, note=?, updated_at=datetime('now','localtime')
     WHERE id=? AND teacher_name=? AND status='启用'`,
  ).run(classTerm.class_id, classTerm.term_id, weekday, periodNo, subject, room, note, id, DEFAULT_TEACHER);
  audit.record('teacher_schedule_entry', id, 'update', {
    summary: `更新个人授课安排：周${weekday}第${periodNo}节`,
    params: { class_id: classTerm.class_id, weekday, period_no: periodNo, subject },
    classId: classTerm.class_id, termId: classTerm.term_id, conn,
  });
  return teacherScheduleEntry(conn, id);
}

export function removeTeacherScheduleEntry(id: number): void {
  const conn = connOf();
  const current = teacherScheduleEntry(conn, id);
  if (current.status !== '启用') throw new TeacherClassError('授课安排不存在');
  conn.prepare(
    "UPDATE teacher_schedule_entries SET status='已移除', updated_at=datetime('now','localtime') WHERE id=? AND teacher_name=?",
  ).run(id, DEFAULT_TEACHER);
  audit.record('teacher_schedule_entry', id, 'delete', {
    summary: '移除个人授课安排', classId: Number(current.class_id), termId: Number(current.term_id), conn,
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
    'SELECT class_id, subjects FROM teacher_classes WHERE teacher_name=? AND enabled=1 ORDER BY sort_order, id',
  ).all(teacherName) as Array<{ class_id: number; subjects: string }>;
  if (classes.length === 0) return [];
  const startDate = text(options.startDate);
  const endDate = text(options.endDate);
  const results: Array<Record<string, unknown>> = [];
  for (const { class_id: classId, subjects: subjectText } of classes) {
    const subjects = parseSubjects(subjectText);
    if (subjects.length === 0) continue;
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
    for (const entry of entries.filter((item) => subjectMatches(item.subject, subjects))) {
      results.push({ ...entry, class_id: classId, class_name: cls.name, grade: cls.grade, term_id: termId, term_name: terms[0].name, source: 'timetable' });
    }
    if (startDate && endDate) {
      const changeWhere = ["class_id=?", "term_id=?", "status='生效'", "change_date>=?", "change_date<=?"];
      const changeParams: unknown[] = [classId, termId, startDate, endDate];
      const changes = conn.prepare(
        `SELECT change_date, period_no, action, subject, teacher_name, room, session_type, note
         FROM timetable_changes WHERE ${changeWhere.join(' AND ')} ORDER BY change_date, period_no`,
      ).all(...changeParams) as Array<Record<string, unknown>>;
      for (const change of changes.filter((item) => subjectMatches(item.subject, subjects))) {
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
