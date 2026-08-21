import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

import { loadConfig } from '../config/index.js';
import * as audit from './audit.js';
import { previewStudents, commitStudentImport } from './importService.js';
import * as scores from './scores.js';
import * as timetable from './timetable.js';
import * as calendar from './schoolCalendar.js';

export class ExcelImportError extends Error {}

export const SUPPORTED_MODULES = ['students', 'scores', 'calendar', 'timetable'] as const;
export type SupportedModule = typeof SUPPORTED_MODULES[number];

const EXPIRE_MINUTES = 30;

interface FileMetadata {
  file_id: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  owner: string;
  channel: string;
  session: string;
  created_at: string;
  expires_at: string;
  sheets: string[];
  headers: string[][];
  row_counts: number[];
  sample_rows: unknown[][];
  candidate_modules: Array<{ module: string; confidence: number; reason: string }>;
  preview_state: Record<string, unknown> | null;
}

function tempDir(): string {
  const config = loadConfig();
  const dir = path.join(config.dataDir, 'excel-temp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function nowIso(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function expiresAtIso(): string {
  const now = new Date(Date.now() + EXPIRE_MINUTES * 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'object' && value !== null && 'formula' in value) return '';
  return String(value).trim();
}

function sanitizeSample(value: unknown): unknown {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 50 ? trimmed.slice(0, 50) + '…' : trimmed;
  }
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return '';
}

async function readExcelMetadata(buffer: Buffer): Promise<{
  sheets: string[];
  headers: string[][];
  row_counts: number[];
  sample_rows: unknown[][];
}> {
  const result = {
    sheets: [] as string[],
    headers: [] as string[][],
    row_counts: [] as number[],
    sample_rows: [] as unknown[][],
  };

  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
  } catch {
    return result;
  }

  for (const ws of wb.worksheets) {
    result.sheets.push(ws.name);
    const headerRow: string[] = [];
    const maxCol = Math.min(ws.columnCount, 50);
    if (ws.rowCount > 0) {
      const row = ws.getRow(1);
      for (let c = 1; c <= maxCol; c += 1) {
        headerRow.push(cellText(row.getCell(c).value));
      }
    }
    result.headers.push(headerRow);
    result.row_counts.push(Math.max(0, ws.rowCount - 1));
    const samples: unknown[][] = [];
    for (let r = 2; r <= Math.min(ws.rowCount, 4); r += 1) {
      const sample: unknown[] = [];
      const row = ws.getRow(r);
      for (let c = 1; c <= maxCol; c += 1) {
        sample.push(sanitizeSample(row.getCell(c).value));
      }
      samples.push(sample);
    }
    result.sample_rows.push(samples);
  }

  return result;
}

const STUDENT_ALIASES = new Set([
  '学号', '姓名', '性别', '出生年月', '民族', '家庭住址',
  '监护人姓名', '监护人电话', '监护人关系', '监护人职业', '是否住校', '特长', '班级任职', '备注',
  '监护人2姓名', '监护人2电话', '监护人2关系', '监护人2职业',
]);

const SCORE_ALIASES = new Set([
  '学号', '姓名', '考试名称', '考试日期', '科目', '分数', '排名', '状态',
]);

const CALENDAR_ALIASES = new Set([
  '日期', '日历日期', '类型', '日期类型', '安排类型', '事项', '安排', '内容',
  '月份', '周次', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日',
]);

const TIMETABLE_ALIASES = new Set([
  '星期', '周几', '星期几', '节次', '第几节', '科目', '课程', '学科',
  '周一', '周二', '周三', '周四', '周五', '周六', '周日',
  '任课教师', '教师', '老师', '教室', '时段类型', '单双周',
]);

