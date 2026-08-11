/* MIG-07 结构化考勤：记录、统计、规则评估与考勤提醒工作项联动。
 * 提供记录、统计、规则评估与提醒联动。
 * save_daily 保留在 p0Service.saveDailyAttendance；考勤提醒回写通过
 * workItems.sourceTransitionHooks['attendance_rule'] 接入。
 */
import type { Database } from 'better-sqlite3';

import { getDb, scopeIds, bindRequestScope, resetRequestScope } from './context.js';
import * as audit from './audit.js';
import { todayString } from './clock.js';
import { ensureSourceWorkItem, updateWorkItem, sourceTransitionHooks } from './workItems.js';

export const STATUSES: Set<string> = new Set(['出勤', '迟到', '请假', '早退', '缺勤']);
export const SCENES: string[] = ['常规到校', '早自习', '上午', '下午', '晚自习'];
export const RULE_SCENES: string[] = ['全部场景', ...SCENES];
export const RULE_METRICS: Set<string> = new Set(['迟到次数', '请假次数', '缺勤次数', '连续缺勤天数']);
export const TRIGGERS: Set<string> = new Set(['save', 'startup', 'manual', 'rule_change']);
export const OPEN_TASK_STATUSES: Set<string> = new Set(['待处理', '处理中', '待复查']);

export class AttendanceError extends Error {}

