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
import { getCurrentScope } from './context.js';
import { decideMapping } from '../excel/semantics/mappingPolicy.js';
import { hashBusinessEffect } from '../excel/domain/hash.js';

export class ExcelImportError extends Error {}

export const SUPPORTED_MODULES = ['students', 'scores', 'calendar', 'timetable'] as const;
export type SupportedModule = typeof SUPPORTED_MODULES[number];

const EXPIRE_MINUTES = 30;
const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 100_000;
const MAX_COLUMNS_PER_SHEET = 200;

export interface ExcelSemanticInput {
  filename: string;
  supported_modules: readonly string[];
  allowed_targets: Record<string, Array<{ target: string; label: string }>>;
  sheets: Array<{
    sheet_index: number;
    name: string;
    header_row: number;
    headers: string[];
    row_count: number;
    sample_types: string[][];
  }>;
}

export interface ExcelSemanticAnalysis {
  candidates: unknown[];
  mappings: unknown[];
  model: string;
  warning: string;
}

export interface ExcelCandidate {
  module: string;
  sheet_index: number;
  confidence: number;
  reason: string;
  source: 'rule' | 'ai' | 'hybrid';
}

interface ExcelFieldMapping {
  source: string;
  target: string;
  matched: boolean;
  source_kind: 'rule' | 'ai' | 'manual' | 'none';
  mapping_status: 'accepted' | 'needs_confirmation' | 'ignored';
  confidence?: number;
  reason?: string;
}

export interface ArtifactFieldMappingInput {
  sourceColumn?: string;
  targetField?: string | null;
  source?: 'rule' | 'ai' | 'manual';
  confidence?: number;
  status?: 'accepted' | 'needs_confirmation' | 'ignored';
  reason?: string;
  confirmedByUser?: boolean;
}

interface SemanticMapping {
  module: string;
  sheet_index: number;
  source: string;
  target: string;
  confidence: number;
  reason: string;
}

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
  header_rows: number[];
  row_counts: number[];
  sample_rows: unknown[][];
  candidate_modules: ExcelCandidate[];
  semantic_mappings: SemanticMapping[];
  recognition_mode: 'rules' | 'hybrid';
  recognition_warning: string;
  recognition_model: string;
  class_id: number;
  class_name: string;
  term_id: number;
  term_name: string;
  preview_state: Record<string, unknown> | null;
  execution_state: Record<string, unknown> | null;
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

function safeHeaderCell(value: unknown): string {
  const raw = cellText(value).slice(0, 80);
  if (!raw) return '';
  if (/^\d{7,}$/.test(raw)) return '<数值字段>';
  if (/^\S+@\S+\.\S+$/.test(raw)) return '<邮箱字段>';
  return raw;
}

function headerHintScore(values: string[]): number {
  const hints = /^(?:学号|学生编号|姓名|学生姓名|性别|出生日期|出生年月|考试名称|考试日期|科目|课程|学科|分数|排名|状态|日期|日历日期|开始日期|结束日期|月份|周次|星期|周几|星期几|节次|第几节|任课教师|教师|老师|教室|备注|事项|安排|内容)$/;
  const nonEmpty = values.filter(Boolean);
  const hits = nonEmpty.filter(value => hints.test(value.replace(/\s+/g, ''))).length;
  const longText = nonEmpty.filter(value => value.length > 40).length;
  return hits * 20 + Math.min(nonEmpty.length, 12) - longText * 5;
}

function findHeaderRow(ws: ExcelJS.Worksheet): number {
  let bestRow = 1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let rowNo = 1; rowNo <= Math.min(ws.rowCount, 10); rowNo += 1) {
    const values: string[] = [];
    for (let column = 1; column <= Math.min(ws.columnCount, 50); column += 1) {
      values.push(safeHeaderCell(ws.getRow(rowNo).getCell(column).value));
    }
    const score = headerHintScore(values);
    if (score > bestScore) {
      bestScore = score;
      bestRow = rowNo;
    }
  }
  return bestRow;
}

function sampleType(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'empty';
  if (value instanceof Date) return 'date';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object' && value !== null && 'formula' in value) return 'formula';
  const raw = String(value).trim();
  if (/^\d{4}[-/.年]\d{1,2}/.test(raw)) return 'date-text';
  if (/^\d+(?:\.\d+)?$/.test(raw)) return 'numeric-text';
  return raw.length > 30 ? 'long-text' : 'text';
}

