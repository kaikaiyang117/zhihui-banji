import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { getDb, scopeIds } from './context.js';
import * as audit from './audit.js';
import { safeResolve, sha256, atomicWrite } from './files.js';
import { todayString } from './clock.js';

export class KnowledgeError extends Error {}

export class KnowledgeConflict extends KnowledgeError {}

export const TEMPLATES = ['备课笔记', '考研知识点', '读书笔记', '学生档案', '班会记录', '班主任日志'];

const TEMPLATE_BODY: Record<string, string> = {
  '备课笔记': `\n# 备课笔记\n\n## 课题\n\n## 教学目标\n\n- 知识目标：\n- 能力目标：\n- 情感目标：\n\n## 教学重难点\n\n**重点：**\n\n**难点：**\n\n## 教学过程\n\n### 导入\n\n### 新课讲授\n\n### 课堂小结\n\n### 作业布置\n\n## 教学反思\n\n`,
  '考研知识点': `\n# 考研知识点\n\n## 所属科目\n\n## 知识点概述\n\n## 核心概念\n\n1. \n2. \n3. \n\n## 记忆口诀\n\n## 真题链接\n\n- [ ] 年份/题型：\n\n## 复习记录\n\n| 日期 | 掌握程度 | 备注 |\n|------|----------|------|\n| {today} | 初次学习 | |\n`,
  '读书笔记': `\n# 读书笔记\n\n## 书籍信息\n\n- 书名：\n- 作者：\n- 阅读日期：{today}\n\n## 核心观点\n\n## 精彩摘录\n\n> \n\n## 我的思考\n\n## 行动清单\n\n- [ ] \n`,
  '学生档案': `\n# 学生档案\n\n## 基本信息\n\n- 姓名：\n- 学号：\n- 家庭情况：\n\n## 学业表现\n\n## 行为记录\n\n| 日期 | 事件 | 处理 |\n|------|------|------|\n| {today} | | |\n\n## 重点关注\n\n`,
  '班会记录': `\n# 班会记录\n\n- 日期：{today}\n- 主题：\n- 主持人：\n\n## 会议内容\n\n## 学生反馈\n\n## 后续跟进\n\n`,
  '班主任日志': `\n# 班主任日志\n\n- 日期：{today}\n- 天气：\n\n## 今日记事\n\n## 好人好事\n\n## 存在问题\n\n## 明日计划\n\n`,
};

const LINK_TABLES: Record<string, string> = {
  meeting: 'meeting_records',
  activity: 'activity_records',
  diary: 'diary_entries',
  work_item: 'student_tasks',
};

export interface NoteIndex {
  id: number;
  relative_path: string;
  title: string;
  category: string;
  tags: string[];
  content_hash: string;
  current_hash: string;
  file_mtime: number;
  sync_status: string;
}

interface ParsedFrontmatter {
  metadata: { title: string; category: string; tags: string[]; date: string };
  body: string;
}

function text(value: unknown): string {
  const t = value ?? '';
  return t ? String(t).trim() : '';
}

function kbDir(): string {
  return getDb().paths.kbDir;
}

function safeRelative(relativePath: string): string {
  const value = text(relativePath).replace(/\\/g, '/');
  if (!value || value.startsWith('/') || value.includes('\x00')) {
    throw new KnowledgeError('笔记路径不合法');
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..'
    || normalized.startsWith('../') || normalized.includes('/..')) {
    throw new KnowledgeError('笔记路径不合法');
  }
  if (!normalized.toLowerCase().endsWith('.md')) {
    return `${normalized}.md`;
  }
  return normalized;
}

function fullPath(relativePath: string): string {
  const safe = safeRelative(relativePath);
  const root = path.resolve(kbDir());
  try {
    return safeResolve(root, safe);
  } catch {
    throw new KnowledgeError('笔记路径不合法');
  }
}

function parseTags(value: unknown): string[] {
  let raw = text(value);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    raw = raw.slice(1, -1);
  }
  const values: string[] = [];
  for (const rawItem of raw.split(',')) {
    const item = stripQuotes(rawItem.trim());
    if (item && !values.includes(item)) {
      values.push(item.slice(0, 40));
    }
  }
  return values.slice(0, 30);
}

