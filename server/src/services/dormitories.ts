/* 宿舍管理：房间/床位为共享资源，入住记录按班级/学期归属。 */
import type { Database } from 'better-sqlite3';

import { ensureStudentInScope, getDb, scopeIds } from './context.js';
import * as audit from './audit.js';

export const DORM_GENDER_LIMITS = ['男', '女', '不限'];
export const DORM_ASSIGNMENT_STATUSES = ['在住', '调宿', '退宿'];
export const DORM_INSPECTION_STATUSES = ['在寝', '未归', '晚归', '请假'];
export const MAX_DORM_CAPACITY = 8;

export class DormitoryError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function endRoomLeader(roomId: number, classId: number, termId: number, studentId: number, conn: Database): void {
  const leader = conn.prepare(
    `SELECT id FROM dorm_room_leaders
      WHERE class_id=? AND term_id=? AND room_id=? AND student_id=? AND status='在任'`,
  ).get(classId, termId, Number(roomId), Number(studentId)) as { id: number } | undefined;
  if (!leader) return;
  conn.prepare(
    `UPDATE dorm_room_leaders
        SET status='已卸任', ended_at=date('now','localtime'), updated_at=datetime('now','localtime')
      WHERE id=?`,
  ).run(leader.id);
  audit.record('dorm_room_leader', Number(leader.id), 'end', {
    summary: `自动解除寝室长：宿舍${roomId}`, params: { student_id: studentId }, classId, termId, conn,
  });
}

