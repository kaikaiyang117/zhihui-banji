/* 班级小组：按班级/学期管理学生分组和成员历史。 */
import type { Database } from 'better-sqlite3';

import { ensureStudentInScope, getDb, scopeIds } from './context.js';
import * as audit from './audit.js';

export const GROUP_TYPES = ['学习小组', '值日小组', '活动小组'];
export const GROUP_ROLES = ['组长', '成员'];

export class GroupError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function groupRow(groupId: number, options: { write?: boolean; conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ write: options.write, conn });
  const row = conn.prepare(
    'SELECT * FROM student_groups WHERE id=? AND class_id=? AND term_id=?',
  ).get(Number(groupId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new GroupError('小组不存在');
  return row;
}

function members(groupId: number, conn: Database): Array<Record<string, unknown>> {
  return conn.prepare(
    `SELECT m.id AS membership_id, m.student_id, m.role, m.sort_order, m.status,
            m.joined_at, m.left_at, s.学号, s.姓名, s.性别
       FROM student_group_members m
       JOIN students s ON s.id=m.student_id
      WHERE m.group_id=? AND m.status='在组' AND s.deleted_at=''
      ORDER BY m.sort_order, s.学号, m.student_id`,
  ).all(groupId) as Array<Record<string, unknown>>;
}

function serialize(row: Record<string, unknown>, conn: Database): Record<string, unknown> {
  const item = { ...row };
  item.members = members(Number(row.id), conn);
  item.member_count = (item.members as Array<unknown>).length;
  return item;
}

export function listGroups(options: { groupType?: string; conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  const params: unknown[] = [classId, termId];
  let sql = `SELECT * FROM student_groups
             WHERE class_id=? AND term_id=? AND status='使用中'`;
  if (options.groupType) {
    if (!GROUP_TYPES.includes(options.groupType)) throw new GroupError('小组类型不合法');
    sql += ' AND group_type=?';
    params.push(options.groupType);
  }
  sql += ' ORDER BY group_type, sort_order, id';
  return (conn.prepare(sql).all(...params) as Array<Record<string, unknown>>)
    .map(row => serialize(row, conn));
}

export function getGroup(groupId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  return serialize(groupRow(groupId, { conn: options.conn }), connOf(options.conn));
}

export function listUnassigned(groupType = '学习小组', options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  if (!GROUP_TYPES.includes(groupType)) throw new GroupError('小组类型不合法');
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  return conn.prepare(
    `SELECT s.id, s.学号, s.姓名, s.性别
       FROM students s
       JOIN student_enrollments e ON e.student_id=s.id
      WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
        AND NOT EXISTS (
          SELECT 1
            FROM student_group_members m
            JOIN student_groups g ON g.id=m.group_id
           WHERE m.student_id=s.id AND m.status='在组'
             AND g.class_id=? AND g.term_id=? AND g.group_type=? AND g.status='使用中'
        )
      ORDER BY s.学号`,
  ).all(classId, termId, classId, termId, groupType) as Array<Record<string, unknown>>;
}

export function createGroup(options: {
  name: string; groupType?: string; sortOrder?: number; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ write: true, conn });
  const name = text(options.name);
  const groupType = text(options.groupType) || '学习小组';
  if (!name) throw new GroupError('小组名称不能为空');
  if (!GROUP_TYPES.includes(groupType)) throw new GroupError('小组类型不合法');
  const result = conn.prepare(
    `INSERT INTO student_groups(class_id, term_id, name, group_type, sort_order)
     VALUES(?,?,?,?,?)`,
  ).run(classId, termId, name, groupType, Number(options.sortOrder ?? 0));
  const groupId = Number(result.lastInsertRowid);
  audit.record('student_group', groupId, 'create', {
    summary: `新增小组：${name}`,
    params: { name, group_type: groupType }, classId, termId, conn,
  });
  return getGroup(groupId, { conn });
}

export function updateGroup(groupId: number, options: {
  name?: string | null; groupType?: string | null; sortOrder?: number | null;
  status?: string | null; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const current = groupRow(groupId, { write: true, conn });
  const fields: string[] = [];
  const params: unknown[] = [];
  if (options.name !== undefined && options.name !== null) {
    const name = text(options.name);
    if (!name) throw new GroupError('小组名称不能为空');
    fields.push('name=?'); params.push(name);
  }
  if (options.groupType !== undefined && options.groupType !== null) {
    const groupType = text(options.groupType);
    if (!GROUP_TYPES.includes(groupType)) throw new GroupError('小组类型不合法');
    if (groupType !== current.group_type) {
      const conflicts = conn.prepare(
        `SELECT s.姓名, g.name
           FROM student_group_members m
           JOIN student_groups g ON g.id=m.group_id
           JOIN students s ON s.id=m.student_id
          WHERE m.group_id=? AND m.status='在组' AND g.group_type<>?
            AND EXISTS (
              SELECT 1 FROM student_group_members other_m
              JOIN student_groups other_g ON other_g.id=other_m.group_id
              WHERE other_m.student_id=m.student_id AND other_m.status='在组'
                AND other_g.id<>g.id AND other_g.class_id=g.class_id AND other_g.term_id=g.term_id
                AND other_g.group_type=? AND other_g.status='使用中'
            )`,
      ).all(groupId, groupType, groupType) as Array<Record<string, unknown>>;
      if (conflicts.length) throw new GroupError(`已有学生属于其他${groupType}，不能直接切换小组类型`);
    }
    fields.push('group_type=?'); params.push(groupType);
  }
  if (options.sortOrder !== undefined && options.sortOrder !== null) {
    fields.push('sort_order=?'); params.push(Number(options.sortOrder));
  }
  if (options.status !== undefined && options.status !== null) {
    if (!['使用中', '已归档'].includes(options.status)) throw new GroupError('小组状态不合法');
    fields.push('status=?'); params.push(options.status);
  }
  if (fields.length > 0) {
    params.push(Number(groupId));
    conn.prepare(`UPDATE student_groups SET ${fields.join(', ')}, updated_at=datetime('now','localtime') WHERE id=?`)
      .run(...params);
    audit.record('student_group', groupId, options.status === '已归档' ? 'archive' : 'update', {
      summary: `更新小组：${options.name ?? current.name ?? ''}`,
      params: { name: options.name, group_type: options.groupType, status: options.status },
      conn,
    });
  }
  return getGroup(groupId, { conn });
}

export function replaceMembers(groupId: number, rawMembers: Array<{
  studentId: number; role?: string; sortOrder?: number;
}>, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const group = groupRow(groupId, { write: true, conn });
  const [classId, termId] = scopeIds({ write: true, conn });
  const selected = new Map<number, { role: string; sortOrder: number }>();
  for (const item of rawMembers) {
    const studentId = Number(item.studentId);
    if (!Number.isInteger(studentId) || studentId <= 0) throw new GroupError('学生参数不合法');
    ensureStudentInScope(studentId, { write: true, conn });
    const role = text(item.role) || '成员';
    if (!GROUP_ROLES.includes(role)) throw new GroupError('小组成员角色不合法');
    selected.set(studentId, { role, sortOrder: Number(item.sortOrder ?? selected.size) });
  }
  if ([...selected.values()].filter(item => item.role === '组长').length > 1) {
    throw new GroupError('一个小组只能设置一名组长');
  }
  const transaction = conn.transaction(() => {
    const conflict = conn.prepare(
      `SELECT g.name, s.姓名
         FROM student_group_members m
         JOIN student_groups g ON g.id=m.group_id
         JOIN students s ON s.id=m.student_id
        WHERE m.student_id=? AND m.status='在组' AND g.id<>?
          AND g.class_id=? AND g.term_id=? AND g.group_type=? AND g.status='使用中'`,
    );
    for (const studentId of selected.keys()) {
      const row = conflict.get(studentId, groupId, classId, termId, group.group_type) as
        { name: string; 姓名: string } | undefined;
      if (row) throw new GroupError(`学生“${row.姓名}”已经在${row.name}，不能重复加入同类型小组`);
    }
    if (selected.size) {
      conn.prepare(
        `UPDATE student_group_members
            SET status='已退出', left_at=datetime('now','localtime')
          WHERE group_id=? AND status='在组' AND student_id NOT IN (${[...selected.keys()].map(() => '?').join(',')})`,
      ).run(groupId, ...selected.keys());
    } else {
      conn.prepare(
        `UPDATE student_group_members
            SET status='已退出', left_at=datetime('now','localtime')
          WHERE group_id=? AND status='在组'`,
      ).run(groupId);
    }
    const existing = conn.prepare(
      'SELECT id FROM student_group_members WHERE group_id=? AND student_id=?',
    );
    const insert = conn.prepare(
      `INSERT INTO student_group_members(group_id, student_id, role, sort_order, status, left_at)
       VALUES(?,?,?,?, '在组', '')`,
    );
    const revive = conn.prepare(
      `UPDATE student_group_members SET role=?, sort_order=?, status='在组', left_at=''
       WHERE group_id=? AND student_id=?`,
    );
    for (const [studentId, value] of selected.entries()) {
      if (existing.get(groupId, studentId)) revive.run(value.role, value.sortOrder, groupId, studentId);
      else insert.run(groupId, studentId, value.role, value.sortOrder);
    }
    audit.record('student_group', groupId, 'members_replace', {
      summary: `更新小组成员：${group.name ?? ''}`,
      params: { count: selected.size }, classId, termId, conn,
    });
  });
  transaction();
  return getGroup(groupId, { conn });
}
