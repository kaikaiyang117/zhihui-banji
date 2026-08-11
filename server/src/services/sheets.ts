/* MIG-05 通用工作表：元数据、行数据、派生列与考勤兼容视图。
 * 提供元数据、行数据、派生列与考勤兼容视图。
 */
import { getDb, scopeIds } from './context.js';
import * as audit from './audit.js';
import { SHEET_META } from '../config/sheets.js';
export { SHEET_META };

export class SheetError extends Error {}

function personalSheet(sheet: string): boolean {
  return SHEET_META[sheet]?.group === 'personal';
}

export function getSheetMeta(sheet: string): { sheet: string; headers: string[]; category: string; group: string } | null {
  const row = getDb().connInstance.prepare('SELECT * FROM sheet_meta WHERE sheet=?').get(sheet) as
    { headers: string; category: string; group_name: string } | undefined;
  if (!row) return null;
  let headers: string[] = [];
  try {
    headers = JSON.parse(row.headers) as string[];
  } catch {
    headers = [];
  }
  return { sheet, headers, category: row.category, group: row.group_name };
}

export function setSheetMeta(
  sheet: string, headers: string[], category = '', groupName = 'teacher',
): void {
  getDb().connInstance.prepare(
    'INSERT OR REPLACE INTO sheet_meta(sheet, headers, category, group_name) VALUES(?,?,?,?)',
  ).run(sheet, JSON.stringify(headers), category, groupName);
}

export interface SheetRow {
  row_no: number;
  data: unknown[];
  created_at: string;
  updated_at: string;
}

export function getRows(sheet: string): SheetRow[] {
  const conn = getDb().connInstance;
  let rows;
  if (personalSheet(sheet)) {
    rows = conn.prepare(
      "SELECT row_no, data, created_at, updated_at FROM sheet_rows "
      + "WHERE sheet=? AND deleted_at='' ORDER BY row_no",
    ).all(sheet);
  } else {
    const [classId, termId] = scopeIds({ conn });
    rows = conn.prepare(
      "SELECT row_no, data, created_at, updated_at FROM sheet_rows "
      + "WHERE sheet=? AND class_id=? AND term_id=? AND deleted_at='' ORDER BY row_no",
    ).all(sheet, classId, termId);
  }
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    row_no: Number(row.row_no),
    data: JSON.parse(String(row.data)) as unknown[],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));
}

export function insertRow(sheet: string, data: unknown[]): number {
  const conn = getDb().connInstance;
  const write = !personalSheet(sheet);
  const [classId, termId] = scopeIds({ write, conn });
  const rowNo = (conn.prepare(
    'SELECT COALESCE(MAX(row_no),0)+1 AS n FROM sheet_rows WHERE sheet=?',
  ).get(sheet) as { n: number }).n;
  conn.prepare(
    'INSERT INTO sheet_rows(sheet, row_no, data, class_id, term_id) VALUES(?,?,?,?,?)',
  ).run(sheet, rowNo, JSON.stringify(data), classId, termId);
  return rowNo;
}

export function updateCell(sheet: string, rowNo: number, col: number, value: unknown): void {
  const conn = getDb().connInstance;
  const write = !personalSheet(sheet);
  const [classId, termId] = scopeIds({ write, conn });
  const rows = getRows(sheet);
  const target = rows.find((row) => row.row_no === rowNo);
  if (!target) throw new SheetError(`行 ${rowNo} 不存在`);
  const data = [...target.data];
  while (data.length <= col) data.push(null);
  data[col] = value;
  if (personalSheet(sheet)) {
    conn.prepare(
      "UPDATE sheet_rows SET data=?, updated_at=datetime('now','localtime') "
      + "WHERE sheet=? AND row_no=? AND deleted_at=''",
    ).run(JSON.stringify(data), sheet, rowNo);
  } else {
    conn.prepare(
      "UPDATE sheet_rows SET data=?, updated_at=datetime('now','localtime') "
      + "WHERE sheet=? AND row_no=? AND class_id=? AND term_id=? AND deleted_at=''",
    ).run(JSON.stringify(data), sheet, rowNo, classId, termId);
  }
}

export function listSheets(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [sheet, meta] of Object.entries(SHEET_META)) {
    const dbMeta = getSheetMeta(sheet);
    out.push({
      name: sheet,
      category: meta.category,
      group: meta.group,
      headers: dbMeta ? dbMeta.headers : [],
    });
  }
  return out;
}