function stripQuotes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === '"' || value[start] === "'")) {
    start += 1;
  }
  while (end > start && (value[end - 1] === '"' || value[end - 1] === "'")) {
    end -= 1;
  }
  return value.slice(start, end);
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const metadata: Record<string, string> = {};
  let body = content;
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---', 4);
    if (end >= 0) {
      const raw = content.slice(4, end);
      body = content.slice(end + 4).replace(/^\n+/, '');
      for (const line of raw.split(/\r\n|\r|\n/)) {
        const colon = line.indexOf(':');
        if (colon < 0) {
          continue;
        }
        metadata[text(line.slice(0, colon))] = text(line.slice(colon + 1));
      }
    }
  }
  let title = text(metadata.title);
  if (!title) {
    const heading = /^#\s+(.+?)\s*$/m.exec(body);
    title = heading ? text(heading[1]) : '';
  }
  return {
    metadata: {
      title,
      category: text(metadata.category) || '未分类',
      tags: parseTags(metadata.tags ?? ''),
      date: text(metadata.date ?? ''),
    },
    body,
  };
}

function frontmatter(content: string, title: string, category: string, tags: string[] | null): string {
  const { metadata, body } = parseFrontmatter(content);
  const cleanTitle = text(title) || metadata.title || '未命名笔记';
  const cleanCategory = text(category) || metadata.category || '未分类';
  const tagList = tags ?? metadata.tags;
  const today = metadata.date || todayString();
  return `---\n`
    + `title: ${cleanTitle}\n`
    + `date: ${today}\n`
    + `category: ${cleanCategory}\n`
    + `tags: [${tagList.join(', ')}]\n`
    + `---\n\n${body.trimEnd()}\n`;
}

function basenameTitle(relativePath: string): string {
  const base = path.posix.basename(relativePath);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    return base;
  }
  return base.slice(0, dot);
}

