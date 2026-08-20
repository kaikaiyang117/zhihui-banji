import type { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';

import { ScopeError, ArchivedScopeError, getDb } from '../../services/context.js';
import * as evidence from '../../services/evidence.js';
import { safeResolve } from '../../services/files.js';
import { currentActor } from '../../services/audit.js';

function mapError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof ArchivedScopeError) return reply.status(409).send({ detail: error.message });
  if (error instanceof ScopeError) return reply.status(400).send({ detail: error.message });
  if (error instanceof evidence.EvidenceError) {
    const status = /不存在/.test(error.message) ? 404
      : /已存在/.test(error.message) ? 409 : 400;
    return reply.status(status).send({ detail: error.message });
  }
  return undefined;
}

function wrap(reply: FastifyReply, fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    const mapped = mapError(reply, error);
    if (mapped) return mapped;
    throw error;
  }
}

function resolveThumbnailPath(relativePath: string): string {
  const root = path.join(getDb().paths.dataDir, 'evidence');
  const thumbRel = evidence.thumbnailPath(relativePath);
  return safeResolve(root, thumbRel);
}

export function registerEvidenceRoutes(app: FastifyInstance): void {
  app.post('/api/evidence/upload', async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.status(400).send({ detail: '未上传文件' });
    const buffer = await data.toBuffer();
    const fields = data.fields;
    const fieldVal = (name: string): string => {
      const f = fields[name];
      const entry = Array.isArray(f) ? f[0] : f;
      return entry && 'value' in entry ? String(entry.value) : '';
    };
    const ownerType = fieldVal('owner_type');
    const ownerId = Number(fieldVal('owner_id') || 0);
    const studentId = fieldVal('student_id') ? Number(fieldVal('student_id')) : null;
    const evidenceKind = fieldVal('evidence_kind') || '请假凭证';
    const note = fieldVal('note');
    const actor = currentActor();
    return wrap(reply, () => {
      const result = evidence.uploadEvidence({
        ownerType, ownerId, studentId, evidenceKind,
        originalName: data.filename ?? '凭证', buffer,
        sourceChannel: actor.channel, note, createdBy: actor.actorId,
      });
      return { ok: true, ...result };
    });
  });

  app.get('/api/evidence/:ownerType/:ownerId', async (request, reply) => {
    const { ownerType, ownerId } = request.params as { ownerType: string; ownerId: string };
    const { include_deleted } = request.query as { include_deleted?: string };
    return wrap(reply, () => ({
      items: evidence.listEvidence({
        ownerType, ownerId: Number(ownerId),
        includeDeleted: include_deleted === 'true',
      }),
    }));
  });

  app.get('/api/evidence/detail/:evidenceId', async (request, reply) => {
    const { evidenceId } = request.params as { evidenceId: string };
    return wrap(reply, () => evidence.getEvidence(Number(evidenceId)));
  });

  app.get('/api/evidence/file/:evidenceId', async (request, reply) => {
    const { evidenceId } = request.params as { evidenceId: string };
    try {
      const filePath = evidence.getEvidenceFilePath(Number(evidenceId));
      const record = evidence.getEvidence(Number(evidenceId));
      reply.header('Content-Type', String(record.mime_type || 'application/octet-stream'));
      reply.header('Content-Disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(String(record.original_name))}`);
      return reply.send(fs.createReadStream(filePath));
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get('/api/evidence/thumbnail/:evidenceId', async (request, reply) => {
    const { evidenceId } = request.params as { evidenceId: string };
    try {
      const record = evidence.getEvidence(Number(evidenceId));
      const originalPath = evidence.getEvidenceFilePath(Number(evidenceId));
      const thumbPath = resolveThumbnailPath(String(record.relative_path));
      if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).isFile()) {
        reply.header('Content-Type', 'image/jpeg');
        return reply.send(fs.createReadStream(thumbPath));
      }
      reply.header('Content-Type', String(record.mime_type || 'application/octet-stream'));
      return reply.send(fs.createReadStream(originalPath));
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.delete('/api/evidence/:evidenceId', async (request, reply) => {
    const { evidenceId } = request.params as { evidenceId: string };
    const body = request.body as { delete_reason?: string };
    const actor = currentActor();
    return wrap(reply, () => {
      evidence.deleteEvidence(Number(evidenceId), {
        deletedBy: actor.actorId, deleteReason: String(body?.delete_reason ?? ''),
      });
      return { ok: true };
    });
  });

  app.post('/api/evidence/:evidenceId/restore', async (request, reply) => {
    const { evidenceId } = request.params as { evidenceId: string };
    const actor = currentActor();
    return wrap(reply, () => {
      evidence.restoreEvidence(Number(evidenceId), { restoredBy: actor.actorId });
      return { ok: true };
    });
  });

  app.get('/api/evidence/counts', async (request, reply) => {
    const { owner_type, owner_ids } = request.query as { owner_type?: string; owner_ids?: string };
    return wrap(reply, () => {
      const ownerType = String(owner_type ?? '');
      const ownerIds = String(owner_ids ?? '').split(',').map(Number).filter((n) => Number.isFinite(n));
      const counts = evidence.countEvidenceByOwners({ ownerType, ownerIds });
      const result: Record<number, number> = {};
      for (const [k, v] of counts) result[k] = v;
      return { counts: result };
    });
  });
}
