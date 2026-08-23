import ExcelJS from 'exceljs';
import type { Database } from 'better-sqlite3';

import { getDb, getCurrentScope, scopeIds, type ScopeInfo } from './context.js';
import * as audit from './audit.js';
import { todayString } from './clock.js';

const DAY_TYPES = new Set(['上课日', '放假日', '调休上课', '考试日', '活动日', '其他']);
const CLASS_DAY_TYPES = new Set(['上课日', '调休上课', '考试日', '活动日']);
const MONTHS: Record<string, number> = {
  '一月': 1, '二月': 2, '三月': 3, '四月': 4, '五月': 5, '六月': 6,
  '七月': 7, '八月': 8, '九月': 9, '十月': 10, '十一月': 11, '十二月': 12,
};
const WEEKS: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7,
  '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12, '十三': 13,
  '十四': 14, '十五': 15, '十六': 16, '十七': 17, '十八': 18, '十九': 19,
  '二十': 20, '二十一': 21, '二十二': 22,
};
const WEEKDAY_COLUMNS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
const REST_WORDS = ['休', '放假', '假期', '春假', '寒假', '暑假', '清明', '劳动节', '端午', '国庆', '中秋'];
const EXAM_WORDS = ['考试', '高考', '中考', '合格考'];
const ACTIVITY_WORDS = ['报名', '典礼', '开学', '儿童节', '活动', '运动会', '培训'];

export class CalendarError extends Error {}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  return String(value).trim();
}

function norm(value: unknown): string {
  return text(value).replace(/\s+/g, '').toLowerCase();
}

function yearFromFilename(filename: string, fallback: number): number {
  const match = /(20\d{2})/.exec(String(filename ?? ''));
  return match ? Number(match[1]) : fallback;
}

function monthNumber(value: unknown): number | null {
  const textValue = text(value).replace(/ /g, '');
  for (const [name, number] of Object.entries(MONTHS)) {
    if (textValue.includes(name)) return number;
  }
  const match = /(?<!\d)(1[0-2]|[1-9])月/.exec(textValue);
  return match ? Number(match[1]) : null;
}

function weekNumber(value: unknown): number | null {
  const textValue = text(value).replaceAll('周', '').replaceAll('第', '').trim();
  if (/^\d+$/.test(textValue)) {
    const number = Number(textValue);
    return Number.isNaN(number) ? null : number;
  }
  const mapped = WEEKS[textValue];
  return mapped !== undefined ? mapped : null;
}

function formatDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new CalendarError(`非法日期：${year}-${month}-${day}`);
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDate(
  value: unknown, defaultYear: number, defaultMonth: number | null = null,
): string | null {
  const textValue = text(value);
  if (!textValue) return null;
  const full = /^(20\d{2})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})/.exec(textValue);
  if (full) return formatDate(Number(full[1]), Number(full[2]), Number(full[3]));
  const monthDay = /(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(textValue);
  if (monthDay) return formatDate(defaultYear, Number(monthDay[1]), Number(monthDay[2]));
  const slash = /(?<!\d)(\d{1,2})\s*[/-]\s*(\d{1,2})(?!\d)/.exec(textValue);
  if (slash && defaultMonth === null) return formatDate(defaultYear, Number(slash[1]), Number(slash[2]));
  if (defaultMonth !== null) {
    const digits = /(?<!\d)(\d{1,2})(?!\d)/.exec(textValue);
    if (digits) return formatDate(defaultYear, defaultMonth, Number(digits[1]));
  }
  return null;
}
function titleFromCell(value: unknown): string {
  const textValue = text(value);
  if (!textValue) return '';
  const titles: string[] = [];
  for (const rawLine of textValue.split(/[\r\n]+/)) {
    let line = rawLine.trim();
    if (!line) continue;
    line = line.replace(/^(?:一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月|\d{1,2}月)\/?\d{1,2}/, '');
    line = line.replace(/^\d{1,2}月/, '');
    line = line.replace(/^\d{1,2}(?=[^\d])/, '');
    line = line.replace(/(?<=[^\d])\d{1,2}$/, '');
    line = line.replace(/[（(]\s*休\s*[）)]/g, '');
    line = line.replace(/^[ \/_-]+|[ \/_-]+$/g, '');
    if (/^\d{1,2}$/.test(line)) continue;
    if (line && !titles.includes(line)) titles.push(line);
  }
  return titles.join('、');
}