function detectModule(headers: string[], sheetName: string): Array<{ module: string; confidence: number; reason: string }> {
  const normalizedHeaders = headers.map(h => h.replace(/\s+/g, '').trim());
  const normalizedSheetName = sheetName.replace(/\s+/g, '').trim();
  const results: Array<{ module: string; confidence: number; reason: string }> = [];

  const studentHits = normalizedHeaders.filter(h => STUDENT_ALIASES.has(h)).length;
  const hasStudentNo = normalizedHeaders.includes('学号');
  const hasStudentName = normalizedHeaders.includes('姓名');
  if (hasStudentNo && hasStudentName) {
    results.push({
      module: 'students',
      confidence: Math.min(0.5 + studentHits * 0.05, 0.95),
      reason: `包含学号和姓名列，匹配${studentHits}个学生信息字段`,
    });
  } else if (studentHits >= 3) {
    results.push({
      module: 'students',
      confidence: Math.min(0.3 + studentHits * 0.05, 0.7),
      reason: `匹配${studentHits}个学生信息字段`,
    });
  }

  const scoreHits = normalizedHeaders.filter(h => SCORE_ALIASES.has(h)).length;
  const hasExamName = normalizedHeaders.includes('考试名称');
  const hasSubject = normalizedHeaders.includes('科目') || normalizedHeaders.includes('学科');
  const hasScore = normalizedHeaders.includes('分数');
  if (hasExamName && (hasSubject || hasScore)) {
    results.push({
      module: 'scores',
      confidence: Math.min(0.5 + scoreHits * 0.05, 0.95),
      reason: `包含考试名称和科目/分数列，匹配${scoreHits}个成绩字段`,
    });
  } else if (hasExamName && hasStudentNo) {
    results.push({
      module: 'scores',
      confidence: 0.6,
      reason: '包含考试名称和学号，可能是宽格式成绩表',
    });
  }

  const calendarHits = normalizedHeaders.filter(h => CALENDAR_ALIASES.has(h)).length;
  const hasWeekdayCols = ['星期一', '星期二', '星期三', '星期四', '星期五'].every(
    d => normalizedHeaders.includes(d),
  );
  const hasDateCol = normalizedHeaders.includes('日期') || normalizedHeaders.includes('日历日期');
  const hasMonthWeek = normalizedHeaders.includes('月份') && normalizedHeaders.includes('周次');
  if (hasMonthWeek && hasWeekdayCols) {
    results.push({
      module: 'calendar',
      confidence: 0.95,
      reason: '包含月份、周次和星期列，匹配校历矩阵格式',
    });
  } else if (hasDateCol) {
    results.push({
      module: 'calendar',
      confidence: Math.min(0.4 + calendarHits * 0.05, 0.8),
      reason: `包含日期列，匹配${calendarHits}个校历字段`,
    });
  }

  const timetableHits = normalizedHeaders.filter(h => TIMETABLE_ALIASES.has(h)).length;
  const hasWeekday = normalizedHeaders.some(h => ['星期', '周几', '星期几'].includes(h));
  const hasPeriod = normalizedHeaders.includes('节次') || normalizedHeaders.includes('第几节');
  const hasCourse = normalizedHeaders.includes('科目') || normalizedHeaders.includes('课程') || normalizedHeaders.includes('学科');
  if (hasWeekday && hasPeriod && hasCourse) {
    results.push({
      module: 'timetable',
      confidence: 0.95,
      reason: '包含星期、节次和科目列，匹配课程表格式',
    });
  } else if (timetableHits >= 3) {
    results.push({
      module: 'timetable',
      confidence: Math.min(0.3 + timetableHits * 0.1, 0.8),
      reason: `匹配${timetableHits}个课程表字段`,
    });
  }

  const sheetLower = normalizedSheetName.toLowerCase();
  if (sheetLower.includes('学生') || sheetLower.includes('student')) {
    const existing = results.find(r => r.module === 'students');
    if (existing) existing.confidence = Math.min(existing.confidence + 0.1, 0.98);
    else results.push({ module: 'students', confidence: 0.3, reason: '工作表名称包含"学生"' });
  }
  if (sheetLower.includes('成绩') || sheetLower.includes('score') || sheetLower.includes('考试')) {
    const existing = results.find(r => r.module === 'scores');
    if (existing) existing.confidence = Math.min(existing.confidence + 0.1, 0.98);
    else results.push({ module: 'scores', confidence: 0.3, reason: '工作表名称包含"成绩/考试"' });
  }
  if (sheetLower.includes('校历') || sheetLower.includes('calendar')) {
    const existing = results.find(r => r.module === 'calendar');
    if (existing) existing.confidence = Math.min(existing.confidence + 0.1, 0.98);
    else results.push({ module: 'calendar', confidence: 0.3, reason: '工作表名称包含"校历"' });
  }
  if (sheetLower.includes('课表') || sheetLower.includes('timetable') || sheetLower.includes('课程')) {
    const existing = results.find(r => r.module === 'timetable');
    if (existing) existing.confidence = Math.min(existing.confidence + 0.1, 0.98);
    else results.push({ module: 'timetable', confidence: 0.3, reason: '工作表名称包含"课表/课程"' });
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}

function mapHeaders(headers: string[], module: string): Array<{ source: string; target: string; matched: boolean }> {
  const normalized = headers.map(h => h.replace(/\s+/g, '').trim());
  const result: Array<{ source: string; target: string; matched: boolean }> = [];

  const MAPPING: Record<string, Record<string, string>> = {
    students: {
      '学号': '学号', '姓名': '姓名', '性别': '性别', '出生年月': '出生年月',
      '民族': '民族', '家庭住址': '家庭住址', '监护人姓名': '监护人姓名',
      '监护人电话': '监护人电话', '监护人关系': '监护人关系', '监护人职业': '监护人职业', '是否住校': '是否住校',
      '特长': '特长', '班级任职': '班级任职', '备注': '备注',
      '监护人2姓名': '监护人2姓名', '监护人2电话': '监护人2电话', '监护人2关系': '监护人2关系', '监护人2职业': '监护人2职业',
    },
    scores: {
      '学号': '学号', '姓名': '姓名', '考试名称': '考试名称', '考试日期': '考试日期',
      '科目': '科目', '学科': '科目', '分数': '分数', '排名': '排名',
      '状态': '状态', '备注': '备注',
    },
    calendar: {
      '日期': 'date', '日历日期': 'date', '开始日期': 'start_date',
      '结束日期': 'end_date', '类型': 'day_type', '日期类型': 'day_type',
      '安排类型': 'day_type', '事项': 'title', '安排': 'title', '内容': 'title',
      '名称': 'title', '备注': 'note', '是否上课': 'is_school_day', '是否行课': 'is_school_day',
      '月份': '月份', '周次': '周次',
      '星期一': '星期一', '星期二': '星期二', '星期三': '星期三',
      '星期四': '星期四', '星期五': '星期五', '星期六': '星期六', '星期日': '星期日',
    },
    timetable: {
      '星期': 'weekday', '周几': 'weekday', '星期几': 'weekday',
      '节次': 'period_no', '第几节': 'period_no',
      '节次名称': 'label', '节次标签': 'label',
      '开始时间': 'start_time', '上课时间': 'start_time',
      '结束时间': 'end_time', '下课时间': 'end_time',
      '科目': 'subject', '课程': 'subject', '学科': 'subject',
      '任课教师': 'teacher_name', '教师': 'teacher_name', '老师': 'teacher_name',
      '教室': 'room', '时段类型': 'session_type', '课程类型': 'session_type',
      '单双周': 'week_pattern', '周次模式': 'week_pattern',
      '开始周': 'week_start', '起始周': 'week_start',
      '结束周': 'week_end', '截止周': 'week_end',
      '备注': 'note',
    },
  };

  const mapping = MAPPING[module] ?? {};
  for (let i = 0; i < headers.length; i += 1) {
    const target = mapping[normalized[i]];
    result.push({ source: headers[i], target: target ?? '', matched: Boolean(target) });
  }

  return result;
}

function computePreviewHash(fileId: string, module: string, mapping: Array<{ source: string; target: string; matched: boolean }>, rowCounts: number[]): string {
  const payload = JSON.stringify({ fileId, module, mapping, rowCounts });
  return createHash('sha256').update(payload, 'utf-8').digest('hex');
}

function loadMetadata(fileId: string): FileMetadata {
  const dir = tempDir();
  const metaPath = path.join(dir, `${fileId}.json`);
  if (!fs.existsSync(metaPath)) throw new ExcelImportError('上传文件不存在或已过期');
  return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as FileMetadata;
}

function assertFileAccess(meta: FileMetadata, options?: { owner?: string; session?: string; channel?: string }): void {
  if (options?.owner && meta.owner && meta.owner !== options.owner) {
    throw new ExcelImportError('上传文件不属于当前操作者');
  }
  if (options?.session && meta.session && meta.session !== options.session) {
    throw new ExcelImportError('上传文件不属于当前会话');
  }
  if (options?.channel && meta.channel && meta.channel !== options.channel) {
    throw new ExcelImportError('上传文件不属于当前渠道');
  }
}

function saveMetadata(meta: FileMetadata): void {
  const dir = tempDir();
  const metaPath = path.join(dir, `${meta.file_id}.json`);
  fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');
}

function saveTempFile(fileId: string, buffer: Buffer): void {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, fileId), buffer);
}

