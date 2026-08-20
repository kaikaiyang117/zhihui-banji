import { SUPPORTED_MODULES } from '../../services/excelImportAssistant.js';
import { ToolError, ToolDefinition } from '../toolRegistry.js';

const ALL_CHANNELS = ['web', 'local', 'lan'];

function importExcelFile(args: Record<string, unknown>): Record<string, unknown> {
  const fileId = String(args.file_id ?? '').trim();
  if (!fileId) throw new ToolError('缺少 file_id，请先上传文件', { code: 'invalid_arguments', retryable: true });

  const module = String(args.module ?? '').trim();
  if (module && !SUPPORTED_MODULES.includes(module as typeof SUPPORTED_MODULES[number])) {
    throw new ToolError(`不支持的导入模块：${module}，可选值：${SUPPORTED_MODULES.join(', ')}`, { code: 'invalid_arguments', retryable: true });
  }

  return {
    file_id: fileId,
    module: module || null,
    hint: module ? '调用 import_excel_preview 生成预览' : '请确认导入模块后调用 import_excel_preview',
  };
}

function importExcelPreview(args: Record<string, unknown>): Record<string, unknown> {
  const fileId = String(args.file_id ?? '').trim();
  if (!fileId) throw new ToolError('缺少 file_id', { code: 'invalid_arguments', retryable: true });

  const module = String(args.module ?? '').trim();
  if (!module) throw new ToolError('缺少 module，请指定导入模块', { code: 'invalid_arguments', retryable: true });
  if (!SUPPORTED_MODULES.includes(module as typeof SUPPORTED_MODULES[number])) {
    throw new ToolError(`不支持的导入模块：${module}`, { code: 'invalid_arguments', retryable: true });
  }

  throw new ToolError(
    `Excel 预览暂不能通过 Agent 工具直接执行，请在工作台的“Excel 导入”面板中打开 ${fileId} 并选择“${module}”生成预览。`,
    { code: 'execution_failed', retryable: false },
  );
}

function confirmExcelImport(args: Record<string, unknown>): Record<string, unknown> {
  const fileId = String(args.file_id ?? '').trim();
  const module = String(args.module ?? '').trim();
  const previewHash = String(args.preview_hash ?? '').trim();

  if (!fileId || !module || !previewHash) {
    throw new ToolError('缺少 file_id、module 或 preview_hash', { code: 'invalid_arguments', retryable: true });
  }

  throw new ToolError(
    `Excel 导入写入必须在网页导入面板中确认，Agent 工具不会直接写入业务数据（文件 ${fileId}，预览 ${previewHash}）。`,
    { code: 'permission_denied', retryable: false },
  );
}

function cancelExcelImport(args: Record<string, unknown>): Record<string, unknown> {
  const fileId = String(args.file_id ?? '').trim();
  if (!fileId) throw new ToolError('缺少 file_id', { code: 'invalid_arguments', retryable: true });
  throw new ToolError(
    `请在工作台的“Excel 导入”面板中取消文件 ${fileId}；Agent 工具不会直接管理上传文件。`,
    { code: 'execution_failed', retryable: false },
  );
}

export function buildExcelImportTools(): ToolDefinition[] {
  return [
    new ToolDefinition({
      name: 'import_excel_file',
      description: '接收用户上传的Excel文件，返回文件标识和推荐的导入模块。不执行任何写入操作。需要用户先通过网页上传文件获得file_id。',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: '网页上传返回的文件标识' },
          module: { type: 'string', description: '用户指定的导入模块，可选值：students、scores、calendar、timetable。可为空，由系统根据表头自动推荐。' },
        },
        required: ['file_id'],
        additionalProperties: false,
      },
      handler: importExcelFile,
      readOnly: true,
      sensitive: false,
      allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'import_excel_preview',
      description: 'Excel 预览入口提示工具。实际预览必须通过网页“Excel 导入”面板调用 HTTP 导入服务；本工具不会伪造预览结果。',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: '上传文件标识' },
          module: { type: 'string', enum: ['students', 'scores', 'calendar', 'timetable'], description: '导入模块' },
          sheet_index: { type: 'integer', minimum: 0, description: '工作表索引（多工作表文件时指定），默认0' },
          duplicate_strategy: { type: 'string', enum: ['update', 'skip'], description: '重复记录策略，默认update' },
        },
        required: ['file_id', 'module'],
        additionalProperties: false,
      },
      handler: importExcelPreview,
      readOnly: true,
      sensitive: false,
      allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'confirm_excel_import',
      description: '兼容保留的 Excel 确认工具。Agent 不直接写入 Excel 导入；请在网页“Excel 导入”面板确认，避免绕过预览和权限校验。',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: '上传文件标识' },
          module: { type: 'string', enum: ['students', 'scores', 'calendar', 'timetable'], description: '导入模块' },
          preview_hash: { type: 'string', description: '预览返回的hash，用于校验预览未被篡改' },
        },
        required: ['file_id', 'module', 'preview_hash'],
        additionalProperties: false,
      },
      handler: confirmExcelImport,
      readOnly: true,
      writeAction: false,
      sensitive: false,
      allowChannels: ALL_CHANNELS,
    }),
    new ToolDefinition({
      name: 'cancel_excel_import',
      description: 'Excel 取消入口提示工具。实际取消必须通过网页“Excel 导入”面板调用 HTTP 导入服务。',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: '要取消的文件标识' },
        },
        required: ['file_id'],
        additionalProperties: false,
      },
      handler: cancelExcelImport,
      readOnly: true,
      sensitive: false,
      allowChannels: ALL_CHANNELS,
    }),
  ];
}
