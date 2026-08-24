import fs from 'node:fs/promises';
import ExcelJS from 'exceljs';

import type { TableRegion } from '../domain/types.js';
import { MAX_COLUMNS_PER_SHEET, MAX_ROWS_PER_SHEET } from '../parser/workbookParser.js';

export const MAX_QUERY_ROWS = 200;
export const MAX_QUERY_COLUMNS = 50;

export type ExposurePolicy = 'structure_only' | 'redacted_values' | 'allowed_values';

export class WorkbookQueryError extends Error {}

export type QueryOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';
export interface WorkbookQueryFilter { column: string; op: QueryOperator; value?: unknown }
export interface WorkbookQueryAggregate { function: 'count' | 'sum' | 'avg' | 'min' | 'max'; column?: string; as?: string }

type CellValue = string | number | boolean | Date | null | undefined | { formula?: string; result?: unknown };

interface RangeRef {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

function columnNumber(value: string): number {
  let result = 0;
  for (const char of value.toUpperCase()) {
    if (char < 'A' || char > 'Z') throw new WorkbookQueryError('Excel 范围列名无效');
    result = result * 26 + char.charCodeAt(0) - 64;
  }
  return result;
}

function columnName(value: number): string {
  let current = value;
  let result = '';
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function parseCell(value: string): { row: number; column: number } {
  const match = /^([A-Za-z]+)(\d+)$/.exec(value.trim());
  if (!match) throw new WorkbookQueryError(`Excel 单元格范围无效：${value}`);
  const row = Number(match[2]);
  const column = columnNumber(match[1]);
  if (!Number.isInteger(row) || row < 1 || column < 1) {
    throw new WorkbookQueryError(`Excel 单元格范围无效：${value}`);
  }
  return { row, column };
}

function parseRange(value: string, limits = {
  maxRows: MAX_QUERY_ROWS, maxColumns: MAX_QUERY_COLUMNS,
}): RangeRef {
  const parts = String(value ?? '').split(':');
  if (parts.length > 2 || parts.some(part => !part.trim())) {
    throw new WorkbookQueryError(`Excel 范围无效：${value}`);
  }
  const start = parseCell(parts[0]);
  const end = parseCell(parts[1] ?? parts[0]);
  const range = {
    startRow: Math.min(start.row, end.row), startColumn: Math.min(start.column, end.column),
    endRow: Math.max(start.row, end.row), endColumn: Math.max(start.column, end.column),
  };
  if (range.endRow - range.startRow + 1 > limits.maxRows) {
    throw new WorkbookQueryError(`单次读取不能超过 ${limits.maxRows} 行`);
  }
  if (range.endColumn - range.startColumn + 1 > limits.maxColumns) {
    throw new WorkbookQueryError(`单次读取不能超过 ${limits.maxColumns} 列`);
  }
  return range;
}

function valueText(value: CellValue): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (value && typeof value.formula === 'string') return `=${value.formula}`;
    return '';
  }
  return String(value).slice(0, 200);
}

function valueType(value: CellValue): 'empty' | 'text' | 'number' | 'boolean' | 'date' | 'formula' {
  if (value === null || value === undefined || value === '') return 'empty';
  if (value instanceof Date) return 'date';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object' && value && typeof value.formula === 'string') return 'formula';
  return 'text';
}

function exposedValue(value: CellValue, policy: ExposurePolicy): unknown {
  if (policy === 'structure_only') return undefined;
  if (policy === 'redacted_values') return value === null || value === undefined || value === '' ? null : '[已脱敏]';
  return valueText(value) || null;
}

async function loadSheet(filePath: string, sheetIndex: number): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(await fs.readFile(filePath));
  } catch {
    throw new WorkbookQueryError('Excel 文件无法读取');
  }
  const sheet = workbook.worksheets[sheetIndex];
  if (!sheet) throw new WorkbookQueryError(`工作表不存在：${sheetIndex}`);
  return sheet;
}

