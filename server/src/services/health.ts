import type { Database } from 'better-sqlite3';
import ExcelJS from 'exceljs';

import { getDb } from './context.js';
import { getRows } from './sheets.js';
import { todayString } from './clock.js';
import { pyRound } from './scores.js';

export const SHEETS: readonly string[] = ['体重体脂追踪', '运动记录', '睡眠记录', '饮食记录'];

export class HealthError extends Error {}

interface HealthRecord {
  id: number;
  date: string;
  data: unknown[];
}

export interface HealthMetrics {
  period_start: string;
  period_end: string;
  weight_records: number;
  latest_weight: number | null;
  weight_change: number | null;
  average_body_fat: number | null;
  exercise_days: number;
  exercise_minutes: number;
  sleep_days: number;
  average_sleep_hours: number | null;
  diet_days: number;
  protein_goal_days: number;
  average_water_ml: number | null;
}

export interface HealthSummary extends HealthMetrics {
  period_type: string;
  alerts: string[];
  goals: Array<Record<string, unknown>>;
  records: Record<string, HealthRecord[]>;
}

function text(value: unknown): string {
  return String(value || '').trim();
}

function parseIsoDate(value: unknown): string {
  let candidate = String(value ?? '').slice(0, 10);
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(candidate);
  if (compact) candidate = `${compact[1]}-${compact[2]}-${compact[3]}`;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate);
  if (!match) throw new HealthError('复盘日期必须为 YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new HealthError('复盘日期必须为 YYYY-MM-DD');
  }
  return candidate;
}

