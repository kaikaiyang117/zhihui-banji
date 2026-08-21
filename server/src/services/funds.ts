/* 班费分类账、结算、冲正、凭证和旧通用表迁移服务。
 * 提供完整账务生命周期管理。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Database } from 'better-sqlite3';

import { getDb, scopeIds, getCurrentScope } from './context.js';
import * as audit from './audit.js';
import { todayString } from './clock.js';
import { pyRound, formatG } from './scores.js';
import { safeResolve, atomicWrite, sha256, sha256File } from './files.js';

export const DIRECTIONS = new Set(['收入', '支出']);
export const ENTRY_STATUSES = new Set(['有效', '已撤销', '已冲正']);
export const SETTLEMENT_STATUSES = new Set(['已结算', '需复核']);
export const DEFAULT_CATEGORIES: Record<string, string[]> = {
  '收入': ['班费收取', '其他收入'],
  '支出': ['教学材料', '活动费用', '日常支出', '其他支出'],
};
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export class FundError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function money(value: unknown, options: { allowZero?: boolean } = {}): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) return null;
  const result = pyRound(parsed, 2);
  if (!Number.isFinite(result)) return null;
  if (!options.allowZero && result <= 0) return null;
  return Number.isInteger(result) ? result : result;
}

function parseDate(
  value: unknown,
  options: { label?: string; required?: boolean; defaultToday?: boolean } = {},
): string {
  const label = options.label ?? '日期';
  let candidate = text(value).slice(0, 10);
  if (!candidate && options.defaultToday) candidate = todayString();
  if (!candidate && options.required === false) return '';
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(candidate);
  if (!match) throw new FundError(`${label}格式不正确，应为 YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new FundError(`${label}格式不正确，应为 YYYY-MM-DD`);
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function scope(options: { write?: boolean; conn?: Database } = {}): [number, number] {
  return scopeIds({ write: options.write, conn: options.conn });
}

function validateDirection(value: unknown): string {
  const result = text(value);
  if (!DIRECTIONS.has(result)) throw new FundError('收支类型必须是“收入”或“支出”');
  return result;
}

function nowString(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function periodRange(periodKey = '', periodStart = '', periodEnd = ''): [string, string, string] {
  const key = text(periodKey);
  if (key) {
    if (!/^\d{4}-\d{2}$/.test(key)) throw new FundError('结算月份必须是 YYYY-MM');
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(5, 7));
    if (month < 1 || month > 12) throw new FundError('结算月份不合法');
    const start = `${key}-01`;
    const end = `${key}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`;
    return [key, start, end];
  }
  const start = parseDate(periodStart, { label: '结算开始日期' });
  const end = parseDate(periodEnd, { label: '结算结束日期' });
  if (start > end) throw new FundError('结算开始日期不能晚于结束日期');
  return [`${start}_${end}`, start, end];
}

function ensureCategory(name: string, direction: string, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: true, conn });
  const categoryName = text(name) || (direction === '收入' ? '其他收入' : '其他支出');
  const row = conn.prepare(
    'SELECT * FROM fund_categories WHERE class_id=? AND term_id=? AND name=? AND direction=?',
  ).get(classId, termId, categoryName, direction) as Record<string, unknown> | undefined;
  if (row) {
    if (row.deleted_at || !row.enabled) {
      conn.prepare(
        "UPDATE fund_categories SET enabled=1, deleted_at='', deleted_by='', updated_at=datetime('now','localtime') WHERE id=?",
      ).run(Number(row.id));
    }
    return conn.prepare('SELECT * FROM fund_categories WHERE id=?').get(Number(row.id)) as Record<string, unknown>;
  }
  const inserted = conn.prepare(
    'INSERT INTO fund_categories(class_id, term_id, name, direction) VALUES(?,?,?,?)',
  ).run(classId, termId, categoryName, direction);
  const categoryId = Number(inserted.lastInsertRowid);
  return conn.prepare('SELECT * FROM fund_categories WHERE id=?').get(categoryId) as Record<string, unknown>;
}

export function ensureDefaultCategories(options: { conn?: Database } = {}): void {
  const conn = connOf(options.conn);
  for (const [direction, names] of Object.entries(DEFAULT_CATEGORIES)) {
    for (const name of names) {
      ensureCategory(name, direction, { conn });
    }
  }
}

export function listCategories(options: { includeDisabled?: boolean; conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  ensureDefaultCategories({ conn });
  const [classId, termId] = scope({ conn });
  const where = ['class_id=?', 'term_id=?'];
  const params: unknown[] = [classId, termId];
  if (!options.includeDisabled) {
    where.push('enabled=1', "deleted_at=''");
  }
  return conn.prepare(
    'SELECT * FROM fund_categories WHERE ' + where.join(' AND ')
    + ' ORDER BY direction, name, id',
  ).all(...params) as Array<Record<string, unknown>>;
}

export function createCategory(options: {
  name: string; direction: string; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const direction = validateDirection(options.direction);
  const name = text(options.name);
  if (!name) throw new FundError('分类名称不能为空');
  const category = ensureCategory(name, direction, { conn });
  const [classId, termId] = scope({ conn });
  audit.record('fund_category', Number(category.id), 'create', {
    summary: `新增班费分类：${name}`,
    params: { name, direction },
    classId, termId, conn,
  });
  return category;
}

export function updateCategory(categoryId: number, options: {
  name?: string | null; enabled?: boolean | null; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: true, conn });
  const id = Number(categoryId);
  const row = conn.prepare(
    "SELECT * FROM fund_categories WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(id, classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new FundError('班费分类不存在');
  const nextName = options.name !== undefined && options.name !== null ? text(options.name) : String(row.name ?? '');
  if (!nextName) throw new FundError('分类名称不能为空');
  const nextEnabled = options.enabled !== undefined && options.enabled !== null
    ? (options.enabled ? 1 : 0) : Number(row.enabled ?? 0);
  conn.prepare(
    "UPDATE fund_categories SET name=?, enabled=?, updated_at=datetime('now','localtime') WHERE id=?",
  ).run(nextName, nextEnabled, id);
  audit.record('fund_category', categoryId, 'update', {
    summary: `更新班费分类：${nextName}`,
    params: { name: nextName, enabled: Boolean(nextEnabled) },
    classId, termId, conn,
  });
  return conn.prepare('SELECT * FROM fund_categories WHERE id=?').get(id) as Record<string, unknown>;
}

function categoryForEntry(
  categoryId: number | null | undefined,
  categoryName: string,
  direction: string,
  options: { conn?: Database } = {},
): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: true, conn });
  if (categoryId !== undefined && categoryId !== null) {
    const row = conn.prepare(
      `SELECT * FROM fund_categories
       WHERE id=? AND class_id=? AND term_id=? AND enabled=1 AND deleted_at=''`,
    ).get(Number(categoryId), classId, termId) as Record<string, unknown> | undefined;
    if (!row) throw new FundError('班费分类不存在、已停用或类型不匹配');
    if (String(row.direction) !== direction) throw new FundError('收入和支出不能使用相反类型的分类');
    return row;
  }
  return ensureCategory(categoryName, direction, { conn });
}

function entryRow(entryId: number, options: { write?: boolean; conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: options.write, conn });
  const row = conn.prepare(
    `SELECT f.*, COALESCE(c.name, f.category_name) AS category,
              s.period_key AS settlement_period, s.status AS settlement_status
     FROM fund_ledger f
     LEFT JOIN fund_categories c ON c.id=f.category_id
     LEFT JOIN fund_settlements s ON s.id=f.settlement_id
     WHERE f.id=? AND f.class_id=? AND f.term_id=?`,
  ).get(Number(entryId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new FundError('班费流水不存在');
  return row;
}

function serialize(row: Record<string, unknown>, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const scopeQuery = `?class_id=${classId}&term_id=${termId}`;
  const item = { ...row };
  item.amount = money(item.amount, { allowZero: true }) || 0;
  item.category = item.category || item.category_name || '';
  item.source_label = {
    legacy_sheet: '旧版班费工作表', reversal: '冲正流水', manual: '手工记录',
  }[String(item.source_type ?? '')] ?? String(item.source_type ?? '');
  item.attachments = conn.prepare(
    `SELECT id, original_name, content_type, size_bytes, created_at
     FROM fund_attachments WHERE ledger_id=? ORDER BY id`,
  ).all(Number(item.id)) as Array<Record<string, unknown>>;
  for (const attachment of item.attachments as Array<Record<string, unknown>>) {
    attachment.download_path = `/api/fund/attachments/${attachment.id}${scopeQuery}`;
  }
  item.attachment_count = (item.attachments as Array<unknown>).length;
  return item;
}

export function migrateLegacyRows(options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: true, conn });
  const existing = conn.prepare(
    `SELECT * FROM fund_migration_runs
     WHERE class_id=? AND term_id=? AND source_sheet=? AND source_version=?`,
  ).get(classId, termId, '班费管理', 'v1') as Record<string, unknown> | undefined;
  if (existing) {
    const result = { ...existing };
    try {
      result.report = JSON.parse(String(result.report ?? '{}'));
    } catch {
      result.report = {};
    }
    return result;
  }
  return conn.transaction(() => {
    const rows = conn.prepare(
      `SELECT row_no, data FROM sheet_rows
       WHERE sheet=? AND class_id=? AND term_id=? AND deleted_at=''
       ORDER BY row_no`,
    ).all('班费管理', classId, termId) as Array<{ row_no: number; data: string }>;
    let imported = 0;
    let skipped = 0;
    const reasons: Record<string, number> = {};
    const countReason = (reason: string): void => {
      skipped += 1;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    };
    for (const row of rows) {
      let data: unknown[];
      try {
        const parsed = JSON.parse(row.data) as unknown;
        data = Array.isArray(parsed) ? parsed : [];
      } catch {
        data = [];
      }
      const directionText = text(data.length > 1 ? data[1] : '');
      if (!DIRECTIONS.has(directionText)) {
        countReason('收支类型无效');
        continue;
      }
      const amount = money(data.length > 2 ? data[2] : null);
      if (amount === null) {
        countReason('金额无效');
        continue;
      }
      const category = directionText === '收入' ? '历史收入' : '历史支出';
      const categoryRow = ensureCategory(category, directionText, { conn });
      const occurredAt = parseDate(data.length > 0 ? data[0] : '', { required: false });
      const sourceKey = `legacy-sheet:${row.row_no}`;
      const inserted = conn.prepare(
        `INSERT OR IGNORE INTO fund_ledger(
           class_id, term_id, occurred_at, direction, amount,
           category_id, category_name, description, handler, witness, note,
           source_type, source_id, source_key
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        classId, termId, occurredAt, directionText, amount,
        Number(categoryRow.id), category,
        text(data.length > 3 ? data[3] : ''), text(data.length > 4 ? data[4] : ''),
        text(data.length > 5 ? data[5] : ''), text(data.length > 6 ? data[6] : ''),
        'legacy_sheet', String(row.row_no), sourceKey,
      );
      imported += Number(inserted.changes || 0);
    }
    const report = {
      source_rows: rows.length, imported_entries: imported,
      skipped_entries: skipped, skipped_reasons: reasons,
      legacy_sheet_retained: true,
    };
    const runInserted = conn.prepare(
      `INSERT INTO fund_migration_runs(
         class_id, term_id, source_sheet, source_version,
         source_rows, imported_entries, skipped_entries, report
       ) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(classId, termId, '班费管理', 'v1', rows.length, imported, skipped,
      JSON.stringify(report));
    const runId = Number(runInserted.lastInsertRowid);
    audit.record('fund_migration', runId, 'migrate', {
      summary: '迁移旧版班费流水',
      params: report, classId, termId, conn,
    });
    const result = conn.prepare('SELECT * FROM fund_migration_runs WHERE id=?').get(runId) as Record<string, unknown>;
    result.report = report;
    return result;
  })();
}

export function ensureLegacyMigrated(options: { conn?: Database } = {}): Record<string, unknown> | null {
  const conn = connOf(options.conn);
  const scopeInfo = getCurrentScope({ conn });
  if (scopeInfo.class_status === '已归档' || scopeInfo.term_status === '已归档') {
    const row = conn.prepare(
      `SELECT * FROM fund_migration_runs WHERE class_id=? AND term_id=?
       AND source_sheet=? AND source_version=?`,
    ).get(scopeInfo.class_id, scopeInfo.term_id, '班费管理', 'v1') as Record<string, unknown> | undefined;
    return row ? { ...row } : null;
  }
  return migrateLegacyRows({ conn });
}

export function migrationReport(options: { conn?: Database } = {}): Record<string, unknown> | null {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const row = conn.prepare(
    `SELECT * FROM fund_migration_runs WHERE class_id=? AND term_id=?
     AND source_sheet=? AND source_version=?`,
  ).get(classId, termId, '班费管理', 'v1') as Record<string, unknown> | undefined;
  if (!row) return null;
  const item = { ...row };
  try {
    item.report = JSON.parse(String(item.report ?? '{}'));
  } catch {
    item.report = {};
  }
  return item;
}

export interface CreateEntryOptions {
  occurredAt?: string;
  direction?: string;
  amount: unknown;
  categoryId?: number | null;
  category?: string;
  description?: string;
  handler?: string;
  witness?: string;
  note?: string;
  sourceType?: string;
  sourceId?: string;
  sourceKey?: string;
  createdBy?: string;
  conn?: Database;
}

export function createEntry(options: CreateEntryOptions): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: true, conn });
  const direction = validateDirection(options.direction ?? '支出');
  const amount = money(options.amount);
  if (amount === null) throw new FundError('金额必须是大于 0 的数字');
  const occurredAt = parseDate(options.occurredAt ?? '', { defaultToday: true });
  const description = text(options.description ?? '');
  if (!description) throw new FundError('用途说明不能为空');
  const categoryRow = categoryForEntry(
    options.categoryId ?? null, text(options.category ?? ''), direction, { conn });
  const sourceKey = text(options.sourceKey ?? '');
  if (sourceKey && conn.prepare(
    'SELECT 1 FROM fund_ledger WHERE class_id=? AND term_id=? AND source_key=?',
  ).get(classId, termId, sourceKey)) {
    throw new FundError('相同来源的班费流水已经存在');
  }
  let entryId = 0;
  conn.transaction(() => {
    const inserted = conn.prepare(
      `INSERT INTO fund_ledger(
         class_id, term_id, occurred_at, direction, amount,
         category_id, category_name, description, handler, witness, note,
         source_type, source_id, source_key, created_by
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ).get(
      classId, termId, occurredAt, direction, amount, Number(categoryRow.id), String(categoryRow.name),
      description, text(options.handler ?? ''), text(options.witness ?? ''), text(options.note ?? ''),
      text(options.sourceType ?? '') || 'manual', text(options.sourceId ?? ''), sourceKey,
      text(options.createdBy ?? '') || '班主任',
    ) as { id: number };
    entryId = Number(inserted.id);
    audit.record('fund_ledger', entryId, 'create', {
      summary: `新增班费${direction}：${formatG(amount)}`,
      params: { direction, amount, category: String(categoryRow.name),
        description, occurred_at: occurredAt },
      classId, termId, conn,
    });
  })();
  return getEntry(entryId, { conn });
}

export function getEntry(entryId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  return serialize(entryRow(entryId, { conn: options.conn }), options);
}

export interface ListEntriesOptions {
  dateFrom?: string;
  dateTo?: string;
  direction?: string;
  status?: string;
  category?: string;
  limit?: number;
  conn?: Database;
}

export function listEntries(options: ListEntriesOptions = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  ensureLegacyMigrated({ conn });
  const [classId, termId] = scope({ conn });
  const where = ['f.class_id=?', 'f.term_id=?'];
  const params: unknown[] = [classId, termId];
  if (options.dateFrom) {
    where.push("(f.occurred_at>=? AND f.occurred_at<>'')");
    params.push(parseDate(options.dateFrom, { label: '开始日期' }));
  }
  if (options.dateTo) {
    where.push("(f.occurred_at<=? AND f.occurred_at<>'')");
    params.push(parseDate(options.dateTo, { label: '结束日期' }));
  }
  if (options.direction) {
    where.push('f.direction=?');
    params.push(validateDirection(options.direction));
  }
  if (options.status) {
    if (!ENTRY_STATUSES.has(options.status)) throw new FundError('班费流水状态不合法');
    where.push('f.status=?');
    params.push(options.status);
  }
  if (options.category) {
    where.push('COALESCE(c.name, f.category_name)=?');
    params.push(text(options.category));
  }
  params.push(Math.max(1, Math.min(Math.floor(Number(options.limit ?? 500)), 5000)));
  const rows = conn.prepare(
    `SELECT f.*, COALESCE(c.name, f.category_name) AS category,
              s.period_key AS settlement_period, s.status AS settlement_status
     FROM fund_ledger f
     LEFT JOIN fund_categories c ON c.id=f.category_id
     LEFT JOIN fund_settlements s ON s.id=f.settlement_id
     WHERE ${where.join(' AND ')}
     ORDER BY CASE WHEN f.occurred_at='' THEN 1 ELSE 0 END, f.occurred_at DESC, f.id DESC LIMIT ?`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => serialize(row, { conn }));
}

export interface UpdateEntryOptions {
  occurredAt?: string | null;
  direction?: string | null;
  amount?: unknown;
  categoryId?: number | null;
  category?: string | null;
  description?: string | null;
  handler?: string | null;
  witness?: string | null;
  note?: string | null;
  conn?: Database;
}

export function updateEntry(entryId: number, options: UpdateEntryOptions = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const current = entryRow(entryId, { write: true, conn });
  if (String(current.status) !== '有效') throw new FundError('只有有效流水可以修改');
  if (current.settlement_id) throw new FundError('已结算流水不能直接修改，请使用冲正或撤销');
  const nextDirection = options.direction !== undefined && options.direction !== null
    ? validateDirection(options.direction) : String(current.direction ?? '');
  const nextAmount = options.amount !== undefined && options.amount !== null
    ? money(options.amount) : Number(current.amount ?? 0);
  if (nextAmount === null) throw new FundError('金额必须是大于 0 的数字');
  const nextDate = options.occurredAt !== undefined && options.occurredAt !== null
    ? parseDate(options.occurredAt) : String(current.occurred_at ?? '');
  if (!nextDate) throw new FundError('日期不能为空');
  const nextDescription = options.description !== undefined && options.description !== null
    ? text(options.description) : String(current.description ?? '');
  if (!nextDescription) throw new FundError('用途说明不能为空');
  const categoryRow = categoryForEntry(
    options.categoryId !== undefined && options.categoryId !== null ? Number(options.categoryId) : null,
    options.category !== undefined && options.category !== null
      ? text(options.category) : String(current.category ?? ''),
    nextDirection, { conn });
  conn.transaction(() => {
    conn.prepare(
      `UPDATE fund_ledger SET occurred_at=?, direction=?, amount=?, category_id=?, category_name=?,
         description=?, handler=?, witness=?, note=?, updated_at=datetime('now','localtime') WHERE id=?`,
    ).run(
      nextDate, nextDirection, nextAmount, Number(categoryRow.id), String(categoryRow.name), nextDescription,
      options.handler !== undefined && options.handler !== null ? text(options.handler) : String(current.handler ?? ''),
      options.witness !== undefined && options.witness !== null ? text(options.witness) : String(current.witness ?? ''),
      options.note !== undefined && options.note !== null ? text(options.note) : String(current.note ?? ''),
      Number(entryId),
    );
    audit.record('fund_ledger', entryId, 'update', {
      summary: '修改班费流水',
      params: { direction: nextDirection, amount: nextAmount, category: String(categoryRow.name) },
      conn,
    });
  })();
  return getEntry(entryId, { conn });
}

export function revokeEntry(entryId: number, reason: string, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const reasonText = text(reason);
  if (!reasonText) throw new FundError('撤销原因不能为空');
  const current = entryRow(entryId, { write: true, conn });
  if (String(current.status) !== '有效') throw new FundError('只有有效流水可以撤销');
  const now = nowString();
  conn.transaction(() => {
    conn.prepare(
      "UPDATE fund_ledger SET status='已撤销', reversed_at=?, reversal_reason=?, updated_at=datetime('now','localtime') WHERE id=?",
    ).run(now, reasonText, Number(entryId));
    audit.record('fund_ledger', entryId, 'revoke', {
      summary: '撤销班费流水',
      params: { reason: reasonText, settlement_period: String(current.settlement_period ?? '') },
      conn,
    });
  })();
  return getEntry(entryId, { conn });
}

export function reverseEntry(entryId: number, reason: string, options: {
  occurredAt?: string; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const reasonText = text(reason);
  if (!reasonText) throw new FundError('冲正原因不能为空');
  const current = entryRow(entryId, { write: true, conn });
  if (String(current.status) !== '有效') throw new FundError('只有有效流水可以冲正');
  if (!current.settlement_id) throw new FundError('未结算流水可直接修改或撤销，只有已结算流水需要冲正');
  const reverseDirection = String(current.direction) === '收入' ? '支出' : '收入';
  const reverseDate = parseDate(options.occurredAt ?? '', { defaultToday: true });
  const [classId, termId] = scope({ write: true, conn });
  const reversalCategory = ensureCategory(
    String(current.category ?? current.category_name ?? ''), reverseDirection, { conn });
  const sourceKey = `reversal:${entryId}`;
  let reversalId = 0;
  conn.transaction(() => {
    const inserted = conn.prepare(
      `INSERT INTO fund_ledger(
         class_id, term_id, occurred_at, direction, amount,
         category_id, category_name, description, handler, witness, note,
         status, reversal_reason, reversal_of_id, source_type, source_id, source_key
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ).get(
      classId, termId, reverseDate, reverseDirection, Number(current.amount), Number(reversalCategory.id),
      String(reversalCategory.name), `冲正：${String(current.description ?? '')}`,
      String(current.handler ?? ''), String(current.witness ?? ''),
      reasonText, '有效', reasonText, Number(entryId), 'reversal', String(entryId), sourceKey,
    ) as { id: number };
    reversalId = Number(inserted.id);
    const now = nowString();
    conn.prepare(
      "UPDATE fund_ledger SET status='已冲正', reversed_at=?, reversal_reason=?, updated_at=datetime('now','localtime') WHERE id=?",
    ).run(now, reasonText, Number(entryId));
    audit.record('fund_ledger', reversalId, 'reverse', {
      summary: '冲正已结算班费流水',
      params: { original_id: entryId, reason: reasonText, amount: Number(current.amount) },
      classId, termId, conn,
    });
  })();
  return getEntry(reversalId, { conn });
}

function totals(options: { before?: string; start?: string; end?: string; conn?: Database } = {}): Record<string, number> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const where = ["class_id=?", "term_id=?", "status IN ('有效','已冲正')"];
  const params: unknown[] = [classId, termId];
  if (options.before) {
    where.push("occurred_at<>''", 'occurred_at<?');
    params.push(options.before);
  }
  if (options.start) {
    where.push("occurred_at<>''", 'occurred_at>=?');
    params.push(options.start);
  }
  if (options.end) {
    where.push("occurred_at<>''", 'occurred_at<=?');
    params.push(options.end);
  }
  const rows = conn.prepare(
    `SELECT direction, COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
     FROM fund_ledger WHERE ${where.join(' AND ')} GROUP BY direction`,
  ).all(...params) as Array<{ direction: string; total: number; count: number }>;
  const values: Record<string, number> = { '收入': 0, '支出': 0, count: 0 };
  for (const row of rows) {
    values[row.direction] = pyRound(Number(row.total ?? 0), 2);
    values.count += Number(row.count ?? 0);
  }
  values.balance = pyRound(values['收入'] - values['支出'], 2);
  return values;
}

function monthRows(options: { conn?: Database } = {}): Array<Record<string, number | string>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const rows = conn.prepare(
    `SELECT substr(occurred_at,1,7) AS month, direction,
              ROUND(SUM(amount),2) AS total, COUNT(*) AS count
     FROM fund_ledger
     WHERE class_id=? AND term_id=? AND status IN ('有效','已冲正') AND occurred_at<>''
     GROUP BY month, direction ORDER BY month DESC`,
  ).all(classId, termId) as Array<{ month: string; direction: string; total: number; count: number }>;
  const buckets: Record<string, Record<string, number | string>> = {};
  const order: string[] = [];
  for (const row of rows) {
    if (!buckets[row.month]) {
      buckets[row.month] = { month: row.month, income: 0, expense: 0, count: 0 };
      order.push(row.month);
    }
    const item = buckets[row.month];
    if (row.direction === '收入') item.income = Number(row.total ?? 0);
    else item.expense = Number(row.total ?? 0);
    item.count = Number(item.count) + Number(row.count ?? 0);
  }
  for (const month of order) {
    const item = buckets[month];
    item.balance = pyRound(Number(item.income) - Number(item.expense), 2);
  }
  return order.map((month) => buckets[month]);
}

export function listSettlements(options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const result: Array<Record<string, unknown>> = [];
  const rows = conn.prepare(
    'SELECT * FROM fund_settlements WHERE class_id=? AND term_id=? ORDER BY period_start DESC, id DESC',
  ).all(classId, termId) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const item = { ...row };
    const actual = totals({ end: String(item.period_end ?? ''), conn });
    item.actual_closing_balance = actual.balance;
    item.drift = pyRound(Number(actual.balance) - Number(item.closing_balance ?? 0), 2);
    if (String(item.status) === '已结算' && Math.abs(Number(item.drift)) > 0.005) {
      item.status_display = '需复核';
    } else {
      item.status_display = String(item.status ?? '');
    }
    result.push(item);
  }
  return result;
}

export interface CreateSettlementOptions {
  periodKey?: string;
  periodStart?: string;
  periodEnd?: string;
  countedBalance?: unknown;
  note?: string;
  conn?: Database;
}

export function createSettlement(options: CreateSettlementOptions = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ write: true, conn });
  const [key, start, end] = periodRange(options.periodKey ?? '', options.periodStart ?? '', options.periodEnd ?? '');
  if (conn.prepare(
    'SELECT 1 FROM fund_settlements WHERE class_id=? AND term_id=? AND period_key=?',
  ).get(classId, termId, key)) {
    throw new FundError('该期间已经结算，请在原结算记录上复核');
  }
  const opening = totals({ before: start, conn });
  const current = totals({ start, end, conn });
  const closing = pyRound(Number(opening.balance) + Number(current.balance), 2);
  const counted = options.countedBalance !== undefined && options.countedBalance !== null
    ? money(options.countedBalance, { allowZero: true }) : closing;
  if (counted === null) throw new FundError('盘点余额必须是数字');
  const difference = pyRound(counted - closing, 2);
  const status = Math.abs(difference) <= 0.005 ? '已结算' : '需复核';
  const now = nowString();
  let settlementId = 0;
  conn.transaction(() => {
    const inserted = conn.prepare(
      `INSERT INTO fund_settlements(
         class_id, term_id, period_key, period_start, period_end,
         opening_balance, income_total, expense_total, closing_balance,
         counted_balance, difference, status, note, settled_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ).get(
      classId, termId, key, start, end, opening.balance, current['收入'], current['支出'],
      closing, counted, difference, status, text(options.note ?? ''), now,
    ) as { id: number };
    settlementId = Number(inserted.id);
    conn.prepare(
      `UPDATE fund_ledger SET settlement_id=?, updated_at=datetime('now','localtime')
       WHERE class_id=? AND term_id=? AND status='有效' AND occurred_at>=? AND occurred_at<=?
         AND settlement_id IS NULL`,
    ).run(settlementId, classId, termId, start, end);
    audit.record('fund_settlement', settlementId, 'create', {
      summary: `结算班费：${key}`,
      params: { period_start: start, period_end: end, closing_balance: closing,
        counted_balance: counted, difference },
      classId, termId, conn,
    });
  })();
  return getSettlement(settlementId, { conn });
}

export function getSettlement(settlementId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const row = conn.prepare(
    'SELECT * FROM fund_settlements WHERE id=? AND class_id=? AND term_id=?',
  ).get(Number(settlementId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new FundError('班费结算记录不存在');
  const item = { ...row };
  const actual = totals({ end: String(item.period_end ?? ''), conn });
  item.actual_closing_balance = actual.balance;
  item.drift = pyRound(Number(actual.balance) - Number(item.closing_balance ?? 0), 2);
  item.status_display = Math.abs(Number(item.drift)) > 0.005 ? '需复核' : String(item.status ?? '');
  return item;
}

export function reconcileSettlement(settlementId: number, options: {
  countedBalance?: unknown; note?: string | null; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const current = getSettlement(settlementId, { conn });
  const counted = options.countedBalance !== undefined && options.countedBalance !== null
    ? money(options.countedBalance, { allowZero: true }) : Number(current.counted_balance ?? 0);
  if (counted === null) throw new FundError('盘点余额必须是数字');
  const actual = totals({ end: String(current.period_end ?? ''), conn });
  const difference = pyRound(counted - Number(actual.balance), 2);
  const status = Math.abs(difference) <= 0.005 ? '已结算' : '需复核';
  conn.transaction(() => {
    conn.prepare(
      "UPDATE fund_settlements SET counted_balance=?, difference=?, status=?, note=?, updated_at=datetime('now','localtime') WHERE id=?",
    ).run(
      counted, difference, status,
      options.note !== undefined && options.note !== null ? text(options.note) : String(current.note ?? ''),
      Number(settlementId),
    );
    audit.record('fund_settlement', settlementId, 'reconcile', {
      summary: '复核班费结算',
      params: { counted_balance: counted, difference, status },
      conn,
    });
  })();
  return getSettlement(settlementId, { conn });
}

export function classSummary(options: {
  referenceDate?: string | null; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  ensureLegacyMigrated({ conn });
  const overall = totals({ conn });
  const current = options.referenceDate
    ? parseDate(options.referenceDate, { label: '参考日期', defaultToday: true }) : todayString();
  const periodStart = `${current.slice(0, 7)}-01`;
  const month = totals({ start: periodStart, end: current, conn });
  const entries = listEntries({ limit: 300, conn });
  return {
    totals: overall,
    current_period: { month: current.slice(0, 7), ...month },
    monthly: monthRows({ conn }),
    categories: categoryTotals({ conn }),
    settlements: listSettlements({ conn }),
    migration: migrationReport({ conn }),
    entries,
    categories_config: listCategories({ conn }),
  };
}

function categoryTotals(options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  return conn.prepare(
    `SELECT COALESCE(c.name, f.category_name) AS category, f.direction,
              ROUND(SUM(f.amount),2) AS total, COUNT(*) AS count
     FROM fund_ledger f LEFT JOIN fund_categories c ON c.id=f.category_id
     WHERE f.class_id=? AND f.term_id=? AND f.status IN ('有效','已冲正')
     GROUP BY category, f.direction ORDER BY f.direction, total DESC`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
}

export function evaluateStartup(options: { conn?: Database } = {}): Record<string, unknown> | null {
  return ensureLegacyMigrated(options);
}

function basename(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? '';
}

function pathSuffix(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot).slice(0, 12);
}

export interface SaveAttachmentOptions {
  filename: string;
  contentType: string;
  content: Buffer;
  conn?: Database;
}

export function saveAttachment(ledgerId: number, options: SaveAttachmentOptions): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const entry = entryRow(ledgerId, { write: true, conn });
  if (String(entry.status) !== '有效') throw new FundError('已撤销或已冲正流水不能上传凭证');
  const data = Buffer.from(options.content ?? Buffer.alloc(0));
  if (data.length === 0) throw new FundError('凭证不能为空');
  if (data.length > MAX_ATTACHMENT_BYTES) throw new FundError('凭证不能超过 10MB');
  const originalName = basename(text(options.filename) || '班费凭证').slice(0, 160);
  const suffix = pathSuffix(originalName);
  const storedName = `${randomBytes(16).toString('hex')}${suffix}`;
  const relativePath = ['attachments', 'fund', String(ledgerId), storedName].join('/');
  let target: string;
  try {
    target = safeResolve(getDb().paths.dataDir, relativePath);
  } catch {
    throw new FundError('凭证路径不合法');
  }
  let attachmentId = 0;
  try {
    atomicWrite(target, data);
    const digest = sha256(data);
    conn.transaction(() => {
      const inserted = conn.prepare(
        `INSERT INTO fund_attachments(
           ledger_id, original_name, stored_name, relative_path,
           content_type, size_bytes, sha256
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        Number(ledgerId), originalName, storedName, relativePath,
        text(options.contentType) || 'application/octet-stream', data.length, digest,
      );
      attachmentId = Number(inserted.lastInsertRowid);
      audit.record('fund_attachment', attachmentId, 'create', {
        summary: `上传班费凭证：${originalName}`,
        params: { ledger_id: Number(ledgerId), size_bytes: data.length },
        conn,
      });
    })();
  } catch (error) {
    fs.rmSync(target, { force: true });
    throw error;
  }
  return {
    id: attachmentId, ledger_id: Number(ledgerId), original_name: originalName,
    content_type: text(options.contentType) || 'application/octet-stream',
    size_bytes: data.length,
    download_path: `/api/fund/attachments/${attachmentId}?class_id=${classId}&term_id=${termId}`,
  };
}

export function attachmentFile(attachmentId: number, options: { conn?: Database } = {}): {
  attachment: Record<string, unknown>; path: string;
} {
  const conn = connOf(options.conn);
  const [classId, termId] = scope({ conn });
  const row = conn.prepare(
    `SELECT a.* FROM fund_attachments a JOIN fund_ledger f ON f.id=a.ledger_id
     WHERE a.id=? AND f.class_id=? AND f.term_id=?`,
  ).get(Number(attachmentId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new FundError('班费凭证不存在');
  let path: string;
  try {
    path = safeResolve(getDb().paths.dataDir, String(row.relative_path));
  } catch {
    throw new FundError('班费凭证文件不存在');
  }
  if (!fs.existsSync(path) || !fs.statSync(path).isFile()) {
    throw new FundError('班费凭证文件不存在');
  }
  const expectedHash = String(row.sha256 ?? '').toLowerCase();
  if (expectedHash && sha256File(path) !== expectedHash) {
    throw new FundError('凭证完整性校验失败');
  }
  return { attachment: row, path };
}

export function exportRows(options: { conn?: Database } = {}): Array<Array<unknown>> {
  const entries = listEntries({ limit: 5000, conn: options.conn });
  return entries.map((item) => [
    item.occurred_at ?? '', item.direction ?? '', item.amount ?? 0,
    item.category ?? '', item.description ?? '', item.handler ?? '',
    item.witness ?? '', item.note ?? '', item.status ?? '',
    item.settlement_period ?? '', item.reversal_reason ?? '',
    item.source_label ?? '', item.attachment_count ?? 0,
  ]);
}
