/* MIG-04 请求级班级/学期上下文（AsyncLocalStorage）。
 * 与 backend/app/services/class_context.py 的请求范围部分语义一致：
 * - 默认（无请求）时取"使用中"班级 + "进行中"学期，否则最近学期。
 * - 归档班级/学期写操作抛 ArchivedScopeError（HTTP 409）。
 * - 本模块只提供上下文与范围解析，班级/学期 CRUD 在 MIG-05 移植。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from 'better-sqlite3';

import type { WorkbenchDb } from '../db/connection.js';

export class ScopeError extends Error {}
export class ArchivedScopeError extends ScopeError {}

const scopeStore = new AsyncLocalStorage<{ classId: number | null; termId: number | null }>();

export interface ScopeInfo {
  class_id: number;
  class_name: string;
  grade: string;
  class_status: string;
  term_id: number;
  term_name: string;
  start_date: string;
  end_date: string;
  term_status: string;
}

export function bindRequestScope(classId: string | number | null, termId: string | number | null): void {
  let parsedClass: number | null = null;
  let parsedTerm: number | null = null;
  if (classId !== null && classId !== '') {
    parsedClass = Number(classId);
    if (!Number.isInteger(parsedClass)) throw new ScopeError('班级或学期参数格式不正确');
  }
  if (termId !== null && termId !== '') {
    parsedTerm = Number(termId);
    if (!Number.isInteger(parsedTerm)) throw new ScopeError('班级或学期参数格式不正确');
  }
  scopeStore.enterWith({ classId: parsedClass, termId: parsedTerm });
}

export function resetRequestScope(): void {
  scopeStore.enterWith({ classId: null, termId: null });
}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

let database: WorkbenchDb | null = null;

export function getDatabase(): WorkbenchDb | null {
  return database;
}

/** 测试/启动时注入数据库实例。 */
export function setDatabase(db: WorkbenchDb | null): void {
  database = db;
}

export function getDb(): WorkbenchDb {
  if (!database) throw new Error('数据库尚未注入，请先调用 setDatabase()');
  return database;
}

export function getCurrentScope(options: { write?: boolean; conn?: Database } = {}): ScopeInfo {
  const conn = connOf(options.conn);
  const { classId, termId } = scopeStore.getStore() ?? { classId: null, termId: null };
  const params: unknown[] = [];
  const where: string[] = [];
  if (termId !== null) {
    where.push('t.id=?');
    params.push(termId);
  }
  if (classId !== null) {
    where.push('c.id=?');
    params.push(classId);
  }
  const sqlBase = [
    'SELECT c.id AS class_id, c.name AS class_name, c.grade, c.status AS class_status, ',
    't.id AS term_id, t.name AS term_name, t.start_date, t.end_date, t.status AS term_status ',
    'FROM terms t JOIN classes c ON c.id=t.class_id',
  ].join('');
  let sql = sqlBase;
  if (where.length > 0) {
    sql += ' WHERE ' + where.join(' AND ');
  } else {
    sql += " WHERE c.status='使用中' AND t.status='进行中'";
  }
  sql += ' ORDER BY CASE WHEN c.status=\'使用中\' THEN 0 ELSE 1 END, '
    + 'CASE WHEN t.status=\'进行中\' THEN 0 ELSE 1 END, c.id, t.id DESC LIMIT 1';
  let row = conn.prepare(sql).get(...params) as ScopeInfo | undefined;
  if (!row) {
    if (classId !== null || termId !== null) {
      throw new ScopeError('所选班级或学期不存在，可能已被移除');
    }
    row = conn.prepare(sqlBase + ' ORDER BY t.id DESC LIMIT 1').get() as ScopeInfo | undefined;
  }
  if (!row) {
    throw new ScopeError('尚未创建班级和学期');
  }
  if (options.write && (row.class_status === '已归档' || row.term_status === '已归档')) {
    throw new ArchivedScopeError('已归档的班级或学期只能查看，不能修改');
  }
  return row;
}