function loadTempFile(fileId: string): Buffer {
  const dir = tempDir();
  const filePath = path.join(dir, fileId);
  if (!fs.existsSync(filePath)) throw new ExcelImportError('上传文件数据不存在或已过期');
  return fs.readFileSync(filePath);
}

function checkExpiry(meta: FileMetadata): void {
  const now = new Date();
  const expires = new Date(meta.expires_at.replace(' ', 'T'));
  if (now > expires) {
    discardUpload(meta.file_id);
    throw new ExcelImportError('上传文件已过期，请重新上传');
  }
}

async function parseXlsxRows(buffer: Buffer, sheetIndex: number): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[sheetIndex] ?? wb.worksheets[0];
  if (!ws) return [];
  const rows: unknown[][] = [];
  for (let r = 1; r <= ws.rowCount; r += 1) {
    const row: unknown[] = [];
    for (let c = 1; c <= ws.columnCount; c += 1) {
      const value = ws.getRow(r).getCell(c).value;
      if (value instanceof Date) row.push(value.toISOString().slice(0, 10));
      else if (typeof value === 'object' && value !== null && 'formula' in value) {
        row.push(`=${(value as { formula: string }).formula}`);
      } else row.push(value);
    }
    rows.push(row);
  }
  return rows;
}

export async function analyzeUpload(options: {
  buffer: Buffer;
  originalName: string;
  sessionId: string;
  owner?: string;
  channel?: string;
}): Promise<{
  file_id: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  sheets: string[];
  headers: string[][];
  row_counts: number[];
  sample_rows: unknown[][];
  candidate_modules: Array<{ module: string; confidence: number; reason: string }>;
}> {
  const { buffer, originalName, sessionId, owner, channel } = options;
  if (!/\.xlsx$/i.test(originalName)) {
    throw new ExcelImportError('第一版只支持 .xlsx 文件，不支持 .xls、.csv 或其他格式');
  }
  if (buffer.length === 0) throw new ExcelImportError('文件不能为空');
  if (buffer.length > 50 * 1024 * 1024) throw new ExcelImportError('文件不能超过 50MB');
  const fileId = randomUUID().replace(/-/g, '');
  const sha256 = sha256Buffer(buffer);
  const meta = await readExcelMetadata(buffer);

  const allCandidates: Array<{ module: string; confidence: number; reason: string }> = [];
  for (let i = 0; i < meta.sheets.length; i += 1) {
    const candidates = detectModule(meta.headers[i], meta.sheets[i]);
    for (const c of candidates) {
      if (!allCandidates.find(ac => ac.module === c.module)) {
        allCandidates.push({ ...c, reason: `[${meta.sheets[i]}] ${c.reason}` });
      }
    }
  }
  allCandidates.sort((a, b) => b.confidence - a.confidence);

  const fileMeta: FileMetadata = {
    file_id: fileId,
    filename: originalName,
    size_bytes: buffer.length,
    sha256,
    owner: owner ?? '',
    channel: channel ?? 'web',
    session: sessionId,
    created_at: nowIso(),
    expires_at: expiresAtIso(),
    sheets: meta.sheets,
    headers: meta.headers,
    row_counts: meta.row_counts,
    sample_rows: meta.sample_rows,
    candidate_modules: allCandidates,
    preview_state: null,
  };

  saveTempFile(fileId, buffer);
  saveMetadata(fileMeta);

  audit.record('excel_import_upload', 0, 'upload', {
    summary: `上传Excel文件：${originalName}，${buffer.length}字节`,
    params: { file_id: fileId, size_bytes: buffer.length, sheets: meta.sheets.length },
  });

  return {
    file_id: fileId,
    filename: originalName,
    size_bytes: buffer.length,
    sha256,
    sheets: meta.sheets,
    headers: meta.headers,
    row_counts: meta.row_counts,
    sample_rows: meta.sample_rows,
    candidate_modules: allCandidates,
  };
}

