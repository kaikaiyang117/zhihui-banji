import type { Database } from 'better-sqlite3';

import { getDb, getCurrentScope, scopeIds } from '../services/context.js';
import { listRecords as listAttendanceRecords } from '../services/attendance.js';
import { listRecords as listScoreRecords, pyRound, scoreSummary, text } from '../services/scores.js';
import { listEntries as listPointEntries } from '../services/points.js';
import { listWorkItems } from '../services/workItems.js';
import { queryCalendar } from '../services/schoolCalendar.js';
import { todayString } from '../services/clock.js';
import { listToolLinks } from '../services/toolLinks.js';
import { startRollCall, submitRollCallExceptions, queryFieldInfo } from './tools/fieldOperations.js';
import { buildExcelImportTools } from './tools/excelImport.js';
import { buildEvidenceTools } from './tools/evidence.js';

export type ToolErrorCode =
  | 'invalid_arguments'
  | 'permission_denied'
  | 'confirmation_required'
  | 'not_found'
  | 'execution_failed'
  | 'unknown_tool'
  | 'tool_error';

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly autoRetry: boolean;

  constructor(message: string, options: { code?: ToolErrorCode; retryable?: boolean; autoRetry?: boolean } = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = options.code ?? 'tool_error';
    this.retryable = options.retryable ?? false;
    this.autoRetry = options.autoRetry ?? false;
  }
}

export type ToolHandler = (args: Record<string, unknown>) => Record<string, unknown>;

