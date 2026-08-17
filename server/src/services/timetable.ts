/* MIG-11 高中课程表：固定周课表、临时调课与按日解析。
 * 课程表只维护当前班级/学期的排课事实；校历负责判断日期是否行课。
 */
import type { Database } from 'better-sqlite3';

import { getDb, getCurrentScope, type ScopeInfo } from './context.js';
import * as audit from './audit.js';

export const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const SESSION_TYPES = ['普通课', '早自习', '晚自习', '班会', '自习', '社团', '考试', '活动'];
export const WEEK_PATTERNS = ['全周', '单周', '双周'];
export const CHANGE_ACTIONS = ['调课', '代课', '停课', '考试', '活动'];

export class TimetableError extends Error {}

type ScopeOptions = { write?: boolean; conn?: Database };

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function integer(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || text(value) === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function scope(options: ScopeOptions = {}): [number, number, ScopeInfo] {
  const current = getCurrentScope(options);
  return [Number(current.class_id), Number(current.term_id), current];
}

function parseDate(value: unknown): string {
  const raw = text(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) throw new TimetableError('日期格式不正确，应为 YYYY-MM-DD');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])) {
    throw new TimetableError('日期格式不正确，应为 YYYY-MM-DD');
  }
  return raw;
}

function parseTime(value: unknown, label: string): string {
  const raw = text(value);
  if (!raw) return '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) {
    throw new TimetableError(`${label}格式不正确，应为 HH:MM`);
  }
  return raw;
}

function validatePeriod(options: {
  periodNo: number; label?: string; startTime?: string; endTime?: string; sessionType?: string;
}): Record<string, unknown> {
  if (options.periodNo < 1 || options.periodNo > 20) throw new TimetableError('节次必须在 1 到 20 之间');
  const label = text(options.label) || `${options.periodNo}节`;
  const startTime = parseTime(options.startTime, '上课时间');
  const endTime = parseTime(options.endTime, '下课时间');
  if (startTime && endTime && startTime >= endTime) throw new TimetableError('下课时间必须晚于上课时间');
  const sessionType = text(options.sessionType) || '普通课';
  if (!SESSION_TYPES.includes(sessionType)) throw new TimetableError('课程时段类型不合法');
  return { period_no: options.periodNo, label, start_time: startTime, end_time: endTime, session_type: sessionType };
}

function validateEntry(options: {
  weekday: number; periodNo: number; subject?: string; teacherName?: string; room?: string;
  sessionType?: string; weekPattern?: string; weekStart?: number; weekEnd?: number; note?: string;
}): Record<string, unknown> {
  if (options.weekday < 1 || options.weekday > 7) throw new TimetableError('星期必须在周一到周日之间');
  if (options.periodNo < 1 || options.periodNo > 20) throw new TimetableError('节次必须在 1 到 20 之间');
  const subject = text(options.subject);
  if (!subject) throw new TimetableError('科目不能为空');
  const sessionType = text(options.sessionType) || '普通课';
  if (!SESSION_TYPES.includes(sessionType)) throw new TimetableError('课程时段类型不合法');
  const weekPattern = text(options.weekPattern) || '全周';
  if (!WEEK_PATTERNS.includes(weekPattern)) throw new TimetableError('单双周设置不合法');
  const weekStart = integer(options.weekStart, 1);
  const weekEnd = integer(options.weekEnd, 99);
  if (weekStart < 1 || weekEnd < weekStart || weekEnd > 99) throw new TimetableError('教学周范围不合法');
  return {
    weekday: options.weekday, period_no: options.periodNo, subject,
    teacher_name: text(options.teacherName), room: text(options.room), session_type: sessionType,
    week_pattern: weekPattern, week_start: weekStart, week_end: weekEnd, note: text(options.note),
  };
}

function dayOfDate(date: string): number {
  const value = new Date(`${date}T00:00:00Z`).getUTCDay();
  return value === 0 ? 7 : value;
}

function weekNumber(date: string, scopeInfo: ScopeInfo): number {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(scopeInfo.start_date))
    ? String(scopeInfo.start_date) : date;
  const diff = Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  return Math.max(1, Math.floor(diff / 7) + 1);
}

