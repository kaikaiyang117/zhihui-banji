/* MIG-09 路由：报告、健康、Excel 导出；以及系统运维（备份/恢复/迁移包/更新）。 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as reports from '../../services/reports.js';
import * as health from '../../services/health.js';
import * as exportService from '../../services/exportService.js';
import * as migrationService from '../../services/migrationService.js';
import * as updateService from '../../services/update.js';
import { db as dbModule, restoreFromBuffer } from '../../db/index.js';
import { loadAppVersion } from '../../config/index.js';
import { isLocalHost } from '../../services/devices.js';

const XLSX_MEDIA = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function mapError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof reports.ReportError
    || error instanceof health.HealthError
    || error instanceof migrationService.MigrationError) {
    return reply.status(400).send({ detail: (error as Error).message });
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

function xlsxReply(reply: FastifyReply, buffer: Buffer, filename: string): void {
  reply.header('Content-Type', XLSX_MEDIA);
  reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  reply.send(buffer);
}

export function registerMig09Routes(app: FastifyInstance): void {
  // ---------- 报告 ----------
  app.post('/api/reports/preview', async (request, reply) => {
    const body = request.body as {
      report_type?: string; period_start?: string; period_end?: string; student_id?: number | null;
    };
    return wrap(reply, () => reports.buildReport(body.report_type ?? 'weekly', {
      periodStart: body.period_start ?? '', periodEnd: body.period_end ?? '',
      studentId: body.student_id !== undefined && body.student_id !== null ? Number(body.student_id) : null,
    }));
  });

  app.get('/api/reports/archives', async (request) => {
    const { report_type = '' } = request.query as { report_type?: string };
    return { archives: reports.listArchives(report_type) };
  });

  app.post('/api/reports/archives', async (request, reply) => {
    const body = request.body as {
      report_type?: string; period_start?: string; period_end?: string; student_id?: number | null;
      class_summary?: string; teacher_summary?: string; next_term_plan?: string;
    };
    return wrap(reply, () => reports.createArchive(body.report_type ?? 'weekly', {
      periodStart: body.period_start ?? '', periodEnd: body.period_end ?? '',
      studentId: body.student_id !== undefined && body.student_id !== null ? Number(body.student_id) : null,
      classSummary: body.class_summary ?? '', teacherSummary: body.teacher_summary ?? '',
      nextTermPlan: body.next_term_plan ?? '',
    }));
  });

  app.post('/api/reports/ai/preview', async (request, reply) => {
    const body = request.body as { instruction?: string };
    try {
      const reportDrafter = await import('../../agent/reportDrafter.js');
      const report = reports.buildReport('term', {}) as Record<string, unknown>;
      return await reportDrafter.generateDraft({ report, instruction: String(body.instruction ?? '') });
    } catch (error) {
      if (error instanceof Error && (error.constructor.name === 'ReportAIDraftError'
        || error.constructor.name === 'ModelError' || error.constructor.name === 'ModelNotConfigured')) {
        return reply.status(400).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.get('/api/reports/archives/:archiveId', async (request, reply) => {
    const { archiveId } = request.params as { archiveId: string };
    return wrap(reply, () => reports.getArchive(Number(archiveId)));
  });

  app.get('/api/reports/archives/:archiveId/export', async (request, reply) => {
    const { archiveId } = request.params as { archiveId: string };
    try {
      const result = await reports.exportArchive(Number(archiveId));
      xlsxReply(reply, result.buffer, result.filename);
      return reply;
    } catch (error) {
      if (error instanceof reports.ReportError) {
        return reply.status(404).send({ detail: (error as Error).message });
      }
      throw error;
    }
  });

  // ---------- 健康 ----------
  app.get('/api/health/goals', async () => ({ goals: health.listGoals() }));

  app.post('/api/health/goals', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => health.createGoal({
      metric: String(body.metric ?? ''),
      targetValue: body.target_value !== undefined && body.target_value !== null
        ? Number(body.target_value) : null,
      unit: String(body.unit ?? ''), note: String(body.note ?? ''),
      enabled: body.enabled !== false,
    }));
  });

  app.put('/api/health/goals/:goalId', async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => health.updateGoal(Number(goalId), {
      metric: body.metric as string | undefined,
      targetValue: body.target_value !== undefined && body.target_value !== null
        ? Number(body.target_value) : undefined,
      unit: body.unit as string | undefined,
      note: body.note as string | undefined,
      enabled: body.enabled === undefined || body.enabled === null ? undefined : Boolean(body.enabled),
    }));
  });

  app.get('/api/health/summary', async (request) => {
    const query = request.query as Record<string, string>;
    return health.summary(
      query.period_type ?? 'month', query.period_start ?? '', query.period_end ?? '');
  });

  app.get('/api/health/summary/export', async (request, reply) => {
    void reply;
    const query = request.query as Record<string, string>;
    const result = await health.exportSummary(
      query.period_type ?? 'month', query.period_start ?? '', query.period_end ?? '');
    xlsxReply(reply, result.buffer, result.filename);
    return reply;
  });

  app.post('/api/health/reviews/generate', async (request, reply) => {
    const query = request.query as Record<string, string>;
    return wrap(reply, () => health.generateReview(
      query.period_type ?? 'month', query.period_start ?? '', query.period_end ?? ''));
  });

  app.get('/api/health/reviews', async (request) => {
    const { limit = '50' } = request.query as { limit?: string };
    return { reviews: health.listReviews(Number(limit)) };
  });

  app.post('/api/health/reviews', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => health.saveReview({
      periodType: String(body.period_type ?? 'month'),
      periodStart: String(body.period_start ?? ''), periodEnd: String(body.period_end ?? ''),
      summaryText: String(body.summary ?? ''), nextPlan: String(body.next_plan ?? ''),
      metrics: (body.metrics ?? {}) as Record<string, unknown>,
    }));
  });

  app.get('/api/health/reminders', async () => ({ reminders: health.listReminders() }));

  app.post('/api/health/reminders', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => health.saveReminder({
      reminderType: String(body.reminder_type ?? ''),
      enabled: body.enabled === true,
      remindTime: String(body.remind_time ?? '21:00'),
      message: String(body.message ?? ''),
    }));
  });

  // ---------- Excel 导出 ----------
  app.get('/api/export/sheet/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    try {
      const result = await exportService.exportSheet(name);
      xlsxReply(reply, result.buffer, result.filename);
      return reply;
    } catch (error) {
      const record = error as { message?: string };
      return reply.status(404).send({ detail: record.message ?? '导出失败' });
    }
  });

  app.get('/api/export/report/scores', async (request, reply) => {
    const { exam = '月考1' } = request.query as { exam?: string };
    try {
      const result = await exportService.exportScoreReport(exam);
      xlsxReply(reply, result.buffer, result.filename);
      return reply;
    } catch (error) {
      const record = error as { message?: string };
      return reply.status(404).send({ detail: record.message ?? '导出失败' });
    }
  });

  app.get('/api/export/report/attendance', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const result = await exportService.exportAttendanceReport(query.date_from ?? '', query.date_to ?? '');
    xlsxReply(reply, result.buffer, result.filename);
    return reply;
  });

  // ---------- 备份 ----------
  app.post('/api/system/backup', async (_request, reply) => {
    try {
      const filename = await dbModule().createBackup('manual');
      return { ok: true, filename };
    } catch (error) {
      return reply.status(400).send({ detail: (error as Error).message });
    }
  });

  app.get('/api/system/backups', async () => {
    const backupsDir = dbModule().backupDir();
    const fs = await import('node:fs');
    if (!fs.existsSync(backupsDir)) return { backups: [] };
    const backups = fs.readdirSync(backupsDir)
      .filter((name: string) => name.endsWith('.db'))
      .map((name: string) => {
        const stat = fs.statSync(requirePath(backupsDir, name));
        return { filename: name, size: stat.size, modified: stat.mtimeMs / 1000 };
      })
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
        Number(b.modified) - Number(a.modified));
    return { backups };
  });

  app.get('/api/system/backup/:filename', async (request, reply) => {
    const { filename } = request.params as { filename: string };
    try {
      const target = safeBackupPath(dbModule().backupDir(), filename);
      return reply.send(await import('node:fs').then((fs) => fs.promises.readFile(target)));
    } catch (error) {
      return reply.status(404).send({ detail: (error as Error).message });
    }
  });

  app.post('/api/system/restore', async (request, reply) => {
    const data = await readUpload(request);
    try {
      return await restoreFromBuffer(data.buffer);
    } catch (error) {
      return reply.status(400).send({ detail: (error as Error).message });
    }
  });

  // ---------- 迁移包 ----------
  app.post('/api/system/migration/export', async (request, reply) => {
    if (!requireLocal(request, reply)) return reply;
    try {
      const filename = await migrationService.createPackage();
      return { ok: true, filename };
    } catch (error) {
      return reply.status(400).send({ detail: (error as Error).message });
    }
  });

  app.get('/api/system/migration/:filename', async (request, reply) => {
    if (!requireLocal(request, reply)) return reply;
    const { filename } = request.params as { filename: string };
    try {
      const target = safeBackupPath(dbModule().backupDir(), filename);
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      return reply.send(await import('node:fs').then((fs) => fs.promises.readFile(target)));
    } catch (error) {
      return reply.status(404).send({ detail: (error as Error).message });
    }
  });

  app.post('/api/system/migration/import', async (request, reply) => {
    if (!requireLocal(request, reply)) return reply;
    const data = await readUpload(request);
    try {
      return await migrationService.restorePackage(data.buffer);
    } catch (error) {
      const status = error instanceof migrationService.MigrationError ? 400 : 500;
      return reply.status(status).send({ detail: (error as Error).message });
    }
  });

  // ---------- 更新 ----------
  app.get('/api/system/update/check', async (_request, _reply) => {
    try {
      return await updateService.checkForUpdate();
    } catch (error) {
    const record = error as { message?: string };
    let hint = '暂时无法检查更新';
    if (String(record.message).includes('HTTP 404')) hint = '尚未找到公开的 GitHub Release，请稍后重试。';
    else if (String(record.message).includes('HTTP 403')) hint = 'GitHub Release 暂时不可访问或触发限流，请稍后重试。';
    else if (String(record.message).includes('HTTP 401')) hint = 'GitHub Release 访问未授权，请稍后重试。';
    return {
      current_version: loadAppVersion(), latest_version: '',
      update_available: false, downloadable: false,
      error: `暂时无法检查更新：${hint}（${record.message}）`,
    };
    }
  });

  app.get('/api/system/update/status', async () => updateService.updateStatus());

  app.post('/api/system/update/install', async (request, reply) => {
    if (!isLocalHost(request.ip)) {
      return reply.status(403).send({ detail: '更新只能在工作台本机管理' });
    }
    const frozen = Boolean(process.env.MEIMEI_PACKAGED);
    if (!frozen) {
      return reply.status(400).send({ detail: '当前启动方式不支持直接安装更新，请使用正式安装版完成更新' });
    }
    if (updateService.isBusy()) {
      return { started: false, status: updateService.updateStatus().status };
    }
    updateService.startUpdateWorker(dbModule());
    return { started: true, status: 'starting' };
  });

  app.get('/api/system/update/installer-path', async (request, reply) => {
    const host = request.ip;
    if (!isLocalHost(host)) {
      return reply.status(403).send({ detail: '安装包信息只能在工作台本机获取' });
    }
    try {
      return updateService.installerPath(dbModule());
    } catch (error) {
      return reply.status(409).send({ detail: (error as Error).message });
    }
  });

}

function requireLocal(request: { ip: string }, reply: FastifyReply): boolean {
  if (!isLocalHost(request.ip)) {
    reply.status(403).send({ detail: '迁移包只能在工作台本机管理' });
    return false;
  }
  return true;
}

function safeBackupPath(backupsDir: string, filename: string): string {
  const clean = path.basename(filename);
  const target = path.resolve(backupsDir, clean);
  if (path.dirname(target) !== path.resolve(backupsDir)) {
    throw new Error('文件名不合法');
  }
  if (!fs.existsSync(target)) throw new Error('文件不存在');
  return target;
}

function requirePath(dir: string, name: string): string {
  return path.join(dir, name);
}

async function readUpload(request: { file?: () => Promise<{
  toBuffer: () => Promise<Buffer>; filename?: string;
} | undefined> }): Promise<{ buffer: Buffer; filename: string }> {
  if (typeof request.file === 'function') {
    const part = await request.file();
    if (!part) return { buffer: Buffer.alloc(0), filename: '' };
    return { buffer: await part.toBuffer(), filename: part.filename ?? '' };
  }
  return { buffer: Buffer.alloc(0), filename: '' };
}
