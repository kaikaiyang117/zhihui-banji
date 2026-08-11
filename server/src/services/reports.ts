import type { Database } from 'better-sqlite3';

import * as attendance from './attendance.js';
import { todayString } from './clock.js';
import * as comments from './comments.js';
import { getCurrentScope, getDb, scopeIds } from './context.js';
import { sheetBytes } from './exportXlsx.js';
import * as points from './points.js';
import * as scores from './scores.js';
import * as workItems from './workItems.js';

export const REPORT_TYPES: Record<string, string> = {
  weekly: '班级周报',
  monthly: '班级月报',
  term: '学期档案',
  student_growth: '学生成长报告',
};

export class ReportError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function parseIsoDate(text: string): { year: number; month: number; day: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const parsed = new Date(`${text}T00:00:00Z`);
  if (isNaN(parsed.getTime())) return null;
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function shiftDays(dateText: string, deltaDays: number): string {
  const parsed = parseIsoDate(dateText);
  const d = new Date(Date.UTC(parsed!.year, parsed!.month - 1, parsed!.day));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function reportDate(value: string, field: string): string {
  const text = String(value || '').slice(0, 10);
  if (!parseIsoDate(text)) throw new ReportError(`${field}必须为 YYYY-MM-DD`);
  return text;
}

function periodRange(reportType: string, periodStart = '', periodEnd = '', conn?: Database): [string, string] {
  if (!(reportType in REPORT_TYPES)) throw new ReportError('报告类型不支持');
  const today = todayString();
  const scope = getCurrentScope({ conn: connOf(conn) });
  let start: string;
  let end: string;
  if (periodStart || periodEnd) {
    start = reportDate(periodStart, '开始日期');
    end = reportDate(periodEnd, '结束日期');
  } else if (reportType === 'weekly') {
    const parsed = parseIsoDate(today)!;
    const weekday = (new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay() + 6) % 7;
    start = shiftDays(today, -weekday);
    end = shiftDays(today, 6 - weekday);
  } else if (reportType === 'monthly') {
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    start = `${year}-${String(month).padStart(2, '0')}-01`;
    end = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  } else {
    start = String(scope.start_date || `${today.slice(0, 4)}-01-01`).slice(0, 10);
    end = String(scope.end_date || today).slice(0, 10);
    start = reportDate(start, '开始日期');
    end = reportDate(end, '结束日期');
  }
  if (start > end) throw new ReportError('开始日期不能晚于结束日期');
  return [start, end];
}

function activeStudents(conn: Database, classId: number, termId: number): Array<Record<string, unknown>> {
  return conn.prepare(
    `SELECT s.id, s.学号, s.姓名, s.性别
     FROM students s JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
     ORDER BY s.学号, s.id`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
}

function studentRow(conn: Database, studentId: number, classId: number, termId: number): Record<string, unknown> {
  const row = conn.prepare(
    `SELECT s.id, s.学号, s.姓名, s.性别
     FROM students s JOIN student_enrollments e ON e.student_id=s.id
     WHERE s.id=? AND e.class_id=? AND e.term_id=? AND e.status='在读'
       AND s.deleted_at=''`,
  ).get(Number(studentId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new ReportError('学生不存在或不在当前班级/学期');
  return row;
}

function educationSources(
  conn: Database, classId: number, termId: number, start: string, end: string,
  studentId?: number | null,
): [Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>] {
  let params: unknown[] = [classId, termId, start, end];
  let studentFilter = '';
  if (studentId !== undefined && studentId !== null) {
    studentFilter = ' AND EXISTS (SELECT 1 FROM meeting_participants mp WHERE mp.meeting_id=m.id AND mp.student_id=?)';
    params.push(studentId);
  }
  const meetings = conn.prepare(
    `SELECT m.id, m.held_on AS date, m.topic AS title, m.conclusion, '班会' AS kind
     FROM meeting_records m
     WHERE m.class_id=? AND m.term_id=? AND m.deleted_at='' AND m.held_on BETWEEN ? AND ?`
    + studentFilter + ' ORDER BY m.held_on, m.id',
  ).all(...params) as Array<Record<string, unknown>>;
  params = [classId, termId, start, end];
  if (studentId !== undefined && studentId !== null) {
    params.push(studentId);
    studentFilter = ' AND EXISTS (SELECT 1 FROM activity_participants ap WHERE ap.activity_id=a.id AND ap.student_id=?)';
  } else {
    studentFilter = '';
  }
  const activities = conn.prepare(
    `SELECT a.id, a.occurred_on AS date, a.name AS title, a.result, a.retrospective, '活动' AS kind
     FROM activity_records a
     WHERE a.class_id=? AND a.term_id=? AND a.deleted_at='' AND a.occurred_on BETWEEN ? AND ?`
    + studentFilter + ' ORDER BY a.occurred_on, a.id',
  ).all(...params) as Array<Record<string, unknown>>;
  const diaries = conn.prepare(
    `SELECT d.id, d.diary_date AS date, d.work, d.event, d.reflection, d.todo, '日志' AS kind
     FROM diary_entries d
     WHERE d.class_id=? AND d.term_id=? AND d.deleted_at='' AND d.diary_date BETWEEN ? AND ?
     ORDER BY d.diary_date, d.id`,
  ).all(classId, termId, start, end) as Array<Record<string, unknown>>;
  return [meetings, activities, diaries];
}

function listEvents(
  conn: Database, classId: number, termId: number, start: string, end: string,
  studentId?: number | null,
): Array<Record<string, unknown>> {
  const where = ['e.class_id=?', 'e.term_id=?', "e.deleted_at=''", 'substr(e.occurred_at,1,10) BETWEEN ? AND ?'];
  const params: unknown[] = [classId, termId, start, end];
  if (studentId !== undefined && studentId !== null) {
    where.push('e.student_id=?');
    params.push(studentId);
  }
  return conn.prepare(
    `SELECT e.id, e.student_id, s.学号, s.姓名 AS student_name, e.occurred_at AS date,
            e.event_type, e.description, e.status
     FROM student_events e JOIN students s ON s.id=e.student_id
     WHERE ` + where.join(' AND ') + ' ORDER BY e.occurred_at, e.id',
  ).all(...params) as Array<Record<string, unknown>>;
}

function listCommunications(
  conn: Database, classId: number, termId: number, start: string, end: string,
  studentId?: number | null,
): Array<Record<string, unknown>> {
  const where = ['c.class_id=?', 'c.term_id=?', "c.deleted_at=''", 'substr(c.communicated_at,1,10) BETWEEN ? AND ?'];
  const params: unknown[] = [classId, termId, start, end];
  if (studentId !== undefined && studentId !== null) {
    where.push('c.student_id=?');
    params.push(studentId);
  }
  return conn.prepare(
    `SELECT c.id, c.student_id, s.学号, s.姓名 AS student_name, c.communicated_at AS date,
            c.method, c.reason, c.summary, c.status
     FROM communications c JOIN students s ON s.id=c.student_id
     WHERE ` + where.join(' AND ') + ' ORDER BY c.communicated_at, c.id',
  ).all(...params) as Array<Record<string, unknown>>;
}

function termAnalysis(
  scoreSummaryData: Record<string, unknown>,
  students: Array<Record<string, unknown>>,
  attendanceRows: Array<Record<string, unknown>>,
  items: Array<Record<string, unknown>>,
  meetings: Array<Record<string, unknown>>,
  activities: Array<Record<string, unknown>>,
  diaries: Array<Record<string, unknown>>,
  eventRows: Array<Record<string, unknown>>,
  communicationRows: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const attendanceExceptionRows = attendanceRows.filter((row) => String(row.status) !== '出勤');
  const attendanceStudents = new Set<number>();
  for (const row of attendanceExceptionRows) {
    if (row.student_id) attendanceStudents.add(Number(row.student_id));
  }
  const statusCounts: Record<string, number> = {};
  for (const row of attendanceExceptionRows) {
    if (row.status) {
      const status = String(row.status);
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }
  }
  const taskStatusCounts: Record<string, number> = {};
  for (const row of items) {
    if (row.status) {
      const status = String(row.status);
      taskStatusCounts[status] = (taskStatusCounts[status] ?? 0) + 1;
    }
  }
  const scoreStudents: Array<Record<string, unknown>> = [];
  const improved: Array<Record<string, unknown>> = [];
  const declined: Array<Record<string, unknown>> = [];
  const summaryStudents = (scoreSummaryData.students ?? []) as Array<Record<string, unknown>>;
  for (const student of summaryStudents) {
    const complete = ((student.exams ?? []) as Array<Record<string, unknown>>)
      .filter((item) => item.total !== null && item.total !== undefined);
    if (complete.length < 2) continue;
    const change = scores.pyRound(
      Number(complete[complete.length - 1].total) - Number(complete[0].total), 2);
    const result = {
      student_id: student.student_id,
      student_name: student['姓名'] === undefined ? '' : student['姓名'],
      first_exam: complete[0].exam_name === undefined ? '' : complete[0].exam_name,
      last_exam: complete[complete.length - 1].exam_name === undefined ? '' : complete[complete.length - 1].exam_name,
      change,
    };
    scoreStudents.push(result);
    if (change > 0) improved.push(result);
    else if (change < 0) declined.push(result);
  }

  const subjectsById = new Map<number, Record<string, unknown>>();
  for (const item of (scoreSummaryData.subjects ?? []) as Array<Record<string, unknown>>) {
    if (item.id) subjectsById.set(Number(item.id), item);
  }
  const combinationOrder: string[] = [];
  const combinationCounts = new Map<string, number>();
  for (const student of summaryStudents) {
    if (!student.selection_configured) continue;
    const names: string[] = [];
    for (const id of (student.selected_subject_ids ?? []) as Array<number>) {
      const subject = subjectsById.get(Number(id));
      if (subject) names.push(String(subject.name ?? ''));
    }
    if (names.length === 0) continue;
    const key = names.join(' + ');
    if (!combinationCounts.has(key)) combinationOrder.push(key);
    combinationCounts.set(key, (combinationCounts.get(key) ?? 0) + 1);
  }
  const selectionCombinations = combinationOrder
    .map((name) => ({ name, count: combinationCounts.get(name) ?? 0 }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return combinationOrder.indexOf(a.name) - combinationOrder.indexOf(b.name);
    })
    .map((item) => ({ name: item.name, student_count: item.count }));

  const examList = (scoreSummaryData.exams ?? []) as Array<Record<string, unknown>>;
  const latestExam = examList.length > 0 ? examList[examList.length - 1] : null;
  const latestSubjects = latestExam
    ? (latestExam.subject_stats ?? []) as Array<Record<string, unknown>> : [];
  return {
    class_overview: {
      student_count: students.length,
      meetings: meetings.length,
      activities: activities.length,
      diary_entries: diaries.length,
      events: eventRows.length,
      communications: communicationRows.length,
    },
    academic: {
      exam_count: examList.length,
      subject_count: ((scoreSummaryData.subjects ?? []) as Array<Record<string, unknown>>).length,
      exams: examList.map((item) => ({
        name: item.name === undefined ? '' : item.name,
        date: item.exam_date === undefined ? '' : item.exam_date,
        class_average_total: item.class_average_total,
        complete_count: item.complete_count === undefined ? 0 : item.complete_count,
        student_count: item.student_count === undefined ? 0 : item.student_count,
        missing_count: item.missing_count === undefined ? 0 : item.missing_count,
      })),
      latest_subjects: latestSubjects,
      selection_combinations: selectionCombinations,
      improved_students: improved
        .sort((a, b) => Number(b.change) - Number(a.change)).slice(0, 8),
      declined_students: declined
        .sort((a, b) => Number(a.change) - Number(b.change)).slice(0, 8),
      comparison_count: scoreStudents.length,
      definition: scoreSummaryData.definition ?? {},
    },
    attendance: {
      total_records: attendanceRows.length,
      exception_records: attendanceExceptionRows.length,
      exception_student_count: attendanceStudents.size,
      status_counts: statusCounts,
    },
    tasks: {
      total: items.length,
      completed: taskStatusCounts['已完成'] ?? 0,
      open: ['待处理', '处理中', '待复查']
        .reduce((sum, status) => sum + (taskStatusCounts[status] ?? 0), 0),
      status_counts: taskStatusCounts,
    },
  };
}

function buildSummary(
  reportType: string, start: string, end: string, studentId?: number | null,
  conn?: Database, classSummary = '', teacherSummary = '', nextTermPlan = '',
): Record<string, unknown> {
  const db = connOf(conn);
  const scope = getCurrentScope({ conn: db });
  const classId = Number(scope.class_id);
  const termId = Number(scope.term_id);
  const students = studentId !== undefined && studentId !== null
    ? [studentRow(db, studentId, classId, termId)]
    : activeStudents(db, classId, termId);
  const attendanceRows = attendance.listRecords({
    dateFrom: start, dateTo: end, studentId: studentId ?? null, limit: 50_000, conn: db,
  });
  const attendanceCounts: Record<string, number> = {};
  for (const status of attendance.STATUSES) attendanceCounts[status] = 0;
  for (const row of attendanceRows) {
    attendanceCounts[String(row.status)] = (attendanceCounts[String(row.status)] ?? 0) + 1;
  }
  const items = workItems.listWorkItems({
    dateFrom: start, dateTo: end, studentId: studentId ?? null, limit: 50_000, conn: db,
  });
  const pointRows = points.listEntries({
    studentId: studentId ?? null, dateFrom: start, dateTo: end, limit: 50_000, conn: db,
  });
  const validPoints = pointRows.filter((row) => String(row.status) === '有效');
  const allExamRows = scores.listRecords({ studentId: studentId ?? null, conn: db });
  const examRows = allExamRows.filter((row) => {
    const examDate = String(row.exam_date ?? '').slice(0, 10);
    return start <= examDate && examDate <= end;
  });
  const scoreSummaryData = scores.scoreSummary({ studentId: studentId ?? null, conn: db });
  const commentRows = comments.listComments({ studentId: studentId ?? null, limit: 500, conn: db });
  const [meetings, activities, diaries] = educationSources(db, classId, termId, start, end, studentId ?? null);
  const eventRows = listEvents(db, classId, termId, start, end, studentId ?? null);
  const communicationRows = listCommunications(db, classId, termId, start, end, studentId ?? null);

  const sourceRefs: Record<string, Array<Record<string, unknown>>> = {
    attendance: attendanceRows.map((row) => ({
      id: row.id, date: row.attendance_date, student_id: row.student_id, status: row.status,
    })),
    work_items: items.map((row) => ({
      id: row.id, title: row.title, status: row.status,
      source_type: row.source_type === undefined ? '' : row.source_type,
    })),
    points: pointRows.map((row) => ({
      id: row.id, date: row.occurred_at === undefined ? '' : row.occurred_at,
      student_id: row.student_id, amount: row.amount === undefined ? 0 : row.amount,
    })),
    scores: examRows.map((row) => ({
      id: row.id, exam_name: row.exam_name === undefined ? '' : row.exam_name,
      exam_date: row.exam_date === undefined ? '' : row.exam_date, student_id: row.student_id,
    })),
    comments: commentRows.map((row) => ({
      id: row.id, student_id: row.student_id, status: row.status === undefined ? '' : row.status,
    })),
    meetings: meetings.map((row) => ({ id: row.id, date: row.date, title: row.title })),
    activities: activities.map((row) => ({ id: row.id, date: row.date, title: row.title })),
    diary: diaries.map((row) => ({ id: row.id, date: row.date })),
    events: eventRows.map((row) => ({ id: row.id, date: row.date, student_id: row.student_id })),
    communications: communicationRows.map((row) => ({ id: row.id, date: row.date, student_id: row.student_id })),
  };
  const statusCounts: Record<string, number> = {};
  for (const row of items) {
    const status = String(row.status ?? '');
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  return {
    report_type: reportType,
    report_label: REPORT_TYPES[reportType],
    period_start: start,
    period_end: end,
    scope: {
      class_id: classId,
      term_id: termId,
      class_name: scope.class_name ?? '',
      term_name: scope.term_name ?? '',
    },
    student: studentId !== undefined && studentId !== null ? students[0] : null,
    metrics: {
      student_count: students.length,
      attendance_total: attendanceRows.length,
      attendance: attendanceCounts,
      work_items_total: items.length,
      work_items_by_status: statusCounts,
      points_total: validPoints.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
      points_entries: validPoints.length,
      score_records: examRows.length,
      comments: commentRows.length,
      events: eventRows.length,
      communications: communicationRows.length,
      meetings: meetings.length,
      activities: activities.length,
      diary_entries: diaries.length,
    },
    sections: {
      students,
      attendance: attendanceRows,
      work_items: items,
      points: pointRows,
      scores: examRows,
      comments: commentRows,
      meetings,
      activities,
      diary: diaries,
      events: eventRows,
      communications: communicationRows,
    },
    analysis: termAnalysis(
      scoreSummaryData, students, attendanceRows, items, meetings, activities,
      diaries, eventRows, communicationRows,
    ),
    manual: {
      class_summary: String(classSummary || ''),
      teacher_summary: String(teacherSummary || ''),
      next_term_plan: String(nextTermPlan || ''),
    },
    source_refs: sourceRefs,
    data_notes: [
      '成绩统计沿用结构化成绩服务的缺考、免考和未录入口径。',
      '积分只汇总有效流水，撤销记录保留在来源清单中。',
      '报告是生成时的只读快照，原始业务记录不会被修改。',
    ],
  };
}

export function buildReport(
  reportType: string,
  options: {
    periodStart?: string; periodEnd?: string; studentId?: number | null;
    conn?: Database; classSummary?: string; teacherSummary?: string; nextTermPlan?: string;
  } = {},
): Record<string, unknown> {
  const [start, end] = periodRange(
    reportType, options.periodStart ?? '', options.periodEnd ?? '', options.conn);
  return buildSummary(
    reportType, start, end, options.studentId ?? null, options.conn,
    options.classSummary ?? '', options.teacherSummary ?? '', options.nextTermPlan ?? '',
  );
}

export function createArchive(
  reportType: string,
  options: {
    periodStart?: string; periodEnd?: string; studentId?: number | null;
    conn?: Database; classSummary?: string; teacherSummary?: string; nextTermPlan?: string;
  } = {},
): Record<string, unknown> {
  const conn = connOf(options.conn);
  const report = buildReport(reportType, options);
  const scope = report.scope as Record<string, unknown>;
  const student = report.student as Record<string, unknown> | null;
  const title = String(report.report_label) + (student ? ` · ${student['姓名']}` : '');
  const row = conn.transaction((): Record<string, unknown> => {
    return conn.prepare(
      `INSERT INTO report_archives(class_id, term_id, report_type, period_start, period_end,
                                   student_id, title, payload_json)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(class_id, term_id, report_type, period_start, period_end, student_id)
       DO UPDATE SET title=excluded.title, payload_json=excluded.payload_json,
                     archived_at=datetime('now','localtime')
       RETURNING *`,
    ).get(
      scope.class_id, scope.term_id, reportType, report.period_start, report.period_end,
      options.studentId ?? null, title, JSON.stringify(report),
    ) as Record<string, unknown>;
  })();
  const result = { ...row };
  result.payload = report;
  return result;
}

export function listArchives(reportType = '', options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  const where = ['class_id=?', 'term_id=?'];
  const params: unknown[] = [classId, termId];
  if (reportType) {
    if (!(reportType in REPORT_TYPES)) throw new ReportError('报告类型不支持');
    where.push('report_type=?');
    params.push(reportType);
  }
  return conn.prepare(
    'SELECT id, report_type, period_start, period_end, student_id, title, created_at, archived_at '
    + 'FROM report_archives WHERE ' + where.join(' AND ') + ' ORDER BY archived_at DESC, id DESC',
  ).all(...params) as Array<Record<string, unknown>>;
}

export function getArchive(archiveId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    'SELECT * FROM report_archives WHERE id=? AND class_id=? AND term_id=?',
  ).get(Number(archiveId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new ReportError('报告归档不存在');
  const result = { ...row };
  result.payload = JSON.parse(String(result.payload_json ?? '{}') || '{}');
  delete result.payload_json;
  return result;
}

export async function exportArchive(archiveId: number, options: { conn?: Database } = {}):
  Promise<{ buffer: Buffer; filename: string }> {
  const conn = connOf(options.conn);
  const report = getArchive(archiveId, { conn });
  const payload = report.payload as Record<string, unknown>;
  const scope = (payload.scope ?? {}) as Record<string, unknown>;
  const metrics = (payload.metrics ?? {}) as Record<string, unknown>;
  const rows: Array<Array<unknown>> = [
    ['报告', report.title],
    ['开始日期', report.period_start],
    ['结束日期', report.period_end],
    ['班级', scope.class_name ?? ''],
    ['学期', scope.term_name ?? ''],
    ['指标', '数值'],
  ];
  for (const [key, value] of Object.entries(metrics)) {
    rows.push([key, value !== null && typeof value === 'object' ? JSON.stringify(value) : value]);
  }
  rows.push([]);
  rows.push(['来源类型', '来源 ID', '日期/标题', '附加信息']);
  const sourceRefs = (payload.source_refs ?? {}) as Record<string, Array<Record<string, unknown>>>;
  for (const [kind, refRows] of Object.entries(sourceRefs)) {
    for (const item of refRows) {
      rows.push([
        kind,
        item.id === undefined ? '' : item.id,
        item.date || item.title || '',
        JSON.stringify(item),
      ]);
    }
  }
  const buffer = await sheetBytes('报告摘要', ['指标', '数值'], rows);
  return { buffer, filename: `${report.title}_${report.period_start}_${report.period_end}.xlsx` };
}