export async function readWorkbookRange(options: {
  filePath: string;
  sheetIndex: number;
  range: string;
  exposurePolicy?: ExposurePolicy;
}): Promise<Record<string, unknown>> {
  const sheet = await loadSheet(options.filePath, options.sheetIndex);
  const ref = parseRange(options.range);
  const policy = options.exposurePolicy ?? 'structure_only';
  const columns = Array.from({ length: ref.endColumn - ref.startColumn + 1 }, (_, index) => ({
    column: ref.startColumn + index,
    letter: columnName(ref.startColumn + index),
    non_empty_count: 0,
    inferred_types: new Set<string>(),
  }));
  const rows: unknown[][] = [];
  const headers: string[] = [];
  for (let rowNumber = ref.startRow; rowNumber <= ref.endRow; rowNumber += 1) {
    const row: unknown[] = [];
    for (let index = 0; index < columns.length; index += 1) {
      const value = sheet.getCell(rowNumber, ref.startColumn + index).value as CellValue;
      const type = valueType(value);
      columns[index].inferred_types.add(type);
      if (type !== 'empty') columns[index].non_empty_count += 1;
      row.push(exposedValue(value, policy));
      // A range may start in the data area (for example A2:C10).  Returning
      // its first row as “headers” would leak real names/IDs under
      // structure_only.  Keep the existing A1 structural header behaviour
      // for compatibility, but never expose arbitrary data rows.
      if (rowNumber === ref.startRow) {
        headers.push(policy === 'allowed_values' || (policy === 'structure_only' && ref.startRow === 1)
          ? valueText(value) : '');
      }
    }
    rows.push(row);
  }
  const result: Record<string, unknown> = {
    sheet_index: options.sheetIndex,
    sheet_name: sheet.name,
    range: `${columnName(ref.startColumn)}${ref.startRow}:${columnName(ref.endColumn)}${ref.endRow}`,
    exposure_policy: policy,
    row_count: rows.length,
    column_count: columns.length,
    headers,
    columns: columns.map(column => ({
      column: column.column, letter: column.letter, non_empty_count: column.non_empty_count,
      inferred_types: [...column.inferred_types].sort(),
    })),
  };
  if (policy !== 'structure_only') result['rows'] = rows;
  return result;
}

export async function profileWorkbookRegion(options: {
  filePath: string;
  sheetIndex: number;
  region: TableRegion;
}): Promise<Record<string, unknown>> {
  const sheet = await loadSheet(options.filePath, options.sheetIndex);
  const ref = parseRange(options.region.range, {
    maxRows: MAX_ROWS_PER_SHEET, maxColumns: MAX_COLUMNS_PER_SHEET,
  });
  const profiles = Array.from({ length: ref.endColumn - ref.startColumn + 1 }, (_, index) => ({
    column: ref.startColumn + index,
    letter: columnName(ref.startColumn + index),
    non_empty_count: 0,
    distinct_values: new Set<string>(),
    types: new Set<string>(),
  }));
  const dataStartRow = ref.startRow + options.region.headerRows.length;
  for (let rowNumber = dataStartRow; rowNumber <= ref.endRow; rowNumber += 1) {
    for (let index = 0; index < profiles.length; index += 1) {
      const value = sheet.getCell(rowNumber, ref.startColumn + index).value as CellValue;
      const type = valueType(value);
      profiles[index].types.add(type);
      if (type !== 'empty') {
        profiles[index].non_empty_count += 1;
        profiles[index].distinct_values.add(valueText(value));
      }
    }
  }
  return {
    sheet_index: options.sheetIndex,
    sheet_name: sheet.name,
    region_id: options.region.id,
    range: options.region.range,
    row_count: Math.max(ref.endRow - dataStartRow + 1, 0),
    column_count: profiles.length,
    columns: profiles.map(profile => ({
      column: profile.column, letter: profile.letter,
      non_empty_count: profile.non_empty_count,
      distinct_count: profile.distinct_values.size,
      inferred_types: [...profile.types].sort(),
    })),
  };
}

function compareQueryValue(left: unknown, right: unknown, op: QueryOperator): boolean {
  const lText = valueText(left as CellValue);
  const rText = valueText(right as CellValue);
  const lNumber = Number(left);
  const rNumber = Number(right);
  const numeric = Number.isFinite(lNumber) && Number.isFinite(rNumber) && lText !== '' && rText !== '';
  const l = numeric ? lNumber : lText;
  const r = numeric ? rNumber : rText;
  if (op === 'contains') return lText.toLowerCase().includes(rText.toLowerCase());
  if (op === 'eq') return l === r;
  if (op === 'neq') return l !== r;
  if (op === 'gt') return l > r;
  if (op === 'gte') return l >= r;
  if (op === 'lt') return l < r;
  return l <= r;
}

/** Executes a bounded query locally. Raw cell values are returned only when
 * the caller already has an explicit allowed_values capability. */