function matchesWeek(row: Record<string, unknown>, week: number): boolean {
  const start = Number(row.week_start ?? 1);
  const end = Number(row.week_end ?? 99);
  if (week < start || week > end) return false;
  const pattern = String(row.week_pattern ?? '全周');
  return pattern === '全周' || (pattern === '单周' && week % 2 === 1) || (pattern === '双周' && week % 2 === 0);
}

function periodRows(conn: Database, classId: number, termId: number): Array<Record<string, unknown>> {
  return conn.prepare(
    'SELECT * FROM timetable_periods WHERE class_id=? AND term_id=? AND enabled=1 ORDER BY period_no',
  ).all(classId, termId) as Array<Record<string, unknown>>;
}

function entryRows(conn: Database, classId: number, termId: number): Array<Record<string, unknown>> {
  return conn.prepare(
    "SELECT * FROM timetable_entries WHERE class_id=? AND term_id=? AND status='启用' ORDER BY weekday, period_no, id",
  ).all(classId, termId) as Array<Record<string, unknown>>;
}

export function listTimetable(options: { teacherName?: string; weekday?: number; conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId, current] = scope({ conn });
  const periods = periodRows(conn, classId, termId);
  const allEntries = conn.prepare(
    "SELECT * FROM timetable_entries WHERE class_id=? AND term_id=? AND status='启用' ORDER BY weekday, period_no, id",
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const entries = allEntries.filter((entry) => {
    if (options.teacherName && String(entry.teacher_name ?? '') !== text(options.teacherName)) return false;
    if (options.weekday && Number(entry.weekday) !== Number(options.weekday)) return false;
    return true;
  });
  return {
    scope: { class_id: classId, term_id: termId, class_name: current.class_name, term_name: current.term_name },
    periods, entries, teachers: [...new Set(allEntries.map(item => String(item.teacher_name ?? '')).filter(Boolean))],
  };
}

export function listChanges(options: { dateFrom?: string; dateTo?: string; conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const where = ["class_id=?", "term_id=?", "status='生效'"];
  const params: unknown[] = [classId, termId];
  if (options.dateFrom) { where.push('change_date>=?'); params.push(parseDate(options.dateFrom)); }
  if (options.dateTo) { where.push('change_date<=?'); params.push(parseDate(options.dateTo)); }
  return conn.prepare(
    `SELECT * FROM timetable_changes WHERE ${where.join(' AND ')} ORDER BY change_date, period_no`,
  ).all(...params) as Array<Record<string, unknown>>;
}

export function daySchedule(dateValue: string, options: ScopeOptions = {}): Record<string, unknown> {
  const date = parseDate(dateValue);
  const conn = connOf(options.conn);
  const [classId, termId, current] = scope({ conn });
  const week = weekNumber(date, current);
  const weekday = dayOfDate(date);
  const calendar = conn.prepare(
    'SELECT * FROM school_calendar_days WHERE class_id=? AND term_id=? AND calendar_date=?',
  ).get(classId, termId, date) as Record<string, unknown> | undefined;
  const periods = periodRows(conn, classId, termId);
  const base = entryRows(conn, classId, termId)
    .filter(row => Number(row.weekday) === weekday && matchesWeek(row, week));
  const changes = conn.prepare(
    "SELECT * FROM timetable_changes WHERE class_id=? AND term_id=? AND change_date=? AND status='生效'",
  ).all(classId, termId, date) as Array<Record<string, unknown>>;
  const changeByPeriod = new Map(changes.map(item => [Number(item.period_no), item]));
  const baseByPeriod = new Map<number, Record<string, unknown>>();
  for (const row of base) if (!baseByPeriod.has(Number(row.period_no))) baseByPeriod.set(Number(row.period_no), row);
  const entries = periods.map(period => {
    const periodNo = Number(period.period_no);
    const change = changeByPeriod.get(periodNo);
    const original = baseByPeriod.get(periodNo);
    let entry: Record<string, unknown> | null = original ? { ...original } : null;
    if (change?.action === '停课') entry = null;
    else if (change) {
      entry = {
        ...(original ?? {}), ...change, id: original?.id ?? null, period_no: periodNo,
        is_change: true, original_subject: original?.subject ?? '', original_teacher_name: original?.teacher_name ?? '',
      };
    }
    return { ...period, entry };
  });
  return {
    date, weekday, weekday_label: WEEKDAYS[weekday - 1], week_no: week,
    school_day: calendar ? Boolean(calendar.is_school_day) : weekday <= 5,
    calendar: calendar ?? null, changes, periods, entries,
  };
}

export function createPeriod(options: {
  periodNo: number; label?: string; startTime?: string; endTime?: string; sessionType?: string;
}): Record<string, unknown> {
  const conn = getDb().connInstance;
  const [classId, termId] = scope({ write: true, conn });
  const item = validatePeriod(options);
  const result = conn.prepare(
    `INSERT INTO timetable_periods(class_id, term_id, period_no, label, start_time, end_time, session_type)
     VALUES(?,?,?,?,?,?,?)`,
  ).run(classId, termId, item.period_no, item.label, item.start_time, item.end_time, item.session_type);
  const id = Number(result.lastInsertRowid);
  audit.record('timetable_period', id, 'create', { summary: '新增课程节次', params: item, classId, termId, conn });
  return conn.prepare('SELECT * FROM timetable_periods WHERE id=?').get(id) as Record<string, unknown>;
}

export function updatePeriod(id: number, options: {
  label?: string; startTime?: string; endTime?: string; sessionType?: string; enabled?: boolean;
}): Record<string, unknown> {
  const conn = getDb().connInstance;
  const [classId, termId] = scope({ write: true, conn });
  const current = conn.prepare('SELECT * FROM timetable_periods WHERE id=? AND class_id=? AND term_id=?').get(id, classId, termId) as Record<string, unknown> | undefined;
  if (!current) throw new TimetableError('课程节次不存在');
  const item = validatePeriod({
    periodNo: Number(current.period_no), label: options.label ?? String(current.label),
    startTime: options.startTime ?? String(current.start_time), endTime: options.endTime ?? String(current.end_time),
    sessionType: options.sessionType ?? String(current.session_type),
  });
  conn.prepare(
    `UPDATE timetable_periods SET label=?, start_time=?, end_time=?, session_type=?, enabled=?, updated_at=datetime('now','localtime')
     WHERE id=? AND class_id=? AND term_id=?`,
  ).run(item.label, item.start_time, item.end_time, item.session_type, options.enabled === false ? 0 : 1, id, classId, termId);
  audit.record('timetable_period', id, 'update', { summary: '更新课程节次', params: item, classId, termId, conn });
  return conn.prepare('SELECT * FROM timetable_periods WHERE id=?').get(id) as Record<string, unknown>;
}

export function createEntry(options: {
  weekday: number; periodNo: number; subject: string; teacherName?: string; room?: string;
  sessionType?: string; weekPattern?: string; weekStart?: number; weekEnd?: number; note?: string;
}): Record<string, unknown> {
  const conn = getDb().connInstance;
  const [classId, termId] = scope({ write: true, conn });
  const item = validateEntry(options);
  if (!conn.prepare('SELECT 1 FROM timetable_periods WHERE class_id=? AND term_id=? AND period_no=? AND enabled=1')
    .get(classId, termId, item.period_no)) throw new TimetableError('请先配置对应的课程节次');
  const result = conn.prepare(
    `INSERT INTO timetable_entries(class_id, term_id, weekday, period_no, subject, teacher_name, room, session_type, week_pattern, week_start, week_end, note)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(classId, termId, item.weekday, item.period_no, item.subject, item.teacher_name, item.room,
    item.session_type, item.week_pattern, item.week_start, item.week_end, item.note);
  const id = Number(result.lastInsertRowid);
  audit.record('timetable_entry', id, 'create', { summary: '新增课程安排', params: item, classId, termId, conn });
  return conn.prepare('SELECT * FROM timetable_entries WHERE id=?').get(id) as Record<string, unknown>;
}

export function updateEntry(id: number, options: {
  weekday?: number; periodNo?: number; subject?: string; teacherName?: string; room?: string;
  sessionType?: string; weekPattern?: string; weekStart?: number; weekEnd?: number; note?: string; status?: string;
}): Record<string, unknown> {
  const conn = getDb().connInstance;
  const [classId, termId] = scope({ write: true, conn });
  const current = conn.prepare('SELECT * FROM timetable_entries WHERE id=? AND class_id=? AND term_id=?').get(id, classId, termId) as Record<string, unknown> | undefined;
  if (!current) throw new TimetableError('课程安排不存在');
  const item = validateEntry({
    weekday: options.weekday ?? Number(current.weekday), periodNo: options.periodNo ?? Number(current.period_no),
    subject: options.subject ?? String(current.subject), teacherName: options.teacherName ?? String(current.teacher_name),
    room: options.room ?? String(current.room), sessionType: options.sessionType ?? String(current.session_type),
    weekPattern: options.weekPattern ?? String(current.week_pattern), weekStart: options.weekStart ?? Number(current.week_start),
    weekEnd: options.weekEnd ?? Number(current.week_end), note: options.note ?? String(current.note),
  });
  conn.prepare(
    `UPDATE timetable_entries SET weekday=?, period_no=?, subject=?, teacher_name=?, room=?, session_type=?, week_pattern=?, week_start=?, week_end=?, note=?, status=?, updated_at=datetime('now','localtime')
     WHERE id=? AND class_id=? AND term_id=?`,
  ).run(item.weekday, item.period_no, item.subject, item.teacher_name, item.room, item.session_type,
    item.week_pattern, item.week_start, item.week_end, item.note, options.status ?? String(current.status), id, classId, termId);
  audit.record('timetable_entry', id, 'update', { summary: '更新课程安排', params: item, classId, termId, conn });
  return conn.prepare('SELECT * FROM timetable_entries WHERE id=?').get(id) as Record<string, unknown>;
}

export function saveChange(options: {
  changeDate: string; periodNo: number; action?: string; subject?: string; teacherName?: string; room?: string;
  sessionType?: string; note?: string; status?: string;
}): Record<string, unknown> {
  const conn = getDb().connInstance;
  const [classId, termId] = scope({ write: true, conn });
  const changeDate = parseDate(options.changeDate);
  if (options.periodNo < 1 || options.periodNo > 20) throw new TimetableError('节次必须在 1 到 20 之间');
  const action = text(options.action) || '调课';
  if (!CHANGE_ACTIONS.includes(action)) throw new TimetableError('课程变更类型不合法');
  if (action !== '停课' && !text(options.subject)) throw new TimetableError('调课、代课、考试或活动必须填写科目');
  if (!conn.prepare('SELECT 1 FROM timetable_periods WHERE class_id=? AND term_id=? AND period_no=? AND enabled=1')
    .get(classId, termId, options.periodNo)) throw new TimetableError('请先配置对应的课程节次');
  const result = conn.prepare(
    `INSERT INTO timetable_changes(class_id, term_id, change_date, period_no, action, subject, teacher_name, room, session_type, note, status)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(class_id, term_id, change_date, period_no) DO UPDATE SET action=excluded.action, subject=excluded.subject,
       teacher_name=excluded.teacher_name, room=excluded.room, session_type=excluded.session_type, note=excluded.note,
       status=excluded.status, updated_at=datetime('now','localtime')`,
  ).run(classId, termId, changeDate, options.periodNo, action, text(options.subject), text(options.teacherName),
    text(options.room), text(options.sessionType) || '普通课', text(options.note), options.status ?? '生效');
  const row = conn.prepare('SELECT * FROM timetable_changes WHERE class_id=? AND term_id=? AND change_date=? AND period_no=?')
    .get(classId, termId, changeDate, options.periodNo) as Record<string, unknown>;
  audit.record('timetable_change', row.id as number, result.changes ? 'upsert' : 'create', {
    summary: '保存课程临时变更', params: { ...options, change_date: changeDate }, classId, termId, conn,
  });
  return row;
}

export function cancelChange(id: number): void {
  const conn = getDb().connInstance;
  const [classId, termId] = scope({ write: true, conn });
  const result = conn.prepare(
    "UPDATE timetable_changes SET status='已取消', updated_at=datetime('now','localtime') WHERE id=? AND class_id=? AND term_id=?",
  ).run(id, classId, termId);
  if (!result.changes) throw new TimetableError('课程变更不存在');
  audit.record('timetable_change', id, 'cancel', { summary: '取消课程临时变更', classId, termId, conn });
}

function dayNumber(value: unknown): number | null {
  const original = text(value);
  const normalized = original.replace(/^星期/, '周').replace(/^礼拜/, '周');
  const raw = normalized.replace(/^周/, '');
  if (/^[1-7]$/.test(raw)) return Number(raw);
  const index = WEEKDAYS.findIndex(item => item === normalized);
  return index >= 0 ? index + 1 : null;
}

function headerIndex(headers: string[]): Record<string, number> {
  const aliases: Record<string, string[]> = {
    weekday: ['星期', '周几', '星期几', 'weekday'], period_no: ['节次', '第几节', 'period', 'period_no'],
    label: ['节次名称', '节次标签', 'label'], start_time: ['开始时间', '上课时间', 'start_time'],
    end_time: ['结束时间', '下课时间', 'end_time'], subject: ['科目', '课程', '学科', 'subject'],
    teacher_name: ['任课教师', '教师', '老师', 'teacher_name'], room: ['教室', 'room'],
    session_type: ['时段类型', '课程类型', 'session_type'], week_pattern: ['单双周', '周次模式', 'week_pattern'],
    week_start: ['开始周', '起始周', 'week_start'], week_end: ['结束周', '截止周', 'week_end'], note: ['备注', 'note'],
  };
  const result: Record<string, number> = {};
  for (const [key, candidates] of Object.entries(aliases)) {
    const index = headers.findIndex(header => candidates.includes(header));
    if (index >= 0) result[key] = index;
  }
  return result;
}

export function previewImport(rows: unknown[][], filename = ''): Record<string, unknown> {
  const headerRow = rows.findIndex(row => {
    const headers = row.map(value => text(value));
    return headers.some(value => ['星期', '周几', '星期几'].includes(value))
      && headers.some(value => ['节次', '第几节', 'period', 'period_no'].includes(value))
      && headers.some(value => ['科目', '课程', '学科', 'subject'].includes(value));
  });
  if (headerRow < 0) throw new TimetableError('未找到课程表表头，需要包含“星期、节次、科目”列');
  const indexes = headerIndex(rows[headerRow].map(value => text(value)));
  const conn = getDb().connInstance;
  const [classId, termId] = scope({ conn });
  const resultRows: Array<Record<string, unknown>> = [];
  let validCount = 0;
  for (let index = headerRow + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row?.some(value => text(value))) continue;
    const value = (key: string): unknown => indexes[key] === undefined ? '' : row[indexes[key]];
    const weekday = dayNumber(value('weekday'));
    const periodNo = integer(value('period_no'));
    const item: Record<string, unknown> = {
      weekday, period_no: periodNo, label: text(value('label')) || `${periodNo}节`,
      start_time: text(value('start_time')), end_time: text(value('end_time')), subject: text(value('subject')),
      teacher_name: text(value('teacher_name')), room: text(value('room')), session_type: text(value('session_type')) || '普通课',
      week_pattern: text(value('week_pattern')) || '全周', week_start: integer(value('week_start'), 1), week_end: integer(value('week_end'), 99), note: text(value('note')),
    };
    let error = '';
    try {
      if (weekday === null) throw new TimetableError('星期不合法');
      validateEntry({
        weekday, periodNo, subject: String(item.subject), teacherName: String(item.teacher_name), room: String(item.room),
        sessionType: String(item.session_type), weekPattern: String(item.week_pattern), weekStart: Number(item.week_start),
        weekEnd: Number(item.week_end), note: String(item.note),
      });
      validatePeriod({ periodNo, label: String(item.label), startTime: String(item.start_time), endTime: String(item.end_time), sessionType: String(item.session_type) });
    }
    catch (caught) { error = caught instanceof Error ? caught.message : '格式不合法'; }
    const existing = !error ? conn.prepare(
      `SELECT id FROM timetable_entries WHERE class_id=? AND term_id=? AND weekday=? AND period_no=? AND week_pattern=? AND week_start=? AND week_end=?`,
    ).get(classId, termId, weekday, periodNo, item.week_pattern, item.week_start, item.week_end) as { id: number } | undefined : undefined;
    const output = { row: index + 1, valid: !error, action: error ? '跳过' : existing ? '更新' : '新增', error, ...item };
    if (!error) validCount += 1;
    resultRows.push(output);
  }
  return { ok: true, filename, header_row: headerRow + 1, rows: resultRows, summary: { total: resultRows.length, valid: validCount, invalid: resultRows.length - validCount } };
}

export function commitImport(rows: Array<Record<string, unknown>>, filename = '', requestId = ''): Record<string, unknown> {
  const conn = getDb().connInstance;
  const [classId, termId] = scope({ write: true, conn });
  const existingRun = requestId ? conn.prepare('SELECT * FROM timetable_import_runs WHERE class_id=? AND term_id=? AND request_id=?')
    .get(classId, termId, requestId) as Record<string, unknown> | undefined : undefined;
  if (existingRun) return { ok: true, duplicate: true, ...existingRun };
  let importedPeriods = 0; let importedEntries = 0; let updatedEntries = 0; let skipped = 0; let errors = 0;
  conn.transaction(() => {
    for (const row of rows) {
      if (row.valid !== true) { skipped += 1; continue; }
      try {
        const periodNo = integer(row.period_no);
        const period = validatePeriod({ periodNo, label: text(row.label), startTime: text(row.start_time), endTime: text(row.end_time), sessionType: text(row.session_type) || '普通课' });
        const periodExists = conn.prepare('SELECT id FROM timetable_periods WHERE class_id=? AND term_id=? AND period_no=?').get(classId, termId, periodNo);
        conn.prepare(
          `INSERT INTO timetable_periods(class_id, term_id, period_no, label, start_time, end_time, session_type)
           VALUES(?,?,?,?,?,?,?) ON CONFLICT(class_id, term_id, period_no) DO UPDATE SET label=excluded.label, start_time=excluded.start_time, end_time=excluded.end_time, session_type=excluded.session_type, enabled=1, updated_at=datetime('now','localtime')`,
        ).run(classId, termId, periodNo, period.label, period.start_time, period.end_time, period.session_type);
        if (!periodExists) importedPeriods += 1;
        const item = validateEntry({ weekday: Number(row.weekday), periodNo, subject: text(row.subject), teacherName: text(row.teacher_name), room: text(row.room), sessionType: text(row.session_type) || '普通课', weekPattern: text(row.week_pattern) || '全周', weekStart: integer(row.week_start, 1), weekEnd: integer(row.week_end, 99), note: text(row.note) });
        const existing = conn.prepare('SELECT id FROM timetable_entries WHERE class_id=? AND term_id=? AND weekday=? AND period_no=? AND week_pattern=? AND week_start=? AND week_end=?')
          .get(classId, termId, item.weekday, item.period_no, item.week_pattern, item.week_start, item.week_end) as { id: number } | undefined;
        conn.prepare(
          `INSERT INTO timetable_entries(class_id, term_id, weekday, period_no, subject, teacher_name, room, session_type, week_pattern, week_start, week_end, note)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(class_id, term_id, weekday, period_no, week_pattern, week_start, week_end) DO UPDATE SET subject=excluded.subject, teacher_name=excluded.teacher_name, room=excluded.room, session_type=excluded.session_type, note=excluded.note, status='启用', updated_at=datetime('now','localtime')`,
        ).run(classId, termId, item.weekday, item.period_no, item.subject, item.teacher_name, item.room, item.session_type, item.week_pattern, item.week_start, item.week_end, item.note);
        if (existing) updatedEntries += 1; else importedEntries += 1;
      } catch { errors += 1; }
    }
    conn.prepare(
      `INSERT INTO timetable_import_runs(class_id, term_id, request_id, filename, imported_periods, imported_entries, updated_entries, skipped, error_count)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(classId, termId, requestId, filename, importedPeriods, importedEntries, updatedEntries, skipped, errors);
  })();
  audit.record('timetable_import', requestId || filename, 'commit', {
    summary: '导入课程表', params: { filename, importedPeriods, importedEntries, updatedEntries, skipped, errors }, classId, termId, conn,
  });
  return { ok: true, filename, imported_periods: importedPeriods, imported: importedEntries, updated: updatedEntries, skipped, error_count: errors };
}

export function templateRows(): unknown[][] {
  return [
    ['星期', '节次', '节次名称', '开始时间', '结束时间', '科目', '任课教师', '教室', '时段类型', '单双周', '开始周', '结束周', '备注'],
    ['周一', 1, '第1节', '08:00', '08:45', '语文', '', '', '普通课', '全周', 1, 99, ''],
  ];
}