export class ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly handler: ToolHandler;
  readonly readOnly: boolean;
  readonly sensitive: boolean;
  readonly writeAction: boolean;
  readonly allowChannels: string[];

  constructor(options: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handler: ToolHandler;
    readOnly?: boolean;
    sensitive?: boolean;
    writeAction?: boolean;
    allowChannels?: string[];
  }) {
    this.name = options.name;
    this.description = options.description;
    this.parameters = options.parameters;
    this.handler = options.handler;
    this.readOnly = options.readOnly ?? true;
    this.sensitive = options.sensitive ?? false;
    this.writeAction = options.writeAction ?? false;
    this.allowChannels = options.allowChannels ?? ['web', 'wechat', 'local', 'lan'];
  }

  publicSchema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      read_only: this.readOnly,
      sensitive: this.sensitive,
      write_action: this.writeAction,
      confirm_required: this.writeAction,
      allow_channels: this.allowChannels,
    };
  }

  modelSchema(): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new ToolError(`工具已注册：${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  list(): Array<Record<string, unknown>> {
    return [...this.tools.keys()].sort().map((name) => this.tools.get(name)!.publicSchema());
  }

  modelTools(channel?: string): Array<Record<string, unknown>> {
    return [...this.tools.keys()].sort()
      .map((name) => this.tools.get(name)!)
      .filter((tool) => !channel || tool.allowChannels.includes(channel))
      .map((tool) => tool.modelSchema());
  }

  forChannel(channel: string): ToolRegistry {
    return new ToolRegistry(
      [...this.tools.values()].filter((tool) => tool.allowChannels.includes(channel)),
    );
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  execute(name: string, argumentsValue?: Record<string, unknown> | null): Record<string, unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError(`工具不存在：${name}`, { code: 'unknown_tool', retryable: true });
    const raw = argumentsValue || {};
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ToolError('工具参数必须是对象', { code: 'invalid_arguments', retryable: true });
    }
    const args = raw as Record<string, unknown>;
    if (tool.writeAction) {
      throw new ToolError('写入工具必须先生成操作预览并获得用户确认', { code: 'confirmation_required' });
    }
    const properties = (tool.parameters['properties'] as Record<string, unknown> | undefined) ?? {};
    const accepted = new Set(Object.keys(properties));
    const unknown = Object.keys(args).filter((key) => !accepted.has(key)).sort();
    if (unknown.length > 0) {
      throw new ToolError(`工具参数不支持：${unknown.join(', ')}`, { code: 'invalid_arguments', retryable: true });
    }
    const required = Array.isArray(tool.parameters['required']) ? tool.parameters['required'] : [];
    const missing = required.filter((key) => !(key in args));
    if (missing.length > 0) {
      throw new ToolError(`缺少工具参数：${missing.join(', ')}`, { code: 'invalid_arguments', retryable: true });
    }
    try {
      return tool.handler(args);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(message, { code: 'invalid_arguments', retryable: true });
    }
  }
}

const STUDENT_QUERY_FIELDS: Record<string, [string, string]> = {
  student_id: ['s.id', 'id'],
  student_no: ['s.学号', '学号'],
  student_name: ['s.姓名', '姓名'],
  gender: ['s.性别', '性别'],
  birth_month: ['s.出生年月', '出生年月'],
  ethnicity: ['s.民族', '民族'],
  guardian_name: ['s.监护人姓名', '监护人姓名'],
  guardian_occupation: ['s.监护人职业', '监护人职业'],
  guardian2_name: ['s.监护人2姓名', '监护人2姓名'],
  guardian2_relationship: ['s.监护人2关系', '监护人2关系'],
  is_boarding: ['s.是否住校', '是否住校'],
  specialty: ['s.特长', '特长'],
  class_role: ['s.班级任职', '班级任职'],
};
const DEFAULT_STUDENT_QUERY_FIELDS = ['student_no', 'student_name', 'gender', 'is_boarding', 'class_role'];
const MAX_STUDENT_QUERY_LIMIT = 500;

function pyInt(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ToolError('cannot convert float infinity to integer', { code: 'invalid_arguments', retryable: true });
    }
    return Math.trunc(value);
  }
  if (typeof value === 'bigint') return Number(value);
  const raw = String(value);
  if (/^\s*[-+]?\d+\s*$/.test(raw)) return Number(raw);
  throw new ToolError(`invalid literal for int() with base 10: '${raw}'`, { code: 'invalid_arguments', retryable: true });
}

function intArg(args: Record<string, unknown>, key: string, fallback: number): number {
  return pyInt(key in args ? args[key] : fallback);
}

function studentIdentity(studentId: unknown): [number | null, string, string] {
  if (!studentId) return [null, '', ''];
  const id = pyInt(studentId);
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    'SELECT s.id, s.学号, s.姓名 FROM students s JOIN student_enrollments e ON e.student_id=s.id '
    + "WHERE s.id=? AND e.class_id=? AND e.term_id=? AND s.deleted_at=''",
  ).get(id, classId, termId) as { id: number; 学号: string; 姓名: string } | undefined;
  if (!row) throw new ToolError('学生不存在', { code: 'invalid_arguments', retryable: true });
  return [Number(row.id), String(row['学号'] ?? ''), String(row['姓名'] ?? '')];
}

function getClassStudentCount(): Record<string, unknown> {
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    'SELECT COUNT(*) AS count FROM student_enrollments e JOIN students s ON s.id=e.student_id '
    + "WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''",
  ).get(classId, termId) as { count: number } | undefined;
  return { student_count: Number(row?.count ?? 0) };
}

function searchStudents(args: Record<string, unknown>): Record<string, unknown> {
  const keyword = String(args['keyword'] ?? '').trim();
  const limit = Math.max(1, Math.min(intArg(args, 'limit', 20), 100));
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const params: unknown[] = [classId, termId];
  let sql = 'SELECT s.id, s.学号, s.姓名, s.性别, s.班级任职, s.是否住校 '
    + 'FROM students s JOIN student_enrollments e ON e.student_id=s.id '
    + "WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''";
  if (keyword) {
    sql += ' AND (s.姓名 LIKE ? OR s.学号 LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  sql += ' ORDER BY s.学号 LIMIT ?';
  const students = (conn.prepare(sql).all(...params, limit) as Array<Record<string, unknown>>)
    .map((student) => ({ ...student, student_id: Number(student['id']) }));
  return { students, count: students.length };
}

function getStudentProfile(args: Record<string, unknown>): Record<string, unknown> {
  const studentId = pyInt(args['student_id']);
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    'SELECT id, 学号, 姓名, 性别, 出生年月, 民族, 家庭住址, 监护人姓名, '
    + '监护人电话, 监护人职业, 是否住校, 特长, 班级任职, 备注, '
    + '监护人2姓名, 监护人2电话, 监护人2关系 '
    + "FROM students s WHERE id=? AND s.deleted_at='' AND EXISTS("
    + 'SELECT 1 FROM student_enrollments e WHERE e.student_id=s.id AND e.class_id=? AND e.term_id=?)',
  ).get(studentId, classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new ToolError('学生不存在', { code: 'invalid_arguments', retryable: true });
  return { student: row };
}

function getStudentTimeline(args: Record<string, unknown>): Record<string, unknown> {
  const studentId = pyInt(args['student_id']);
  const limit = Math.max(1, Math.min(intArg(args, 'limit', 30), 100));
  const profile = getStudentProfile({ student_id: studentId })['student'] as Record<string, unknown>;
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const timeline: Array<Record<string, unknown>> = [];
  const events = conn.prepare(
    'SELECT id, occurred_at AS at, event_type AS title, description AS summary, status '
    + "FROM student_events WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at='' "
    + 'ORDER BY occurred_at DESC, id DESC LIMIT ?',
  ).all(studentId, classId, termId, limit) as Array<Record<string, unknown>>;
  for (const row of events) timeline.push({ kind: 'event', ...row });
  const communications = conn.prepare(
    "SELECT id, communicated_at AS at, '家校沟通' AS title, summary, status "
    + "FROM communications WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at='' "
    + 'ORDER BY communicated_at DESC, id DESC LIMIT ?',
  ).all(studentId, classId, termId, limit) as Array<Record<string, unknown>>;
  for (const row of communications) timeline.push({ kind: 'communication', ...row });
  const tasks = conn.prepare(
    "SELECT id, COALESCE(due_at, created_at) AS at, '待办' AS title, title AS summary, status "
    + "FROM student_tasks WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at='' "
    + 'ORDER BY due_at DESC, id DESC LIMIT ?',
  ).all(studentId, classId, termId, limit) as Array<Record<string, unknown>>;
  for (const row of tasks) timeline.push({ kind: 'task', ...row });
  timeline.sort((a, b) => {
    const atA = String(a['at'] ?? '');
    const atB = String(b['at'] ?? '');
    if (atA === atB) return 0;
    return atA > atB ? -1 : 1;
  });
  return {
    student: { id: profile['id'], 学号: profile['学号'], 姓名: profile['姓名'] },
    timeline: timeline.slice(0, limit),
  };
}

function getAttendanceSummary(args: Record<string, unknown>): Record<string, unknown> {
  const studentIdValue = args['student_id'];
  const [parsedStudentId, , studentName] = studentIdentity(studentIdValue);
  const dateFrom = String(args['date_from'] ?? '').slice(0, 10);
  const dateTo = String(args['date_to'] ?? '').slice(0, 10);
  const limit = Math.max(1, Math.min(intArg(args, 'limit', 30), 100));
  const records = listAttendanceRecords({
    studentId: parsedStudentId, dateFrom, dateTo, limit: Math.max(limit, 100),
  });
  const summary: Record<string, number> = {};
  for (const row of records) {
    const status = String(row['status']);
    summary[status] = (summary[status] ?? 0) + 1;
  }
  return {
    student: studentIdValue ? { id: studentIdValue, 姓名: studentName } : null,
    date_from: dateFrom,
    date_to: dateTo,
    summary,
    records: records.slice(0, limit).map((row) => ({
      date: row['attendance_date'], scene: row['scene'],
      student_name: row['student_name'], status: row['status'],
      reason: row['reason'], note: row['note'],
    })),
  };
}

function getScoresSummary(args: Record<string, unknown>): Record<string, unknown> {
  const studentIdValue = args['student_id'];
  const [parsedStudentId, , studentName] = studentIdentity(studentIdValue);
  const limit = Math.max(1, Math.min(intArg(args, 'limit', 20), 100));
  const data = scoreSummary({ studentId: parsedStudentId });
  const exams: Array<Record<string, unknown>> = [];
  const query = String(args['exam_name'] ?? '').trim();
  const students = data['students'] as Array<Record<string, unknown>>;
  for (const student of students) {
    const studentExams = [...(student['exams'] as Array<Record<string, unknown>>)].reverse();
    for (const exam of studentExams) {
      if (query && !String(exam['exam_name']).includes(query)) continue;
      if (!exam['has_any']) continue;
      const subjects = exam['subjects'] as Record<string, Record<string, unknown>>;
      const mappedSubjects: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(subjects)) {
        mappedSubjects[name] = String(item['status']) === '正常' ? item['score'] : item['status'];
      }
      exams.push({
        student_id: student['student_id'], student_name: student['姓名'],
        exam_name: exam['exam_name'], exam_date: exam['exam_date'],
        subjects: mappedSubjects,
        total: exam['total'], rank: exam['rank'],
        complete: exam['complete'], missing_subjects: exam['missing_subjects'],
        total_change: exam['total_change'], rank_change: exam['rank_change'],
      });
      if (exams.length >= limit) break;
    }
    if (exams.length >= limit) break;
  }
  return { student: studentIdValue ? { id: studentIdValue, 姓名: studentName } : null, exams };
}

function getTasksList(args: Record<string, unknown>): Record<string, unknown> {
  const studentIdValue = args['student_id'];
  const [parsedStudentId, , studentName] = studentIdentity(studentIdValue);
  const limit = Math.max(1, Math.min(intArg(args, 'limit', 20), 100));
  const status = String(args['status'] ?? '').trim() || null;
  const tasks = listWorkItems({
    status, bucket: status ? 'all' : 'open', studentId: parsedStudentId, limit,
  });
  return { student: studentIdValue ? { id: studentIdValue, 姓名: studentName } : null, tasks };
}

function getSchoolCalendar(args: Record<string, unknown>): Record<string, unknown> {
  return queryCalendar(
    String(args['date_from'] ?? ''), String(args['date_to'] ?? ''),
    String(args['day_type'] ?? ''), intArg(args, 'limit', 100),
  );
}

function getCommunicationsList(args: Record<string, unknown>): Record<string, unknown> {
  const studentIdValue = args['student_id'];
  const [parsedStudentId, , studentName] = studentIdentity(studentIdValue);
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const limit = Math.max(1, Math.min(intArg(args, 'limit', 20), 100));
  const where = ["c.class_id=?", "c.term_id=?", "c.deleted_at=''", "s.deleted_at=''"];
  const params: unknown[] = [classId, termId];
  const status = String(args['status'] ?? '').trim();
  if (status) {
    where.push('c.status=?');
    params.push(status);
  }
  if (parsedStudentId) {
    where.push('c.student_id=?');
    params.push(parsedStudentId);
  }
  params.push(limit);
  const records = conn.prepare(
    'SELECT c.id, c.student_id, s.姓名 AS student_name, c.communicated_at, '
    + 'c.method, c.reason, c.summary, c.feedback, c.agreement, c.followup_at, c.status '
    + 'FROM communications c JOIN students s ON s.id=c.student_id '
    + 'WHERE ' + where.join(' AND ')
    + ' ORDER BY c.communicated_at DESC, c.id DESC LIMIT ?',
  ).all(...params) as Array<Record<string, unknown>>;
  return {
    student: studentIdValue ? { id: studentIdValue, 姓名: studentName } : null,
    communications: records,
  };
}

function studentQueryFields(fieldsValue: unknown): Array<[string, string, string]> {
  let selected: string[];
  if (fieldsValue === undefined || fieldsValue === null) {
    selected = [...DEFAULT_STUDENT_QUERY_FIELDS];
  } else if (Array.isArray(fieldsValue)) {
    selected = fieldsValue.map((value) => String(value));
  } else if (typeof fieldsValue === 'string') {
    selected = fieldsValue.split('');
  } else {
    selected = [...DEFAULT_STUDENT_QUERY_FIELDS];
  }
  if (selected.length === 0) selected = [...DEFAULT_STUDENT_QUERY_FIELDS];
  const result: Array<[string, string, string]> = [];
  const seen = new Set<string>();
  for (const item of selected) {
    const name = String(item || '').trim();
    const mapping = STUDENT_QUERY_FIELDS[name];
    if (!mapping) throw new ToolError(`不支持的学生字段：${name}`, { code: 'invalid_arguments', retryable: true });
    if (seen.has(name)) continue;
    seen.add(name);
    result.push([name, mapping[0], mapping[1]]);
  }
  if (result.length > 10) throw new ToolError('一次最多查询 10 个学生字段', { code: 'invalid_arguments', retryable: true });
  return result;
}

function studentQueryScope(args: Record<string, unknown>): { where: string; params: unknown[] } {
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const where = ['e.class_id=?', 'e.term_id=?', "e.status='在读'", "s.deleted_at=''"];
  const params: unknown[] = [classId, termId];
  const keyword = String(args['keyword'] ?? '').trim();
  if (keyword) {
    where.push('(s.姓名 LIKE ? OR s.学号 LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const gender = String(args['gender'] ?? '').trim();
  if (gender) {
    where.push('s.性别=?');
    params.push(gender);
  }
  const boarding = String(args['boarding_status'] ?? '').trim();
  if (boarding) {
    where.push('s.是否住校=?');
    params.push(boarding);
  }
  const classRole = String(args['class_role'] ?? '').trim();
  if (classRole) {
    where.push('s.班级任职 LIKE ?');
    params.push(`%${classRole}%`);
  }
  return { where: where.join(' AND '), params };
}

function queryStudents(args: Record<string, unknown>): Record<string, unknown> {
  const selected = studentQueryFields(args['fields']);
  const limit = Math.max(1, Math.min(intArg(args, 'limit', 100), MAX_STUDENT_QUERY_LIMIT));
  const conn = getDb().connInstance;
  const { where, params } = studentQueryScope(args);
  const row = conn.prepare(
    'SELECT COUNT(*) AS count FROM students s JOIN student_enrollments e ON e.student_id=s.id '
    + 'WHERE ' + where,
  ).get(...params) as { count: number } | undefined;
  const total = Number(row?.count ?? 0);
  const columns = selected.map(([, expression, label]) => `${expression} AS "${label}"`).join(', ');
  const students = (conn.prepare(
    `SELECT ${columns} FROM students s JOIN student_enrollments e ON e.student_id=s.id `
    + `WHERE ${where} ORDER BY s.学号, s.id LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>).map((student) => {
    if (!('id' in student)) return student;
    return { ...student, student_id: Number(student['id']) };
  });
  return {
    fields: selected.map(([name]) => name),
    students,
    count: students.length,
    total_count: total,
    truncated: total > limit,
  };
}

