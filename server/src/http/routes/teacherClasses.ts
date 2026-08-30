import type { FastifyInstance, FastifyReply } from 'fastify';

import * as teacherClasses from '../../services/teacherClasses.js';

function wrap(reply: FastifyReply, fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    if (error instanceof teacherClasses.TeacherClassError) {
      const msg = String(error.message);
      const status = /不存在/.test(msg) ? 404 : /已存在/.test(msg) ? 409 : 400;
      return reply.status(status).send({ detail: msg });
    }
    throw error;
  }
}

export function registerTeacherClassesRoutes(app: FastifyInstance): void {
  app.get('/api/teacher/classes', async (_request, reply) => {
    return wrap(reply, () => ({ classes: teacherClasses.getTeacherClasses() }));
  });

  app.post('/api/teacher/classes', async (request, reply) => {
    const body = request.body as { class_id?: number; role?: string; subjects?: string; sort_order?: number };
    return wrap(reply, () => teacherClasses.addTeacherClass({
      classId: Number(body.class_id ?? 0),
      role: body.role,
      subjects: body.subjects,
      sortOrder: body.sort_order,
    }));
  });

  app.put('/api/teacher/classes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { role?: string; subjects?: string; sort_order?: number; enabled?: boolean };
    return wrap(reply, () => teacherClasses.updateTeacherClass(Number(id), {
      role: body.role,
      subjects: body.subjects,
      sortOrder: body.sort_order,
      enabled: body.enabled,
    }));
  });

  app.delete('/api/teacher/classes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    return wrap(reply, () => { teacherClasses.removeTeacherClass(Number(id)); return { ok: true }; });
  });

  app.get('/api/teacher/timetable', async (request, reply) => {
    const query = request.query as { start_date?: string; end_date?: string };
    return wrap(reply, () => ({ entries: teacherClasses.getTeacherTimetable({
      startDate: query.start_date,
      endDate: query.end_date,
    }) }));
  });

  app.get('/api/teacher/schedule', async (_request, reply) => {
    return wrap(reply, () => teacherClasses.getTeacherSchedule());
  });

  app.post('/api/teacher/schedule', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({ ok: true, entry: teacherClasses.createTeacherScheduleEntry({
      classId: Number(body.class_id), weekday: Number(body.weekday), periodNo: Number(body.period_no),
      subject: String(body.subject ?? ''), room: String(body.room ?? ''), note: String(body.note ?? ''),
    }) }));
  });

  app.put('/api/teacher/schedule/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({ ok: true, entry: teacherClasses.updateTeacherScheduleEntry(Number(id), {
      classId: body.class_id === undefined ? undefined : Number(body.class_id),
      weekday: body.weekday === undefined ? undefined : Number(body.weekday),
      periodNo: body.period_no === undefined ? undefined : Number(body.period_no),
      subject: body.subject as string | undefined, room: body.room as string | undefined, note: body.note as string | undefined,
    }) }));
  });

  app.delete('/api/teacher/schedule/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    return wrap(reply, () => { teacherClasses.removeTeacherScheduleEntry(Number(id)); return { ok: true }; });
  });

  app.get('/api/teacher/exams', async (request, reply) => {
    const query = request.query as { limit?: string };
    return wrap(reply, () => ({ exams: teacherClasses.getTeacherExams({
      limit: query.limit ? Number(query.limit) : undefined,
    }) }));
  });
}
