/* MIG-05 路由：班级/学期/在班关系、学生、通用工作表、座位表。
 * 错误映射：409 冲突/归档、400 业务、404 不存在。
 */
import type { FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  createClass, updateClass, createTerm, updateTerm, rolloverTerm,
  enrollStudent, updateEnrollment, transferEnrollment,
  listContexts, listEnrollments, listStudentDirectory,
  ScopeError, ArchivedScopeError,
} from '../../services/context.js';
import {
  listStudents, createStudent, updateStudent,
  savePhoto, removePhoto, photoPath, StudentPhotoError, StudentDuplicateError,
  type StudentFields,
} from '../../services/students.js';
import {
  buildTemplate, previewStudents, commitStudentImport, importStudents,
} from '../../services/importService.js';
import { exportStudents } from '../../services/exportService.js';
import * as sheetsService from '../../services/sheets.js';
import { SheetError } from '../../services/sheets.js';
import { softDeleteSheetRow } from '../../services/recycleSheets.js';
import { RecycleError } from '../../services/recycle.js';
import { getDb, scopeIds } from '../../services/context.js';
import * as audit from '../../services/audit.js';
import { sheetBytes } from '../../services/exportXlsx.js';
import { ensureStudentInScope } from '../../services/context.js';

const XLSX_MEDIA = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function errorHandler(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof ArchivedScopeError) return reply.status(409).send({ detail: error.message });
  if (error instanceof ScopeError) return reply.status(400).send({ detail: error.message });
  if (error instanceof StudentDuplicateError) return reply.status(409).send({ detail: error.message });
  if (error instanceof StudentPhotoError) return reply.status(404).send({ detail: error.message });
  if (error instanceof SheetError) return reply.status(404).send({ detail: error.message });
  if (error instanceof RecycleError) return reply.status(404).send({ detail: error.message });
  const record = error as { code?: unknown; message?: string };
  if (record && typeof record.code === 'string' && record.code.startsWith('SQLITE_CONSTRAINT')) {
    return reply.status(409).send({ detail: '名称或在班关系已存在' });
  }
  return undefined;
}

function xlsxReply(reply: FastifyReply, buffer: Buffer, filename: string): void {
  reply.header('Content-Type', XLSX_MEDIA);
  reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  reply.send(buffer);
}