export function scopeIds(options: { write?: boolean; conn?: Database } = {}): [number, number] {
  const scope = getCurrentScope(options);
  return [Number(scope.class_id), Number(scope.term_id)];
}

export function ensureStudentInScope(
  studentId: number,
  options: { write?: boolean; conn?: Database } = {},
): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds(options);
  const statusFilter = options.write ? " AND e.status='在读'" : '';
  const row = conn.prepare(
    'SELECT s.*, e.id AS enrollment_id, e.status AS enrollment_status '
    + 'FROM students s JOIN student_enrollments e ON e.student_id=s.id '
    + `WHERE s.id=? AND e.class_id=? AND e.term_id=? AND s.deleted_at='' ${statusFilter}`,
  ).get(studentId, classId, termId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new ScopeError('学生不在当前班级和学期中，或当前不是在读状态');
  }
  return row;
}

/* ---------------- 班级 / 学期 / 在班关系 CRUD（MIG-05） ---------------- */

export function listContexts(conn?: Database): Record<string, unknown> {
  const db = connOf(conn);
  const current = getCurrentScope({ conn: db });
  const classes = [];
  const classRows = db.prepare(
    "SELECT * FROM classes ORDER BY CASE WHEN status='使用中' THEN 0 ELSE 1 END, id",
  ).all() as Array<Record<string, unknown>>;
  const termStmt = db.prepare(
    `SELECT t.*,
            COUNT(e.id) AS student_count,
            SUM(CASE WHEN e.status='在读' THEN 1 ELSE 0 END) AS active_student_count
     FROM terms t
     LEFT JOIN student_enrollments e ON e.term_id=t.id AND e.class_id=t.class_id
     WHERE t.class_id=? GROUP BY t.id
     ORDER BY CASE WHEN t.status='进行中' THEN 0 ELSE 1 END, t.id DESC`,
  );
  for (const classRow of classRows) {
    const item = { ...classRow };
    const terms = (termStmt.all(classRow.id) as Array<Record<string, unknown>>).map((term) => ({
      ...term,
      student_count: Number(term.student_count ?? 0),
      active_student_count: Number(term.active_student_count ?? 0),
    }));
    item.terms = terms;
    classes.push(item);
  }
  return { current, classes };
}

export function createClass(
  name: string, grade = '', termName = '默认学期',
  startDate = '', endDate = '', conn?: Database,
): Record<string, unknown> {
  const db = connOf(conn);
  const cleanName = String(name ?? '').trim();
  const cleanTerm = String(termName ?? '').trim();
  if (!cleanName || !cleanTerm) {
    throw new ScopeError('班级名称和首个学期名称不能为空');
  }
  // better-sqlite3 语句自动提交，班级+学期必须在一个显式事务中（失败回滚，与 Python 一致）。
  return db.transaction(() => {
    const inserted = db.prepare('INSERT INTO classes(name, grade) VALUES(?,?)')
      .run(cleanName, String(grade ?? '').trim());
    const classId = Number(inserted.lastInsertRowid);
    const termInserted = db.prepare(
      'INSERT INTO terms(class_id, name, start_date, end_date) VALUES(?,?,?,?)',
    ).run(classId, cleanTerm, String(startDate ?? '').trim(), String(endDate ?? '').trim());
    return { class_id: classId, term_id: Number(termInserted.lastInsertRowid) };
  })();
}

