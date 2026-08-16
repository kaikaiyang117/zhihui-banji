/* MIG-10 路由：班级小组与宿舍/床位管理。 */
import type { FastifyInstance, FastifyReply } from 'fastify';

import * as groups from '../../services/groups.js';
import * as dormitories from '../../services/dormitories.js';
import { ArchivedScopeError, ScopeError } from '../../services/context.js';

function mapError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof ArchivedScopeError) return reply.status(409).send({ detail: error.message });
  if (error instanceof ScopeError) return reply.status(400).send({ detail: error.message });
  if (error instanceof groups.GroupError || error instanceof dormitories.DormitoryError) {
    const message = (error as Error).message;
    return reply.status(message.includes('不存在') ? 404 : 400).send({ detail: message });
  }
  const record = error as { code?: unknown };
  if (record && typeof record.code === 'string' && record.code.startsWith('SQLITE_CONSTRAINT')) {
    return reply.status(409).send({ detail: '名称、房间或床位已经存在' });
  }
  return undefined;
}

function wrap(reply: FastifyReply, fn: () => unknown): unknown {
  try { return fn(); } catch (error) {
    const mapped = mapError(reply, error);
    if (mapped) return mapped;
    throw error;
  }
}

export function registerMig10Routes(app: FastifyInstance): void {
  // ---------- 小组 ----------
  app.get('/api/groups', async (request, reply) => wrap(reply, () => ({
    groups: groups.listGroups({ groupType: (request.query as { type?: string }).type ?? '' }),
  })));

  app.get('/api/groups/unassigned', async (request, reply) => wrap(reply, () => ({
    students: groups.listUnassigned((request.query as { type?: string }).type ?? '学习小组'),
  })));

  app.get('/api/groups/:groupId', async (request, reply) => wrap(reply, () => ({
    group: groups.getGroup(Number((request.params as { groupId: string }).groupId)),
  })));

  app.post('/api/groups', async (request, reply) => wrap(reply, () => ({
    ok: true,
    group: groups.createGroup({
      name: String((request.body as Record<string, unknown>).name ?? ''),
      groupType: String((request.body as Record<string, unknown>).group_type ?? '学习小组'),
      sortOrder: Number((request.body as Record<string, unknown>).sort_order ?? 0),
    }),
  })));

  app.put('/api/groups/:groupId', async (request, reply) => wrap(reply, () => ({
    ok: true,
    group: groups.updateGroup(Number((request.params as { groupId: string }).groupId), {
      name: (request.body as Record<string, unknown>).name as string | null | undefined,
      groupType: (request.body as Record<string, unknown>).group_type as string | null | undefined,
      sortOrder: (request.body as Record<string, unknown>).sort_order as number | null | undefined,
      status: (request.body as Record<string, unknown>).status as string | null | undefined,
    }),
  })));

  app.put('/api/groups/:groupId/members', async (request, reply) => wrap(reply, () => ({
    ok: true,
    group: groups.replaceMembers(Number((request.params as { groupId: string }).groupId),
      ((request.body as { members?: Array<Record<string, unknown>> }).members ?? []).map(member => ({
        studentId: Number(member.student_id), role: String(member.role ?? '成员'), sortOrder: Number(member.sort_order ?? 0),
      }))),
  })));

  // ---------- 宿舍 ----------
  app.get('/api/dormitories/rooms', async (_request, reply) => wrap(reply, () => ({ rooms: dormitories.listRooms() })));
  app.get('/api/dormitories/assignments', async (_request, reply) => wrap(reply, () => ({ assignments: dormitories.listAssignments() })));
  app.get('/api/dormitories/unassigned', async (_request, reply) => wrap(reply, () => ({ students: dormitories.listUnassigned() })));
  app.get('/api/dormitories/inspections', async (_request, reply) => wrap(reply, () => ({ inspections: dormitories.listInspections() })));
  app.get('/api/dormitories/inspections/:inspectionId', async (request, reply) => wrap(reply, () => ({
    inspection: dormitories.getInspection(Number((request.params as { inspectionId: string }).inspectionId)),
  })));

  app.post('/api/dormitories/rooms', async (request, reply) => wrap(reply, () => ({
    ok: true,
    room: dormitories.createRoom({
      building: String((request.body as Record<string, unknown>).building ?? ''),
      floor: String((request.body as Record<string, unknown>).floor ?? ''),
      roomNo: String((request.body as Record<string, unknown>).room_no ?? ''),
      genderLimit: String((request.body as Record<string, unknown>).gender_limit ?? '不限'),
      capacity: Number((request.body as Record<string, unknown>).capacity ?? 0),
      note: String((request.body as Record<string, unknown>).note ?? ''),
    }),
  })));

  app.put('/api/dormitories/rooms/:roomId', async (request, reply) => wrap(reply, () => ({
    ok: true,
    room: dormitories.updateRoom(Number((request.params as { roomId: string }).roomId), {
      building: (request.body as Record<string, unknown>).building as string | null | undefined,
      floor: (request.body as Record<string, unknown>).floor as string | null | undefined,
      roomNo: (request.body as Record<string, unknown>).room_no as string | null | undefined,
      genderLimit: (request.body as Record<string, unknown>).gender_limit as string | null | undefined,
      capacity: (request.body as Record<string, unknown>).capacity as number | null | undefined,
      status: (request.body as Record<string, unknown>).status as string | null | undefined,
      note: (request.body as Record<string, unknown>).note as string | null | undefined,
    }),
  })));

  app.put('/api/dormitories/rooms/:roomId/leader', async (request, reply) => wrap(reply, () => ({
    ok: true,
    leader: dormitories.setRoomLeader(
      Number((request.params as { roomId: string }).roomId),
      (request.body as { student_id?: number | null }).student_id == null
        ? null : Number((request.body as { student_id: number }).student_id),
      { assignedAt: String((request.body as Record<string, unknown>).assigned_at ?? ''), note: String((request.body as Record<string, unknown>).note ?? '') },
    ),
  })));

  app.post('/api/dormitories/assignments', async (request, reply) => wrap(reply, () => ({
    ok: true,
    assignment: dormitories.assignBed({
      studentId: Number((request.body as Record<string, unknown>).student_id),
      bedId: Number((request.body as Record<string, unknown>).bed_id),
      moveInAt: String((request.body as Record<string, unknown>).move_in_at ?? ''),
      note: String((request.body as Record<string, unknown>).note ?? ''),
    }),
  })));

  app.post('/api/dormitories/assignments/:assignmentId/move', async (request, reply) => wrap(reply, () => ({
    ok: true,
    assignment: dormitories.moveAssignment(Number((request.params as { assignmentId: string }).assignmentId), {
      bedId: Number((request.body as Record<string, unknown>).bed_id),
      reason: String((request.body as Record<string, unknown>).reason ?? ''),
      moveInAt: String((request.body as Record<string, unknown>).move_in_at ?? ''),
      note: String((request.body as Record<string, unknown>).note ?? ''),
    }),
  })));

  app.post('/api/dormitories/assignments/:assignmentId/checkout', async (request, reply) => wrap(reply, () => ({
    ok: true,
    assignment: dormitories.checkoutAssignment(Number((request.params as { assignmentId: string }).assignmentId), {
      reason: String((request.body as Record<string, unknown>).reason ?? ''),
      moveOutAt: String((request.body as Record<string, unknown>).move_out_at ?? ''),
    }),
  })));

  app.post('/api/dormitories/inspections', async (request, reply) => wrap(reply, () => ({
    ok: true,
    inspection: dormitories.createInspection({
      inspectionDate: String((request.body as Record<string, unknown>).inspection_date ?? ''),
      inspectionTime: String((request.body as Record<string, unknown>).inspection_time ?? ''),
      inspector: String((request.body as Record<string, unknown>).inspector ?? ''),
      note: String((request.body as Record<string, unknown>).note ?? ''),
      records: Array.isArray((request.body as Record<string, unknown>).records)
        ? ((request.body as { records: Array<Record<string, unknown>> }).records).map(record => ({
          studentId: Number(record.student_id), status: String(record.status ?? '在寝'), note: String(record.note ?? ''),
        })) : undefined,
    }),
  })));
}