function roomRow(roomId: number, options: { write?: boolean; conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  if (options.write) scopeIds({ write: true, conn });
  const row = conn.prepare('SELECT * FROM dorm_rooms WHERE id=?').get(Number(roomId)) as Record<string, unknown> | undefined;
  if (!row) throw new DormitoryError('宿舍房间不存在');
  return row;
}

function bedRow(bedId: number, conn: Database): Record<string, unknown> {
  const row = conn.prepare(
    `SELECT b.*, r.building, r.floor, r.room_no, r.gender_limit, r.status AS room_status
       FROM dorm_beds b JOIN dorm_rooms r ON r.id=b.room_id WHERE b.id=?`,
  ).get(Number(bedId)) as Record<string, unknown> | undefined;
  if (!row) throw new DormitoryError('宿舍床位不存在');
  return row;
}

function roomBeds(roomId: number, termId: number, conn: Database): Array<Record<string, unknown>> {
  return conn.prepare(
    `SELECT b.id, b.room_id, b.bed_no, b.status,
            da.id AS assignment_id, da.student_id, da.class_id, da.term_id,
            da.status AS assignment_status, s.学号, s.姓名, s.性别
       FROM dorm_beds b
       LEFT JOIN dorm_assignments da
         ON da.bed_id=b.id AND da.term_id=? AND da.status='在住'
       LEFT JOIN students s ON s.id=da.student_id
      WHERE b.room_id=?
        AND (CAST(b.bed_no AS INTEGER) <= (SELECT capacity FROM dorm_rooms WHERE id=b.room_id) OR da.id IS NOT NULL)
      ORDER BY b.bed_no, b.id`,
  ).all(termId, roomId) as Array<Record<string, unknown>>;
}

function serializeRoom(row: Record<string, unknown>, classId: number, termId: number, conn: Database): Record<string, unknown> {
  const item = { ...row };
  item.beds = roomBeds(Number(row.id), termId, conn);
  item.occupied_count = (item.beds as Array<Record<string, unknown>>)
    .filter(bed => bed.assignment_id).length;
  item.available_count = (item.beds as Array<Record<string, unknown>>)
    .filter(bed => !bed.assignment_id && bed.status === '可用').length;
  item.leader = conn.prepare(
    `SELECT l.id, l.room_id, l.student_id, l.assigned_at, l.note, s.学号, s.姓名, s.性别
       FROM dorm_room_leaders l JOIN students s ON s.id=l.student_id
      WHERE l.class_id=? AND l.term_id=? AND l.room_id=? AND l.status='在任' AND s.deleted_at=''`,
  ).get(classId, termId, Number(row.id)) ?? null;
  return item;
}

export function listRooms(options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  const rows = conn.prepare('SELECT * FROM dorm_rooms ORDER BY building, floor, room_no, id')
    .all() as Array<Record<string, unknown>>;
  return rows.map(row => serializeRoom(row, classId, termId, conn));
}

export function listAssignments(options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  return conn.prepare(
    `SELECT da.*, s.学号, s.姓名, s.性别,
            b.bed_no, b.room_id, r.building, r.floor, r.room_no
       FROM dorm_assignments da
       JOIN students s ON s.id=da.student_id
       JOIN dorm_beds b ON b.id=da.bed_id
       JOIN dorm_rooms r ON r.id=b.room_id
      WHERE da.class_id=? AND da.term_id=? AND da.status='在住' AND s.deleted_at=''
      ORDER BY r.building, r.floor, r.room_no, b.bed_no, s.学号`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
}

export function listUnassigned(options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  return conn.prepare(
    `SELECT s.id, s.学号, s.姓名, s.性别, s.是否住校
       FROM students s
       JOIN student_enrollments e ON e.student_id=s.id
      WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
        AND NOT EXISTS (
          SELECT 1 FROM dorm_assignments da
           WHERE da.student_id=s.id AND da.term_id=? AND da.status='在住'
        )
      ORDER BY s.学号`,
  ).all(classId, termId, termId) as Array<Record<string, unknown>>;
}

export function setRoomLeader(roomId: number, studentId: number | null, options: {
  assignedAt?: string; note?: string; conn?: Database;
} = {}): Record<string, unknown> | null {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ write: true, conn });
  roomRow(Number(roomId), { conn });
  return conn.transaction(() => {
    const current = conn.prepare(
      `SELECT * FROM dorm_room_leaders
        WHERE class_id=? AND term_id=? AND room_id=? AND status='在任'`,
    ).get(classId, termId, Number(roomId)) as Record<string, unknown> | undefined;

    if (studentId === null || studentId === undefined) {
      if (current) {
        conn.prepare(
          `UPDATE dorm_room_leaders
              SET status='已卸任', ended_at=date('now','localtime'), updated_at=datetime('now','localtime')
            WHERE id=?`,
        ).run(current.id);
        audit.record('dorm_room_leader', Number(current.id), 'end', {
          summary: `解除寝室长：宿舍${roomId}`, params: {}, classId, termId, conn,
        });
      }
      return null;
    }

    const assignment = conn.prepare(
      `SELECT da.student_id, s.姓名
         FROM dorm_assignments da
         JOIN dorm_beds b ON b.id=da.bed_id
         JOIN students s ON s.id=da.student_id
        WHERE da.class_id=? AND da.term_id=? AND b.room_id=? AND da.student_id=?
          AND da.status='在住' AND s.deleted_at=''`,
    ).get(classId, termId, Number(roomId), Number(studentId)) as { student_id: number; 姓名: string } | undefined;
    if (!assignment) throw new DormitoryError('寝室长必须是本宿舍当前入住学生');
    if (current && Number(current.student_id) === Number(studentId)) return current;

    if (current) {
      conn.prepare(
        `UPDATE dorm_room_leaders
            SET status='已卸任', ended_at=date('now','localtime'), updated_at=datetime('now','localtime')
          WHERE id=?`,
      ).run(current.id);
    }
    const inserted = conn.prepare(
      `INSERT INTO dorm_room_leaders(class_id, term_id, room_id, student_id, assigned_at, note)
       VALUES(?,?,?,?,?,?)`,
    ).run(classId, termId, Number(roomId), Number(studentId), text(options.assignedAt) || '', text(options.note));
    const leaderId = Number(inserted.lastInsertRowid);
    audit.record('dorm_room_leader', leaderId, 'assign', {
      summary: `指定寝室长：${assignment.姓名 ?? ''}`, params: { room_id: roomId, student_id: studentId },
      classId, termId, conn,
    });
    return conn.prepare(
      `SELECT l.id, l.room_id, l.student_id, l.assigned_at, l.note, s.学号, s.姓名, s.性别
         FROM dorm_room_leaders l JOIN students s ON s.id=l.student_id WHERE l.id=?`,
    ).get(leaderId) as Record<string, unknown>;
  })();
}

