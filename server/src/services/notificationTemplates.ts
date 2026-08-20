import type { Database } from 'better-sqlite3';

import { getDb, getCurrentScope, scopeIds } from './context.js';
import * as audit from './audit.js';

export class NotificationTemplateError extends Error {}

export const SCENES = ['放假通知', '安全提醒', '调课通知', '班级活动', '材料收集'];

export interface TemplateVariable {
  name: string;
  label: string;
  required: boolean;
  format: string;
  default_value: string;
}

const SYSTEM_TEMPLATES: Array<{ name: string; scene: string; content: string; variables: TemplateVariable[] }> = [
  {
    name: '放假/返校通知',
    scene: '放假通知',
    content: `各位家长：\n根据学校安排，{holiday_start}至{holiday_end}放假，{return_date}正常返校上课。请督促孩子合理安排假期时间，注意安全。\n\n{class_name}班主任`,
    variables: [
      { name: 'holiday_start', label: '放假开始日期', required: true, format: 'date', default_value: '' },
      { name: 'holiday_end', label: '放假结束日期', required: true, format: 'date', default_value: '' },
      { name: 'return_date', label: '返校日期', required: true, format: 'date', default_value: '' },
      { name: 'class_name', label: '班级名称', required: false, format: 'class_name', default_value: '' },
    ],
  },
  {
    name: '安全提醒',
    scene: '安全提醒',
    content: `各位家长：\n{reminder_content}\n请家长关注孩子安全，做好防护。\n\n{class_name}班主任`,
    variables: [
      { name: 'reminder_content', label: '提醒内容', required: true, format: 'text', default_value: '' },
      { name: 'class_name', label: '班级名称', required: false, format: 'class_name', default_value: '' },
    ],
  },
  {
    name: '调课/考试安排通知',
    scene: '调课通知',
    content: `各位家长：\n{arrangement_content}\n请家长留意时间安排，提醒孩子做好准备。\n\n{class_name}班主任`,
    variables: [
      { name: 'arrangement_content', label: '安排内容', required: true, format: 'text', default_value: '' },
      { name: 'class_name', label: '班级名称', required: false, format: 'class_name', default_value: '' },
    ],
  },
  {
    name: '班级活动/研学通知',
    scene: '班级活动',
    content: `各位家长：\n{activity_name}将于{activity_date}举行，{activity_details}。请孩子按时参加，如有特殊情况请提前告知。\n\n{class_name}班主任`,
    variables: [
      { name: 'activity_name', label: '活动名称', required: true, format: 'text', default_value: '' },
      { name: 'activity_date', label: '活动日期', required: true, format: 'date', default_value: '' },
      { name: 'activity_details', label: '活动详情', required: false, format: 'text', default_value: '' },
      { name: 'class_name', label: '班级名称', required: false, format: 'class_name', default_value: '' },
    ],
  },
  {
    name: '材料收集/学习安排提醒',
    scene: '材料收集',
    content: `各位家长：\n{material_name}需在{deadline}前{material_action}。请家长协助孩子完成。\n\n{class_name}班主任`,
    variables: [
      { name: 'material_name', label: '材料名称', required: true, format: 'text', default_value: '' },
      { name: 'deadline', label: '截止日期', required: true, format: 'date', default_value: '' },
      { name: 'material_action', label: '要求动作', required: false, format: 'text', default_value: '提交' },
      { name: 'class_name', label: '班级名称', required: false, format: 'class_name', default_value: '' },
    ],
  },
];

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function rowById(id: number, options?: { conn?: Database; includeDeleted?: boolean }): Record<string, unknown> | undefined {
  const conn = connOf(options?.conn);
  const [classId, termId] = scopeIds({ conn });
  const deletedClause = options?.includeDeleted ? '' : " AND deleted_at=''";
  return conn.prepare(
    `SELECT * FROM notification_templates
     WHERE id=? AND class_id=? AND term_id=?${deletedClause}`,
  ).get(id, classId, termId) as Record<string, unknown> | undefined;
}

function rowByIdOrFail(id: number, options?: { conn?: Database; includeDeleted?: boolean }): Record<string, unknown> {
  const row = rowById(id, options);
  if (!row) throw new NotificationTemplateError('模板不存在');
  return row;
}

function serialize(row: Record<string, unknown>): Record<string, unknown> {
  const item = { ...row };
  try {
    item.variables = JSON.parse(String(row.variables_json || '[]'));
  } catch {
    item.variables = [];
  }
  item.is_system = Number(row.is_system) === 1;
  item.is_owner_saved = Number(row.is_owner_saved) === 1;
  item.enabled = Number(row.enabled) === 1;
  return item;
}