function formatUtc(utcMs: number): string {
  const date = new Date(utcMs);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function period(periodType: string, start = '', end = ''): [string, string] {
  const today = todayString();
  let begin: string;
  let finish: string;
  if (start || end) {
    begin = parseIsoDate(start);
    finish = parseIsoDate(end);
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
    const year = Number(match?.[1] ?? 0);
    const month = Number(match?.[2] ?? 1);
    const day = Number(match?.[3] ?? 1);
    const todayUtc = Date.UTC(year, month - 1, day);
    if (periodType === 'week') {
      const weekday = (new Date(todayUtc).getUTCDay() + 6) % 7;
      const weekStart = todayUtc - weekday * 86400000;
      begin = formatUtc(weekStart);
      finish = formatUtc(weekStart + 6 * 86400000);
    } else {
      begin = formatUtc(Date.UTC(year, month - 1, 1));
      finish = today;
    }
  }
  if (begin > finish) throw new HealthError('开始日期不能晚于结束日期');
  return [begin, finish];
}

function rows(sheet: string, start: string, end: string): HealthRecord[] {
  const result: HealthRecord[] = [];
  for (const row of getRows(sheet)) {
    const data = row.data ?? [];
    const rawDate = sheet === '体重体脂追踪' && data.length > 1 ? data[1] : data.length > 0 ? data[0] : '';
    const dateText = text(rawDate).slice(0, 10);
    if (start <= dateText && dateText <= end) {
      result.push({ id: row.row_no, date: dateText, data });
    }
  }
  return result;
}

function pythonJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => pythonJson(item)).join(', ')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`);
  return `{${entries.join(', ')}}`;
}

export function listGoals(): Array<Record<string, unknown>> {
  const rows = getDb().connInstance.prepare(
    'SELECT * FROM health_goals ORDER BY enabled DESC, metric, id',
  ).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
}

export function createGoal(options: {
  metric: string;
  targetValue?: number | null;
  unit?: string;
  note?: string;
  enabled?: boolean;
}): Record<string, unknown> {
  const metric = text(options.metric);
  if (!metric) throw new HealthError('目标名称不能为空');
  const conn = getDb().connInstance;
  try {
    return conn.transaction(() => {
      const row = conn.prepare(
        'INSERT INTO health_goals(metric, target_value, unit, note, enabled) '
        + 'VALUES(?,?,?,?,?) RETURNING *',
      ).get(metric, options.targetValue ?? null, text(options.unit), text(options.note), options.enabled === false ? 0 : 1) as Record<string, unknown>;
      return { ...row };
    })();
  } catch (error) {
    if (String(error).toUpperCase().includes('UNIQUE')) throw new HealthError('该健康目标已存在');
    throw error;
  }
}

export function updateGoal(
  goalId: number,
  options: {
    metric?: string | null;
    targetValue?: number | null;
    unit?: string | null;
    note?: string | null;
    enabled?: boolean | null;
  } = {},
): Record<string, unknown> {
  const conn = getDb().connInstance;
  const id = Number(goalId);
  const current = conn.prepare('SELECT * FROM health_goals WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!current) throw new HealthError('健康目标不存在');
  const updates: Array<[string, unknown]> = [
    ['metric', options.metric],
    ['target_value', options.targetValue],
    ['unit', options.unit],
    ['note', options.note],
    ['enabled', options.enabled],
  ];
  const fields: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of updates) {
    if (value !== null && value !== undefined) {
      fields.push(`${key}=?`);
      if (key === 'enabled') params.push(value ? 1 : 0);
      else if (key === 'metric' || key === 'unit' || key === 'note') params.push(text(value));
      else params.push(value);
    }
  }
  if (fields.length > 0) {
    try {
      conn.transaction(() => {
        conn.prepare(
          `UPDATE health_goals SET ${fields.join(', ')}, updated_at=datetime('now','localtime') WHERE id=?`,
        ).run(...params, id);
      })();
    } catch (error) {
      throw new HealthError('健康目标更新失败，可能存在同名目标');
    }
  }
  return conn.prepare('SELECT * FROM health_goals WHERE id=?').get(id) as Record<string, unknown>;
}

export function summary(
  periodType = 'month',
  periodStart = '',
  periodEnd = '',
): HealthSummary {
  const [start, end] = period(periodType, periodStart, periodEnd);
  const weight = rows('体重体脂追踪', start, end);
  const exercise = rows('运动记录', start, end);
  const sleep = rows('睡眠记录', start, end);
  const diet = rows('饮食记录', start, end);

  const nums = (items: HealthRecord[], index: number): number[] => {
    const values: number[] = [];
    for (const item of items) {
      const raw = item.data[index];
      if (raw === null || raw === undefined) continue;
      if (typeof raw === 'string' && raw.trim() === '') continue;
      const value = Number(raw);
      if (!Number.isNaN(value)) values.push(value);
    }
    return values;
  };

  const weights = nums(weight, 2);
  const bodyFat = nums(weight, 4);
  const exerciseMinutes = nums(exercise, 4);
  const sleepHours = nums(sleep, 3);
  const water = nums(diet, 6);
  const proteinOk = diet.reduce(
    (count, item) => count + (item.data.length > 5 && text(item.data[5]) === '达标' ? 1 : 0),
    0,
  );
  const metrics: HealthMetrics = {
    period_start: start,
    period_end: end,
    weight_records: weight.length,
    latest_weight: weights.length > 0 ? weights[weights.length - 1] : null,
    weight_change: weights.length > 1 ? pyRound(weights[weights.length - 1] - weights[0], 2) : null,
    average_body_fat: bodyFat.length > 0 ? pyRound(bodyFat.reduce((a, b) => a + b, 0) / bodyFat.length, 2) : null,
    exercise_days: exercise.length,
    exercise_minutes: pyRound(exerciseMinutes.reduce((a, b) => a + b, 0), 1),
    sleep_days: sleep.length,
    average_sleep_hours: sleepHours.length > 0 ? pyRound(sleepHours.reduce((a, b) => a + b, 0) / sleepHours.length, 2) : null,
    diet_days: diet.length,
    protein_goal_days: proteinOk,
    average_water_ml: water.length > 0 ? pyRound(water.reduce((a, b) => a + b, 0) / water.length, 1) : null,
  };
  const alerts: string[] = [];
  if (metrics.average_sleep_hours !== null && metrics.average_sleep_hours < 7) {
    alerts.push('周期平均睡眠少于 7 小时');
  }
  if (metrics.diet_days && proteinOk < metrics.diet_days / 2) {
    alerts.push('蛋白质达标天数不足周期饮食记录的一半');
  }
  if (exercise.length === 0) {
    alerts.push('本周期暂无运动记录');
  }
  return {
    period_type: periodType,
    ...metrics,
    alerts,
    goals: listGoals(),
    records: { weight, exercise, sleep, diet },
  };
}

export function generateReview(
  periodType = 'month',
  periodStart = '',
  periodEnd = '',
): Record<string, unknown> {
  const data = summary(periodType, periodStart, periodEnd);
  const parts = [`记录 ${data.diet_days} 天饮食、${data.exercise_days} 天运动、${data.sleep_days} 天睡眠。`];
  if (data.latest_weight !== null) {
    parts.push(`最近体重 ${data.latest_weight} 斤。`);
  }
  if (data.alerts.length > 0) {
    parts.push(`需要关注：${data.alerts.join('；')}。`);
  } else {
    parts.push('本周期没有检测到明显异常。');
  }
  return {
    period_type: periodType,
    period_start: data.period_start,
    period_end: data.period_end,
    summary: parts.join(''),
    next_plan: '',
    metrics: data,
  };
}

export function saveReview(options: {
  periodType: string;
  periodStart: string;
  periodEnd: string;
  summaryText: string;
  nextPlan?: string;
  metrics?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const [start, end] = period(options.periodType, options.periodStart, options.periodEnd);
  const row = getDb().connInstance.prepare(
    `INSERT INTO health_reviews(period_type, period_start, period_end, summary, next_plan, metrics_json)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(period_type, period_start, period_end) DO UPDATE SET
       summary=excluded.summary, next_plan=excluded.next_plan, metrics_json=excluded.metrics_json,
       updated_at=datetime('now','localtime') RETURNING *`,
  ).get(
    options.periodType, start, end,
    text(options.summaryText), text(options.nextPlan ?? ''), JSON.stringify(options.metrics || {}),
  ) as Record<string, unknown>;
  const item = { ...row };
  item.metrics = JSON.parse(String(item.metrics_json || '{}')) as Record<string, unknown>;
  delete item.metrics_json;
  return item;
}

export function listReviews(limit = 50): Array<Record<string, unknown>> {
  const bounded = Math.max(1, Math.min(Number(limit), 200));
  const rows = getDb().connInstance.prepare(
    'SELECT * FROM health_reviews ORDER BY period_end DESC, id DESC LIMIT ?',
  ).all(bounded) as Array<Record<string, unknown>>;
  const result: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const item = { ...row };
    item.metrics = JSON.parse(String(item.metrics_json || '{}')) as Record<string, unknown>;
    delete item.metrics_json;
    result.push(item);
  }
  return result;
}

export function listReminders(): Array<Record<string, unknown>> {
  const rows = getDb().connInstance.prepare(
    'SELECT * FROM health_reminders ORDER BY reminder_type',
  ).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
}

export function saveReminder(options: {
  reminderType: string;
  enabled?: boolean;
  remindTime?: string;
  message?: string;
}): Record<string, unknown> {
  const reminderType = text(options.reminderType);
  if (!reminderType) throw new HealthError('提醒类型不能为空');
  const remindTime = text(options.remindTime);
  if (!remindTime || remindTime.length !== 5) throw new HealthError('提醒时间应为 HH:MM');
  const row = getDb().connInstance.prepare(
    `INSERT INTO health_reminders(reminder_type, enabled, remind_time, message)
     VALUES(?,?,?,?)
     ON CONFLICT(reminder_type) DO UPDATE SET
       enabled=excluded.enabled, remind_time=excluded.remind_time, message=excluded.message,
       updated_at=datetime('now','localtime') RETURNING *`,
  ).get(reminderType, options.enabled ? 1 : 0, remindTime, text(options.message)) as Record<string, unknown>;
  return { ...row, enabled: Boolean(row.enabled) };
}

export async function exportSummary(
  periodType = 'month',
  periodStart = '',
  periodEnd = '',
): Promise<{ buffer: Buffer; filename: string }> {
  const data = summary(periodType, periodStart, periodEnd);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('健康周期汇总');
  ws.getCell('A1').value = '个人健康周期汇总';
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = '周期';
  ws.getCell('B2').value = `${data.period_start} 至 ${data.period_end}`;
  ws.getRow(4).values = ['指标', '数值'];
  ws.getCell('A4').font = { bold: true };
  ws.getCell('B4').font = { bold: true };
  const labels: Array<[string, keyof HealthMetrics]> = [
    ['体重记录数', 'weight_records'],
    ['最近体重', 'latest_weight'],
    ['体重变化', 'weight_change'],
    ['平均体脂', 'average_body_fat'],
    ['运动天数', 'exercise_days'],
    ['运动分钟数', 'exercise_minutes'],
    ['睡眠天数', 'sleep_days'],
    ['平均睡眠小时', 'average_sleep_hours'],
    ['饮食记录天数', 'diet_days'],
    ['蛋白质达标天数', 'protein_goal_days'],
    ['平均饮水量（毫升）', 'average_water_ml'],
  ];
  let rowIndex = 5;
  for (const [label, key] of labels) {
    ws.getRow(rowIndex).getCell(1).value = label;
    const value = data[key];
    if (value !== null && value !== undefined) {
      ws.getRow(rowIndex).getCell(2).value = value;
    }
    rowIndex += 1;
  }
  rowIndex += 1;
  ws.getRow(rowIndex).values = ['周期提醒'];
  rowIndex += 1;
  for (const alert of data.alerts) {
    ws.getRow(rowIndex).values = [alert];
    rowIndex += 1;
  }
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 28;
  for (const [name, recordRows] of Object.entries(data.records)) {
    const detail = wb.addWorksheet(name);
    detail.getRow(1).values = ['日期', '原始记录'];
    detail.getCell('A1').font = { bold: true };
    detail.getCell('B1').font = { bold: true };
    for (let i = 0; i < recordRows.length; i += 1) {
      detail.getRow(i + 2).values = [recordRows[i].date ?? '', pythonJson(recordRows[i].data)];
    }
    detail.getColumn(1).width = 16;
    detail.getColumn(2).width = 80;
  }
  const buffer = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(buffer),
    filename: `个人健康汇总-${data.period_start}-${data.period_end}.xlsx`,
  };
}

export function evaluateStartup(options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  void options;
  return [];
}
