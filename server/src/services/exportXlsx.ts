/* MIG-05 Excel 输出辅助：与 Python export_service._sheet_bytes 语义一致。
 * 表头加粗 + 填充色 + 固定列宽 16。日期按朴素本地日期序列号写入（MIG-01 约定）。
 */
import ExcelJS from 'exceljs';

/** 按本地日历分量计算序列号（1899-12-30 起算），避免 exceljs 的 UTC 时区偏移。 */
export function naiveDateSerial(date: Date): number {
  const epoch = Date.UTC(1899, 11, 30);
  const local = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((local - epoch) / 86400000);
}

export async function sheetBytes(title: string, headers: string[], rows: Array<Array<unknown>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.getRow(1).values = headers;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF5B6ABF' },
  };
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  for (let r = 0; r < rows.length; r += 1) {
    const row = ws.getRow(r + 2);
    for (let c = 0; c < rows[r].length; c += 1) {
      const value = rows[r][c];
      if (value === null || value === undefined) continue;
      if (value instanceof Date) {
        row.getCell(c + 1).value = naiveDateSerial(value);
        row.getCell(c + 1).numFmt = 'yyyy-mm-dd';
      } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        row.getCell(c + 1).value = value;
      } else {
        row.getCell(c + 1).value = String(value);
      }
    }
  }
  for (let c = 1; c <= headers.length; c += 1) {
    ws.getColumn(c).width = 16;
  }
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