function nowString(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
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

function parseDate(value: string | null | undefined, defaultToday = false): string {
  const text = String(value || (defaultToday ? todayString() : '')).slice(0, 10);
  if (!text) return '';
  if (!parseIsoDate(text)) throw new AttendanceError('日期格式必须为 YYYY-MM-DD');
  return text;
}

function parseScene(value: string | null | undefined, allowAll = false): string {
  const text = String(value || (allowAll ? '全部场景' : '常规到校')).trim();
  const allowed = allowAll ? RULE_SCENES : SCENES;
  if (!allowed.includes(text)) throw new AttendanceError('不支持的考勤场景');
  return text;
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

function isoWeekdayIndex(parsed: { year: number; month: number; day: number }): number {
  const d = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  return (d.getUTCDay() + 6) % 7;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface ListRecordsOptions {
  attendanceDate?: string;
  dateFrom?: string;
  dateTo?: string;
  scene?: string;
  studentId?: number | null;
  status?: string;
  limit?: number;
  conn?: Database;
}

export function listRecords(options: ListRecordsOptions = {}): Array<Record<string, unknown>> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const where = ["a.class_id=?", "a.term_id=?", "a.deleted_at=''", "s.deleted_at=''"];
  const params: unknown[] = [classId, termId];
  if (options.attendanceDate) {
    where.push('a.attendance_date=?');
    params.push(parseDate(options.attendanceDate));
  }
  if (options.dateFrom) {
    where.push('a.attendance_date>=?');
    params.push(parseDate(options.dateFrom));
  }
  if (options.dateTo) {
    where.push('a.attendance_date<=?');
    params.push(parseDate(options.dateTo));
  }
  if (options.scene && options.scene !== '全部场景') {
    where.push('a.scene=?');
    params.push(parseScene(options.scene));
  }
  if (options.studentId !== undefined && options.studentId !== null) {
    where.push('a.student_id=?');
    params.push(Number(options.studentId));
  }
  if (options.status) {
    if (!STATUSES.has(options.status)) throw new AttendanceError('考勤状态不合法');
    where.push('a.status=?');
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(Number(options.limit ?? 5000), 50_000));
  return conn.prepare(
    'SELECT a.*, s.学号, s.姓名 AS student_name FROM attendance_records a '
    + 'JOIN students s ON s.id=a.student_id WHERE ' + where.join(' AND ')
    + ' ORDER BY a.attendance_date DESC, a.scene, s.学号, a.id DESC LIMIT ?',
  ).all(...params, limit) as Array<Record<string, unknown>>;
}

export function compatibilityRows(options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = options.conn ?? getDb().connInstance;
  const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const output: Array<Record<string, unknown>> = [];
  for (const row of listRecords({ limit: 50_000, conn })) {
    let weekday = '';
    const parsed = parseIsoDate(String(row['attendance_date'] ?? ''));
    if (parsed) weekday = weekdays[isoWeekdayIndex(parsed)];
    output.push({
      row_no: row['id'],
      data: [row['attendance_date'], weekday, row['学号'], row['student_name'],
        row['status'], row['arrive_at'], row['leave_at'], row['reason'],
        row['note'], row['scene']],
    });
  }
  return output;
}

function emptyBucket(label: string): Record<string, number | string> {
  return { label, 出勤: 0, 迟到: 0, 请假: 0, 早退: 0, 缺勤: 0, 总记录: 0, 异常: 0 };
}

export function attendanceStats(options: {
  dateFrom?: string; dateTo?: string; scene?: string; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const dateFrom = options.dateFrom ? parseDate(options.dateFrom) : '';
  const dateTo = options.dateTo ? parseDate(options.dateTo) : '';
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new AttendanceError('开始日期不能晚于结束日期');
  }
  const scene = parseScene(options.scene ?? '全部场景', true);
  const rows = listRecords({ dateFrom, dateTo, scene, limit: 50_000, conn });
  const statusCount: Record<string, number> = {};
  for (const status of STATUSES) statusCount[status] = 0;
  const dateStats: Record<string, Record<string, number | string>> = {};
  const studentStats: Record<number, Record<string, number | string>> = {};
  const monthStats: Record<string, Record<string, number | string>> = {};
  const weekStats: Record<string, Record<string, number | string>> = {};
  const anomalies: Array<Record<string, unknown>> = [];
  const sessionKeys = new Set<string>();
  for (const row of rows) {
    const status = String(row['status']);
    const dateText = String(row['attendance_date']);
    const sceneText = String(row['scene']);
    sessionKeys.add(JSON.stringify([dateText, sceneText]));
    statusCount[status] = (statusCount[status] ?? 0) + 1;
    if (!dateStats[dateText]) dateStats[dateText] = emptyBucket(dateText);
    const day = dateStats[dateText];
    const monthKey = dateText.slice(0, 7);
    if (!monthStats[monthKey]) monthStats[monthKey] = emptyBucket(monthKey);
    const month = monthStats[monthKey];
    let weekKey = '日期异常';
    const parsed = parseIsoDate(dateText);
    if (parsed) weekKey = isoWeekKey(parsed);
    if (!weekStats[weekKey]) weekStats[weekKey] = emptyBucket(weekKey);
    const week = weekStats[weekKey];
    const studentId = Number(row['student_id']);
    if (!studentStats[studentId]) {
      studentStats[studentId] = {
        student_id: studentId, 学号: row['学号'] as string, student_name: row['student_name'] as string,
        ...emptyBucket(String(row['student_name'] ?? '')),
      };
    }
    const student = studentStats[studentId];
    for (const bucket of [day, month, week, student]) {
      bucket[status] = Number(bucket[status] ?? 0) + 1;
      bucket['总记录'] = Number(bucket['总记录']) + 1;
      if (status !== '出勤') bucket['异常'] = Number(bucket['异常']) + 1;
    }
    if (status !== '出勤') {
      anomalies.push({
        id: row['id'], student_id: row['student_id'], 学号: row['学号'],
        student_name: row['student_name'], date: row['attendance_date'],
        scene: row['scene'], status, reason: row['reason'], note: row['note'],
      });
    }
  }
  for (const item of Object.values(studentStats)) {
    const attended = Number(item['出勤']) + Number(item['迟到']) + Number(item['早退']);
    item['应到次数'] = item['总记录'];
    item['正常出勤'] = item['出勤'];
    item['到勤次数'] = attended;
    item['punctual_rate'] = Number(item['总记录'])
      ? round1((Number(item['出勤']) * 100) / Number(item['总记录'])) : 0;
    item['presence_rate'] = Number(item['总记录'])
      ? round1((attended * 100) / Number(item['总记录'])) : 0;
    // 保留旧字段，避免已有导出或外部调用失效。
    item['attendance_rate'] = item['presence_rate'];
  }
  const students = Object.values(studentStats).sort((a, b) => {
    const anomalyDiff = Number(b['异常']) - Number(a['异常']);
    if (anomalyDiff !== 0) return anomalyDiff;
    const idA = String(a['学号'] || '');
    const idB = String(b['学号'] || '');
    if (idA !== idB) return idA < idB ? -1 : 1;
    return Number(a['student_id']) - Number(b['student_id']);
  });
  return {
    date_from: dateFrom, date_to: dateTo, scene,
    total_records: rows.length, total_sessions: sessionKeys.size,
    status_count: statusCount,
    date_stats: Object.keys(dateStats).sort().reverse().map((key) => dateStats[key]),
    student_stats: students,
    month_stats: Object.keys(monthStats).sort().reverse().map((key) => monthStats[key]),
    week_stats: Object.keys(weekStats).sort().reverse().map((key) => weekStats[key]),
    anomalies: anomalies.slice(0, 500),
    definition: '按时出勤率=正常出勤/应到次数；到勤率=(正常出勤+迟到+早退)/应到次数；请假和缺勤不计入到勤。',
  };
}

export function dashboardCounts(targetDate: string, conn?: Database): Record<string, number> {
  const db = conn ?? getDb().connInstance;
  const rows = listRecords({ attendanceDate: parseDate(targetDate), limit: 50_000, conn: db });
  const severity: Record<string, number> = { 出勤: 0, 迟到: 1, 早退: 2, 请假: 3, 缺勤: 4 };
  const byStudent: Record<number, string> = {};
  for (const row of rows) {
    const studentId = Number(row['student_id']);
    const current = byStudent[studentId] ?? '出勤';
    if ((severity[String(row['status'])] ?? 0) >= (severity[current] ?? 0)) {
      byStudent[studentId] = String(row['status']);
    }
  }
  const counts: Record<string, number> = {};
  for (const status of STATUSES) counts[status] = 0;
  for (const status of Object.values(byStudent)) counts[status] += 1;
  return counts;
}

function ruleValue(records: Array<Record<string, unknown>>, metric: string): number {
  const mapping: Record<string, string> = { 迟到次数: '迟到', 请假次数: '请假', 缺勤次数: '缺勤' };
  if (mapping[metric] !== undefined) {
    const target = mapping[metric];
    return records.filter((row) => String(row['status']) === target).length;
  }
  if (metric !== '连续缺勤天数') throw new AttendanceError('不支持的考勤指标');
  const byDate: Record<string, string[]> = {};
  for (const row of records) {
    const day = String(row['attendance_date']);
    (byDate[day] ??= []).push(String(row['status']));
  }
  let streak = 0;
  let best = 0;
  for (const day of Object.keys(byDate).sort()) {
    if (byDate[day].includes('缺勤')) {
      streak += 1;
      best = Math.max(best, streak);
    } else {
      streak = 0;
    }
  }
  return best;
}

function ruleRow(
  ruleId: number, options: { write?: boolean; conn?: Database } = {},
): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: options.write, conn });
  const row = conn.prepare(
    "SELECT * FROM attendance_rules WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(ruleId, classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new AttendanceError('考勤规则不存在');
  return row;
}