function nowString(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function syncFile(relativePath: string, options: { conn?: Database; acceptChanges?: boolean } = {}): NoteIndex {
  const db = options.conn ?? getDb().connInstance;
  const full = fullPath(relativePath);
  const safe = safeRelative(relativePath);
  let content: string;
  try {
    content = fs.readFileSync(full, 'utf8');
  } catch {
    throw new KnowledgeError('笔记文件不存在');
  }
  const metadata = parseFrontmatter(content).metadata;
  const stat = fs.statSync(full);
  const digest = sha256(content);
  const row = db.prepare('SELECT * FROM knowledge_notes WHERE relative_path=?').get(safe) as
    Record<string, unknown> | undefined;
  let status = '同步';
  const rowHash = row ? row.content_hash : '';
  if (row && rowHash && rowHash !== digest && !options.acceptChanges) {
    status = '文件已修改';
  }
  if (row && String(row.sync_status ?? '') === '待恢复' && !options.acceptChanges) {
    status = '待恢复';
  }
  const [classId, termId] = scopeIds({ conn: db });
  const storedHash = !row || options.acceptChanges ? digest : String(rowHash ?? '');
  const title = metadata.title || basenameTitle(safe);
  const tagsJson = JSON.stringify(metadata.tags);
  const fileMtime = stat.mtimeMs / 1000;
  let noteId: number;
  if (row) {
    db.prepare(
      'UPDATE knowledge_notes SET title=?,category=?,tags=?,content_hash=?,file_mtime=?,sync_status=?,'
      + 'class_id=COALESCE(class_id,?),term_id=COALESCE(term_id,?),updated_at=? WHERE relative_path=?',
    ).run(title, metadata.category, tagsJson, storedHash, fileMtime, status,
      classId, termId, nowString(), safe);
    noteId = Number(row.id);
  } else {
    const inserted = db.prepare(
      'INSERT INTO knowledge_notes(class_id,term_id,relative_path,title,category,tags,content_hash,file_mtime,sync_status)'
      + ' VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(classId, termId, safe, title, metadata.category, tagsJson, digest, fileMtime, status);
    noteId = Number(inserted.lastInsertRowid);
  }
  return {
    id: noteId,
    relative_path: safe,
    title,
    category: metadata.category,
    tags: metadata.tags,
    content_hash: storedHash,
    current_hash: digest,
    file_mtime: fileMtime,
    sync_status: status,
  };
}

function decorate(note: NoteIndex, conn?: Database): Record<string, unknown> {
  const db = conn ?? getDb().connInstance;
  const item = { ...note } as Record<string, unknown>;
  try {
    item.tags = JSON.parse(String(item.tags ?? '[]'));
  } catch {
    item.tags = parseTags(String(item.tags ?? ''));
  }
  item.links = db.prepare(
    'SELECT * FROM knowledge_note_links WHERE note_id=? ORDER BY id',
  ).all(note.id);
  return item;
}

function coerceLinkId(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? value : Math.trunc(value);
  }
  const raw = String(value).trim();
  if (raw === '' || !/^[+-]?(0[xX][0-9a-fA-F]+|\d+(_\d+)*)$/.test(raw)) {
    throw new KnowledgeError('知识库关联 ID 不合法');
  }
  return Number(raw.replace(/_/g, ''));
}

function replaceLinks(noteId: number, links: Array<Record<string, unknown>>, options: { conn?: Database } = {}): void {
  const db = options.conn ?? getDb().connInstance;
  db.transaction(() => {
    const [classId, termId] = scopeIds({ write: true, conn: db });
    db.prepare('DELETE FROM knowledge_note_links WHERE note_id=?').run(noteId);
    for (const link of links) {
      const linkType = text(link.link_type ?? link.type);
      if (!(linkType in LINK_TABLES)) {
        throw new KnowledgeError('知识库关联类型不合法');
      }
      const linkIdValue = link.link_id !== undefined ? link.link_id : link.id;
      const linkId = coerceLinkId(linkIdValue);
      const table = LINK_TABLES[linkType];
      const exists = db.prepare(
        `SELECT 1 FROM ${table} WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''`,
      ).get(linkId, classId, termId);
      if (!exists) {
        throw new KnowledgeError('关联的来源记录不存在');
      }
      db.prepare(
        'INSERT OR IGNORE INTO knowledge_note_links(note_id,link_type,link_id,label) VALUES(?,?,?,?)',
      ).run(noteId, linkType, linkId, text(link.label));
    }
  })();
}

export function listNotes(
  options: { query?: string; tag?: string; category?: string; conn?: Database } = {},
): { notes: Array<Record<string, unknown>>; categories: string[]; tags: string[]; templates: string[] } {
  const db = options.conn ?? getDb().connInstance;
  const root = kbDir();
  fs.mkdirSync(root, { recursive: true });
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.name === '.git' || entry.name === '__pycache__') {
          continue;
        }
        stack.push(path.join(dir, entry.name));
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        files.push(path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/'));
      }
    }
  }
  const indexed: NoteIndex[] = [];
  for (const relativePath of files) {
    try {
      indexed.push(syncFile(relativePath, { conn: db }));
    } catch (error) {
      if (!(error instanceof KnowledgeError)
        && !(error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string')) {
        throw error;
      }
    }
  }
  const q = text(options.query).toLowerCase();
  const wantedTag = text(options.tag).toLowerCase();
  const wantedCategory = text(options.category);
  const result: Array<Record<string, unknown>> = [];
  for (const item of indexed) {
    if (wantedCategory && item.category !== wantedCategory) {
      continue;
    }
    if (wantedTag && !item.tags.some((tag) => tag.toLowerCase() === wantedTag)) {
      continue;
    }
    if (q) {
      let haystack = '';
      try {
        haystack = fs.readFileSync(fullPath(item.relative_path), 'utf8').toLowerCase();
      } catch {
        haystack = '';
      }
      if (!(item.title + ' ' + item.relative_path).toLowerCase().includes(q) && !haystack.includes(q)) {
        continue;
      }
    }
    result.push(decorate(item, db));
  }
  result.sort((a, b) => Number(b.file_mtime) - Number(a.file_mtime));
  const categories = [...new Set(indexed.map((item) => item.category))].sort();
  const tags = [...new Set(indexed.flatMap((item) => item.tags))].sort();
  return { notes: result, categories, tags, templates: TEMPLATES };
}

export function readNote(relativePath: string, options: { conn?: Database } = {}): Record<string, unknown> {
  const db = options.conn ?? getDb().connInstance;
  const item = syncFile(relativePath, { conn: db });
  const content = fs.readFileSync(fullPath(relativePath), 'utf8');
  return {
    ...decorate(item, db),
    content,
    recoverable: item.sync_status === '文件已修改' || item.sync_status === '待恢复',
  };
}