export async function generateImportPreview(options: {
  fileId: string;
  module: string;
  classId?: number;
  termId?: number;
  sheetIndex?: number;
  duplicateStrategy?: string;
  owner?: string;
  session?: string;
  channel?: string;
}): Promise<{
  file_id: string;
  module: string;
  field_mapping: Array<{ source: string; target: string; matched: boolean }>;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  new_count: number;
  update_count: number;
  skip_count: number;
  errors: Array<{ row: number; reason: string }>;
  preview_hash: string;
}> {
  const { fileId, module, sheetIndex, duplicateStrategy, owner, session, channel } = options;

  if (!SUPPORTED_MODULES.includes(module as SupportedModule)) {
    throw new ExcelImportError(`不支持的导入模块：${module}，可选值：${SUPPORTED_MODULES.join(', ')}`);
  }

  const meta = loadMetadata(fileId);
  assertFileAccess(meta, { owner, session, channel });
  checkExpiry(meta);

  const idx = sheetIndex ?? 0;
  if (idx < 0 || idx >= meta.headers.length) {
    throw new ExcelImportError(`工作表索引越界：${idx}，文件共有${meta.headers.length}个工作表`);
  }

  const headers = meta.headers[idx];
  const fieldMapping = mapHeaders(headers, module);
  const buffer = loadTempFile(fileId);

  let totalRows = 0;
  let validRows = 0;
  let errorRows = 0;
  let newCount = 0;
  let updateCount = 0;
  let skipCount = 0;
  const errors: Array<{ row: number; reason: string }> = [];

  if (module === 'students') {
    const preview = await previewStudents(buffer, meta.filename);
    totalRows = preview.rows.length + preview.errors.length;
    validRows = preview.summary.valid;
    newCount = preview.summary.imported;
    updateCount = preview.summary.updated;
    skipCount = preview.summary.skipped;
    errorRows = preview.errors.length;
    for (const e of preview.errors) errors.push({ row: e.row, reason: e.msg });
  } else if (module === 'scores') {
    const rows = await parseXlsxRows(buffer, idx);
    try {
      const preview = scores.previewExamRows(rows, duplicateStrategy ?? 'update');
      totalRows = preview.rows.length;
      validRows = preview.summary.valid;
      newCount = preview.summary.new;
      updateCount = preview.summary.update;
      skipCount = preview.summary.skip;
      errorRows = preview.summary.error;
      for (const e of preview.errors) errors.push({ row: e.row, reason: e.message });
    } catch (error) {
      if (error instanceof scores.ScoreError) {
        errors.push({ row: 0, reason: error.message });
        errorRows = 1;
      } else throw error;
    }
  } else if (module === 'calendar') {
    try {
      const preview = await calendar.previewImport(buffer, meta.filename);
      totalRows = preview.summary.parsed;
      validRows = preview.summary.valid;
      newCount = preview.summary.new;
      updateCount = preview.summary.update;
      skipCount = preview.summary.skip;
      errorRows = preview.summary.error + preview.summary.conflict;
      for (const e of preview.errors) errors.push({ row: e.row, reason: e.message });
    } catch (error) {
      if (error instanceof calendar.CalendarError) {
        errors.push({ row: 0, reason: error.message });
        errorRows = 1;
      } else throw error;
    }
  } else if (module === 'timetable') {
    const rows = await parseXlsxRows(buffer, idx);
    try {
      const preview = timetable.previewImport(rows, meta.filename);
      const previewRows = preview.rows as Array<Record<string, unknown>>;
      const previewSummary = preview.summary as { valid: number; invalid: number; total: number };
      totalRows = previewRows.length;
      validRows = previewSummary.valid;
      newCount = previewRows.filter(r => r.action === '新增').length;
      updateCount = previewRows.filter(r => r.action === '更新').length;
      skipCount = previewRows.filter(r => r.action === '跳过').length;
      errorRows = previewSummary.invalid;
      for (const r of previewRows) {
        if (r.error) errors.push({ row: Number(r.row ?? 0), reason: String(r.error) });
      }
    } catch (error) {
      if (error instanceof timetable.TimetableError) {
        errors.push({ row: 0, reason: error.message });
        errorRows = 1;
      } else throw error;
    }
  }

  const previewHash = computePreviewHash(fileId, module, fieldMapping, meta.row_counts);

  meta.preview_state = {
    module,
    sheet_index: idx,
    duplicate_strategy: duplicateStrategy ?? 'update',
    preview_hash: previewHash,
    total_rows: totalRows,
    valid_rows: validRows,
    new_count: newCount,
    update_count: updateCount,
    skip_count: skipCount,
    error_rows: errorRows,
    errors,
  };
  saveMetadata(meta);

  return {
    file_id: fileId,
    module,
    field_mapping: fieldMapping,
    total_rows: totalRows,
    valid_rows: validRows,
    error_rows: errorRows,
    new_count: newCount,
    update_count: updateCount,
    skip_count: skipCount,
    errors,
    preview_hash: previewHash,
  };
}