export function listRules(options: { sourceId?: number | null; conn?: Database } = {}):
  Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const params: unknown[] = [classId, termId];
  let sql = "SELECT * FROM attendance_rules WHERE class_id=? AND term_id=? AND deleted_at=''";
  if (options.sourceId) {
    sql += ' AND id=?';
    params.push(Number(options.sourceId));
  }
  const rules = conn.prepare(sql + ' ORDER BY enabled DESC, id').all(...params) as Array<Record<string, unknown>>;
  for (const rule of rules) {
    rule['enabled'] = Boolean(rule['enabled']);
    const hits = conn.prepare(
      `SELECT h.*, s.学号, s.姓名 AS student_name,
              t.status AS task_status, t.result AS task_result
       FROM attendance_rule_hits h
       JOIN students s ON s.id=h.student_id
       LEFT JOIN student_tasks t ON t.id=h.task_id
       WHERE h.class_id=? AND h.term_id=? AND h.rule_id=?
       ORDER BY CASE h.status WHEN '待处理' THEN 0 WHEN '已处理' THEN 1 ELSE 2 END,
                h.last_hit_at DESC, h.id DESC`,
    ).all(classId, termId, rule['id']) as Array<Record<string, unknown>>;
    rule['hits'] = hits;
    rule['active_hit_count'] = hits.filter((item) => String(item['status']) === '待处理').length;
    rule['handled_hit_count'] = hits.filter((item) => String(item['status']) === '已处理').length;
  }
  const runs = conn.prepare(
    'SELECT * FROM attendance_rule_runs WHERE class_id=? AND term_id=? ORDER BY id DESC LIMIT 20',
  ).all(classId, termId) as Array<Record<string, unknown>>;
  for (const run of runs) {
    const summaryJson = String(run['summary_json'] ?? '[]');
    delete run['summary_json'];
    try {
      run['summary'] = JSON.parse(summaryJson);
    } catch {
      run['summary'] = [];
    }
  }
  return { rules, recent_runs: runs };
}