function aggregateStudents(args: Record<string, unknown>): Record<string, unknown> {
  const groupBy = String(args['group_by'] ?? '').trim();
  const selected = studentQueryFields([groupBy]);
  const groupField = selected[0][0];
  const groupColumn = selected[0][2];
  const query = queryStudents({
    fields: ['student_id', 'student_no', 'student_name', groupField],
    keyword: args['keyword'], gender: args['gender'],
    boarding_status: args['boarding_status'], class_role: args['class_role'],
    limit: intArg(args, 'limit', MAX_STUDENT_QUERY_LIMIT),
  });
  const groups: Record<string, { value: string; count: number; students: Array<Record<string, unknown>> }> = {};
  let emptyCount = 0;
  for (const row of query['students'] as Array<Record<string, unknown>>) {
    let value = String(row[groupColumn] ?? '').trim();
    if (!value) {
      emptyCount += 1;
      if (!args['include_empty']) continue;
      value = '未填写';
    }
    const group = groups[value] ?? { value, count: 0, students: [] };
    group.count += 1;
    if (args['include_students'] !== false) {
      group.students.push({ id: row['id'], 学号: row['学号'] ?? '', 姓名: row['姓名'] ?? '' });
    }
    groups[value] = group;
  }
  const ordered = Object.values(groups).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.value === b.value) return 0;
    return a.value < b.value ? -1 : 1;
  });
  return {
    group_by: groupField,
    groups: ordered,
    student_count: query['total_count'],
    included_student_count: query['count'],
    empty_count: emptyCount,
    truncated: query['truncated'],
  };
}

