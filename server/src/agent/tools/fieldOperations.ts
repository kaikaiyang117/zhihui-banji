import { randomBytes } from 'node:crypto';

import { getDb, scopeIds, bindRequestScope } from '../../services/context.js';
import { todayString } from '../../services/clock.js';
import { listUpcomingExams } from '../../services/scores.js';
import { listWorkItems } from '../../services/workItems.js';
import { getTeacherClasses } from '../../services/teacherClasses.js';
import { ToolError } from '../toolRegistry.js';

const ROLL_CALL_TTL_MS = 30 * 60 * 1000;

interface RollCallSession {
  classId: number;
  termId: number;
  className: string;
  date: string;
  scene: string;
  students: Array<{ student_id: number; 学号: string; 姓名: string }>;
  createdAt: number;
}

const sessions = new Map<string, RollCallSession>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.createdAt > ROLL_CALL_TTL_MS) sessions.delete(key);
  }
}

function loadClassStudents(classId: number, termId: number, conn: import('better-sqlite3').Database): Array<{ student_id: number; 学号: string; 姓名: string }> {
  return (conn.prepare(
    'SELECT s.id AS student_id, s.学号, s.姓名 FROM students s '
    + 'JOIN student_enrollments e ON e.student_id=s.id '
    + "WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at='' "
    + 'ORDER BY s.学号, s.id',
  ).all(classId, termId) as Array<{ student_id: number; 学号: string; 姓名: string }>);
}

function findStudentByName(
  name: string, students: Array<{ student_id: number; 学号: string; 姓名: string }>,
): { student_id: number; 姓名: string } {
  const exact = students.filter((s) => s.姓名 === name);
  if (exact.length === 1) return { student_id: exact[0].student_id, 姓名: exact[0].姓名 };
  if (exact.length > 1) {
    const names = exact.map((s) => `${s.姓名}(ID:${s.student_id})`).join('、');
    throw new ToolError(`学生"${name}"存在歧义，匹配到：${names}，请使用学号指定`, { code: 'invalid_arguments', retryable: true });
  }
  const partial = students.filter((s) => s.姓名.includes(name) || name.includes(s.姓名));
  if (partial.length === 1) return { student_id: partial[0].student_id, 姓名: partial[0].姓名 };
  if (partial.length > 1) {
    const names = partial.map((s) => `${s.姓名}(ID:${s.student_id})`).join('、');
    throw new ToolError(`学生"${name}"存在歧义，匹配到：${names}，请使用学号指定`, { code: 'invalid_arguments', retryable: true });
  }
  throw new ToolError(`找不到学生"${name}"，请使用完整姓名或学号`, { code: 'not_found', retryable: true });
}

const VALID_SCENES = new Set(['早自习', '上午', '下午', '晚自习', '常规到校']);
const VALID_STATUSES = new Set(['出勤', '迟到', '早退', '请假', '缺勤']);

function validateScene(scene: string): string {
  const trimmed = String(scene ?? '').trim();
  if (!trimmed) return '常规到校';
  if (!VALID_SCENES.has(trimmed)) {
    throw new ToolError(`考勤场景不合法：${trimmed}，有效值为：${[...VALID_SCENES].join('、')}`, {
      code: 'invalid_arguments', retryable: true,
    });
  }
  return trimmed;
}

function validateStatus(status: string): string {
  const trimmed = String(status ?? '').trim();
  if (!VALID_STATUSES.has(trimmed)) {
    throw new ToolError(`考勤状态不合法：${trimmed}，有效值为：${[...VALID_STATUSES].join('、')}`, { code: 'invalid_arguments', retryable: true });
  }
  return trimmed;
}

function resolveSession(sessionId: string): RollCallSession {
  purgeExpired();
  const session = sessions.get(sessionId);
  if (!session) {
    throw new ToolError('点名会话不存在或已过期，请重新发起点名', { code: 'not_found', retryable: true });
  }
  if (Date.now() - session.createdAt > ROLL_CALL_TTL_MS) {
    sessions.delete(sessionId);
    throw new ToolError('点名会话已过期，请重新发起点名', { code: 'not_found', retryable: true });
  }
  return session;
}

