import type { Database } from 'better-sqlite3';

import { getDb } from '../../services/context.js';
import type {
  ArtifactAccess, ArtifactStatus, WorkbookArtifact, WorkbookBlueprint,
} from '../domain/types.js';

export class ExcelArtifactError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function parseBlueprint(value: unknown): WorkbookBlueprint | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed as WorkbookBlueprint : null;
  } catch {
    return null;
  }
}

function mapArtifact(row: Record<string, unknown>): WorkbookArtifact {
  return {
    id: String(row.id),
    filename: String(row.filename),
    sha256: String(row.sha256),
    sizeBytes: Number(row.size_bytes),
    storagePath: String(row.storage_path),
    ownerId: String(row.owner_id),
    channel: String(row.channel),
    sessionId: String(row.session_id),
    classId: Number(row.class_id),
    termId: Number(row.term_id),
    status: String(row.status) as ArtifactStatus,
    blueprint: parseBlueprint(row.blueprint_json),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    updatedAt: String(row.updated_at),
  };
}

function accessWhere(access: ArtifactAccess): { sql: string; params: unknown[] } {
  return {
    sql: 'owner_id=? AND channel=? AND session_id=? AND class_id=? AND term_id=?',
    params: [access.ownerId, access.channel, access.sessionId, access.classId, access.termId],
  };
}

export function insertArtifact(input: {
  id: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  storagePath: string;
  access: ArtifactAccess;
  expiresAt: string;
  conn?: Database;
}): WorkbookArtifact {
  const db = connOf(input.conn);
  db.prepare(
    `INSERT INTO excel_artifacts
      (id, filename, sha256, size_bytes, storage_path, owner_id, channel, session_id,
       class_id, term_id, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?)`,
  ).run(
    input.id, input.filename, input.sha256, input.sizeBytes, input.storagePath,
    input.access.ownerId, input.access.channel, input.access.sessionId,
    input.access.classId, input.access.termId, input.expiresAt,
  );
  const artifact = getArtifact(input.id, input.access, db);
  if (!artifact) throw new ExcelArtifactError('Excel 文件记录创建失败');
  return artifact;
}

export function getArtifact(id: string, access: ArtifactAccess, conn?: Database): WorkbookArtifact | null {
  const db = connOf(conn);
  const where = accessWhere(access);
  const row = db.prepare(
    `SELECT * FROM excel_artifacts WHERE id=? AND ${where.sql}`,
  ).get(id, ...where.params) as Record<string, unknown> | undefined;
  return row ? mapArtifact(row) : null;
}

export function requireArtifact(id: string, access: ArtifactAccess, conn?: Database): WorkbookArtifact {
  const artifact = getArtifact(id, access, conn);
  if (!artifact) throw new ExcelArtifactError('Excel 文件不存在或不属于当前会话');
  if (artifact.status === 'discarded' || artifact.status === 'expired') {
    throw new ExcelArtifactError('Excel 文件已失效，请重新上传');
  }
  if (new Date(artifact.expiresAt.replace(' ', 'T')).getTime() < Date.now()) {
    markArtifactExpired(artifact.id, access, conn);
    throw new ExcelArtifactError('Excel 文件已过期，请重新上传');
  }
  return artifact;
}

export function saveBlueprint(
  id: string, access: ArtifactAccess, blueprint: WorkbookBlueprint, conn?: Database,
): WorkbookArtifact {
  const db = connOf(conn);
  const where = accessWhere(access);
  const result = db.prepare(
    `UPDATE excel_artifacts
        SET blueprint_json=?, status='inspected', updated_at=datetime('now','localtime')
      WHERE id=? AND ${where.sql} AND status='uploaded'`,
  ).run(JSON.stringify(blueprint), id, ...where.params);
  if (result.changes !== 1) throw new ExcelArtifactError('Excel 文件不存在、已失效或已完成识别');
  const artifact = getArtifact(id, access, db);
  if (!artifact) throw new ExcelArtifactError('Excel 文件记录不存在');
  return artifact;
}

export function markArtifactExpired(id: string, access: ArtifactAccess, conn?: Database): void {
  const db = connOf(conn);
  const where = accessWhere(access);
  db.prepare(
    `UPDATE excel_artifacts SET status='expired', updated_at=datetime('now','localtime')
     WHERE id=? AND ${where.sql} AND status IN ('uploaded','inspected')`,
  ).run(id, ...where.params);
}

export function markArtifactDiscarded(id: string, access: ArtifactAccess, conn?: Database): void {
  const db = connOf(conn);
  const where = accessWhere(access);
  const result = db.prepare(
    `UPDATE excel_artifacts SET status='discarded', updated_at=datetime('now','localtime')
     WHERE id=? AND ${where.sql} AND status NOT IN ('expired','discarded')`,
  ).run(id, ...where.params);
  if (result.changes !== 1) throw new ExcelArtifactError('Excel 文件不存在或已失效');
}

export function listExpiredArtifacts(now: string, conn?: Database): Array<{ id: string; storagePath: string }> {
  const db = connOf(conn);
  return db.prepare(
    `SELECT id, storage_path AS storagePath FROM excel_artifacts
     WHERE expires_at < ? AND status IN ('uploaded','inspected')`,
  ).all(now) as Array<{ id: string; storagePath: string }>;
}

export function deleteArtifactRecord(id: string, conn?: Database): void {
  connOf(conn).prepare('DELETE FROM excel_artifacts WHERE id=?').run(id);
}
