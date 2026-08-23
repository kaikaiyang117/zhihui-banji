import type { Database } from 'better-sqlite3';

import { getDb } from '../../services/context.js';
import { hashPlan, hashPreview } from '../domain/hash.js';
import type {
  ArtifactAccess, ExcelImportPlan, FieldMapping, ImportPlanStatus,
} from '../domain/types.js';
import { requireArtifact } from '../artifacts/artifactRepository.js';
import { getImportAdapter } from './adapterRegistry.js';

export class ExcelImportPlanError extends Error {}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function parseJson(value: unknown, fallback: unknown): unknown {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function mapPlan(row: Record<string, unknown>): ExcelImportPlan {
  const mappings = parseJson(row.mappings_json, []);
  const options = parseJson(row.options_json, {});
  const preview = parseJson(row.preview_json, null);
  return {
    id: String(row.id),
    artifactId: String(row.artifact_id),
    adapterId: String(row.adapter_id),
    adapterVersion: String(row.adapter_version),
    sheetIndex: Number(row.sheet_index),
    regionId: String(row.region_id),
    mappings: Array.isArray(mappings) ? mappings as FieldMapping[] : [],
    options: options && typeof options === 'object' && !Array.isArray(options)
      ? options as Record<string, unknown> : {},
    classId: Number(row.class_id),
    termId: Number(row.term_id),
    status: String(row.status) as ImportPlanStatus,
    planHash: String(row.plan_hash),
    preview: preview && typeof preview === 'object' && !Array.isArray(preview)
      ? preview as Record<string, unknown> : null,
    previewHash: String(row.preview_hash ?? ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function planAccessWhere(access: ArtifactAccess): { sql: string; params: unknown[] } {
  return {
    sql: 'a.owner_id=? AND a.channel=? AND a.session_id=? AND p.class_id=? AND p.term_id=?',
    params: [access.ownerId, access.channel, access.sessionId, access.classId, access.termId],
  };
}

export function getImportPlan(id: string, access: ArtifactAccess, conn?: Database): ExcelImportPlan | null {
  const db = connOf(conn);
  const where = planAccessWhere(access);
  const row = db.prepare(
    `SELECT p.* FROM excel_import_plans p
       JOIN excel_artifacts a ON a.id=p.artifact_id
      WHERE p.id=? AND ${where.sql}`,
  ).get(id, ...where.params) as Record<string, unknown> | undefined;
  return row ? mapPlan(row) : null;
}

export function requireImportPlan(id: string, access: ArtifactAccess, conn?: Database): ExcelImportPlan {
  const plan = getImportPlan(id, access, conn);
  if (!plan) throw new ExcelImportPlanError('导入计划不存在或不属于当前会话');
  if (['cancelled', 'failed'].includes(plan.status)) {
    throw new ExcelImportPlanError('导入计划已失效，请重新创建');
  }
  return plan;
}

export function createImportPlan(input: {
  id: string;
  artifactId: string;
  adapterId: string;
  adapterVersion?: string;
  sheetIndex: number;
  regionId: string;
  mappings: FieldMapping[];
  options: Record<string, unknown>;
  access: ArtifactAccess;
  conn?: Database;
}): ExcelImportPlan {
  const db = connOf(input.conn);
  getImportAdapter(input.adapterId);
  const artifact = requireArtifact(input.artifactId, input.access, db);
  const blueprint = artifact.blueprint;
  const sheet = blueprint?.sheets[input.sheetIndex];
  if (!sheet) throw new ExcelImportPlanError('导入计划的工作表不存在');
  if (input.regionId && !sheet.regions.some(region => region.id === input.regionId)) {
    throw new ExcelImportPlanError('导入计划的数据区域不存在');
  }
  const adapterVersion = input.adapterVersion ?? '1';
  const planHash = hashPlan({
    artifactSha256: artifact.sha256,
    adapterId: input.adapterId,
    adapterVersion,
    sheetIndex: input.sheetIndex,
    regionId: input.regionId,
    mappings: input.mappings,
    options: input.options,
    classId: input.access.classId,
    termId: input.access.termId,
  });
  db.prepare(
    `INSERT INTO excel_import_plans
      (id, artifact_id, adapter_id, adapter_version, sheet_index, region_id,
       mappings_json, options_json, class_id, term_id, status, plan_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
  ).run(
    input.id, input.artifactId, input.adapterId, adapterVersion, input.sheetIndex,
    input.regionId, JSON.stringify(input.mappings), JSON.stringify(input.options),
    input.access.classId, input.access.termId, planHash,
  );
  const plan = getImportPlan(input.id, input.access, db);
  if (!plan) throw new ExcelImportPlanError('导入计划创建失败');
  return plan;
}

export function updateImportPlan(input: {
  id: string;
  mappings?: FieldMapping[];
  options?: Record<string, unknown>;
  status?: ImportPlanStatus;
  access: ArtifactAccess;
  conn?: Database;
}): ExcelImportPlan {
  const db = connOf(input.conn);
  const plan = requireImportPlan(input.id, input.access, db);
  if (input.status && ![
    'draft', 'needs_input', 'ready', 'previewed', 'awaiting_confirmation',
    'executed', 'failed', 'cancelled',
  ].includes(input.status)) {
    throw new ExcelImportPlanError('导入计划状态不合法');
  }
  const artifact = requireArtifact(plan.artifactId, input.access, db);
  const mappings = input.mappings ?? plan.mappings;
  const options = input.options ?? plan.options;
  const nextHash = hashPlan({
    artifactSha256: artifact.sha256,
    adapterId: plan.adapterId,
    adapterVersion: plan.adapterVersion,
    sheetIndex: plan.sheetIndex,
    regionId: plan.regionId,
    mappings,
    options,
    classId: input.access.classId,
    termId: input.access.termId,
  });
  db.prepare(
    `UPDATE excel_import_plans
        SET mappings_json=?, options_json=?, status=?, plan_hash=?,
            preview_json='', preview_hash='', updated_at=datetime('now','localtime')
      WHERE id=?`,
  ).run(JSON.stringify(mappings), JSON.stringify(options), input.status ?? 'draft', nextHash, input.id);
  const updated = getImportPlan(input.id, input.access, db);
  if (!updated) throw new ExcelImportPlanError('导入计划更新失败');
  return updated;
}

export function saveImportPreview(
  id: string, preview: Record<string, unknown>, access: ArtifactAccess, conn?: Database,
): ExcelImportPlan {
  const db = connOf(conn);
  const plan = requireImportPlan(id, access, db);
  const previewHash = hashPreview(plan.planHash, preview);
  db.prepare(
    `UPDATE excel_import_plans
        SET status='awaiting_confirmation', preview_json=?, preview_hash=?,
            updated_at=datetime('now','localtime')
      WHERE id=?`,
  ).run(JSON.stringify(preview), previewHash, id);
  const updated = getImportPlan(id, access, db);
  if (!updated) throw new ExcelImportPlanError('导入预览保存失败');
  return updated;
}

export function markImportPlanStatus(
  id: string, status: ImportPlanStatus, access: ArtifactAccess, conn?: Database,
): void {
  const db = connOf(conn);
  const plan = getImportPlan(id, access, db);
  if (!plan) throw new ExcelImportPlanError('导入计划不存在或不属于当前会话');
  if (plan.status === 'executed' && status !== 'executed') {
    throw new ExcelImportPlanError('已执行的导入计划不能回退状态');
  }
  db.prepare(
    `UPDATE excel_import_plans SET status=?, updated_at=datetime('now','localtime') WHERE id=?`,
  ).run(status, id);
}
