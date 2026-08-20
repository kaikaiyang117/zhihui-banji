import type { Database } from 'better-sqlite3';

import { getDb, scopeIds, ensureStudentInScope } from './context.js';

export class MeetingPrepError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function maskPhone(value: string): string {
  if (!value || value.length < 7) return value;
  return value.slice(0, 3) + '****' + value.slice(-4);
}

function maskAddress(value: string): string {
  if (!value) return value;
  return value.slice(0, Math.min(3, value.length)) + '****';
}

interface SectionResult {
  category: string;
  source: string;
  date_range: string;
  items: Array<Record<string, unknown>>;
  has_data: boolean;
}

function emptySection(category: string, source: string, dateRange: string): SectionResult {
  return { category, source, date_range: dateRange, items: [], has_data: false };
}

export function generateStudentSummary(options: {
  studentId: number;
  dateStart?: string;
  dateEnd?: string;
  includeScores?: boolean;
  includeAttendance?: boolean;
  includePoints?: boolean;
  includeCommunications?: boolean;
  includeEvents?: boolean;
  includeHealth?: boolean;
  conn?: Database;
}): {
  student: Record<string, unknown>;
  date_range: { start: string; end: string };
  sections: Array<SectionResult>;
} {
  const conn = connOf(options.conn);
  const studentId = Number(options.studentId);
  let student: Record<string, unknown>;
  try {
    student = ensureStudentInScope(studentId, { conn });
  } catch {
    throw new MeetingPrepError('学生不存在或不在当前班级/学期');
  }
  const dateStart = text(options.dateStart);
  const dateEnd = text(options.dateEnd);
  const sections: Array<SectionResult> = [];
  const dateRange = dateStart && dateEnd ? `${dateStart} ~ ${dateEnd}` : '';

  if (options.includeScores !== false) {
    const section = buildScoresSection(conn, studentId, dateStart, dateEnd, dateRange);
    sections.push(section);
  }

  if (options.includeAttendance !== false) {
    const section = buildAttendanceSection(conn, studentId, dateStart, dateEnd, dateRange);
    sections.push(section);
  }

  if (options.includePoints !== false) {
    const section = buildPointsSection(conn, studentId, dateStart, dateEnd, dateRange);
    sections.push(section);
  }

  if (options.includeCommunications !== false) {
    const section = buildCommunicationsSection(conn, studentId, dateStart, dateEnd, dateRange);
    sections.push(section);
  }

  if (options.includeEvents !== false) {
    const section = buildEventsSection(conn, studentId, dateStart, dateEnd, dateRange);
    sections.push(section);
  }

  if (options.includeHealth === true) {
    const section = buildHealthSection(conn, studentId, dateStart, dateEnd, dateRange);
    sections.push(section);
  }

  const safeStudent: Record<string, unknown> = { ...student };
  if (safeStudent['监护人电话']) safeStudent['监护人电话'] = maskPhone(String(safeStudent['监护人电话']));
  if (safeStudent['监护人2电话']) safeStudent['监护人2电话'] = maskPhone(String(safeStudent['监护人2电话']));
  if (safeStudent['家庭住址']) safeStudent['家庭住址'] = maskAddress(String(safeStudent['家庭住址']));

  return {
    student: safeStudent,
    date_range: { start: dateStart, end: dateEnd },
    sections,
  };
}

function buildScoresSection(
  conn: Database, studentId: number, dateStart: string, dateEnd: string, dateRange: string,
): SectionResult {
  const section = emptySection('成绩记录', 'exam_records', dateRange);
  try {
    const [classId, termId] = scopeIds({ conn });
    const where = ["e.student_id=?", "e.class_id=?", "e.term_id=?", "e.deleted_at=''"];
    const params: unknown[] = [studentId, classId, termId];
    if (dateStart) { where.push("e.exam_date>=?"); params.push(dateStart); }
    if (dateEnd) { where.push("e.exam_date<=?"); params.push(dateEnd); }
    const rows = conn.prepare(
      `SELECT e.exam_name, e.exam_date, e.subject, e.score, e.rank, e.record_status
       FROM exam_records e WHERE ${where.join(' AND ')}
       ORDER BY e.exam_date DESC, e.exam_name, e.subject`,
    ).all(...params) as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      section.items = rows.map(row => ({
        exam_name: row.exam_name,
        exam_date: row.exam_date,
        subject: row.subject,
        score: row.score,
        rank: row.rank,
        record_status: row.record_status,
      }));
      section.has_data = true;
    }
  } catch { }
  return section;
}

