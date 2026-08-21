import type { Database } from 'better-sqlite3';

import { todayString } from './clock.js';
import { ensureStudentInScope, getCurrentScope, getDb, ScopeError, scopeIds } from './context.js';

export class MeetingPrepError extends Error {}

export interface MeetingPrepSection {
  category: string;
  source: string;
  source_label: string;
  date_range: string;
  items: Array<Record<string, unknown>>;
  has_data: boolean;
}

export interface MeetingPrepSummary {
  student: Record<string, unknown>;
  scope: { class_name: string; term_name: string };
  date_range: { start: string; end: string };
  sections: Array<MeetingPrepSection>;
}

export interface MeetingPrepSummaryOptions {
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
}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function resolveDateRange(options: MeetingPrepSummaryOptions, conn: Database): { start: string; end: string } {
  const scope = getCurrentScope({ conn });
  const today = todayString();
  const termStart = isDate(text(scope.start_date)) ? text(scope.start_date) : `${today.slice(0, 4)}-01-01`;
  const termEnd = isDate(text(scope.end_date)) && text(scope.end_date) < today ? text(scope.end_date) : today;
  const start = text(options.dateStart) || (termStart <= termEnd ? termStart : termEnd);
  const end = text(options.dateEnd) || termEnd;
  if (!isDate(start) || !isDate(end)) throw new MeetingPrepError('日期格式不正确，请重新选择');
  if (start > end) throw new MeetingPrepError('起始日期不能晚于截止日期');
  if (end > today) throw new MeetingPrepError('截止日期不能晚于今天，未来记录不会用于会谈分析');
  return { start, end };
}

function emptySection(
  category: string, source: string, sourceLabel: string, dateRange: string,
): MeetingPrepSection {
  return { category, source, source_label: sourceLabel, date_range: dateRange, items: [], has_data: false };
}

export function generateStudentSummary(options: MeetingPrepSummaryOptions): MeetingPrepSummary {
  const conn = connOf(options.conn);
  const studentId = Number(options.studentId);
  let student: Record<string, unknown>;
  try {
    student = ensureStudentInScope(studentId, { conn });
  } catch (error) {
    if (!(error instanceof ScopeError)) throw error;
    throw new MeetingPrepError('学生不存在或不在当前班级/学期');
  }
  if (options.includeHealth === true) {
    throw new MeetingPrepError('健康数据尚未接入会谈准备，请先取消该选项');
  }
  const selected = [
    options.includeScores !== false,
    options.includeAttendance !== false,
    options.includePoints !== false,
    options.includeCommunications !== false,
    options.includeEvents !== false,
  ];
  if (!selected.some(Boolean)) throw new MeetingPrepError('请至少选择一类事实资料');

  const range = resolveDateRange(options, conn);
  const dateRange = `${range.start} ~ ${range.end}`;
  const sections: Array<MeetingPrepSection> = [];
  if (options.includeScores !== false) sections.push(buildScoresSection(conn, studentId, range.start, range.end, dateRange));
  if (options.includeAttendance !== false) sections.push(buildAttendanceSection(conn, studentId, range.start, range.end, dateRange));
  if (options.includePoints !== false) sections.push(buildPointsSection(conn, studentId, range.start, range.end, dateRange));
  if (options.includeCommunications !== false) sections.push(buildCommunicationsSection(conn, studentId, range.start, range.end, dateRange));
  if (options.includeEvents !== false) sections.push(buildEventsSection(conn, studentId, range.start, range.end, dateRange));

  const scope = getCurrentScope({ conn });
  return {
    student: {
      id: student.id,
      学号: student['学号'],
      姓名: student['姓名'],
      性别: student['性别'],
      班级任职: student['班级任职'],
      特长: student['特长'],
      是否住校: student['是否住校'],
    },
    scope: { class_name: scope.class_name, term_name: scope.term_name },
    date_range: range,
    sections,
  };
}

function buildScoresSection(
  conn: Database, studentId: number, dateStart: string, dateEnd: string, dateRange: string,
): MeetingPrepSection {
  const section = emptySection('成绩', 'exam_records', '成绩记录', dateRange);
  const [classId, termId] = scopeIds({ conn });
  const rows = conn.prepare(
    `SELECT e.exam_name, e.exam_date, e.subject, e.score, e.rank, e.record_status
     FROM exam_records e
     WHERE e.student_id=? AND e.class_id=? AND e.term_id=? AND e.deleted_at=''
       AND e.exam_date>=? AND e.exam_date<=?
     ORDER BY e.exam_date DESC, e.exam_name, e.subject`,
  ).all(studentId, classId, termId, dateStart, dateEnd) as Array<Record<string, unknown>>;
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
  return section;
}