export interface InspectionRecordInput {
  studentId: number;
  status?: string;
  note?: string;
}

export function listInspections(options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  return conn.prepare(
    `SELECT di.*,
            COUNT(dir.id) AS record_count,
            COALESCE(SUM(CASE WHEN dir.status='在寝' THEN 1 ELSE 0 END), 0) AS present_count,
            COALESCE(SUM(CASE WHEN dir.status='未归' THEN 1 ELSE 0 END), 0) AS absent_count,
            COALESCE(SUM(CASE WHEN dir.status='晚归' THEN 1 ELSE 0 END), 0) AS late_count,
            COALESCE(SUM(CASE WHEN dir.status='请假' THEN 1 ELSE 0 END), 0) AS leave_count
       FROM dorm_inspections di
       LEFT JOIN dorm_inspection_records dir ON dir.inspection_id=di.id
      WHERE di.class_id=? AND di.term_id=?
      GROUP BY di.id
      ORDER BY di.inspection_date DESC, di.inspection_time DESC, di.id DESC
      LIMIT 30`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
}

export function getInspection(inspectionId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  const inspection = conn.prepare(
    'SELECT * FROM dorm_inspections WHERE id=? AND class_id=? AND term_id=?',
  ).get(Number(inspectionId), classId, termId) as Record<string, unknown> | undefined;
  if (!inspection) throw new DormitoryError('查寝记录不存在');
  return {
    ...inspection,
    records: conn.prepare(
      `SELECT dir.*, s.学号, s.姓名, s.性别, r.building, r.floor, r.room_no, b.bed_no
         FROM dorm_inspection_records dir
         JOIN students s ON s.id=dir.student_id
         JOIN dorm_rooms r ON r.id=dir.room_id
         LEFT JOIN dorm_assignments da ON da.student_id=dir.student_id AND da.term_id=? AND da.status='在住'
         LEFT JOIN dorm_beds b ON b.id=da.bed_id
        WHERE dir.inspection_id=? AND s.deleted_at=''
        ORDER BY r.building, r.floor, r.room_no, b.bed_no, s.学号`,
    ).all(termId, Number(inspectionId)) as Array<Record<string, unknown>>,
  };
}

export function createInspection(options: {
  inspectionDate: string; inspectionTime?: string; inspector?: string; note?: string;
  records?: InspectionRecordInput[]; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ write: true, conn });
  const inspectionDate = text(options.inspectionDate);
  if (!inspectionDate) throw new DormitoryError('查寝日期不能为空');
  const occupants = conn.prepare(
    `SELECT da.student_id, b.room_id
       FROM dorm_assignments da JOIN dorm_beds b ON b.id=da.bed_id
      WHERE da.class_id=? AND da.term_id=? AND da.status='在住'`,
  ).all(classId, termId) as Array<{ student_id: number; room_id: number }>;
  const occupantByStudent = new Map(occupants.map(item => [Number(item.student_id), item]));
  const requested = options.records?.length
    ? options.records
    : occupants.map(item => ({ studentId: Number(item.student_id), status: '在寝', note: '' }));
  const seen = new Set<number>();
  for (const record of requested) {
    const studentId = Number(record.studentId);
    if (seen.has(studentId)) throw new DormitoryError('查寝名单中存在重复学生');
    seen.add(studentId);
    if (!occupantByStudent.has(studentId)) throw new DormitoryError('查寝学生必须是当前入住学生');
    if (!DORM_INSPECTION_STATUSES.includes(text(record.status) || '在寝')) throw new DormitoryError('查寝状态不合法');
  }
  const inspectionId = conn.transaction(() => {
    const inserted = conn.prepare(
      `INSERT INTO dorm_inspections(class_id, term_id, inspection_date, inspection_time, inspector, note)
       VALUES(?,?,?,?,?,?)`,
    ).run(classId, termId, inspectionDate, text(options.inspectionTime), text(options.inspector), text(options.note));
    const id = Number(inserted.lastInsertRowid);
    const insertRecord = conn.prepare(
      `INSERT INTO dorm_inspection_records(inspection_id, room_id, student_id, status, note)
       VALUES(?,?,?,?,?)`,
    );
    for (const record of requested) {
      const studentId = Number(record.studentId);
      insertRecord.run(id, occupantByStudent.get(studentId)?.room_id, studentId, text(record.status) || '在寝', text(record.note));
    }
    audit.record('dorm_inspection', id, 'create', {
      summary: `查寝：${inspectionDate}`, params: { record_count: requested.length, inspector: options.inspector },
      classId, termId, conn,
    });
    return id;
  })();
  return getInspection(inspectionId, { conn });
}

