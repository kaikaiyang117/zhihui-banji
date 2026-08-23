/* MIG-05 学生导出。 */
import { getDb, scopeIds } from './context.js';
import { STUDENT_COLUMNS } from '../config/sheets.js';
import { sheetBytes } from './exportXlsx.js';
import { getSheetMeta, getRows, derive } from './sheets.js';
import * as attendance from './attendance.js';
import * as points from './points.js';
import * as funds from './funds.js';
import * as comments from './comments.js';
import * as health from './health.js';
import { scoreSummary, ScoreError } from './scores.js';
import { filenamePart, scopedExportFilename } from './filename.js';

export interface ExportResult {
  buffer: Buffer;
  filename: string;
}

export async function exportStudents(): Promise<ExportResult> {
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const rows = conn.prepare(
    `SELECT ${STUDENT_COLUMNS.map((key) => `s.[${key}]`).join(',')} FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at='' ORDER BY s.学号`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const data = rows.map((row) => STUDENT_COLUMNS.map((key) => row[key] ?? ''));
  const buffer = await sheetBytes('学生信息', STUDENT_COLUMNS, data);
  return { buffer, filename: scopedExportFilename('学生信息总表', 'xlsx', conn) };
}

export async function exportSheet(
  sheet: string, options: { academicYear?: string } = {},
): Promise<ExportResult> {
  if (sheet === '座位表') return exportSeating();
  if (sheet === '考勤管理') {
    const rows = attendance.compatibilityRows();
    const headers = ['日期', '星期', '学号', '姓名', '状态', '到校时间', '离校时间',
      '原因', '备注', '考勤场景'];
    const buffer = await sheetBytes(sheet, headers, rows.map((row) => row['data'] as unknown[]));
    return { buffer, filename: scopedExportFilename(sheet) };
  }
  if (sheet === '日常行为积分') return exportPoints(options);
  if (sheet === '班费管理') return exportFunds();
  if (sheet === '评语管理') return exportComments();
  const meta = getSheetMeta(sheet);
  const headers = meta ? meta.headers : [];
  const rows = derive(sheet, getRows(sheet));
  const buffer = await sheetBytes(sheet, headers, rows.map((row) => row.data));
  return { buffer, filename: scopedExportFilename(sheet) };
}

export async function exportPoints(options: { academicYear?: string } = {}): Promise<ExportResult> {
  const entries = points.listEntries({ academicYear: options.academicYear ?? '', limit: 5000 });
  const headers = ['日期', '周期', '学号', '姓名', '分类', '分值', '原因', '状态',
    '撤销原因', '来源', '规则'];
  const rows = entries.map((item) => [
    item['occurred_at'] || '历史快照', item['period_key'] ?? '',
    item['学号'] ?? '', item['student_name'] ?? '', item['category'] ?? '',
    item['amount'] ?? 0, item['reason'] ?? '', item['status'] ?? '',
    item['reversal_reason'] ?? '', item['source_label'] ?? '', item['rule_name'] ?? '',
  ]);
  const buffer = await sheetBytes('行为积分流水', headers, rows);
  return { buffer, filename: scopedExportFilename('行为积分流水') };
}

export async function exportFunds(): Promise<ExportResult> {
  const headers = ['日期', '收支类型', '金额', '分类', '用途说明', '经手人', '证明人',
    '备注', '状态', '结算期间', '处理原因', '来源', '凭证数'];
  const rows = funds.exportRows();
  const buffer = await sheetBytes('班费分类账', headers, rows);
  return { buffer, filename: scopedExportFilename('班费分类账') };
}

export async function exportComments(): Promise<ExportResult> {
  const headers = ['学号', '姓名', '评语类型', '评语内容', '状态', '模板', '人工修改',
    '审核时间', '审核人', '审核意见', '发送时间', '交付方式', '备注', '来源'];
  const rows = comments.exportRows();
  const buffer = await sheetBytes('学生评语', headers, rows);
  return { buffer, filename: scopedExportFilename('学生评语') };
}

export async function exportSeating(): Promise<ExportResult> {
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const rows = conn.prepare(
    'SELECT r, c, val FROM seating WHERE class_id=? AND term_id=? ORDER BY r, c',
  ).all(classId, termId) as Array<{ r: number; c: number; val: string }>;
  const maxR = rows.reduce((max, row) => Math.max(max, Number(row.r)), 0);
  const maxC = rows.reduce((max, row) => Math.max(max, Number(row.c)), 0);
  const grid: string[][] = Array.from(
    { length: maxR + 1 }, () => Array.from({ length: maxC + 1 }, () => ''),
  );
  for (const row of rows) grid[Number(row.r)][Number(row.c)] = String(row.val ?? '');
  while (grid.length > 0 && grid[0].every((value) => value === '')) grid.shift();
  while (grid.length > 0 && grid[grid.length - 1].every((value) => value === '')) grid.pop();
  const cols = grid.length > 0 ? grid[0].length : 0;
  for (const row of grid) {
    while (row.length < cols) row.push('');
  }
  const headers = Array.from({ length: cols }, (_, index) => `第${index + 1}列`);
  const buffer = await sheetBytes('座位表', headers, grid);
  return { buffer, filename: scopedExportFilename('座位表', 'xlsx', conn) };
}

export async function exportScoreReport(exam: string): Promise<ExportResult> {
  const summary = scoreSummary();
  const exams = (summary['exams'] as Array<Record<string, unknown>> | undefined) ?? [];
  let selected: Record<string, unknown> | undefined;
  for (const item of exams) {
    if (String(item['id']) === String(exam) || item['name'] === exam) {
      selected = item;
      break;
    }
  }
  if (!selected) throw new ScoreError('考试不存在');
  const selectedId = Number(selected['id']);
  const subjectNames = ((selected['subject_stats'] as Array<Record<string, unknown>> | undefined) ?? [])
    .map((item) => String(item['subject'] ?? ''));
  const headers = ['学号', '姓名', ...subjectNames, '总分', '班排名', '分层', '完整性'];
  const data: Array<Array<unknown>> = [];
  for (const student of (summary['students'] as Array<Record<string, unknown>> | undefined) ?? []) {
    const result = ((student['exams'] as Array<Record<string, unknown>> | undefined) ?? []).find(
      (item) => Number(item['exam_id']) === selectedId,
    );
    if (!result || !result['has_any']) continue;
    const subjects = (result['subjects'] as Record<string, Record<string, unknown>> | undefined) ?? {};
    const subjectValues: unknown[] = [];
    for (const name of subjectNames) {
      const item = subjects[name];
      if (!item) subjectValues.push(null);
      else if (item['status'] === '正常') subjectValues.push(item['score']);
      else subjectValues.push(item['status']);
    }
    data.push([
      student['学号'], student['姓名'], ...subjectValues, result['total'],
      result['rank'], result['stratum'],
      result['complete']
        ? '完整'
        : `缺少：${((result['missing_subjects'] as string[] | undefined) ?? []).join('、')}`,
    ]);
  }
  const name = String(selected['name'] ?? '');
  const buffer = await sheetBytes(`成绩汇总-${name}`, headers, data);
  return { buffer, filename: scopedExportFilename(`成绩汇总-${filenamePart(name, '未命名考试')}`) };
}

export async function exportAttendanceReport(
  dateFrom?: string | null, dateTo?: string | null,
): Promise<ExportResult> {
  const rows = attendance.listRecords({
    dateFrom: dateFrom ?? '', dateTo: dateTo ?? '', limit: 50_000,
  });
  const headers = ['日期', '场景', '出勤', '迟到', '请假', '早退', '缺勤', '总记录'];
  const grouped: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const key = JSON.stringify([row['attendance_date'], row['scene']]);
    if (!grouped[key]) {
      grouped[key] = { 出勤: 0, 迟到: 0, 请假: 0, 早退: 0, 缺勤: 0, 总记录: 0 };
    }
    const status = String(row['status'] ?? '');
    grouped[key][status] = (grouped[key][status] ?? 0) + 1;
    grouped[key]['总记录'] += 1;
  }
  const keys = Object.keys(grouped).sort((a, b) => {
    const [dayA, sceneA] = JSON.parse(a) as [string, string];
    const [dayB, sceneB] = JSON.parse(b) as [string, string];
    if (dayA !== dayB) return dayA < dayB ? -1 : 1;
    return sceneA < sceneB ? -1 : sceneA > sceneB ? 1 : 0;
  });
  const data: Array<Array<unknown>> = keys.map((key) => {
    const [day, scene] = JSON.parse(key) as [string, string];
    const item = grouped[key];
    return [day, scene, item['出勤'], item['迟到'], item['请假'], item['早退'],
      item['缺勤'], item['总记录']];
  });
  const total: Record<string, number> = { 出勤: 0, 迟到: 0, 请假: 0, 早退: 0, 缺勤: 0, 总记录: 0 };
  for (const item of Object.values(grouped)) {
    for (const key of Object.keys(total)) total[key] += item[key];
  }
  data.push(['合计', '全部场景', total['出勤'], total['迟到'], total['请假'],
    total['早退'], total['缺勤'], total['总记录']]);
  const buffer = await sheetBytes('考勤汇总', headers, data);
  return { buffer, filename: scopedExportFilename('考勤汇总') };
}

export async function exportHealthSummary(
  periodType = 'month', periodStart = '', periodEnd = '',
): Promise<ExportResult> {
  return health.exportSummary(periodType, periodStart, periodEnd);
}
