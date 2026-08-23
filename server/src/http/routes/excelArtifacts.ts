import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

import { currentActor } from '../../services/audit.js';
import { getCurrentScope } from '../../services/context.js';
import {
  cleanExpiredArtifacts, createArtifactFromBuffer, discardArtifact,
} from '../../excel/artifacts/artifactService.js';
import {
  ExcelArtifactError, requireArtifact,
} from '../../excel/artifacts/artifactRepository.js';
import {
  createImportPlan, ExcelImportPlanError, getImportPlan, updateImportPlan,
} from '../../excel/imports/importPlanRepository.js';
import type { ArtifactAccess, FieldMapping } from '../../excel/domain/types.js';

type UploadPart = { toBuffer: () => Promise<Buffer>; filename: string };

function requestAccess(request: { headers: Record<string, unknown> }): ArtifactAccess {
  const actor = currentActor();
  const scope = getCurrentScope();
  return {
    ownerId: actor.actorId,
    channel: actor.channel,
    sessionId: String(request.headers['x-workbench-session'] ?? ''),
    classId: scope.class_id,
    termId: scope.term_id,
  };
}

function bodyOf(request: { body?: unknown }): Record<string, unknown> {
  return request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body as Record<string, unknown> : {};
}

function errorStatus(error: unknown): number {
  return error instanceof ExcelArtifactError || error instanceof ExcelImportPlanError ? 404 : 400;
}

export function registerExcelArtifactRoutes(app: FastifyInstance): void {
  app.post('/api/excel-artifacts/upload', async (request, reply) => {
    try {
      // Cleanup is opportunistic as well as startup-driven, so long-running
      // desktop processes do not retain expired workbook files indefinitely.
      cleanExpiredArtifacts();
      const multipart = request as unknown as { file?: () => Promise<UploadPart> };
      const part = await multipart.file?.();
      if (!part) return reply.status(400).send({ detail: '未接收到 Excel 文件' });
      const access = requestAccess(request as unknown as { headers: Record<string, unknown> });
      const artifact = createArtifactFromBuffer({
        buffer: await part.toBuffer(), filename: part.filename, access,
      });
      return reply.status(201).send({ artifact });
    } catch (error) {
      return reply.status(errorStatus(error)).send({ detail: error instanceof Error ? error.message : 'Excel 文件处理失败' });
    }
  });

  app.get('/api/excel-artifacts/:id', async (request, reply) => {
    try {
      const params = request.params as { id?: string };
      const access = requestAccess(request as unknown as { headers: Record<string, unknown> });
      const artifact = requireArtifact(String(params.id ?? ''), access);
      return { artifact, blueprint: artifact.blueprint };
    } catch (error) {
      return reply.status(errorStatus(error)).send({ detail: error instanceof Error ? error.message : 'Excel 文件不存在' });
    }
  });

  app.post('/api/excel-artifacts/:id/discard', async (request, reply) => {
    try {
      const params = request.params as { id?: string };
      discardArtifact(String(params.id ?? ''), requestAccess(request as unknown as { headers: Record<string, unknown> }));
      return { ok: true };
    } catch (error) {
      return reply.status(errorStatus(error)).send({ detail: error instanceof Error ? error.message : 'Excel 文件取消失败' });
    }
  });

  app.post('/api/excel-import-plans', async (request, reply) => {
    try {
      const body = bodyOf(request);
      const access = requestAccess(request as unknown as { headers: Record<string, unknown> });
      const mappings = Array.isArray(body.mappings) ? body.mappings.map(item => {
        const raw = item && typeof item === 'object' && !Array.isArray(item)
          ? item as Record<string, unknown> : {};
        return {
          sourceColumn: String(raw.sourceColumn ?? ''),
          targetField: raw.targetField == null ? null : String(raw.targetField),
          source: raw.source === 'manual' ? 'manual' : raw.source === 'rule' ? 'rule' : 'ai',
          confidence: Number(raw.confidence ?? 0), status: raw.status === 'ignored' ? 'ignored' : 'accepted',
          reason: raw.reason == null ? undefined : String(raw.reason),
          confirmedByUser: raw.source === 'manual',
        } as FieldMapping;
      }) : [];
      const options = body.options && typeof body.options === 'object' && !Array.isArray(body.options)
        ? body.options as Record<string, unknown> : {};
      const plan = createImportPlan({
        id: String(body.id ?? randomUUID()),
        artifactId: String(body.artifact_id ?? ''),
        adapterId: String(body.adapter_id ?? ''),
        adapterVersion: body.adapter_version ? String(body.adapter_version) : undefined,
        sheetIndex: Number(body.sheet_index ?? 0), regionId: String(body.region_id ?? ''),
        mappings, options, access,
      });
      return reply.status(201).send({ plan });
    } catch (error) {
      return reply.status(errorStatus(error)).send({ detail: error instanceof Error ? error.message : '导入计划创建失败' });
    }
  });

  app.get('/api/excel-import-plans/:id', async (request, reply) => {
    try {
      const params = request.params as { id?: string };
      const access = requestAccess(request as unknown as { headers: Record<string, unknown> });
      const plan = getImportPlan(String(params.id ?? ''), access);
      if (!plan) return reply.status(404).send({ detail: '导入计划不存在或不属于当前会话' });
      return { plan };
    } catch (error) {
      return reply.status(errorStatus(error)).send({ detail: error instanceof Error ? error.message : '导入计划读取失败' });
    }
  });

  app.get('/api/excel-import-plans/:id/error-report', async (request, reply) => {
    try {
      const params = request.params as { id?: string };
      const access = requestAccess(request as unknown as { headers: Record<string, unknown> });
      const plan = getImportPlan(String(params.id ?? ''), access);
      if (!plan) return reply.status(404).send({ detail: '导入计划不存在或不属于当前会话' });
      const errors = Array.isArray(plan.preview?.errors) ? plan.preview.errors : [];
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="excel-import-errors-${plan.id}.json"`);
      return { plan_id: plan.id, artifact_id: plan.artifactId, errors };
    } catch (error) {
      return reply.status(errorStatus(error)).send({ detail: error instanceof Error ? error.message : '错误报告读取失败' });
    }
  });

  app.patch('/api/excel-import-plans/:id', async (request, reply) => {
    try {
      const params = request.params as { id?: string };
      const body = bodyOf(request);
      const mappings = Array.isArray(body.mappings) ? body.mappings.map(item => {
        const raw = item && typeof item === 'object' && !Array.isArray(item)
          ? item as Record<string, unknown> : {};
        return {
          sourceColumn: String(raw.sourceColumn ?? ''),
          targetField: raw.targetField == null ? null : String(raw.targetField),
          source: raw.source === 'manual' ? 'manual' : raw.source === 'rule' ? 'rule' : 'ai',
          confidence: Number(raw.confidence ?? 0), status: raw.status === 'ignored' ? 'ignored' : 'accepted',
          reason: raw.reason == null ? undefined : String(raw.reason),
          confirmedByUser: raw.source === 'manual',
        } as FieldMapping;
      }) : undefined;
      const options = body.options && typeof body.options === 'object' && !Array.isArray(body.options)
        ? body.options as Record<string, unknown> : undefined;
      const plan = updateImportPlan({
        id: String(params.id ?? ''), mappings, options,
        access: requestAccess(request as unknown as { headers: Record<string, unknown> }),
      });
      return { plan };
    } catch (error) {
      return reply.status(errorStatus(error)).send({ detail: error instanceof Error ? error.message : '导入计划更新失败' });
    }
  });
}
