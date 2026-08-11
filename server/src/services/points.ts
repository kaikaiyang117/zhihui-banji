/* MIG-08 行为积分：流水、规则、周期命中与旧快照迁移。
 * 提供流水、规则、周期命中与旧快照迁移能力。
 */
import type { Database } from 'better-sqlite3';

import {
  ArchivedScopeError, bindRequestScope, ensureStudentInScope,
  getCurrentScope, getDb, resetRequestScope, ScopeError, scopeIds,
} from './context.js';
import * as audit from './audit.js';
import { todayString } from './clock.js';
import {
  ensureSourceWorkItem, sourceTransitionHooks, updateWorkItem, WorkItemError,
} from './workItems.js';
import { formatG, nowText, pyRound } from './scores.js';
import { getRows } from './sheets.js';

export const POINT_STATUSES = new Set(['有效', '已撤销']);
export const RULE_METRICS = new Set(['周期扣分', '周期总分低于']);
export const PRIORITIES = new Set(['普通', '重要', '紧急']);
export const HIT_STATUSES = new Set(['新命中', '已处理', '已解除']);

export class PointError extends Error {}

function text(value: unknown): string {
  return String(value || '').trim();
}

function numberValue(value: unknown, allowZero = true): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  const result = Number(raw);
  if (!Number.isFinite(result)) return null;
  if (!allowZero && result === 0) return null;
  return result;
}

function amountOf(value: unknown): number | null {
  const number = numberValue(value);
  if (number === null) return null;
  if (Number.isInteger(number)) {
    const integer = Math.trunc(number);
    return integer === 0 ? 0 : integer;
  }
  return pyRound(number, 2);
}

function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function parseDate(value: unknown, label = '日期', defaultToday = false): string {
  const candidate = String((value ?? '') || '').slice(0, 10) || (defaultToday ? todayString() : '');
  if (!parseIsoDate(candidate)) throw new PointError(`${label}格式不正确，应为 YYYY-MM-DD`);
  return candidate;
}

