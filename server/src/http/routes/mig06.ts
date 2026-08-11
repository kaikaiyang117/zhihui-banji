/* MIG-06 路由：事件、工作项、关注、家校沟通、考勤保存、学生详情与流程。
 * 提供行动闭环相关 HTTP 入口。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';

import { getDb, scopeIds, ensureStudentInScope, ScopeError, ArchivedScopeError } from '../../services/context.js';
import * as workItemsService from '../../services/workItems.js';
import { WorkItemError } from '../../services/workItems.js';
import { updateSource, getWorkflow, WorkflowError } from '../../services/workflow.js';
import {
  createEvent, createFocus, createCommunication, saveDailyAttendance,
  listAttendanceRecords, studentDetail, CommunicationError, AttendanceError,
} from '../../services/p0Service.js';

function mapError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof ArchivedScopeError) return reply.status(409).send({ detail: error.message });
  if (error instanceof ScopeError) return reply.status(404).send({ detail: error.message });
  if (error instanceof WorkItemError) {
    return reply.status(String(error.message).includes('不存在') ? 404 : 400).send({ detail: error.message });
  }
  if (error instanceof WorkflowError) {
    return reply.status(String(error.message).includes('不存在') ? 404 : 400).send({ detail: error.message });
  }
  if (error instanceof CommunicationError) return reply.status(400).send({ detail: error.message });
  if (error instanceof AttendanceError) return reply.status(400).send({ detail: error.message });
  return undefined;
}

export function registerMig06Routes(app: FastifyInstance): void {
  // ---------- 事件 ----------
  app.post('/api/events', async (request, reply) => {
    const body = request.body as {
      student_id: number; occurred_at: string; event_type: string; description: string;
      handling?: string; parent_contacted?: boolean; needs_followup?: boolean;
      followup_due?: string; status?: string;
    };
    try {
      const result = createEvent({
        studentId: body.student_id, occurredAt: body.occurred_at, eventType: body.event_type,
        description: body.description, handling: body.handling,
        parentContacted: Boolean(body.parent_contacted), needsFollowup: Boolean(body.needs_followup),
        followupDue: body.followup_due ?? '', status: body.status ?? '已完成',
      });
      return { ok: true, ...result };
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get('/api/events', async (request) => {
    const conn = getDb().connInstance;
    const [classId, termId] = scopeIds({ conn });
    const query = request.query as Record<string, string>;
    const where = ["e.class_id=?", "e.term_id=?", "e.deleted_at=''", "s.deleted_at=''"];
    const params: unknown[] = [classId, termId];
    if (query.student_id) {
      where.push('e.student_id=?');
      params.push(Number(query.student_id));
    }
    if (query.status) {
      where.push('e.status=?');
      params.push(query.status);
    }
    if (query.source_id) {
      where.push('e.id=?');
      params.push(Number(query.source_id));
    }
    const limit = Math.max(1, Math.min(Number(query.limit ?? 100), 500));
    const events = conn.prepare(
      'SELECT e.*, s.姓名 AS student_name FROM student_events e JOIN students s ON s.id=e.student_id '
      + `WHERE ${where.join(' AND ')} ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?`,
    ).all(...params, limit);
    return { events };
  });

  // ---------- 工作项 ----------
  app.post('/api/tasks', async (request, reply) => {
    const body = request.body as {
      title: string; student_id?: number | null; source?: string; owner?: string;
      scheduled_at?: string; due_at?: string; priority?: string; status?: string; notes?: string;
    };
    if (body.student_id) {
      try {
        ensureStudentInScope(Number(body.student_id), { write: true });
      } catch (error) {
        const mapped = mapError(reply, error);
        if (mapped) return mapped;
        throw error;
      }
    }
    try {
      const result = workItemsService.createWorkItem({
        title: body.title, studentId: body.student_id ?? null, sourceType: 'manual',
        sourceLabel: body.source, owner: body.owner, scheduledAt: body.scheduled_at,
        dueAt: body.due_at, priority: body.priority, status: body.status, notes: body.notes,
      });
      return { ok: true, task_id: result.id };
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get('/api/tasks', async (request, reply) => {
    const query = request.query as Record<string, string>;
    try {
      const tasks = workItemsService.listWorkItems({
        status: query.status ?? null, studentId: query.student_id ? Number(query.student_id) : null,
        bucket: query.bucket ?? 'all', sourceType: query.source_type ?? null,
        query: query.q ?? '', dateFrom: query.date_from ?? '', dateTo: query.date_to ?? '',
        limit: Number(query.limit ?? 200),
      });
      return { tasks };
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get('/api/tasks/summary', async () => ({ summary: workItemsService.workItemSummary() }));

  app.put('/api/tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const body = request.body as Record<string, unknown>;
    try {
      const item = workItemsService.updateWorkItem(Number(taskId), {
        title: body.title as string | null | undefined,
        owner: body.owner as string | null | undefined,
        priority: body.priority as string | null | undefined,
        scheduledAt: body.scheduled_at as string | null | undefined,
        dueAt: body.due_at as string | null | undefined,
        status: body.status as string | null | undefined,
        notes: body.notes as string | null | undefined,
        result: body.result as string | null | undefined,
      });
      return { ok: true, task: item };
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  // ---------- 关注 ----------
  app.post('/api/focus', async (request, reply) => {
    const body = request.body as {
      student_id: number; topic: string; reason: string; evidence?: string;
      action_plan?: string; status?: string; next_review_at?: string;
    };
    try {
      const result = createFocus({
        studentId: body.student_id, topic: body.topic, reason: body.reason,
        evidence: body.evidence, actionPlan: body.action_plan,
        status: body.status ?? '待确认', nextReviewAt: body.next_review_at ?? '',
      });
      return { ok: true, ...result };
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get('/api/focus', async (request) => {
    const conn = getDb().connInstance;
    const [classId, termId] = scopeIds({ conn });
    const query = request.query as Record<string, string>;
    let sql = 'SELECT f.*, s.姓名 AS student_name FROM focus_items f JOIN students s ON s.id=f.student_id '
      + "WHERE f.class_id=? AND f.term_id=? AND f.deleted_at='' AND s.deleted_at=''";
    const params: unknown[] = [classId, termId];
    if (query.status) {
      sql += ' AND f.status=?';
      params.push(query.status);
    }
    if (query.source_id) {
      sql += ' AND f.id=?';
      params.push(Number(query.source_id));
    }
    const limit = Math.max(1, Math.min(Number(query.limit ?? 100), 500));
    sql += " ORDER BY CASE WHEN f.status='已结束' THEN 1 ELSE 0 END, f.next_review_at, f.id DESC LIMIT ?";
    params.push(limit);
    return { focus: conn.prepare(sql).all(...params) };
  });

  app.put('/api/focus/:focusId', async (request, reply) => {
    const { focusId } = request.params as { focusId: string };
    const body = request.body as Record<string, unknown>;
    try {
      const result = updateSource('focus', Number(focusId), {
        status: body.status as string | null | undefined,
        progress: String(body.progress ?? ''),
        result: String(body.conclusion ?? ''),
        nextActionAt: body.next_review_at as string | null | undefined,
        taskAction: body.task_action as string | null | undefined,
        requestId: String(body.request_id ?? ''),
      });
      return { ok: true, ...result };
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  // ---------- 家校沟通 ----------
  app.post('/api/communications', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    try {
      const result = createCommunication({
        studentId: Number(body.student_id), communicatedAt: String(body.communicated_at ?? ''),
        method: String(body.method ?? ''), reason: String(body.reason ?? ''),
        summary: String(body.summary ?? ''), feedback: String(body.feedback ?? ''),
        agreement: String(body.agreement ?? ''), followupAt: String(body.followup_at ?? ''),
        status: String(body.status ?? '已完成'),
        eventId: body.event_id !== undefined && body.event_id !== null ? Number(body.event_id) : null,
      });
      return { ok: true, ...result };
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get('/api/communications', async (request) => {
    const conn = getDb().connInstance;
    const [classId, termId] = scopeIds({ conn });
    const query = request.query as Record<string, string>;
    let sql = 'SELECT c.*, s.姓名 AS student_name FROM communications c JOIN students s ON s.id=c.student_id '
      + "WHERE c.class_id=? AND c.term_id=? AND c.deleted_at='' AND s.deleted_at=''";
    const params: unknown[] = [classId, termId];
    if (query.status) {
      sql += ' AND c.status=?';
      params.push(query.status);
    }
    if (query.student_id) {
      sql += ' AND c.student_id=?';
      params.push(Number(query.student_id));
    }
    if (query.source_id) {
      sql += ' AND c.id=?';
      params.push(Number(query.source_id));
    }
    const limit = Math.max(1, Math.min(Number(query.limit ?? 100), 500));
    sql += ' ORDER BY c.communicated_at DESC, c.id DESC LIMIT ?';
    params.push(limit);
    return { communications: conn.prepare(sql).all(...params) };
  });

  // ---------- 考勤（规则评估在 MIG-07 接入） ----------
  app.post('/api/attendance/daily', async (request, reply) => {
    const body = request.body as { date: string; scene?: string; records: Array<Record<string, unknown>> };
    try {
      return saveDailyAttendance(body.date, body.scene ?? '常规到校', body.records ?? []);
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get('/api/attendance/records', async (request) => {
    const query = request.query as Record<string, string>;
    return { records: listAttendanceRecords({
      attendanceDate: query.date ?? '', scene: query.scene ?? '常规到校', limit: 5000,
    }) };
  });

  // ---------- 学生详情 ----------
  app.get('/api/students/:studentId/detail', async (request, reply) => {
    const { studentId } = request.params as { studentId: string };
    try {
      return studentDetail(Number(studentId));
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  // ---------- 统一流程 ----------
  app.get('/api/workflows/:sourceType/:sourceId', async (request, reply) => {
    const { sourceType, sourceId } = request.params as { sourceType: string; sourceId: string };
    try {
      return getWorkflow(sourceType, Number(sourceId));
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.put('/api/workflows/:sourceType/:sourceId', async (request, reply) => {
    const { sourceType, sourceId } = request.params as { sourceType: string; sourceId: string };
    const body = request.body as Record<string, unknown>;
    try {
      const result = updateSource(sourceType, Number(sourceId), {
        status: body.status as string | null | undefined,
        progress: String(body.progress ?? ''),
        result: String(body.result ?? ''),
        nextActionAt: body.next_action_at as string | null | undefined,
        taskAction: body.task_action as string | null | undefined,
        requestId: String(body.request_id ?? ''),
        fields: body.fields as Record<string, unknown> | null | undefined,
      });
      return result;
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });
}
