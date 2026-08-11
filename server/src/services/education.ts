/* 班会、活动、日志的结构化记录与统一行动关联。
 * 提供结构化记录和统一行动关联。
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { getDb, scopeIds, ensureStudentInScope } from './context.js';
import * as audit from './audit.js';
import { todayString } from './clock.js';
import { ensureSourceWorkItem } from './workItems.js';
import * as recycle from './recycle.js';
import { safeResolve, atomicWrite, sha256 } from './files.js';

export const MEETING_FORMATS: Set<string> = new Set(['主题班会', '事务通知', '团队活动', '安全教育', '心理健康']);
export const MEETING_STATUSES: Set<string> = new Set(['已记录', '待复盘']);
export const ACTIVITY_TYPES: Set<string> = new Set(['文体活动', '社会实践', '志愿服务', '学科竞赛', '节日庆祝', '其他']);
export const ACTIVITY_STATUSES: Set<string> = new Set(['计划中', '进行中', '已完成', '已复盘']);
export const LINK_TYPES: Set<string> = new Set(['meeting', 'activity', 'event', 'work_item', 'student']);
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export class EducationError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function nowString(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function scope(options: { write?: boolean; conn?: Database } = {}): [number, number] {
  return scopeIds({ write: options.write, conn: options.conn });
}

function dateText(value: unknown, label: string, defaultToday = false): string {
  let textValue = String(value ?? '').trim().slice(0, 10);
  if (!textValue && defaultToday) textValue = todayString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(textValue)) {
    throw new EducationError(`${label}格式不正确，应为 YYYY-MM-DD`);
  }
  const year = Number(textValue.slice(0, 4));
  const month = Number(textValue.slice(5, 7));
  const day = Number(textValue.slice(8, 10));
  const parsed = new Date(`${textValue}T00:00:00Z`);
  if (isNaN(parsed.getTime())) throw new EducationError(`${label}格式不正确，应为 YYYY-MM-DD`);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new EducationError(`${label}格式不正确，应为 YYYY-MM-DD`);
  }
  return textValue;
}

function intValue(value: unknown, label: string, minimum = 0): number {
  let number: number;
  if (value === null || value === undefined || value === '') {
    number = 0;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    number = Math.trunc(value);
  } else if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    number = Number(value.trim());
  } else {
    throw new EducationError(`${label}必须是整数`);
  }
  if (number < minimum) throw new EducationError(`${label}不能小于 ${minimum}`);
  return number;
}

function pyFloatString(value: number): string {
  /* Python str() 对浮点数输出 '0.0'，JS 无浮点类型；审计参数对齐 Python。 */
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function money(value: unknown): number {
  const raw = value === null || value === undefined || value === '' ? 0 : value;
  const number = Number(raw);
  if (Number.isNaN(number)) throw new EducationError('预算必须是数字');
  const rounded = Math.round(number * 100) / 100;
  if (rounded < 0) throw new EducationError('预算不能为负数');
  return rounded;
}

function studentIds(values: unknown, options: { conn?: Database } = {}): number[] {
  const conn = connOf(options.conn);
  const ids: number[] = [];
  for (const value of (values ?? []) as Array<unknown>) {
    const studentId = intValue(value, '学生 ID', 1);
    ensureStudentInScope(studentId, { write: true, conn });
    if (!ids.includes(studentId)) ids.push(studentId);
  }
  return ids;
}