function buildAttendanceSection(
  conn: Database, studentId: number, dateStart: string, dateEnd: string, dateRange: string,
): SectionResult {
  const section = emptySection('考勤记录', 'attendance_records', dateRange);
  try {
    const [classId, termId] = scopeIds({ conn });
    const where = ["a.student_id=?", "a.class_id=?", "a.term_id=?", "a.deleted_at=''"];
    const params: unknown[] = [studentId, classId, termId];
    if (dateStart) { where.push("a.attendance_date>=?"); params.push(dateStart); }
    if (dateEnd) { where.push("a.attendance_date<=?"); params.push(dateEnd); }
    const rows = conn.prepare(
      `SELECT a.attendance_date, a.scene, a.status, a.reason
       FROM attendance_records a WHERE ${where.join(' AND ')}
       ORDER BY a.attendance_date DESC`,
    ).all(...params) as Array<Record<string, unknown>>;
    const anomalies = rows.filter(r => String(r.status) !== '出勤');
    if (anomalies.length > 0) {
      section.items = anomalies.map(row => ({
        date: row.attendance_date,
        scene: row.scene,
        status: row.status,
        reason: row.reason,
      }));
      section.has_data = true;
    } else if (rows.length > 0) {
      section.items = [{ summary: `共 ${rows.length} 条考勤记录，全部正常出勤` }];
      section.has_data = true;
    }
  } catch { }
  return section;
}

function buildPointsSection(
  conn: Database, studentId: number, dateStart: string, dateEnd: string, dateRange: string,
): SectionResult {
  const section = emptySection('积分记录', 'point_ledger', dateRange);
  try {
    const [classId, termId] = scopeIds({ conn });
    const where = ["p.student_id=?", "p.class_id=?", "p.term_id=?", "p.status='有效'"];
    const params: unknown[] = [studentId, classId, termId];
    if (dateStart) { where.push("p.occurred_at>=?"); params.push(dateStart); }
    if (dateEnd) { where.push("p.occurred_at<=?"); params.push(dateEnd); }
    const rows = conn.prepare(
      `SELECT p.occurred_at, p.amount, p.category, p.reason
       FROM point_ledger p WHERE ${where.join(' AND ')}
       ORDER BY p.occurred_at DESC LIMIT 50`,
    ).all(...params) as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      const total = rows.reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
      section.items = rows.map(row => ({
        date: row.occurred_at,
        amount: row.amount,
        category: row.category,
        reason: row.reason,
      }));
      section.items.unshift({ summary: `共 ${rows.length} 条记录，合计 ${total} 分` });
      section.has_data = true;
    }
  } catch { }
  return section;
}

function buildCommunicationsSection(
  conn: Database, studentId: number, dateStart: string, dateEnd: string, dateRange: string,
): SectionResult {
  const section = emptySection('家校沟通', 'communications', dateRange);
  try {
    const [classId, termId] = scopeIds({ conn });
    const where = ["c.student_id=?", "c.class_id=?", "c.term_id=?", "c.deleted_at=''"];
    const params: unknown[] = [studentId, classId, termId];
    if (dateStart) { where.push("c.communicated_at>=?"); params.push(dateStart); }
    if (dateEnd) { where.push("c.communicated_at<=?"); params.push(dateEnd); }
    const rows = conn.prepare(
      `SELECT c.communicated_at, c.method, c.reason, c.status, c.followup_at
       FROM communications c WHERE ${where.join(' AND ')}
       ORDER BY c.communicated_at DESC LIMIT 20`,
    ).all(...params) as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      section.items = rows.map(row => ({
        date: row.communicated_at,
        method: row.method,
        reason: row.reason,
        status: row.status,
        followup_at: row.followup_at,
      }));
      section.has_data = true;
    }
  } catch { }
  return section;
}

function buildEventsSection(
  conn: Database, studentId: number, dateStart: string, dateEnd: string, dateRange: string,
): SectionResult {
  const section = emptySection('学生事件', 'student_events', dateRange);
  try {
    const [classId, termId] = scopeIds({ conn });
    const where = ["e.student_id=?", "e.class_id=?", "e.term_id=?", "e.deleted_at=''"];
    const params: unknown[] = [studentId, classId, termId];
    if (dateStart) { where.push("e.occurred_at>=?"); params.push(dateStart); }
    if (dateEnd) { where.push("e.occurred_at<=?"); params.push(dateEnd); }
    const rows = conn.prepare(
      `SELECT e.occurred_at, e.event_type, e.description, e.status
       FROM student_events e WHERE ${where.join(' AND ')}
       ORDER BY e.occurred_at DESC LIMIT 20`,
    ).all(...params) as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      section.items = rows.map(row => ({
        date: row.occurred_at,
        event_type: row.event_type,
        description: row.description,
        status: row.status,
      }));
      section.has_data = true;
    }
  } catch { }
  return section;
}

function buildHealthSection(
  _conn: Database, _studentId: number, _dateStart: string, _dateEnd: string, dateRange: string,
): SectionResult {
  return emptySection('健康数据', 'health', dateRange);
}