/** 考勤管理兼容视图：从结构化 attendance_records 渲染旧九列布局（与 Python 一致）。 */
export function attendanceCompatibilityRows(): SheetRow[] {
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const rows = conn.prepare(
    `SELECT a.*, s.学号, s.姓名 AS student_name
     FROM attendance_records a JOIN students s ON s.id=a.student_id
     WHERE a.class_id=? AND a.term_id=? AND a.deleted_at='' ORDER BY a.attendance_date, a.id`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const weekday = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  return rows.map((row) => {
    let day = '';
    const dateText = String(row.attendance_date ?? '');
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
    if (match) {
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      // getDay() 周日起始（0=周日），列表为周一起始，转换后对齐 Python date.weekday()
      day = weekday[(date.getDay() + 6) % 7];
    }
    return {
      row_no: Number(row.id),
      data: [row.attendance_date, day, row.学号, row.student_name,
        row.status, row.arrive_at, row.leave_at, row.reason, row.note, row.scene],
      created_at: '',
      updated_at: '',
    };
  });
}

/* ---------------- 派生列 ---------------- */

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const parsed = Number(String(value).trim());
  return Number.isNaN(parsed) ? null : parsed;
}

function cell(data: unknown[], index: number): unknown {
  return index < data.length ? data[index] : null;
}

function deriveScoreRows(rows: SheetRow[]): SheetRow[] {
  return rows.map((r) => {
    const d = [...r.data];
    let yk = 0;
    for (let i = 2; i < 8; i += 1) {
      const v = num(cell(d, i));
      if (v !== null) yk += v;
    }
    let qz = 0;
    for (let i = 10; i < 16; i += 1) {
      const v = num(cell(d, i));
      if (v !== null) qz += v;
    }
    const rank1 = num(cell(d, 9));
    const rank2 = num(cell(d, 17));
    const change = rank1 !== null && rank2 !== null ? rank1 - rank2 : null;
    if (yk) d[8] = yk;
    if (qz) d[16] = qz;
    d[18] = change;
    return { ...r, data: d };
  });
}

function derivePointRows(rows: SheetRow[]): SheetRow[] {
  const out = rows.map((r) => {
    const d = [...r.data];
    let total = 0;
    for (let i = 2; i < 10; i += 1) {
      const v = num(cell(d, i));
      if (v !== null) total += v;
    }
    d[10] = total ? Math.trunc(total) : null;
    return { ...r, data: d };
  });
  out.sort((a, b) => (num(cell(b.data, 10)) ?? 0) - (num(cell(a.data, 10)) ?? 0));
  out.forEach((r, index) => {
    if (num(cell(r.data, 10))) r.data[11] = index + 1;
  });
  return out;
}

function deriveFundRows(rows: SheetRow[]): SheetRow[] {
  let balance = 0;
  return rows.map((r) => {
    const d = [...r.data];
    const type = String(cell(d, 1) ?? '').trim();
    const amount = num(cell(d, 2));
    if (amount !== null) {
      if (type.includes('收入')) balance += amount;
      else if (type.includes('支出')) balance -= amount;
    }
    d[6] = Math.round(balance * 100) / 100;
    return { ...r, data: d };
  });
}

function deriveWeightRows(rows: SheetRow[]): SheetRow[] {
  let prevWeight: number | null = null;
  return rows.map((r) => {
    const d = [...r.data];
    const waist = num(cell(d, 5));
    const hip = num(cell(d, 6));
    d[7] = waist && hip ? Math.round((waist / hip) * 100) / 100 : null;
    const weight = num(cell(d, 2));
    if (weight !== null && prevWeight !== null) {
      d[8] = Math.round((weight - prevWeight) * 10) / 10;
    }
    prevWeight = weight !== null ? weight : prevWeight;
    return { ...r, data: d };
  });
}

const DERIVERS: Record<string, (rows: SheetRow[]) => SheetRow[]> = {
  '成绩跟踪': deriveScoreRows,
  '日常行为积分': derivePointRows,
  '班费管理': deriveFundRows,
  '体重体脂追踪': deriveWeightRows,
};

export function derive(sheet: string, rows: SheetRow[]): SheetRow[] {
  const fn = DERIVERS[sheet];
  return fn ? fn(rows) : rows;
}

export function recordSheetAudit(
  objectType: string, objectId: string, action: string, summary: string, params: Record<string, unknown>,
): void {
  audit.record(objectType, objectId, action, { summary, params });
}
