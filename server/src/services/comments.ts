import type { Database } from 'better-sqlite3';

import {
  getDb, scopeIds, getCurrentScope, ensureStudentInScope,
  ScopeError, ArchivedScopeError, type ScopeInfo,
} from './context.js';
import * as audit from './audit.js';
import { STUDENT_COLUMNS } from '../config/sheets.js';
import { getRows } from './sheets.js';

export const COMMENT_TYPES = new Set(['学期评语', '毕业评语', '日常评语']);
export const COMMENT_STATUSES = new Set(['草稿', '待审核', '完成', '已发送']);
export const STATUS_TRANSITIONS: Record<string, Set<string>> = {
  草稿: new Set(['待审核']),
  待审核: new Set(['草稿', '完成']),
  完成: new Set(['待审核', '已发送']),
  已发送: new Set(),
};
export const SUPPORTED_VARIABLES: string[] = [...STUDENT_COLUMNS, '班级', '年级', '学期'];
const VARIABLE_RE = /{{\s*([^{}]+?)\s*}}/g;
const SOURCE_LABELS: Record<string, string> = {
  manual: '手工创建',
  template: '模板生成',
  legacy_sheet: '旧版评语工作表',
  agent: 'Agent 草稿',
  ai: 'AI生成草稿',
};
const LEGACY_STATUS_MAP: Record<string, string> = {
  已完成: '完成',
  完成: '完成',
  已发送: '已发送',
  待审核: '待审核',
};

export class CommentError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function textValue(value: unknown): string {
  return String(value ?? '').trim();
}