function shiftDate(dateText: string, deltaDays: number): string {
  const d = new Date(`${dateText}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function isoWeekKey(parsed: { year: number; month: number; day: number }): string {
  const d = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function academicYearLabel(reference = ''): string {
  const current = reference || todayString();
  const year = Number(current.slice(0, 4));
  const month = Number(current.slice(5, 7));
  const startYear = month >= 9 ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

export function academicYearRange(value = '', reference = ''): [string, string, string] {
  const label = text(value) || academicYearLabel(reference);
  const parts = label.split('-');
  const startYear = Number(parts[0]);
  const endYear = Number(parts[1]);
  if (parts.length !== 2 || !Number.isInteger(startYear) || !Number.isInteger(endYear)
    || endYear !== startYear + 1) {
    throw new PointError('学年格式不正确，应为 YYYY-YYYY');
  }
  return [label, `${startYear}-09-01`, `${endYear}-08-31`];
}

function periodKey(occurredAt: string): string {
  const parsed = parseIsoDate(parseDate(occurredAt));
  return isoWeekKey(parsed!);
}

function academicYears(classId: number, conn: Database): string[] {
  const years = new Set([academicYearLabel()]);
  const rows = conn.prepare(
    "SELECT occurred_at FROM point_ledger WHERE class_id=? AND occurred_at<>''",
  ).all(classId) as Array<{ occurred_at: string }>;
  for (const row of rows) {
    const candidate = String(row.occurred_at ?? '').slice(0, 10);
    if (parseIsoDate(candidate)) years.add(academicYearLabel(candidate));
  }
  return [...years].sort().reverse();
}

function serialize(row: Record<string, unknown>): Record<string, unknown> {
  const item = { ...row };
  item.amount = amountOf(item.amount);
  item.student_name = (item.student_name || item['姓名'] || '') as string;
  item.rule_name = (item.rule_name || '') as string;
  item.source_label = item.source_type === 'legacy_sheet' ? '旧版积分快照' : '手工记录';
  return item;
}

function activeStudents(conn: Database): Array<Record<string, unknown>> {
  const [classId, termId] = scopeIds({ conn });
  return conn.prepare(
    `SELECT s.id, s.学号, s.姓名 FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
     ORDER BY s.学号, s.id`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
}

function ensureStudent(studentId: number, options: { write?: boolean; conn?: Database } = {}): void {
  try {
    ensureStudentInScope(studentId, { write: options.write, conn: options.conn ?? getDb().connInstance });
  } catch (error) {
    if (error instanceof ArchivedScopeError) throw error;
    if (error instanceof ScopeError) throw new PointError(error.message);
    throw error;
  }
}

export function migrateLegacyRows(options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  const existing = conn.prepare(
    `SELECT * FROM point_migration_runs
     WHERE class_id=? AND term_id=? AND source_sheet=? AND source_version=?`,
  ).get(classId, termId, '日常行为积分', 'v1') as Record<string, unknown> | undefined;
  if (existing) {
    const result = { ...existing };
    result.report = JSON.parse(String(result.report ?? '{}') || '{}');
    return result;
  }
  const rows = getRows('日常行为积分');
  const studentRows = conn.prepare(
    `SELECT s.id, s.学号 FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const students = new Map<string, number>();
  for (const row of studentRows) {
    const xh = text(row['学号']);
    if (xh) students.set(xh, Number(row.id));
  }
  let imported = 0;
  let skipped = 0;
  const skippedReasons: Record<string, number> = {};
  const insertStmt = conn.prepare(
    `INSERT OR IGNORE INTO point_ledger(
       class_id, term_id, student_id, occurred_at, period_key,
       amount, category, reason, source_type, source_id, source_key
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let runId = 0;
  conn.transaction(() => {
    for (const row of rows) {
      const xh = text(row.data.length > 0 ? row.data[0] : '');
      const studentId = students.get(xh);
      if (!studentId) {
        skipped += 1;
        skippedReasons['学号不在当前班级'] = (skippedReasons['学号不在当前班级'] ?? 0) + 1;
        continue;
      }
      for (let week = 0; week < 8; week += 1) {
        const amount = amountOf(row.data.length > week + 2 ? row.data[week + 2] : null);
        if (amount === null || amount === 0) continue;
        const sourceKey = `legacy-sheet:${row.row_no}:w${week + 1}`;
        const inserted = insertStmt.run(classId, termId, studentId, '', `legacy-W${week + 1}`,
          amount, '历史积分', `旧版日常行为积分第${week + 1}周`, 'legacy_sheet',
          String(row.row_no), sourceKey);
        imported += Number(inserted.changes ?? 0);
      }
    }
    const report = {
      source_rows: rows.length, imported_entries: imported,
      skipped_entries: skipped, skipped_reasons: skippedReasons,
      legacy_sheet_retained: true,
    };
    const runInserted = conn.prepare(
      `INSERT INTO point_migration_runs(
         class_id, term_id, source_sheet, source_version,
         source_rows, imported_entries, skipped_entries, report
       ) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(classId, termId, '日常行为积分', 'v1', rows.length, imported, skipped,
      JSON.stringify(report));
    runId = Number(runInserted.lastInsertRowid);
    audit.record('point_migration', runId, 'migrate', {
      summary: '迁移旧版行为积分快照',
      params: report, classId, termId, conn,
    });
  })();
  const result = conn.prepare(
    'SELECT * FROM point_migration_runs WHERE id=?',
  ).get(runId) as Record<string, unknown>;
  result.report = {
    source_rows: rows.length, imported_entries: imported,
    skipped_entries: skipped, skipped_reasons: skippedReasons,
    legacy_sheet_retained: true,
  };
  return result;
}

export function ensureLegacyMigrated(options: { conn?: Database } = {}): Record<string, unknown> | null {
  const conn = options.conn ?? getDb().connInstance;
  const scope = getCurrentScope({ conn });
  if (scope.class_status === '已归档' || scope.term_status === '已归档') {
    const row = conn.prepare(
      `SELECT * FROM point_migration_runs WHERE class_id=? AND term_id=?
       AND source_sheet=? AND source_version=?`,
    ).get(Number(scope.class_id), Number(scope.term_id), '日常行为积分', 'v1') as
      Record<string, unknown> | undefined;
    return row ? { ...row } : null;
  }
  return migrateLegacyRows({ conn });
}

export function migrationReport(options: { conn?: Database } = {}): Record<string, unknown> | null {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    `SELECT * FROM point_migration_runs WHERE class_id=? AND term_id=?
     AND source_sheet=? AND source_version=?`,
  ).get(classId, termId, '日常行为积分', 'v1') as Record<string, unknown> | undefined;
  if (!row) return null;
  const item = { ...row };
  item.report = JSON.parse(String(item.report ?? '{}') || '{}');
  return item;
}

