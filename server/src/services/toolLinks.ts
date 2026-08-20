import type { Database } from 'better-sqlite3';

import { getDb } from './context.js';
import * as audit from './audit.js';

export class ToolLinkError extends Error {}

export const CATEGORIES = ['教务系统', '教学平台', '备课资源', '班级沟通', '学校服务', '其他'];
export const ALLOWED_PROTOCOLS = ['http://', 'https://'];

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function validateUrl(url: string): void {
  if (!url) throw new ToolLinkError('URL 不能为空');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ToolLinkError('URL 格式不正确'); }
  if (!['http:', 'https:'].includes(parsed.protocol.toLowerCase())) {
    throw new ToolLinkError('URL 必须以 http:// 或 https:// 开头');
  }
  if (!parsed.hostname) throw new ToolLinkError('URL 必须包含域名');
  if (parsed.username || parsed.password) throw new ToolLinkError('URL 不允许包含账号或密码');
}

function ensureUniqueName(name: string, conn: Database, excludeId?: number): void {
  const row = conn.prepare(
    "SELECT id FROM tool_links WHERE name=? AND deleted_at='' AND (? IS NULL OR id<>?) LIMIT 1",
  ).get(name, excludeId ?? null, excludeId ?? null) as { id: number } | undefined;
  if (row) throw new ToolLinkError('同名工作入口已存在');
}

export function listToolLinks(options?: { search?: string; category?: string; conn?: Database }): Array<Record<string, unknown>> {
  const conn = connOf(options?.conn);
  const clauses = ["deleted_at = ''"];
  const params: unknown[] = [];
  if (options?.category) {
    clauses.push('category = ?');
    params.push(options.category);
  }
  if (options?.search) {
    clauses.push('(name LIKE ? OR url LIKE ?)');
    const pattern = `%${options.search}%`;
    params.push(pattern, pattern);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = conn.prepare(
    `SELECT * FROM tool_links ${where} ORDER BY pinned DESC, sort_order, id`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows;
}

export function getToolLink(id: number, conn?: Database): Record<string, unknown> {
  const row = connOf(conn).prepare(
    "SELECT * FROM tool_links WHERE id = ? AND deleted_at = ''",
  ).get(id) as Record<string, unknown> | undefined;
  if (!row) throw new ToolLinkError('工作入口不存在');
  return row;
}

export function createToolLink(options: {
  name: string;
  url: string;
  category?: string;
  icon?: string;
  color?: string;
  sortOrder?: number;
  pinned?: boolean;
  conn?: Database;
}): Record<string, unknown> {
  validateUrl(options.url);
  const name = options.name.trim();
  if (!name) throw new ToolLinkError('名称不能为空');
  const category = options.category && CATEGORIES.includes(options.category) ? options.category : CATEGORIES[0];
  const conn = connOf(options.conn);
  ensureUniqueName(name, conn);
  const result = conn.prepare(
    `INSERT INTO tool_links (name, url, category, icon, color, sort_order, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    name,
    options.url.trim(),
    category,
    options.icon ?? '',
    options.color ?? '',
    options.sortOrder ?? 0,
    options.pinned ? 1 : 0,
  );
  const created = getToolLink(Number(result.lastInsertRowid), conn);
  audit.record('tool_link', Number(result.lastInsertRowid), 'create', {
    summary: `创建工作入口：${name}`, params: { name, url: options.url, category }, conn,
  });
  return created;
}

export function updateToolLink(id: number, options: {
  name?: string;
  url?: string;
  category?: string;
  icon?: string;
  color?: string;
  sortOrder?: number;
  pinned?: boolean;
  conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const existing = getToolLink(id, conn);
  if (existing.deleted_at) throw new ToolLinkError('工作入口已删除');
  if (options.url !== undefined) validateUrl(options.url);
  if (options.name !== undefined && !options.name.trim()) throw new ToolLinkError('名称不能为空');
  if (options.name !== undefined) ensureUniqueName(options.name.trim(), conn, id);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (options.name !== undefined) { sets.push('name = ?'); params.push(options.name.trim()); }
  if (options.url !== undefined) { sets.push('url = ?'); params.push(options.url.trim()); }
  if (options.category !== undefined) {
    sets.push('category = ?');
    params.push(CATEGORIES.includes(options.category) ? options.category : CATEGORIES[0]);
  }
  if (options.icon !== undefined) { sets.push('icon = ?'); params.push(options.icon); }
  if (options.color !== undefined) { sets.push('color = ?'); params.push(options.color); }
  if (options.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(options.sortOrder); }
  if (options.pinned !== undefined) { sets.push('pinned = ?'); params.push(options.pinned ? 1 : 0); }
  if (sets.length === 0) return existing;
  sets.push("updated_at = datetime('now','localtime')");
  params.push(id);
  conn.prepare(`UPDATE tool_links SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const updated = getToolLink(id, conn);
  audit.record('tool_link', id, 'update', {
    summary: `更新工作入口：${String(updated.name ?? '')}`, params: options, conn,
  });
  return updated;
}

export function deleteToolLink(id: number, conn?: Database): void {
  const c = connOf(conn);
  const existing = getToolLink(id, c);
  if (existing.deleted_at) throw new ToolLinkError('工作入口已删除');
  c.prepare(
    "UPDATE tool_links SET deleted_at = datetime('now','localtime'), deleted_by = '' WHERE id = ?",
  ).run(id);
  audit.record('tool_link', id, 'delete', {
    summary: `删除工作入口：${String(existing.name ?? '')}`, params: { name: existing.name }, conn: c,
  });
}

export function recordToolLinkUsage(id: number, conn?: Database): void {
  connOf(conn).prepare(
    "UPDATE tool_links SET last_used_at = datetime('now','localtime') WHERE id = ? AND deleted_at = ''",
  ).run(id);
}
