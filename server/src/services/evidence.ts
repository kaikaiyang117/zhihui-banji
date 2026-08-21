import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { getDb, scopeIds } from './context.js';
import * as audit from './audit.js';
import { safeResolve, atomicWrite, sha256 } from './files.js';

export const OWNER_TYPES = new Set(['attendance', 'communication', 'student_event', 'education']);
export const EVIDENCE_KINDS = new Set(['请假凭证', '沟通截图', '现场照片', '证明材料']);
export const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

export class EvidenceError extends Error {}

const OWNER_TABLES: Record<string, string> = {
  attendance: 'attendance_records',
  communication: 'communications',
  student_event: 'student_events',
  education: 'student_comments',
};

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function evidenceRoot(): string {
  return path.join(getDb().paths.dataDir, 'evidence');
}

export function detectMimeType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  return null;
}

export function generateStoragePath(options: {
  classId: number;
  termId: number;
  ownerType: string;
  ownerId: number;
  extension: string;
}): { storedName: string; relativePath: string } {
  const storedName = `${randomBytes(16).toString('hex')}${options.extension}`;
  const relativePath = ['evidence', String(options.classId), String(options.termId),
    options.ownerType, String(options.ownerId), storedName].join('/');
  return { storedName, relativePath };
}

export function thumbnailPath(relativePath: string): string {
  const dot = relativePath.lastIndexOf('.');
  const base = dot > 0 ? relativePath.slice(0, dot) : relativePath;
  return `${base}.thumb.jpg`;
}

function ensureOwnerInScope(
  ownerType: string, ownerId: number, classId: number, termId: number, studentId: number | null, conn: Database,
): void {
  const table = OWNER_TABLES[ownerType];
  if (!table) throw new EvidenceError(`不支持的凭证归属类型：${ownerType}`);
  const row = conn.prepare(
    `SELECT id, student_id FROM ${table} WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''`,
  ).get(ownerId, classId, termId) as { id: number; student_id?: number } | undefined;
  if (!row) throw new EvidenceError(`凭证归属记录不存在：${ownerType}/${ownerId}`);
  if (studentId !== null && Number(row.student_id ?? 0) !== studentId) {
    throw new EvidenceError('证据关联的学生与业务记录不一致');
  }
}