function inferDayType(raw: string, weekday: number, explicit = ''): [string, boolean] {
  const explicitText = text(explicit);
  if (DAY_TYPES.has(explicitText)) {
    return [explicitText, CLASS_DAY_TYPES.has(explicitText)];
  }
  const textValue = text(raw);
  if (textValue.includes('调休') || textValue.includes('上班') || textValue.includes('补课')) {
    return ['调休上课', true];
  }
  if (EXAM_WORDS.some((word) => textValue.includes(word))) return ['考试日', true];
  if (REST_WORDS.some((word) => textValue.includes(word))) return ['放假日', false];
  if (ACTIVITY_WORDS.some((word) => textValue.includes(word))) return ['活动日', true];
  if (weekday >= 5) return ['放假日', false];
  return ['上课日', true];
}

function boolValue(value: unknown, fallback: boolean): boolean {
  const textValue = text(value).toLowerCase();
  if (!textValue) return fallback;
  if (new Set(['1', 'true', 'yes', '是', '上课', '工作日']).has(textValue)) return true;
  if (new Set(['0', 'false', 'no', '否', '不上课', '休息日']).has(textValue)) return false;
  return fallback;
}

function scopeOf(options: { write?: boolean; conn?: Database } = {}): [number, number, number, ScopeInfo] {
  const scope = getCurrentScope(options);
  return [Number(scope.class_id), Number(scope.term_id), Number(scope.academic_term_id), scope];
}

function termBound(value: unknown): string | null {
  const textValue = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(textValue) ? textValue : null;
}

function termBounds(scope: ScopeInfo): [string | null, string | null] {
  return [termBound(scope.start_date), termBound(scope.end_date)];
}

function isoWeekday(iso: string): number {
  const date = new Date(`${iso}T00:00:00Z`);
  return (date.getUTCDay() + 6) % 7;
}

function isoString(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoString(date);
}

function diffDays(a: string, b: string): number {
  const dateA = new Date(`${a}T00:00:00Z`);
  const dateB = new Date(`${b}T00:00:00Z`);
  return Math.round((dateA.getTime() - dateB.getTime()) / 86_400_000);
}

function entryFromParts(
  calendarDate: string, raw: string,
  options: { row: number; source?: string; explicitType?: string; explicitSchoolDay?: unknown; note?: string },
): Record<string, unknown> {
  const [dayType, schoolDayDefault] = inferDayType(raw, isoWeekday(calendarDate), options.explicitType ?? '');
  const schoolDay = boolValue(options.explicitSchoolDay, schoolDayDefault);
  return {
    row: options.row,
    date: calendarDate,
    day_type: dayType,
    title: titleFromCell(raw),
    is_school_day: schoolDay,
    note: text(options.note ?? ''),
    source: options.source ?? 'import',
  };
}