function meetingRow(meetingId: number, options: { write?: boolean; conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: options.write, conn });
  const row = conn.prepare(
    `SELECT m.*, t.name AS template_name
     FROM meeting_records m LEFT JOIN meeting_templates t ON t.id=m.template_id
     WHERE m.id=? AND m.class_id=? AND m.term_id=? AND m.deleted_at=''`,
  ).get(Number(meetingId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new EducationError('班会记录不存在');
  return row;
}

function activityRow(activityId: number, options: { write?: boolean; conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: options.write, conn });
  const row = conn.prepare(
    `SELECT a.*, t.name AS template_name
     FROM activity_records a LEFT JOIN activity_templates t ON t.id=a.template_id
     WHERE a.id=? AND a.class_id=? AND a.term_id=? AND a.deleted_at=''`,
  ).get(Number(activityId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new EducationError('活动记录不存在');
  return row;
}

function decorateMeeting(row: Record<string, unknown>, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const item: Record<string, unknown> = { ...row };
  item.participants = conn.prepare(
    `SELECT p.*, s.学号, s.姓名 AS student_name
     FROM meeting_participants p JOIN students s ON s.id=p.student_id
     WHERE p.meeting_id=? AND s.deleted_at='' ORDER BY s.学号, s.id`,
  ).all(Number(item.id));
  item.actions = conn.prepare(
    'SELECT * FROM meeting_actions WHERE meeting_id=? ORDER BY id',
  ).all(Number(item.id));
  item.participant_count = (item.participants as Array<unknown>).length;
  item.legacy = Boolean(item.legacy_row_no);
  return item;
}

function decorateActivity(row: Record<string, unknown>, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const item: Record<string, unknown> = { ...row };
  item.participants = conn.prepare(
    `SELECT p.*, s.学号, s.姓名 AS student_name
     FROM activity_participants p JOIN students s ON s.id=p.student_id
     WHERE p.activity_id=? AND s.deleted_at='' ORDER BY s.学号, s.id`,
  ).all(Number(item.id));
  item.attachments = conn.prepare(
    'SELECT * FROM activity_attachments WHERE activity_id=? ORDER BY id',
  ).all(Number(item.id));
  item.legacy = Boolean(item.legacy_row_no);
  return item;
}

export function listMeetings(options: {
  query?: string; dateFrom?: string; dateTo?: string; includeDeleted?: boolean; conn?: Database;
} = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const where = ['m.class_id=?', 'm.term_id=?'];
  const params: unknown[] = [classId, termId];
  if (!options.includeDeleted) where.push("m.deleted_at=''");
  if (text(options.query)) {
    where.push('(m.topic LIKE ? OR m.content LIKE ? OR m.conclusion LIKE ?)');
    const like = `%${text(options.query)}%`;
    params.push(like, like, like);
  }
  if (options.dateFrom) {
    where.push('m.held_on>=?');
    params.push(dateText(options.dateFrom, '开始日期'));
  }
  if (options.dateTo) {
    where.push('m.held_on<=?');
    params.push(dateText(options.dateTo, '结束日期'));
  }
  const rows = conn.prepare(
    'SELECT m.*, t.name AS template_name FROM meeting_records m '
    + 'LEFT JOIN meeting_templates t ON t.id=m.template_id WHERE ' + where.join(' AND ')
    + ' ORDER BY m.held_on DESC, m.id DESC',
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => decorateMeeting(row, { conn }));
}

export function listActivities(options: {
  query?: string; dateFrom?: string; dateTo?: string; conn?: Database;
} = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const where = ["a.class_id=?", "a.term_id=?", "a.deleted_at=''"];
  const params: unknown[] = [classId, termId];
  if (text(options.query)) {
    where.push('(a.name LIKE ? OR a.summary LIKE ? OR a.retrospective LIKE ?)');
    const like = `%${text(options.query)}%`;
    params.push(like, like, like);
  }
  if (options.dateFrom) {
    where.push('a.occurred_on>=?');
    params.push(dateText(options.dateFrom, '开始日期'));
  }
  if (options.dateTo) {
    where.push('a.occurred_on<=?');
    params.push(dateText(options.dateTo, '结束日期'));
  }
  const rows = conn.prepare(
    'SELECT a.*, t.name AS template_name FROM activity_records a '
    + 'LEFT JOIN activity_templates t ON t.id=a.template_id WHERE ' + where.join(' AND ')
    + ' ORDER BY a.occurred_on DESC, a.id DESC',
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => decorateActivity(row, { conn }));
}

export function listDiary(options: {
  month?: string; dateFrom?: string; dateTo?: string; conn?: Database;
} = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const where = ["d.class_id=?", "d.term_id=?", "d.deleted_at=''"];
  const params: unknown[] = [classId, termId];
  const month = text(options.month);
  if (month) {
    if (month.length !== 7 || month[4] !== '-') {
      throw new EducationError('月份格式不正确，应为 YYYY-MM');
    }
    where.push('substr(d.diary_date,1,7)=?');
    params.push(month);
  }
  if (options.dateFrom) {
    where.push('d.diary_date>=?');
    params.push(dateText(options.dateFrom, '开始日期'));
  }
  if (options.dateTo) {
    where.push('d.diary_date<=?');
    params.push(dateText(options.dateTo, '结束日期'));
  }
  const rows = conn.prepare(
    'SELECT d.* FROM diary_entries d WHERE ' + where.join(' AND ')
    + ' ORDER BY d.diary_date DESC, d.id DESC',
  ).all(...params) as Array<Record<string, unknown>>;
  const result: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const item: Record<string, unknown> = { ...row };
    item.links = conn.prepare(
      'SELECT * FROM diary_links WHERE diary_id=? ORDER BY id',
    ).all(Number(item.id));
    item.legacy = Boolean(item.legacy_row_no);
    result.push(item);
  }
  return result;
}

export function listTemplates(options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  return {
    meetings: conn.prepare(
      'SELECT * FROM meeting_templates WHERE class_id=? AND term_id=? AND enabled=1 ORDER BY name',
    ).all(classId, termId),
    activities: conn.prepare(
      'SELECT * FROM activity_templates WHERE class_id=? AND term_id=? AND enabled=1 ORDER BY name',
    ).all(classId, termId),
  };
}

export function createTemplate(kind: string, options: {
  name?: string; content?: string; format?: string; activityType?: string; description?: string; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: true, conn });
  const name = text(options.name);
  if (!name) throw new EducationError('模板名称不能为空');
  try {
    const rowId = conn.transaction(() => {
      let rowId: number;
      if (kind === 'meeting') {
        const format = options.format ?? '主题班会';
        if (!MEETING_FORMATS.has(format)) throw new EducationError('班会形式不合法');
        const inserted = conn.prepare(
          'INSERT INTO meeting_templates(class_id,term_id,name,format,content) VALUES(?,?,?,?,?)',
        ).run(classId, termId, name, format, text(options.content));
        rowId = Number(inserted.lastInsertRowid);
      } else if (kind === 'activity') {
        const activityType = options.activityType ?? '其他';
        if (!ACTIVITY_TYPES.has(activityType)) throw new EducationError('活动类型不合法');
        const inserted = conn.prepare(
          'INSERT INTO activity_templates(class_id,term_id,name,activity_type,description) VALUES(?,?,?,?,?)',
        ).run(classId, termId, name, activityType, text(options.description));
        rowId = Number(inserted.lastInsertRowid);
      } else {
        throw new EducationError('不支持的模板类型');
      }
      audit.record(`${kind}_template`, rowId, 'create', {
        summary: `新增${kind}模板：${name}`,
        params: { name },
        classId, termId, conn,
      });
      return rowId;
    })();
    return { id: rowId, name };
  } catch (error) {
    if (!(error instanceof EducationError)
      && String((error as Error).message ?? error).toUpperCase().includes('UNIQUE')) {
      throw new EducationError('当前班级与学期已有同名模板');
    }
    throw error;
  }
}