export function updateClass(
  classId: number,
  options: { name?: string | null; grade?: string | null; status?: string | null; conn?: Database } = {},
): void {
  const db = connOf(options.conn);
  const fields: string[] = [];
  const params: unknown[] = [];
  if (options.name !== undefined && options.name !== null) {
    if (!String(options.name).trim()) throw new ScopeError('班级名称不能为空');
    fields.push('name=?');
    params.push(String(options.name).trim());
  }
  if (options.grade !== undefined && options.grade !== null) {
    fields.push('grade=?');
    params.push(String(options.grade).trim());
  }
  if (options.status !== undefined && options.status !== null) {
    if (!['使用中', '已归档'].includes(String(options.status))) {
      throw new ScopeError('班级状态不合法');
    }
    if (options.status === '已归档' && db.prepare(
      "SELECT 1 FROM terms WHERE class_id=? AND status='进行中'",
    ).get(classId)) {
      throw new ScopeError('请先归档该班级下仍在进行的学期');
    }
    fields.push('status=?', 'archived_at=?');
    params.push(options.status, options.status === '已归档' ? minuteString() : '');
  }
  if (fields.length === 0) return;
  params.push(classId);
  const result = db.prepare(
    `UPDATE classes SET ${fields.join(', ')}, updated_at=datetime('now','localtime') WHERE id=?`,
  ).run(...params);
  if (result.changes === 0) {
    throw new ScopeError('班级不存在');
  }
  void auditRecord('class', classId, options.status === '已归档' ? 'archive' : 'update', {
    summary: options.status === '已归档' ? '归档班级' : '更新班级',
    params: { name: options.name, grade: options.grade, status: options.status },
    classId, termId: null,
  });
}

export function createTerm(
  classId: number, name: string, startDate = '', endDate = '', conn?: Database,
): number {
  const db = connOf(conn);
  if (!db.prepare("SELECT 1 FROM classes WHERE id=? AND status='使用中'").get(classId)) {
    throw new ScopeError('班级不存在或已归档');
  }
  if (!String(name ?? '').trim()) throw new ScopeError('学期名称不能为空');
  try {
    const inserted = db.prepare(
      'INSERT INTO terms(class_id, name, start_date, end_date) VALUES(?,?,?,?)',
    ).run(classId, String(name).trim(), String(startDate ?? '').trim(), String(endDate ?? '').trim());
    return Number(inserted.lastInsertRowid);
  } catch (error) {
    throw error;
  }
}

export function updateTerm(
  termId: number,
  options: { name?: string | null; startDate?: string | null; endDate?: string | null; status?: string | null; conn?: Database } = {},
): void {
  const db = connOf(options.conn);
  const fields: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of [
    ['name', options.name],
    ['start_date', options.startDate],
    ['end_date', options.endDate],
  ] as Array<[string, string | null | undefined]>) {
    if (value !== undefined && value !== null) {
      if (key === 'name' && !String(value).trim()) throw new ScopeError('学期名称不能为空');
      fields.push(`${key}=?`);
      params.push(String(value).trim());
    }
  }
  if (options.status !== undefined && options.status !== null) {
    if (!['进行中', '已归档'].includes(String(options.status))) {
      throw new ScopeError('学期状态不合法');
    }
    fields.push('status=?', 'archived_at=?');
    params.push(options.status, options.status === '已归档' ? minuteString() : '');
  }
  if (fields.length === 0) return;
  params.push(termId);
  const result = db.prepare(
    `UPDATE terms SET ${fields.join(', ')}, updated_at=datetime('now','localtime') WHERE id=?`,
  ).run(...params);
  if (result.changes === 0) throw new ScopeError('学期不存在');
  const term = db.prepare('SELECT class_id FROM terms WHERE id=?').get(termId) as
    { class_id: number } | undefined;
  void auditRecord('term', termId, options.status === '已归档' ? 'archive' : 'update', {
    summary: options.status === '已归档' ? '归档学期' : '更新学期',
    params: { name: options.name, start_date: options.startDate, end_date: options.endDate, status: options.status },
    classId: term ? Number(term.class_id) : null, termId,
  });
}

