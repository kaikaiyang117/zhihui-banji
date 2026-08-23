import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

import type {
  ColumnProfile, TableRegion, WorkbookBlueprint, WorkbookSheet,
} from '../domain/types.js';

export const MAX_SHEETS = 20;
export const MAX_ROWS_PER_SHEET = 100_000;
export const MAX_COLUMNS_PER_SHEET = 200;

export class WorkbookParserError extends Error {}

function columnName(index: number): string {
  let value = index;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result || 'A';
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object' && value !== null && 'formula' in value) return '';
  return String(value).trim();
}

function valueType(value: unknown): ColumnProfile['inferredType'] {
  if (value === null || value === undefined || value === '') return 'empty';
  if (value instanceof Date) return 'date';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  const text = String(value).trim();
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(text)) return 'date';
  if (text !== '' && Number.isFinite(Number(text))) return 'number';
  return 'text';
}

function mergeTypes(types: ColumnProfile['inferredType'][]): ColumnProfile['inferredType'] {
  const nonEmpty = types.filter(type => type !== 'empty');
  if (nonEmpty.length === 0) return 'empty';
  const first = nonEmpty[0];
  return nonEmpty.every(type => type === first) ? first : 'mixed';
}

function headerRowFor(sheet: ExcelJS.Worksheet): number {
  const limit = Math.min(sheet.rowCount, 10);
  let bestRow = 1;
  let bestScore = -1;
  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, cell => {
      const text = cellText(cell.value);
      if (text) values.push(text);
    });
    const unique = new Set(values).size;
    const score = values.length * 10 + unique - rowNumber;
    if (values.length > 0 && score > bestScore) {
      bestRow = rowNumber;
      bestScore = score;
    }
  }
  return bestRow;
}

function regionForSheet(sheet: ExcelJS.Worksheet): TableRegion[] {
  if (sheet.rowCount < 1 || sheet.columnCount < 1) return [];
  const headerRow = headerRowFor(sheet);
  const headers: string[] = [];
  for (let column = 1; column <= sheet.columnCount; column += 1) {
    headers.push(cellText(sheet.getCell(headerRow, column).value));
  }
  const nonEmptyHeaders = headers.filter(Boolean);
  if (nonEmptyHeaders.length === 0) return [];
  const inferredTypes: ColumnProfile[] = headers.map((header, index) => {
    const values: unknown[] = [];
    const end = Math.min(sheet.rowCount, headerRow + 20);
    for (let row = headerRow + 1; row <= end; row += 1) {
      values.push(sheet.getCell(row, index + 1).value);
    }
    const nonEmpty = values.filter(value => value !== null && value !== undefined && value !== '');
    const distinct = new Set(nonEmpty.map(value => cellText(value))).size;
    return {
      header,
      nonEmptyCount: nonEmpty.length,
      distinctCount: distinct,
      inferredType: mergeTypes(values.map(valueType)),
    };
  });
  const filledRatio = nonEmptyHeaders.length / Math.max(headers.length, 1);
  return [{
    id: `sheet-${sheet.id}-region-1`,
    range: `A${headerRow}:${columnName(sheet.columnCount)}${sheet.rowCount}`,
    headerRows: [headerRow],
    headers,
    rowCount: Math.max(sheet.rowCount - headerRow, 0),
    columnCount: sheet.columnCount,
    inferredTypes,
    confidence: Math.min(1, 0.55 + filledRatio * 0.45),
  }];
}

function sheetBlueprint(sheet: ExcelJS.Worksheet, index: number): WorkbookSheet {
  let formulaCount = 0;
  sheet.eachRow({ includeEmpty: false }, row => {
    row.eachCell({ includeEmpty: false }, cell => {
      if (cell.value && typeof cell.value === 'object' && 'formula' in cell.value) formulaCount += 1;
    });
  });
  const model = (sheet as unknown as { model?: { merges?: string[] } }).model;
  return {
    index,
    name: sheet.name,
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
    usedRange: sheet.rowCount > 0 && sheet.columnCount > 0
      ? `A1:${columnName(sheet.columnCount)}${sheet.rowCount}` : '',
    mergedRanges: Array.isArray(model?.merges) ? [...model.merges] : [],
    hiddenRows: Array.from({ length: sheet.rowCount }, (_, position) => position + 1)
      .filter(rowNumber => sheet.getRow(rowNumber).hidden),
    hiddenColumns: Array.from({ length: sheet.columnCount }, (_, position) => position + 1)
      .filter(columnNumber => sheet.getColumn(columnNumber).hidden),
    regions: regionForSheet(sheet),
    formulaCount,
  };
}

export async function parseWorkbookBuffer(buffer: Buffer): Promise<WorkbookBlueprint> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new WorkbookParserError('不是有效的 .xlsx 工作簿');
  }
  if (workbook.worksheets.length > MAX_SHEETS) {
    throw new WorkbookParserError(`工作表不能超过 ${MAX_SHEETS} 个`);
  }
  const sheets = workbook.worksheets.map((sheet, index) => {
    if (sheet.rowCount > MAX_ROWS_PER_SHEET) {
      throw new WorkbookParserError(`工作表“${sheet.name}”超过 ${MAX_ROWS_PER_SHEET} 行`);
    }
    if (sheet.columnCount > MAX_COLUMNS_PER_SHEET) {
      throw new WorkbookParserError(`工作表“${sheet.name}”超过 ${MAX_COLUMNS_PER_SHEET} 列`);
    }
    return sheetBlueprint(sheet, index);
  });
  return { version: 1, sheets, generatedAt: new Date().toISOString() };
}

export async function parseWorkbookFile(filePath: string): Promise<WorkbookBlueprint> {
  return parseWorkbookBuffer(await fs.readFile(path.resolve(filePath)));
}
