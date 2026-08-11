/* MIG-07 路由：考勤规则、成绩配置/导入、班级任务、值日、校历、搜索。
 * 提供高频教师业务相关 HTTP 入口。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';

import { getDb, scopeIds, ScopeError, ArchivedScopeError } from '../../services/context.js';
import * as attendance from '../../services/attendance.js';
import * as scores from '../../services/scores.js';
import * as scoresRules from '../../services/scoresRules.js';
import * as classTasks from '../../services/classTasks.js';
import * as duty from '../../services/duty.js';
import * as calendar from '../../services/schoolCalendar.js';

type ErrorClass = new (...args: never[]) => Error;

function mapError(reply: FastifyReply, error: unknown, notFoundOn = /不存在/): FastifyReply | undefined {
  if (error instanceof ArchivedScopeError) return reply.status(409).send({ detail: error.message });
  if (error instanceof ScopeError) return reply.status(400).send({ detail: error.message });
  if (error instanceof classTasks.IncompleteTaskError) {
    return reply.status(409).send({
      message: error.message,
      missing_students: (error as unknown as { missing?: unknown }).missing ?? [],
    });
  }
  if (error instanceof duty.DutyConflictError) {
    return reply.status(409).send({
      message: error.message,
      conflicts: (error as unknown as { conflicts?: unknown }).conflicts ?? [],
    });
  }
  const known: Array<ErrorClass> = [
    attendance.AttendanceError, scores.ScoreError, classTasks.ClassTaskError,
    duty.DutyError, calendar.CalendarError,
  ];
  for (const ErrorType of known) {
    if (error instanceof ErrorType) {
      const status = notFoundOn.test(String((error as Error).message)) ? 404 : 400;
      return reply.status(status).send({ detail: (error as Error).message });
    }
  }
  return undefined;
}

function wrap(reply: FastifyReply, fn: () => unknown, notFoundOn = /不存在/): unknown {
  try {
    return fn();
  } catch (error) {
    const mapped = mapError(reply, error, notFoundOn);
    if (mapped) return mapped;
    throw error;
  }
}

export function registerMig07Routes(app: FastifyInstance): void {
  // ---------- 考勤规则 ----------
  app.get('/api/attendance/rules', async (request) => {
    const { source_id } = request.query as { source_id?: string };
    return attendance.listRules({ sourceId: source_id ? Number(source_id) : null });
  });

  app.post('/api/attendance/rules', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => attendance.createRule({
      name: String(body.name ?? ''), metric: String(body.metric ?? '迟到次数'),
      threshold: Number(body.threshold ?? 2), periodDays: Number(body.period_days ?? 7),
      priority: String(body.priority ?? '重要'), enabled: body.enabled !== false,
      scene: String(body.scene ?? '全部场景'),
    }));
  });

  app.put('/api/attendance/rules/:ruleId', async (request, reply) => {
    const { ruleId } = request.params as { ruleId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => attendance.updateRule(Number(ruleId), {
      enabled: body.enabled, threshold: body.threshold, period_days: body.period_days,
      priority: body.priority, scene: body.scene,
    }));
  });

  app.post('/api/attendance/rules/evaluate', async (request, reply) => {
    const body = (request.body ?? {}) as { reference_date?: string };
    return wrap(reply, () => {
      const result = attendance.evaluateRules({ referenceDate: body.reference_date ?? '', trigger: 'manual' }) as Record<string, unknown>;
      const summary = (result.summary ?? []) as Array<Record<string, unknown>>;
      return {
        ...result,
        created: summary.filter((item) => item.state === '新命中'),
        count: result.created_count,
      };
    });
  });

  // ---------- 成绩配置 ----------
  app.get('/api/score-config', async () => scores.listConfig());

  app.post('/api/score-config/subjects', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => scores.createSubject({
      name: String(body.name ?? ''), fullScore: Number(body.full_score ?? 0),
      sortOrder: Number(body.sort_order ?? 0),
      subjectGroup: String(body.subject_group ?? '必考'), scoreType: String(body.score_type ?? '原始分'),
      enabled: body.enabled === undefined || body.enabled === null ? true : Boolean(body.enabled),
    }));
  });

  app.put('/api/score-config/subjects/:subjectId', async (request, reply) => {
    const { subjectId } = request.params as { subjectId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => scores.updateSubject(Number(subjectId), {
      name: body.name,
      fullScore: body.full_score,
      sortOrder: body.sort_order,
      enabled: body.enabled === undefined || body.enabled === null ? null : Boolean(body.enabled),
      subjectGroup: body.subject_group as string | null | undefined,
      scoreType: body.score_type as string | null | undefined,
    }));
  });

  app.post('/api/score-config/exams', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => scores.createExam({
      name: String(body.name ?? ''), examDate: String(body.exam_date ?? ''),
      subjectIds: Array.isArray(body.subject_ids) ? (body.subject_ids as number[]) : [],
      enabled: body.enabled === undefined || body.enabled === null ? true : Boolean(body.enabled),
      sortOrder: Number(body.sort_order ?? 0),
    }));
  });

  app.put('/api/score-config/exams/:examId', async (request, reply) => {
    const { examId } = request.params as { examId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => scores.updateExam(Number(examId), {
      name: body.name,
      examDate: body.exam_date,
      subjectIds: Array.isArray(body.subject_ids) ? (body.subject_ids as number[]) : null,
      enabled: body.enabled === undefined || body.enabled === null ? null : Boolean(body.enabled),
      sortOrder: body.sort_order,
    }));
  });

  app.put('/api/score-config/settings', async (request, reply) => {
    const body = request.body as { mode?: string };
    return wrap(reply, () => scores.updateTermSettings({ mode: body.mode ?? '固定科目' }));
  });

  app.post('/api/score-config/presets/sichuan-312', async (_request, reply) =>
    wrap(reply, () => scores.applySichuan312Preset()));

  app.put('/api/score-config/students/:studentId/subjects', async (request, reply) => {
    const { studentId } = request.params as { studentId: string };
    const body = request.body as { subject_ids?: number[] };
    return wrap(reply, () => scores.saveStudentSubjects(Number(studentId), body.subject_ids ?? []));
  });

  app.put('/api/score-config/student-subjects/batch', async (request, reply) => {
    const body = request.body as { student_ids?: number[]; subject_ids?: number[] };
    return wrap(reply, () => scores.saveStudentSubjectsBatch(body.student_ids ?? [], body.subject_ids ?? []));
  });

  // ---------- 成绩记录 ----------
  app.get('/api/exams', async (request) => {
    const { student_id, exam_name } = request.query as { student_id?: string; exam_name?: string };
    const records = scores.listRecords({ studentId: student_id ? Number(student_id) : null });
    return {
      records: exam_name
        ? records.filter((item) => item.exam_name === exam_name)
        : records,
    };
  });

  app.get('/api/exams/summary', async (request) => {
    const { student_id } = request.query as { student_id?: string };
    return scores.scoreSummary({ studentId: student_id ? Number(student_id) : null });
  });

  app.post('/api/exams/import', async (request) => {
    const data = await readUpload(request);
    const rows = await scores.previewExamRows(await parseXlsxRows(data.buffer));
    return { ok: true, filename: data.filename, ...rows };
  });

  app.post('/api/exams/import/preview', async (request) => {
    const query = request.query as { duplicate_strategy?: string };
    const data = await readUpload(request);
    const rows = await scores.previewExamRows(
      await parseXlsxRows(data.buffer), query.duplicate_strategy ?? 'update');
    return { ok: true, filename: data.filename, ...rows };
  });

  app.post('/api/exams/import/commit', async (request, reply) => {
    const body = request.body as {
      filename?: string; duplicate_strategy?: string; request_id?: string;
      rows?: Array<Record<string, unknown>>;
    };
    return wrap(reply, () => scores.commitExamRows(
      body.rows ?? [], {
        filename: body.filename ?? '', duplicateStrategy: body.duplicate_strategy ?? 'update',
        requestId: body.request_id ?? '',
      },
    ));
  });

  // ---------- 成绩规则 ----------
  app.get('/api/score-rules', async (request) => {
    const { source_id } = request.query as { source_id?: string };
    return scoresRules.listRules({ sourceId: source_id ? Number(source_id) : null });
  });

  app.post('/api/score-rules', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => scoresRules.createRule({
      name: String(body.name ?? ''), metric: String(body.metric ?? '总分下降'),
      subjectId: body.subject_id !== undefined && body.subject_id !== null ? Number(body.subject_id) : null,
      threshold: Number(body.threshold ?? 10), priority: String(body.priority ?? '重要'),
      enabled: body.enabled !== false,
    }));
  });

  app.put('/api/score-rules/:ruleId', async (request, reply) => {
    const { ruleId } = request.params as { ruleId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => scoresRules.updateRule(Number(ruleId), {
      enabled: body.enabled === undefined || body.enabled === null ? null : Boolean(body.enabled),
      threshold: body.threshold,
      priority: body.priority as string | null | undefined,
    }));
  });

  app.post('/api/score-rules/evaluate', async (_request, reply) =>
    wrap(reply, () => scoresRules.evaluateRules({ trigger: 'manual' })));

  // ---------- 班级任务 ----------
  app.get('/api/class-tasks', async (request, reply) => {
    const query = request.query as Record<string, string>;
    return wrap(reply, () => ({
      tasks: classTasks.listTasks({
        status: query.status ?? '', timingState: query.timing_state ?? '',
        sourceId: query.source_id ? Number(query.source_id) : null,
      }),
    }));
  });

  app.get('/api/class-task-templates', async (request) => {
    const { include_disabled } = request.query as { include_disabled?: string };
    return { templates: classTasks.listTemplates({ includeDisabled: include_disabled === 'true' }) };
  });

  app.post('/api/class-task-templates', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({
      ok: true,
      template: classTasks.createTemplate({
        name: String(body.name ?? ''), taskType: String(body.task_type ?? '材料收集'),
        materialName: String(body.material_name ?? ''), description: String(body.description ?? ''),
        defaultDueDays: Number(body.default_due_days ?? 7), enabled: body.enabled !== false,
      }),
    }));
  });

  app.put('/api/class-task-templates/:templateId', async (request, reply) => {
    const { templateId } = request.params as { templateId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({
      ok: true,
      template: classTasks.updateTemplate(Number(templateId), {
        name: body.name as string | null | undefined,
        taskType: body.task_type as string | null | undefined,
        materialName: body.material_name as string | null | undefined,
        description: body.description as string | null | undefined,
        defaultDueDays: typeof body.default_due_days === 'number' ? body.default_due_days : null,
        enabled: body.enabled === undefined || body.enabled === null ? null : Boolean(body.enabled),
      }),
    }));
  });

  app.post('/api/class-tasks', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => {
      const task = classTasks.createTask({
        title: String(body.title ?? ''), taskType: String(body.task_type ?? '材料收集'),
        startAt: String(body.start_at ?? ''), dueAt: String(body.due_at ?? ''),
        materialName: String(body.material_name ?? ''), description: String(body.description ?? ''),
        studentIds: Array.isArray(body.student_ids) ? (body.student_ids as number[]) : [],
        templateId: body.template_id !== undefined && body.template_id !== null
          ? Number(body.template_id) : null,
      });
      return { ok: true, task_id: task.id, task };
    }, /学生.*不存在|不存在/);
  });

  app.put('/api/class-tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => {
      const task = classTasks.updateTask(Number(taskId), {
        status: body.status === undefined ? undefined : String(body.status),
        description: body.description === undefined ? undefined : String(body.description),
        startAt: body.start_at === undefined ? undefined : String(body.start_at),
        dueAt: body.due_at === undefined ? undefined : String(body.due_at),
        completionResult: body.completion_result === undefined ? undefined : String(body.completion_result),
        confirmIncomplete: body.confirm_incomplete === true,
      });
      return { ok: true, task };
    });
  });

  app.put('/api/class-tasks/:taskId/items/bulk', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const body = request.body as { student_ids?: number[]; status?: string; note?: string };
    return wrap(reply, () => ({
      ok: true,
      task: classTasks.updateItems(Number(taskId), body.student_ids ?? [],
        { status: String(body.status ?? '已提交'), note: String(body.note ?? '') }),
    }));
  });

  app.put('/api/class-tasks/:taskId/items/:studentId', async (request, reply) => {
    const { taskId, studentId } = request.params as { taskId: string; studentId: string };
    const body = request.body as { status?: string; note?: string };
    return wrap(reply, () => ({
      ok: true,
      task: classTasks.updateItem(Number(taskId), Number(studentId),
        { status: String(body.status ?? '已提交'), note: String(body.note ?? '') }),
    }));
  });

  app.post('/api/class-tasks/:taskId/remind', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const body = request.body as { student_ids?: number[] } | null;
    return wrap(reply, () => classTasks.remind(Number(taskId),
      Array.isArray(body?.student_ids) ? (body?.student_ids as number[]) : null));
  });

  app.post('/api/class-tasks/:taskId/attachments/:studentId', async (request, reply) => {
    const { taskId, studentId } = request.params as { taskId: string; studentId: string };
    const data = await readUpload(request);
    return wrap(reply, () => ({
      ok: true,
      attachment: classTasks.saveAttachment(Number(taskId), Number(studentId), {
        filename: data.filename || '附件',
        contentType: data.contentType || 'application/octet-stream',
        content: data.buffer,
      }),
    }));
  });

  app.get('/api/class-tasks/attachments/:attachmentId', async (request, reply) => {
    const { attachmentId } = request.params as { attachmentId: string };
    try {
      const result = classTasks.attachmentFile(Number(attachmentId));
      reply.header('Content-Type', result.attachment.content_type);
      reply.header('Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(String(result.attachment.original_name))}`);
      return reply.send(result.path);
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  // ---------- 值日 ----------
  app.get('/api/duty', async (request, reply) => {
    const query = request.query as Record<string, string>;
    return wrap(reply, () => ({
      assignments: duty.listAssignments({
        dutyDate: query.duty_date ?? '', dateFrom: query.date_from ?? '',
        dateTo: query.date_to ?? '', sourceId: query.source_id ? Number(query.source_id) : null,
      }),
    }));
  });

  app.post('/api/duty', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => {
      const assignment = duty.createAssignment({
        dutyDate: String(body.duty_date ?? ''), area: String(body.area ?? ''),
        studentId: Number(body.student_id), status: String(body.status ?? '待完成'),
        note: String(body.note ?? ''), completionResult: String(body.completion_result ?? ''),
      }) as Record<string, unknown>;
      return { ok: true, assignment_id: assignment.id, assignment };
    }, /学生.*不存在|不存在/);
  });

  app.put('/api/duty/:assignmentId', async (request, reply) => {
    const { assignmentId } = request.params as { assignmentId: string };
    const body = request.body as { status?: string; note?: string; completion_result?: string };
    return wrap(reply, () => ({
      ok: true,
      assignment: duty.updateAssignment(Number(assignmentId), {
        status: String(body.status ?? ''), note: String(body.note ?? ''),
        completionResult: String(body.completion_result ?? ''),
      }),
    }));
  });

  app.get('/api/duty/rotation-rules', async (request) => {
    const { include_disabled } = request.query as { include_disabled?: string };
    return { rules: duty.listRotationRules({ includeDisabled: include_disabled === 'true' }) };
  });

  app.post('/api/duty/rotation-rules', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({
      ok: true,
      rule: duty.createRotationRule({
        name: String(body.name ?? ''), area: String(body.area ?? ''),
        startDate: String(body.start_date ?? ''), endDate: String(body.end_date ?? ''),
        weekdayMask: Number(body.weekday_mask ?? 31),
        studentIds: Array.isArray(body.student_ids) ? (body.student_ids as number[]) : [],
        enabled: body.enabled === undefined || body.enabled === null ? true : Boolean(body.enabled),
      }),
    }), /学生.*不存在|不存在/);
  });

  app.post('/api/duty/rotation-rules/:ruleId/generate', async (request, reply) => {
    const { ruleId } = request.params as { ruleId: string };
    const body = (request.body ?? {}) as { date_from?: string; date_to?: string; confirm?: boolean };
    return wrap(reply, () => duty.generateRotation(Number(ruleId), {
      dateFrom: body.date_from ?? '', dateTo: body.date_to ?? '', confirm: body.confirm === true,
    }));
  });

  // ---------- 学期校历 ----------
  app.get('/api/school-calendar', async (request, reply) => {
    const query = request.query as { date_from?: string; date_to?: string; month?: string };
    return wrap(reply, () => calendar.listCalendar(
      query.date_from ?? '', query.date_to ?? '', query.month ?? ''));
  });

  app.get('/api/school-calendar/term', async (_request, reply) =>
    wrap(reply, () => calendar.termCalendar()));

  app.post('/api/school-calendar/import/preview', async (request, reply) => {
    void request;
    const data = await readUpload(request);
    return wrap(reply, () => calendar.previewImport(data.buffer, data.filename));
  });

  app.post('/api/school-calendar/import/commit', async (request, reply) => {
    const body = request.body as {
      filename?: string; request_id?: string; rows?: Array<Record<string, unknown>>;
    };
    return wrap(reply, () => calendar.commitImport(
      body.rows ?? [], body.filename ?? '', body.request_id ?? ''));
  });

  app.post('/api/school-calendar', async (request, reply) => {
    const body = request.body as {
      calendar_date: string; day_type?: string; title?: string; is_school_day?: boolean; note?: string;
    };
    return wrap(reply, () => calendar.createEntry(
      body.calendar_date, body.day_type ?? '上课日', body.title ?? '',
      body.is_school_day !== false, body.note ?? ''));
  });

  app.put('/api/school-calendar/:entryId', async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    const body = request.body as {
      calendar_date: string; day_type?: string; title?: string; is_school_day?: boolean; note?: string;
    };
    return wrap(reply, () => calendar.updateEntry(
      Number(entryId), body.calendar_date, body.day_type ?? '上课日', body.title ?? '',
      body.is_school_day !== false, body.note ?? ''));
  });

  // ---------- 搜索 ----------
  app.get('/api/search', async (request) => {
    const { q = '', limit = '30' } = request.query as { q?: string; limit?: string };
    const query = String(q).trim();
    if (!query) return { results: [] };
    const like = `%${query}%`;
    const conn = getDb().connInstance;
    const [classId, termId] = scopeIds({ conn });
    const maxLimit = Number(limit);
    const results: Array<Record<string, unknown>> = [];
    for (const row of conn.prepare(
      `SELECT s.id, s.学号, s.姓名, s.班级任职 FROM students s
       JOIN student_enrollments e ON e.student_id=s.id
       WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
         AND (s.学号 LIKE ? OR s.姓名 LIKE ? OR s.备注 LIKE ?)
       ORDER BY s.学号 LIMIT ?`,
    ).all(classId, termId, like, like, like, maxLimit) as Array<Record<string, unknown>>) {
      results.push({
        kind: 'student', id: row.id, student_id: row.id, title: row.姓名,
        summary: `${row.学号 || '暂无学号'} · ${row.班级任职 || '班级成员'}`,
        path: `/student/${row.id}`,
      });
    }
    const sources: Array<[string, string, string, string]> = [
      ['student_events', 'x.id, x.student_id, x.event_type AS title, x.description AS summary', '事件', '/events'],
      ['student_tasks', 'x.id, x.student_id, x.title, x.notes AS summary', '待办', '/tasks'],
      ['focus_items', 'x.id, x.student_id, x.topic AS title, x.reason AS summary', '关注', '/special'],
      ['communications', 'x.id, x.student_id, x.reason AS title, x.summary', '沟通', '/parent-comm'],
    ];
    for (const [table, fields, kind, path] of sources) {
      for (const row of conn.prepare(
        `SELECT ${fields}, s.姓名 AS student_name FROM ${table} x JOIN students s ON s.id=x.student_id
         WHERE x.class_id=? AND x.term_id=? AND x.deleted_at='' AND s.deleted_at='' AND (title LIKE ? OR summary LIKE ?) LIMIT ?`,
      ).all(classId, termId, like, like, maxLimit) as Array<Record<string, unknown>>) {
        results.push({
          kind, id: row.id, student_id: row.student_id, title: row.title,
          summary: `${row.student_name} · ${row.summary ?? ''}`, path,
        });
      }
    }
    for (const row of conn.prepare(
      `SELECT e.id, e.student_id, e.exam_name AS title, e.subject || ' ' || COALESCE(e.score, '') AS summary,
              s.姓名 AS student_name FROM exam_records e JOIN students s ON s.id=e.student_id
       WHERE e.class_id=? AND e.term_id=? AND e.deleted_at='' AND s.deleted_at='' AND (e.exam_name LIKE ? OR e.subject LIKE ?) LIMIT ?`,
    ).all(classId, termId, like, like, maxLimit) as Array<Record<string, unknown>>) {
      results.push({
        kind: '成绩', id: row.id, student_id: row.student_id, title: row.title,
        summary: `${row.student_name} · ${row.summary}`, path: '/scores',
      });
    }
    return { results: results.slice(0, maxLimit) };
  });
}

async function readUpload(request: { file?: () => Promise<{
  toBuffer: () => Promise<Buffer>; filename?: string; mimetype?: string;
} | undefined> }): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  if (typeof request.file === 'function') {
    const part = await request.file();
    if (!part) return { buffer: Buffer.alloc(0), filename: '', contentType: '' };
    return {
      buffer: await part.toBuffer(),
      filename: part.filename ?? '',
      contentType: part.mimetype ?? '',
    };
  }
  return { buffer: Buffer.alloc(0), filename: '', contentType: '' };
}

async function parseXlsxRows(buffer: Buffer): Promise<unknown[][]> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const rows: unknown[][] = [];
  for (let r = 1; r <= ws.rowCount; r += 1) {
    const row: unknown[] = [];
    for (let c = 1; c <= ws.columnCount; c += 1) {
      const value = ws.getRow(r).getCell(c).value;
      if (value instanceof Date) row.push(value.toISOString().slice(0, 10));
      else if (typeof value === 'object' && value !== null && 'formula' in value) {
        row.push(`=${(value as { formula: string }).formula}`);
      } else {
        row.push(value);
      }
    }
    rows.push(row);
  }
  return rows;
}