async function doImport(
  module: string, buffer: Buffer, filename: string, duplicateStrategy: string, sheetIndex: number, requestId: string,
): Promise<{
  imported: number;
  updated: number;
  skipped: number;
  error_count: number;
  errors: Array<{ row: number; reason: string }>;
}> {
  if (module === 'students') {
    const preview = await previewStudents(buffer, filename);
    const commitResult = commitStudentImport(preview.rows, filename);
    return {
      imported: commitResult.imported,
      updated: commitResult.updated,
      skipped: commitResult.skipped + preview.summary.skipped,
      error_count: commitResult.errors.length + preview.errors.length,
      errors: [
        ...preview.errors.map(e => ({ row: e.row, reason: e.msg })),
        ...commitResult.errors.map(e => ({ row: e.row, reason: e.msg })),
      ],
    };
  }

  if (module === 'scores') {
    const rows = await parseXlsxRows(buffer, sheetIndex);
    const preview = scores.previewExamRows(rows, duplicateStrategy);
    const valid = preview.rows.filter(item => item.valid === true && item.action !== '跳过');
    const commitResult = scores.commitExamRows(valid, {
      filename, duplicateStrategy, requestId: requestId || `excel-import-${randomUUID().replace(/-/g, '')}`,
    });
    return {
      imported: Number(commitResult.imported ?? 0),
      updated: Number(commitResult.updated ?? 0),
      skipped: Number(commitResult.skipped ?? 0) + preview.summary.skip,
      error_count: preview.errors.length,
      errors: preview.errors.map(e => ({ row: e.row, reason: e.message })),
    };
  }

  if (module === 'calendar') {
    const preview = await calendar.previewImport(buffer, filename);
    const validRows = preview.rows.filter(r => (r.valid ?? true) && r.action !== '冲突');
    const commitResult = calendar.commitImport(validRows, filename, requestId || `excel-import-${randomUUID().replace(/-/g, '')}`);
    return {
      imported: Number(commitResult.imported ?? 0),
      updated: Number(commitResult.updated ?? 0),
      skipped: Number(commitResult.skipped ?? 0),
      error_count: Number(commitResult.error_count ?? 0) + preview.errors.length,
      errors: preview.errors.map(e => ({ row: e.row, reason: e.message })),
    };
  }

  if (module === 'timetable') {
    const rows = await parseXlsxRows(buffer, sheetIndex);
    const preview = timetable.previewImport(rows, filename);
    const previewRows = preview.rows as Array<Record<string, unknown>>;
    const validRows = previewRows.filter(r => r.valid === true);
    const commitResult = timetable.commitImport(validRows, filename, requestId || `excel-import-${randomUUID().replace(/-/g, '')}`) as Record<string, unknown>;
    return {
      imported: Number(commitResult.imported ?? 0),
      updated: Number(commitResult.updated ?? 0),
      skipped: Number(commitResult.skipped ?? 0),
      error_count: Number(commitResult.error_count ?? 0),
      errors: [],
    };
  }

  throw new ExcelImportError(`不支持的模块：${module}`);
}

