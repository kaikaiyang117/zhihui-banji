import type { Database } from 'better-sqlite3';

import { getDb } from '../../services/context.js';
import type { ArtifactAccess, ExcelImportPlan } from '../domain/types.js';
import { hashBusinessEffect } from '../domain/hash.js';
import { requireArtifact } from '../artifacts/artifactRepository.js';
import {
  getImportPlan, requireImportPlan, saveImportPreview, markImportPlanStatus,
} from './importPlanRepository.js';
import { getImportAdapter } from './adapterRegistry.js';

export class ExcelImportExecutionError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function contextOf(plan: ExcelImportPlan, access: ArtifactAccess, conn: Database) {
  const artifact = requireArtifact(plan.artifactId, access, conn);
  const adapter = getImportAdapter(plan.adapterId);
  return {
    artifact, adapter,
    context: {
      artifact, plan, mappings: plan.mappings, options: plan.options,
    },
  };
}

export async function previewImportPlan(
  id: string, access: ArtifactAccess, conn?: Database,
): Promise<ExcelImportPlan> {
  const db = connOf(conn);
  const plan = requireImportPlan(id, access, db);
  const { adapter, context } = contextOf(plan, access, db);
  const rawPreview = await adapter.preview(context);
  const preview = {
    ...rawPreview,
    business_effect_hash: String(rawPreview.business_effect_hash ?? hashBusinessEffect({
      module: plan.adapterId,
      rows: Array.isArray(rawPreview.rows) ? rawPreview.rows : [],
    })),
  };
  return saveImportPreview(id, {
    ...preview,
    plan_id: plan.id,
    artifact_id: plan.artifactId,
    adapter_id: plan.adapterId,
    plan_hash: plan.planHash,
  }, access, db);
}

export async function executeImportPlan(options: {
  id: string;
  previewHash: string;
  requestId: string;
  access: ArtifactAccess;
  conn?: Database;
}): Promise<Record<string, unknown>> {
  const db = connOf(options.conn);
  const plan = requireImportPlan(options.id, options.access, db);
  if (plan.status !== 'awaiting_confirmation' || !plan.preview || !plan.previewHash) {
    throw new ExcelImportExecutionError('请先生成导入预览并完成确认');
  }
  if (plan.previewHash !== options.previewHash) {
    throw new ExcelImportExecutionError('导入预览已失效，请重新预览');
  }
  const { adapter, context } = contextOf(plan, options.access, db);
  if (plan.adapterVersion !== adapter.version) {
    throw new ExcelImportExecutionError('导入适配器版本已更新，请重新生成计划和预览');
  }
  // WorkbookArtifact adapters prepare/parse asynchronously, then commit and
  // verify synchronously inside one SQLite transaction.  A failed post-write
  // verification therefore rolls back the business writes instead of leaving
  // a partially trusted import behind.
  if (adapter.prepare && adapter.commitPrepared && adapter.verifySync) {
    const prepared = await adapter.prepare(context);
    const expectedEffectHash = String(plan.preview.business_effect_hash ?? '');
    const freshEffectHash = String(prepared.preview.business_effect_hash ?? '');
    if (!expectedEffectHash || !freshEffectHash || expectedEffectHash !== freshEffectHash) {
      throw new ExcelImportExecutionError('目标数据已发生变化，请重新生成导入预览后再确认');
    }
    try {
      return db.transaction(() => {
        const result = adapter.commitPrepared!({ ...context, requestId: options.requestId }, prepared);
        const verification = adapter.verifySync!({ ...context, requestId: options.requestId }, result);
        if (!verification.verified) {
          throw new ExcelImportExecutionError(`导入写入验证失败：${verification.evidence}`);
        }
        markImportPlanStatus(plan.id, 'executed', options.access, db);
        return {
          plan_id: plan.id, status: 'executed', result, verification, request_id: options.requestId,
        };
      })();
    } catch (error) {
      try { markImportPlanStatus(plan.id, 'failed', options.access, db); } catch { /* preserve original */ }
      throw error;
    }
  }
  const result = await adapter.execute({ ...context, requestId: options.requestId });
  const verification = await adapter.verify({ ...context, requestId: options.requestId }, result);
  if (!verification.verified) {
    markImportPlanStatus(plan.id, 'failed', options.access, db);
    throw new ExcelImportExecutionError(`导入写入验证失败：${verification.evidence}`);
  }
  markImportPlanStatus(plan.id, 'executed', options.access, db);
  return {
    plan_id: plan.id,
    status: 'executed',
    result,
    verification,
    request_id: options.requestId,
  };
}

export function getPlanForAccess(id: string, access: ArtifactAccess, conn?: Database): ExcelImportPlan {
  const plan = getImportPlan(id, access, connOf(conn));
  if (!plan) throw new ExcelImportExecutionError('导入计划不存在或不属于当前会话');
  return plan;
}