export function createMeeting(options: {
  heldOn: string; topic: string; format?: string; content?: string; participation?: string;
  conclusion?: string; status?: string; templateId?: number | null; studentIds?: unknown;
  actionItems?: Array<Record<string, unknown>> | null; followupTitle?: string; followupDue?: string;
  conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: true, conn });
  const heldOn = dateText(options.heldOn, '班会日期', true);
  const topic = text(options.topic);
  if (!topic) throw new EducationError('班会主题不能为空');
  const format = options.format ?? '主题班会';
  const status = options.status ?? '已记录';
  if (!MEETING_FORMATS.has(format) || !MEETING_STATUSES.has(status)) {
    throw new EducationError('班会形式或状态不合法');
  }
  const ids = studentIds(options.studentIds, { conn });
  const actions: Array<Record<string, unknown>> = [...(options.actionItems ?? [])];
  if (text(options.followupTitle)) {
    actions.push({ title: options.followupTitle, due_at: options.followupDue ?? '' });
  }
  const meetingId = conn.transaction(() => {
    const inserted = conn.prepare(
      `INSERT INTO meeting_records(
         class_id,term_id,template_id,held_on,topic,format,content,participation,conclusion,status
       ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      classId, termId, options.templateId ?? null, heldOn, topic, format, text(options.content),
      text(options.participation), text(options.conclusion), status,
    );
    const createdId = Number(inserted.lastInsertRowid);
    const participantStmt = conn.prepare('INSERT INTO meeting_participants(meeting_id,student_id) VALUES(?,?)');
    for (const studentId of ids) participantStmt.run(createdId, studentId);
    for (const action of actions) {
      const title = text(action.title);
      if (!title) continue;
      const dueAt = text(action.due_at).slice(0, 30);
      const actionInserted = conn.prepare(
        'INSERT INTO meeting_actions(meeting_id,title,owner,due_at) VALUES(?,?,?,?)',
      ).run(createdId, title, text(action.owner) || '班主任', dueAt);
      const actionId = Number(actionInserted.lastInsertRowid);
      const item = ensureSourceWorkItem({
        title,
        sourceType: 'meeting_action',
        sourceId: actionId,
        sourceLabel: '班会行动项',
        dueAt,
        priority: text(action.priority) || '普通',
        notes: `来源：班会 #${createdId}`,
        conn,
      });
      conn.prepare('UPDATE meeting_actions SET work_item_id=? WHERE id=?').run(item.id, actionId);
    }
    audit.record('meeting', createdId, 'create', {
      summary: `新增班会：${topic}`,
      params: { held_on: heldOn, participant_count: ids.length, action_count: actions.length },
      classId, termId, conn,
    });
    return createdId;
  })();
  return decorateMeeting(meetingRow(meetingId, { conn }), { conn });
}