export async function executeImport(options: {
  fileId: string;
  module: string;
  previewHash: string;
  requestId: string;
  owner?: string;
  session?: string;
  channel?: string;
}): Promise<{
  imported: number;
  updated: number;
  skipped: number;
  error_count: number;
  errors: Array<{ row: number; reason: string }>;
}> {
  const { fileId, module, previewHash, requestId, owner, session, channel } = options;

  if (!SUPPORTED_MODULES.includes(module as SupportedModule)) {
    throw new ExcelImportError(`不支持的导入模块：${module}`);
  }

  const meta = loadMetadata(fileId);
  assertFileAccess(meta, { owner, session, channel });
  checkExpiry(meta);

  if (!meta.preview_state) {
    throw new ExcelImportError('请先生成导入预览');
  }

  if (meta.preview_state.preview_hash !== previewHash) {
    throw new ExcelImportError('预览已失效，请重新生成预览');
  }

  if (meta.preview_state.module !== module) {
    throw new ExcelImportError('预览模块与请求模块不一致');
  }

  const buffer = loadTempFile(fileId);
  const duplicateStrategy = String(meta.preview_state.duplicate_strategy ?? 'update');
  const sheetIndex = Number(meta.preview_state.sheet_index ?? 0);

  const result = await doImport(module, buffer, meta.filename, duplicateStrategy, sheetIndex, requestId);

  audit.record('excel_import_execute', 0, 'import', {
    summary: `对话式导入${module}：${result.imported}新增，${result.updated}更新，${result.skipped}跳过`,
    params: {
      file_id: fileId, module, request_id: requestId,
      imported: result.imported, updated: result.updated, skipped: result.skipped, error_count: result.error_count,
    },
  });

  discardUpload(fileId);

  return result;
}

