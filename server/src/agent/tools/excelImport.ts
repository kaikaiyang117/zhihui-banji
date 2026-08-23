import { randomUUID } from 'node:crypto';

import { currentActor } from '../../services/audit.js';
import { getCurrentScope } from '../../services/context.js';
import { getStoredArtifact, getStoredArtifactPath, inspectArtifact } from '../../excel/artifacts/artifactService.js';
import type { ArtifactAccess, FieldMapping, TableRegion } from '../../excel/domain/types.js';
import { createImportPlan, getImportPlan, updateImportPlan } from '../../excel/imports/importPlanRepository.js';
import { previewImportPlan } from '../../excel/imports/importPlanService.js';
import { listImportAdapters } from '../../excel/imports/adapterRegistry.js';
import {
  profileWorkbookRegion, queryWorkbookRegion, readWorkbookRange, type ExposurePolicy,
  type WorkbookQueryAggregate, type WorkbookQueryFilter, type QueryOperator,
} from '../../excel/query/workbookQuery.js';
import { ToolError, ToolDefinition, type ToolExecutionContext } from '../toolRegistry.js';

const ALL_CHANNELS = ['web', 'local', 'lan'];
const EXPOSURE_POLICIES: ExposurePolicy[] = ['structure_only', 'redacted_values', 'allowed_values'];

function accessFor(context?: ToolExecutionContext): ArtifactAccess {
  const scope = getCurrentScope();
  const actor = currentActor();
  return {
    ownerId: context?.actorId || actor.actorId,
    channel: context?.channel || actor.channel,
    sessionId: context?.sessionId || '',
    classId: scope.class_id,
    termId: scope.term_id,
  };
}

function artifactId(args: Record<string, unknown>): string {
  const id = String(args.artifact_id ?? '').trim();
  if (!id) throw new ToolError('缺少 artifact_id', { code: 'invalid_arguments', retryable: true });
  return id;
}