export function updateMeeting(meetingId: number, options: {
  values: Record<string, unknown>; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const current = meetingRow(meetingId, { write: true, conn });
  const values = options.values ?? {};
  const allowed = ['held_on', 'topic', 'format', 'content', 'participation', 'conclusion', 'status', 'template_id'];
  const updates: string[] = [];
  const params: unknown[] = [];
  for (const key of allowed) {
    if (!(key in values)) continue;
    let value = values[key];
    if (key === 'held_on') {
      value = dateText(value, '班会日期');
    } else if (key === 'topic') {
      value = text(value);
      if (!value) throw new EducationError('班会主题不能为空');
    } else if (key === 'format' && !MEETING_FORMATS.has(String(value))) {
      throw new EducationError('班会形式不合法');
    } else if (key === 'status' && !MEETING_STATUSES.has(String(value))) {
      throw new EducationError('班会状态不合法');
    }
    updates.push(`${key}=?`);
    params.push(value);
  }
  const ids = 'student_ids' in values ? studentIds(values.student_ids, { conn }) : null;
  if (updates.length === 0 && ids === null) {
    return decorateMeeting(current, { conn });
  }
  params.push(nowString(), meetingId);
  conn.transaction(() => {
    if (updates.length > 0) {
      conn.prepare('UPDATE meeting_records SET ' + updates.join(',') + ',updated_at=? WHERE id=?')
        .run(...params);
    }
    if (ids !== null) {
      conn.prepare('DELETE FROM meeting_participants WHERE meeting_id=?').run(meetingId);
      const stmt = conn.prepare('INSERT INTO meeting_participants(meeting_id,student_id) VALUES(?,?)');
      for (const studentId of ids) stmt.run(meetingId, studentId);
    }
    audit.record('meeting', meetingId, 'update', {
      summary: '更新班会记录',
      params: { fields: allowed.filter((key) => key in values).sort() },
      conn,
    });
  })();
  return decorateMeeting(meetingRow(meetingId, { conn }), { conn });
}

export function createActivity(options: {
  occurredOn: string; name: string; activityType?: string; budget?: unknown; participantCount?: unknown;
  summary?: string; result?: string; retrospective?: string; status?: string; templateId?: number | null;
  studentIds?: unknown; followupTitle?: string; followupDue?: string; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: true, conn });
  const occurredOn = dateText(options.occurredOn, '活动日期', true);
  const name = text(options.name);
  if (!name) throw new EducationError('活动名称不能为空');
  const activityType = options.activityType ?? '其他';
  const status = options.status ?? '计划中';
  if (!ACTIVITY_TYPES.has(activityType) || !ACTIVITY_STATUSES.has(status)) {
    throw new EducationError('活动类型或状态不合法');
  }
  const ids = studentIds(options.studentIds, { conn });
  let count = intValue(options.participantCount, '参与人数');
  if (ids.length > 0) count = ids.length;
  const activityId = conn.transaction(() => {
    const inserted = conn.prepare(
      `INSERT INTO activity_records(
         class_id,term_id,template_id,occurred_on,name,activity_type,budget,participant_count,
         summary,result,retrospective,status
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      classId, termId, options.templateId ?? null, occurredOn, name, activityType, money(options.budget), count,
      text(options.summary), text(options.result), text(options.retrospective), status,
    );
    const createdId = Number(inserted.lastInsertRowid);
    const participantStmt = conn.prepare('INSERT INTO activity_participants(activity_id,student_id) VALUES(?,?)');
    for (const studentId of ids) participantStmt.run(createdId, studentId);
    if (text(options.followupTitle)) {
      const action = ensureSourceWorkItem({
        title: text(options.followupTitle),
        sourceType: 'activity',
        sourceId: createdId,
        sourceLabel: '班级活动',
        dueAt: text(options.followupDue).slice(0, 30),
        notes: `来源：活动 #${createdId}`,
        conn,
      });
      conn.prepare('UPDATE activity_records SET work_item_id=? WHERE id=?').run(action.id, createdId);
    }
    audit.record('activity', createdId, 'create', {
      summary: `新增活动：${name}`,
      params: { occurred_on: occurredOn, participant_count: count, budget: pyFloatString(money(options.budget)) },
      classId, termId, conn,
    });
    return createdId;
  })();
  return decorateActivity(activityRow(activityId, { conn }), { conn });
}