export function discardUpload(fileId: string, options?: { owner?: string; session?: string; channel?: string }): void {
  const dir = tempDir();
  const filePath = path.join(dir, fileId);
  const metaPath = path.join(dir, `${fileId}.json`);
  if (fs.existsSync(metaPath)) {
    const meta = loadMetadata(fileId);
    assertFileAccess(meta, options);
  }
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignore */ }
  try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch { /* ignore */ }
}

export function cleanExpiredUploads(): number {
  const dir = tempDir();
  if (!fs.existsSync(dir)) return 0;
  const now = Date.now();
  let cleaned = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const metaPath = path.join(dir, entry);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as FileMetadata;
      const expires = new Date(meta.expires_at.replace(' ', 'T')).getTime();
      if (now > expires) {
        const filePath = path.join(dir, meta.file_id);
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignore */ }
        try { fs.unlinkSync(metaPath); } catch { /* ignore */ }
        cleaned += 1;
      }
    } catch {
      const filePath = path.join(dir, entry.replace('.json', ''));
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignore */ }
      try { fs.unlinkSync(path.join(dir, entry)); } catch { /* ignore */ }
      cleaned += 1;
    }
  }
  return cleaned;
}

export async function buildErrorExcel(fileId: string, module: string, options?: { owner?: string; session?: string; channel?: string }): Promise<Buffer> {
  const meta = loadMetadata(fileId);
  assertFileAccess(meta, options);
  void module;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('导入错误');
  ws.getRow(1).values = ['行号', '错误原因'];
  if (meta.preview_state) {
    const stateErrors = meta.preview_state.errors as Array<{ row: number; reason: string }> | undefined;
    if (stateErrors) {
      for (let i = 0; i < stateErrors.length; i += 1) {
        ws.getRow(i + 2).values = [stateErrors[i].row, stateErrors[i].reason];
      }
    }
  }
  return wb.xlsx.writeBuffer() as Promise<Buffer>;
}
