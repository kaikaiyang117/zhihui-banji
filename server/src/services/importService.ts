/* MIG-05 学生 Excel 导入：模板 + 预览 + 按学号合并提交（整批回滚、故障行报告）。
 * 提供整批回滚和故障行报告。
 */
import ExcelJS from 'exceljs';

import { getDb } from './context.js';
import { enrollStudent, scopeIds } from './context.js';
import { STUDENT_COLUMNS } from '../config/sheets.js';
import { sheetBytes } from './exportXlsx.js';

const NORMALIZE: Record<string, string> = {
  '学号': '学号', '姓名': '姓名', '性别': '性别', '出生年月': '出生年月',
  '民族': '民族', '家庭住址': '家庭住址', '监护人姓名': '监护人姓名',
  '监护人电话': '监护人电话', '监护人关系': '监护人关系', '监护人职业': '监护人职业', '是否住校': '是否住校',
  '特长': '特长', '班级任职': '班级任职', '备注': '备注',
  '监护人2姓名': '监护人2姓名', '监护人2电话': '监护人2电话', '监护人2关系': '监护人2关系', '监护人2职业': '监护人2职业',
};

function norm(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'object' && value !== null && 'formula' in value) {
    return cellText((value as { result?: unknown }).result);
  }
  return String(value).trim();
}

export async function buildTemplate(): Promise<Buffer> {
  const rows: Array<Array<unknown>> = [[
    '2201', '张三', '男', '2010-05', '汉', '汶川县威州镇',
    '张大明', '13800000000', '父亲', '务农', '住校', '书法', '纪律委员', '',
    '李芳', '13900000000', '母亲', '护士',
  ]];
  return sheetBytes('学生信息', STUDENT_COLUMNS, rows);
}

export interface PreviewRow {
  row: number;
  action: '新增' | '更新' | '跳过';
  student_id: number | null;
  fields: Record<string, string>;
}

export interface ImportPreviewResult {
  filename: string;
  rows: PreviewRow[];
  errors: Array<{ row: number; msg: string }>;
  summary: { imported: number; updated: number; skipped: number; valid: number };
}

export async function previewStudents(fileBytes: Buffer, filename = '', duplicateStrategy = 'update'): Promise<ImportPreviewResult> {
  const conn = getDb().connInstance;
  const result: ImportPreviewResult = {
    filename, rows: [], errors: [], summary: { imported: 0, updated: 0, skipped: 0, valid: 0 },
  };
  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fileBytes);
  } catch (error) {
    result.errors = [{ row: 0, msg: `文件无法解析: ${(error as Error).message}` }];
    result.summary.skipped = 1;
    return result;
  }
  const ws = wb.worksheets[0];

  // 定位表头行（第一个包含「学号」「姓名」的行）
  let headerRow = -1;
  let colMap: Record<string, number> = {};
  const maxHeaderRow = Math.min(ws.rowCount, 10);
  for (let r = 1; r <= maxHeaderRow; r += 1) {
    const rowHdr: Record<string, number> = {};
    const row = ws.getRow(r);
    for (let c = 1; c <= ws.columnCount; c += 1) {
      const key = norm(row.getCell(c).value);
      if (!key) continue;
      const mapped = NORMALIZE[key];
      if (mapped) rowHdr[mapped] = c;
    }
    if (rowHdr.学号 && rowHdr.姓名) {
      headerRow = r;
      colMap = rowHdr;
      break;
    }
  }
  if (headerRow <= 0) {
    result.errors = [{ row: 1, msg: '未找到表头，需包含「学号」「姓名」列（列名不能带多余空格/换行）' }];
    result.summary.skipped = 1;
    return result;
  }

  const getVal = (r: number, key: string): string => {
    const c = colMap[key];
    if (!c) return '';
    return cellText(ws.getRow(r).getCell(c).value);
  };

  const seen = new Set<string>();
  const existingStmt = conn.prepare('SELECT id, deleted_at FROM students WHERE 学号=?');
  for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
    const 学号 = norm(getVal(r, '学号'));
    const 姓名 = norm(getVal(r, '姓名'));
    if (!学号 && !姓名) continue;
    if (!学号) {
      result.errors.push({ row: r, msg: `姓名「${姓名}」缺少学号，已跳过` });
      result.summary.skipped += 1;
      continue;
    }
    if (!姓名) {
      result.errors.push({ row: r, msg: `学号「${学号}」缺少姓名，已跳过` });
      result.summary.skipped += 1;
      continue;
    }
    if (seen.has(学号)) {
      result.errors.push({ row: r, msg: `学号「${学号}」在文件中重复，已跳过` });
      result.summary.skipped += 1;
      continue;
    }
    const fields: Record<string, string> = {};
    for (const key of STUDENT_COLUMNS) fields[key] = getVal(r, key);
    fields['学号'] = 学号;
    fields['姓名'] = 姓名;
    const existing = existingStmt.get(学号) as { id: number; deleted_at: string } | undefined;
    if (existing && existing.deleted_at) {
      result.errors.push({ row: r, msg: `学号「${学号}」位于回收站，请先恢复` });
      result.summary.skipped += 1;
      continue;
    }
    const action = existing && duplicateStrategy === 'skip' ? '跳过' : existing ? '更新' : '新增';
    result.rows.push({ row: r, action, student_id: existing ? Number(existing.id) : null, fields });
    if (action === '跳过') result.summary.skipped += 1;
    else if (existing) result.summary.updated += 1;
    else result.summary.imported += 1;
    seen.add(学号);
  }
  result.summary.valid = result.rows.length;
  return result;
}