export function updateActivity(activityId: number, options: {
  values: Record<string, unknown>; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const current = activityRow(activityId, { write: true, conn });
  const values = options.values ?? {};
  const allowed = ['occurred_on', 'name', 'activity_type', 'budget', 'participant_count',
    'summary', 'result', 'retrospective', 'status', 'template_id'];
  const updates: string[] = [];
  const params: unknown[] = [];
  for (const key of allowed) {
    if (!(key in values)) continue;
    let value = values[key];
    if (key === 'occurred_on') {
      value = dateText(value, '活动日期');
    } else if (key === 'name') {
      value = text(value);
      if (!value) throw new EducationError('活动名称不能为空');
    } else if (key === 'activity_type' && !ACTIVITY_TYPES.has(String(value))) {
      throw new EducationError('活动类型不合法');
    } else if (key === 'status' && !ACTIVITY_STATUSES.has(String(value))) {
      throw new EducationError('活动状态不合法');
    } else if (key === 'budget') {
      value = money(value);
    } else if (key === 'participant_count') {
      value = intValue(value, '参与人数');
    }
    updates.push(`${key}=?`);
    params.push(value);
  }
  const ids = 'student_ids' in values ? studentIds(values.student_ids, { conn }) : null;
  if (updates.length === 0 && ids === null) {
    return decorateActivity(current, { conn });
  }
  params.push(nowString(), activityId);
  conn.transaction(() => {
    if (updates.length > 0) {
      conn.prepare('UPDATE activity_records SET ' + updates.join(',') + ',updated_at=? WHERE id=?')
        .run(...params);
    }
    if (ids !== null) {
      conn.prepare('DELETE FROM activity_participants WHERE activity_id=?').run(activityId);
      const stmt = conn.prepare('INSERT INTO activity_participants(activity_id,student_id) VALUES(?,?)');
      for (const studentId of ids) stmt.run(activityId, studentId);
      conn.prepare('UPDATE activity_records SET participant_count=?,updated_at=? WHERE id=?')
        .run(ids.length, nowString(), activityId);
    }
    audit.record('activity', activityId, 'update', {
      summary: '更新活动记录',
      params: { fields: allowed.filter((key) => key in values).sort() },
      conn,
    });
  })();
  return decorateActivity(activityRow(activityId, { conn }), { conn });
}

export function createDiary(options: {
  diaryDate: string; weather?: string; work?: string; event?: string; reflection?: string; todo?: string;
  links?: Array<Record<string, unknown>> | null; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: true, conn });
  const diaryDate = dateText(options.diaryDate, '日志日期', true);
  const links = options.links ?? [];
  const diaryId = conn.transaction(() => {
    const inserted = conn.prepare(
      `INSERT INTO diary_entries(class_id,term_id,diary_date,weather,work,event,reflection,todo)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      classId, termId, diaryDate, text(options.weather), text(options.work), text(options.event),
      text(options.reflection), text(options.todo),
    );
    const createdId = Number(inserted.lastInsertRowid);
    replaceDiaryLinks(createdId, links, { conn });
    audit.record('diary', createdId, 'create', {
      summary: `新增班主任日志：${diaryDate}`,
      params: { link_count: links.length },
      classId, termId, conn,
    });
    return createdId;
  })();
  return listDiary({ conn }).find((item) => Number(item.id) === diaryId) as Record<string, unknown>;
}

export function updateDiary(diaryId: number, options: {
  values: Record<string, unknown>; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: true, conn });
  const values = options.values ?? {};
  const row = conn.prepare(
    "SELECT * FROM diary_entries WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(Number(diaryId), classId, termId);
  if (!row) throw new EducationError('日志记录不存在');
  const fields = ['diary_date', 'weather', 'work', 'event', 'reflection', 'todo'];
  const updates: string[] = [];
  const params: unknown[] = [];
  for (const key of fields) {
    if (!(key in values)) continue;
    const value = key === 'diary_date' ? dateText(values[key], '日志日期') : text(values[key]);
    updates.push(`${key}=?`);
    params.push(value);
  }
  conn.transaction(() => {
    if (updates.length > 0) {
      conn.prepare('UPDATE diary_entries SET ' + updates.join(',') + ',updated_at=? WHERE id=?')
        .run(...params, nowString(), Number(diaryId));
    }
    if ('links' in values) {
      replaceDiaryLinks(Number(diaryId), (values.links as Array<Record<string, unknown>> | null) ?? [], { conn });
    }
    audit.record('diary', diaryId, 'update', {
      summary: '更新班主任日志',
      params: { fields: fields.filter((key) => key in values).sort() },
      conn,
    });
  })();
  return listDiary({ conn }).find((item) => Number(item.id) === diaryId) as Record<string, unknown>;
}

function replaceDiaryLinks(
  diaryId: number, links: Array<Record<string, unknown>>, options: { conn?: Database } = {},
): void {
  const conn = connOf(options.conn);
  conn.prepare('DELETE FROM diary_links WHERE diary_id=?').run(diaryId);
  const [classId, termId] = scope({ write: true, conn });
  const insertStmt = conn.prepare(
    'INSERT OR IGNORE INTO diary_links(diary_id,link_type,link_id,student_id,label) VALUES(?,?,?,?,?)',
  );
  for (const link of links) {
    const linkType = text(link.link_type ?? link.type);
    if (!LINK_TYPES.has(linkType)) throw new EducationError('日志关联类型不合法');
    const linkIdValue = 'link_id' in link ? link.link_id : link.id;
    const studentIdValue = link.student_id;
    let linkId: unknown = linkIdValue;
    let studentId: unknown = studentIdValue;
    if (linkType === 'student') {
      const resolvedStudentId = intValue(studentIdValue || linkIdValue, '学生 ID', 1);
      ensureStudentInScope(resolvedStudentId, { write: true, conn });
      studentId = resolvedStudentId;
      linkId = null;
    } else if (linkType === 'meeting' || linkType === 'activity') {
      linkId = intValue(linkIdValue, '关联记录 ID', 1);
      const table = linkType === 'meeting' ? 'meeting_records' : 'activity_records';
      const found = conn.prepare(
        `SELECT 1 FROM ${table} WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''`,
      ).get(linkId, classId, termId);
      if (!found) throw new EducationError('关联的来源记录不存在');
    } else if (linkType === 'event') {
      linkId = intValue(linkIdValue, '事件 ID', 1);
      const found = conn.prepare(
        "SELECT 1 FROM student_events WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
      ).get(linkId, classId, termId);
      if (!found) throw new EducationError('关联的学生事件不存在');
    } else if (linkType === 'work_item') {
      linkId = intValue(linkIdValue, '工作项 ID', 1);
      const found = conn.prepare(
        "SELECT 1 FROM student_tasks WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
      ).get(linkId, classId, termId);
      if (!found) throw new EducationError('关联的工作项不存在');
    }
    insertStmt.run(diaryId, linkType, linkId ?? null, studentId ?? null, text(link.label));
  }
}

export function deleteRecord(kind: string, recordId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  const objectType = ({ meeting: 'meeting', activity: 'activity', diary: 'diary' } as Record<string, string>)[kind];
  if (!objectType) throw new EducationError('不支持删除该记录');
  return recycle.softDelete(objectType, Number(recordId), { conn: options.conn });
}

export function saveActivityAttachment(activityId: number, options: {
  filename: string; content: Buffer; mimeType?: string; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const activity = activityRow(activityId, { write: true, conn });
  const filename = options.filename;
  const data = Buffer.from(options.content ?? Buffer.alloc(0));
  if (!filename || data.length === 0) throw new EducationError('附件不能为空');
  if (data.length > MAX_ATTACHMENT_BYTES) throw new EducationError('附件不能超过 20MB');
  const baseName = String(filename).replace(/\\/g, '/').split('/').pop() ?? '';
  const safeName = baseName.replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '') || '附件';
  const storedName = `${randomBytes(16).toString('hex')}-${safeName}`;
  const relativePath = ['activity-attachments', String(activity.class_id), String(activity.term_id),
    String(activityId), storedName].join('/');
  const fullPath = safeResolve(getDb().paths.dataDir, relativePath);
  let attachmentId = 0;
  try {
    atomicWrite(fullPath, data);
    const digest = sha256(data);
    conn.transaction(() => {
      const inserted = conn.prepare(
        `INSERT INTO activity_attachments(
           activity_id,original_name,stored_name,relative_path,mime_type,size,sha256
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        Number(activityId), String(filename).slice(0, 255), storedName, relativePath,
        String(options.mimeType ?? '').slice(0, 100), data.length, digest,
      );
      attachmentId = Number(inserted.lastInsertRowid);
      audit.record('activity_attachment', attachmentId, 'create', {
        summary: `上传活动材料：${filename}`,
        params: { activity_id: activityId, size: data.length },
        conn,
      });
    })();
  } catch (error) {
    fs.rmSync(fullPath, { force: true });
    throw error;
  }
  return conn.prepare('SELECT * FROM activity_attachments WHERE id=?').get(attachmentId) as Record<string, unknown>;
}