export function createEntry(options: {
  studentId: number; amount: unknown; occurredAt?: string; category?: string; reason?: string;
  ruleId?: number | null; sourceType?: string; sourceId?: string; sourceKey?: string;
  createdBy?: string; conn?: Database;
}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const entryId = conn.transaction((): number => {
    const [classId, termId] = scopeIds({ write: true, conn });
    const amount = amountOf(options.amount);
    if (amount === null || amount === 0) throw new PointError('积分分值必须是非零数字');
    const occurredAt = parseDate(options.occurredAt ?? '', '日期', true);
    const category = text(options.category) || '日常行为';
    const reason = text(options.reason);
    if (!reason) throw new PointError('积分原因不能为空');
    ensureStudent(Number(options.studentId), { write: true, conn });
    if (options.ruleId !== undefined && options.ruleId !== null) {
      ruleRow(Number(options.ruleId), { conn });
    }
    const period = periodKey(occurredAt);
    const inserted = conn.prepare(
      `INSERT INTO point_ledger(
         class_id, term_id, student_id, rule_id, occurred_at, period_key,
         amount, category, reason, source_type, source_id, source_key, created_by
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ).get(classId, termId, Number(options.studentId), options.ruleId ?? null, occurredAt, period,
      amount, category, reason, text(options.sourceType) || 'manual', text(options.sourceId),
      text(options.sourceKey), text(options.createdBy) || '班主任') as { id: number };
    const id = Number(inserted.id);
    audit.record('point_ledger', id, 'create', {
      summary: `新增行为积分：${formatG(amount)}`,
      params: { student_id: options.studentId, amount, category, reason, occurred_at: occurredAt },
      classId, termId, conn,
    });
    return id;
  })();
  return getEntry(entryId, { conn });
}

export function getEntry(entryId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    `SELECT p.*, s.学号, s.姓名, r.name AS rule_name
     FROM point_ledger p JOIN students s ON s.id=p.student_id
     LEFT JOIN point_rules r ON r.id=p.rule_id
     WHERE p.id=? AND p.class_id=? AND p.term_id=? AND s.deleted_at=''`,
  ).get(Number(entryId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new PointError('积分流水不存在');
  return serialize(row);
}

export function listEntries(options: {
  studentId?: number | null; dateFrom?: string; dateTo?: string; status?: string;
  academicYear?: string; includeLegacy?: boolean; limit?: number; conn?: Database;
} = {}): Array<Record<string, unknown>> {
  const conn = options.conn ?? getDb().connInstance;
  ensureLegacyMigrated({ conn });
  const scope = getCurrentScope({ conn });
  const classId = Number(scope.class_id);
  const termId = Number(scope.term_id);
  const includeLegacy = options.includeLegacy !== false;
  const where = ["p.class_id=?", "p.status IN ('有效','已撤销')", "s.deleted_at=''"];
  const params: unknown[] = [classId];
  const academicYear = text(options.academicYear);
  if (academicYear) {
    const [, periodStart, periodEnd] = academicYearRange(academicYear);
    where.push('p.occurred_at>=?', 'p.occurred_at<=?');
    params.push(periodStart, periodEnd);
  } else {
    where.push('p.term_id=?');
    params.push(termId);
  }
  if (options.studentId !== undefined && options.studentId !== null) {
    ensureStudent(Number(options.studentId), { conn });
    where.push('p.student_id=?');
    params.push(Number(options.studentId));
  }
  if (options.dateFrom) {
    where.push(includeLegacy ? "(p.occurred_at='' OR p.occurred_at>=?)" : 'p.occurred_at>=?');
    params.push(parseDate(options.dateFrom, '开始日期'));
  }
  if (options.dateTo) {
    where.push(includeLegacy ? "(p.occurred_at='' OR p.occurred_at<=?)" : 'p.occurred_at<=?');
    params.push(parseDate(options.dateTo, '结束日期'));
  }
  if (options.status) {
    if (!POINT_STATUSES.has(options.status)) throw new PointError('积分流水状态不合法');
    where.push('p.status=?');
    params.push(options.status);
  }
  if (!includeLegacy) {
    where.push("p.source_type<>'legacy_sheet'");
  }
  const limit = Math.max(1, Math.min(Number(options.limit ?? 500), 5_000));
  const rows = conn.prepare(
    `SELECT p.*, s.学号, s.姓名, r.name AS rule_name,
            t.name AS term_name, t.status AS term_status
     FROM point_ledger p JOIN students s ON s.id=p.student_id
     JOIN terms t ON t.id=p.term_id
     LEFT JOIN point_rules r ON r.id=p.rule_id
     WHERE ` + where.join(' AND ') +
    ` ORDER BY CASE WHEN p.occurred_at='' THEN 0 ELSE 1 END, p.occurred_at DESC, p.id DESC LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;
  const result: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const item = serialize(row);
    item.can_revoke = (
      Number(item.term_id ?? 0) === termId
      && scope.term_status !== '已归档'
      && scope.class_status !== '已归档'
    );
    result.push(item);
  }
  return result;
}

export function revokeEntry(entryId: number, reason: string, options: { conn?: Database } = {}):
  Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const current = getEntry(entryId, { conn });
  const cleanReason = text(reason);
  if (!cleanReason) throw new PointError('撤销积分必须填写原因');
  if (String(current.status) === '已撤销') return current;
  conn.transaction(() => {
    const [classId, termId] = scopeIds({ write: true, conn });
    conn.prepare(
      `UPDATE point_ledger SET status='已撤销', reversed_at=?, reversal_reason=?,
             updated_at=datetime('now','localtime')
       WHERE id=? AND class_id=? AND term_id=? AND status='有效'`,
    ).run(nowText(), cleanReason, Number(entryId), classId, termId);
    audit.record('point_ledger', entryId, 'revoke', {
      summary: '撤销行为积分',
      params: { reason: cleanReason }, classId, termId, conn,
    });
  })();
  return getEntry(entryId, { conn });
}

function ruleRow(ruleId: number, options: { write?: boolean; conn?: Database } = {}):
  Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: options.write, conn });
  const row = conn.prepare(
    "SELECT * FROM point_rules WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(Number(ruleId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new PointError('积分规则不存在');
  return row;
}