function nowString(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function currentActorId(): string {
  return audit.currentActor().actorId;
}

function commentType(value: string): string {
  const text = textValue(value) || '学期评语';
  if (!COMMENT_TYPES.has(text)) throw new CommentError('评语类型不合法');
  return text;
}

function statusValue(value: string): string {
  const text = textValue(value);
  if (!COMMENT_STATUSES.has(text)) throw new CommentError('评语状态不合法');
  return text;
}

function templateRow(templateId: number, options: { write?: boolean; conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ write: options.write, conn });
  const row = conn.prepare(
    "SELECT * FROM comment_templates WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(Number(templateId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new CommentError('评语模板不存在');
  return row;
}

function commentRow(commentId: number, options: { write?: boolean; conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ write: options.write, conn });
  const row = conn.prepare(
    `SELECT c.*, s.学号, s.姓名 AS student_name, t.name AS template_name
     FROM student_comments c JOIN students s ON s.id=c.student_id
     LEFT JOIN comment_templates t ON t.id=c.template_id
     WHERE c.id=? AND c.class_id=? AND c.term_id=? AND c.deleted_at='' AND s.deleted_at=''`,
  ).get(Number(commentId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new CommentError('学生评语不存在');
  return row;
}

function studentRow(studentId: number, options: { write?: boolean; conn?: Database } = {}): Record<string, unknown> {
  try {
    return ensureStudentInScope(Number(studentId), { write: options.write, conn: connOf(options.conn) });
  } catch (error) {
    if (error instanceof ArchivedScopeError) throw error;
    if (error instanceof ScopeError) throw new CommentError((error as Error).message);
    throw error;
  }
}

function activeStudents(options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  return conn.prepare(
    `SELECT s.* FROM students s JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
     ORDER BY s.学号, s.id`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
}

function recordVersion(
  commentId: number, content: string, status: string, changeType: string,
  note = '', options: { conn?: Database } = {},
): void {
  const conn = connOf(options.conn);
  const versionNo = Number((conn.prepare(
    'SELECT COALESCE(MAX(version_no),0)+1 AS n FROM comment_versions WHERE comment_id=?',
  ).get(Number(commentId)) as { n: number }).n);
  conn.prepare(
    `INSERT INTO comment_versions(
       comment_id, version_no, content, status, change_type, note, changed_by
     ) VALUES(?,?,?,?,?,?,?)`,
  ).run(Number(commentId), versionNo, textValue(content), status, changeType, textValue(note), currentActorId());
}

function serialize(row: Record<string, unknown>, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const item = { ...row };
  item.student_name = String(item.student_name || item['姓名'] || '');
  item.template_name = String(item.template_name || '');
  item.is_manually_edited = Boolean(item.is_manually_edited);
  item.version_count = Number((conn.prepare(
    'SELECT COUNT(*) AS count FROM comment_versions WHERE comment_id=?',
  ).get(Number(item.id)) as { count: number }).count);
  const sourceType = String(item.source_type ?? '');
  item.source_label = SOURCE_LABELS[sourceType] ?? sourceType;
  return item;
}

export function extractVariables(content: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of textValue(content).matchAll(VARIABLE_RE)) {
    const item = textValue(match[1] ?? '');
    if (item && !seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

export function variableCatalog(): Array<Record<string, unknown>> {
  return SUPPORTED_VARIABLES.map((item) => ({ name: item, token: `{{${item}}}` }));
}

function renderContent(content: string, student: Record<string, unknown>, scope: ScopeInfo): [string, string[]] {
  const values: Record<string, string> = {};
  for (const key of STUDENT_COLUMNS) values[key] = textValue(student[key]);
  values['班级'] = textValue(scope.class_name);
  values['年级'] = textValue(scope.grade);
  values['学期'] = textValue(scope.term_name);
  const missing: string[] = [];
  const rendered = textValue(content).replace(VARIABLE_RE, (_match, name: string) => {
    const variable = textValue(name);
    const value = values[variable] ?? '';
    if (!value) {
      missing.push(variable);
      return `〔${variable}未填写〕`;
    }
    return value;
  });
  const uniqueMissing: string[] = [];
  for (const item of missing) {
    if (!uniqueMissing.includes(item)) uniqueMissing.push(item);
  }
  return [rendered, uniqueMissing];
}

export function listTemplates(options: { includeDisabled?: boolean; conn?: Database } = {}):
  Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  const where = ['class_id=?', 'term_id=?', "deleted_at=''"];
  const params: unknown[] = [classId, termId];
  if (!options.includeDisabled) where.push('enabled=1');
  const rows = conn.prepare(
    'SELECT * FROM comment_templates WHERE ' + where.join(' AND ')
    + ' ORDER BY enabled DESC, comment_type, name, id',
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ ...row, variables: extractVariables(String(row['content'] ?? '')) }));
}

export function createTemplate(options: {
  name: string; commentType?: string; content: string; enabled?: boolean; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const name = textValue(options.name);
  const content = textValue(options.content);
  if (!name || !content) throw new CommentError('模板名称和内容不能为空');
  const type = commentType(options.commentType ?? '学期评语');
  const unknown = extractVariables(content).filter((item) => !SUPPORTED_VARIABLES.includes(item));
  if (unknown.length > 0) throw new CommentError(`模板含不支持的变量：${unknown.join('、')}`);
  const [classId, termId] = scopeIds({ write: true, conn });
  let templateId: number;
  try {
    templateId = conn.transaction(() => {
      const inserted = conn.prepare(
        'INSERT INTO comment_templates(class_id, term_id, name, comment_type, content, enabled) '
        + 'VALUES(?,?,?,?,?,?) RETURNING id',
      ).get(classId, termId, name, type, content, options.enabled ?? true ? 1 : 0) as { id: number };
      const id = Number(inserted.id);
      audit.record('comment_template', id, 'create', {
        summary: `新增评语模板：${name}`,
        params: { name, comment_type: type, variables: extractVariables(content) },
        classId, termId, conn,
      });
      return id;
    })();
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE constraint failed')) {
      throw new CommentError('当前班级与学期已有同名评语模板');
    }
    throw error;
  }
  return templateRow(templateId, { conn });
}

export function updateTemplate(templateId: number, options: {
  name?: string | null; commentType?: string | null; content?: string | null;
  enabled?: boolean | null; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const current = templateRow(templateId, { write: true, conn });
  const values: Record<string, unknown> = {
    name: options.name !== undefined && options.name !== null ? textValue(options.name) : current['name'],
    comment_type: options.commentType !== undefined && options.commentType !== null
      ? commentType(options.commentType) : current['comment_type'],
    content: options.content !== undefined && options.content !== null
      ? textValue(options.content) : current['content'],
    enabled: options.enabled !== undefined && options.enabled !== null
      ? (options.enabled ? 1 : 0) : Number(current['enabled']),
  };
  if (!textValue(values['name']) || !textValue(values['content'])) {
    throw new CommentError('模板名称和内容不能为空');
  }
  const unknown = extractVariables(String(values['content'])).filter(
    (item) => !SUPPORTED_VARIABLES.includes(item));
  if (unknown.length > 0) throw new CommentError(`模板含不支持的变量：${unknown.join('、')}`);
  try {
    conn.transaction(() => {
      conn.prepare(
        'UPDATE comment_templates SET name=?, comment_type=?, content=?, enabled=?, '
        + "updated_at=datetime('now','localtime') WHERE id=?",
      ).run(values['name'], values['comment_type'], values['content'], values['enabled'], Number(templateId));
      audit.record('comment_template', templateId, 'update', {
        summary: `更新评语模板：${String(values['name'])}`,
        params: values,
        classId: Number(current['class_id']), termId: Number(current['term_id']), conn,
      });
    })();
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE constraint failed')) {
      throw new CommentError('当前班级与学期已有同名评语模板');
    }
    throw error;
  }
  return templateRow(templateId, { conn });
}

export function migrateLegacyRows(options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ write: true, conn });
  const existing = conn.prepare(
    'SELECT * FROM comment_migration_runs WHERE class_id=? AND term_id=? AND source_sheet=? AND source_version=?',
  ).get(classId, termId, '评语管理', 'v1') as Record<string, unknown> | undefined;
  if (existing) {
    const result = { ...existing };
    result.report = JSON.parse(String(result.report ?? '') || '{}');
    return result;
  }
  const rows = getRows('评语管理');
  const students = conn.prepare(
    `SELECT s.id, s.学号, s.姓名 FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND s.deleted_at=''`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const byNumber = new Map<string, Record<string, unknown>>();
  const byName = new Map<string, Array<Record<string, unknown>>>();
  for (const item of students) {
    const number = textValue(item['学号']);
    if (number) byNumber.set(number, item);
    const name = textValue(item['姓名']);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)!.push(item);
  }
  let imported = 0;
  let skipped = 0;
  const reasons: Record<string, number> = {};
  return conn.transaction(() => {
    for (const row of rows) {
      const data = row.data;
      const number = textValue(data.length > 0 ? data[0] : '');
      const name = textValue(data.length > 1 ? data[1] : '');
      let student = byNumber.get(number);
      if (!student && (byName.get(name) ?? []).length === 1) student = byName.get(name)![0];
      const content = textValue(data.length > 3 ? data[3] : '');
      if (!student || !content) {
        const reason = !student ? '学生无法唯一匹配' : '评语内容为空';
        skipped += 1;
        reasons[reason] = (reasons[reason] ?? 0) + 1;
        continue;
      }
      const rawType = textValue(data.length > 2 ? data[2] : '');
      const type = COMMENT_TYPES.has(rawType) ? rawType : '学期评语';
      const rawStatus = textValue(data.length > 4 ? data[4] : '');
      const status = LEGACY_STATUS_MAP[rawStatus] ?? '草稿';
      const sourceKey = `legacy-sheet:${row.row_no}`;
      let commentId: number;
      try {
        commentId = Number((conn.prepare(
          `INSERT INTO student_comments(
             class_id, term_id, student_id, comment_type, content, status,
             source_type, source_id, source_key, is_manually_edited,
             edited_at, edited_by, note
           ) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?) RETURNING id`,
        ).get(
          classId, termId, student['id'], type, content, status,
          'legacy_sheet', String(row.row_no), sourceKey, nowString(), 'legacy-import',
          textValue(data.length > 5 ? data[5] : ''),
        ) as { id: number }).id);
      } catch (error) {
        if (!String((error as Error).message).includes('UNIQUE constraint failed')) throw error;
        skipped += 1;
        reasons['同学生同类型已有评语'] = (reasons['同学生同类型已有评语'] ?? 0) + 1;
        continue;
      }
      recordVersion(commentId, content, status, 'migrate', '', { conn });
      imported += 1;
    }
    const report = {
      source_rows: rows.length,
      imported_entries: imported,
      skipped_entries: skipped,
      skipped_reasons: reasons,
      legacy_sheet_retained: true,
    };
    const runInserted = conn.prepare(
      `INSERT INTO comment_migration_runs(
         class_id, term_id, source_sheet, source_version,
         source_rows, imported_entries, skipped_entries, report
       ) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(classId, termId, '评语管理', 'v1', rows.length, imported, skipped, JSON.stringify(report));
    const runId = Number(runInserted.lastInsertRowid);
    audit.record('comment_migration', runId, 'migrate', {
      summary: '迁移旧版评语', params: report, classId, termId, conn,
    });
    const resultRow = conn.prepare('SELECT * FROM comment_migration_runs WHERE id=?').get(runId) as
      Record<string, unknown>;
    const result = { ...resultRow };
    result.report = report;
    return result;
  })();
}

export function ensureLegacyMigrated(options: { conn?: Database } = {}): Record<string, unknown> | null {
  const conn = connOf(options.conn);
  const scope = getCurrentScope({ conn });
  if (scope.class_status === '已归档' || scope.term_status === '已归档') {
    const row = conn.prepare(
      'SELECT * FROM comment_migration_runs WHERE class_id=? AND term_id=? AND source_sheet=? AND source_version=?',
    ).get(scope.class_id, scope.term_id, '评语管理', 'v1') as Record<string, unknown> | undefined;
    return row ? { ...row } : null;
  }
  return migrateLegacyRows({ conn });
}

export function migrationReport(options: { conn?: Database } = {}): Record<string, unknown> | null {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    'SELECT * FROM comment_migration_runs WHERE class_id=? AND term_id=? AND source_sheet=? AND source_version=?',
  ).get(classId, termId, '评语管理', 'v1') as Record<string, unknown> | undefined;
  if (!row) return null;
  const item = { ...row };
  item.report = JSON.parse(String(item.report ?? '') || '{}');
  return item;
}

export function listComments(options: {
  studentId?: number | null; commentType?: string; status?: string;
  keyword?: string; limit?: number; conn?: Database;
} = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  ensureLegacyMigrated({ conn });
  const [classId, termId] = scopeIds({ conn });
  const where = ["c.class_id=?", "c.term_id=?", "c.deleted_at=''", "s.deleted_at=''"];
  const params: unknown[] = [classId, termId];
  if (options.studentId !== undefined && options.studentId !== null) {
    where.push('c.student_id=?');
    params.push(Number(options.studentId));
  }
  if (options.commentType) {
    where.push('c.comment_type=?');
    params.push(commentType(options.commentType));
  }
  if (options.status) {
    where.push('c.status=?');
    params.push(statusValue(options.status));
  }
  if (options.keyword) {
    where.push('(s.姓名 LIKE ? OR s.学号 LIKE ? OR c.content LIKE ?)');
    const pattern = `%${textValue(options.keyword)}%`;
    params.push(pattern, pattern, pattern);
  }
  params.push(Math.max(1, Math.min(Number(options.limit ?? 500), 5000)));
  const rows = conn.prepare(
    `SELECT c.*, s.学号, s.姓名 AS student_name, t.name AS template_name
     FROM student_comments c JOIN students s ON s.id=c.student_id
     LEFT JOIN comment_templates t ON t.id=c.template_id
     WHERE ` + where.join(' AND ')
    + " ORDER BY CASE c.status WHEN '待审核' THEN 0 WHEN '草稿' THEN 1 WHEN '完成' THEN 2 ELSE 3 END, s.学号, c.id DESC LIMIT ?",
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => serialize(row, { conn }));
}

export function getComment(commentId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  return serialize(commentRow(commentId, { conn }), { conn });
}

export function commentVersions(commentId: number, options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  commentRow(commentId, { conn });
  return conn.prepare(
    'SELECT * FROM comment_versions WHERE comment_id=? ORDER BY version_no DESC',
  ).all(Number(commentId)) as Array<Record<string, unknown>>;
}

export function previewGeneration(options: {
  templateId: number; studentIds?: number[] | null; commentType?: string; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  ensureLegacyMigrated({ conn });
  const template = templateRow(Number(options.templateId), { conn });
  const selectedType = commentType(options.commentType || String(template['comment_type'] ?? ''));
  const scope = getCurrentScope({ conn });
  let students = activeStudents({ conn });
  const requested = new Set((options.studentIds ?? []).map((item) => Number(item)));
  if (requested.size > 0) {
    students = students.filter((item) => requested.has(Number(item['id'])));
    const found = new Set(students.map((item) => Number(item['id'])));
    if (found.size !== requested.size || ![...requested].every((id) => found.has(id))) {
      throw new CommentError('部分学生不在当前班级和学期中');
    }
  }
  if (students.length === 0) throw new CommentError('至少选择一名学生');
  const [classId, termId] = scopeIds({ conn });
  const rows: Array<Record<string, unknown>> = [];
  for (const student of students) {
    const existingRow = conn.prepare(
      `SELECT c.*, s.学号, s.姓名 AS student_name, t.name AS template_name
       FROM student_comments c JOIN students s ON s.id=c.student_id
       LEFT JOIN comment_templates t ON t.id=c.template_id
       WHERE c.class_id=? AND c.term_id=? AND c.student_id=?
         AND c.comment_type=? AND c.deleted_at=''`,
    ).get(classId, termId, student['id'], selectedType) as Record<string, unknown> | undefined;
    const existing = existingRow ? { ...existingRow } : null;
    const protectedRow = Boolean(existing
      && (existing['is_manually_edited'] || String(existing['status']) !== '草稿'));
    const [content, missing] = renderContent(String(template['content'] ?? ''), student, scope);
    rows.push({
      student_id: Number(student['id']),
      学号: student['学号'] || '',
      姓名: student['姓名'] || '',
      content,
      missing_variables: missing,
      has_missing: missing.length > 0,
      existing_id: existing ? Number(existing['id']) : null,
      existing_status: existing ? String(existing['status']) : '',
      is_manually_edited: Boolean(existing && existing['is_manually_edited']),
      protected: protectedRow,
      action: protectedRow ? '跳过受保护内容' : existing ? '更新自动草稿' : '新增草稿',
    });
  }
  return {
    template: { ...template, variables: extractVariables(String(template['content'] ?? '')) },
    comment_type: selectedType,
    rows,
    summary: {
      requested: rows.length,
      creatable: rows.filter((row) => !row['existing_id']).length,
      updatable: rows.filter((row) => Boolean(row['existing_id']) && !row['protected']).length,
      protected: rows.filter((row) => row['protected']).length,
      missing: rows.filter((row) => row['has_missing']).length,
    },
  };
}

export function generateBatch(options: {
  templateId: number; studentIds?: number[] | null; commentType?: string;
  confirmMissing?: boolean; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  scopeIds({ write: true, conn });
  const preview = previewGeneration({
    templateId: options.templateId, studentIds: options.studentIds,
    commentType: options.commentType, conn,
  });
  const previewSummary = preview['summary'] as Record<string, number>;
  if (Number(previewSummary['missing']) > 0 && !options.confirmMissing) {
    throw new CommentError(`有 ${previewSummary['missing']} 名学生存在模板变量缺失，请确认后再生成`);
  }
  const [classId, termId] = scopeIds({ write: true, conn });
  const templateId = Number(options.templateId);
  return conn.transaction(() => {
    const runInserted = conn.prepare(
      `INSERT INTO comment_generation_runs(
         class_id, term_id, template_id, comment_type, requested_count,
         protected_count, missing_count, result_json
       ) VALUES(?,?,?,?,?,?,?,?) RETURNING id`,
    ).get(
      classId, termId, templateId, String(preview['comment_type']),
      previewSummary['requested'], previewSummary['protected'], previewSummary['missing'],
      JSON.stringify(previewSummary),
    ) as { id: number };
    const runId = Number(runInserted.id);
    let created = 0;
    let updated = 0;
    for (const row of preview['rows'] as Array<Record<string, unknown>>) {
      if (row['protected']) continue;
      if (row['existing_id']) {
        conn.prepare(
          `UPDATE student_comments SET template_id=?, generation_run_id=?, content=?,
             source_type='template', source_id=?, is_manually_edited=0,
             updated_at=datetime('now','localtime') WHERE id=?`,
        ).run(templateId, runId, String(row['content']), String(templateId), row['existing_id']);
        recordVersion(Number(row['existing_id']), String(row['content']), '草稿', 'regenerate', '', { conn });
        updated += 1;
      } else {
        const commentId = Number((conn.prepare(
          `INSERT INTO student_comments(
             class_id, term_id, student_id, template_id, generation_run_id,
             comment_type, content, status, source_type, source_id
           ) VALUES(?,?,?,?,?,?,?,'草稿','template',?) RETURNING id`,
        ).get(
          classId, termId, row['student_id'], templateId, runId,
          String(preview['comment_type']), String(row['content']), String(templateId),
        ) as { id: number }).id);
        recordVersion(commentId, String(row['content']), '草稿', 'generate', '', { conn });
        created += 1;
      }
    }
    const result = { ...previewSummary, created, updated, run_id: runId };
    conn.prepare(
      'UPDATE comment_generation_runs SET created_count=?, updated_count=?, result_json=? WHERE id=?',
    ).run(created, updated, JSON.stringify(result), runId);
    audit.record('comment_generation', runId, 'generate', {
      summary: '批量生成学生评语草稿', params: result, classId, termId, conn,
    });
    return result;
  })();
}

export function createComment(options: {
  studentId: number; commentType?: string; content: string;
  note?: string; sourceType?: string; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const content = textValue(options.content);
  if (!content) throw new CommentError('评语内容不能为空');
  const type = commentType(options.commentType ?? '学期评语');
  studentRow(Number(options.studentId), { write: true, conn });
  const [classId, termId] = scopeIds({ write: true, conn });
  const sourceType = textValue(options.sourceType ?? '') === 'agent' ? 'agent' : 'manual';
  const manual = sourceType === 'manual' ? 1 : 0;
  const now = nowString();
  const actor = currentActorId();
  let commentId: number;
  try {
    commentId = conn.transaction(() => {
      const inserted = conn.prepare(
        `INSERT INTO student_comments(
           class_id, term_id, student_id, comment_type, content, status,
           source_type, is_manually_edited, edited_at, edited_by, note
         ) VALUES(?,?,?,?,?,'草稿',?,?,?,?,?) RETURNING id`,
      ).get(
        classId, termId, Number(options.studentId), type, content, sourceType,
        manual, manual ? now : '', manual ? actor : '', textValue(options.note ?? ''),
      ) as { id: number };
      const id = Number(inserted.id);
      recordVersion(id, content, '草稿', 'create', '', { conn });
      audit.record('student_comment', id, 'create', {
        summary: '新增学生评语草稿',
        params: { student_id: options.studentId, comment_type: type, source_type: sourceType },
        classId, termId, conn,
      });
      return id;
    })();
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE constraint failed')) {
      throw new CommentError('该学生在本学期已有同类型评语');
    }
    throw error;
  }
  return getComment(commentId, { conn });
}

export function saveAiDrafts(options: {
  rows: Array<Record<string, unknown>>; commentType?: string; model?: string;
  period?: Record<string, unknown> | null; conn?: Database;
}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const rows = options.rows ?? [];
  if (rows.length === 0) throw new CommentError('没有可保存的 AI 评语');
  const type = commentType(options.commentType ?? '学期评语');
  const [classId, termId] = scopeIds({ write: true, conn });
  const selected = new Set<number>();
  for (const row of rows) {
    if (row['content']) selected.add(Number(row['student_id']));
  }
  const active = new Set(activeStudents({ conn }).map((row) => Number(row['id'])));
  if (selected.size === 0 || ![...selected].every((id) => active.has(id))) {
    throw new CommentError('AI评语中包含无效学生');
  }
  const model = textValue(options.model ?? '');
  const payload = {
    kind: 'ai_comment_generation',
    model,
    period: options.period ?? {},
    rows: rows.filter((row) => row['content']).map((row) => ({
      student_id: Number(row['student_id']),
      content: textValue(row['content']),
      evidence: row['evidence'] ?? [],
      warnings: row['warnings'] ?? [],
    })),
  };
  return conn.transaction(() => {
    const runInserted = conn.prepare(
      `INSERT INTO comment_generation_runs(
         class_id, term_id, template_id, comment_type, requested_count, result_json
       ) VALUES(?,?,NULL,?,?,?) RETURNING id`,
    ).get(classId, termId, type, rows.length, JSON.stringify(payload)) as { id: number };
    const runId = Number(runInserted.id);
    let created = 0;
    let updated = 0;
    let protectedCount = 0;
    for (const row of rows) {
      const content = textValue(row['content']);
      if (!content) continue;
      const studentId = Number(row['student_id']);
      const current = conn.prepare(
        "SELECT * FROM student_comments WHERE class_id=? AND term_id=? AND student_id=? AND comment_type=? AND deleted_at=''",
      ).get(classId, termId, studentId, type) as Record<string, unknown> | undefined;
      if (current) {
        if (String(current['status']) !== '草稿' || Number(current['is_manually_edited'])) {
          protectedCount += 1;
          continue;
        }
        conn.prepare(
          `UPDATE student_comments SET content=?, generation_run_id=?, source_type='ai',
             source_id=?, updated_at=datetime('now','localtime') WHERE id=?`,
        ).run(content, runId, model.slice(0, 120), Number(current['id']));
        recordVersion(Number(current['id']), content, '草稿', 'ai_generate', '', { conn });
        updated += 1;
      } else {
        const commentId = Number((conn.prepare(
          `INSERT INTO student_comments(
             class_id, term_id, student_id, generation_run_id, comment_type, content,
             status, source_type, source_id
           ) VALUES(?,?,?,?,?,?,'草稿','ai',?) RETURNING id`,
        ).get(classId, termId, studentId, runId, type, content, model.slice(0, 120)) as { id: number }).id);
        recordVersion(commentId, content, '草稿', 'ai_generate', '', { conn });
        created += 1;
      }
    }
    const result = {
      run_id: runId, created, updated, protected: protectedCount,
      generated: created + updated, requested: rows.length,
    };
    conn.prepare(
      'UPDATE comment_generation_runs SET created_count=?, updated_count=?, protected_count=? WHERE id=?',
    ).run(created, updated, protectedCount, runId);
    audit.record('comment_generation', runId, 'ai_generate', {
      summary: 'AI生成学生评语草稿',
      params: {
        requested: rows.length, created, updated, protected: protectedCount, model: model.slice(0, 120),
      },
      classId, termId, conn,
    });
    return result;
  })();
}

export function updateComment(commentId: number, options: {
  content?: string | null; note?: string | null; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const current = commentRow(commentId, { write: true, conn });
  if (String(current['status']) !== '草稿') {
    throw new CommentError('只有草稿可以编辑；待审核评语请先退回草稿');
  }
  const nextContent = options.content !== undefined && options.content !== null
    ? textValue(options.content) : String(current['content'] ?? '');
  if (!nextContent) throw new CommentError('评语内容不能为空');
  const nextNote = options.note !== undefined && options.note !== null
    ? textValue(options.note) : String(current['note'] ?? '');
  conn.transaction(() => {
    conn.prepare(
      `UPDATE student_comments SET content=?, note=?, is_manually_edited=1,
         edited_at=?, edited_by=?, updated_at=datetime('now','localtime') WHERE id=?`,
    ).run(nextContent, nextNote, nowString(), currentActorId(), Number(commentId));
    recordVersion(commentId, nextContent, '草稿', 'manual_edit', nextNote, { conn });
    audit.record('student_comment', commentId, 'update', {
      summary: '人工修改学生评语',
      params: { student_id: current['student_id'], comment_type: current['comment_type'] },
      conn,
    });
  })();
  return getComment(commentId, { conn });
}

export function transitionComment(commentId: number, targetStatus: string, options: {
  note?: string; deliveryMethod?: string; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  const current = commentRow(commentId, { write: true, conn });
  const target = statusValue(targetStatus);
  if (!(STATUS_TRANSITIONS[String(current['status'])] ?? new Set()).has(target)) {
    throw new CommentError(`评语不能从“${String(current['status'])}”直接变为“${target}”`);
  }
  conn.transaction(() => {
    const fields = ['status=?', "updated_at=datetime('now','localtime')"];
    const params: unknown[] = [target];
    if (target === '完成') {
      fields.push('reviewed_at=?', 'reviewed_by=?', 'review_note=?');
      params.push(nowString(), currentActorId(), textValue(options.note ?? ''));
    } else if (target === '已发送') {
      const method = textValue(options.deliveryMethod ?? '');
      if (!method) throw new CommentError('标记已发送时必须填写交付方式');
      fields.push('sent_at=?', 'delivery_method=?');
      params.push(nowString(), method);
    } else if (target === '草稿') {
      fields.push("reviewed_at=''", "reviewed_by=''", 'review_note=?');
      params.push(textValue(options.note ?? ''));
    }
    params.push(Number(commentId));
    conn.prepare(`UPDATE student_comments SET ${fields.join(', ')} WHERE id=?`).run(...params);
    recordVersion(commentId, String(current['content'] ?? ''), target, 'status', options.note ?? '', { conn });
    audit.record('student_comment', commentId, 'transition', {
      summary: `评语状态：${String(current['status'])} → ${target}`,
      params: {
        from: current['status'], to: target,
        note: options.note ?? '', delivery_method: options.deliveryMethod ?? '',
      },
      conn,
    });
  })();
  return getComment(commentId, { conn });
}

export function summary(options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = connOf(options.conn);
  ensureLegacyMigrated({ conn });
  const [classId, termId] = scopeIds({ conn });
  const counts: Record<string, number> = {};
  for (const status of COMMENT_STATUSES) counts[status] = 0;
  for (const row of conn.prepare(
    "SELECT status, COUNT(*) AS count FROM student_comments WHERE class_id=? AND term_id=? AND deleted_at='' GROUP BY status",
  ).all(classId, termId) as Array<Record<string, unknown>>) {
    counts[String(row['status'])] = Number(row['count']);
  }
  counts['total'] = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const students = activeStudents({ conn });
  const termCommentCount = Number((conn.prepare(
    "SELECT COUNT(*) AS count FROM student_comments WHERE class_id=? AND term_id=? AND comment_type='学期评语' AND deleted_at=''",
  ).get(classId, termId) as { count: number }).count);
  const generatedStudentIds = (conn.prepare(
    "SELECT DISTINCT student_id FROM student_comments WHERE class_id=? AND term_id=? AND comment_type='学期评语' AND deleted_at=''",
  ).all(classId, termId) as Array<Record<string, unknown>>).map((row) => Number(row['student_id']));
  return {
    counts,
    coverage: {
      student_count: students.length,
      generated_count: termCommentCount,
      missing_count: Math.max(0, students.length - termCommentCount),
      completion_rate: students.length > 0 ? round1((termCommentCount / students.length) * 100) : 0,
      generated_student_ids: generatedStudentIds,
    },
    templates: listTemplates({ conn }),
    migration: migrationReport({ conn }),
    variables: variableCatalog(),
    students: students.map((item) => ({
      id: Number(item['id']), 学号: item['学号'] || '', 姓名: item['姓名'] || '',
    })),
  };
}

export function studentCommentSummary(studentId: number, options: { conn?: Database } = {}):
  Record<string, unknown> {
  const conn = connOf(options.conn);
  studentRow(studentId, { conn });
  const rows = listComments({ studentId, limit: 100, conn });
  let latest: Record<string, unknown> | null = null;
  for (const item of rows) {
    const key = String(item['updated_at'] || item['created_at'] || '');
    if (latest === null) {
      latest = item;
      continue;
    }
    const bestKey = String(latest['updated_at'] || latest['created_at'] || '');
    if (key > bestKey || (key === bestKey && Number(item['id']) > Number(latest['id']))) {
      latest = item;
    }
  }
  return { comments: rows, latest };
}

export function evaluateStartup(options: { conn?: Database } = {}): Record<string, unknown> | null {
  return ensureLegacyMigrated(options);
}

export function exportRows(options: {
  status?: string; commentType?: string; conn?: Database;
} = {}): Array<Array<unknown>> {
  const conn = connOf(options.conn);
  const rows = listComments({ status: options.status ?? '', commentType: options.commentType ?? '', limit: 5000, conn });
  return rows.map((item) => [
    item['学号'] ?? '', item['student_name'] ?? '', item['comment_type'] ?? '',
    item['content'] ?? '', item['status'] ?? '', item['template_name'] ?? '',
    Boolean(item['is_manually_edited']) ? '是' : '否', item['reviewed_at'] ?? '',
    item['reviewed_by'] ?? '', item['review_note'] ?? '', item['sent_at'] ?? '',
    item['delivery_method'] ?? '', item['note'] ?? '', item['source_label'] ?? '',
  ]);
}