export function activityAttachmentPath(attachmentId: number, options: { conn?: Database } = {}): string {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const row = conn.prepare(
    `SELECT aa.* FROM activity_attachments aa
     JOIN activity_records a ON a.id=aa.activity_id
     WHERE aa.id=? AND a.class_id=? AND a.term_id=? AND a.deleted_at=''`,
  ).get(Number(attachmentId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new EducationError('活动材料不存在');
  let fullPath: string;
  try {
    fullPath = safeResolve(getDb().paths.dataDir, String(row.relative_path));
  } catch {
    throw new EducationError('活动材料文件不存在，可能需要恢复备份');
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new EducationError('活动材料文件不存在，可能需要恢复备份');
  }
  return fullPath;
}

export function migrateLegacyRows(options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: true, conn });
  const totals: Record<string, unknown> = { imported: 0, skipped: 0, rows: 0, sources: [] };
  const mappings: Record<string, string> = {
    '班会记录': 'meeting', '班级活动': 'activity', '班主任日志': 'diary',
  };
  conn.transaction(() => {
    for (const [sheet, kind] of Object.entries(mappings)) {
      const existingRun = conn.prepare(
        'SELECT * FROM domain4_migration_runs WHERE class_id=? AND term_id=? AND source_sheet=? AND source_version=?',
      ).get(classId, termId, sheet, 'v1');
      if (existingRun) {
        (totals.sources as Array<unknown>).push(existingRun);
        continue;
      }
      const rows = conn.prepare(
        "SELECT row_no, data FROM sheet_rows WHERE sheet=? AND class_id=? AND term_id=? AND deleted_at='' ORDER BY row_no",
      ).all(sheet, classId, termId) as Array<{ row_no: number; data: string }>;
      let imported = 0;
      let skipped = 0;
      for (const row of rows) {
        try {
          const values = JSON.parse(String(row.data)) as unknown;
          if (!Array.isArray(values)) throw new EducationError();
          const key = `legacy:${sheet}:${row.row_no}`;
          const sourceId = String(row.row_no);
          if (kind === 'meeting') {
            conn.prepare(
              `INSERT INTO meeting_records(class_id,term_id,held_on,topic,format,content,participation,conclusion,
                 source_type,source_id,source_key,legacy_row_no,legacy_payload)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            ).run(
              classId, termId, legacyDate(values[0] ?? ''), legacyValue(values, 2, '未命名班会'),
              legacyChoice(values, 3, '主题班会', MEETING_FORMATS), legacyValue(values, 4),
              legacyValue(values, 5), joinNonEmpty(legacyValue(values, 6), legacyValue(values, 7)),
              'legacy_sheet', sourceId, key, row.row_no, String(row.data),
            );
          } else if (kind === 'activity') {
            const count = legacyNumber(values, 3);
            const result = joinNonEmpty(legacyValue(values, 5), legacyValue(values, 6));
            conn.prepare(
              `INSERT INTO activity_records(class_id,term_id,occurred_on,name,activity_type,participant_count,summary,result,
                 source_type,source_id,source_key,legacy_row_no,legacy_payload)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            ).run(
              classId, termId, legacyDate(values[0] ?? ''), legacyValue(values, 1, '未命名活动'),
              legacyChoice(values, 2, '其他', ACTIVITY_TYPES), count, legacyValue(values, 4), result,
              'legacy_sheet', sourceId, key, row.row_no, String(row.data),
            );
          } else {
            conn.prepare(
              `INSERT INTO diary_entries(class_id,term_id,diary_date,weather,work,event,reflection,todo,
                 source_type,source_id,legacy_row_no,legacy_payload)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
            ).run(
              classId, termId, legacyDate(values[0] ?? ''), legacyValue(values, 2),
              legacyValue(values, 3), legacyValue(values, 4), legacyValue(values, 5), legacyValue(values, 6),
              'legacy_sheet', sourceId, row.row_no, String(row.data),
            );
          }
          imported += 1;
        } catch {
          skipped += 1;
        }
      }
      const report = { source_sheet: sheet, rows: rows.length, imported, skipped };
      conn.prepare(
        `INSERT INTO domain4_migration_runs(class_id,term_id,source_sheet,source_rows,imported_entries,skipped_entries,report)
         VALUES(?,?,?,?,?,?,?)`,
      ).run(classId, termId, sheet, rows.length, imported, skipped, JSON.stringify(report));
      totals.rows = Number(totals.rows) + rows.length;
      totals.imported = Number(totals.imported) + imported;
      totals.skipped = Number(totals.skipped) + skipped;
      (totals.sources as Array<unknown>).push(report);
    }
  })();
  return totals;
}

function legacyValue(values: unknown[], index: number, fallback = ''): string {
  if (index >= values.length || values[index] === null || values[index] === undefined || values[index] === '') {
    return fallback;
  }
  return text(values[index]);
}

function legacyChoice(values: unknown[], index: number, fallback: string, choices: Set<string>): string {
  const value = legacyValue(values, index, fallback);
  return choices.has(value) ? value : fallback;
}

function legacyNumber(values: unknown[], index: number): number {
  const parsed = Number.parseFloat(legacyValue(values, index, '0'));
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function legacyDate(value: unknown): string {
  const textValue = text(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(textValue)) return todayString();
  const year = Number(textValue.slice(0, 4));
  const month = Number(textValue.slice(5, 7));
  const day = Number(textValue.slice(8, 10));
  const parsed = new Date(`${textValue}T00:00:00Z`);
  if (isNaN(parsed.getTime())) return todayString();
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return todayString();
  }
  return textValue;
}

function joinNonEmpty(...parts: string[]): string {
  return parts.filter((part) => part !== '').join('；');
}

export function evaluateStartup(options: { conn?: Database } = {}): Record<string, unknown> {
  try {
    return migrateLegacyRows({ conn: options.conn });
  } catch {
    return { ok: false, error: '旧通用表迁移失败' };
  }
}