export function listRules(options: { includeDisabled?: boolean; conn?: Database } = {}):
  Array<Record<string, unknown>> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const where = ['class_id=?', 'term_id=?', "deleted_at=''"];
  const params: unknown[] = [classId, termId];
  if (!options.includeDisabled) where.push('enabled=1');
  return conn.prepare(
    'SELECT * FROM point_rules WHERE ' + where.join(' AND ')
    + ' ORDER BY enabled DESC, name, id',
  ).all(...params) as Array<Record<string, unknown>>;
}

export function createRule(options: {
  name?: unknown; category?: string; metric?: string; threshold?: unknown;
  periodDays?: unknown; priority?: string; enabled?: boolean; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const name = text(options.name);
  if (!name) throw new PointError('规则名称不能为空');
  const metric = options.metric ?? '周期扣分';
  if (!RULE_METRICS.has(metric)) throw new PointError('积分规则指标不合法');
  const threshold = numberValue(options.threshold ?? 5, false);
  if (threshold === null || threshold <= 0) throw new PointError('阈值必须是正数');
  const periodDays = Number(options.periodDays ?? 7);
  if (!Number.isFinite(periodDays) || Math.trunc(periodDays) < 1 || Math.trunc(periodDays) > 365) {
    throw new PointError('规则周期必须在 1 到 365 天之间');
  }
  const priority = options.priority ?? '重要';
  if (!PRIORITIES.has(priority)) throw new PointError('优先级不合法');
  const [classId, termId] = scopeIds({ write: true, conn });
  const ruleId = conn.transaction((): number => {
    const inserted = conn.prepare(
      `INSERT INTO point_rules(
         class_id, term_id, name, category, metric, threshold, period_days, priority, enabled
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(classId, termId, name, text(options.category) || '日常行为', metric, threshold,
      Math.trunc(periodDays), priority, (options.enabled ?? true) ? 1 : 0);
    const id = Number(inserted.lastInsertRowid);
    audit.record('point_rule', id, 'create', {
      summary: `新增积分规则：${name}`,
      params: { metric, threshold, period_days: periodDays },
      classId, termId, conn,
    });
    return id;
  })();
  return ruleRow(ruleId, { conn });
}

export function updateRule(ruleId: number, options: {
  enabled?: boolean | null; threshold?: unknown; periodDays?: number | null;
  priority?: string | null; category?: string | null; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const current = ruleRow(ruleId, { write: true, conn });
  const values: Record<string, unknown> = {
    enabled: options.enabled !== undefined && options.enabled !== null
      ? (options.enabled ? 1 : 0) : current.enabled,
    threshold: options.threshold !== undefined && options.threshold !== null
      ? numberValue(options.threshold, false) : current.threshold,
    period_days: options.periodDays !== undefined && options.periodDays !== null
      ? Math.trunc(Number(options.periodDays)) : current.period_days,
    priority: options.priority !== undefined && options.priority !== null
      ? String(options.priority) : current.priority,
    category: options.category !== undefined && options.category !== null
      ? text(options.category) : current.category,
  };
  if (values.threshold === null || Number(values.threshold) <= 0) {
    throw new PointError('阈值必须是正数');
  }
  const periodDays = Number(values.period_days);
  if (!Number.isFinite(periodDays) || periodDays < 1 || periodDays > 365) {
    throw new PointError('规则周期必须在 1 到 365 天之间');
  }
  if (!PRIORITIES.has(String(values.priority))) throw new PointError('优先级不合法');
  const [classId, termId] = scopeIds({ write: true, conn });
  conn.transaction(() => {
    conn.prepare(
      `UPDATE point_rules SET enabled=?, threshold=?, period_days=?, priority=?, category=?,
             updated_at=datetime('now','localtime') WHERE id=? AND class_id=? AND term_id=?`,
    ).run(values.enabled, values.threshold, values.period_days, values.priority, values.category,
      Number(ruleId), classId, termId);
    audit.record('point_rule', ruleId, 'update', {
      summary: `更新积分规则：${String(current.name)}`,
      params: values, classId, termId, conn,
    });
  })();
  return ruleRow(ruleId, { conn });
}

function periodTotal(conn: Database, studentId: number, start: string, end: string): number {
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM point_ledger
     WHERE class_id=? AND term_id=? AND student_id=? AND status='有效'
       AND occurred_at<>'' AND occurred_at>=? AND occurred_at<=?`,
  ).get(classId, termId, Number(studentId), start, end) as { total: number };
  return Number(row.total ?? 0);
}

function ruleHit(rule: Record<string, unknown>, value: number): boolean {
  if (rule.metric === '周期扣分') return value <= -Number(rule.threshold);
  if (rule.metric === '周期总分低于') return value < Number(rule.threshold);
  return false;
}

function ensureHitWorkItem(
  hitId: number, rule: Record<string, unknown>, studentId: number,
  periodEnd: string, value: number, conn: Database,
): void {
  const task = ensureSourceWorkItem({
    title: `积分异常 · ${String(rule.name)}`, studentId,
    sourceType: 'point_rule', sourceId: hitId, sourceLabel: '积分规则',
    scheduledAt: periodEnd, dueAt: periodEnd, priority: String(rule.priority),
    notes: `周期值 ${formatG(value)}，阈值 ${formatG(Number(rule.threshold))}`,
    conn,
  });
  conn.prepare('UPDATE point_rule_hits SET task_id=? WHERE id=?').run(Number(task.id), hitId);
}

export function evaluateRules(options: {
  referenceDate?: string; trigger?: string; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  const reference = parseDate(options.referenceDate ?? '', '日期', true);
  const rules = listRules({ conn });
  const students = activeStudents(conn);
  let createdCount = 0;
  let resolvedCount = 0;
  let runId = 0;
  conn.transaction(() => {
    const runInserted = conn.prepare(
      'INSERT INTO point_rule_runs(class_id, term_id, reference_date) VALUES(?,?,?)',
    ).run(classId, termId, reference);
    runId = Number(runInserted.lastInsertRowid);
    for (const rule of rules) {
      const start = shiftDate(reference, -(Number(rule.period_days) - 1));
      for (const student of students) {
        const value = periodTotal(conn, Number(student.id), start, reference);
        const existing = conn.prepare(
          `SELECT * FROM point_rule_hits
           WHERE rule_id=? AND student_id=? AND period_start=? AND period_end=?`,
        ).get(Number(rule.id), Number(student.id), start, reference) as
          Record<string, unknown> | undefined;
        const hit = ruleHit(rule, value);
        if (hit && !existing) {
          const hitInserted = conn.prepare(
            `INSERT INTO point_rule_hits(
               run_id, rule_id, class_id, term_id, student_id,
               period_start, period_end, value, threshold, status
             ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          ).run(runId, Number(rule.id), classId, termId, Number(student.id),
            start, reference, value, rule.threshold, '新命中');
          const hitId = Number(hitInserted.lastInsertRowid);
          ensureHitWorkItem(hitId, rule, Number(student.id), reference, value, conn);
          createdCount += 1;
        } else if (hit && existing && String(existing.status) === '已解除') {
          conn.prepare(
            `UPDATE point_rule_hits SET run_id=?, value=?, threshold=?, status='新命中',
                   resolved_at='', updated_at=datetime('now','localtime') WHERE id=?`,
          ).run(runId, value, rule.threshold, Number(existing.id));
          ensureHitWorkItem(Number(existing.id), rule, Number(student.id), reference, value, conn);
          createdCount += 1;
        } else if (!hit && existing
          && (String(existing.status) === '新命中' || String(existing.status) === '已处理')) {
          if (existing.task_id) {
            try {
              updateWorkItem(Number(existing.task_id), {
                status: '已完成', result: '积分异常条件已解除',
                conn, syncSource: false,
              });
            } catch (error) {
              if (!(error instanceof WorkItemError)) throw error;
            }
          }
          conn.prepare(
            `UPDATE point_rule_hits SET run_id=?, value=?, status='已解除',
                   resolved_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
               WHERE id=?`,
          ).run(runId, value, Number(existing.id));
          resolvedCount += 1;
        }
      }
    }
    conn.prepare(
      'UPDATE point_rule_runs SET created_count=?, resolved_count=? WHERE id=?',
    ).run(createdCount, resolvedCount, runId);
    audit.record('point_rule_run', runId, 'evaluate', {
      summary: `检查积分规则：新增 ${createdCount} 项`,
      params: { trigger: options.trigger ?? 'manual', created_count: createdCount,
        resolved_count: resolvedCount },
      classId, termId, conn,
    });
  })();
  return {
    run_id: runId, reference_date: reference,
    created_count: createdCount, resolved_count: resolvedCount,
  };
}

export function evaluateStartup(options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = options.conn ?? getDb().connInstance;
  const scopes = conn.prepare(
    `SELECT c.id AS class_id, t.id AS term_id FROM classes c
     JOIN terms t ON t.class_id=c.id
     WHERE c.status='使用中' AND t.status='进行中' ORDER BY c.id, t.id`,
  ).all() as Array<{ class_id: number; term_id: number }>;
  const results: Array<Record<string, unknown>> = [];
  for (const scope of scopes) {
    bindRequestScope(Number(scope.class_id), Number(scope.term_id));
    try {
      if (listRules({ conn }).length === 0) {
        results.push({ created_count: 0, resolved_count: 0 });
        continue;
      }
      results.push(evaluateRules({ trigger: 'startup', conn }));
    } finally {
      resetRequestScope();
    }
  }
  return results;
}

export function listRuleHits(options: {
  status?: string; limit?: number; conn?: Database;
} = {}): Array<Record<string, unknown>> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const where = ['h.class_id=?', 'h.term_id=?', "s.deleted_at=''"];
  const params: unknown[] = [classId, termId];
  if (options.status) {
    if (!HIT_STATUSES.has(options.status)) throw new PointError('规则命中状态不合法');
    where.push('h.status=?');
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(Number(options.limit ?? 200), 5_000));
  return conn.prepare(
    `SELECT h.*, s.学号, s.姓名, r.name AS rule_name, r.priority
     FROM point_rule_hits h JOIN students s ON s.id=h.student_id
     JOIN point_rules r ON r.id=h.rule_id WHERE ` + where.join(' AND ') +
    ` ORDER BY CASE WHEN h.status='新命中' THEN 0 ELSE 1 END, h.period_end DESC, h.id DESC LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;
}

export function onWorkItemTransition(
  conn: Database, before: Record<string, unknown>, nextStatus: string, _result: string,
): void {
  const hitId = before.source_id;
  if (String(before.source_type ?? '') !== 'point_rule' || !hitId) return;
  const hit = conn.prepare(
    'SELECT * FROM point_rule_hits WHERE id=? AND class_id=? AND term_id=?',
  ).get(Number(hitId), Number(before.class_id), Number(before.term_id)) as
    Record<string, unknown> | undefined;
  if (!hit) return;
  if (nextStatus === '已完成') {
    conn.prepare(
      "UPDATE point_rule_hits SET status='已处理', updated_at=datetime('now','localtime') WHERE id=?",
    ).run(Number(hitId));
  } else if (nextStatus !== '已取消') {
    conn.prepare(
      "UPDATE point_rule_hits SET status='新命中', resolved_at='', updated_at=datetime('now','localtime') WHERE id=?",
    ).run(Number(hitId));
  }
}

function periodBuckets(reference: string, count = 8): Array<[string, string]> {
  const parsed = parseIsoDate(reference);
  const monday = new Date(Date.UTC(parsed!.year, parsed!.month - 1, parsed!.day));
  const dayNum = monday.getUTCDay() || 7;
  monday.setUTCDate(monday.getUTCDate() - (dayNum - 1));
  const buckets: Array<[string, string]> = [];
  for (let index = 0; index < count; index += 1) {
    const start = new Date(monday);
    start.setUTCDate(start.getUTCDate() - (count - index - 1) * 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    buckets.push([start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]);
  }
  return buckets;
}

function monthBuckets(start: string, count = 12): Array<[string, string]> {
  const parsed = parseIsoDate(start);
  const buckets: Array<[string, string]> = [];
  for (let offset = 0; offset < count; offset += 1) {
    const year = parsed!.year + Math.floor((parsed!.month - 1 + offset) / 12);
    const month = ((parsed!.month - 1 + offset) % 12) + 1;
    const first = new Date(Date.UTC(year, month - 1, 1));
    const nextFirst = month === 12
      ? new Date(Date.UTC(year + 1, 0, 1))
      : new Date(Date.UTC(year, month, 1));
    const end = new Date(nextFirst);
    end.setUTCDate(end.getUTCDate() - 1);
    buckets.push([first.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]);
  }
  return buckets;
}

function summaryForStudent(
  student: Record<string, unknown>, entries: Array<Record<string, unknown>>,
  options: { reference: string; periodStart?: string; periodEnd?: string; count?: number },
): Record<string, unknown> {
  const { reference, periodStart, periodEnd } = options;
  const count = options.count ?? 8;
  let valid = entries.filter((item) => String(item.status) === '有效');
  if (periodStart && periodEnd) {
    valid = valid.filter((item) => {
      const occurred = String(item.occurred_at ?? '').slice(0, 10);
      return Boolean(occurred) && occurred >= periodStart && occurred <= periodEnd;
    });
  }
  const total = valid.reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  const buckets = periodBuckets(reference, count);
  const dated = valid.filter((item) => Boolean(item.occurred_at));
  let weekly = buckets.map(([start, end]) => amountOf(
    dated
      .filter((item) => {
        const occurred = String(item.occurred_at ?? '').slice(0, 10);
        return occurred >= start && occurred <= end;
      })
      .reduce((sum, item) => sum + Number(item.amount ?? 0), 0),
  ) ?? 0);
  if (dated.length === 0) {
    const legacy: Record<number, number> = {};
    for (const item of valid) {
      const key = String(item.period_key ?? '');
      if (key.startsWith('legacy-W')) {
        const index = Number(key.split('-W')[1]);
        if (Number.isInteger(index)) legacy[index] = Number(item.amount ?? 0);
      }
    }
    weekly = Array.from({ length: count }, (_, index) => amountOf(legacy[index + 1] ?? 0) ?? 0);
  }
  const positiveTotal = valid
    .filter((item) => Number(item.amount ?? 0) > 0)
    .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  const negativeTotal = valid
    .filter((item) => Number(item.amount ?? 0) < 0)
    .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  let monthly: number[] = [];
  if (periodStart && periodEnd) {
    monthly = monthBuckets(periodStart).map(([start, end]) => amountOf(
      valid
        .filter((item) => {
          const occurred = String(item.occurred_at ?? '').slice(0, 10);
          return Boolean(occurred) && occurred >= start && occurred <= end;
        })
        .reduce((sum, item) => sum + Number(item.amount ?? 0), 0),
    ) ?? 0);
  }
  return {
    student_id: Number(student.id), 学号: String(student['学号'] ?? ''),
    name: String(student['姓名'] ?? ''),
    weekly, total: amountOf(total) ?? 0,
    positive_total: amountOf(positiveTotal) ?? 0,
    negative_total: amountOf(negativeTotal) ?? 0,
    monthly,
    entry_count: valid.length, revoked_count: entries.length - valid.length,
  };
}

export function classSummary(options: {
  referenceDate?: string; academicYear?: string; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  ensureLegacyMigrated({ conn });
  const reference = parseDate(options.referenceDate ?? '', '日期', true);
  const students = activeStudents(conn);
  const [classId, termId] = scopeIds({ conn });
  let yearLabel = '';
  let periodStart = '';
  let periodEnd = '';
  if (options.academicYear) {
    [yearLabel, periodStart, periodEnd] = academicYearRange(options.academicYear, reference);
  } else {
    yearLabel = academicYearLabel(reference);
  }
  let sql = `SELECT p.*, s.学号, s.姓名 FROM point_ledger p JOIN students s ON s.id=p.student_id
             WHERE p.class_id=? AND s.deleted_at=''`;
  const params: unknown[] = [classId];
  if (periodStart && periodEnd) {
    sql += ' AND p.occurred_at>=? AND p.occurred_at<=?';
    params.push(periodStart, periodEnd);
  } else {
    sql += ' AND p.term_id=?';
    params.push(termId);
  }
  const rows = conn.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const byStudent = new Map<number, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const studentId = Number(row.student_id);
    if (!byStudent.has(studentId)) byStudent.set(studentId, []);
    byStudent.get(studentId)!.push(serialize(row));
  }
  const summaries = students.map((student) => summaryForStudent(
    student, byStudent.get(Number(student.id)) ?? [],
    { reference, periodStart: periodStart || undefined, periodEnd: periodEnd || undefined },
  ));
  summaries.sort((a, b) => {
    const diff = Number(b.total) - Number(a.total);
    if (diff !== 0) return diff;
    const xhA = String(a['学号'] ?? '');
    const xhB = String(b['学号'] ?? '');
    return xhA < xhB ? -1 : xhA > xhB ? 1 : 0;
  });
  summaries.forEach((item, index) => {
    item.rank = Number(item.entry_count) ? index + 1 : null;
  });
  const validRows = rows.filter((row) => String(row.status) === '有效');
  const categoryTotals: Record<string, {
    category: string; total: number; positive: number; negative: number;
  }> = {};
  for (const row of validRows) {
    const category = text(row.category) || '未分类';
    const item = categoryTotals[category] ?? { category, total: 0, positive: 0, negative: 0 };
    const amount = Number(row.amount ?? 0);
    item.total = amountOf(item.total + amount) ?? 0;
    if (amount > 0) item.positive = amountOf(item.positive + amount) ?? 0;
    else if (amount < 0) item.negative = amountOf(item.negative + amount) ?? 0;
    categoryTotals[category] = item;
  }
  let monthly: Array<Record<string, unknown>> = [];
  if (periodStart && periodEnd) {
    monthly = monthBuckets(periodStart).map(([start, end]) => {
      const monthRows = validRows.filter((row) => {
        const occurred = String(row.occurred_at ?? '').slice(0, 10);
        return Boolean(occurred) && occurred >= start && occurred <= end;
      });
      const total = monthRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
      const positive = monthRows
        .filter((row) => Number(row.amount ?? 0) > 0)
        .reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
      const negative = monthRows
        .filter((row) => Number(row.amount ?? 0) < 0)
        .reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
      return {
        label: `${start.slice(0, 4)}-${start.slice(5, 7)}`,
        total: amountOf(total) ?? 0,
        positive: amountOf(positive) ?? 0,
        negative: amountOf(negative) ?? 0,
      };
    });
  }
  return {
    reference_date: reference, academic_year: yearLabel,
    academic_year_start: periodStart, academic_year_end: periodEnd,
    academic_years: academicYears(classId, conn),
    students: summaries,
    totals: {
      valid_entries: validRows.length,
      students_with_entries: summaries.filter((item) => Number(item.entry_count) > 0).length,
      total: amountOf(validRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0)) ?? 0,
      positive: amountOf(validRows
        .filter((row) => Number(row.amount ?? 0) > 0)
        .reduce((sum, row) => sum + Number(row.amount ?? 0), 0)) ?? 0,
      negative: amountOf(validRows
        .filter((row) => Number(row.amount ?? 0) < 0)
        .reduce((sum, row) => sum + Number(row.amount ?? 0), 0)) ?? 0,
    },
    monthly,
    categories: Object.values(categoryTotals).sort((a, b) => {
      const diff = Math.abs(b.total) - Math.abs(a.total);
      if (diff !== 0) return diff;
      return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
    }),
    migration: migrationReport({ conn }),
    rules: listRules({ conn }),
    hits: listRuleHits({ status: '新命中', conn }),
  };
}

export function studentSummary(studentId: number, options: {
  referenceDate?: string; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  ensureLegacyMigrated({ conn });
  const students = activeStudents(conn)
    .filter((item) => Number(item.id) === Number(studentId));
  if (students.length === 0) throw new PointError('学生不在当前班级和学期');
  const [classId, termId] = scopeIds({ conn });
  const rows = conn.prepare(
    `SELECT p.*, s.学号, s.姓名 FROM point_ledger p JOIN students s ON s.id=p.student_id
     WHERE p.class_id=? AND p.term_id=? AND p.student_id=? AND s.deleted_at=''`,
  ).all(classId, termId, Number(studentId)) as Array<Record<string, unknown>>;
  const reference = parseDate(options.referenceDate ?? '', '日期', true);
  const result = summaryForStudent(
    students[0], rows.map((row) => serialize(row)), { reference },
  );
  result.entries = rows.map((row) => serialize(row));
  return result;
}

sourceTransitionHooks['point_rule'] = onWorkItemTransition;