async function inspectWorkbook(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<Record<string, unknown>> {
  const artifact = await inspectArtifact(artifactId(args), accessFor(context));
  return {
    artifact_id: artifact.id,
    filename: artifact.filename,
    sha256: artifact.sha256,
    status: artifact.status,
    blueprint: artifact.blueprint,
    exposure_policy: 'structure_only',
  };
}

async function listRegions(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<Record<string, unknown>> {
  const artifact = await inspectArtifact(artifactId(args), accessFor(context));
  const sheetIndex = args.sheet_index === undefined ? null : Number(args.sheet_index);
  if (sheetIndex !== null && (!Number.isInteger(sheetIndex) || sheetIndex < 0)) {
    throw new ToolError('sheet_index 必须是非负整数', { code: 'invalid_arguments', retryable: true });
  }
  const sheets = (artifact.blueprint?.sheets ?? [])
    .filter(sheet => sheetIndex === null || sheet.index === sheetIndex)
    .map(sheet => ({ index: sheet.index, name: sheet.name, regions: sheet.regions }));
  return { artifact_id: artifact.id, sheets, exposure_policy: 'structure_only' };
}

async function suggestImportPlan(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<Record<string, unknown>> {
  const artifact = await inspectArtifact(artifactId(args), accessFor(context));
  const adapters = listImportAdapters();
  const suggestions = (artifact.blueprint?.sheets ?? []).flatMap(sheet => sheet.regions.flatMap(region => (
    adapters.map(adapter => {
      const detection = adapter.detect(region);
      return {
        adapter_id: adapter.id, adapter_label: adapter.label, adapter_version: adapter.version,
        sheet_index: sheet.index, sheet_name: sheet.name, region_id: region.id,
        region_range: region.range, confidence: detection.confidence, reason: detection.reason,
        fields: adapter.fields(), duplicate_strategies: adapter.duplicateStrategies(),
      };
    })
  ))).sort((left, right) => Number(right.confidence) - Number(left.confidence));
  return { artifact_id: artifact.id, suggestions, hint: '服务端已根据区域结构给出候选；模型不能自行伪造适配器或版本。' };
}

async function readRange(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<Record<string, unknown>> {
  const id = artifactId(args);
  const sheetIndex = Number(args.sheet_index ?? 0);
  const range = String(args.range ?? '').trim();
  const policy = String(args.exposure_policy ?? 'structure_only') as ExposurePolicy;
  if (!Number.isInteger(sheetIndex) || sheetIndex < 0) {
    throw new ToolError('sheet_index 必须是非负整数', { code: 'invalid_arguments', retryable: true });
  }
  if (!range) throw new ToolError('缺少 range', { code: 'invalid_arguments', retryable: true });
  if (!EXPOSURE_POLICIES.includes(policy)) {
    throw new ToolError('exposure_policy 不受支持', { code: 'invalid_arguments', retryable: true });
  }
  if (policy === 'allowed_values' && context?.allowSensitiveExcelValues !== true) {
    throw new ToolError('读取原始 Excel 单元格值需要用户明确授权；当前对话只允许结构或脱敏分析', {
      code: 'permission_denied', retryable: false,
    });
  }
  const access = accessFor(context);
  const artifact = getStoredArtifact(id, access);
  const result = await readWorkbookRange({
    filePath: getStoredArtifactPath(id, access), sheetIndex, range, exposurePolicy: policy,
  });
  return { artifact_id: artifact.id, ...result };
}

async function profileRegion(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<Record<string, unknown>> {
  const id = artifactId(args);
  const sheetIndex = Number(args.sheet_index ?? 0);
  const regionId = String(args.region_id ?? '').trim();
  if (!Number.isInteger(sheetIndex) || sheetIndex < 0 || !regionId) {
    throw new ToolError('需要有效的 sheet_index 和 region_id', { code: 'invalid_arguments', retryable: true });
  }
  const access = accessFor(context);
  const artifact = await inspectArtifact(id, access);
  const region = artifact.blueprint?.sheets.find(sheet => sheet.index === sheetIndex)?.regions
    .find(item => item.id === regionId) as TableRegion | undefined;
  if (!region) throw new ToolError('指定的数据区域不存在', { code: 'not_found', retryable: false });
  const result = await profileWorkbookRegion({
    filePath: getStoredArtifactPath(id, access), sheetIndex, region,
  });
  return { artifact_id: artifact.id, exposure_policy: 'structure_only', ...result };
}

async function queryRegion(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<Record<string, unknown>> {
  const id = artifactId(args);
  const sheetIndex = Number(args.sheet_index ?? 0);
  const regionId = String(args.region_id ?? '').trim();
  const policy = String(args.exposure_policy ?? 'structure_only') as ExposurePolicy;
  if (!Number.isInteger(sheetIndex) || sheetIndex < 0 || !regionId) {
    throw new ToolError('需要有效的 sheet_index 和 region_id', { code: 'invalid_arguments', retryable: true });
  }
  if (!EXPOSURE_POLICIES.includes(policy)) throw new ToolError('exposure_policy 不受支持', { code: 'invalid_arguments', retryable: true });
  if (policy === 'allowed_values' && context?.allowSensitiveExcelValues !== true) {
    throw new ToolError('读取原始 Excel 单元格值需要用户明确授权；当前对话只允许结构或脱敏分析', {
      code: 'permission_denied', retryable: false,
    });
  }
  const access = accessFor(context);
  const artifact = await inspectArtifact(id, access);
  const region = artifact.blueprint?.sheets.find(sheet => sheet.index === sheetIndex)?.regions
    .find(item => item.id === regionId) as TableRegion | undefined;
  if (!region) throw new ToolError('指定的数据区域不存在', { code: 'not_found', retryable: false });
  const filters = Array.isArray(args.filters) ? args.filters as WorkbookQueryFilter[] : [];
  const aggregate = Array.isArray(args.aggregate) ? args.aggregate as WorkbookQueryAggregate[] : [];
  const select = Array.isArray(args.select) ? args.select.map(String) : undefined;
  const sort = args.sort && typeof args.sort === 'object' ? args.sort as { column: string; direction?: 'asc' | 'desc' } : undefined;
  if (filters.some(filter => !filter || typeof filter.column !== 'string' || !['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'].includes(filter.op as QueryOperator))) {
    throw new ToolError('filters 参数不合法', { code: 'invalid_arguments', retryable: true });
  }
  const result = await queryWorkbookRegion({
    filePath: getStoredArtifactPath(id, access), sheetIndex, region, select, filters, sort, aggregate,
    limit: Number(args.limit ?? 50), exposurePolicy: policy,
  });
  return { artifact_id: artifact.id, ...result };
}

function mappingInput(value: unknown, context?: ToolExecutionContext): FieldMapping[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ToolError('mappings 必须是数组', { code: 'invalid_arguments', retryable: true });
  }
  const approvedMappings = context?.approvedExcelMappings ?? [];
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ToolError('mappings 中包含无效字段', { code: 'invalid_arguments', retryable: true });
    }
    const raw = item as Record<string, unknown>;
    const sourceColumn = String(raw.sourceColumn ?? '');
    const targetField = raw.targetField == null ? null : String(raw.targetField);
    const explicitlyApproved = raw.source === 'manual'
      && Boolean(context?.allowManualExcelMapping)
      && targetField !== null
      && approvedMappings.some(mapping => (
        mapping.sourceColumn.trim() === sourceColumn.trim()
        && mapping.targetField.trim() === targetField.trim()
      ));
    return {
      sourceColumn, targetField,
      source: raw.source === 'rule' ? 'rule' : raw.source === 'manual' ? 'manual' : 'ai',
      confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0,
      status: raw.status === 'ignored' ? 'ignored' : explicitlyApproved ? 'accepted' : 'needs_confirmation',
      reason: raw.reason == null ? undefined : String(raw.reason),
      // Explicitly strip the user-only approval bit from model tool input.
      confirmedByUser: explicitlyApproved,
    };
  });
}

function optionsInput(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolError('options 必须是对象', { code: 'invalid_arguments', retryable: true });
  }
  return value as Record<string, unknown>;
}

function createPlan(args: Record<string, unknown>, context?: ToolExecutionContext): Record<string, unknown> {
  const id = artifactId(args);
  const adapterId = String(args.adapter_id ?? '').trim();
  const regionId = String(args.region_id ?? '').trim();
  const sheetIndex = Number(args.sheet_index ?? 0);
  if (!adapterId || !regionId || !Number.isInteger(sheetIndex) || sheetIndex < 0) {
    throw new ToolError('需要有效的 adapter_id、sheet_index 和 region_id', { code: 'invalid_arguments', retryable: true });
  }
  const plan = createImportPlan({
    id: String(args.plan_id ?? randomUUID()), artifactId: id, adapterId,
    adapterVersion: args.adapter_version ? String(args.adapter_version) : undefined,
    sheetIndex, regionId, mappings: mappingInput(args.mappings, context), options: optionsInput(args.options),
    access: accessFor(context),
  });
  return { plan, confirmation_required: false, hint: '导入计划已创建；下一步需要生成业务预览，预览后才能请求确认写入。' };
}

function updatePlan(args: Record<string, unknown>, context?: ToolExecutionContext): Record<string, unknown> {
  const id = String(args.plan_id ?? '').trim();
  if (!id) throw new ToolError('缺少 plan_id', { code: 'invalid_arguments', retryable: true });
  const existing = getImportPlan(id, accessFor(context));
  if (!existing) throw new ToolError('导入计划不存在或不属于当前会话', { code: 'not_found', retryable: false });
  const plan = updateImportPlan({
    id, mappings: args.mappings === undefined ? undefined : mappingInput(args.mappings, context),
    options: args.options === undefined ? undefined : optionsInput(args.options), access: accessFor(context),
  });
  return { plan, confirmation_required: false, hint: '导入计划已更新；任何变更都会使旧预览失效。' };
}

async function previewPlan(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<Record<string, unknown>> {
  const id = String(args.plan_id ?? '').trim();
  if (!id) throw new ToolError('缺少 plan_id', { code: 'invalid_arguments', retryable: true });
  const plan = await previewImportPlan(id, accessFor(context));
  const needsInput = plan.status === 'needs_input' || plan.preview?.needs_input === true;
  return {
    plan,
    needs_input: needsInput,
    ready_for_authorization: !needsInput,
    hint: needsInput
      ? '业务预览发现字段信息不足，请先补充映射后再继续。'
      : '业务预览已生成；下一步将创建一次待授权的导入操作。',
  };
}

export function buildExcelImportTools(): ToolDefinition[] {
  return [
    new ToolDefinition({
      name: 'excel_inspect_workbook',
      description: '检查已上传 Excel 的工作簿结构、工作表、区域、表头和类型。只返回结构信息，不返回单元格值。',
      parameters: {
        type: 'object', properties: { artifact_id: { type: 'string' } },
        required: ['artifact_id'], additionalProperties: false,
      }, handler: inspectWorkbook, readOnly: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'excel_list_regions',
      description: '列出 Excel 中可识别的数据区域。先检查结构、再选择区域进行读取或分析。',
      parameters: {
        type: 'object', properties: {
          artifact_id: { type: 'string' }, sheet_index: { type: 'integer', minimum: 0 },
        }, required: ['artifact_id'], additionalProperties: false,
      }, handler: listRegions, readOnly: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'excel_suggest_import_plan',
      description: '根据已识别的数据区域和服务端适配器规则推荐导入模块、区域、字段能力和重复策略；不会写入业务数据。',
      parameters: {
        type: 'object', properties: { artifact_id: { type: 'string' } },
        required: ['artifact_id'], additionalProperties: false,
      }, handler: suggestImportPlan, readOnly: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'excel_read_range',
      description: '读取 Excel 指定范围的结构化结果。默认 structure_only，不向模型暴露单元格值；需要值时必须显式选择受限 exposure_policy。',
      parameters: {
        type: 'object', properties: {
          artifact_id: { type: 'string' }, sheet_index: { type: 'integer', minimum: 0 },
          range: { type: 'string', description: '例如 A1:D20，最多200行、50列' },
          exposure_policy: { type: 'string', enum: EXPOSURE_POLICIES, default: 'structure_only' },
        }, required: ['artifact_id', 'range'], additionalProperties: false,
      }, handler: readRange, readOnly: true, sensitive: true, allowChannels: ['web', 'local', 'lan'],
    }),
    new ToolDefinition({
      name: 'excel_profile_region',
      description: '统计 Excel 数据区域的行列数量、非空数、去重数和推断类型，不返回单元格值。',
      parameters: {
        type: 'object', properties: {
          artifact_id: { type: 'string' }, sheet_index: { type: 'integer', minimum: 0 },
          region_id: { type: 'string' },
        }, required: ['artifact_id', 'region_id'], additionalProperties: false,
      }, handler: profileRegion, readOnly: true, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'excel_query_region',
      description: '在本地对 Excel 区域执行受限筛选、排序和聚合。计算在本机完成，默认只返回统计结果，不把整表发送给模型。',
      parameters: {
        type: 'object', properties: {
          artifact_id: { type: 'string' }, sheet_index: { type: 'integer', minimum: 0 }, region_id: { type: 'string' },
          select: { type: 'array', items: { type: 'string' } },
          filters: { type: 'array', items: { type: 'object' } },
          sort: { type: 'object' }, aggregate: { type: 'array', items: { type: 'object' } },
          limit: { type: 'integer', minimum: 1, maximum: 200 }, exposure_policy: { type: 'string', enum: EXPOSURE_POLICIES },
        }, required: ['artifact_id', 'region_id'], additionalProperties: false,
      }, handler: queryRegion, readOnly: true, sensitive: true, allowChannels: ['web', 'local', 'lan'],
    }),
    new ToolDefinition({
      name: 'excel_create_import_plan',
      description: '根据 Artifact 的工作表区域和字段映射创建导入草稿计划。只保存计划，不写入业务数据；预览和确认仍是后续步骤。',
      parameters: {
        type: 'object', properties: {
          artifact_id: { type: 'string' }, plan_id: { type: 'string' },
          adapter_id: { type: 'string', enum: ['students', 'scores', 'calendar', 'timetable'] },
          adapter_version: { type: 'string' }, sheet_index: { type: 'integer', minimum: 0 },
          region_id: { type: 'string' }, mappings: { type: 'array' }, options: { type: 'object' },
        }, required: ['artifact_id', 'adapter_id', 'region_id'], additionalProperties: false,
      }, handler: createPlan, readOnly: false, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'excel_update_import_plan',
      description: '修改导入草稿的字段映射或适配器选项。只更新计划，不写入业务数据；修改后旧预览自动失效。',
      parameters: {
        type: 'object', properties: {
          plan_id: { type: 'string' }, mappings: { type: 'array' }, options: { type: 'object' },
        }, required: ['plan_id'], additionalProperties: false,
      }, handler: updatePlan, readOnly: false, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'excel_preview_import',
      description: '根据导入计划生成真实业务预览，包括新增、更新、跳过、错误行和字段映射；不会写入业务数据。',
      parameters: {
        type: 'object', properties: { plan_id: { type: 'string' } },
        required: ['plan_id'], additionalProperties: false,
      }, handler: previewPlan, readOnly: false, allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'execute_excel_import',
      description: '确认并执行已生成预览的 Excel 导入。系统会复核预览哈希、创建备份、执行适配器写入并验证结果。必须经过用户确认。',
      parameters: {
        type: 'object', properties: {
          plan_id: { type: 'string' }, preview_hash: { type: 'string' }, request_id: { type: 'string' },
        }, required: ['plan_id', 'preview_hash'], additionalProperties: false,
      }, handler: () => ({ confirmation_required: true }), readOnly: false, writeAction: true,
      allowChannels: ['web', 'local', 'lan'],
    }),
  ];
}
