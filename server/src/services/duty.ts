import type { Database } from 'better-sqlite3';

import { getDb, scopeIds, ensureStudentInScope } from './context.js';
import * as audit from './audit.js';
import { todayString } from './clock.js';
import { ensureSourceWorkItem, updateWorkItem, sourceTransitionHooks } from './workItems.js';

export const ASSIGNMENT_STATUSES = new Set(['待完成', '已完成']);

export class DutyError extends Error {}

export class DutyConflictError extends DutyError {
  readonly conflicts: Array<Record<string, unknown>>;

  constructor(conflicts: Array<Record<string, unknown>>) {
    super(`发现 ${conflicts.length} 项值日冲突，请调整后再生成`);
    this.conflicts = conflicts;
  }
}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function nowString(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function scope(options: { write?: boolean; conn?: Database } = {}): [number, number] {
  return scopeIds({ write: options.write, conn: options.conn });
}

function parseDate(value: string, label = '日期'): Date {
  const raw = text(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) throw new DutyError(`${label}格式不正确，应为 YYYY-MM-DD`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new DutyError(`${label}格式不正确，应为 YYYY-MM-DD`);
  }
  return date;
}

function toIso(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

function weekdayOf(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

function assignmentRow(assignmentId: number, options: { write?: boolean; conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: options.write, conn });
  const row = conn.prepare(
    "SELECT * FROM duty_assignments WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(Number(assignmentId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new DutyError('值日安排不存在');
  return row;
}

function decorate(row: Record<string, unknown>): Record<string, unknown> {
  const result = { ...row };
  result.is_overdue = String(result.status) === '待完成'
    && String(result.duty_date) < todayString();
  return result;
}

export function listAssignments(options: {
  dutyDate?: string; dateFrom?: string; dateTo?: string; sourceId?: number | null; conn?: Database;
} = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const where = ["d.class_id=?", "d.term_id=?", "d.deleted_at=''", "s.deleted_at=''"];
  const params: unknown[] = [classId, termId];
  if (options.sourceId) {
    where.push('d.id=?');
    params.push(Number(options.sourceId));
  }
  if (options.dutyDate) {
    where.push('d.duty_date=?');
    params.push(toIso(parseDate(options.dutyDate)));
  } else {
    if (options.dateFrom) {
      where.push('d.duty_date>=?');
      params.push(toIso(parseDate(options.dateFrom, '开始日期')));
    }
    if (options.dateTo) {
      where.push('d.duty_date<=?');
      params.push(toIso(parseDate(options.dateTo, '结束日期')));
    }
  }
  const rows = conn.prepare(
    `SELECT d.*, s.学号, s.姓名, r.name AS rotation_rule_name
     FROM duty_assignments d
     JOIN students s ON s.id=d.student_id
     LEFT JOIN duty_rotation_rules r ON r.id=d.rotation_rule_id
     WHERE ` + where.join(' AND ')
    + ' ORDER BY d.duty_date, d.area, s.学号',
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => decorate(row));
}

export function getAssignment(assignmentId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  const rows = listAssignments({ sourceId: assignmentId, conn: options.conn });
  if (rows.length === 0) throw new DutyError('值日安排不存在');
  return rows[0];
}

function studentIds(values: Array<number | string>, conn: Database): number[] {
  const ids = values.map((item) => Number(item));
  if (ids.length === 0) throw new DutyError('轮换规则至少需要一名学生');
  if (new Set(ids).size !== ids.length) throw new DutyError('轮换学生不能重复');
  for (const studentId of ids) ensureStudentInScope(studentId, { write: true, conn });
  return ids;
}

function conflictsForAssignment(options: {
  dutyDate: string; area: string; studentId: number; conn?: Database;
}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  return conn.prepare(
    `SELECT d.id, d.duty_date, d.area, d.student_id, s.姓名
     FROM duty_assignments d JOIN students s ON s.id=d.student_id
     WHERE d.class_id=? AND d.term_id=? AND d.duty_date=?
       AND d.student_id=? AND d.deleted_at='' AND d.area<>?`,
  ).all(classId, termId, options.dutyDate, Number(options.studentId), text(options.area)) as Array<Record<string, unknown>>;
}

function syncWorkItem(before: Record<string, unknown>, values: Record<string, unknown>, conn: Database): void {
  if (!before) return;
  const linked = conn.prepare(
    `SELECT * FROM student_tasks
     WHERE class_id=? AND term_id=? AND source_type='duty_assignment' AND source_id=?
       AND deleted_at='' ORDER BY id LIMIT 1`,
  ).get(before.class_id, before.term_id, before.id) as Record<string, unknown> | undefined;
  if (!linked) return;
  const nextStatus = values.status === '已完成' ? '已完成' : '待处理';
  updateWorkItem(Number(linked.id), {
    title: `值日 · ${before.area}`, scheduledAt: String(values.duty_date), dueAt: String(values.duty_date),
    status: nextStatus, notes: String(values.note), result: String(values.completion_result),
    conn, syncSource: false,
  });
}

export function createAssignment(options: {
  dutyDate: string; area: string; studentId: number; status?: string; note?: string;
  rotationRuleId?: number | null; rotationIndex?: number | null; completionResult?: string;
  conn?: Database; commit?: boolean;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const dutyDate = toIso(parseDate(options.dutyDate));
  const area = text(options.area);
  if (!area) throw new DutyError('值日区域不能为空');
  const status = options.status ?? '待完成';
  if (!ASSIGNMENT_STATUSES.has(status)) throw new DutyError('值日状态不合法');
  if (status === '已完成' && !text(options.completionResult)) {
    throw new DutyError('完成值日时必须填写完成记录');
  }
  const [classId, termId] = scope({ write: true, conn });
  ensureStudentInScope(Number(options.studentId), { write: true, conn });
  const conflicts = conflictsForAssignment({
    dutyDate, area, studentId: Number(options.studentId), conn,
  });
  if (conflicts.length > 0) throw new DutyConflictError(conflicts);
  const existing = conn.prepare(
    `SELECT * FROM duty_assignments
     WHERE class_id=? AND term_id=? AND duty_date=? AND area=? AND student_id=?
       AND deleted_at=''`,
  ).get(classId, termId, dutyDate, area, Number(options.studentId)) as Record<string, unknown> | undefined;
  const values: Record<string, unknown> = {
    duty_date: dutyDate, area, student_id: Number(options.studentId),
    status, note: text(options.note),
    completed_at: status === '已完成' ? nowString() : '',
    completion_result: status === '已完成' ? text(options.completionResult) : '',
  };
  const rowId = conn.transaction(() => {
    conn.prepare(
      `INSERT INTO duty_assignments(
         duty_date, area, student_id, class_id, term_id, status, note,
         rotation_rule_id, rotation_index, completed_at, completion_result
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(class_id, term_id, duty_date, area, student_id)
       DO UPDATE SET status=excluded.status, note=excluded.note,
         rotation_rule_id=excluded.rotation_rule_id,
         rotation_index=excluded.rotation_index,
         completed_at=excluded.completed_at,
         completion_result=excluded.completion_result,
         updated_at=datetime('now','localtime')`,
    ).run(
      dutyDate, area, Number(options.studentId), classId, termId, status, values.note,
      options.rotationRuleId ?? null, options.rotationIndex ?? null,
      values.completed_at, values.completion_result,
    );
    const row = conn.prepare(
      `SELECT * FROM duty_assignments
       WHERE class_id=? AND term_id=? AND duty_date=? AND area=? AND student_id=?
         AND deleted_at=''`,
    ).get(classId, termId, dutyDate, area, Number(options.studentId)) as { id: number };
    if (existing) {
      syncWorkItem(existing, values, conn);
    } else if (status !== '已完成') {
      ensureSourceWorkItem({
        title: `值日 · ${area}`, studentId: Number(options.studentId),
        sourceType: 'duty_assignment', sourceId: Number(row.id),
        scheduledAt: dutyDate, dueAt: dutyDate, status: '待处理',
        notes: String(values.note), conn,
      });
    }
    audit.record('duty_assignment', row.id, existing ? 'update' : 'create', {
      summary: `保存值日安排：${area}`,
      params: { duty_date: dutyDate, student_id: options.studentId, status },
      classId, termId, conn,
    });
    return Number(row.id);
  })();
  void options.commit;
  return getAssignment(rowId, { conn });
}

export function updateAssignment(assignmentId: number, options: {
  status: string; note?: string; completionResult?: string; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const current = assignmentRow(assignmentId, { write: true, conn });
  if (!ASSIGNMENT_STATUSES.has(options.status)) throw new DutyError('值日状态不合法');
  const completionResult = text(options.completionResult)
    || (options.status === '已完成' ? text(current.completion_result) : '');
  if (options.status === '已完成' && !completionResult) {
    throw new DutyError('完成值日时必须填写完成记录');
  }
  const values: Record<string, unknown> = {
    duty_date: current.duty_date, status: options.status, note: text(options.note),
    completion_result: completionResult,
  };
  const [classId, termId] = scope({ write: true, conn });
  conn.transaction(() => {
    conn.prepare(
      `UPDATE duty_assignments SET status=?, note=?, completed_at=?,
         completion_result=?, updated_at=datetime('now','localtime')
       WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''`,
    ).run(
      options.status, values.note, options.status === '已完成' ? nowString() : '',
      completionResult, Number(assignmentId), classId, termId,
    );
    syncWorkItem(current, values, conn);
    audit.record('duty_assignment', assignmentId, 'update', {
      summary: `更新值日状态：${options.status}`,
      params: { status: options.status, completion_result: completionResult },
      classId, termId, conn,
    });
  })();
  return getAssignment(assignmentId, { conn });
}

export function listRotationRules(options: { includeDisabled?: boolean; conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const where = ["r.class_id=?", "r.term_id=?", "r.deleted_at=''"];
  const params: unknown[] = [classId, termId];
  if (!options.includeDisabled) where.push('r.enabled=1');
  const result: Array<Record<string, unknown>> = [];
  for (const row of conn.prepare(
    'SELECT r.* FROM duty_rotation_rules r WHERE ' + where.join(' AND ')
    + ' ORDER BY r.enabled DESC, r.area, r.id',
  ).all(...params) as Array<Record<string, unknown>>) {
    const item = { ...row };
    item.members = conn.prepare(
      `SELECT m.*, s.学号, s.姓名 FROM duty_rotation_members m
       JOIN students s ON s.id=m.student_id WHERE m.rule_id=? AND m.enabled=1
       ORDER BY m.position`,
    ).all(Number(item.id)) as Array<Record<string, unknown>>;
    result.push(item);
  }
  return result;
}

export function createRotationRule(options: {
  name: string; area: string; startDate: string; endDate?: string;
  weekdayMask?: number; studentIds: Array<number | string>; enabled?: boolean; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const name = text(options.name);
  const area = text(options.area);
  const start = toIso(parseDate(options.startDate, '开始日期'));
  const end = text(options.endDate) ? toIso(parseDate(options.endDate ?? '', '结束日期')) : '';
  if (end && end < start) throw new DutyError('结束日期不能早于开始日期');
  const mask = Number(options.weekdayMask ?? 31);
  if (mask < 1 || mask > 127) throw new DutyError('值日星期范围不合法');
  if (!name || !area) throw new DutyError('轮换规则名称和区域不能为空');
  const [classId, termId] = scope({ write: true, conn });
  const members = studentIds(options.studentIds, conn);
  const ruleId = conn.transaction(() => {
    const inserted = conn.prepare(
      `INSERT INTO duty_rotation_rules(
         class_id, term_id, name, area, start_date, end_date, weekday_mask, enabled
       ) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(classId, termId, name, area, start, end, mask, options.enabled === false ? 0 : 1);
    const createdId = Number(inserted.lastInsertRowid);
    const stmt = conn.prepare(
      'INSERT INTO duty_rotation_members(rule_id, student_id, position) VALUES(?,?,?)',
    );
    members.forEach((studentId, position) => stmt.run(createdId, studentId, position));
    audit.record('duty_rotation_rule', createdId, 'create', {
      summary: `新增值日轮换规则：${name}`,
      params: { area, student_count: members.length },
      classId, termId, conn,
    });
    return createdId;
  })();
  return listRotationRules({ includeDisabled: true, conn })
    .find((ruleRow) => ruleRow.id === ruleId) as Record<string, unknown>;
}

function rule(ruleId: number, options: { write?: boolean; conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: options.write, conn });
  const row = conn.prepare(
    "SELECT * FROM duty_rotation_rules WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(Number(ruleId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new DutyError('值日轮换规则不存在');
  const item = { ...row };
  item.members = conn.prepare(
    'SELECT * FROM duty_rotation_members WHERE rule_id=? AND enabled=1 ORDER BY position',
  ).all(Number(ruleId)) as Array<Record<string, unknown>>;
  if ((item.members as Array<unknown>).length === 0) {
    throw new DutyError('值日轮换规则没有可用学生');
  }
  return item;
}

export function previewRotation(ruleId: number, options: {
  dateFrom?: string; dateTo?: string; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const ruleRow = rule(ruleId, { conn });
  const start = parseDate(options.dateFrom || String(ruleRow.start_date), '开始日期');
  const end = parseDate(options.dateTo || String(ruleRow.end_date) || toIso(addDays(start, 30)), '结束日期');
  if (end.getTime() < start.getTime()) throw new DutyError('结束日期不能早于开始日期');
  const ruleStart = parseDate(String(ruleRow.start_date));
  const members = ruleRow.members as Array<Record<string, unknown>>;
  const mask = Number(ruleRow.weekday_mask);
  const proposals: Array<Record<string, unknown>> = [];
  let cursor = start;
  while (cursor.getTime() <= end.getTime()) {
    const bit = 1 << weekdayOf(cursor);
    if (cursor.getTime() >= ruleStart.getTime() && (mask & bit)) {
      const occurrence = Math.round((cursor.getTime() - ruleStart.getTime()) / 86400000);
      let eligibleDays = 0;
      for (let offset = 0; offset <= occurrence; offset += 1) {
        if (mask & (1 << weekdayOf(addDays(ruleStart, offset)))) eligibleDays += 1;
      }
      eligibleDays -= 1;
      const member = members[eligibleDays % members.length];
      const existingSameArea = conn.prepare(
        `SELECT d.id, d.student_id, s.姓名 FROM duty_assignments d
         JOIN students s ON s.id=d.student_id
         WHERE d.class_id=? AND d.term_id=? AND d.duty_date=? AND d.area=?
           AND d.deleted_at=''`,
      ).all(ruleRow.class_id, ruleRow.term_id, toIso(cursor), ruleRow.area) as Array<Record<string, unknown>>;
      const conflicts = conflictsForAssignment({
        dutyDate: toIso(cursor), area: String(ruleRow.area), studentId: Number(member.student_id), conn,
      });
      for (const existing of existingSameArea) {
        if (Number(existing.student_id) !== Number(member.student_id)) {
          conflicts.push({ ...existing, reason: '同一区域已有其他学生' });
        }
      }
      proposals.push({
        duty_date: toIso(cursor), area: ruleRow.area,
        student_id: member.student_id, 姓名: member.姓名 ?? '',
        rotation_index: eligibleDays, conflicts,
        existing: existingSameArea.map((existing) => ({ ...existing })),
      });
    }
    cursor = addDays(cursor, 1);
  }
  const conflicts = proposals.filter((item) =>
    (item.conflicts as Array<unknown>).length > 0);
  return { rule: ruleRow, proposals, conflicts, can_generate: conflicts.length === 0 && proposals.length > 0 };
}

export function generateRotation(ruleId: number, options: {
  dateFrom?: string; dateTo?: string; confirm?: boolean; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const preview = previewRotation(ruleId, { dateFrom: options.dateFrom, dateTo: options.dateTo, conn });
  if ((preview.conflicts as Array<unknown>).length > 0) {
    throw new DutyConflictError(preview.conflicts as Array<Record<string, unknown>>);
  }
  if (!options.confirm) {
    return { preview: true, ...preview };
  }
  const ruleRow = preview.rule as Record<string, unknown>;
  let created = 0;
  conn.transaction(() => {
    for (const item of preview.proposals as Array<Record<string, unknown>>) {
      const existing = conn.prepare(
        `SELECT * FROM duty_assignments
         WHERE class_id=? AND term_id=? AND duty_date=? AND area=? AND student_id=?
           AND deleted_at=''`,
      ).get(
        ruleRow.class_id, ruleRow.term_id, item.duty_date,
        item.area, item.student_id,
      ) as Record<string, unknown> | undefined;
      createAssignment({
        dutyDate: String(item.duty_date), area: String(item.area), studentId: Number(item.student_id),
        rotationRuleId: ruleId, rotationIndex: Number(item.rotation_index), conn,
      });
      if (!existing) created += 1;
    }
    audit.record('duty_rotation_rule', ruleId, 'generate', {
      summary: `生成值日安排 ${created} 项`,
      params: { date_from: options.dateFrom ?? '', date_to: options.dateTo ?? '', created },
      conn,
    });
  })();
  return { preview: false, created, ...preview };
}

export function onWorkItemTransition(
  conn: Database, before: Record<string, unknown>, nextStatus: string, result: string,
): void {
  const assignmentId = before.source_id;
  if (String(before.source_type ?? '') !== 'duty_assignment' || !assignmentId) return;
  const assignment = conn.prepare(
    "SELECT * FROM duty_assignments WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(assignmentId, before.class_id, before.term_id) as Record<string, unknown> | undefined;
  if (!assignment) return;
  const status = nextStatus === '已完成' ? '已完成' : '待完成';
  conn.prepare(
    `UPDATE duty_assignments SET status=?, completed_at=?, completion_result=?,
       updated_at=datetime('now','localtime') WHERE id=?`,
  ).run(status, status === '已完成' ? nowString() : '', text(result), assignmentId);
}

sourceTransitionHooks['duty_assignment'] = onWorkItemTransition;
