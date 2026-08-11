/* MIG-06 行动闭环服务：事件、家校沟通、关注、考勤保存、学生详情与时间线。
 * 提供事件、沟通、关注、考勤和学生时间线能力。
 * 积分汇总为 MIG-08 前的最小实现（与 timeline 无关部分从简）。
 */
import type { Database } from 'better-sqlite3';

import { getDb, scopeIds, ensureStudentInScope } from './context.js';
import * as audit from './audit.js';
import { todayString } from './clock.js';
import { ensureSourceWorkItem, listWorkItems, type WorkItemError } from './workItems.js';
import * as points from './points.js';
import { WorkflowError } from './workflow.js';

export class CommunicationError extends Error {}

const COMMUNICATION_STATUSES = new Set(['待回访', '进行中', '已完成', '无需回访']);

export function createCommunication(options: {
  studentId: number;
  communicatedAt: string;
  method: string;
  reason: string;
  summary: string;
  feedback?: string;
  agreement?: string;
  followupAt?: string;
  status?: string;
  eventId?: number | null;
  sourceType?: string;
  sourceId?: string;
  sourceKey?: string;
  conn?: Database;
}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  try {
    ensureStudentInScope(Number(options.studentId), { write: true, conn });
  } catch (error) {
    throw new CommunicationError((error as Error).message);
  }
  let status = options.status ?? '已完成';
  if (options.followupAt && status === '已完成') status = '待回访';
  if (!COMMUNICATION_STATUSES.has(status)) throw new CommunicationError('沟通状态不合法');
  const required = [options.communicatedAt, options.method, options.reason, options.summary];
  if (required.some((value) => !String(value ?? '').trim())) {
    throw new CommunicationError('沟通日期、方式、原因和摘要不能为空');
  }
  const inserted = conn.prepare(
    `INSERT INTO communications(
       student_id, communicated_at, method, reason, summary, feedback,
       agreement, followup_at, status, event_id, class_id, term_id,
       source_type, source_id, source_key
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).get(
    options.studentId, options.communicatedAt, options.method, options.reason, options.summary,
    options.feedback ?? '', options.agreement ?? '', options.followupAt ?? '', status,
    options.eventId ?? null, classId, termId,
    options.sourceType ?? 'manual', options.sourceId ?? '', options.sourceKey ?? '',
  ) as { id: number };
  const communicationId = Number(inserted.id);
  let taskId: number | null = null;
  if (options.followupAt) {
    const task = ensureSourceWorkItem({
      title: '家校沟通回访', studentId: options.studentId,
      sourceType: 'communication', sourceId: communicationId,
      dueAt: options.followupAt, priority: '重要', status: '待复查',
      notes: options.agreement ?? options.summary, conn,
    });
    taskId = task.id;
  }
  audit.record('communication', communicationId, 'create', {
    summary: '新增家校沟通记录',
    params: { student_id: options.studentId, method: options.method, followup_at: options.followupAt ?? '' },
    classId, termId, conn,
  });
  return { communication_id: communicationId, task_id: taskId };
}

export function getCommunication(
  communicationId: number, options: { conn?: Database } = {},
): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    "SELECT * FROM communications WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(Number(communicationId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new CommunicationError('家校沟通记录不存在');
  return row;
}

export const EVENT_STATUSES = new Set(['待处理', '处理中', '待复查', '已完成', '无需处理']);

export function createEvent(options: {
  studentId: number;
  occurredAt: string;
  eventType: string;
  description: string;
  handling?: string;
  parentContacted?: boolean;
  needsFollowup?: boolean;
  followupDue?: string;
  status?: string;
  conn?: Database;
}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  ensureStudentInScope(Number(options.studentId), { write: true, conn });
  const requestedStatus = options.status ?? '已完成';
  if (!EVENT_STATUSES.has(requestedStatus)) throw new CommunicationError('事件状态不合法');
  if (options.needsFollowup && !options.followupDue) {
    throw new CommunicationError('需要跟进时必须填写跟进日期');
  }
  const [classId, termId] = scopeIds({ write: true, conn });
  const eventStatus = options.needsFollowup && requestedStatus === '已完成' ? '待复查' : requestedStatus;
  const inserted = conn.prepare(
    `INSERT INTO student_events(student_id, occurred_at, event_type, description, handling,
       parent_contacted, needs_followup, followup_due, status, class_id, term_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    options.studentId, options.occurredAt, options.eventType, options.description,
    options.handling ?? '', options.parentContacted ? 1 : 0, options.needsFollowup ? 1 : 0,
    options.followupDue ?? '', eventStatus, classId, termId,
  );
  const eventId = Number(inserted.lastInsertRowid);
  let taskId: number | null = null;
  if (options.needsFollowup) {
    const task = ensureSourceWorkItem({
      title: `${options.eventType} · 跟进`, studentId: options.studentId,
      sourceType: 'event', sourceId: eventId, dueAt: options.followupDue ?? '',
      priority: '重要', status: '待复查', notes: options.description, conn,
    });
    taskId = task.id;
  }
  return { event_id: eventId, task_id: taskId };
}

export function getEvent(eventId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    "SELECT * FROM student_events WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(Number(eventId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new CommunicationError('学生事件不存在');
  return row;
}

export const FOCUS_STATUSES = new Set(['待确认', '跟进中', '情况改善', '已结束']);

export function createFocus(options: {
  studentId: number;
  topic: string;
  reason: string;
  evidence?: string;
  actionPlan?: string;
  status?: string;
  nextReviewAt?: string;
  conn?: Database;
}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  ensureStudentInScope(Number(options.studentId), { write: true, conn });
  if (!FOCUS_STATUSES.has(options.status ?? '待确认')) throw new CommunicationError('关注状态不合法');
  const [classId, termId] = scopeIds({ write: true, conn });
  const inserted = conn.prepare(
    `INSERT INTO focus_items(student_id, topic, reason, evidence, action_plan, status, next_review_at, class_id, term_id)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    options.studentId, options.topic, options.reason, options.evidence ?? '',
    options.actionPlan ?? '', options.status ?? '待确认', options.nextReviewAt ?? '',
    classId, termId,
  );
  const focusId = Number(inserted.lastInsertRowid);
  let taskId: number | null = null;
  if (options.nextReviewAt && options.status !== '已结束') {
    const task = ensureSourceWorkItem({
      title: `${options.topic} · 复查`, studentId: options.studentId,
      sourceType: 'focus', sourceId: focusId, dueAt: options.nextReviewAt,
      priority: '重要', status: '待复查', notes: options.actionPlan ?? options.reason, conn,
    });
    taskId = task.id;
  }
  return { focus_id: focusId, task_id: taskId };
}

export function getFocus(focusId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    "SELECT * FROM focus_items WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(Number(focusId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new CommunicationError('关注事项不存在');
  return row;
}

export class AttendanceError extends Error {}

const ATTENDANCE_STATUSES = new Set(['出勤', '迟到', '早退', '请假', '缺勤']);

export function saveDailyAttendance(
  attendanceDate: string, scene: string, records: Array<Record<string, unknown>>,
  options: { conn?: Database } = {},
): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  if (!records || records.length === 0) throw new AttendanceError('至少提交一名学生的考勤');
  const [classId, termId] = scopeIds({ write: true, conn });
  const students = new Map<number, unknown>();
  for (const row of conn.prepare(
    `SELECT s.id, s.学号, s.姓名 FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读'
       AND s.deleted_at=''`,
  ).all(classId, termId) as Array<{ id: number }>) {
    students.set(Number(row.id), row);
  }
  let saved = 0;
  conn.transaction(() => {
    const stmt = conn.prepare(
      `INSERT INTO attendance_records(
         student_id, class_id, term_id, attendance_date, scene, status,
         arrive_at, leave_at, reason, note
       ) VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(class_id, term_id, attendance_date, scene, student_id)
       DO UPDATE SET status=excluded.status, arrive_at=excluded.arrive_at,
         leave_at=excluded.leave_at, reason=excluded.reason, note=excluded.note,
         deleted_at='', deleted_by='', updated_at=datetime('now','localtime')`,
    );
    for (const item of records) {
      const studentId = Number(item.student_id ?? 0);
      if (!students.has(studentId)) {
        throw new AttendanceError(`学生 ${studentId} 不存在或不在当前班级`);
      }
      const status = String(item.status ?? '出勤').trim() || '出勤';
      if (!ATTENDANCE_STATUSES.has(status)) throw new AttendanceError(`考勤状态不合法：${status}`);
      stmt.run(
        studentId, classId, termId, attendanceDate, scene, status,
        String(item.arrive ?? item.arrive_at ?? '').trim(),
        String(item.leave ?? item.leave_at ?? '').trim(),
        String(item.reason ?? '').trim(), String(item.note ?? '').trim(),
      );
      saved += 1;
    }
    audit.record('attendance_batch', `${attendanceDate}:${scene}`, 'save', {
      summary: `保存${attendanceDate} ${scene}考勤 ${saved} 人`,
      params: { date: attendanceDate, scene, saved }, classId, termId, conn,
    });
  })();
  // 保存后执行考勤规则评估（与 Python save_daily 一致）；失败作为可见警告返回，不阻断保存。
  let evaluation = null;
  let evaluationError = '';
  try {
    const { evaluateRules } = requireAttendance();
    evaluation = evaluateRules({ referenceDate: attendanceDate, trigger: 'save', conn });
  } catch (error) {
    evaluationError = String((error as Error).message);
  }
  return { ok: true, date: attendanceDate, scene, saved, evaluation, evaluation_error: evaluationError };
}

export function listAttendanceRecords(options: {
  attendanceDate?: string; scene?: string; studentId?: number | null; limit?: number; conn?: Database;
} = {}): Array<Record<string, unknown>> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const where = ["a.class_id=?", "a.term_id=?", "a.deleted_at=''", "s.deleted_at=''"];
  const params: unknown[] = [classId, termId];
  if (options.attendanceDate) {
    where.push('a.attendance_date=?');
    params.push(options.attendanceDate);
  }
  if (options.scene && options.scene !== '全部场景') {
    where.push('a.scene=?');
    params.push(options.scene);
  }
  if (options.studentId !== undefined && options.studentId !== null) {
    where.push('a.student_id=?');
    params.push(options.studentId);
  }
  const limit = Math.max(1, Math.min(Number(options.limit ?? 5000), 50_000));
  return conn.prepare(
    `SELECT a.*, s.学号, s.姓名 AS student_name FROM attendance_records a
     JOIN students s ON s.id=a.student_id WHERE ${where.join(' AND ')}
     ORDER BY a.attendance_date DESC, a.id DESC LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;
}

export function getAttendanceRecord(options: {
  studentId: number; attendanceDate: string; scene: string; conn?: Database;
}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    `SELECT * FROM attendance_records
     WHERE student_id=? AND class_id=? AND term_id=? AND attendance_date=? AND scene=? AND deleted_at=''`,
  ).get(
    Number(options.studentId), classId, termId,
    String(options.attendanceDate), String(options.scene),
  ) as Record<string, unknown> | undefined;
  if (!row) throw new AttendanceError('考勤记录不存在');
  return row;
}

export function studentDetail(studentId: number): Record<string, unknown> {
  const conn = getDb().connInstance;
  const student = ensureStudentInScope(studentId);
  const [classId, termId] = scopeIds({ conn });
  const rows = (sql: string, params: unknown[] = []): Array<Record<string, unknown>> =>
    conn.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  const events = rows(
    'SELECT e.*, s.姓名 AS student_name FROM student_events e '
    + "JOIN students s ON s.id=e.student_id WHERE e.student_id=? AND e.class_id=? AND e.term_id=? AND e.deleted_at='' "
    + 'ORDER BY e.occurred_at DESC, e.id DESC',
    [studentId, classId, termId]);
  const tasks = rows(
    'SELECT t.*, s.姓名 AS student_name FROM student_tasks t '
    + "LEFT JOIN students s ON s.id=t.student_id WHERE t.student_id=? AND t.class_id=? AND t.term_id=? AND t.deleted_at='' "
    + "ORDER BY CASE WHEN t.status IN ('已完成','已取消') THEN 1 ELSE 0 END, t.due_at, t.id DESC",
    [studentId, classId, termId]);
  const focus = rows(
    "SELECT * FROM focus_items WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at='' ORDER BY "
    + "CASE WHEN status='已结束' THEN 1 ELSE 0 END, next_review_at, id DESC",
    [studentId, classId, termId]);
  const communications = rows(
    'SELECT c.*, s.姓名 AS student_name FROM communications c '
    + "JOIN students s ON s.id=c.student_id WHERE c.student_id=? AND c.class_id=? AND c.term_id=? AND c.deleted_at='' "
    + 'ORDER BY c.communicated_at DESC, c.id DESC',
    [studentId, classId, termId]);
  const workflowUpdates = rows(
    'SELECT * FROM workflow_updates WHERE student_id=? AND class_id=? AND term_id=? '
    + 'ORDER BY created_at DESC, id DESC',
    [studentId, classId, termId]);

  const attendance = listAttendanceRecords({ studentId, limit: 5000 });

  const scoreSummary = buildScoreSummary(studentId, conn, classId, termId);
  const pointsSummary = points.studentSummary(studentId) as Record<string, unknown>;
  const pointEntries = (pointsSummary.entries ?? []) as Array<Record<string, unknown>>;
  pointsSummary.updated_at = pointEntries
    .map((item) => String(item.updated_at ?? item.created_at ?? ''))
    .filter(Boolean)
    .sort()
    .pop() ?? '';
  const pointWeeks = (pointsSummary.weekly ?? []) as Array<number>;
  pointsSummary.text_summary = `累计 ${pointsSummary.total ?? 0} 分，${pointWeeks.filter((value) => value).length} 个周次有积分记录。`;
  const commentsSummary = buildCommentsSummary(studentId, conn, classId, termId);

  const timeline: Array<Record<string, unknown>> = [];
  for (const row of events) {
    timeline.push({ kind: 'event', id: row.id, at: row.occurred_at,
      title: row.event_type, summary: row.description, status: row.status });
  }
  for (const row of communications) {
    timeline.push({ kind: 'communication', id: row.id, at: row.communicated_at,
      title: `家校沟通 · ${row.method}`, summary: row.summary, status: row.status });
  }
  const attendanceGroups: Record<string, Array<Record<string, unknown>>> = {};
  for (const row of attendance) {
    if (!['迟到', '早退', '请假', '缺勤'].includes(String(row.status))) continue;
    attendanceGroups[String(row.status)] ??= [];
    attendanceGroups[String(row.status)].push(row);
  }
  for (const [status, group] of Object.entries(attendanceGroups)) {
    group.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
    const latest = group[0];
    const dates = group.slice(0, 4).map((item) => String(item.date)).filter(Boolean);
    let summary = `共 ${group.length} 次，最近一次 ${latest.date}（${latest.scene}）`;
    const reason = String(latest.reason ?? latest.note ?? '');
    if (reason) summary += `：${reason}`;
    if (group.length > 1 && dates.length > 0) {
      summary += `；记录日期：${dates.join('、')}`;
      if (group.length > dates.length) summary += '…';
    }
    timeline.push({ kind: 'attendance', id: `attendance-${status}`, at: latest.date,
      title: `考勤异常 · ${status}`, summary, status: `${group.length} 次` });
  }
  for (const row of tasks) {
    if (!['attendance_rule', 'score_rule'].includes(String(row.source_type ?? '')) || !row.result) continue;
    const isAttendance = String(row.source_type) === 'attendance_rule';
    timeline.push({
      kind: isAttendance ? 'attendance_followup' : 'score_followup', id: row.id,
      at: String(row.completed_at ?? row.cancelled_at ?? row.updated_at ?? ''),
      title: isAttendance ? '考勤异常跟进' : '成绩异常跟进',
      summary: String(row.result), status: row.status,
    });
  }
  for (const row of focus) {
    timeline.push({ kind: 'focus', id: row.id, at: row.started_at,
      title: `关注 · ${row.topic}`, summary: row.reason, status: row.status });
  }
  for (const row of (commentsSummary.comments ?? []) as Array<Record<string, unknown>>) {
    timeline.push({
      kind: 'comment', id: row.id,
      at: String(row.sent_at ?? row.reviewed_at ?? row.updated_at ?? ''),
      title: `评语 · ${row.comment_type}`, summary: String(row.content ?? '').slice(0, 120),
      status: row.status,
    });
  }
  const sourceNames: Record<string, string> = { event: '事件', communication: '家校沟通', focus: '关注事项' };
  for (const row of workflowUpdates) {
    const statusText = String(row.status_from) !== String(row.status_to)
      ? `${row.status_from} → ${row.status_to}` : String(row.status_to);
    timeline.push({
      kind: 'workflow', id: row.id, at: row.created_at,
      title: `${sourceNames[String(row.source_type)] ?? '跟进'} · 过程记录`,
      summary: String(row.content ?? '') || statusText || '更新记录',
      status: statusText,
      source_type: row.source_type, source_id: row.source_id,
    });
  }
  timeline.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));

  const today = todayString();
  const openActions = listWorkItems({ bucket: 'open', studentId, limit: 50 });
  const overdueActions = openActions.filter((item) => item.timing_state === '已逾期');
  const dueFocus = focus.filter((item) => String(item.status) !== '已结束'
    && item.next_review_at && String(item.next_review_at).slice(0, 10) <= today);
  const recentAttendance = attendance.slice(0, 5);
  const attendanceRisks = recentAttendance.filter((item) =>
    ['迟到', '早退', '缺勤'].includes(String(item.status)));
  const riskReasons: string[] = [];
  if (overdueActions.length > 0) riskReasons.push(`${overdueActions.length} 项行动已逾期`);
  if (dueFocus.length > 0) riskReasons.push(`${dueFocus.length} 项关注需要复查`);
  if (attendanceRisks.length > 0) riskReasons.push(`最近 5 次考勤有 ${attendanceRisks.length} 次异常`);
  let riskLevel = '低';
  if (overdueActions.length > 0 || attendanceRisks.length > 0) riskLevel = '高';
  else if (dueFocus.length > 0 || openActions.length > 0) riskLevel = '中';

  const conclusions: Array<[string, unknown]> = [];
  for (const row of events) {
    if (row.result) conclusions.push([String(row.closed_at ?? row.updated_at ?? ''), row.result]);
  }
  for (const row of communications) {
    if (row.result) conclusions.push([String(row.closed_at ?? row.updated_at ?? ''), row.result]);
  }
  for (const row of focus) {
    if (row.conclusion) conclusions.push([String(row.ended_at ?? row.updated_at ?? ''), row.conclusion]);
  }
  conclusions.sort((a, b) => String(a[0]).localeCompare(String(b[0])).toString() === '1' ? -1 : 0);
  conclusions.sort((a, b) => String(b[0]).localeCompare(String(a[0])));

  const photoPath = String(student.photo_path ?? '');
  const studentOut = { ...student };
  delete studentOut.photo_path;
  studentOut.photo_url = photoPath ? `/api/students/${studentId}/photo` : '';

  return {
    student: studentOut, events, tasks, focus, communications, attendance,
    workflow_updates: workflowUpdates,
    score_summary: scoreSummary, points_summary: pointsSummary,
    comments_summary: commentsSummary,
    timeline,
    insights: {
      risk_level: riskLevel,
      risk_reasons: riskReasons.length > 0 ? riskReasons : ['当前没有逾期行动、到期复查或近期考勤异常'],
      recent_changes: timeline.slice(0, 4),
      open_actions: openActions,
      stage_conclusion: conclusions.length > 0 ? conclusions[0][1]
        : '暂无阶段结论；完成一次跟进后可在这里回顾结果。',
    },
  };
}