function clip(value: unknown, limit = 120): string {
  const raw = text(value);
  return raw.length <= limit ? raw : `${raw.slice(0, limit - 1)}…`;
}

function scoreFacts(
  studentId: number, start: string, end: string, conn: Database,
): [Record<string, unknown>, Array<Record<string, unknown>>] {
  const records = listScoreRecords({ studentId, conn }).filter((row) => {
    const examDate = String(row['exam_date'] ?? '');
    return !examDate || (start <= examDate.slice(0, 10) && examDate.slice(0, 10) <= end);
  });
  const bySubject = new Map<string, Array<[string, number]>>();
  for (const row of records) {
    const rawScore = row['score'];
    if (rawScore === null || rawScore === undefined) continue;
    if (rawScore === '') continue;
    const value = Number(rawScore);
    if (!Number.isFinite(value)) continue;
    const subject = text(row['subject']);
    const list = bySubject.get(subject) ?? [];
    list.push([String(row['exam_date'] ?? ''), value]);
    bySubject.set(subject, list);
  }
  const changes: Array<Record<string, unknown>> = [];
  for (const [subject, values] of bySubject) {
    values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (values.length >= 2) {
      changes.push({ subject, delta: pyRound(values[values.length - 1][1] - values[0][1], 1) });
    }
  }
  changes.sort((a, b) => Math.abs(Number(b['delta'])) - Math.abs(Number(a['delta'])));
  const refs = records.length > 0
    ? [{
      source: '成绩',
      record_ids: records.slice(0, 20).map((row) => Number(row['id'])),
      detail: `${records.length}条学期成绩记录`,
    }] : [];
  return [{
    record_count: records.length,
    exam_count: new Set(records.map((row) => String(row['exam_name'] ?? ''))).size,
    subject_changes: changes.slice(0, 8),
    recent_scores: records.slice(-20).map((row) => ({
      exam: text(row['exam_name']), subject: text(row['subject']),
      score: row['score'], status: text(row['record_status']),
    })),
  }, refs];
}