export interface ImportCommitResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; msg: string }>;
}

export function commitStudentImport(
  rows: Array<{ row: number; fields: Record<string, string>; action?: string }>, filename = '', duplicateStrategy = 'update',
): ImportCommitResult {
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  const result: ImportCommitResult = { imported: 0, updated: 0, skipped: 0, errors: [] };
  const valid: Array<[number, Record<string, string>]> = [];
  const seen = new Set<string>();
  for (const item of rows ?? []) {
    const fields = item.fields ?? {};
    const 学号 = norm(fields['学号']);
    const 姓名 = norm(fields['姓名']);
    const rowNo = item.row ?? 0;
    if (!学号 || !姓名) {
      result.errors.push({ row: rowNo, msg: '学号和姓名不能为空，已跳过' });
      result.skipped += 1;
      continue;
    }
    if (seen.has(学号)) {
      result.errors.push({ row: rowNo, msg: `学号「${学号}」重复，已跳过` });
      result.skipped += 1;
      continue;
    }
    const normalized: Record<string, string> = {};
    for (const key of STUDENT_COLUMNS) normalized[key] = cellText(fields[key] ?? '');
    normalized['学号'] = 学号;
    normalized['姓名'] = 姓名;
    valid.push([rowNo, normalized]);
    seen.add(学号);
  }

  // 整批提交：任何一步抛错即回滚（better-sqlite3 显式事务）
  conn.transaction(() => {
    const existingStmt = conn.prepare('SELECT id, deleted_at FROM students WHERE 学号=?');
    const cols = STUDENT_COLUMNS.map((key) => `[${key}]`).join(',');
    const placeholders = STUDENT_COLUMNS.map(() => '?').join(',');
    const updates = STUDENT_COLUMNS.map((key) => `[${key}]=?`).join(',');
    for (const [rowNo, fields] of valid) {
      const values = STUDENT_COLUMNS.map((key) => fields[key]);
      const existing = existingStmt.get(fields['学号']) as { id: number; deleted_at: string } | undefined;
      if (existing && existing.deleted_at) {
        result.errors.push({ row: rowNo, msg: `学号「${fields['学号']}」位于回收站，请先恢复` });
        result.skipped += 1;
        continue;
      }
      if (existing && duplicateStrategy === 'skip') {
        result.skipped += 1;
        continue;
      }
      let studentId: number;
      if (existing) {
        conn.prepare(
          `UPDATE students SET ${updates}, updated_at=datetime('now','localtime') WHERE 学号=?`,
        ).run(...values, fields['学号']);
        result.updated += 1;
        studentId = Number(existing.id);
      } else {
        const inserted = conn.prepare(`INSERT INTO students(${cols}) VALUES(${placeholders})`).run(...values);
        studentId = Number(inserted.lastInsertRowid);
        result.imported += 1;
      }
      enrollStudent(studentId, { classId, termId, conn });
    }
    conn.prepare(
      `INSERT INTO student_import_runs
       (filename, imported, updated, skipped, error_count, class_id, term_id)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(filename || '', result.imported, result.updated, result.skipped, result.errors.length, classId, termId);
  })();
  return result;
}

export async function importStudents(fileBytes: Buffer, filename = ''): Promise<ImportCommitResult> {
  const preview = await previewStudents(fileBytes, filename);
  const result = commitStudentImport(preview.rows, filename);
  result.skipped += preview.summary.skipped;
  result.errors = [...preview.errors, ...result.errors];
  return result;
}
