/* MIG-05 通用工作表行软删除（与 Python recycle.soft_delete_sheet_row 一致）。 */
import { getDb, scopeIds } from './context.js';
import * as audit from './audit.js';
import { SHEET_META } from '../config/sheets.js';
import { RecycleError } from './recycle.js';

export function softDeleteSheetRow(sheet: string, rowNo: number): Record<string, unknown> {
  if (!SHEET_META[sheet]) throw new RecycleError('工作表不存在');
  const conn = getDb().connInstance;
  const write = SHEET_META[sheet].group !== 'personal';
  const [classId, termId] = scopeIds({ write, conn });
  const row = conn.prepare(
    "SELECT * FROM sheet_rows WHERE sheet=? AND row_no=? AND deleted_at='' "
    + 'AND (class_id=? AND term_id=?)',
  ).get(sheet, rowNo, classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new RecycleError('记录不存在或已删除');
  const { actorId } = audit.currentActor();
  const deletedAt = nowString();
  const objectId = `${sheet}:${rowNo}`;
  conn.prepare(
    "UPDATE sheet_rows SET deleted_at=?, deleted_by=? "
    + "WHERE sheet=? AND row_no=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).run(deletedAt, actorId, sheet, rowNo, classId, termId);
  const inserted = conn.prepare(
    `INSERT INTO recycle_bin(
       object_type, object_id, class_id, term_id, label, snapshot,
       status, deleted_by, deleted_at
     ) VALUES('sheet_row',?,?,?,?,?, '已删除', ?,?)`,
  ).run(objectId, classId, termId, `${sheet} · 第 ${rowNo} 行`,
    JSON.stringify(row), actorId, deletedAt);
  audit.record(
    'sheet_row', objectId, 'delete', {
      summary: `${sheet} 第 ${rowNo} 行移入回收站`,
      params: { sheet, row_no: rowNo }, classId, termId, conn,
    },
  );
  return { ok: true, recycle_id: Number(inserted.lastInsertRowid) };
}

function nowString(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