export function createNote(
  options: {
    title: string;
    category?: string;
    template?: string;
    content?: string;
    tags?: string[] | null;
    links?: Array<Record<string, unknown>> | null;
    conn?: Database;
  },
): Record<string, unknown> {
  const db = options.conn ?? getDb().connInstance;
  return db.transaction(() => {
    const title = text(options.title);
    const category = text(options.category) || '个人成长';
    if (!title) {
      throw new KnowledgeError('请输入笔记标题');
    }
    const safeTitle = title.replace(/[\\/:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '') || '未命名笔记';
    const relativePath = safeRelative(`${category}/${safeTitle}.md`);
    const full = fullPath(relativePath);
    if (fs.existsSync(full)) {
      throw new KnowledgeError(`笔记“${title}”已存在`);
    }
    let body: string;
    if (options.template) {
      body = (TEMPLATE_BODY[text(options.template)] ?? '').replace(/\{today\}/g, todayString());
    } else {
      body = text(options.content);
    }
    if (options.template && options.content) {
      body += '\n' + text(options.content);
    }
    const rendered = frontmatter(body, title, category, [...(options.tags ?? [])]);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const fd = fs.openSync(full, 'wx');
    try {
      fs.writeFileSync(fd, rendered, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    const item = syncFile(relativePath, { conn: db });
    replaceLinks(item.id, options.links ?? [], { conn: db });
    audit.record('knowledge_note', item.id, 'create', {
      summary: `新建知识库笔记：${title}`,
      params: { relative_path: relativePath, tag_count: (options.tags ?? []).length },
      conn: db,
    });
    return readNote(relativePath, { conn: db });
  })();
}

export function updateNote(
  noteId: number,
  options: {
    content: string;
    expectedHash?: string;
    force?: boolean;
    title?: string;
    category?: string;
    tags?: string[] | null;
    links?: Array<Record<string, unknown>> | null;
    conn?: Database;
  },
): Record<string, unknown> {
  const db = options.conn ?? getDb().connInstance;
  const row = db.prepare('SELECT * FROM knowledge_notes WHERE id=?').get(Number(noteId)) as
    Record<string, unknown> | undefined;
  if (!row) {
    throw new KnowledgeError('笔记不存在');
  }
  const relativePath = String(row.relative_path);
  const full = fullPath(relativePath);
  let current: string;
  try {
    current = fs.readFileSync(full, 'utf8');
  } catch {
    throw new KnowledgeError('笔记文件不存在，无法保存');
  }
  const currentHash = sha256(current);
  if (options.expectedHash && currentHash !== options.expectedHash && !options.force) {
    db.prepare("UPDATE knowledge_notes SET sync_status='文件已修改' WHERE id=?").run(Number(noteId));
    throw new KnowledgeConflict('文件已被外部修改，请重新读取后再保存；原文件仍保留');
  }
  const rendered = frontmatter(
    options.content,
    options.title || String(row.title ?? ''),
    options.category || String(row.category ?? ''),
    options.tags !== null && options.tags !== undefined ? [...options.tags] : null,
  );
  atomicWrite(full, rendered);
  const item = syncFile(relativePath, { conn: db, acceptChanges: true });
  replaceLinks(item.id, options.links ?? [], { conn: db });
  audit.record('knowledge_note', Number(noteId), 'update', {
    summary: `更新知识库笔记：${item.title}`,
    params: { relative_path: relativePath, force: Boolean(options.force) },
    conn: db,
  });
  return readNote(relativePath, { conn: db });
}

export function adoptExternalChange(noteId: number, options: { conn?: Database } = {}): Record<string, unknown> {
  const db = options.conn ?? getDb().connInstance;
  const row = db.prepare('SELECT relative_path FROM knowledge_notes WHERE id=?').get(Number(noteId)) as
    { relative_path: string } | undefined;
  if (!row) {
    throw new KnowledgeError('笔记不存在');
  }
  syncFile(row.relative_path, { conn: db, acceptChanges: true });
  db.prepare("UPDATE knowledge_notes SET sync_status='同步' WHERE id=?").run(Number(noteId));
  audit.record('knowledge_note', Number(noteId), 'adopt_external', {
    summary: '采纳外部修改的知识库笔记',
    conn: db,
  });
  return readNote(row.relative_path, { conn: db });
}

export function evaluateStartup(options: { conn?: Database } = {}): void {
  void options.conn;
  fs.mkdirSync(kbDir(), { recursive: true });
}