function matrixRows(ws: ExcelJS.Worksheet, filename: string, _scope: ScopeInfo): Array<Record<string, unknown>> {
  let header = 0;
  for (let r = 1; r <= Math.min(ws.rowCount, 12); r += 1) {
    const values: string[] = [];
    for (let c = 1; c <= Math.min(ws.columnCount, 10); c += 1) {
      values.push(norm(ws.getRow(r).getCell(c).value));
    }
    if (values.includes('月份') && values.includes('周次')
      && WEEKDAY_COLUMNS.every((item) => values.includes(norm(item)))) {
      header = r;
      break;
    }
  }
  if (!header) return [];

  const fallbackYear = yearFromFilename(filename, Number(todayString().slice(0, 4)));
  let currentMonth: number | null = null;
  let firstWeek: number | null = null;
  let firstDay: number | null = null;
  let firstCol: number | null = null;
  const weekRows: Array<[number, number, number | null, string[]]> = [];
  for (let r = header + 1; r <= ws.rowCount; r += 1) {
    const month = monthNumber(text(ws.getRow(r).getCell(1).value));
    if (month !== null) currentMonth = month;
    const cells: string[] = [];
    for (let c = 3; c <= 9; c += 1) cells.push(text(ws.getRow(r).getCell(c).value));
    if (!cells.some((cell) => cell)) continue;
    let week = weekNumber(text(ws.getRow(r).getCell(2).value));
    if (week === null) week = weekRows.length > 0 ? weekRows[weekRows.length - 1][0] + 1 : null;
    if (week === null) continue;
    weekRows.push([week, r, currentMonth, cells]);
    if (firstWeek === null) {
      for (let index = 0; index < cells.length; index += 1) {
        const match = /(?<!\d)(\d{1,2})(?!\d)/.exec(cells[index]);
        if (match && currentMonth !== null) {
          firstWeek = week;
          firstDay = Number(match[1]);
          firstCol = index;
          break;
        }
      }
    }
  }
  if (firstWeek === null || firstDay === null || firstCol === null) {
    throw new CalendarError('未能从校历矩阵识别首周日期，请检查月份、周次和星期列');
  }

  const firstDate = formatDate(fallbackYear, weekRows[0][2] ?? 1, firstDay);
  const baseMonday = addDays(firstDate, -firstCol);
  const rows: Array<Record<string, unknown>> = [];
  for (const [week, row, , cells] of weekRows) {
    for (let index = 0; index < cells.length; index += 1) {
      const raw = cells[index];
      if (!raw) continue;
      const calendarDate = addDays(baseMonday, (week - firstWeek) * 7 + index);
      rows.push(entryFromParts(calendarDate, raw, { row }));
    }
  }
  return rows;
}
function flatRows(ws: ExcelJS.Worksheet, filename: string): Array<Record<string, unknown>> {
  const aliases: Record<string, string> = {
    '日期': 'date', '日历日期': 'date', 'calendar_date': 'date', '开始日期': 'start_date',
    '结束日期': 'end_date', '类型': 'day_type', '日期类型': 'day_type', '安排类型': 'day_type',
    '事项': 'title', '安排': 'title', '内容': 'title', '名称': 'title', '备注': 'note',
    '是否上课': 'is_school_day', '是否行课': 'is_school_day',
  };
  const mapping: Record<string, number> = {};
  let header = 0;
  for (let r = 1; r <= Math.min(ws.rowCount, 12); r += 1) {
    for (let c = 1; c <= ws.columnCount; c += 1) {
      const key = norm(ws.getRow(r).getCell(c).value);
      const mapped = aliases[key];
      if (mapped) mapping[mapped] = c;
    }
    if (mapping.date !== undefined || mapping.start_date !== undefined) {
      header = r;
      break;
    }
  }
  if (!header) return [];
  const year = yearFromFilename(filename, Number(todayString().slice(0, 4)));
  const rows: Array<Record<string, unknown>> = [];
  for (let r = header + 1; r <= ws.rowCount; r += 1) {
    const value = (key: string): unknown => {
      const col = mapping[key];
      return col ? ws.getRow(r).getCell(col).value : '';
    };
    const start = parseDate(value('date') || value('start_date'), year);
    if (!start) continue;
    const end = parseDate(value('end_date'), year) ?? start;
    if (end < start || diffDays(end, start) > 366) {
      throw new CalendarError(`第 ${r} 行的日期范围不合法`);
    }
    const raw = `${text(value('title'))} ${text(value('day_type'))}`.trim();
    for (let offset = 0; offset <= diffDays(end, start); offset += 1) {
      rows.push(entryFromParts(
        addDays(start, offset), raw, {
          row: r,
          explicitType: text(value('day_type')),
          explicitSchoolDay: value('is_school_day'),
          note: text(value('note')),
        },
      ));
    }
  }
  return rows;
}

async function parseWorkbook(
  fileBytes: Buffer, filename: string, scope: ScopeInfo,
): Promise<[string, Array<Record<string, unknown>>]> {
  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fileBytes);
  } catch (error) {
    throw new CalendarError(`文件无法解析：${(error as Error).message}`);
  }
  for (const worksheet of wb.worksheets) {
    const matrix = matrixRows(worksheet, filename, scope);
    if (matrix.length > 0) return ['matrix', matrix];
    const flat = flatRows(worksheet, filename);
    if (flat.length > 0) return ['flat', flat];
  }
  throw new CalendarError('未识别到校历数据。支持“月份/周次/星期一至星期日”矩阵，或包含日期列的明细表。');
}

