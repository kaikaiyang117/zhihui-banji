import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDb } from '../../services/context.js';
import type { ArtifactAccess, WorkbookArtifact } from '../domain/types.js';
import {
  deleteArtifactRecord, getArtifact, insertArtifact, markArtifactDiscarded,
  listExpiredArtifacts, requireArtifact, saveBlueprint,
} from './artifactRepository.js';
import { parseWorkbookFile } from '../parser/workbookParser.js';

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function normalizeFilename(filename: string): string {
  const clean = path.basename(String(filename || 'upload.xlsx')).trim();
  return clean.toLowerCase().endsWith('.xlsx') ? clean : `${clean}.xlsx`;
}

function fileSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function artifactAccess(input: ArtifactAccess): ArtifactAccess {
  return {
    ownerId: String(input.ownerId ?? ''),
    channel: String(input.channel ?? 'web'),
    sessionId: String(input.sessionId ?? ''),
    classId: Number(input.classId),
    termId: Number(input.termId),
  };
}

export function createArtifactFromBuffer(input: {
  buffer: Buffer;
  filename: string;
  access: ArtifactAccess;
}): WorkbookArtifact {
  if (!Buffer.isBuffer(input.buffer) || input.buffer.length === 0) {
    throw new Error('Excel 文件不能为空');
  }
  if (input.buffer.length > MAX_ARTIFACT_BYTES) {
    throw new Error(`Excel 文件不能超过 ${MAX_ARTIFACT_BYTES / 1024 / 1024}MB`);
  }
  const id = randomUUID();
  const relativePath = path.join('excel-artifacts', `${id}.xlsx`);
  const absolutePath = path.join(getDb().paths.dataDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, input.buffer, { flag: 'wx', mode: 0o600 });
  try {
    return insertArtifact({
      id,
      filename: normalizeFilename(input.filename),
      sha256: fileSha256(input.buffer),
      sizeBytes: input.buffer.length,
      storagePath: relativePath,
      access: artifactAccess(input.access),
      expiresAt: stamp(new Date(Date.now() + ARTIFACT_TTL_MS)),
    });
  } catch (error) {
    fs.rmSync(absolutePath, { force: true });
    throw error;
  }
}

export async function inspectArtifact(id: string, access: ArtifactAccess): Promise<WorkbookArtifact> {
  const normalized = artifactAccess(access);
  const artifact = requireArtifact(id, normalized);
  if (artifact.blueprint) return artifact;
  const blueprint = await parseWorkbookFile(path.join(getDb().paths.dataDir, artifact.storagePath));
  return saveBlueprint(id, normalized, blueprint);
}

export function getStoredArtifact(id: string, access: ArtifactAccess): WorkbookArtifact {
  return requireArtifact(id, artifactAccess(access));
}

export function getStoredArtifactPath(id: string, access: ArtifactAccess): string {
  const artifact = getStoredArtifact(id, access);
  const dataDir = path.resolve(getDb().paths.dataDir);
  const filePath = path.resolve(dataDir, artifact.storagePath);
  if (filePath !== dataDir && !filePath.startsWith(`${dataDir}${path.sep}`)) {
    throw new Error('Excel 文件存储路径无效');
  }
  return filePath;
}

export function discardArtifact(id: string, access: ArtifactAccess): void {
  const normalized = artifactAccess(access);
  const artifact = getArtifact(id, normalized);
  if (!artifact) throw new Error('Excel 文件不存在或不属于当前会话');
  markArtifactDiscarded(id, normalized);
  fs.rmSync(path.join(getDb().paths.dataDir, artifact.storagePath), { force: true });
}

export function cleanExpiredArtifacts(now = stamp(new Date())): number {
  const expired = listExpiredArtifacts(now);
  let cleaned = 0;
  for (const item of expired) {
    fs.rmSync(path.join(getDb().paths.dataDir, item.storagePath), { force: true });
    deleteArtifactRecord(item.id);
    cleaned += 1;
  }
  return cleaned;
}