export function createRoom(options: {
  building?: string; floor?: string; roomNo: string; genderLimit?: string;
  capacity: number; note?: string; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ write: true, conn });
  const roomNo = text(options.roomNo);
  const capacity = Number(options.capacity);
  const genderLimit = text(options.genderLimit) || '不限';
  if (!roomNo) throw new DormitoryError('房间号不能为空');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_DORM_CAPACITY) {
    throw new DormitoryError(`床位数必须在 1 到 ${MAX_DORM_CAPACITY} 之间`);
  }
  if (!DORM_GENDER_LIMITS.includes(genderLimit)) throw new DormitoryError('宿舍性别限制不合法');
  const roomId = conn.transaction(() => {
    const inserted = conn.prepare(
      `INSERT INTO dorm_rooms(building, floor, room_no, gender_limit, capacity, note)
       VALUES(?,?,?,?,?,?)`,
    ).run(text(options.building), text(options.floor), roomNo, genderLimit, capacity, text(options.note));
    const roomId = Number(inserted.lastInsertRowid);
    const bed = conn.prepare('INSERT INTO dorm_beds(room_id, bed_no) VALUES(?,?)');
    for (let index = 1; index <= capacity; index += 1) bed.run(roomId, String(index));
    audit.record('dorm_room', roomId, 'create', {
      summary: `新增宿舍：${roomNo}`, params: { building: options.building, floor: options.floor, room_no: roomNo, capacity },
      classId, termId, conn,
    });
    return roomId;
  })();
  return listRooms({ conn }).find(row => Number(row.id) === roomId) ?? roomRow(roomId, { conn });
}