async function readExcelMetadata(buffer: Buffer): Promise<{
  sheets: string[];
  headers: string[][];
  header_rows: number[];
  row_counts: number[];
  sample_rows: unknown[][];
}> {
  const result = {
    sheets: [] as string[],
    headers: [] as string[][],
    header_rows: [] as number[],
    row_counts: [] as number[],
    sample_rows: [] as unknown[][],
  };

  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
  } catch (error) {
    throw new ExcelImportError(`文件无法解析，可能已损坏或受密码保护：${(error as Error).message}`);
  }

  if (wb.worksheets.length === 0) throw new ExcelImportError('Excel 文件中没有可读取的工作表');
  if (wb.worksheets.length > MAX_SHEETS) throw new ExcelImportError(`工作表不能超过 ${MAX_SHEETS} 个`);

  for (const ws of wb.worksheets) {
    if (ws.rowCount > MAX_ROWS_PER_SHEET) throw new ExcelImportError(`工作表“${ws.name}”超过 ${MAX_ROWS_PER_SHEET} 行`);
    if (ws.columnCount > MAX_COLUMNS_PER_SHEET) throw new ExcelImportError(`工作表“${ws.name}”超过 ${MAX_COLUMNS_PER_SHEET} 列`);
    result.sheets.push(ws.name);
    const headerRowNo = findHeaderRow(ws);
    result.header_rows.push(headerRowNo);
    const headerRow: string[] = [];
    const maxCol = Math.min(ws.columnCount, 50);
    if (ws.rowCount > 0) {
      const row = ws.getRow(headerRowNo);
      for (let c = 1; c <= maxCol; c += 1) {
        headerRow.push(safeHeaderCell(row.getCell(c).value));
      }
    }
    result.headers.push(headerRow);
    result.row_counts.push(Math.max(0, ws.rowCount - headerRowNo));
    const samples: unknown[][] = [];
    for (let r = headerRowNo + 1; r <= Math.min(ws.rowCount, headerRowNo + 3); r += 1) {
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

const HEADER_MAPPINGS: Record<string, Record<string, string>> = {
  students: {
    '学号': '学号', '学生编号': '学号', '学生学号': '学号',
    '姓名': '姓名', '学生姓名': '姓名', '身份证号码': '身份证号码', '身份证号': '身份证号码',
    '性别': '性别',
    '出生年月': '出生年月', '出生日期': '出生年月', '生日': '出生年月',
    '民族': '民族', '家庭住址': '家庭住址', '家庭地址': '家庭住址',
    '监护人姓名': '监护人姓名', '家长姓名': '监护人姓名',
    '监护人电话': '监护人电话', '家长电话': '监护人电话', '联系电话': '监护人电话',
    '监护人关系': '监护人关系', '与学生关系': '监护人关系',
    '监护人职业': '监护人职业', '家长职业': '监护人职业',
    '是否住校': '是否住校', '住宿情况': '是否住校',
    '特长': '特长', '班级任职': '班级任职', '备注': '备注',
    '监护人2姓名': '监护人2姓名', '第二监护人姓名': '监护人2姓名',
    '监护人2电话': '监护人2电话', '第二监护人电话': '监护人2电话',
    '监护人2关系': '监护人2关系', '第二监护人关系': '监护人2关系',
    '监护人2职业': '监护人2职业', '第二监护人职业': '监护人2职业',
  },
  scores: {
    '学号': '学号', '学生编号': '学号', '姓名': '姓名', '学生姓名': '姓名',
    '考试名称': '考试名称', '考试': '考试名称', '考试日期': '考试日期', '日期': '考试日期',
    '科目': '科目', '学科': '科目', '课程': '科目', '分数': '分数', '成绩': '分数',
    '排名': '排名', '名次': '排名', '状态': '状态', '备注': '备注',
  },
  calendar: {
    '日期': 'date', '日历日期': 'date', '校历日期': 'date', '开始日期': 'start_date',
    '结束日期': 'end_date', '类型': 'day_type', '日期类型': 'day_type',
    '安排类型': 'day_type', '事项': 'title', '安排': 'title', '内容': 'title',
    '名称': 'title', '备注': 'note', '说明': 'note',
    '是否上课': 'is_school_day', '是否行课': 'is_school_day',
    '月份': '月份', '周次': '周次',
    '星期一': '星期一', '星期二': '星期二', '星期三': '星期三',
    '星期四': '星期四', '星期五': '星期五', '星期六': '星期六', '星期日': '星期日',
  },
  timetable: {
    '星期': 'weekday', '周几': 'weekday', '星期几': 'weekday',
    '节次': 'period_no', '第几节': 'period_no', '课节': 'period_no',
    '节次名称': 'label', '节次标签': 'label',
    '开始时间': 'start_time', '上课时间': 'start_time',
    '结束时间': 'end_time', '下课时间': 'end_time',
    '科目': 'subject', '课程': 'subject', '学科': 'subject', '课程名称': 'subject',
    '任课教师': 'teacher_name', '教师': 'teacher_name', '老师': 'teacher_name',
    '教室': 'room', '上课地点': 'room', '时段类型': 'session_type', '课程类型': 'session_type',
    '单双周': 'week_pattern', '周次模式': 'week_pattern',
    '开始周': 'week_start', '起始周': 'week_start',
    '结束周': 'week_end', '截止周': 'week_end', '备注': 'note',
  },
};

const CANONICAL_HEADERS: Record<string, Record<string, string>> = {
  students: Object.fromEntries(Object.values(HEADER_MAPPINGS.students).map(target => [target, target])),
  scores: Object.fromEntries(Object.values(HEADER_MAPPINGS.scores).map(target => [target, target])),
  calendar: {
    date: '日期', start_date: '开始日期', end_date: '结束日期', day_type: '类型', title: '事项',
    note: '备注', is_school_day: '是否上课', '月份': '月份', '周次': '周次',
    '星期一': '星期一', '星期二': '星期二', '星期三': '星期三', '星期四': '星期四',
    '星期五': '星期五', '星期六': '星期六', '星期日': '星期日',
  },
  timetable: {
    weekday: '星期', period_no: '节次', label: '节次名称', start_time: '开始时间', end_time: '结束时间',
    subject: '科目', teacher_name: '任课教师', room: '教室', session_type: '时段类型',
    week_pattern: '单双周', week_start: '开始周', week_end: '结束周', note: '备注',
  },
};

function detectModule(headers: string[], sheetName: string): Array<{ module: string; confidence: number; reason: string }> {
  const normalizedHeaders = headers.map(h => h.replace(/\s+/g, '').trim());
  const normalizedSheetName = sheetName.replace(/\s+/g, '').trim();
  const results: Array<{ module: string; confidence: number; reason: string }> = [];

  const studentTargets = normalizedHeaders.map(h => HEADER_MAPPINGS.students[h]).filter(Boolean);
  const studentHits = studentTargets.length;
  const hasStudentNo = studentTargets.includes('学号');
  const hasStudentName = studentTargets.includes('姓名');
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

  const scoreTargets = normalizedHeaders.map(h => HEADER_MAPPINGS.scores[h]).filter(Boolean);
  const scoreHits = scoreTargets.length;
  const hasExamName = scoreTargets.includes('考试名称');
  const hasSubject = scoreTargets.includes('科目');
  const hasScore = scoreTargets.includes('分数');
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

  const calendarTargets = normalizedHeaders.map(h => HEADER_MAPPINGS.calendar[h]).filter(Boolean);
  const calendarHits = calendarTargets.length;
  const hasWeekdayCols = ['星期一', '星期二', '星期三', '星期四', '星期五'].every(
    d => normalizedHeaders.includes(d),
  );
  const hasDateCol = calendarTargets.includes('date') || calendarTargets.includes('start_date');
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

  const timetableTargets = normalizedHeaders.map(h => HEADER_MAPPINGS.timetable[h]).filter(Boolean);
  const timetableHits = timetableTargets.length;
  const hasWeekday = timetableTargets.includes('weekday');
  const hasPeriod = timetableTargets.includes('period_no');
  const hasCourse = timetableTargets.includes('subject');
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

function mapHeaders(
  headers: string[], module: string, semanticMappings: SemanticMapping[] = [], sheetIndex = 0,
): ExcelFieldMapping[] {
  const normalized = headers.map(h => h.replace(/\s+/g, '').trim());
  const result: ExcelFieldMapping[] = [];
  const mapping = HEADER_MAPPINGS[module] ?? {};
  for (let i = 0; i < headers.length; i += 1) {
    const target = mapping[normalized[i]];
    if (target) {
      const decision = decideMapping('rule');
      result.push({
        source: headers[i], target, matched: decision.matched, source_kind: 'rule',
        mapping_status: decision.status, confidence: decision.confidence,
      });
      continue;
    }
    const semantic = semanticMappings.find(item => item.module === module
      && item.sheet_index === sheetIndex && item.source === headers[i]);
    if (semantic) {
      const decision = decideMapping('ai', semantic.confidence);
      result.push({
        source: headers[i], target: semantic.target, matched: decision.matched, source_kind: 'ai',
        mapping_status: decision.status, confidence: decision.confidence,
        reason: semantic.reason,
      });
    } else {
      result.push({
        source: headers[i], target: '', matched: false, source_kind: 'none',
        mapping_status: 'ignored',
      });
    }
  }

  return result;
}

function mapArtifactHeaders(
  headers: string[], module: string, mappings: ArtifactFieldMappingInput[],
): ExcelFieldMapping[] {
  const defaults = mapHeaders(headers, module);
  const supplied = new Map(mappings.map(item => [String(item.sourceColumn ?? '').trim(), item]));
  return defaults.map(item => {
    const selected = supplied.get(item.source);
    if (!selected) return item;
    // The model is allowed to propose a mapping, but it is not allowed to
    // manufacture an accepted decision by sending status/confidence fields.
    // Deterministic header rules remain authoritative; all other proposals
    // must be explicitly confirmed by a later user-owned flow.
    if (item.source_kind === 'rule' && item.target) return item;
    const target = String(selected.targetField ?? '').trim();
    if (selected.status === 'ignored' || !target) {
      return {
        source: item.source, target: '', matched: false, source_kind: selected.source ?? 'manual',
        mapping_status: 'ignored', confidence: 0, reason: selected.reason,
      };
    }
    if (!CANONICAL_HEADERS[module]?.[target]) {
      throw new ExcelImportError(`字段映射目标不受支持：${target}`);
    }
    if (selected.confirmedByUser === true && selected.source === 'manual') {
      return {
        source: item.source, target, matched: true, source_kind: 'manual',
        mapping_status: 'accepted', confidence: 1,
        reason: selected.reason || '用户已确认字段映射',
      };
    }
    return {
      source: item.source, target, matched: false, source_kind: 'ai',
      mapping_status: 'needs_confirmation', confidence: 0.65,
      reason: '模型提出的字段映射需要用户确认；模型不能直接批准写入',
    };
  });
}

function assertMappingUnambiguous(mapping: ExcelFieldMapping[]): void {
  const sourcesByTarget = new Map<string, string[]>();
  for (const item of mapping) {
    if (!item.matched || !item.target) continue;
    const sources = sourcesByTarget.get(item.target) ?? [];
    sources.push(item.source);
    sourcesByTarget.set(item.target, sources);
  }
  const conflicts = [...sourcesByTarget.entries()].filter(([, sources]) => sources.length > 1);
  if (conflicts.length > 0) {
    const detail = conflicts.map(([target, sources]) => `${sources.join('、')} → ${target}`).join('；');
    throw new ExcelImportError(`字段映射存在冲突，请删除重复列或修改表头：${detail}`);
  }
}

function computePreviewHash(options: {
  fileId: string;
  sha256: string;
  module: string;
  sheetIndex: number;
  headerRow: number;
  duplicateStrategy: string;
  mapping: ExcelFieldMapping[];
  classId: number;
  termId: number;
}): string {
  const payload = JSON.stringify(options);
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

function removeTempFile(fileId: string): void {
  const filePath = path.join(tempDir(), fileId);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignore */ }
}

function checkExpiry(meta: FileMetadata): void {
  const now = new Date();
  const expires = new Date(meta.expires_at.replace(' ', 'T'));
  if (now > expires) {
    discardUpload(meta.file_id);
    throw new ExcelImportError('上传文件已过期，请重新上传');
  }
}

function assertScope(meta: FileMetadata): void {
  const scope = getCurrentScope();
  if (Number(scope.class_id) !== Number(meta.class_id) || Number(scope.term_id) !== Number(meta.term_id)) {
    throw new ExcelImportError(
      `当前班级或学期已切换；该文件属于“${meta.class_name} / ${meta.term_name}”，请切回后继续或重新上传`,
    );
  }
}

function verifyTempFile(meta: FileMetadata): Buffer {
  const buffer = loadTempFile(meta.file_id);
  if (sha256Buffer(buffer) !== meta.sha256) {
    throw new ExcelImportError('上传文件内容已变化，请重新上传');
  }
  return buffer;
}

function semanticInput(meta: {
  sheets: string[];
  headers: string[][];
  header_rows: number[];
  row_counts: number[];
  sample_rows: unknown[][];
}, filename: string): ExcelSemanticInput {
  const allowedTargets: ExcelSemanticInput['allowed_targets'] = {};
  for (const module of SUPPORTED_MODULES) {
    allowedTargets[module] = Object.entries(CANONICAL_HEADERS[module]).map(([target, label]) => ({ target, label }));
  }
  return {
    filename: path.extname(filename).toLowerCase() === '.xlsx' ? '上传文件.xlsx' : '上传文件',
    supported_modules: SUPPORTED_MODULES,
    allowed_targets: allowedTargets,
    sheets: meta.sheets.map((name, sheetIndex) => {
      const samples = (meta.sample_rows[sheetIndex] ?? []) as unknown[][];
      return {
        sheet_index: sheetIndex,
        name: safeHeaderCell(name),
        header_row: meta.header_rows[sheetIndex] ?? 1,
        headers: meta.headers[sheetIndex].map(safeHeaderCell),
        row_count: meta.row_counts[sheetIndex] ?? 0,
        sample_types: samples.map(row => row.map(sampleType)),
      };
    }),
  };
}

function confidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(parsed, 0.95));
}

function validateSemanticAnalysis(
  analysis: ExcelSemanticAnalysis,
  meta: { headers: string[][] },
): { candidates: ExcelCandidate[]; mappings: SemanticMapping[] } {
  const candidates: ExcelCandidate[] = [];
  for (const raw of analysis.candidates) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const module = String(item.module ?? '');
    const sheetIndex = Number(item.sheet_index);
    if (!SUPPORTED_MODULES.includes(module as SupportedModule)
      || !Number.isInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= meta.headers.length) continue;
    const score = confidence(item.confidence);
    if (score <= 0) continue;
    candidates.push({
      module, sheet_index: sheetIndex, confidence: score,
      reason: String(item.reason ?? 'AI 根据列名语义识别').trim().slice(0, 160), source: 'ai',
    });
  }

  const mappings: SemanticMapping[] = [];
  for (const raw of analysis.mappings) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const module = String(item.module ?? '');
    const sheetIndex = Number(item.sheet_index);
    const source = String(item.source ?? '').trim();
    const target = String(item.target ?? '').trim();
    if (!SUPPORTED_MODULES.includes(module as SupportedModule)
      || !Number.isInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= meta.headers.length
      || !meta.headers[sheetIndex].includes(source) || !CANONICAL_HEADERS[module]?.[target]) continue;
    const score = confidence(item.confidence);
    if (score <= 0) continue;
    mappings.push({
      module, sheet_index: sheetIndex, source, target, confidence: score,
      reason: String(item.reason ?? 'AI 根据列名语义映射').trim().slice(0, 160),
    });
  }
  return { candidates, mappings };
}

