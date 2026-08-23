import type { FastifyInstance } from 'fastify';

import {
  analyzeUpload,
  generateImportPreview,
  discardUpload,
  buildErrorExcel,
  cleanExpiredUploads,
  ExcelImportError,
} from '../../services/excelImportAssistant.js';
import { currentActor } from '../../services/audit.js';
import { analyzeExcelSemantics } from '../../agent/excelSemanticAnalyzer.js';

async function readUpload(request: { file?: () => Promise<{ toBuffer: () => Promise<Buffer>; filename: string; mimetype: string }> }): Promise<{ buffer: Buffer; filename: string }> {
  const data = await request.file?.();
  if (!data) throw new Error('未接收到文件');
  const buffer = await data.toBuffer();
  const filename = data.filename || 'upload.xlsx';
  return { buffer, filename };
}

export function registerExcelImportRoutes(app: FastifyInstance): void {
  app.post('/api/excel-import/upload', async (request, reply) => {
    const sessionId = String((request.headers as Record<string, unknown>)['x-workbench-session'] ?? '');
    const actor = currentActor();

    let buffer: Buffer;
    let filename: string;
    try {
      const data = await readUpload(request as Parameters<typeof readUpload>[0]);
      buffer = data.buffer;
      filename = data.filename;
    } catch {
      return reply.status(400).send({ detail: '未接收到文件或文件无法读取' });
    }

    try {
      const result = await analyzeUpload({
        buffer, originalName: filename, sessionId, owner: actor.actorId, channel: actor.channel,
        semanticAnalyzer: analyzeExcelSemantics,
      });
      return result;
    } catch (error) {
      if (error instanceof ExcelImportError) {
        return reply.status(400).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.post('/api/excel-import/preview', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const fileId = String(body.file_id ?? '').trim();
    const module = String(body.module ?? '').trim();

    if (!fileId || !module) {
      return reply.status(422).send({ detail: '缺少 file_id 或 module' });
    }

    const sheetIndex = typeof body.sheet_index === 'number' ? body.sheet_index : 0;
    const duplicateStrategy = String(body.duplicate_strategy ?? 'update').trim();
    const actor = currentActor();
    const sessionId = String((request.headers as Record<string, unknown>)['x-workbench-session'] ?? '');

    try {
      const preview = await generateImportPreview({
        fileId,
        module,
        sheetIndex,
        duplicateStrategy,
        owner: actor.actorId, session: sessionId, channel: actor.channel,
      });
      return preview;
    } catch (error) {
      if (error instanceof ExcelImportError) {
        const status = /不存在|已过期/.test(error.message) ? 404 : 400;
        return reply.status(status).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.post('/api/excel-import/execute', async (_request, reply) => {
    return reply.status(410).send({
      detail: '旧版 Excel 直接执行接口已停用，请通过班小助生成业务预览并确认写入。',
      replacement: '/api/agent/tools/execute_excel_import',
    });
  });

  app.post('/api/excel-import/discard', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const fileId = String(body.file_id ?? '').trim();
    if (!fileId) {
      return reply.status(422).send({ detail: '缺少 file_id' });
    }
    const actor = currentActor();
    const sessionId = String((request.headers as Record<string, unknown>)['x-workbench-session'] ?? '');
    try {
      discardUpload(fileId, { owner: actor.actorId, session: sessionId, channel: actor.channel });
      return { ok: true };
    } catch (error) {
      if (error instanceof ExcelImportError) return reply.status(404).send({ detail: error.message });
      throw error;
    }
  });

  app.get('/api/excel-import/errors/:fileId', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const module = String((request.query as Record<string, unknown>).module ?? '').trim();
    const actor = currentActor();
    const sessionId = String((request.headers as Record<string, unknown>)['x-workbench-session'] ?? '');

    try {
      const buffer = await buildErrorExcel(fileId, module, { owner: actor.actorId, session: sessionId, channel: actor.channel });
      const filename = `导入错误报告-${fileId.slice(0, 8)}.xlsx`;
      return reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .send(buffer);
    } catch (error) {
      if (error instanceof ExcelImportError) {
        return reply.status(404).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.post('/api/excel-import/clean-expired', async () => {
    const cleaned = cleanExpiredUploads();
    return { ok: true, cleaned };
  });
}
