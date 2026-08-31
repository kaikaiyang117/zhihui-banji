/* MIG-11 路由：高中课程表与教学日程。 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import ExcelJS from 'exceljs';

import * as timetable from '../../services/timetable.js';
import { ArchivedScopeError, ScopeError } from '../../services/context.js';
import { todayString } from '../../services/clock.js';

function wrap(reply: FastifyReply, fn: () => unknown): unknown {
  try { return fn(); } catch (error) {
    if (error instanceof ArchivedScopeError) return reply.status(409).send({ detail: error.message });
    if (error instanceof ScopeError) return reply.status(400).send({ detail: error.message });
    if (error instanceof timetable.TimetableError) {
      return reply.status(String(error.message).includes('不存在') ? 404 : 400).send({ detail: error.message });
    }
    const record = error as { code?: unknown };
    if (record && typeof record.code === 'string' && record.code.startsWith('SQLITE_CONSTRAINT')) {
      return reply.status(409).send({ detail: '课程表中存在重复节次或安排，请检查后重试' });
    }
    throw error;
  }
}

async function readRows(request: { file?: () => Promise<{ toBuffer: () => Promise<Buffer>; filename?: string } | undefined> }): Promise<{ rows: unknown[][]; filename: string }> {
  const part = typeof request.file === 'function' ? await request.file() : undefined;
  if (!part) return { rows: [], filename: '' };
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await part.toBuffer());
  const worksheet = workbook.worksheets[0];
  const rows: unknown[][] = [];
  for (let rowNo = 1; rowNo <= worksheet.rowCount; rowNo += 1) {
    const row: unknown[] = [];
    for (let columnNo = 1; columnNo <= worksheet.columnCount; columnNo += 1) {
      const value = worksheet.getRow(rowNo).getCell(columnNo).value;
      if (value instanceof Date) row.push(value.toISOString().slice(0, 10));
      else if (typeof value === 'object' && value !== null && 'formula' in value) {
        row.push(`=${(value as { formula: string }).formula}`);
      } else row.push(value);
    }
    rows.push(row);
  }
  return { rows, filename: part.filename ?? '' };
}

export function registerMig11Routes(app: FastifyInstance): void {
  app.get('/api/timetable', async (request, reply) => {
    const query = request.query as { teacher_name?: string; weekday?: string };
    return wrap(reply, () => timetable.listTimetable({
      teacherName: query.teacher_name ?? '', weekday: query.weekday ? Number(query.weekday) : undefined,
    }));
  });

  app.get('/api/timetable/day', async (request, reply) => {
    const query = request.query as { date?: string };
    return wrap(reply, () => timetable.daySchedule(query.date ?? todayString()));
  });

  app.get('/api/timetable/changes', async (request, reply) => {
    const query = request.query as { date_from?: string; date_to?: string };
    return wrap(reply, () => ({ changes: timetable.listChanges({ dateFrom: query.date_from, dateTo: query.date_to }) }));
  });

  app.post('/api/timetable/periods', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({ ok: true, period: timetable.createPeriod({
      periodNo: Number(body.period_no), label: String(body.label ?? ''), startTime: String(body.start_time ?? ''),
      endTime: String(body.end_time ?? ''), sessionType: String(body.session_type ?? '普通课'),
    }) }));
  });

  app.put('/api/timetable/periods/:periodId', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({ ok: true, period: timetable.updatePeriod(Number((request.params as { periodId: string }).periodId), {
      label: body.label as string | undefined, startTime: body.start_time as string | undefined,
      endTime: body.end_time as string | undefined, sessionType: body.session_type as string | undefined,
      enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
    }) }));
  });

  app.post('/api/timetable/entries', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({ ok: true, entry: timetable.createEntry({
      weekday: Number(body.weekday), periodNo: Number(body.period_no), subject: String(body.subject ?? ''),
      teacherName: String(body.teacher_name ?? ''), room: String(body.room ?? ''), sessionType: String(body.session_type ?? '普通课'),
      weekPattern: String(body.week_pattern ?? '全周'), weekStart: Number(body.week_start ?? 1), weekEnd: Number(body.week_end ?? 99), note: String(body.note ?? ''),
    }) }));
  });

  app.put('/api/timetable/entries/:entryId', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({ ok: true, entry: timetable.updateEntry(Number((request.params as { entryId: string }).entryId), {
      weekday: body.weekday === undefined ? undefined : Number(body.weekday), periodNo: body.period_no === undefined ? undefined : Number(body.period_no),
      subject: body.subject as string | undefined, teacherName: body.teacher_name as string | undefined, room: body.room as string | undefined,
      sessionType: body.session_type as string | undefined, weekPattern: body.week_pattern as string | undefined,
      weekStart: body.week_start === undefined ? undefined : Number(body.week_start), weekEnd: body.week_end === undefined ? undefined : Number(body.week_end),
      note: body.note as string | undefined, status: body.status as string | undefined,
    }) }));
  });

  app.delete('/api/timetable/entries/:entryId', async (request, reply) =>
    wrap(reply, () => { timetable.deleteEntry(Number((request.params as { entryId: string }).entryId)); return { ok: true }; }));

  app.post('/api/timetable/changes', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({ ok: true, change: timetable.saveChange({
      changeDate: String(body.change_date ?? ''), periodNo: Number(body.period_no), action: String(body.action ?? '调课'),
      subject: String(body.subject ?? ''), teacherName: String(body.teacher_name ?? ''), room: String(body.room ?? ''),
      sessionType: String(body.session_type ?? '普通课'), note: String(body.note ?? ''), status: String(body.status ?? '生效'),
    }) }));
  });

  app.put('/api/timetable/changes/:changeId/cancel', async (request, reply) =>
    wrap(reply, () => { timetable.cancelChange(Number((request.params as { changeId: string }).changeId)); return { ok: true }; }));

  app.post('/api/timetable/import/preview', async (request, reply) => {
    const data = await readRows(request);
    return wrap(reply, () => timetable.previewImport(data.rows, data.filename));
  });

  app.post('/api/timetable/import/commit', async (request, reply) => {
    const body = request.body as { filename?: string; request_id?: string; rows?: Array<Record<string, unknown>> };
    return wrap(reply, () => timetable.commitImport(body.rows ?? [], body.filename ?? '', body.request_id ?? ''));
  });

  app.get('/api/timetable/template', async (_request, reply) => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('课程表');
    worksheet.addRows(timetable.templateRows());
    worksheet.getRow(1).font = { bold: true };
    worksheet.columns = [
      { width: 10 }, { width: 8 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 },
      { width: 14 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 24 },
    ];
    const buffer = await workbook.xlsx.writeBuffer();
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('课程表导入模板.xlsx')}`);
    return reply.send(Buffer.from(buffer));
  });
}