function buildAttendanceSection(
  conn: Database, studentId: number, dateStart: string, dateEnd: string, dateRange: string,
): MeetingPrepSection {
  const section = emptySection('考勤', 'attendance_records', '考勤记录', dateRange);
  const [classId, termId] = scopeIds({ conn });
  const rows = conn.prepare(
    `SELECT a.attendance_date, a.scene, a.status, a.reason
     FROM attendance_records a
     WHERE a.student_id=? AND a.class_id=? AND a.term_id=? AND a.deleted_at=''
       AND a.attendance_date>=? AND a.attendance_date<=?
     ORDER BY a.attendance_date DESC`,
  ).all(studentId, classId, termId, dateStart, dateEnd) as Array<Record<string, unknown>>;
  const anomalies = rows.filter(row => String(row.status) !== '出勤');
  if (anomalies.length > 0) {
    section.items = anomalies.map(row => ({
      date: row.attendance_date,
      scene: row.scene,
      status: row.status,
      reason: row.reason,
    }));
    section.has_data = true;
  } else if (rows.length > 0) {
    section.items = [{ summary: `所选范围内有 ${rows.length} 条考勤记录，未记录异常` }];
    section.has_data = true;
  }
  return section;
}

function buildPointsSection(
  conn: Database, studentId: number, dateStart: string, dateEnd: string, dateRange: string,
): MeetingPrepSection {
  const section = emptySection('行为积分', 'point_ledger', '行为积分记录', dateRange);
  const [classId, termId] = scopeIds({ conn });
  const rows = conn.prepare(
    `SELECT p.occurred_at, p.amount, p.category, p.reason
     FROM point_ledger p
     WHERE p.student_id=? AND p.class_id=? AND p.term_id=? AND p.status='有效'
       AND p.occurred_at>=? AND p.occurred_at<=?
     ORDER BY p.occurred_at DESC LIMIT 30`,
  ).all(studentId, classId, termId, dateStart, dateEnd) as Array<Record<string, unknown>>;
  if (rows.length > 0) {
    const total = rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
    section.items = [{ summary: `所选范围内共 ${rows.length} 条记录，合计 ${total} 分` }, ...rows.map(row => ({
      date: row.occurred_at,
      amount: row.amount,
      category: row.category,
      reason: row.reason,
    }))];
    section.has_data = true;
  }
  return section;
}

function buildCommunicationsSection(
  conn: Database, studentId: number, dateStart: string, dateEnd: string, dateRange: string,
): MeetingPrepSection {
  const section = emptySection('家校沟通', 'communications', '家校沟通记录', dateRange);
  const [classId, termId] = scopeIds({ conn });
  const rows = conn.prepare(
    `SELECT c.communicated_at, c.method, c.reason, c.status, c.followup_at
     FROM communications c
     WHERE c.student_id=? AND c.class_id=? AND c.term_id=? AND c.deleted_at=''
       AND c.communicated_at>=? AND c.communicated_at<=?
     ORDER BY c.communicated_at DESC LIMIT 20`,
  ).all(studentId, classId, termId, dateStart, dateEnd) as Array<Record<string, unknown>>;
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
  return section;
}

function buildEventsSection(
  conn: Database, studentId: number, dateStart: string, dateEnd: string, dateRange: string,
): MeetingPrepSection {
  const section = emptySection('学生事件', 'student_events', '学生事件记录', dateRange);
  const [classId, termId] = scopeIds({ conn });
  const rows = conn.prepare(
    `SELECT e.occurred_at, e.event_type, e.description, e.status
     FROM student_events e
     WHERE e.student_id=? AND e.class_id=? AND e.term_id=? AND e.deleted_at=''
       AND e.occurred_at>=? AND e.occurred_at<=?
     ORDER BY e.occurred_at DESC LIMIT 20`,
  ).all(studentId, classId, termId, dateStart, dateEnd) as Array<Record<string, unknown>>;
  if (rows.length > 0) {
    section.items = rows.map(row => ({
      date: row.occurred_at,
      event_type: row.event_type,
      description: row.description,
      status: row.status,
    }));
    section.has_data = true;
  }
  return section;
}