function classNameFromScope(): string {
  try {
    const scope = getCurrentScope();
    return String(scope.class_name ?? '');
  } catch {
    return '';
  }
}

export function ensureSystemTemplates(options?: { conn?: Database }): void {
  const conn = connOf(options?.conn);
  const [classId, termId] = scopeIds({ write: true, conn });
  for (const tpl of SYSTEM_TEMPLATES) {
    const existing = conn.prepare(
      "SELECT id FROM notification_templates WHERE class_id=? AND term_id=? AND name=? AND is_system=1 AND deleted_at=''",
    ).get(classId, termId, tpl.name) as { id: number } | undefined;
    if (existing) continue;
    conn.prepare(
      `INSERT INTO notification_templates (class_id, term_id, name, scene, content, variables_json, is_system)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(classId, termId, tpl.name, tpl.scene, tpl.content, JSON.stringify(tpl.variables));
  }
}

export function listTemplates(options?: { scene?: string; conn?: Database }): Array<Record<string, unknown>> {
  const conn = connOf(options?.conn);
  const [classId, termId] = scopeIds({ conn });
  const params: unknown[] = [classId, termId];
  let sql = `SELECT * FROM notification_templates
             WHERE class_id=? AND term_id=? AND deleted_at='' AND enabled=1`;
  if (options?.scene) {
    if (!SCENES.includes(options.scene)) throw new NotificationTemplateError('场景类型不合法');
    sql += ' AND scene=?';
    params.push(options.scene);
  }
  sql += ' ORDER BY is_system DESC, id';
  return (conn.prepare(sql).all(...params) as Array<Record<string, unknown>>)
    .map(row => serialize(row));
}

export function getTemplate(id: number, options?: { conn?: Database }): Record<string, unknown> {
  return serialize(rowByIdOrFail(id, options));
}

export function generateContent(options: {
  templateId: number;
  variableValues: Record<string, string>;
  conn?: Database;
}): { content: string; missingVariables: string[] } {
  const conn = connOf(options.conn);
  const row = rowByIdOrFail(options.templateId, { conn });
  if (Number(row.is_system) !== 1 && Number(row.is_owner_saved) !== 1) {
    throw new NotificationTemplateError('只能从系统模板或已保存模板生成内容');
  }
  let variables: TemplateVariable[] = [];
  try {
    variables = JSON.parse(String(row.variables_json || '[]'));
  } catch { /* empty */ }
  const values = { ...options.variableValues };
  const className = classNameFromScope();
  const missing: string[] = [];
  for (const v of variables) {
    if (!values[v.name] && v.default_value) values[v.name] = v.default_value;
    if (v.format === 'class_name' && !values[v.name]) {
      values[v.name] = className;
    }
    if (v.required && !values[v.name]) {
      missing.push(v.name);
    }
    if (values[v.name]) {
      const value = String(values[v.name]);
      if (v.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new NotificationTemplateError(`${v.label}必须使用 YYYY-MM-DD 格式`);
      }
      if (v.format === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        throw new NotificationTemplateError(`${v.label}必须使用 HH:mm 格式`);
      }
      if ((v.format === 'text' || v.format === 'class_name') && !value.trim()) {
        throw new NotificationTemplateError(`${v.label}不能为空`);
      }
    }
  }
  let content = String(row.content);
  for (const [key, val] of Object.entries(values)) {
    content = content.replaceAll(`{${key}}`, val);
  }
  return { content, missingVariables: missing };
}

export function savePersonalTemplate(options: {
  baseTemplateId: number;
  name: string;
  content: string;
  variablesJson?: string;
  conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ write: true, conn });
  const base = rowByIdOrFail(options.baseTemplateId, { conn });
  const variablesJson = options.variablesJson ?? String(base.variables_json ?? '[]');
  const templateName = options.name.trim() || String(base.name);
  try {
    const result = conn.prepare(
      `INSERT INTO notification_templates (class_id, term_id, name, scene, content, variables_json, is_system, is_owner_saved)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1)`,
    ).run(classId, termId, templateName, base.scene, options.content, variablesJson);
    const created = serialize(rowByIdOrFail(Number(result.lastInsertRowid), { conn }));
    audit.record('notification_template', Number(result.lastInsertRowid), 'create', {
      summary: `保存通知模板：${templateName}`,
      params: { name: templateName, scene: base.scene }, classId, termId, conn,
    });
    return created;
  } catch (error) {
    const record = error as { code?: string };
    if (record.code?.startsWith('SQLITE_CONSTRAINT')) {
      throw new NotificationTemplateError('同名模板已存在');
    }
    throw error;
  }
}

export function updateTemplate(id: number, options: {
  name?: string;
  content?: string;
  variablesJson?: string;
  enabled?: boolean;
  conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const row = rowByIdOrFail(id, { conn });
  if (Number(row.is_system) === 1) {
    throw new NotificationTemplateError('系统模板不能修改');
  }
  scopeIds({ write: true, conn });
  if (options.name !== undefined) {
    const name = options.name.trim();
    if (!name) throw new NotificationTemplateError('模板名称不能为空');
    const duplicate = conn.prepare(
      "SELECT id FROM notification_templates WHERE class_id=? AND term_id=? AND name=? AND id<>?",
    ).get(row.class_id, row.term_id, name, id) as { id: number } | undefined;
    if (duplicate) throw new NotificationTemplateError('同名模板已存在');
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (options.name !== undefined) { sets.push('name=?'); params.push(options.name.trim()); }
  if (options.content !== undefined) { sets.push('content=?'); params.push(options.content); }
  if (options.variablesJson !== undefined) { sets.push('variables_json=?'); params.push(options.variablesJson); }
  if (options.enabled !== undefined) { sets.push('enabled=?'); params.push(options.enabled ? 1 : 0); }
  if (sets.length === 0) return serialize(row);
  sets.push("updated_at=datetime('now','localtime')");
  params.push(id);
  try {
    conn.prepare(`UPDATE notification_templates SET ${sets.join(', ')} WHERE id=?`).run(...params);
  } catch (error) {
    const record = error as { code?: string };
    if (record.code?.startsWith('SQLITE_CONSTRAINT')) {
      throw new NotificationTemplateError('同名模板已存在');
    }
    throw error;
  }
  const updated = serialize(rowByIdOrFail(id, { conn }));
  const [classId, termId] = scopeIds({ conn });
  audit.record('notification_template', id, 'update', {
    summary: `更新通知模板：${String(updated.name ?? '')}`,
    params: options, classId, termId, conn,
  });
  return updated;
}

export function deleteTemplate(id: number, options?: { conn?: Database }): void {
  const conn = connOf(options?.conn);
  const row = rowByIdOrFail(id, { conn });
  if (Number(row.is_system) === 1) {
    throw new NotificationTemplateError('系统模板不能删除');
  }
  scopeIds({ write: true, conn });
  const [classId, termId] = scopeIds({ conn });
  conn.prepare(
    "UPDATE notification_templates SET deleted_at=datetime('now','localtime'), deleted_by='' WHERE id=?",
  ).run(id);
  audit.record('notification_template', id, 'delete', {
    summary: `删除通知模板：${String(row.name ?? '')}`,
    params: { name: row.name }, classId, termId, conn,
  });
}

export function restoreTemplate(id: number, options?: { conn?: Database }): Record<string, unknown> {
  const conn = connOf(options?.conn);
  const row = rowByIdOrFail(id, { conn, includeDeleted: true });
  if (Number(row.is_system) === 1) {
    throw new NotificationTemplateError('系统模板无需恢复');
  }
  scopeIds({ write: true, conn });
  const [classId, termId] = scopeIds({ conn });
  const systemTpl = SYSTEM_TEMPLATES.find(t => t.scene === row.scene);
  if (!systemTpl) {
    throw new NotificationTemplateError('未找到对应场景的系统模板');
  }
  const systemRow = conn.prepare(
    "SELECT * FROM notification_templates WHERE class_id=? AND term_id=? AND name=? AND is_system=1 AND deleted_at=''",
  ).get(classId, termId, systemTpl.name) as Record<string, unknown> | undefined;
  const content = systemRow ? String(systemRow.content) : systemTpl.content;
  const variablesJson = systemRow ? String(systemRow.variables_json) : JSON.stringify(systemTpl.variables);
  conn.prepare(
    "UPDATE notification_templates SET content=?, variables_json=?, deleted_at='', deleted_by='', updated_at=datetime('now','localtime') WHERE id=?",
  ).run(content, variablesJson, id);
  const restored = serialize(rowByIdOrFail(id, { conn }));
  audit.record('notification_template', id, 'restore', {
    summary: `恢复通知模板：${String(row.name ?? '')}`,
    params: { name: row.name }, classId, termId, conn,
  });
  return restored;
}