export function updateRoom(roomId: number, options: {
  building?: string | null; floor?: string | null; roomNo?: string | null;
  genderLimit?: string | null; capacity?: number | null; status?: string | null;
  note?: string | null; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ write: true, conn });
  const current = roomRow(roomId, { conn });
  const fields: string[] = [];
  const params: unknown[] = [];
  if (options.building !== undefined && options.building !== null) { fields.push('building=?'); params.push(text(options.building)); }
  if (options.floor !== undefined && options.floor !== null) { fields.push('floor=?'); params.push(text(options.floor)); }
  if (options.roomNo !== undefined && options.roomNo !== null) {
    const roomNo = text(options.roomNo); if (!roomNo) throw new DormitoryError('房间号不能为空');
    fields.push('room_no=?'); params.push(roomNo);
  }
  if (options.genderLimit !== undefined && options.genderLimit !== null) {
    if (!DORM_GENDER_LIMITS.includes(options.genderLimit)) throw new DormitoryError('宿舍性别限制不合法');
    fields.push('gender_limit=?'); params.push(options.genderLimit);
  }
  if (options.status !== undefined && options.status !== null) {
    if (!['使用中', '停用'].includes(options.status)) throw new DormitoryError('宿舍状态不合法');
    if (options.status === '停用' && conn.prepare(
      `SELECT 1 FROM dorm_assignments da JOIN dorm_beds b ON b.id=da.bed_id
       WHERE b.room_id=? AND da.status='在住'`,
    ).get(roomId)) throw new DormitoryError('仍有学生入住，不能停用宿舍');
    fields.push('status=?'); params.push(options.status);
  }
  if (options.note !== undefined && options.note !== null) { fields.push('note=?'); params.push(text(options.note)); }
  if (options.capacity !== undefined && options.capacity !== null) {
    const capacity = Number(options.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_DORM_CAPACITY) {
      throw new DormitoryError(`床位数必须在 1 到 ${MAX_DORM_CAPACITY} 之间`);
    }
    const occupied = conn.prepare(
      `SELECT COUNT(*) AS count FROM dorm_assignments da JOIN dorm_beds b ON b.id=da.bed_id
       WHERE b.room_id=? AND da.status='在住'`,
    ).get(roomId) as { count: number };
    if (conn.prepare(
      `SELECT 1 FROM dorm_assignments da JOIN dorm_beds b ON b.id=da.bed_id
       WHERE b.room_id=? AND da.status='在住' AND CAST(b.bed_no AS INTEGER)>?`,
    ).get(roomId, capacity)) throw new DormitoryError('不能移除当前入住床位');
    if (capacity < Number(occupied.count)) throw new DormitoryError('新床位数不能少于当前入住人数');
    const beds = conn.prepare('SELECT id, bed_no, status FROM dorm_beds WHERE room_id=? ORDER BY id').all(roomId) as Array<Record<string, unknown>>;
    const maxExisting = beds.reduce((max, bed) => Math.max(max, Number(bed.bed_no) || 0), 0);
    const insertBed = conn.prepare('INSERT INTO dorm_beds(room_id, bed_no) VALUES(?,?)');
    for (let index = maxExisting + 1; index <= capacity; index += 1) insertBed.run(roomId, String(index));
    const removable = beds.filter(bed => Number(bed.bed_no) > capacity && bed.status === '可用');
    for (const bed of removable) {
      // 床位可能被历史入住记录引用，不能删除；停用后从当前房间视图隐藏。
      conn.prepare("UPDATE dorm_beds SET status='停用' WHERE id=?").run(bed.id);
    }
    conn.prepare(
      `UPDATE dorm_beds SET status='可用'
        WHERE room_id=? AND status='停用' AND CAST(bed_no AS INTEGER)>? AND CAST(bed_no AS INTEGER)<=?`,
    ).run(roomId, current.capacity, capacity);
    fields.push('capacity=?'); params.push(capacity);
  }
  if (fields.length) {
    params.push(Number(roomId));
    conn.prepare(`UPDATE dorm_rooms SET ${fields.join(', ')}, updated_at=datetime('now','localtime') WHERE id=?`).run(...params);
    audit.record('dorm_room', roomId, 'update', {
      summary: `更新宿舍：${options.roomNo ?? current.room_no ?? ''}`,
      params: { room_no: options.roomNo, capacity: options.capacity, status: options.status },
      classId, termId, conn,
    });
  }
  return listRooms({ conn }).find(row => Number(row.id) === Number(roomId)) ?? roomRow(roomId, { conn });
}

export function assignBed(options: {
  studentId: number; bedId: number; note?: string; moveInAt?: string; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ write: true, conn });
  const student = ensureStudentInScope(Number(options.studentId), { write: true, conn });
  const bed = bedRow(Number(options.bedId), conn);
  if (bed.room_status !== '使用中' || bed.status !== '可用') throw new DormitoryError('该宿舍或床位不可用');
  if (bed.gender_limit !== '不限' && text(student.性别) && bed.gender_limit !== student.性别) {
    throw new DormitoryError(`该宿舍仅限${bed.gender_limit}生入住`);
  }
  if (conn.prepare("SELECT 1 FROM dorm_assignments WHERE student_id=? AND term_id=? AND status='在住'").get(options.studentId, termId)) {
    throw new DormitoryError('该学生本学期已经有在住床位');
  }
  if (conn.prepare("SELECT 1 FROM dorm_assignments WHERE bed_id=? AND term_id=? AND status='在住'").get(options.bedId, termId)) {
    throw new DormitoryError('该床位已经有人入住');
  }
  const result = conn.prepare(
    `INSERT INTO dorm_assignments(class_id, term_id, student_id, bed_id, status, move_in_at, note)
     VALUES(?,?,?,?,'在住',?,?)`,
  ).run(classId, termId, Number(options.studentId), Number(options.bedId), text(options.moveInAt), text(options.note));
  const assignmentId = Number(result.lastInsertRowid);
  audit.record('dorm_assignment', assignmentId, 'create', {
    summary: `安排住宿：${student.姓名 ?? ''}`, params: { student_id: options.studentId, bed_id: options.bedId },
    classId, termId, conn,
  });
  return getAssignment(assignmentId, { conn });
}