function buildScoreSummary(
  studentId: number, conn: Database, classId: number, termId: number,
): Record<string, unknown> {
  const subjects = conn.prepare(
    'SELECT name FROM score_subjects WHERE class_id=? AND term_id=? AND enabled=1 ORDER BY sort_order, id',
  ).all(classId, termId) as Array<{ name: string }>;
  const examRows = conn.prepare(
    'SELECT e.* FROM score_exams e WHERE e.class_id=? AND e.term_id=? AND e.enabled=1 ORDER BY e.exam_date, e.sort_order, e.id',
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const records = conn.prepare(
    `SELECT r.* FROM exam_records r
     WHERE r.student_id=? AND r.class_id=? AND r.term_id=? AND r.deleted_at=''`,
  ).all(studentId, classId, termId) as Array<Record<string, unknown>>;
  const expectedSubjects = new Map<number, string[]>();
  for (const row of conn.prepare(
    'SELECT exam_id, subject_id FROM score_exam_subjects ORDER BY sort_order',
  ).all() as Array<{ exam_id: number; subject_id: number }>) {
    const names = expectedSubjects.get(Number(row.exam_id)) ?? [];
    names.push(String(row.subject_id));
    expectedSubjects.set(Number(row.exam_id), names);
  }
  const subjectNameById = new Map<number, string>();
  for (const row of conn.prepare('SELECT id, name FROM score_subjects').all() as Array<{ id: number; name: string }>) {
    subjectNameById.set(Number(row.id), String(row.name));
  }
  const byExam = new Map<number, Array<Record<string, unknown>>>();
  for (const row of records) {
    const examId = Number(row.exam_id ?? 0);
    if (examId === 0) continue;
    const list = byExam.get(examId) ?? [];
    list.push(row);
    byExam.set(examId, list);
  }
  const exams = examRows.map((exam) => {
    const examId = Number(exam.id);
    const examRecords = byExam.get(examId) ?? [];
    const subjectScores: Record<string, { score: unknown; status: string }> = {};
    for (const record of examRecords) {
      const subjectName = String(record.subject ?? '');
      const status = String(record.record_status ?? '正常');
      subjectScores[subjectName] = { score: record.score, status };
    }
    const expected = (expectedSubjects.get(examId) ?? [])
      .map((subjectId) => subjectNameById.get(Number(subjectId)))
      .filter((name): name is string => Boolean(name));
    const complete = expected.length > 0
      && expected.every((name) => subjectScores[name]?.status === '正常' && subjectScores[name]?.score !== null);
    const total = complete
      ? Math.round(expected.reduce((sum, name) => sum + Number(subjectScores[name].score ?? 0), 0) * 10) / 10
      : null;
    return {
      exam_id: examId, exam_name: exam.name, exam_date: exam.exam_date,
      total, complete, expected_subjects: expected,
      subjects: subjectScores,
    };
  });
  const comparable = exams.filter((exam) => exam.total !== null);
  let textSummary = '暂无成绩趋势数据。';
  if (comparable.length >= 2) {
    const previous = comparable[comparable.length - 2];
    const latest = comparable[comparable.length - 1];
    const change = Math.round((Number(latest.total) - Number(previous.total)) * 10) / 10;
    const direction = change > 0 ? '提升' : change < 0 ? '下降' : '持平';
    textSummary = `最近一次 ${latest.exam_name} 共 ${latest.total} 分，较前一次${direction} ${Math.abs(change)} 分。`;
  } else if (comparable.length === 1) {
    textSummary = `当前有 1 次完整考试记录，${comparable[0].exam_name} 共 ${comparable[0].total} 分。`;
  } else if (exams.length > 0) {
    textSummary = '已有成绩记录，但预期科目尚未录入完整，暂不计算总分趋势。';
  }
  return {
    exams, subjects: subjects.map((item) => item.name),
    definition: {
      missing: '缺考、免考和未录入均不按 0 分计入平均分。',
      total: '只有考试配置中的预期科目全部为正常数值成绩时才计算总分。',
      rank: '班级排名仅在总分完整的学生中按总分降序计算，同分同名次。',
      stratum: 'A/B/C 层按完整总分排名的前 25%/中间 50%/后 25% 划分。',
    },
    text_summary: textSummary,
  };
}

function buildCommentsSummary(
  studentId: number, conn: Database, classId: number, termId: number,
): Record<string, unknown> {
  const rows = conn.prepare(
    `SELECT c.*, s.学号, s.姓名 AS student_name FROM student_comments c
     JOIN students s ON s.id=c.student_id
     WHERE c.student_id=? AND c.class_id=? AND c.term_id=? AND c.deleted_at=''
     ORDER BY c.updated_at DESC, c.id DESC LIMIT 100`,
  ).all(studentId, classId, termId) as Array<Record<string, unknown>>;
  const latest = rows.length > 0
    ? rows.reduce((best, item) => {
      const key = String(item.updated_at ?? item.created_at ?? '');
      const bestKey = String(best.updated_at ?? best.created_at ?? '');
      return key > bestKey ? item : best;
    })
    : null;
  return { comments: rows, latest };
}

export { WorkflowError, type WorkItemError };

function requireAttendance(): { evaluateRules: (options: {
  referenceDate?: string; trigger?: string; conn?: Database;
}) => Record<string, unknown> } {
  // 延迟导入避免循环依赖（attendance → workItems，workItems 不依赖 p0Service）
  return { evaluateRules: attendanceModule.evaluateRules };
}

import * as attendanceModule from './attendance.js';