export function enrollStudent(
  studentId: number,
  options: { classId?: number | null; termId?: number | null; status?: string; conn?: Database; commit?: boolean } = {},
): number {
  const db = connOf(options.conn);
  let classId = options.classId ?? null;
  let termId = options.termId ?? null;
  if (classId === null || termId === null) {
    const scope = getCurrentScope({ write: true, conn: db });
    if (classId === null) classId = Number(scope.class_id);
    if (termId === null) termId = Number(scope.term_id);
  }
  const status = options.status ?? '在读';
  if (!['在读', '转出', '毕业'].includes(status)) throw new ScopeError('在班状态不合法');
  const term = db.prepare('SELECT class_id, status FROM terms WHERE id=?').get(termId) as
    { class_id: number; status: string } | undefined;
  if (!term || Number(term.class_id) !== Number(classId)) throw new ScopeError('班级与学期不匹配');
  if (term.status === '已归档') throw new ArchivedScopeError('不能向已归档学期添加学生');
  if (!db.prepare("SELECT 1 FROM students WHERE id=? AND deleted_at=''").get(studentId)) {
    throw new ScopeError('学生不存在');
  }
  db.prepare(
    `INSERT INTO student_enrollments(student_id, class_id, term_id, status, joined_at, left_at)
     VALUES(?,?,?,?,date('now','localtime'),?)
     ON CONFLICT(student_id, class_id, term_id) DO UPDATE SET
       status=excluded.status,
       joined_at=CASE WHEN student_enrollments.joined_at='' THEN excluded.joined_at ELSE student_enrollments.joined_at END,
       left_at=excluded.left_at,
       updated_at=datetime('now','localtime')`,
  ).run(studentId, classId, termId, status, status === '在读' ? '' : todayIso());
  const row = db.prepare(
    'SELECT id FROM student_enrollments WHERE student_id=? AND class_id=? AND term_id=?',
  ).get(studentId, classId, termId) as { id: number };
  return Number(row.id);
}

export function updateEnrollment(enrollmentId: number, status: string, conn?: Database): void {
  const db = connOf(conn);
  const [classId, termId] = scopeIds({ write: true, conn: db });
  if (!['在读', '转出', '毕业'].includes(status)) throw new ScopeError('在班状态不合法');
  const row = db.prepare(
    'SELECT e.*, t.status AS term_status FROM student_enrollments e '
    + 'JOIN terms t ON t.id=e.term_id WHERE e.id=? AND e.class_id=? AND e.term_id=?',
  ).get(enrollmentId, classId, termId) as { term_status: string } | undefined;
  if (!row) throw new ScopeError('在班记录不存在');
  if (row.term_status === '已归档') throw new ArchivedScopeError('已归档学期不能修改在班状态');
  db.prepare(
    "UPDATE student_enrollments SET status=?, left_at=?, updated_at=datetime('now','localtime') WHERE id=?",
  ).run(status, status === '在读' ? '' : todayIso(), enrollmentId);
}

export function transferEnrollment(
  enrollmentId: number, targetClassId: number, targetTermId: number, conn?: Database,
): number {
  const db = connOf(conn);
  const [sourceClassId, sourceTermId] = scopeIds({ write: true, conn: db });
  const source = db.prepare(
    'SELECT e.*, t.status AS term_status FROM student_enrollments e '
    + 'JOIN terms t ON t.id=e.term_id '
    + 'WHERE e.id=? AND e.class_id=? AND e.term_id=?',
  ).get(enrollmentId, sourceClassId, sourceTermId) as Record<string, unknown> | undefined;
  if (!source) throw new ScopeError('当前班级中没有该在班记录');
  if (source.status !== '在读') throw new ScopeError('只有在读学生可以办理转班');
  const target = db.prepare(
    'SELECT t.id, t.class_id, t.status AS term_status, c.status AS class_status '
    + 'FROM terms t JOIN classes c ON c.id=t.class_id '
    + 'WHERE t.id=? AND t.class_id=?',
  ).get(targetTermId, targetClassId) as { term_status: string; class_status: string } | undefined;
  if (!target || target.term_status !== '进行中' || target.class_status !== '使用中') {
    throw new ScopeError('目标班级或学期不存在，或已经归档');
  }
  if (Number(targetClassId) === Number(sourceClassId) && Number(targetTermId) === Number(sourceTermId)) {
    throw new ScopeError('目标班级和学期不能与当前相同');
  }
  const today = todayIso();
  db.prepare(
    "UPDATE student_enrollments SET status='转出', left_at=?, updated_at=datetime('now','localtime') WHERE id=?",
  ).run(today, enrollmentId);
  db.prepare(
    `INSERT INTO student_enrollments(student_id, class_id, term_id, status, joined_at, left_at)
     VALUES(?,?,?,'在读',?,'')
     ON CONFLICT(student_id, class_id, term_id) DO UPDATE SET
       status='在读', joined_at=excluded.joined_at, left_at='',
       updated_at=datetime('now','localtime')`,
  ).run(source.student_id, targetClassId, targetTermId, today);
  const targetRow = db.prepare(
    'SELECT id FROM student_enrollments WHERE student_id=? AND class_id=? AND term_id=?',
  ).get(source.student_id, targetClassId, targetTermId) as { id: number };
  return Number(targetRow.id);
}

