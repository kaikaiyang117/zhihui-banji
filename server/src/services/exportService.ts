/* MIG-05 学生导出（与 backend/app/export_service.export_students 一致）。 */
import { getDb, scopeIds } from './context.js';
import { STUDENT_COLUMNS } from '../config/sheets.js';
import { sheetBytes } from './exportXlsx.js';

export async function exportStudents(): Promise<{ buffer: Buffer; filename: string }> {
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const rows = conn.prepare(
    `SELECT ${STUDENT_COLUMNS.map((key) => `s.[${key}]`).join(',')} FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at='' ORDER BY s.学号`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const data = rows.map((row) => STUDENT_COLUMNS.map((key) => row[key] ?? ''));
  const buffer = await sheetBytes('学生信息', STUDENT_COLUMNS, data);
  return { buffer, filename: '学生信息总表.xlsx' };
}