export function startRollCall(args: Record<string, unknown>): Record<string, unknown> {
  purgeExpired();
  const conn = getDb().connInstance;
  const teacherClasses = getTeacherClasses();
  const requested = String(args.class_name ?? '').trim();
  if (requested) {
    const match = teacherClasses.find((tc) => String(tc.class_name) === requested);
    if (!match) {
      const names = teacherClasses.map((tc) => String(tc.class_name)).join('、');
      throw new ToolError(
        teacherClasses.length > 0
          ? `班级"${requested}"不在您的班级列表中，您的班级：${names}`
          : `班级"${requested}"不在您的班级列表中`,
        { code: 'invalid_arguments', retryable: true },
      );
    }
    const termId = match.term_id ?? null;
    bindRequestScope(Number(match.class_id), termId != null ? Number(termId) : null);
  } else if (teacherClasses.length > 1) {
    return {
      multiple_classes: true,
      classes: teacherClasses.map((tc) => ({
        class_id: tc.class_id,
        class_name: tc.class_name,
        grade: tc.grade,
      })),
      hint: '您管理多个班级，请指定 class_name 后重新发起点名',
    };
  } else if (teacherClasses.length === 1) {
    const onlyClass = teacherClasses[0];
    bindRequestScope(Number(onlyClass.class_id), onlyClass.term_id != null ? Number(onlyClass.term_id) : null);
  }
  const [classId, termId] = scopeIds({ conn });
  const scope = conn.prepare(
    'SELECT c.name AS class_name FROM classes c WHERE c.id=?',
  ).get(classId) as { class_name: string } | undefined;
  const className = String(scope?.class_name ?? '');
  const date = String(args.date ?? '').trim() || todayString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ToolError('日期格式应为 YYYY-MM-DD', { code: 'invalid_arguments', retryable: true });
  }
  const scene = validateScene(String(args.scene ?? ''));
  const students = loadClassStudents(classId, termId, conn);
  if (students.length === 0) {
    throw new ToolError('当前班级没有在读学生', { code: 'not_found', retryable: false });
  }
  const sessionId = `rc:${randomBytes(4).toString('hex')}`;
  sessions.set(sessionId, {
    classId,
    termId,
    className,
    date,
    scene,
    students,
    createdAt: Date.now(),
  });
  return {
    session_id: sessionId,
    class_name: className,
    date,
    scene,
    total: students.length,
    students: students.map((s) => ({ student_id: s.student_id, 学号: s.学号, 姓名: s.姓名 })),
    hint: '默认全到，可回复异常学生和状态',
  };
}

export function submitRollCallExceptions(args: Record<string, unknown>): Record<string, unknown> {
  const sessionId = String(args.session_id ?? '').trim();
  const session = resolveSession(sessionId);
  const rawExceptions = args.exceptions;
  if (!Array.isArray(rawExceptions) || rawExceptions.length === 0) {
    throw new ToolError('exceptions 必须是非空数组', { code: 'invalid_arguments', retryable: true });
  }
  const resolved: Array<{ student_id: number; student_name: string; status: string; reason: string }> = [];
  for (const item of rawExceptions) {
    if (typeof item !== 'object' || item === null) {
      throw new ToolError('exceptions 中每项必须是对象', { code: 'invalid_arguments', retryable: true });
    }
    const entry = item as Record<string, unknown>;
    const studentName = String(entry.student_name ?? '').trim();
    if (!studentName) {
      throw new ToolError('每条异常必须包含 student_name', { code: 'invalid_arguments', retryable: true });
    }
    const status = validateStatus(String(entry.status ?? ''));
    const reason = String(entry.reason ?? '').trim();
    const match = findStudentByName(studentName, session.students);
    resolved.push({ student_id: match.student_id, student_name: match.姓名, status, reason });
  }
  const normalCount = session.students.length - resolved.length;
  return {
    session_id: sessionId,
    class_name: session.className,
    date: session.date,
    scene: session.scene,
    total: session.students.length,
    normal_count: normalCount,
    exceptions: resolved.map((e) => ({ student_name: e.student_name, status: e.status, reason: e.reason })),
    confirm_required: true,
    hint: '回复"确认"执行写入，回复"取消"放弃',
  };
}