export function listStudentDirectory(conn?: Database): Array<Record<string, unknown>> {
  const db = connOf(conn);
  return db.prepare(
    `SELECT s.id, s.学号, s.姓名, s.性别,
            GROUP_CONCAT(c.name || ' · ' || t.name || ' · ' || e.status, '；') AS memberships
     FROM students s
     LEFT JOIN student_enrollments e ON e.student_id=s.id
     LEFT JOIN classes c ON c.id=e.class_id
     LEFT JOIN terms t ON t.id=e.term_id
     WHERE s.deleted_at=''
     GROUP BY s.id ORDER BY s.学号`,
  ).all() as Array<Record<string, unknown>>;
}

export function listEnrollments(conn?: Database): Array<Record<string, unknown>> {
  const db = connOf(conn);
  const [classId, termId] = scopeIds({ conn: db });
  return db.prepare(
    `SELECT e.id, e.student_id, e.status, e.joined_at, e.left_at,
            s.学号, s.姓名, s.性别, s.班级任职
     FROM student_enrollments e JOIN students s ON s.id=e.student_id
     WHERE e.class_id=? AND e.term_id=? AND s.deleted_at='' ORDER BY s.学号`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
}

export function rolloverTerm(
  sourceTermId: number, name: string, startDate = '', endDate = '', archiveSource = true,
  conn?: Database,
): Record<string, unknown> {
  const db = connOf(conn);
  const cleanName = String(name ?? '').trim();
  if (!cleanName) throw new ScopeError('新学期名称不能为空');
  const source = db.prepare('SELECT * FROM terms WHERE id=?').get(sourceTermId) as
    Record<string, unknown> | undefined;
  if (!source) throw new ScopeError('原学期不存在');
  if (source.status === '已归档') throw new ArchivedScopeError('原学期已经归档，不能重复结转');
  const termInserted = db.prepare(
    'INSERT INTO terms(class_id, name, start_date, end_date) VALUES(?,?,?,?)',
  ).run(source.class_id, cleanName, String(startDate ?? '').trim(), String(endDate ?? '').trim());
  const termId = Number(termInserted.lastInsertRowid);
  db.prepare(
    `INSERT INTO student_enrollments(student_id, class_id, term_id, status, joined_at)
     SELECT student_id, class_id, ?, '在读', date('now','localtime')
     FROM student_enrollments WHERE term_id=? AND status='在读'`,
  ).run(termId, sourceTermId);
  db.prepare(
    `INSERT INTO attendance_rules(name, metric, threshold, period_days, priority, enabled, scene, class_id, term_id)
     SELECT name, metric, threshold, period_days, priority, enabled, scene, class_id, ?
     FROM attendance_rules WHERE term_id=?`,
  ).run(termId, sourceTermId);
  db.prepare(
    `INSERT INTO score_subjects(
       class_id, term_id, name, full_score, sort_order, enabled
     )
     SELECT class_id, ?, name, full_score, sort_order, enabled
     FROM score_subjects WHERE term_id=?`,
  ).run(termId, sourceTermId);
  db.prepare(
    `INSERT INTO score_rules(
       class_id, term_id, name, metric, subject_id, threshold, priority, enabled
     )
     SELECT r.class_id, ?, r.name, r.metric, next_subject.id,
            r.threshold, r.priority, r.enabled
     FROM score_rules r
     LEFT JOIN score_subjects old_subject ON old_subject.id=r.subject_id
     LEFT JOIN score_subjects next_subject
       ON next_subject.class_id=r.class_id AND next_subject.term_id=?
        AND next_subject.name=old_subject.name
     WHERE r.term_id=? AND r.deleted_at=''`,
  ).run(termId, termId, sourceTermId);
  db.prepare(
    `INSERT INTO point_rules(
       class_id, term_id, name, category, metric, threshold,
       period_days, priority, enabled
     )
     SELECT class_id, ?, name, category, metric, threshold,
            period_days, priority, enabled
     FROM point_rules
     WHERE term_id=? AND deleted_at=''`,
  ).run(termId, sourceTermId);
  db.prepare(
    `INSERT INTO fund_categories(
       class_id, term_id, name, direction, enabled
     )
     SELECT class_id, ?, name, direction, enabled
     FROM fund_categories
     WHERE term_id=? AND deleted_at=''`,
  ).run(termId, sourceTermId);
  db.prepare(
    `INSERT INTO comment_templates(
       class_id, term_id, name, comment_type, content, enabled
     )
     SELECT class_id, ?, name, comment_type, content, enabled
     FROM comment_templates
     WHERE term_id=? AND deleted_at=''`,
  ).run(termId, sourceTermId);
  db.prepare(
    `INSERT INTO meeting_templates(
       class_id, term_id, name, format, content, enabled
     )
     SELECT class_id, ?, name, format, content, enabled
     FROM meeting_templates
     WHERE term_id=?`,
  ).run(termId, sourceTermId);
  db.prepare(
    `INSERT INTO activity_templates(
       class_id, term_id, name, activity_type, description, enabled
     )
     SELECT class_id, ?, name, activity_type, description, enabled
     FROM activity_templates
     WHERE term_id=?`,
  ).run(termId, sourceTermId);
  db.prepare(
    `INSERT INTO class_task_templates(
       class_id, term_id, name, task_type, material_name,
       description, default_due_days, enabled
     )
     SELECT class_id, ?, name, task_type, material_name,
            description, default_due_days, enabled
     FROM class_task_templates
     WHERE term_id=? AND deleted_at=''`,
  ).run(termId, sourceTermId);
  db.prepare(
    `INSERT INTO duty_rotation_rules(
       class_id, term_id, name, area, start_date, end_date,
       weekday_mask, enabled
     )
     SELECT class_id, ?, name, area, start_date, end_date,
            weekday_mask, enabled
     FROM duty_rotation_rules
     WHERE term_id=? AND deleted_at=''`,
  ).run(termId, sourceTermId);
  db.prepare(
    `INSERT INTO duty_rotation_members(rule_id, student_id, position, enabled)
     SELECT next_rule.id, member.student_id, member.position, member.enabled
     FROM duty_rotation_members member
     JOIN duty_rotation_rules old_rule ON old_rule.id=member.rule_id
     JOIN duty_rotation_rules next_rule
       ON next_rule.class_id=old_rule.class_id
        AND next_rule.term_id=?
        AND next_rule.name=old_rule.name
     WHERE old_rule.term_id=? AND old_rule.deleted_at=''`,
  ).run(termId, sourceTermId);
  if (archiveSource) {
    db.prepare(
      "UPDATE terms SET status='已归档', archived_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?",
    ).run(sourceTermId);
  }
  return { term_id: termId, class_id: Number(source.class_id) };
}

function minuteString(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function todayIso(): string {
  return clockToday();
}

// 循环依赖处理：context 不依赖 audit，但审计需要记录班级/学期操作。
import * as auditModule from './audit.js';

function auditRecord(objectType: string, objectId: number, action: string, options: {
  summary: string; params?: Record<string, unknown>; classId: number | null; termId: number | null;
}): void {
  auditModule.record(objectType, objectId, action, {
    summary: options.summary,
    params: options.params,
    classId: options.classId,
    termId: options.termId,
  });
}

function clockToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