function attendanceFacts(
  studentId: number, start: string, end: string, conn: Database,
): [Record<string, unknown>, Array<Record<string, unknown>>] {
  const records = listAttendanceRecords({ studentId, dateFrom: start, dateTo: end, limit: 5000, conn });
  const counts: Record<string, number> = {};
  for (const row of records) {
    const status = text(row['status']);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const anomalies = records.filter((row) => {
    const status = text(row['status']);
    return status !== '' && status !== '出勤';
  });
  const refs = anomalies.length > 0
    ? [{
      source: '考勤',
      record_ids: anomalies.slice(0, 12).map((row) => Number(row['id'])),
      detail: `${anomalies.length}次异常考勤`,
    }] : [];
  return [{
    record_count: records.length,
    status_counts: counts,
    anomaly_count: anomalies.length,
    recent_anomalies: anomalies.slice(0, 6).map((row) => ({
      date: text(row['attendance_date']), status: text(row['status']),
      reason: clip(row['reason'], 80),
    })),
  }, refs];
}

function pointFacts(
  studentId: number, start: string, end: string, conn: Database,
): [Record<string, unknown>, Array<Record<string, unknown>>] {
  const records = listPointEntries({ studentId, dateFrom: start, dateTo: end, limit: 5000, conn })
    .filter((row) => text(row['status']) === '有效');
  const categories: Record<string, { count: number; positive: number; negative: number }> = {};
  for (const row of records) {
    const category = text(row['category']) || '未分类';
    const bucket = categories[category] ?? { count: 0, positive: 0, negative: 0 };
    bucket.count += 1;
    if (Number(row['amount'] ?? 0) > 0) bucket.positive += 1;
    else bucket.negative += 1;
    categories[category] = bucket;
  }
  const refs = records.length > 0
    ? [{
      source: '行为积分',
      record_ids: records.slice(0, 12).map((row) => Number(row['id'])),
      detail: `${records.length}条有效行为记录，不用于计算奖学金总分`,
    }] : [];
  return [{
    record_count: records.length,
    categories,
    recent_reasons: records.slice(0, 6).map((row) => clip(row['reason'], 80)).filter(Boolean),
  }, refs];
}

function processFacts(
  studentId: number, classId: number, termId: number, start: string, end: string, conn: Database,
): [Record<string, unknown>, Array<Record<string, unknown>>] {
  const work = listWorkItems({ studentId, dateFrom: start, dateTo: end, limit: 200, conn });
  const events = conn.prepare(
    'SELECT id, occurred_at, event_type, description, status FROM student_events '
    + "WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at='' "
    + 'AND substr(occurred_at,1,10) BETWEEN ? AND ? ORDER BY occurred_at DESC, id DESC LIMIT 20',
  ).all(studentId, classId, termId, start, end) as Array<Record<string, unknown>>;
  const focus = conn.prepare(
    'SELECT id, topic, status, conclusion FROM focus_items '
    + "WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at='' "
    + "AND (conclusion<>'' OR status IN ('情况改善','已结束')) "
    + 'ORDER BY updated_at DESC, id DESC LIMIT 8',
  ).all(studentId, classId, termId) as Array<Record<string, unknown>>;
  const refs: Array<Record<string, unknown>> = [];
  if (events.length > 0) {
    refs.push({
      source: '学生事件',
      record_ids: events.map((row) => Number(row['id'])),
      detail: `${events.length}条学期事件`,
    });
  }
  if (focus.length > 0) {
    refs.push({
      source: '关注事项',
      record_ids: focus.map((row) => Number(row['id'])),
      detail: `${focus.length}条已形成结论的关注事项`,
    });
  }
  if (work.length > 0) {
    refs.push({
      source: '待办跟进',
      record_ids: work.slice(0, 12).map((row) => Number(row['id'])),
      detail: `${work.length}条跟进工作项`,
    });
  }
  return [{
    work_items: {
      total: work.length,
      completed: work.filter((row) => String(row['status']) === '已完成').length,
      open: work.filter((row) => !['已完成', '已取消'].includes(String(row['status']))).length,
    },
    events: events.slice(0, 8).map((row) => ({
      date: text(row['occurred_at']).slice(0, 10), type: text(row['event_type']),
      description: clip(row['description']), status: text(row['status']),
    })),
    followups: focus.map((row) => ({
      topic: clip(row['topic'], 60), status: text(row['status']),
      conclusion: clip(row['conclusion'], 100),
    })),
  }, refs];
}

function activeStudent(
  conn: Database, classId: number, termId: number, studentIds: number[] | null,
): Array<Record<string, unknown>> {
  let rows = conn.prepare(
    'SELECT s.id, s.学号, s.姓名, s.特长, s.班级任职 FROM students s '
    + 'JOIN student_enrollments e ON e.student_id=s.id '
    + "WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at='' "
    + 'ORDER BY s.学号, s.id',
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const requested = new Set((studentIds ?? []).map(Number));
  if (requested.size > 0) {
    const found = new Set(rows.map((row) => Number(row['id'])));
    for (const value of requested) {
      if (!found.has(value)) {
        throw new ToolError('选择的学生中有不在当前班级或学期的记录', { code: 'invalid_arguments', retryable: true });
      }
    }
    rows = rows.filter((row) => requested.has(Number(row['id'])));
  }
  return rows;
}

function buildStudentTermContext(studentId: number, conn: Database): Record<string, unknown> {
  const scope = getCurrentScope({ conn });
  const classId = Number(scope.class_id);
  const termId = Number(scope.term_id);
  const student = activeStudent(conn, classId, termId, [studentId])[0];
  if (!student) {
    throw new ToolError('学生不存在或不在当前班级/学期', { code: 'invalid_arguments', retryable: true });
  }
  const today = todayString();
  const start = (text(scope.start_date) || `${today.slice(0, 4)}-01-01`).slice(0, 10);
  const end = (text(scope.end_date) || today).slice(0, 10);
  const [scoreData, scoreRefs] = scoreFacts(studentId, start, end, conn);
  const [attendanceData, attendanceRefs] = attendanceFacts(studentId, start, end, conn);
  const [pointData, pointRefs] = pointFacts(studentId, start, end, conn);
  const [processData, processRefs] = processFacts(studentId, classId, termId, start, end, conn);
  const evidence = [...scoreRefs, ...attendanceRefs, ...pointRefs, ...processRefs];
  const available: string[] = [];
  if (Number(scoreData['record_count'] ?? 0) > 0) available.push('成绩');
  if (Number(attendanceData['anomaly_count'] ?? 0) > 0) available.push('异常考勤');
  if (Number(pointData['record_count'] ?? 0) > 0) available.push('行为记录');
  if ((processData['events'] as unknown[]).length > 0 || (processData['followups'] as unknown[]).length > 0) {
    available.push('过程记录');
  }
  return {
    student_id: Number(student['id']),
    学号: text(student['学号']),
    姓名: text(student['姓名']),
    profile: { 特长: clip(student['特长'], 80), 班级任职: clip(student['班级任职'], 80) },
    period: { start, end, term: text(scope.term_name) },
    facts: { 成绩: scoreData, 考勤: attendanceData, 行为记录: pointData, 过程记录: processData },
    evidence,
    coverage: { available_sources: available, source_count: evidence.length },
  };
}

function buildStudentTermContexts(studentIds: number[]): Array<Record<string, unknown>> {
  const conn = getDb().connInstance;
  const scope = getCurrentScope({ conn });
  const classId = Number(scope.class_id);
  const termId = Number(scope.term_id);
  const students = activeStudent(conn, classId, termId, studentIds);
  return students.map((row) => buildStudentTermContext(Number(row['id']), conn));
}

function getStudentTermCommentContext(args: Record<string, unknown>): Record<string, unknown> {
  const rawIds = args['student_ids'];
  const selected = (Array.isArray(rawIds) ? rawIds : []).map((value) => pyInt(value));
  if (selected.length === 0) {
    throw new ToolError('请至少提供一名学生', { code: 'invalid_arguments', retryable: true });
  }
  if (selected.length > Math.min(intArg(args, 'limit', 30), 30)) {
    throw new ToolError('一次最多整理30名学生的学期评语事实', { code: 'invalid_arguments', retryable: true });
  }
  const contexts = buildStudentTermContexts(selected);
  return { period: contexts[0]?.['period'] ?? {}, students: contexts };
}

const ALL_CHANNELS = ['web', 'wechat', 'local', 'lan'];
const NON_WECHAT_CHANNELS = ['web', 'local', 'lan'];

export function buildRegistry(): ToolRegistry {
  const tools: ToolDefinition[] = [
    new ToolDefinition({
      name: 'class_student_count',
      description: '查询当前工作台班级的学生总人数。用户问班级有多少人、多少名学生、学生总数时必须使用此工具。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: getClassStudentCount,
    }),
    new ToolDefinition({
      name: 'attendance_summary',
      description: '查询全班或指定学生的考勤统计。可按日期范围筛选，适合回答出勤、迟到、请假、缺勤问题。',
      parameters: {
        type: 'object',
        properties: {
          student_id: { type: 'integer', minimum: 1 },
          date_from: { type: 'string', description: '起始日期 YYYY-MM-DD，可为空' },
          date_to: { type: 'string', description: '结束日期 YYYY-MM-DD，可为空' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
        },
        additionalProperties: false,
      },
      handler: getAttendanceSummary,
    }),
    new ToolDefinition({
      name: 'scores_summary',
      description: '查询全班或指定学生的考试成绩、科目分数和总分。',
      parameters: {
        type: 'object',
        properties: {
          student_id: { type: 'integer', minimum: 1 },
          exam_name: { type: 'string', description: '考试名称，可为空' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
      handler: getScoresSummary,
      allowChannels: NON_WECHAT_CHANNELS,
    }),
    new ToolDefinition({
      name: 'tasks_list',
      description: '查询待办、逾期事项和学生跟进任务，默认只返回未完成事项。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: '待处理、处理中、待复查等状态，可为空' },
          student_id: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
      handler: getTasksList,
    }),
    new ToolDefinition({
      name: 'school_calendar_query',
      description: '查询当前学期校历中的上课日、放假日、调休、考试和活动安排。用户询问校历、哪天上课、哪天放假、调休或考试安排时必须使用此工具。',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: '起始日期 YYYY-MM-DD，可为空' },
          date_to: { type: 'string', description: '结束日期 YYYY-MM-DD，可为空' },
          day_type: { type: 'string', enum: ['上课日', '放假日', '调休上课', '考试日', '活动日', '其他'], description: '日期类型，可为空' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
        },
        additionalProperties: false,
      },
      handler: getSchoolCalendar,
    }),
    new ToolDefinition({
      name: 'communications_list',
      description: '查询家校沟通记录和后续跟进信息，只返回沟通摘要，不返回家长电话等敏感字段。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: '沟通状态，可为空' },
          student_id: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
      handler: getCommunicationsList,
    }),
    new ToolDefinition({
      name: 'students_search',
      description: '按姓名或学号搜索学生，只返回基础班级信息。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '姓名或学号，可为空' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
      handler: searchStudents,
    }),
    new ToolDefinition({
      name: 'student_get_profile',
      description: '根据学生 ID 查询学生档案。',
      parameters: {
        type: 'object',
        properties: { student_id: { type: 'integer', minimum: 1 } },
        required: ['student_id'],
        additionalProperties: false,
      },
      handler: getStudentProfile,
      sensitive: true,
      allowChannels: NON_WECHAT_CHANNELS,
    }),
    new ToolDefinition({
      name: 'student_get_timeline',
      description: '查询学生的事件、家校沟通和待办时间线。',
      parameters: {
        type: 'object',
        properties: {
          student_id: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
        },
        required: ['student_id'],
        additionalProperties: false,
      },
      handler: getStudentTimeline,
    }),
    new ToolDefinition({
      name: 'student_term_comment_context',
      description: '整理当前学期生成学生评语所需的安全事实摘要。只返回成绩变化、异常考勤、行为记录和已形成结论的过程记录，不返回家庭电话、住址或家校沟通原文。生成评语前必须使用此工具。',
      parameters: {
        type: 'object', properties: {
          student_ids: {
            type: 'array', items: { type: 'integer', minimum: 1 },
            minItems: 1, maxItems: 30,
          },
          limit: { type: 'integer', minimum: 1, maximum: 30, default: 30 },
        },
        required: ['student_ids'], additionalProperties: false,
      },
      handler: getStudentTermCommentContext,
    }),
    new ToolDefinition({
      name: 'students_query',
      description: '按字段白名单批量查询当前班级学生。适合回答“所有学生”“每个学生”“哪些学生的家长职业”等需要一次获取多名学生数据的问题；不返回电话、家庭住址或备注。',
      parameters: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'student_id', 'student_no', 'student_name', 'gender', 'birth_month',
                'ethnicity', 'guardian_name', 'guardian_occupation', 'guardian2_name',
                'guardian2_relationship', 'is_boarding', 'specialty', 'class_role',
              ],
            },
            minItems: 1,
            maxItems: 10,
            description: '需要返回的字段；未指定时返回学号、姓名、性别、住校和班级任职',
          },
          keyword: { type: 'string', description: '按姓名或学号筛选，可为空' },
          gender: { type: 'string', description: '按性别筛选，可为空' },
          boarding_status: { type: 'string', description: '按是否住校筛选，可为空' },
          class_role: { type: 'string', description: '按班级任职包含文字筛选，可为空' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
        additionalProperties: false,
      },
      handler: queryStudents,
    }),
    new ToolDefinition({
      name: 'students_aggregate',
      description: '按字段统计当前班级学生分布。适合回答家长职业分布、住校分布、性别分布或每种分类对应哪些学生的问题；不返回电话、家庭住址或备注。',
      parameters: {
        type: 'object',
        properties: {
          group_by: {
            type: 'string',
            enum: [
              'gender', 'guardian_occupation', 'is_boarding',
              'guardian2_relationship', 'class_role', 'ethnicity',
            ],
            description: '分组字段',
          },
          keyword: { type: 'string', description: '按姓名或学号筛选，可为空' },
          gender: { type: 'string', description: '按性别筛选，可为空' },
          boarding_status: { type: 'string', description: '按是否住校筛选，可为空' },
          class_role: { type: 'string', description: '按班级任职包含文字筛选，可为空' },
          include_empty: { type: 'boolean', default: false, description: '是否把未填写字段计入“未填写”分组' },
          include_students: { type: 'boolean', default: true, description: '是否返回每个分组的学生名单' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 500 },
        },
        required: ['group_by'],
        additionalProperties: false,
      },
      handler: aggregateStudents,
    }),
  ];
  tools.push(
    new ToolDefinition({
      name: 'create_task',
      description: '提出创建一条待办的操作预览。模型不得声称已创建；用户回复确认后才会执行。',
      parameters: {
        type: 'object', properties: {
          title: { type: 'string', minLength: 1 },
          student_id: { type: 'integer', minimum: 1, description: '学生数据库 ID 或学号' },
          owner: { type: 'string' }, scheduled_at: { type: 'string' },
          due_at: { type: 'string' }, priority: { type: 'string', enum: ['普通', '重要', '紧急'] },
          notes: { type: 'string' },
        }, required: ['title'], additionalProperties: false,
      },
      handler: () => ({}), readOnly: false, writeAction: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'record_communication',
      description: '提出记录家校沟通的操作预览。必须得到用户确认后才写入。',
      parameters: {
        type: 'object', properties: {
          student_id: { type: 'integer', minimum: 1 }, communicated_at: { type: 'string' },
          method: { type: 'string' }, reason: { type: 'string' }, summary: { type: 'string' },
          feedback: { type: 'string' }, agreement: { type: 'string' }, followup_at: { type: 'string' },
          status: { type: 'string' }, event_id: { type: 'integer' },
        }, required: ['student_id', 'communicated_at', 'method', 'reason', 'summary'], additionalProperties: false,
      },
      handler: () => ({}), readOnly: false, writeAction: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'save_attendance',
      description: '提出保存单名学生考勤的操作预览。只允许单条记录，必须得到用户确认后才写入。',
      parameters: {
        type: 'object', properties: {
          student_id: { type: 'integer', minimum: 1 }, date: { type: 'string' },
          scene: { type: 'string' }, status: { type: 'string', enum: ['出勤', '迟到', '请假', '早退', '缺勤'] },
          reason: { type: 'string' }, arrive: { type: 'string' }, leave: { type: 'string' }, note: { type: 'string' },
        }, required: ['student_id', 'date', 'status'], additionalProperties: false,
      },
      handler: () => ({}), readOnly: false, writeAction: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'record_points',
      description: '提出记录单名学生行为积分的操作预览。必须得到用户确认后才写入。',
      parameters: {
        type: 'object', properties: {
          student_id: { type: 'integer', minimum: 1 }, amount: { type: 'number' },
          occurred_at: { type: 'string' }, category: { type: 'string' }, reason: { type: 'string' },
        }, required: ['student_id', 'amount', 'reason'], additionalProperties: false,
      },
      handler: () => ({}), readOnly: false, writeAction: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'update_task',
      description: '提出修改一条待办的操作预览，可修改内容、时间、优先级或状态；完成/取消时必须填写结果。用户确认后才会执行。',
      parameters: {
        type: 'object', properties: {
          task_id: { type: 'integer', minimum: 1, description: '待办数据库 ID' },
          title: { type: 'string' }, owner: { type: 'string' }, priority: { type: 'string', enum: ['普通', '重要', '紧急'] },
          scheduled_at: { type: 'string' }, due_at: { type: 'string' },
          status: { type: 'string', enum: ['待处理', '处理中', '待复查', '已完成', '已取消'] },
          notes: { type: 'string' }, result: { type: 'string' },
        }, required: ['task_id'], additionalProperties: false,
      },
      handler: () => ({}), readOnly: false, writeAction: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'create_event',
      description: '提出记录单个学生事件的操作预览，例如异常情况、家长反馈或成长记录；用户确认后才会写入。',
      parameters: {
        type: 'object', properties: {
          student_id: { type: 'integer', minimum: 1, description: '学生数据库 ID 或学号' },
          occurred_at: { type: 'string', minLength: 1, description: '发生时间' },
          event_type: { type: 'string', minLength: 1, description: '事件类型' },
          description: { type: 'string', minLength: 1, description: '事件描述' },
          handling: { type: 'string' }, parent_contacted: { type: 'boolean' },
          needs_followup: { type: 'boolean' }, followup_due: { type: 'string' },
          status: { type: 'string', enum: ['待处理', '处理中', '待复查', '已完成', '无需处理'] },
        }, required: ['student_id', 'occurred_at', 'event_type', 'description'], additionalProperties: false,
      },
      handler: () => ({}), readOnly: false, writeAction: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'create_focus',
      description: '提出为单个学生创建重点关注事项的操作预览，包含原因和跟进计划；用户确认后才会写入。',
      parameters: {
        type: 'object', properties: {
          student_id: { type: 'integer', minimum: 1, description: '学生数据库 ID 或学号' },
          topic: { type: 'string', minLength: 1, description: '关注主题' },
          reason: { type: 'string', minLength: 1, description: '关注原因' },
          evidence: { type: 'string' }, action_plan: { type: 'string' },
          status: { type: 'string', enum: ['待确认', '跟进中', '情况改善', '已结束'] },
          next_review_at: { type: 'string' },
        }, required: ['student_id', 'topic', 'reason'], additionalProperties: false,
      },
      handler: () => ({}), readOnly: false, writeAction: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'create_meeting',
      description: '提出记录一次班会的操作预览，可包含主题、内容、结论和行动项；用户确认后才会写入。',
      parameters: {
        type: 'object', properties: {
          held_on: { type: 'string', description: '班会日期 YYYY-MM-DD' },
          topic: { type: 'string', minLength: 1 },
          format: { type: 'string', enum: ['主题班会', '事务通知', '团队活动', '安全教育', '心理健康'] },
          content: { type: 'string' }, participation: { type: 'string' }, conclusion: { type: 'string' },
          status: { type: 'string', enum: ['已记录', '待复盘'] },
          student_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: '参与学生 ID 或学号，可为空' },
          action_items: { type: 'array', items: { type: 'object' }, description: '行动项数组，可包含 title、owner、due_at、priority' },
          followup_title: { type: 'string' }, followup_due: { type: 'string' },
        }, required: ['held_on', 'topic'], additionalProperties: false,
      },
      handler: () => ({}), readOnly: false, writeAction: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'create_activity',
      description: '提出记录一次班级活动的操作预览，可包含参与学生、预算、结果和复盘；用户确认后才会写入。',
      parameters: {
        type: 'object', properties: {
          occurred_on: { type: 'string', description: '活动日期 YYYY-MM-DD' },
          name: { type: 'string', minLength: 1 },
          activity_type: { type: 'string', enum: ['文体活动', '社会实践', '志愿服务', '学科竞赛', '节日庆祝', '其他'] },
          budget: { type: 'number', minimum: 0 }, participant_count: { type: 'integer', minimum: 0 },
          summary: { type: 'string' }, result: { type: 'string' }, retrospective: { type: 'string' },
          status: { type: 'string', enum: ['计划中', '进行中', '已完成', '已复盘'] },
          student_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: '参与学生 ID 或学号，可为空' },
          followup_title: { type: 'string' }, followup_due: { type: 'string' },
        }, required: ['occurred_on', 'name'], additionalProperties: false,
      },
      handler: () => ({}), readOnly: false, writeAction: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'create_diary',
      description: '提出记录一条班主任日志的操作预览；用户确认后才会写入本地工作台。',
      parameters: {
        type: 'object', properties: {
          diary_date: { type: 'string', description: '日志日期 YYYY-MM-DD' }, weather: { type: 'string' },
          work: { type: 'string' }, event: { type: 'string' }, reflection: { type: 'string' }, todo: { type: 'string' },
        }, required: ['diary_date'], additionalProperties: false,
      },
      handler: () => ({}), readOnly: false, writeAction: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'create_knowledge_note',
      description: '提出在本地知识库创建 Markdown 笔记的操作预览；用户确认后才会创建文件。',
      parameters: {
        type: 'object', properties: {
          title: { type: 'string', minLength: 1 }, category: { type: 'string' },
          template: { type: 'string', enum: ['备课笔记', '考研知识点', '读书笔记', '学生档案', '班会记录', '班主任日志'] },
          content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
        }, required: ['title'], additionalProperties: false,
      },
      handler: () => ({}), readOnly: false, writeAction: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'create_class_task',
      description: '提出为明确学生范围创建班级材料收集任务的操作预览。此操作会为每名学生生成收集项，用户确认后才会写入；微信端不可用。',
      parameters: {
        type: 'object', properties: {
          title: { type: 'string', minLength: 1 },
          student_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, description: '学生 ID 或学号' },
          task_type: { type: 'string' }, start_at: { type: 'string' }, due_at: { type: 'string' },
          material_name: { type: 'string' }, description: { type: 'string' }, template_id: { type: 'integer', minimum: 1 },
        }, required: ['title', 'student_ids'], additionalProperties: false,
      },
      handler: () => ({}), readOnly: false, writeAction: true, allowChannels: NON_WECHAT_CHANNELS,
    }),
  );
  tools.push(new ToolDefinition({
    name: 'start_roll_call',
    description: '发起课堂点名，返回班级学生列表和默认全到提示。需确认班级、日期和场景。',
    parameters: {
      type: 'object', properties: {
        class_name: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' },
        scene: { type: 'string', enum: ['早自习', '上午', '下午', '晚自习', '常规到校'] },
      }, additionalProperties: false,
    },
    handler: startRollCall, readOnly: true, writeAction: false, allowChannels: ALL_CHANNELS,
  }));
  tools.push(new ToolDefinition({
    name: 'submit_roll_call_exceptions',
    description: '提交点名异常学生，返回预览结果供教师确认。',
    parameters: {
      type: 'object', properties: {
        session_id: { type: 'string' },
        exceptions: { type: 'array', items: { type: 'object', properties: { student_name: { type: 'string' }, status: { type: 'string' }, reason: { type: 'string' } }, required: ['student_name', 'status'] } },
      }, required: ['session_id', 'exceptions'], additionalProperties: false,
    },
    handler: submitRollCallExceptions, readOnly: false, writeAction: true, allowChannels: ALL_CHANNELS,
  }));
  tools.push(new ToolDefinition({
    name: 'query_field_info',
    description: '查询现场只读信息：今日课程、近期考试、待办摘要或班级学生。',
    parameters: {
      type: 'object', properties: {
        query_type: { type: 'string', enum: ['today_schedule', 'upcoming_exams', 'today_tasks', 'class_students'] },
        class_name: { type: 'string' },
      }, required: ['query_type'], additionalProperties: false,
    },
    handler: queryFieldInfo, readOnly: true, writeAction: false, allowChannels: ALL_CHANNELS,
  }));
  tools.push(...buildExcelImportTools());
  tools.push(...buildEvidenceTools());
  tools.push(new ToolDefinition({
    name: 'tool_link_search',
    description: '搜索已配置的工作入口/常用工具链接。用户要求打开教务系统、教学平台等外部工具时使用此工具查找匹配的链接。找不到时明确提示，不编造网址。',
    parameters: {
      type: 'object', properties: {
        query: { type: 'string', description: '搜索关键词，匹配名称或URL' },
      }, required: ['query'], additionalProperties: false,
    },
    handler: (args) => {
      const query = String(args.query ?? '').trim();
      if (!query) return { results: [], hint: '请提供搜索关键词' };
      const results = listToolLinks({ search: query });
      if (results.length === 0) return { results: [], hint: `未找到匹配"${query}"的工作入口，请到工作入口页面配置。` };
      return {
        results: results.map((r: Record<string, unknown>) => ({
          id: r.id, name: r.name, url: r.url, category: r.category, pinned: r.pinned,
        })),
        hint: results.length > 1 ? `找到 ${results.length} 个匹配入口，请确认要打开哪一个。` : '找到匹配入口。',
      };
    },
    readOnly: true, writeAction: false, allowChannels: ALL_CHANNELS,
  }));
  return new ToolRegistry(tools);
}