function getAssignment(assignmentId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
       `SELECT da.*, s.学号, s.姓名, s.性别, b.bed_no, b.room_id, r.building, r.floor, r.room_no
       FROM dorm_assignments da JOIN students s ON s.id=da.student_id
       JOIN dorm_beds b ON b.id=da.bed_id JOIN dorm_rooms r ON r.id=b.room_id
      WHERE da.id=? AND da.class_id=? AND da.term_id=?`,
  ).get(assignmentId, classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new DormitoryError('住宿记录不存在');
  return row;
}

export function moveAssignment(assignmentId: number, options: {
  bedId: number; reason?: string; moveInAt?: string; note?: string; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const current = getAssignment(assignmentId, { conn });
  scopeIds({ write: true, conn });
  if (current.status !== '在住') throw new DormitoryError('只有在住记录可以调宿');
  const bed = bedRow(Number(options.bedId), conn);
  if (bed.room_status !== '使用中' || bed.status !== '可用') throw new DormitoryError('目标宿舍或床位不可用');
  if (conn.prepare("SELECT 1 FROM dorm_assignments WHERE bed_id=? AND term_id=? AND status='在住'").get(options.bedId, current.term_id)) {
    throw new DormitoryError('目标床位已经有人入住');
  }
  const result = conn.transaction(() => {
    if (Number(bed.room_id) !== Number(current.room_id)) {
      endRoomLeader(Number(current.room_id), Number(current.class_id), Number(current.term_id), Number(current.student_id), conn);
    }
    conn.prepare(
      `UPDATE dorm_assignments SET status='调宿', move_out_at=?, reason=?, updated_at=datetime('now','localtime') WHERE id=?`,
    ).run(text(options.moveInAt), text(options.reason) || '调宿', assignmentId);
    const inserted = conn.prepare(
      `INSERT INTO dorm_assignments(class_id, term_id, student_id, bed_id, status, move_in_at, note)
       VALUES(?,?,?,?,'在住',?,?)`,
    ).run(current.class_id, current.term_id, current.student_id, Number(options.bedId), text(options.moveInAt), text(options.note));
    const newId = Number(inserted.lastInsertRowid);
    audit.record('dorm_assignment', newId, 'move', {
      summary: `调宿：${current.姓名 ?? ''}`, params: { from_assignment_id: assignmentId, bed_id: options.bedId, reason: options.reason },
      conn,
    });
    return newId;
  })();
  return getAssignment(result, { conn });
}

export function checkoutAssignment(assignmentId: number, options: {
  reason?: string; moveOutAt?: string; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const current = getAssignment(assignmentId, { conn });
  scopeIds({ write: true, conn });
  if (current.status !== '在住') throw new DormitoryError('只有在住记录可以退宿');
  endRoomLeader(Number(current.room_id), Number(current.class_id), Number(current.term_id), Number(current.student_id), conn);
  conn.prepare(
    `UPDATE dorm_assignments SET status='退宿', move_out_at=?, reason=?, updated_at=datetime('now','localtime') WHERE id=?`,
  ).run(text(options.moveOutAt), text(options.reason) || '退宿', assignmentId);
  audit.record('dorm_assignment', assignmentId, 'checkout', {
    summary: `退宿：${current.姓名 ?? ''}`, params: { reason: options.reason }, conn,
  });
  return getAssignment(assignmentId, { conn });
}