export function uploadEvidence(options: {
  ownerType: string;
  ownerId: number;
  studentId?: number | null;
  evidenceKind?: string;
  originalName: string;
  buffer: Buffer;
  sourceChannel?: string;
  note?: string;
  createdBy?: string;
  conn?: Database;
}): { id: number; sha256: string; size_bytes: number; mime_type: string; stored_name: string; relative_path: string } {
  const conn = connOf(options.conn);
  if (!OWNER_TYPES.has(options.ownerType)) {
    throw new EvidenceError(`不支持的凭证归属类型：${options.ownerType}`);
  }
  const [classId, termId] = scopeIds({ write: true, conn });
  const studentId = options.studentId == null ? null : Number(options.studentId);
  if (studentId !== null && (!Number.isInteger(studentId) || studentId < 1)) {
    throw new EvidenceError('student_id 必须是正整数');
  }
  ensureOwnerInScope(options.ownerType, options.ownerId, classId, termId, studentId, conn);

  const data = Buffer.from(options.buffer ?? Buffer.alloc(0));
  if (data.length === 0) throw new EvidenceError('凭证文件不能为空');
  if (data.length > MAX_FILE_SIZE) throw new EvidenceError('凭证文件不能超过 10MB');

  const originalName = String(options.originalName ?? '凭证').slice(0, 160);

  const mimeType = detectMimeType(data);
  if (!mimeType || !ALLOWED_MIME_TYPES.has(mimeType)) {
    const ext = originalName.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'heic' || ext === 'heif') throw new EvidenceError('请将 HEIC 图片转换为 JPEG 后上传');
    if (ext === 'gif') throw new EvidenceError('不支持 GIF 动图，请转换为 PNG 或 JPEG');
    if (ext === 'svg') throw new EvidenceError('不支持 SVG 矢量图，请截图后上传');
    if (ext === 'pdf') throw new EvidenceError('不支持 PDF 文件，请截图后上传');
    throw new EvidenceError('仅支持 JPEG、PNG、WebP 格式的图片');
  }

  const evidenceKind = options.evidenceKind ?? '请假凭证';
  if (!EVIDENCE_KINDS.has(evidenceKind)) {
    throw new EvidenceError(`不支持的凭证类型：${evidenceKind}`);
  }

  const digest = sha256(data);
  const dup = checkDuplicateHash({ ownerType: options.ownerType, ownerId: options.ownerId, sha256: digest, conn });
  if (dup.duplicate) {
    throw new EvidenceError(`相同文件已存在于当前记录（附件 ID: ${dup.existingId}）`);
  }

  const dot = originalName.lastIndexOf('.');
  const extension = dot > 0 ? originalName.slice(dot).slice(0, 12) : '.jpg';
  const { storedName, relativePath } = generateStoragePath({
    classId, termId, ownerType: options.ownerType, ownerId: options.ownerId, extension,
  });

  const target = safeResolve(evidenceRoot(), relativePath);
  let evidenceId = 0;
  try {
    atomicWrite(target, data);
    try {
      conn.transaction(() => {
        const inserted = conn.prepare(
          `INSERT INTO evidence_attachments(
             class_id, term_id, owner_type, owner_id, student_id, evidence_kind,
             original_name, stored_name, relative_path, mime_type, size_bytes,
             sha256, source_channel, note, created_by
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          classId, termId, options.ownerType, options.ownerId,
          studentId, evidenceKind,
          originalName, storedName, relativePath, mimeType, data.length,
          digest, String(options.sourceChannel ?? 'web'), String(options.note ?? ''),
          String(options.createdBy ?? ''),
        );
        evidenceId = Number(inserted.lastInsertRowid);
        audit.record('evidence', evidenceId, 'create', {
          summary: `上传凭证：${originalName}`,
          params: { owner_type: options.ownerType, owner_id: options.ownerId, evidence_kind: evidenceKind, size_bytes: data.length },
          classId, termId, conn,
        });
      })();
    } catch (dbError) {
      try { fs.rmSync(target, { force: true }); } catch { /* cleanup failure */ }
      throw dbError;
    }
  } catch (writeError) {
    throw writeError;
  }

  return {
    id: evidenceId, sha256: digest, size_bytes: data.length, mime_type: mimeType,
    stored_name: storedName, relative_path: relativePath,
  };
}

export function listEvidence(options: {
  ownerType: string;
  ownerId: number;
  includeDeleted?: boolean;
  conn?: Database;
}): Array<Record<string, unknown>> {
  const conn = connOf(options.conn);
  if (!OWNER_TYPES.has(options.ownerType)) {
    throw new EvidenceError(`不支持的凭证归属类型：${options.ownerType}`);
  }
  const [classId, termId] = scopeIds({ conn });
  const where = ["class_id=?", "term_id=?", "owner_type=?", "owner_id=?"];
  const params: unknown[] = [classId, termId, options.ownerType, options.ownerId];
  if (!options.includeDeleted) {
    where.push("deleted_at=''");
  }
  const rows = conn.prepare(
    'SELECT * FROM evidence_attachments WHERE ' + where.join(' AND ') + ' ORDER BY id',
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...row,
    download_path: `/api/evidence/file/${row.id}?class_id=${classId}&term_id=${termId}`,
    thumbnail_path: `/api/evidence/thumbnail/${row.id}?class_id=${classId}&term_id=${termId}`,
  }));
}

export function getEvidence(evidenceId: number, options?: { conn?: Database }): Record<string, unknown> {
  const conn = connOf(options?.conn);
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    'SELECT * FROM evidence_attachments WHERE id=? AND class_id=? AND term_id=?',
  ).get(evidenceId, classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new EvidenceError('凭证不存在');
  return {
    ...row,
    download_path: `/api/evidence/file/${row.id}?class_id=${classId}&term_id=${termId}`,
    thumbnail_path: `/api/evidence/thumbnail/${row.id}?class_id=${classId}&term_id=${termId}`,
  };
}

export function getEvidenceFilePath(evidenceId: number, options?: { conn?: Database }): string {
  const conn = connOf(options?.conn);
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    "SELECT * FROM evidence_attachments WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(evidenceId, classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new EvidenceError('凭证不存在或已删除');
  const resolved = safeResolve(evidenceRoot(), String(row.relative_path));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new EvidenceError('凭证文件不存在');
  }
  const digest = sha256(fs.readFileSync(resolved));
  if (digest !== String(row.sha256 ?? '').toLowerCase()) {
    throw new EvidenceError('凭证完整性校验失败，文件内容与记录不一致');
  }
  return resolved;
}

export function deleteEvidence(evidenceId: number, options: {
  deletedBy: string;
  deleteReason: string;
  conn?: Database;
}): void {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ write: true, conn });
  const row = conn.prepare(
    "SELECT * FROM evidence_attachments WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(evidenceId, classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new EvidenceError('凭证不存在或已删除');
  if (!String(options.deleteReason ?? '').trim()) {
    throw new EvidenceError('删除凭证时必须填写原因');
  }
  conn.transaction(() => {
    conn.prepare(
      `UPDATE evidence_attachments SET deleted_at=datetime('now','localtime'),
         deleted_by=?, delete_reason=?
       WHERE id=? AND class_id=? AND term_id=?`,
    ).run(String(options.deletedBy ?? ''), String(options.deleteReason).trim(), evidenceId, classId, termId);
    audit.record('evidence', evidenceId, 'delete', {
      summary: `删除凭证：${row.original_name}`,
      params: { owner_type: row.owner_type, owner_id: row.owner_id, delete_reason: options.deleteReason },
      classId, termId, conn,
    });
  })();
}

export function restoreEvidence(evidenceId: number, options?: { restoredBy?: string; conn?: Database }): void {
  const conn = connOf(options?.conn);
  const [classId, termId] = scopeIds({ write: true, conn });
  const row = conn.prepare(
    'SELECT * FROM evidence_attachments WHERE id=? AND class_id=? AND term_id=? AND deleted_at<>""',
  ).get(evidenceId, classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new EvidenceError('凭证不存在或未被删除');
  conn.transaction(() => {
    conn.prepare(
      `UPDATE evidence_attachments SET deleted_at='', deleted_by='', delete_reason=''
       WHERE id=? AND class_id=? AND term_id=?`,
    ).run(evidenceId, classId, termId);
    audit.record('evidence', evidenceId, 'restore', {
      summary: `恢复凭证：${row.original_name}`,
      params: { owner_type: row.owner_type, owner_id: row.owner_id, restored_by: options?.restoredBy ?? '' },
      classId, termId, conn,
    });
  })();
}

export function countEvidenceByOwners(options: {
  ownerType: string;
  ownerIds: number[];
  conn?: Database;
}): Map<number, number> {
  const conn = connOf(options.conn);
  if (!OWNER_TYPES.has(options.ownerType)) {
    throw new EvidenceError(`不支持的凭证归属类型：${options.ownerType}`);
  }
  const [classId, termId] = scopeIds({ conn });
  const result = new Map<number, number>();
  if (options.ownerIds.length === 0) return result;
  for (const id of options.ownerIds) {
    result.set(Number(id), 0);
  }
  const placeholders = options.ownerIds.map(() => '?').join(',');
  const rows = conn.prepare(
    `SELECT owner_id, COUNT(*) AS cnt FROM evidence_attachments
     WHERE class_id=? AND term_id=? AND owner_type=? AND deleted_at=''
       AND owner_id IN (${placeholders})
     GROUP BY owner_id`,
  ).all(classId, termId, options.ownerType, ...options.ownerIds) as Array<{ owner_id: number; cnt: number }>;
  for (const row of rows) {
    result.set(Number(row.owner_id), Number(row.cnt));
  }
  return result;
}

export function checkDuplicateHash(options: {
  ownerType: string;
  ownerId: number;
  sha256: string;
  conn?: Database;
}): { duplicate: boolean; existingId?: number } {
  const conn = connOf(options.conn);
  const [classId, termId] = scopeIds({ conn });
  const row = conn.prepare(
    `SELECT id FROM evidence_attachments
     WHERE class_id=? AND term_id=? AND owner_type=? AND owner_id=? AND sha256=? AND deleted_at=''
     LIMIT 1`,
  ).get(classId, termId, options.ownerType, options.ownerId, options.sha256) as { id: number } | undefined;
  if (row) return { duplicate: true, existingId: Number(row.id) };
  return { duplicate: false };
}