function mergeCandidates(rules: ExcelCandidate[], ai: ExcelCandidate[]): ExcelCandidate[] {
  const merged = new Map<string, ExcelCandidate>();
  for (const candidate of [...rules, ...ai]) {
    const key = `${candidate.module}:${candidate.sheet_index}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, candidate);
      continue;
    }
    merged.set(key, {
      module: candidate.module,
      sheet_index: candidate.sheet_index,
      confidence: Math.max(previous.confidence, candidate.confidence),
      reason: previous.reason === candidate.reason ? previous.reason : `${previous.reason}；${candidate.reason}`.slice(0, 220),
      source: previous.source === candidate.source ? previous.source : 'hybrid',
    });
  }
  return [...merged.values()].sort((a, b) => b.confidence - a.confidence);
}

async function normalizedWorkbookBuffer(
  buffer: Buffer, sheetIndex: number, headerRow: number, mapping: ExcelFieldMapping[], module: string,
): Promise<Buffer> {
  const sourceBook = new ExcelJS.Workbook();
  await sourceBook.xlsx.load(buffer);
  const sourceSheet = sourceBook.worksheets[sheetIndex];
  if (!sourceSheet) throw new ExcelImportError('所选工作表不存在');
  const targetBook = new ExcelJS.Workbook();
  const targetSheet = targetBook.addWorksheet(sourceSheet.name.slice(0, 31) || '导入数据');
  for (let rowNo = 1; rowNo <= sourceSheet.rowCount; rowNo += 1) {
    for (let column = 1; column <= sourceSheet.columnCount; column += 1) {
      targetSheet.getRow(rowNo).getCell(column).value = sourceSheet.getRow(rowNo).getCell(column).value;
    }
  }
  for (let column = 1; column <= mapping.length; column += 1) {
    const item = mapping[column - 1];
    if (item.matched) targetSheet.getRow(headerRow).getCell(column).value = CANONICAL_HEADERS[module][item.target];
  }
  const written = await targetBook.xlsx.writeBuffer();
  return Buffer.from(written);
}

function rowsFromHeader(rows: unknown[][], headerRow: number): unknown[][] {
  return rows.slice(Math.max(0, headerRow - 1));
}

function originalRow(row: number, headerRow: number): number {
  return row > 0 ? row + Math.max(0, headerRow - 1) : row;
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
        row.push((value as { result?: unknown }).result ?? '');
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
  semanticAnalyzer?: (input: ExcelSemanticInput) => Promise<ExcelSemanticAnalysis>;
}): Promise<{
  file_id: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  sheets: string[];
  headers: string[][];
  header_rows: number[];
  row_counts: number[];
  sample_rows: unknown[][];
  candidate_modules: ExcelCandidate[];
  recognition_mode: 'rules' | 'hybrid';
  recognition_warning: string;
  recognition_model: string;
  scope: { class_id: number; class_name: string; term_id: number; term_name: string };
}> {
  const { buffer, originalName, sessionId, owner, channel, semanticAnalyzer } = options;
  cleanExpiredUploads();
  if (!/\.xlsx$/i.test(originalName)) {
    throw new ExcelImportError('第一版只支持 .xlsx 文件，不支持 .xls、.csv 或其他格式');
  }
  if (buffer.length === 0) throw new ExcelImportError('文件不能为空');
  if (buffer.length > 50 * 1024 * 1024) throw new ExcelImportError('文件不能超过 50MB');
  if (buffer.subarray(0, 2).toString('utf-8') !== 'PK') {
    throw new ExcelImportError('文件内容不是有效的 .xlsx 工作簿');
  }
  const fileId = randomUUID().replace(/-/g, '');
  const sha256 = sha256Buffer(buffer);
  const meta = await readExcelMetadata(buffer);
  const scope = getCurrentScope();

  const ruleCandidates: ExcelCandidate[] = [];
  for (let i = 0; i < meta.sheets.length; i += 1) {
    const candidates = detectModule(meta.headers[i], meta.sheets[i]);
    for (const c of candidates) {
      ruleCandidates.push({ ...c, sheet_index: i, reason: `[${meta.sheets[i]}] ${c.reason}`, source: 'rule' });
    }
  }
  let semanticMappings: SemanticMapping[] = [];
  let aiCandidates: ExcelCandidate[] = [];
  let recognitionWarning = '';
  let recognitionModel = '';
  if (semanticAnalyzer) {
    try {
      const analysis = await semanticAnalyzer(semanticInput(meta, originalName));
      const validated = validateSemanticAnalysis(analysis, meta);
      semanticMappings = validated.mappings;
      aiCandidates = validated.candidates;
      recognitionWarning = analysis.warning;
      recognitionModel = analysis.model;
    } catch {
      recognitionWarning = 'AI 语义识别暂时不可用，本次使用本地规则识别';
    }
  }
  const allCandidates = mergeCandidates(ruleCandidates, aiCandidates);
  const recognitionMode: 'rules' | 'hybrid' = aiCandidates.length > 0 || semanticMappings.length > 0 ? 'hybrid' : 'rules';

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
    header_rows: meta.header_rows,
    row_counts: meta.row_counts,
    sample_rows: meta.sample_rows,
    candidate_modules: allCandidates,
    semantic_mappings: semanticMappings,
    recognition_mode: recognitionMode,
    recognition_warning: recognitionWarning,
    recognition_model: recognitionModel,
    class_id: Number(scope.class_id),
    class_name: scope.class_name,
    term_id: Number(scope.term_id),
    term_name: scope.term_name,
    preview_state: null,
    execution_state: null,
  };

  saveTempFile(fileId, buffer);
  saveMetadata(fileMeta);

  audit.record('excel_import_upload', 0, 'upload', {
    summary: `上传Excel文件：${meta.sheets.length}个工作表，${buffer.length}字节`,
    params: { file_id: fileId, size_bytes: buffer.length, sheets: meta.sheets.length },
  });

  return {
    file_id: fileId,
    filename: originalName,
    size_bytes: buffer.length,
    sha256,
    sheets: meta.sheets,
    headers: meta.headers,
    header_rows: meta.header_rows,
    row_counts: meta.row_counts,
    sample_rows: meta.sample_rows,
    candidate_modules: allCandidates,
    recognition_mode: recognitionMode,
    recognition_warning: recognitionWarning,
    recognition_model: recognitionModel,
    scope: {
      class_id: Number(scope.class_id), class_name: scope.class_name,
      term_id: Number(scope.term_id), term_name: scope.term_name,
    },
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
  field_mapping: ExcelFieldMapping[];
  scope: { class_id: number; class_name: string; term_id: number; term_name: string };
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
  assertScope(meta);
  if ((options.classId && Number(options.classId) !== meta.class_id)
    || (options.termId && Number(options.termId) !== meta.term_id)) {
    throw new ExcelImportError('导入目标班级或学期与上传时不一致，请重新上传');
  }

  const idx = sheetIndex ?? 0;
  if (idx < 0 || idx >= meta.headers.length) {
    throw new ExcelImportError(`工作表索引越界：${idx}，文件共有${meta.headers.length}个工作表`);
  }

  const headers = meta.headers[idx];
  const fieldMapping = mapHeaders(headers, module, meta.semantic_mappings, idx);
  assertMappingUnambiguous(fieldMapping);
  const buffer = verifyTempFile(meta);
  const headerRow = meta.header_rows[idx] ?? 1;
  const normalizedBuffer = await normalizedWorkbookBuffer(buffer, idx, headerRow, fieldMapping, module);

  let totalRows = 0;
  let validRows = 0;
  let errorRows = 0;
  let newCount = 0;
  let updateCount = 0;
  let skipCount = 0;
  const errors: Array<{ row: number; reason: string }> = [];

  if (module === 'students') {
    const preview = await previewStudents(normalizedBuffer, meta.filename);
    totalRows = preview.rows.length + preview.errors.length;
    validRows = preview.summary.valid;
    newCount = preview.summary.imported;
    updateCount = preview.summary.updated;
    skipCount = preview.summary.skipped;
    errorRows = preview.errors.length;
    for (const e of preview.errors) errors.push({ row: e.row, reason: e.msg });
  } else if (module === 'scores') {
    const rows = rowsFromHeader(await parseXlsxRows(normalizedBuffer, 0), headerRow);
    try {
      const preview = scores.previewExamRows(rows, duplicateStrategy ?? 'update');
      totalRows = preview.rows.length;
      validRows = preview.summary.valid;
      newCount = preview.summary.new;
      updateCount = preview.summary.update;
      skipCount = preview.summary.skip;
      errorRows = preview.summary.error;
      for (const e of preview.errors) errors.push({ row: originalRow(e.row, headerRow), reason: e.message });
    } catch (error) {
      if (error instanceof scores.ScoreError) {
        errors.push({ row: 0, reason: error.message });
        errorRows = 1;
      } else throw error;
    }
  } else if (module === 'calendar') {
    try {
      const preview = await calendar.previewImport(normalizedBuffer, meta.filename, duplicateStrategy ?? 'merge');
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
    const rows = rowsFromHeader(await parseXlsxRows(normalizedBuffer, 0), headerRow);
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
        if (r.error) errors.push({ row: originalRow(Number(r.row ?? 0), headerRow), reason: String(r.error) });
      }
    } catch (error) {
      if (error instanceof timetable.TimetableError) {
        errors.push({ row: 0, reason: error.message });
        errorRows = 1;
      } else throw error;
    }
  }

  const strategy = duplicateStrategy ?? 'update';
  const previewHash = computePreviewHash({
    fileId, sha256: meta.sha256, module, sheetIndex: idx, headerRow,
    duplicateStrategy: strategy, mapping: fieldMapping, classId: meta.class_id, termId: meta.term_id,
  });

  meta.preview_state = {
    module,
    sheet_index: idx,
    header_row: headerRow,
    duplicate_strategy: strategy,
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
    scope: {
      class_id: meta.class_id, class_name: meta.class_name,
      term_id: meta.term_id, term_name: meta.term_name,
    },
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
  module: string, buffer: Buffer, filename: string, duplicateStrategy: string,
  requestId: string, headerRow: number,
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
    const rows = rowsFromHeader(await parseXlsxRows(buffer, 0), headerRow);
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
      errors: preview.errors.map(e => ({ row: originalRow(e.row, headerRow), reason: e.message })),
    };
  }

  if (module === 'calendar') {
    const preview = await calendar.previewImport(buffer, filename, duplicateStrategy);
    const validRows = preview.rows.filter(r => (r.valid ?? true) && r.action !== '冲突' && r.action !== '跳过');
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
    const rows = rowsFromHeader(await parseXlsxRows(buffer, 0), headerRow);
    const preview = timetable.previewImport(rows, filename);
    const previewRows = preview.rows as Array<Record<string, unknown>>;
    const validRows = previewRows.filter(r => r.valid === true);
    const previewErrors = previewRows
      .filter(row => row.error)
      .map(row => ({ row: originalRow(Number(row.row ?? 0), headerRow), reason: String(row.error) }));
    const commitResult = timetable.commitImport(validRows, filename, requestId || `excel-import-${randomUUID().replace(/-/g, '')}`) as Record<string, unknown>;
    return {
      imported: Number(commitResult.imported ?? 0),
      updated: Number(commitResult.updated ?? 0),
      skipped: Number(commitResult.skipped ?? 0),
      error_count: Number(commitResult.error_count ?? 0) + previewErrors.length,
      errors: previewErrors,
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
  assertScope(meta);

  if (!meta.preview_state) {
    throw new ExcelImportError('请先生成导入预览');
  }

  if (meta.preview_state.preview_hash !== previewHash) {
    throw new ExcelImportError('预览已失效，请重新生成预览');
  }

  if (meta.preview_state.module !== module) {
    throw new ExcelImportError('预览模块与请求模块不一致');
  }

  if (meta.execution_state) {
    if (String(meta.execution_state.request_id ?? '') !== requestId) {
      throw new ExcelImportError('该预览已经执行，不能用新的请求再次导入');
    }
    return meta.execution_state.result as {
      imported: number; updated: number; skipped: number; error_count: number;
      errors: Array<{ row: number; reason: string }>;
    };
  }

  const buffer = verifyTempFile(meta);
  const duplicateStrategy = String(meta.preview_state.duplicate_strategy ?? 'update');
  const sheetIndex = Number(meta.preview_state.sheet_index ?? 0);
  const headerRow = Number(meta.preview_state.header_row ?? meta.header_rows[sheetIndex] ?? 1);
  const mapping = mapHeaders(meta.headers[sheetIndex], module, meta.semantic_mappings, sheetIndex);
  assertMappingUnambiguous(mapping);
  if (mapping.some(item => item.mapping_status === 'needs_confirmation')) {
    throw new ExcelImportError('存在置信度不足的 AI 字段映射，请先人工确认后再导入');
  }
  const normalizedBuffer = await normalizedWorkbookBuffer(buffer, sheetIndex, headerRow, mapping, module);

  const result = await doImport(module, normalizedBuffer, meta.filename, duplicateStrategy, requestId, headerRow);

  audit.record('excel_import_execute', 0, 'import', {
    summary: `对话式导入${module}：${result.imported}新增，${result.updated}更新，${result.skipped}跳过`,
    params: {
      file_id: fileId, module, request_id: requestId,
      imported: result.imported, updated: result.updated, skipped: result.skipped, error_count: result.error_count,
    },
  });

  meta.execution_state = { request_id: requestId, result, executed_at: nowIso() };
  saveMetadata(meta);
  removeTempFile(fileId);

  return result;
}

type ArtifactImportOptions = {
  buffer: Buffer;
  filename: string;
  module: string;
  sheetIndex: number;
  headerRow: number;
  mappings: ArtifactFieldMappingInput[];
  duplicateStrategy?: string;
};

export interface PreparedImportBuffer {
  fieldMapping: ExcelFieldMapping[];
  preview: Record<string, unknown>;
  /** Synchronous DB phase. It is safe to call inside the outer DB transaction. */
  commit: (requestId: string) => Record<string, unknown>;
}

/** Parse, map and preview outside the transaction; retain the validated rows for
 * the synchronous commit/verify phase. */
export async function prepareImportBuffer(options: ArtifactImportOptions): Promise<PreparedImportBuffer> {
  if (!SUPPORTED_MODULES.includes(options.module as SupportedModule)) {
    throw new ExcelImportError(`不支持的导入模块：${options.module}`);
  }
  const rows = await parseXlsxRows(options.buffer, options.sheetIndex);
  const headers = (rows[Math.max(0, options.headerRow - 1)] ?? []).map(value => cellText(value));
  const mapping = mapArtifactHeaders(headers, options.module, options.mappings);
  assertMappingUnambiguous(mapping);
  const needsInput = mapping.filter(item => item.mapping_status === 'needs_confirmation');
  if (needsInput.length > 0) {
    return {
      fieldMapping: mapping,
      preview: {
        module: options.module, field_mapping: mapping, needs_input: true,
        needs_input_mappings: needsInput.map(item => ({ source: item.source, target: item.target, reason: item.reason })),
        message: '有字段无法可靠判断，请补充映射后继续。',
      },
      commit: () => { throw new ExcelImportError('请先补充字段映射'); },
    };
  }
  const normalizedBuffer = await normalizedWorkbookBuffer(
    options.buffer, options.sheetIndex, options.headerRow, mapping, options.module,
  );
  let totalRows = 0;
  let validRows = 0;
  let errorRows = 0;
  let newCount = 0;
  let updateCount = 0;
  let skipCount = 0;
  let businessEffectHash = '';
  const errors: Array<{ row: number; reason: string }> = [];
  let commit: (requestId: string) => Record<string, unknown>;
  if (options.module === 'students') {
    const preview = await previewStudents(normalizedBuffer, options.filename, options.duplicateStrategy ?? 'update');
    totalRows = preview.rows.length + preview.errors.length;
    validRows = preview.summary.valid;
    newCount = preview.summary.imported;
    updateCount = preview.summary.updated;
    skipCount = preview.summary.skipped;
    businessEffectHash = hashBusinessEffect({ module: options.module, rows: preview.rows });
    errorRows = preview.errors.length;
    errors.push(...preview.errors.map(error => ({ row: error.row, reason: error.msg })));
    commit = (requestId) => {
      const result = commitStudentImport(
        preview.rows.filter(row => row.action !== '跳过'), options.filename,
        options.duplicateStrategy ?? 'update',
      );
      return {
        imported: result.imported, updated: result.updated,
        skipped: result.skipped + preview.summary.skipped,
        error_count: result.errors.length + preview.errors.length,
        errors: [
          ...preview.errors.map(error => ({ row: error.row, reason: error.msg })),
          ...result.errors.map(error => ({ row: error.row, reason: error.msg })),
        ], request_id: requestId,
      };
    };
  } else if (options.module === 'scores') {
    const scoreRows = rowsFromHeader(await parseXlsxRows(normalizedBuffer, 0), options.headerRow);
    const preview = scores.previewExamRows(scoreRows, options.duplicateStrategy ?? 'update');
    totalRows = preview.rows.length;
    validRows = preview.summary.valid;
    newCount = preview.summary.new;
    updateCount = preview.summary.update;
    skipCount = preview.summary.skip;
    businessEffectHash = hashBusinessEffect({ module: options.module, rows: preview.rows });
    errorRows = preview.summary.error;
    errors.push(...preview.errors.map(error => ({ row: originalRow(error.row, options.headerRow), reason: error.message })));
    commit = (requestId) => {
      const valid = preview.rows.filter(item => item.valid === true && item.action !== '跳过');
      const result = scores.commitExamRows(valid, {
        filename: options.filename, duplicateStrategy: options.duplicateStrategy ?? 'update', requestId,
      });
      return {
        ...result, imported: Number(result.imported ?? 0), updated: Number(result.updated ?? 0),
        skipped: Number(result.skipped ?? 0) + preview.summary.skip,
        error_count: preview.errors.length,
        errors: preview.errors.map(error => ({ row: originalRow(error.row, options.headerRow), reason: error.message })),
      };
    };
  } else if (options.module === 'calendar') {
    const preview = await calendar.previewImport(normalizedBuffer, options.filename, options.duplicateStrategy ?? 'merge');
    totalRows = preview.summary.parsed;
    validRows = preview.summary.valid;
    newCount = preview.summary.new;
    updateCount = preview.summary.update;
    skipCount = preview.summary.skip;
    businessEffectHash = hashBusinessEffect({ module: options.module, rows: preview.rows });
    errorRows = preview.summary.error + preview.summary.conflict;
    errors.push(...preview.errors.map(error => ({ row: error.row, reason: error.message })));
    commit = (requestId) => {
      const validRows = preview.rows.filter(row => (row.valid ?? true) && row.action !== '冲突' && row.action !== '跳过');
      const result = calendar.commitImport(validRows, options.filename, requestId);
      return {
        ...result, imported: Number(result.imported ?? 0), updated: Number(result.updated ?? 0),
        skipped: Number(result.skipped ?? 0),
        error_count: Number(result.error_count ?? 0) + preview.errors.length,
        errors: preview.errors.map(error => ({ row: error.row, reason: error.message })),
      };
    };
  } else {
    const timetableRows = rowsFromHeader(await parseXlsxRows(normalizedBuffer, 0), options.headerRow);
    const preview = timetable.previewImport(timetableRows, options.filename, options.duplicateStrategy ?? 'merge');
    const previewRows = preview.rows as Array<Record<string, unknown>>;
    totalRows = previewRows.length;
    validRows = (preview.summary as { valid: number }).valid;
    newCount = previewRows.filter(row => row.action === '新增').length;
    updateCount = previewRows.filter(row => row.action === '更新').length;
    skipCount = previewRows.filter(row => row.action === '跳过').length;
    businessEffectHash = hashBusinessEffect({ module: options.module, rows: previewRows });
    errorRows = (preview.summary as { invalid: number }).invalid;
    errors.push(...previewRows.filter(row => row.error).map(row => ({
      row: originalRow(Number(row.row ?? 0), options.headerRow), reason: String(row.error),
    })));
    commit = (requestId) => {
      const validRows = previewRows.filter(row => row.valid === true);
      const previewErrors = previewRows.filter(row => row.error).map(row => ({
        row: originalRow(Number(row.row ?? 0), options.headerRow), reason: String(row.error),
      }));
      const result = timetable.commitImport(
        validRows, options.filename, requestId, options.duplicateStrategy ?? 'merge',
      ) as Record<string, unknown>;
      return {
        ...result, imported: Number(result.imported ?? 0), updated: Number(result.updated ?? 0),
        skipped: Number(result.skipped ?? 0),
        error_count: Number(result.error_count ?? 0) + previewErrors.length,
        errors: previewErrors,
      };
    };
  }
  const previewResult = {
    module: options.module,
    field_mapping: mapping,
    total_rows: totalRows,
    valid_rows: validRows,
    error_rows: errorRows,
    new_count: newCount,
    update_count: updateCount,
    skip_count: skipCount,
    business_effect_hash: businessEffectHash,
    errors,
    duplicate_strategy: options.duplicateStrategy ?? 'update',
  };
  return { fieldMapping: mapping, preview: previewResult, commit };
}

/** Artifact/ImportPlan 直接使用的业务预览，不依赖旧版 excel-temp 元数据。 */
export async function previewImportBuffer(options: ArtifactImportOptions): Promise<Record<string, unknown>> {
  const prepared = await prepareImportBuffer(options);
  return prepared.preview;
}

/** Artifact/ImportPlan 直接使用的业务执行；调用方负责外层备份、事务和写后验证。 */
export async function executeImportBuffer(options: {
  buffer: Buffer;
  filename: string;
  module: string;
  sheetIndex: number;
  headerRow: number;
  mappings: ArtifactFieldMappingInput[];
  duplicateStrategy?: string;
  requestId: string;
}): Promise<Record<string, unknown>> {
  const prepared = await prepareImportBuffer(options);
  return { ...prepared.commit(options.requestId), field_mapping: prepared.fieldMapping };
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
  checkExpiry(meta);
  assertScope(meta);
  const stateModule = String(meta.preview_state?.module ?? '');
  if (module !== stateModule) throw new ExcelImportError('错误报告模块与导入预览不一致');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('导入错误');
  ws.getRow(1).values = ['行号', '错误原因'];
  const executionResult = meta.execution_state?.result as { errors?: Array<{ row: number; reason: string }> } | undefined;
  const stateErrors = executionResult?.errors
    ?? meta.preview_state?.errors as Array<{ row: number; reason: string }> | undefined;
  if (stateErrors) {
    for (let i = 0; i < stateErrors.length; i += 1) {
      ws.getRow(i + 2).values = [stateErrors[i].row, stateErrors[i].reason];
    }
  }
  return wb.xlsx.writeBuffer() as Promise<Buffer>;
}