export interface CalendarImportPreviewResult {
  filename: string;
  format: string;
  rows: Array<Record<string, unknown>>;
  errors: Array<{ row: number; message: string }>;
  term: { name: string; start_date: string; end_date: string };
  summary: {
    parsed: number; valid: number; new: number; update: number; skip: number;
    conflict: number; out_of_term: number; error: number;
  };
}

export async function previewImport(fileBytes: Buffer, filename = ''): Promise<CalendarImportPreviewResult> {
  const conn = getDb().connInstance;
  const [, , academicTermId, scope] = scopeOf({ conn });
  const result: CalendarImportPreviewResult = {
    filename,
    format: '',
    rows: [],
    errors: [],
    term: { name: scope.term_name, start_date: scope.start_date, end_date: scope.end_date },
    summary: { parsed: 0, valid: 0, new: 0, update: 0, skip: 0, conflict: 0, out_of_term: 0, error: 0 },
  };
  let formatName: string;
  let parsed: Array<Record<string, unknown>>;
  try {
    [formatName, parsed] = await parseWorkbook(fileBytes, filename, scope);
  } catch (error) {
    if (error instanceof CalendarError) {
      result.errors = [{ row: 0, message: error.message }];
      result.summary.error = 1;
      return result;
    }
    throw error;
  }
  result.format = formatName;
  result.summary.parsed = parsed.length;
  const [start, end] = termBounds(scope);
  const existing = new Map<string, Record<string, unknown>>();
  for (const row of conn.prepare(
    'SELECT * FROM school_calendar_days WHERE academic_term_id=? ORDER BY calendar_date',
  ).all(academicTermId) as Array<Record<string, unknown>>) {
    existing.set(String(row.calendar_date), row);
  }
  const seen = new Map<string, Record<string, unknown>>();
  for (const item of parsed) {
    const dateText = String(item.date);
    const current = existing.get(dateText);
    const duplicate = seen.get(dateText);
    const outOfTerm = Boolean((start && dateText < start) || (end && dateText > end));
    const conflict = Boolean(duplicate && ['day_type', 'title', 'is_school_day', 'note']
      .some((key) => item[key] !== duplicate[key]));
    let action = current ? '更新' : '新增';
    let error = '';
    if (conflict) {
      action = '冲突';
      error = `同一文件第 ${duplicate!.row} 行与第 ${item.row} 行对同一天有不同安排`;
      result.summary.conflict += 1;
    } else if (current && ['day_type', 'title', 'is_school_day', 'note']
      .every((key) => String(current[key] || '') === String(item[key] || ''))) {
      action = '跳过';
      result.summary.skip += 1;
    } else if (current) {
      result.summary.update += 1;
    } else {
      result.summary.new += 1;
    }
    if (outOfTerm) result.summary.out_of_term += 1;
    result.rows.push({ ...item, action, valid: !conflict, out_of_term: outOfTerm, error });
    if (!seen.has(dateText)) seen.set(dateText, item);
  }
  result.summary.valid = result.rows.filter((row) => row.valid && row.action !== '跳过').length;
  return result;
}

interface ValidatedEntry {
  date: string;
  day_type: string;
  title: string;
  is_school_day: number;
  note: string;
  row: number;
}

function validateEntry(item: Record<string, unknown>): ValidatedEntry {
  const calendarDate = parseDate(item.date || item.calendar_date, Number(todayString().slice(0, 4)));
  if (!calendarDate) throw new CalendarError('校历日期不能为空且必须是 YYYY-MM-DD');
  const dayType = text(item.day_type) || '上课日';
  if (!DAY_TYPES.has(dayType)) throw new CalendarError(`不支持的日期类型：${dayType}`);
  return {
    date: calendarDate,
    day_type: dayType,
    title: text(item.title),
    is_school_day: boolValue(item.is_school_day, dayType !== '放假日') ? 1 : 0,
    note: text(item.note),
    row: Number(item.row ?? 0),
  };
}