export function buildRollCallRecords(args: Record<string, unknown>): Array<Record<string, unknown>> {
  const sessionId = String(args.session_id ?? '').trim();
  const session = resolveSession(sessionId);
  const exceptions = args.exceptions;
  if (!Array.isArray(exceptions) || exceptions.length === 0) {
    throw new ToolError('点名异常名单不能为空', { code: 'invalid_arguments', retryable: true });
  }
  const exceptionMap = new Map<number, { status: string; reason: string }>();
  for (const item of exceptions as Array<Record<string, unknown>>) {
    let studentId = Number(item.student_id);
    if (!Number.isInteger(studentId) || !session.students.some((student) => student.student_id === studentId)) {
      const matched = findStudentByName(String(item.student_name ?? '').trim(), session.students);
      studentId = matched.student_id;
    }
    exceptionMap.set(studentId, {
      status: String(item.status ?? '出勤'),
      reason: String(item.reason ?? ''),
    });
  }
  const records: Array<Record<string, unknown>> = [];
  for (const student of session.students) {
    const ex = exceptionMap.get(student.student_id);
    records.push({
      student_id: student.student_id,
      status: ex?.status ?? '出勤',
      reason: ex?.reason ?? '',
    });
  }
  return records;
}

export function getSession(sessionId: string): RollCallSession | undefined {
  return sessions.get(sessionId);
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function queryFieldInfo(args: Record<string, unknown>): Record<string, unknown> {
  const queryType = String(args.query_type ?? '').trim();
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const today = todayString();
  if (queryType === 'today_schedule') {
    const timetable = require('../../services/timetable.js') as typeof import('../../services/timetable.js');
    const schedule = timetable.daySchedule(today, { conn });
    const entries = (schedule.entries as Array<Record<string, unknown>>)
      .filter((e) => e.entry !== null)
      .map((e) => {
        const entry = e.entry as Record<string, unknown> | null;
        return entry ? {
          period: e.label ?? e.period_no,
          subject: entry.subject ?? '',
          teacher: entry.teacher_name ?? '',
        } : null;
      })
      .filter(Boolean);
    return {
      date: today,
      weekday: schedule.weekday_label,
      school_day: schedule.school_day,
      calendar: schedule.calendar,
      entries,
    };
  }
  if (queryType === 'upcoming_exams') {
    const exams = listUpcomingExams({ limit: 5, conn });
    return {
      date: today,
      exams: exams.map((e) => ({
        name: e.name,
        exam_date: e.exam_date,
        days_until: e.days_until,
        label: e.label,
        subjects: e.subjects,
      })),
    };
  }
  if (queryType === 'today_tasks') {
    const tasks = listWorkItems({ bucket: 'open', limit: 20, conn });
    const overdue = tasks.filter((t) => t.timing_state === '已逾期');
    return {
      date: today,
      open_count: tasks.length,
      overdue_count: overdue.length,
      overdue: overdue.slice(0, 5).map((t) => ({
        id: t.id, title: t.title, status: t.status, due_at: t.due_at,
      })),
      recent: tasks.slice(0, 10).map((t) => ({
        id: t.id, title: t.title, status: t.status, due_at: t.due_at,
      })),
    };
  }
  if (queryType === 'class_students') {
    const students = loadClassStudents(classId, termId, conn);
    return {
      total: students.length,
      students: students.map((s) => ({ student_id: s.student_id, 学号: s.学号, 姓名: s.姓名 })),
    };
  }
  throw new ToolError(
    `不支持的 query_type：${queryType}，可选值：today_schedule、upcoming_exams、today_tasks、class_students`,
    { code: 'invalid_arguments', retryable: true },
  );
}