export function createRule(options: {
  name: string; metric: string; threshold?: number; periodDays?: number;
  priority?: string; enabled?: boolean; scene?: string; conn?: Database;
}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const name = String(options.name ?? '').trim();
  if (!name) throw new AttendanceError('规则名称不能为空');
  if (!RULE_METRICS.has(options.metric)) throw new AttendanceError('不支持的考勤指标');
  const threshold = Number(options.threshold ?? 2);
  const periodDays = Number(options.periodDays ?? 7);
  if (threshold < 1 || !(1 <= periodDays && periodDays <= 365)) {
    throw new AttendanceError('阈值或统计周期不合法');
  }
  const scene = parseScene(options.scene ?? '全部场景', true);
  const enabled = options.enabled ?? true;
  const [classId, termId] = scopeIds({ write: true, conn });
  const ruleId = conn.transaction(() => {
    const inserted = conn.prepare(
      `INSERT INTO attendance_rules(
         name, metric, threshold, period_days, priority, enabled, scene, class_id, term_id
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      name, options.metric, threshold, periodDays,
      String(options.priority || '重要'), enabled ? 1 : 0, scene, classId, termId,
    );
    const id = Number(inserted.lastInsertRowid);
    audit.record('attendance_rule', id, 'create', {
      summary: `新增考勤规则：${name}`,
      params: { metric: options.metric, threshold, period_days: periodDays, scene, enabled },
      classId, termId, conn,
    });
    return id;
  })();
  const evaluation = enabled ? evaluateRules({ trigger: 'rule_change', conn }) : null;
  return { ok: true, rule_id: ruleId, evaluation };
}

function resolveOpenTask(taskId: number | null, result: string, conn: Database): boolean {
  if (!taskId) return false;
  const task = conn.prepare(
    "SELECT status FROM student_tasks WHERE id=? AND deleted_at=''",
  ).get(taskId) as { status: string } | undefined;
  if (!task || !OPEN_TASK_STATUSES.has(String(task['status']))) return false;
  updateWorkItem(taskId, { status: '已取消', result, conn });
  return true;
}

function resolveRuleHits(ruleId: number, result: string, conn: Database): number {
  const [classId, termId] = scopeIds({ write: true, conn });
  const hits = conn.prepare(
    "SELECT * FROM attendance_rule_hits WHERE rule_id=? AND class_id=? AND term_id=? AND status<>'已解除'",
  ).all(ruleId, classId, termId) as Array<Record<string, unknown>>;
  let resolved = 0;
  for (const hit of hits) {
    resolveOpenTask(hit['task_id'] as number | null, result, conn);
    conn.prepare(
      "UPDATE attendance_rule_hits SET status='已解除', resolved_at=?, updated_at=datetime('now','localtime') WHERE id=?",
    ).run(nowString(), hit['id']);
    resolved += 1;
  }
  return resolved;
}

export function updateRule(ruleId: number, changes: Record<string, unknown> = {}):
  Record<string, unknown> {
  const conn = (changes['conn'] as Database | undefined) ?? getDb().connInstance;
  delete changes['conn'];
  const current = ruleRow(ruleId, { write: true, conn });
  const fields: string[] = [];
  const params: unknown[] = [];
  for (const key of ['enabled', 'threshold', 'period_days', 'priority', 'scene']) {
    const value = changes[key];
    if (value === undefined || value === null) continue;
    let stored: unknown = value;
    if (key === 'enabled') {
      stored = value ? 1 : 0;
    } else if (key === 'threshold') {
      if (Number(value) < 1) throw new AttendanceError('阈值不能小于 1');
    } else if (key === 'period_days') {
      if (!(1 <= Number(value) && Number(value) <= 365)) {
        throw new AttendanceError('统计周期必须在 1 到 365 天之间');
      }
    } else if (key === 'scene') {
      stored = parseScene(String(value), true);
    }
    fields.push(`${key}=?`);
    params.push(stored);
  }
  if (fields.length === 0) return { ok: true, evaluation: null };
  const enabledChange = changes['enabled'];
  const nextEnabled = enabledChange !== undefined && enabledChange !== null
    ? Boolean(enabledChange) : Boolean(current['enabled']);
  const [classId, termId] = scopeIds({ write: true, conn });
  params.push(ruleId, classId, termId);
  const resolved = conn.transaction(() => {
    conn.prepare(
      `UPDATE attendance_rules SET ${fields.join(', ')}, updated_at=datetime('now','localtime') `
      + 'WHERE id=? AND class_id=? AND term_id=?',
    ).run(...params);
    let count = 0;
    if (!nextEnabled) {
      count = resolveRuleHits(ruleId, '考勤规则已停用，系统自动解除提醒', conn);
    }
    audit.record('attendance_rule', ruleId, 'update', {
      summary: `更新考勤规则：${String(current['name'])}`,
      params: changes, classId, termId, conn,
    });
    return count;
  })();
  const evaluation = nextEnabled ? evaluateRules({ trigger: 'rule_change', conn }) : null;
  return { ok: true, resolved_count: resolved, evaluation };
}

function activateTask(
  rule: Record<string, unknown>, student: Record<string, unknown>, value: number,
  referenceDate: string, options: { rehit: boolean; conn: Database },
): { taskId: number; created: boolean; reopened: boolean } {
  const { rehit, conn } = options;
  const title = `考勤提醒 · ${String(student['姓名'] ?? '')} · ${String(rule['name'] ?? '')}`;
  const notes = `${String(rule['metric'])}达到 ${value}，阈值 ${String(rule['threshold'])}，`
    + `统计周期 ${String(rule['period_days'])} 天，场景 ${String(rule['scene'])}`;
  const task = ensureSourceWorkItem({
    title, legacyTitle: title, studentId: Number(student['id']),
    sourceType: 'attendance_rule', sourceId: Number(rule['id']), dueAt: referenceDate,
    priority: rule['priority'] as string | undefined, status: '待处理', notes, conn,
  });
  const taskId = Number(task.id);
  const row = conn.prepare(
    `SELECT status, title, priority, due_at, notes
     FROM student_tasks WHERE id=? AND deleted_at=''`,
  ).get(taskId) as Record<string, unknown> | undefined;
  let reopened = false;
  if (row && !OPEN_TASK_STATUSES.has(String(row['status'])) && (rehit || !task.created)) {
    updateWorkItem(taskId, {
      title, priority: rule['priority'] as string | null | undefined, status: '待处理',
      dueAt: referenceDate, notes, conn,
    });
    reopened = true;
  } else if (row && OPEN_TASK_STATUSES.has(String(row['status'])) && (
    String(row['title']) !== title
    || String(row['priority']) !== String(rule['priority'] ?? '')
    || String(row['due_at']) !== referenceDate
    || String(row['notes']) !== notes
  )) {
    updateWorkItem(taskId, {
      title, priority: rule['priority'] as string | null | undefined,
      dueAt: referenceDate, notes, conn,
    });
  }
  return { taskId, created: Boolean(task.created), reopened };
}

interface EvaluateRunResult {
  runId: number;
  hitCount: number;
  createdCount: number;
  reopenedCount: number;
  resolvedCount: number;
  summary: Array<Record<string, unknown>>;
}

export function evaluateRules(options: {
  referenceDate?: string | null; trigger?: string; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const referenceDate = parseDate(options.referenceDate ?? null, true);
  const trigger = options.trigger ?? 'manual';
  if (!TRIGGERS.has(trigger)) throw new AttendanceError('规则执行来源不合法');
  const [classId, termId] = scopeIds({ write: true, conn });
  const rules = conn.prepare(
    "SELECT * FROM attendance_rules WHERE enabled=1 AND class_id=? AND term_id=? AND deleted_at='' ORDER BY id",
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const students = conn.prepare(
    `SELECT s.id, s.学号, s.姓名 FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
     ORDER BY s.id`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const maxDays = rules.reduce(
    (max, rule) => Math.max(max, Number(rule['period_days'] ?? 1)), 1);
  const startDate = shiftDate(referenceDate, -(maxDays - 1));
  const rawRecords = conn.prepare(
    `SELECT * FROM attendance_records
     WHERE class_id=? AND term_id=? AND deleted_at=''
       AND attendance_date>=? AND attendance_date<=?
     ORDER BY attendance_date, id`,
  ).all(classId, termId, startDate, referenceDate) as Array<Record<string, unknown>>;
  const byStudent = new Map<number, Array<Record<string, unknown>>>();
  for (const record of rawRecords) {
    const studentId = Number(record['student_id']);
    const list = byStudent.get(studentId) ?? [];
    list.push(record);
    byStudent.set(studentId, list);
  }
  const now = nowString();
  let success: EvaluateRunResult | null = null;
  try {
    success = conn.transaction((): EvaluateRunResult => {
      let hitCount = 0;
      let createdCount = 0;
      let reopenedCount = 0;
      let resolvedCount = 0;
      const summary: Array<Record<string, unknown>> = [];
      for (const rule of rules) {
        const ruleStart = shiftDate(referenceDate, -(Number(rule['period_days']) - 1));
        for (const student of students) {
          const records = (byStudent.get(Number(student['id'])) ?? []).filter(
            (row) => String(row['attendance_date']) >= ruleStart
              && (rule['scene'] === '全部场景' || String(row['scene']) === String(rule['scene'])),
          );
          const value = ruleValue(records, String(rule['metric']));
          const hit = conn.prepare(
            `SELECT * FROM attendance_rule_hits
             WHERE class_id=? AND term_id=? AND rule_id=? AND student_id=?`,
          ).get(classId, termId, rule['id'], student['id']) as Record<string, unknown> | undefined;
          if (value >= Number(rule['threshold'])) {
            hitCount += 1;
            const needsActivation = !hit || String(hit['status']) === '已解除';
            if (needsActivation) {
              const activated = activateTask(
                rule, student, value, referenceDate, { rehit: Boolean(hit), conn });
              createdCount += activated.created ? 1 : 0;
              reopenedCount += activated.reopened ? 1 : 0;
              if (hit) {
                conn.prepare(
                  `UPDATE attendance_rule_hits SET status='待处理', current_value=?,
                       task_id=?, last_hit_at=?, handled_at='', resolved_at='',
                       updated_at=datetime('now','localtime') WHERE id=?`,
                ).run(value, activated.taskId, now, hit['id']);
              } else {
                conn.prepare(
                  `INSERT INTO attendance_rule_hits(
                     rule_id, student_id, class_id, term_id, status,
                     current_value, task_id, first_hit_at, last_hit_at
                   ) VALUES(?,?,?,?,'待处理',?,?,?,?)`,
                ).run(rule['id'], student['id'], classId, termId,
                  value, activated.taskId, now, now);
              }
              summary.push({
                rule_id: rule['id'], rule: rule['name'],
                student_id: student['id'], student_name: student['姓名'],
                value, state: hit ? '重新命中' : '新命中',
              });
            } else {
              const task = hit['task_id']
                ? conn.prepare('SELECT status FROM student_tasks WHERE id=?')
                  .get(hit['task_id']) as { status: string } | undefined
                : undefined;
              let nextStatus = String(hit['status']);
              if (nextStatus === '待处理' && task
                && !OPEN_TASK_STATUSES.has(String(task['status']))) {
                nextStatus = '已处理';
              }
              conn.prepare(
                `UPDATE attendance_rule_hits SET status=?, current_value=?, last_hit_at=?,
                   handled_at=CASE WHEN ?='已处理' AND handled_at='' THEN ? ELSE handled_at END,
                   updated_at=datetime('now','localtime') WHERE id=?`,
              ).run(nextStatus, value, now, nextStatus, now, hit['id']);
              summary.push({
                rule_id: rule['id'], rule: rule['name'],
                student_id: student['id'], student_name: student['姓名'],
                value, state: nextStatus,
              });
            }
          } else if (hit && String(hit['status']) !== '已解除') {
            resolveOpenTask(
              hit['task_id'] as number | null, '考勤指标已恢复，系统自动解除提醒', conn);
            conn.prepare(
              `UPDATE attendance_rule_hits SET status='已解除', current_value=?,
                 resolved_at=?, updated_at=datetime('now','localtime') WHERE id=?`,
            ).run(value, now, hit['id']);
            resolvedCount += 1;
          }
        }
        conn.prepare(
          "UPDATE attendance_rules SET last_run_at=?, updated_at=datetime('now','localtime') WHERE id=?",
        ).run(now, rule['id']);
      }
      const inserted = conn.prepare(
        `INSERT INTO attendance_rule_runs(
           class_id, term_id, trigger_type, reference_date, rules_evaluated,
           students_evaluated, hit_count, created_count, reopened_count,
           resolved_count, status, summary_json
         ) VALUES(?,?,?,?,?,?,?,?,?,?,'success',?)`,
      ).run(classId, termId, trigger, referenceDate, rules.length, students.length,
        hitCount, createdCount, reopenedCount, resolvedCount, JSON.stringify(summary));
      const runId = Number(inserted.lastInsertRowid);
      audit.record('attendance_rules', runId, 'evaluate', {
        summary: `执行 ${rules.length} 条考勤规则：命中 ${hitCount}，`
          + `新建 ${createdCount}，重开 ${reopenedCount}，解除 ${resolvedCount}`,
        params: { trigger, reference_date: referenceDate },
        classId, termId, conn,
      });
      return { runId, hitCount, createdCount, reopenedCount, resolvedCount, summary };
    })();
  } catch (error) {
    conn.prepare(
      `INSERT INTO attendance_rule_runs(
         class_id, term_id, trigger_type, reference_date, rules_evaluated,
         students_evaluated, status, error
       ) VALUES(?,?,?,?,?,?,'failed',?)`,
    ).run(classId, termId, trigger, referenceDate, rules.length, students.length,
      String((error as Error).message).slice(0, 500));
    throw error;
  }
  return {
    run_id: success!.runId, reference_date: referenceDate, trigger,
    rules_evaluated: rules.length, students_evaluated: students.length,
    hit_count: success!.hitCount, created_count: success!.createdCount,
    reopened_count: success!.reopenedCount, resolved_count: success!.resolvedCount,
    summary: success!.summary,
  };
}

function onWorkItemTransition(
  conn: Database, before: Record<string, unknown>, nextStatus: string, _result: string,
): void {
  if (String(before['source_type'] ?? '') !== 'attendance_rule') return;
  const now = nowString();
  if (nextStatus === '已完成' || nextStatus === '已取消') {
    conn.prepare(
      `UPDATE attendance_rule_hits SET status='已处理', handled_at=?,
         updated_at=datetime('now','localtime')
       WHERE task_id=? AND status='待处理'`,
    ).run(now, before['id']);
  } else if (OPEN_TASK_STATUSES.has(nextStatus)) {
    conn.prepare(
      `UPDATE attendance_rule_hits SET status='待处理', handled_at='', resolved_at='',
         updated_at=datetime('now','localtime') WHERE task_id=?`,
    ).run(before['id']);
  }
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
    bindRequestScope(scope.class_id, scope.term_id);
    try {
      results.push(evaluateRules({ trigger: 'startup', conn }));
    } finally {
      resetRequestScope();
    }
  }
  return results;
}

sourceTransitionHooks['attendance_rule'] = onWorkItemTransition;