function calendarRequestId(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const micros = String((Date.now() * 1000) % 1_000_000).padStart(6, '0');
  return `calendar-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${micros}`;
}
export function commitImport(
  rows: Array<Record<string, unknown>>, filename = '', requestId = '',
): Record<string, unknown> {
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  const academicTermId = Number((conn.prepare(
    'SELECT academic_term_id FROM terms WHERE id=? AND class_id=?',
  ).get(termId, classId) as { academic_term_id: number }).academic_term_id);
  const normalizedRequestId = text(requestId) || calendarRequestId();
  const previous = conn.prepare(
    `SELECT imported, updated, skipped, conflict_count, error_count
     FROM school_calendar_import_runs WHERE academic_term_id=? AND request_id=?`,
  ).get(academicTermId, normalizedRequestId) as Record<string, unknown> | undefined;
  if (previous) {
    return {
      idempotent: true,
      imported: Number(previous.imported),
      updated: Number(previous.updated),
      skipped: Number(previous.skipped),
      conflict_count: Number(previous.conflict_count),
      error_count: Number(previous.error_count),
      errors: [],
    };
  }
  const result = {
    imported: 0,
    updated: 0,
    skipped: 0,
    conflict_count: 0,
    error_count: 0,
    errors: [] as Array<{ row: number; message: string }>,
  };
  const seen = new Set<string>();
  conn.transaction(() => {
    for (const raw of rows ?? []) {
      if (!(raw.valid ?? true) || raw.action === '冲突') {
        result.conflict_count += 1;
        continue;
      }
      let item: ValidatedEntry;
      try {
        item = validateEntry(raw);
      } catch (error) {
        if (error instanceof CalendarError) {
          result.error_count += 1;
          result.errors.push({ row: Number(raw.row ?? 0), message: error.message });
          continue;
        }
        throw error;
      }
      if (seen.has(item.date)) {
        result.conflict_count += 1;
        continue;
      }
      seen.add(item.date);
      const current = conn.prepare(
        `SELECT id, day_type, title, is_school_day, note FROM school_calendar_days
         WHERE academic_term_id=? AND calendar_date=?`,
      ).get(academicTermId, item.date) as Record<string, unknown> | undefined;
      if (current && ['day_type', 'title', 'is_school_day', 'note']
        .every((key) => String(current[key] || '') === String((item as unknown as Record<string, unknown>)[key] || ''))) {
        result.skipped += 1;
        continue;
      }
      if (current) {
        conn.prepare(
          `UPDATE school_calendar_days SET day_type=?, title=?, is_school_day=?, note=?,
           source='import', source_filename=?, source_row=?, updated_at=datetime('now','localtime')
           WHERE id=?`,
        ).run(item.day_type, item.title, item.is_school_day, item.note, filename || '', item.row, Number(current.id));
        result.updated += 1;
      } else {
        conn.prepare(
          `INSERT INTO school_calendar_days
           (academic_term_id, calendar_date, day_type, title, is_school_day, note, source, source_filename, source_row)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        ).run(
          academicTermId, item.date, item.day_type, item.title, item.is_school_day, item.note,
          'import', filename || '', item.row,
        );
        result.imported += 1;
      }
    }
    conn.prepare(
      `INSERT INTO school_calendar_import_runs
       (academic_term_id, request_id, filename, imported, updated, skipped, conflict_count, error_count)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      academicTermId, normalizedRequestId, filename || '',
      result.imported, result.updated, result.skipped, result.conflict_count, result.error_count,
    );
    audit.record('school_calendar', normalizedRequestId, 'import', {
      summary: '导入校历',
      params: {
        filename: filename || '', imported: result.imported, updated: result.updated,
        skipped: result.skipped, conflicts: result.conflict_count,
      },
      classId, termId, conn, commit: false,
    });
  })();
  return result;
}

export function listCalendar(dateFrom = '', dateTo = '', month = ''): Record<string, unknown> {
  const conn = getDb().connInstance;
  const [classId, termId, academicTermId, scope] = scopeOf({ conn });
  let from = text(dateFrom).slice(0, 10);
  let to = text(dateTo).slice(0, 10);
  if (month && /^20\d{2}-\d{2}$/.test(month)) {
    from = `${month}-01`;
    const monthValue = Number(month.slice(5, 7));
    if (monthValue < 1 || monthValue > 12) {
      throw new Error('月份参数不合法');
    }
    const date28 = new Date(Date.UTC(Number(month.slice(0, 4)), monthValue - 1, 28));
    date28.setUTCDate(date28.getUTCDate() + 4);
    date28.setUTCDate(1);
    date28.setUTCDate(date28.getUTCDate() - 1);
    to = isoString(date28);
  }
  const where = ['academic_term_id=?'];
  const params: unknown[] = [academicTermId];
  if (from) {
    where.push('calendar_date>=?');
    params.push(from);
  }
  if (to) {
    where.push('calendar_date<=?');
    params.push(to);
  }
  const rows = conn.prepare(
    'SELECT * FROM school_calendar_days WHERE ' + where.join(' AND ') + ' ORDER BY calendar_date',
  ).all(...params) as Array<Record<string, unknown>>;
  for (const row of rows) row.is_school_day = Boolean(row.is_school_day);
  return {
    scope: {
      class_id: classId, term_id: termId, term_name: scope.term_name,
      start_date: scope.start_date, end_date: scope.end_date,
    },
    entries: rows,
    summary: {
      total: rows.length,
      school_days: rows.filter((row) => row.is_school_day).length,
      non_school_days: rows.filter((row) => !row.is_school_day).length,
      events: rows.filter((row) => row.title).length,
    },
  };
}

export function termCalendar(): Record<string, unknown> {
  const conn = getDb().connInstance;
  const [classId, termId, academicTermId, scope] = scopeOf({ conn });
  const rows = conn.prepare(
    'SELECT * FROM school_calendar_days WHERE academic_term_id=? ORDER BY calendar_date',
  ).all(academicTermId) as Array<Record<string, unknown>>;
  for (const row of rows) row.is_school_day = Boolean(row.is_school_day);

  const [scopeStart, scopeEnd] = termBounds(scope);
  let start = scopeStart;
  let end = scopeEnd;
  if (!start || !end) {
    if (rows.length > 0) {
      start = String(rows[0].calendar_date);
      end = String(rows[rows.length - 1].calendar_date);
    } else {
      return {
        scope: {
          class_id: classId, term_id: termId, term_name: scope.term_name,
          start_date: scope.start_date, end_date: scope.end_date,
        },
        weeks: [],
        entries: [],
        summary: {
          total: 0, recorded: 0, unrecorded: 0, school_days: 0,
          non_school_days: 0, special_days: 0, week_count: 0, current_week: 0,
        },
      };
    }
  }
  if (end < start) throw new CalendarError('当前学期的结束日期不能早于开始日期');
  const scopeView = {
    class_id: classId, term_id: termId, term_name: scope.term_name,
    start_date: start, end_date: end,
  };

  const byDate = new Map<string, Record<string, unknown>>();
  for (const row of rows) byDate.set(String(row.calendar_date), row);
  const firstMonday = addDays(start, -isoWeekday(start));
  const lastSunday = addDays(end, 6 - isoWeekday(end));
  const today = todayString();
  const weeks: Array<Record<string, unknown>> = [];
  const days: Array<Record<string, unknown>> = [];
  let cursor = firstMonday;
  let weekNo = 1;
  while (cursor <= lastSunday) {
    const weekDays: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const current = addDays(cursor, offset);
      const inTerm = start <= current && current <= end;
      const entry = byDate.get(current);
      const weekday = isoWeekday(current);
      const day: Record<string, unknown> = {
        date: current,
        day: Number(current.slice(8, 10)),
        weekday,
        weekday_label: WEEKDAY_COLUMNS[weekday],
        week_no: weekNo,
        in_term: inTerm,
        is_today: current === today,
        recorded: Boolean(entry),
        day_type: entry ? entry.day_type : (weekday >= 5 ? '周末' : '未设置'),
        title: entry ? String(entry.title ?? '') : '',
        note: entry ? String(entry.note ?? '') : '',
        is_school_day: entry ? Boolean(entry.is_school_day) : false,
        entry: entry ?? null,
      };
      weekDays.push(day);
      if (inTerm) days.push(day);
    }
    const weekEnd = addDays(cursor, 6);
    weeks.push({
      week_no: weekNo,
      start_date: cursor > start ? cursor : start,
      end_date: weekEnd < end ? weekEnd : end,
      is_current: start <= today && today <= end && cursor <= today && today <= weekEnd,
      days: weekDays,
    });
    cursor = addDays(cursor, 7);
    weekNo += 1;
  }
  const specialDays = days.filter((day) => day.recorded && (
    day.title || !['上课日', '放假日'].includes(String(day.day_type))
  ));
  const currentWeek = Number(weeks.find((week) => week.is_current)?.week_no ?? 0);
  return {
    scope: scopeView,
    weeks,
    entries: rows,
    summary: {
      total: days.length,
      recorded: days.filter((day) => day.recorded).length,
      unrecorded: days.filter((day) => !day.recorded).length,
      school_days: days.filter((day) => day.recorded && day.is_school_day).length,
      non_school_days: days.filter((day) => day.recorded && !day.is_school_day).length,
      special_days: specialDays.length,
      week_count: weeks.length,
      current_week: currentWeek,
    },
  };
}

function saveEntry(
  entryId: number | null, calendarDate: string, dayType: string, title: string,
  isSchoolDay: boolean, note: string,
): { id: number } {
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  const academicTermId = Number((conn.prepare(
    'SELECT academic_term_id FROM terms WHERE id=? AND class_id=?',
  ).get(termId, classId) as { academic_term_id: number }).academic_term_id);
  const item = validateEntry({
    date: calendarDate, day_type: dayType, title, is_school_day: isSchoolDay, note,
  });
  return conn.transaction(() => {
    let resultId: number;
    if (entryId) {
      const current = conn.prepare(
        'SELECT id FROM school_calendar_days WHERE id=? AND academic_term_id=?',
      ).get(entryId, academicTermId) as { id: number } | undefined;
      if (!current) throw new CalendarError('校历记录不存在');
      conn.prepare(
        `UPDATE school_calendar_days SET calendar_date=?, day_type=?, title=?, is_school_day=?, note=?,
         source='manual', source_filename='', source_row=NULL, updated_at=datetime('now','localtime')
         WHERE id=?`,
      ).run(item.date, item.day_type, item.title, item.is_school_day, item.note, entryId);
      resultId = entryId;
    } else {
      const inserted = conn.prepare(
        `INSERT INTO school_calendar_days(academic_term_id, calendar_date, day_type, title, is_school_day, note, source)
         VALUES(?,?,?,?,?,?, 'manual')`,
      ).run(academicTermId, item.date, item.day_type, item.title, item.is_school_day, item.note);
      resultId = Number(inserted.lastInsertRowid);
    }
    audit.record('school_calendar', resultId, entryId ? 'update' : 'create', {
      summary: '修改校历日期',
      params: {
        date: item.date, day_type: item.day_type, title: item.title,
        is_school_day: Boolean(item.is_school_day),
      },
      classId, termId, conn, commit: false,
    });
    return { id: resultId };
  })();
}

export function createEntry(
  calendarDate: string, dayType = '上课日', title = '', isSchoolDay = true, note = '',
): { id: number } {
  return saveEntry(null, calendarDate, dayType, title, isSchoolDay, note);
}

export function updateEntry(
  entryId: number, calendarDate: string, dayType = '上课日', title = '',
  isSchoolDay = true, note = '',
): { id: number } {
  return saveEntry(Number(entryId), calendarDate, dayType, title, isSchoolDay, note);
}

export function queryCalendar(dateFrom = '', dateTo = '', dayType = '', limit = 100): Record<string, unknown> {
  const data = listCalendar(dateFrom, dateTo);
  const entries = (data.entries as Array<Record<string, unknown>>)
    .filter((row) => !dayType || String(row.day_type) === String(dayType).trim());
  const capped = Math.max(1, Math.min(Number(limit), 200));
  return {
    date_from: text(dateFrom).slice(0, 10),
    date_to: text(dateTo).slice(0, 10),
    day_type: text(dayType),
    entries: entries.slice(0, capped),
    count: entries.slice(0, capped).length,
    total_count: entries.length,
    truncated: entries.length > capped,
  };
}