export function registerMig05Routes(app: FastifyInstance): void {
  // ---------- 班级 / 学期 / 在班关系 ----------
  app.get('/api/context', async (_request, reply) => {
    try { return listContexts(); } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/classes', async (request, reply) => {
    const body = request.body as { name: string; grade?: string; term_name?: string; start_date?: string; end_date?: string };
    try {
      const result = createClass(body.name, body.grade ?? '', body.term_name ?? '当前学期',
        body.start_date ?? '', body.end_date ?? '');
      return { ok: true, ...result };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.put('/api/classes/:classId', async (request, reply) => {
    const { classId } = request.params as { classId: string };
    const body = request.body as { name?: string; grade?: string; status?: string };
    try {
      updateClass(Number(classId), { name: body.name ?? null, grade: body.grade ?? null, status: body.status ?? null });
      return { ok: true };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/classes/:classId/terms', async (request, reply) => {
    const { classId } = request.params as { classId: string };
    const body = request.body as { name: string; start_date?: string; end_date?: string };
    try {
      const termId = createTerm(Number(classId), body.name, body.start_date ?? '', body.end_date ?? '');
      return { ok: true, term_id: termId };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.put('/api/terms/:termId', async (request, reply) => {
    const { termId } = request.params as { termId: string };
    const body = request.body as { name?: string; start_date?: string; end_date?: string; status?: string };
    try {
      updateTerm(Number(termId), {
        name: body.name ?? null, startDate: body.start_date ?? null,
        endDate: body.end_date ?? null, status: body.status ?? null,
      });
      return { ok: true };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/terms/:termId/rollover', async (request, reply) => {
    const { termId } = request.params as { termId: string };
    const body = request.body as { name: string; start_date?: string; end_date?: string; archive_source?: boolean };
    try {
      const result = rolloverTerm(Number(termId), body.name, body.start_date ?? '', body.end_date ?? '',
        body.archive_source ?? true);
      return { ok: true, ...result };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get('/api/enrollments', async () => ({ enrollments: listEnrollments() }));

  app.post('/api/enrollments', async (request, reply) => {
    const body = request.body as { student_id: number; status?: string };
    try {
      const enrollmentId = enrollStudent(Number(body.student_id), { status: body.status ?? '在读' });
      return { ok: true, enrollment_id: enrollmentId };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.put('/api/enrollments/:enrollmentId', async (request, reply) => {
    const { enrollmentId } = request.params as { enrollmentId: string };
    const body = request.body as { status: string };
    try {
      updateEnrollment(Number(enrollmentId), body.status);
      return { ok: true };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/enrollments/:enrollmentId/transfer', async (request, reply) => {
    const { enrollmentId } = request.params as { enrollmentId: string };
    const body = request.body as { target_class_id: number; target_term_id: number };
    try {
      const targetId = transferEnrollment(Number(enrollmentId), Number(body.target_class_id), Number(body.target_term_id));
      return { ok: true, enrollment_id: targetId };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  // ---------- 学生 ----------
  app.get('/api/students', async (request) => {
    const { keyword } = request.query as { keyword?: string };
    return listStudents(keyword ?? '');
  });

  app.get('/api/students/directory', async () => ({ students: listStudentDirectory() }));

  app.get('/api/students/template', async (_request, reply) => {
    const buffer = await buildTemplate();
    xlsxReply(reply, buffer, '学生信息导入模板.xlsx');
    return reply;
  });

  app.get('/api/students/export', async (_request, reply) => {
    const result = await exportStudents();
    xlsxReply(reply, result.buffer, result.filename);
    return reply;
  });

  app.post('/api/students', async (request, reply) => {
    const body = request.body as StudentFields;
    try {
      const studentId = createStudent(body);
      enrollStudent(studentId);
      return { ok: true, id: studentId };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.put('/api/students/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const body = request.body as StudentFields;
    try {
      updateStudent(Number(sid), body);
      return { ok: true };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.delete('/api/students/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    try {
      const { softDelete } = await import('../../services/recycle.js');
      return softDelete('student', Number(sid));
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/students/:sid/photo', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    try {
      const student = ensureStudentInScope(Number(sid), { write: true });
      const data = await (request as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
      const saved = savePhoto(Number(sid), data);
      const conn = getDb().connInstance;
      const oldPath = String(student.photo_path ?? '');
      conn.prepare(
        "UPDATE students SET photo_path=?, updated_at=datetime('now','localtime') WHERE id=?",
      ).run(saved.relative_path, Number(sid));
      audit.record('student', Number(sid), 'photo_update', {
        summary: `更新学生头像：${student.姓名 ?? ''}`,
        params: { size_bytes: saved.size_bytes, content_type: saved.content_type },
        conn,
      });
      removePhoto(oldPath || null);
      const [classId, termId] = scopeIds();
      return { ok: true, photo_url: `/api/students/${sid}/photo?class_id=${classId}&term_id=${termId}` };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get('/api/students/:sid/photo', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    try {
      const student = ensureStudentInScope(Number(sid));
      const target = photoPath(String(student.photo_path ?? ''));
      if (!target) return reply.status(404).send({ detail: '该学生尚未上传头像' });
      return reply.type('image/*').send(await import('node:fs').then((fs) => fs.promises.readFile(target)));
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.delete('/api/students/:sid/photo', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    try {
      const student = ensureStudentInScope(Number(sid), { write: true });
      const oldPath = String(student.photo_path ?? '');
      if (!oldPath) return { ok: true };
      const conn = getDb().connInstance;
      conn.prepare(
        "UPDATE students SET photo_path='', updated_at=datetime('now','localtime') WHERE id=?",
      ).run(Number(sid));
      audit.record('student', Number(sid), 'photo_remove', {
        summary: `移除学生头像：${student.姓名 ?? ''}`,
        conn,
      });
      removePhoto(oldPath);
      return { ok: true };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/students/import', async (request, reply) => {
    const data = await readUpload(request);
    try {
      return await importStudents(data.buffer, data.filename);
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/students/import/preview', async (request) => {
    const data = await readUpload(request);
    return previewStudents(data.buffer, data.filename);
  });

  app.post('/api/students/import/commit', async (request, reply) => {
    const body = request.body as { filename?: string; rows?: Array<{ row: number; fields: Record<string, string> }> };
    try {
      return commitStudentImport(body.rows ?? [], body.filename ?? '');
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  // ---------- 通用工作表 ----------
  app.get('/api/sheets', async () => sheetsService.listSheets());

  app.get('/api/sheet/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!sheetsService.SHEET_META[name]) {
      return reply.status(404).send({ detail: `工作表 "${name}" 不存在` });
    }
    if (name === '考勤管理') {
      return {
        name,
        headers: ['日期', '星期', '学号', '姓名', '状态', '到校时间', '离校时间', '原因', '备注', '考勤场景'],
        rows: sheetsService.attendanceCompatibilityRows(),
      };
    }
    const meta = sheetsService.getSheetMeta(name);
    const rows = sheetsService.derive(name, sheetsService.getRows(name));
    return {
      name,
      headers: meta ? meta.headers : [],
      rows: rows.map((row) => ({ row_no: row.row_no, data: row.data })),
    };
  });

  app.post('/api/sheet/:name/append', async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = request.body as { data: unknown[] };
    const blocked = structuredSheetBlock(name);
    if (blocked) return reply.status(409).send({ detail: blocked });
    if (!sheetsService.SHEET_META[name]) {
      return reply.status(404).send({ detail: `工作表 "${name}" 不存在` });
    }
    if (!Array.isArray(body.data) || body.data.length === 0) {
      return reply.status(400).send({ detail: '缺少 data 参数' });
    }
    try {
      const rowNo = sheetsService.insertRow(name, body.data);
      sheetsService.recordSheetAudit('sheet_row', `${name}:${rowNo}`, 'create',
        `新增${name}记录`, { sheet: name, row_no: rowNo });
      return { ok: true, row_no: Number(rowNo) };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.put('/api/sheet/:name/update', async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = request.body as { row_no: number; col: number; value: unknown };
    const blocked = structuredSheetBlock(name);
    if (blocked) return reply.status(409).send({ detail: blocked });
    if (!sheetsService.SHEET_META[name]) {
      return reply.status(404).send({ detail: `工作表 "${name}" 不存在` });
    }
    try {
      sheetsService.updateCell(name, Number(body.row_no), Number(body.col), body.value);
      sheetsService.recordSheetAudit('sheet_row', `${name}:${body.row_no}`, 'update',
        `更新${name}记录`, { sheet: name, row_no: body.row_no, col: body.col, value: body.value });
      return { ok: true, row_no: Number(body.row_no), col: Number(body.col) };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.delete('/api/sheet/:name/row/:rowNo', async (request, reply) => {
    const { name, rowNo } = request.params as { name: string; rowNo: string };
    const blocked = structuredSheetBlock(name);
    if (blocked) return reply.status(409).send({ detail: blocked });
    if (!sheetsService.SHEET_META[name]) {
      return reply.status(404).send({ detail: `工作表 "${name}" 不存在` });
    }
    try {
      return softDeleteSheetRow(name, Number(rowNo));
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  // ---------- 座位表 ----------
  app.get('/api/seating', async () => {
    const conn = getDb().connInstance;
    const [classId, termId] = scopeIds({ conn });
    const rows = conn.prepare(
      'SELECT r, c, val FROM seating WHERE class_id=? AND term_id=?',
    ).all(classId, termId) as Array<{ r: number; c: number; val: string }>;
    void rows;
    const grid: string[][] = [];
    const specials: Record<string, string> = {};
    for (const row of rows) {
      while (grid.length <= row.r) grid.push([]);
      while (grid[row.r].length <= row.c) grid[row.r].push('');
      grid[row.r][row.c] = row.val;
      if (['讲台', '前门', '后门', '过道'].includes(row.val)) {
        specials[`${row.r},${row.c}`] = row.val;
      }
    }
    return { grid, specials, rows: grid.length, cols: grid.length > 0 ? grid[0].length : 0 };
  });

  app.post('/api/seating/update', async (request, reply) => {
    try {
      const conn = getDb().connInstance;
      const [classId, termId] = scopeIds({ write: true, conn });
      const body = request.body as { row: number; col: number; value: string };
      conn.prepare(
        'INSERT OR REPLACE INTO seating(class_id, term_id, r, c, val) VALUES(?,?,?,?,?)',
      ).run(classId, termId, Number(body.row), Number(body.col), String(body.value ?? ''));
      return { ok: true };
    } catch (error) {
      const mapped = errorHandler(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });
}

function structuredSheetBlock(name: string): string {
  const blocks: Record<string, string> = {
    '考勤管理': '考勤已升级为结构化记录，请使用考勤管理页面批量保存',
    '日常行为积分': '行为积分已升级为结构化流水，请使用行为积分页面新增记录',
    '班费管理': '班费已升级为结构化分类账，请使用班费管理页面新增流水',
    '评语管理': '评语已升级为结构化审核工作流，请使用评语管理页面新增草稿',
  };
  return blocks[name] ?? '';
}

async function readUpload(request: FastifyRequest): Promise<{ buffer: Buffer; filename: string }> {
  const multipart = request as unknown as {
    file?: () => Promise<{ toBuffer: () => Promise<Buffer>; filename?: string }>;
    rawBody?: Buffer;
  };
  if (typeof multipart.file === 'function') {
    const part = await multipart.file();
    return { buffer: await part.toBuffer(), filename: part.filename ?? '' };
  }
  return { buffer: multipart.rawBody ?? Buffer.alloc(0), filename: '' };
}

export { XLSX_MEDIA, sheetBytes };