export async function queryWorkbookRegion(options: {
  filePath: string;
  sheetIndex: number;
  region: TableRegion;
  select?: string[];
  filters?: WorkbookQueryFilter[];
  sort?: { column: string; direction?: 'asc' | 'desc' };
  aggregate?: WorkbookQueryAggregate[];
  limit?: number;
  exposurePolicy?: ExposurePolicy;
}): Promise<Record<string, unknown>> {
  const sheet = await loadSheet(options.filePath, options.sheetIndex);
  const ref = parseRange(options.region.range, { maxRows: MAX_ROWS_PER_SHEET, maxColumns: MAX_COLUMNS_PER_SHEET });
  const headerRow = options.region.headerRows[0] ?? ref.startRow;
  const headers = Array.from({ length: ref.endColumn - ref.startColumn + 1 }, (_, index) => {
    const raw = sheet.getCell(headerRow, ref.startColumn + index).value as CellValue;
    return valueText(raw) || columnName(ref.startColumn + index);
  });
  const keyIndex = (key: string): number => {
    const normalized = key.trim().toLowerCase();
    const byHeader = headers.findIndex(header => header.trim().toLowerCase() === normalized);
    if (byHeader >= 0) return byHeader;
    const byLetter = headers.findIndex((_, index) => columnName(ref.startColumn + index).toLowerCase() === normalized);
    return byLetter;
  };
  const resolveColumnKey = (key: string): string | null => {
    const index = keyIndex(key);
    return index >= 0 ? headers[index] : null;
  };
  const records: Array<Record<string, unknown>> = [];
  const dataStart = Math.max(headerRow + 1, ref.startRow + options.region.headerRows.length);
  for (let rowNumber = dataStart; rowNumber <= ref.endRow; rowNumber += 1) {
    const values = headers.map((_, index) => sheet.getCell(rowNumber, ref.startColumn + index).value as CellValue);
    if (!values.some(value => valueText(value))) continue;
    const record: Record<string, unknown> = {};
    headers.forEach((header, index) => { record[header] = values[index]; });
    const matches = (options.filters ?? []).every(filter => {
      const index = keyIndex(filter.column);
      return index >= 0 && compareQueryValue(values[index], filter.value, filter.op);
    });
    if (matches) records.push(record);
  }
  if (options.sort) {
    const sortColumn = resolveColumnKey(options.sort.column);
    if (!sortColumn) throw new WorkbookQueryError(`排序列不存在：${options.sort.column}`);
    const direction = options.sort.direction === 'desc' ? -1 : 1;
    records.sort((left, right) => {
      const result = compareQueryValue(left[sortColumn], right[sortColumn], 'lt') ? -1 :
        compareQueryValue(left[sortColumn], right[sortColumn], 'gt') ? 1 : 0;
      return result * direction;
    });
  }
  const aggregates = (options.aggregate ?? []).map(item => {
    const aggregateColumn = item.column ? resolveColumnKey(item.column) : null;
    if (item.column && !aggregateColumn) throw new WorkbookQueryError(`聚合列不存在：${item.column}`);
    const values = aggregateColumn ? records.map(record => Number(record[aggregateColumn])).filter(Number.isFinite) : [];
    let value: number;
    if (item.function === 'count') value = item.column ? values.length : records.length;
    else if (item.function === 'sum') value = values.reduce((sum, current) => sum + current, 0);
    else if (item.function === 'avg') value = values.length ? values.reduce((sum, current) => sum + current, 0) / values.length : 0;
    else if (item.function === 'min') value = values.length ? Math.min(...values) : 0;
    else value = values.length ? Math.max(...values) : 0;
    return { as: item.as ?? `${item.function}_${item.column ?? 'rows'}`, value };
  });
  const policy = options.exposurePolicy ?? 'structure_only';
  const selectedKeys = options.select?.length ? options.select : headers;
  const selected = selectedKeys.map(key => {
    const resolved = resolveColumnKey(key);
    if (!resolved) throw new WorkbookQueryError(`查询列不存在：${key}`);
    return resolved;
  });
  const limit = Math.max(1, Math.min(Number(options.limit ?? 50), MAX_QUERY_ROWS));
  const result: Record<string, unknown> = {
    sheet_index: options.sheetIndex, sheet_name: sheet.name, region_id: options.region.id,
    columns: selected, matched_count: records.length, returned_count: Math.min(records.length, limit),
    aggregates, exposure_policy: policy,
  };
  if (policy !== 'structure_only') {
    result.rows = records.slice(0, limit).map(record => Object.fromEntries(
      selected.map(key => [key, exposedValue(record[key] as CellValue, policy)]),
    ));
  }
  return result;
}
