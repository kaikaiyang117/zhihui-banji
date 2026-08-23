import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { getDb, scopeIds } from '../services/context.js';
import * as audit from '../services/audit.js';
import { ToolError, buildRegistry, type ToolRegistry } from './toolRegistry.js';
import { getPlanForAccess } from '../excel/imports/importPlanService.js';

const ACTION_TTL_MINUTES = 10;
const WRITE_TOOLS: Record<string, string> = {
  create_task: '创建待办',
  record_communication: '记录家校沟通',
  save_attendance: '保存考勤',
  record_points: '记录行为积分',
  update_task: '修改待办',
  create_event: '记录学生事件',
  create_focus: '创建重点关注',
  create_meeting: '记录班会',
  create_activity: '记录班级活动',
  create_diary: '记录班主任日志',
  create_knowledge_note: '创建知识库笔记',
  create_class_task: '创建班级任务',
  submit_roll_call_exceptions: '提交点名异常',
  execute_excel_import: '执行 Excel 导入',
};
const WRITE_FIELDS: Record<string, [ReadonlySet<string>, ReadonlySet<string>]> = {
  create_task: [
    new Set(['title']),
    new Set(['title', 'student_id', 'owner', 'scheduled_at', 'due_at', 'priority', 'notes']),
  ],
  record_communication: [
    new Set(['student_id', 'communicated_at', 'method', 'reason', 'summary']),
    new Set(['student_id', 'communicated_at', 'method', 'reason', 'summary',
      'feedback', 'agreement', 'followup_at', 'status', 'event_id']),
  ],
  save_attendance: [
    new Set(['student_id', 'date', 'status']),
    new Set(['student_id', 'date', 'scene', 'status', 'reason', 'arrive', 'leave', 'note']),
  ],
  record_points: [
    new Set(['student_id', 'amount', 'reason']),
    new Set(['student_id', 'amount', 'occurred_at', 'category', 'reason']),
  ],
  update_task: [
    new Set(['task_id']),
    new Set(['task_id', 'title', 'owner', 'priority', 'scheduled_at', 'due_at', 'status', 'notes', 'result']),
  ],
  create_event: [
    new Set(['student_id', 'occurred_at', 'event_type', 'description']),
    new Set(['student_id', 'occurred_at', 'event_type', 'description', 'handling', 'parent_contacted',
      'needs_followup', 'followup_due', 'status']),
  ],
  create_focus: [
    new Set(['student_id', 'topic', 'reason']),
    new Set(['student_id', 'topic', 'reason', 'evidence', 'action_plan', 'status', 'next_review_at']),
  ],
  create_meeting: [
    new Set(['held_on', 'topic']),
    new Set(['held_on', 'topic', 'format', 'content', 'participation', 'conclusion', 'status', 'student_ids',
      'action_items', 'followup_title', 'followup_due']),
  ],
  create_activity: [
    new Set(['occurred_on', 'name']),
    new Set(['occurred_on', 'name', 'activity_type', 'budget', 'participant_count', 'summary', 'result',
      'retrospective', 'status', 'student_ids', 'followup_title', 'followup_due']),
  ],
  create_diary: [
    new Set(['diary_date']),
    new Set(['diary_date', 'weather', 'work', 'event', 'reflection', 'todo']),
  ],
  create_knowledge_note: [
    new Set(['title']),
    new Set(['title', 'category', 'template', 'content', 'tags']),
  ],
  create_class_task: [
    new Set(['title', 'student_ids']),
    new Set(['title', 'student_ids', 'task_type', 'start_at', 'due_at', 'material_name', 'description', 'template_id']),
  ],
  submit_roll_call_exceptions: [
    new Set(['session_id', 'exceptions']),
    new Set(['session_id', 'exceptions']),
  ],
  execute_excel_import: [
    new Set(['plan_id', 'preview_hash']),
    new Set(['plan_id', 'preview_hash', 'request_id']),
  ],
};

export class ActionError extends Error {}

export function getRegistry(): ToolRegistry {
  return buildRegistry();
}

export function listTools(channel = 'local'): Array<Record<string, unknown>> {
  return getRegistry().list().filter((tool) =>
    (tool['allow_channels'] as string[]).includes(channel));
}

export function modelTools(): Array<Record<string, unknown>> {
  return getRegistry().modelTools();
}

export function isWriteTool(name: string): boolean {
  return name in WRITE_TOOLS;
}

export function actionsAllowed(channel: string, toolName: string): boolean {
  const definition = getRegistry().list().find((tool) => tool['name'] === toolName);
  const channels = definition?.['allow_channels'];
  return toolName in WRITE_TOOLS && Array.isArray(channels) && channels.includes(channel);
}

function nowStamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function stampOf(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

const SENSITIVE_MARKERS = [
  'key', 'token', 'secret', 'password', 'credential', 'authorization',
  '密码', '电话', '手机', '地址', '住址',
];

function sanitizeArguments(value: unknown, key = ''): unknown {
  if (SENSITIVE_MARKERS.some((marker) => key.toLowerCase().includes(marker.toLowerCase()))) {
    return '***';
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeArguments(item));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
      result[String(innerKey)] = sanitizeArguments(innerValue, String(innerKey));
    }
    return result;
  }
  const raw = value === null || value === undefined ? '' : String(value);
  return raw.slice(0, 200);
}

function recordAudit(
  channel: string, actorId: string, name: string, args: Record<string, unknown>,
  status: string, resultSummary: string,
): void {
  const conn = getDb().connInstance;
  conn.prepare(
    'INSERT INTO agent_audit(channel, actor_id, tool_name, arguments, status, result_summary) '
    + 'VALUES(?,?,?,?,?,?)',
  ).run(channel, actorId, name, canonicalJson(sanitizeArguments(args)), status, resultSummary);
}

function summaryText(result: Record<string, unknown>): string {
  if ('student_count' in result) return `班级共有 ${result['student_count']} 名学生`;
  if ('summary' in result && 'records' in result) {
    return `返回考勤统计和 ${(result['records'] as unknown[]).length} 条记录`;
  }
  if ('exams' in result) return `返回 ${(result['exams'] as unknown[]).length} 组成绩`;
  if ('tasks' in result) return `返回 ${(result['tasks'] as unknown[]).length} 条待办`;
  if ('communications' in result) {
    return `返回 ${(result['communications'] as unknown[]).length} 条家校沟通记录`;
  }
  if ('students' in result) return `返回 ${(result['students'] as unknown[]).length} 名学生`;
  if ('timeline' in result) return `返回 ${(result['timeline'] as unknown[]).length} 条时间线记录`;
  return '调用成功';
}

export function expireActions(conn: Database): void {
  conn.prepare(
    "UPDATE agent_actions SET status='expired' WHERE status='pending' AND expires_at<?",
  ).run(nowStamp());
}

export function previewText(toolName: string, args: Record<string, unknown>): string {
  const label = WRITE_TOOLS[toolName];
  let detail: string;
  if (toolName === 'create_task') {
    const target = args['student_id'] ? `学生 ${args['student_id']}` : '班级';
    detail = `${target}创建待办“${String(args['title'] ?? '')}”`;
  } else if (toolName === 'record_communication') {
    detail = `为学生 ${args['student_id']} 记录${String(args['method'] ?? '沟通')}沟通`;
  } else if (toolName === 'save_attendance') {
    detail = `记录 ${String(args['date'] ?? '')} ${String(args['scene'] ?? '常规到校')} 的学生 `
      + `${args['student_id']} 为“${String(args['status'] ?? '')}”`;
  } else if (toolName === 'record_points') {
    detail = `为学生 ${args['student_id']} 记录 ${args['amount']} 分行为积分`;
  } else if (toolName === 'update_task') {
    const status = args['status'] ? `，状态改为“${args['status']}”` : '';
    detail = `修改待办 ${args['task_id']}${status}`;
  } else if (toolName === 'create_event') {
    detail = `为学生 ${args['student_id']} 记录“${String(args['event_type'] ?? '')}”事件`;
  } else if (toolName === 'create_focus') {
    detail = `为学生 ${args['student_id']} 创建重点关注“${String(args['topic'] ?? '')}”`;
  } else if (toolName === 'create_meeting') {
    detail = `记录 ${String(args['held_on'] ?? '')} 的班会“${String(args['topic'] ?? '')}”`;
  } else if (toolName === 'create_activity') {
    detail = `记录 ${String(args['occurred_on'] ?? '')} 的班级活动“${String(args['name'] ?? '')}”`;
  } else if (toolName === 'create_diary') {
    detail = `记录 ${String(args['diary_date'] ?? '')} 的班主任日志`;
  } else if (toolName === 'create_knowledge_note') {
    detail = `在知识库创建笔记“${String(args['title'] ?? '')}”`;
  } else if (toolName === 'submit_roll_call_exceptions') {
    const count = Array.isArray(args['exceptions']) ? args['exceptions'].length : 0;
    detail = `提交点名异常 ${count} 人`;
  } else if (toolName === 'execute_excel_import') {
    detail = `导入 Excel 计划 ${String(args['plan_id'] ?? '')}`;
  } else {
    detail = `为 ${Array.isArray(args['student_ids']) ? args['student_ids'].length : 0} 名学生创建班级任务"${String(args['title'] ?? '')}"`;
  }
  return `将要${detail}。这是一次${label}，回复“确认”执行，回复“取消”放弃。确认有效期 ${ACTION_TTL_MINUTES} 分钟。`;
}

function excelActionPreview(options: {
  args: Record<string, unknown>; sessionId: string; actorId: string; channel: string; conn: Database;
}): Record<string, unknown> | null {
  const planId = String(options.args.plan_id ?? '').trim();
  if (!planId) return null;
  const [classId, termId] = scopeIds({ conn: options.conn });
  const plan = getPlanForAccess(planId, {
    ownerId: options.actorId, channel: options.channel, sessionId: options.sessionId, classId, termId,
  }, options.conn);
  if (!plan.preview || !plan.previewHash || plan.previewHash !== String(options.args.preview_hash ?? '')) {
    throw new ActionError('Excel 业务预览已失效，请重新生成预览');
  }
  return {
    plan_id: plan.id, adapter_id: plan.adapterId, artifact_id: plan.artifactId,
    preview_hash: plan.previewHash, preview: plan.preview,
  };
}

function excelActionPreviewText(value: Record<string, unknown> | null): string {
  const preview = value?.preview as Record<string, unknown> | undefined;
  if (!preview) return 'Excel 导入预览已准备，请确认导入。';
  return `准备导入：新增 ${Number(preview.new_count ?? 0)}，更新 ${Number(preview.update_count ?? 0)}，`
    + `跳过 ${Number(preview.skip_count ?? 0)}，错误 ${Number(preview.error_rows ?? 0)}。点击“导入”后才会修改业务数据。`;
}

function validatePositiveInt(key: string, value: unknown): void {
  let parsed: number;
  if (typeof value === 'number') {
    parsed = Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
  } else if (typeof value === 'bigint') {
    parsed = Number(value);
  } else if (typeof value === 'string' && /^\s*[-+]?\d+\s*$/.test(value)) {
    parsed = Number(value);
  } else {
    parsed = Number.NaN;
  }
  if (!Number.isInteger(parsed) || parsed < 1) throw new ActionError(`${key}必须是正整数`);
}

function actionFloat(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new ActionError('积分分值必须是非零数字');
}

export function validateArguments(toolName: string, args: Record<string, unknown>): void {
  const [required, allowed] = WRITE_FIELDS[toolName];
  const unknown = Object.keys(args).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new ActionError(`工具参数不支持：${unknown.join(', ')}`);
  const missing = [...required].filter((key) => !(key in args)).sort();
  if (missing.length > 0) throw new ActionError(`缺少工具参数：${missing.join(', ')}`);
  for (const key of ['student_id', 'event_id']) {
    if (key in args && args[key] != null) validatePositiveInt(key, args[key]);
  }
  if (toolName === 'record_points') {
    const amount = actionFloat(args['amount']);
    if (amount === 0) throw new ActionError('积分分值必须是非零数字');
  }
  if (toolName === 'update_task' && Object.keys(args).length <= 1) {
    throw new ActionError('修改待办至少需要提供一个修改字段');
  }
  if (['create_meeting', 'create_activity'].includes(toolName)
    && 'student_ids' in args && !Array.isArray(args.student_ids)) {
    throw new ActionError('student_ids必须是学生 ID 或学号数组');
  }
  if (toolName === 'create_class_task'
    && (!Array.isArray(args.student_ids) || args.student_ids.length === 0)) {
    throw new ActionError('班级任务至少需要选择一名学生');
  }
  if (toolName === 'submit_roll_call_exceptions'
    && (!Array.isArray(args.exceptions) || args.exceptions.length === 0)) {
    throw new ActionError('点名异常名单不能为空');
  }
}

export function createPendingAction(options: {
  toolName: string; args: Record<string, unknown>; sessionId: string; channel: string; actorId: string;
}): Record<string, unknown> {
  const { toolName, args, sessionId, channel, actorId } = options;
  if (!isWriteTool(toolName)) throw new ActionError('不是可确认的写入工具');
  if (!actionsAllowed(channel, toolName)) throw new ActionError('当前渠道没有该操作权限');
  if (!sessionId) throw new ActionError('写入操作缺少会话身份');
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ActionError('写入参数必须是对象');
  }
  validateArguments(toolName, args);
  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  const raw = canonicalJson(args);
  const argsHash = sha256(raw);
  expireActions(conn);
  const existing = conn.prepare(
    "SELECT * FROM agent_actions WHERE session_id=? AND actor_id=? AND arguments_hash=? AND status='pending' "
    + 'ORDER BY id DESC LIMIT 1',
  ).get(sessionId, actorId, argsHash) as Record<string, unknown> | undefined;
  const businessPreview = toolName === 'execute_excel_import'
    ? excelActionPreview({ args, sessionId, actorId, channel, conn }) : null;
  if (existing) {
    const item: Record<string, unknown> = { ...existing };
    item['confirmation_required'] = true;
    item['action_id'] = item['id'];
    if (businessPreview) item['business_preview'] = businessPreview;
    return item;
  }
  const token = randomBytes(3).toString('hex').toUpperCase();
  const expiresAt = stampOf(new Date(Date.now() + ACTION_TTL_MINUTES * 60 * 1000));
  const preview = toolName === 'execute_excel_import'
    ? excelActionPreviewText(businessPreview) : previewText(toolName, args);
  const inserted = conn.prepare(
    'INSERT INTO agent_actions('
    + 'class_id, term_id, session_id, channel, actor_id, tool_name, '
    + 'arguments_json, arguments_hash, confirmation_hash, preview, expires_at'
    + ') VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING *',
  ).get(classId, termId, sessionId, channel, actorId, toolName, raw, argsHash,
    sha256(`${token}:${argsHash}`), preview, expiresAt) as Record<string, unknown>;
  const item: Record<string, unknown> = { ...inserted };
  item['confirmation_required'] = true;
  item['action_id'] = item['id'];
  item['confirmation_token'] = token;
  if (businessPreview) item['business_preview'] = businessPreview;
  audit.record('agent_action', Number(item['id']), 'preview', {
    status: 'success',
    summary: preview,
    params: { tool_name: toolName, arguments: args },
    classId, termId, conn,
  });
  return item;
}

export function invokeTool(
  name: string,
  argsValue?: Record<string, unknown> | null,
  options: { channel?: string; actorId?: string; sessionId?: string; confirmed?: boolean; allowSensitiveExcelValues?: boolean; allowManualExcelMapping?: boolean; approvedExcelMappings?: Array<{ sourceColumn: string; targetField: string }> } = {},
): Record<string, unknown> {
  const channel = options.channel ?? 'local';
  const actorId = options.actorId ?? '';
  const sessionId = options.sessionId ?? '';
  const confirmed = options.confirmed ?? false;
  const args = argsValue || {};
  const registry = getRegistry();
  const definition = registry.get(name);
  if (definition && definition.writeAction) {
    if (!actionsAllowed(channel, name)) {
      const message = '当前渠道没有该写入操作权限。';
      recordAudit(channel, actorId, name, args, 'denied', message);
      throw new ToolError(message, { code: 'permission_denied' });
    }
    if (!confirmed) {
      try {
        const result = createPendingAction({
          toolName: name, args, sessionId, channel, actorId,
        });
        recordAudit(channel, actorId, name, args, 'pending', String(result['preview'] ?? '等待确认'));
        return result;
      } catch (error) {
        if (!(error instanceof ActionError)) throw error;
        const message = error.message;
        recordAudit(channel, actorId, name, args, 'error', message);
        throw new ToolError(message, { code: 'confirmation_required' });
      }
    }
    throw new ToolError('写入操作必须通过确认接口执行', { code: 'permission_denied' });
  }
  if (definition && definition.sensitive && channel === 'wechat') {
    const message = '微信渠道默认不提供敏感档案字段，请在工作台网页端查看。';
    recordAudit(channel, actorId, name, args, 'denied', message);
    throw new ToolError(message, { code: 'permission_denied' });
  }
  if (definition && !definition.allowChannels.includes(channel)) {
    const message = '当前渠道没有该工具权限。';
    recordAudit(channel, actorId, name, args, 'denied', message);
    throw new ToolError(message, { code: 'permission_denied' });
  }
  let result: Record<string, unknown>;
  try {
    result = registry.execute(name, args, {
      channel, actorId, sessionId, allowSensitiveExcelValues: options.allowSensitiveExcelValues,
      allowManualExcelMapping: options.allowManualExcelMapping,
      approvedExcelMappings: options.approvedExcelMappings,
    });
  } catch (error) {
    if (error instanceof ToolError) {
      recordAudit(channel, actorId, name, args, 'error', error.message);
      throw error;
    }
    throw error;
  }
  recordAudit(channel, actorId, name, args, 'success', summaryText(result));
  return result;
}

/** 异步工具入口。Excel Artifact 读取需要异步解压工作簿，旧同步入口保持兼容。 */
export async function invokeToolAsync(
  name: string,
  argsValue?: Record<string, unknown> | null,
  options: { channel?: string; actorId?: string; sessionId?: string; confirmed?: boolean; allowSensitiveExcelValues?: boolean; allowManualExcelMapping?: boolean; approvedExcelMappings?: Array<{ sourceColumn: string; targetField: string }> } = {},
): Promise<Record<string, unknown>> {
  const channel = options.channel ?? 'local';
  const actorId = options.actorId ?? '';
  const sessionId = options.sessionId ?? '';
  const confirmed = options.confirmed ?? false;
  const args = argsValue || {};
  const registry = getRegistry();
  const definition = registry.get(name);
  if (definition && definition.writeAction) {
    if (!actionsAllowed(channel, name)) {
      const message = '当前渠道没有该写入操作权限。';
      recordAudit(channel, actorId, name, args, 'denied', message);
      throw new ToolError(message, { code: 'permission_denied' });
    }
    if (!confirmed) {
      try {
        const result = createPendingAction({ toolName: name, args, sessionId, channel, actorId });
        recordAudit(channel, actorId, name, args, 'pending', String(result['preview'] ?? '等待确认'));
        return result;
      } catch (error) {
        if (!(error instanceof ActionError)) throw error;
        const message = error.message;
        recordAudit(channel, actorId, name, args, 'error', message);
        throw new ToolError(message, { code: 'confirmation_required' });
      }
    }
    throw new ToolError('写入操作必须通过确认接口执行', { code: 'permission_denied' });
  }
  if (definition && definition.sensitive && channel === 'wechat') {
    const message = '微信渠道默认不提供敏感档案字段，请在工作台网页端查看。';
    recordAudit(channel, actorId, name, args, 'denied', message);
    throw new ToolError(message, { code: 'permission_denied' });
  }
  if (definition && !definition.allowChannels.includes(channel)) {
    const message = '当前渠道没有该工具权限。';
    recordAudit(channel, actorId, name, args, 'denied', message);
    throw new ToolError(message, { code: 'permission_denied' });
  }
  try {
    const result = await registry.executeAsync(name, args, {
      channel, actorId, sessionId, allowSensitiveExcelValues: options.allowSensitiveExcelValues,
      allowManualExcelMapping: options.allowManualExcelMapping,
      approvedExcelMappings: options.approvedExcelMappings,
    });
    recordAudit(channel, actorId, name, args, 'success', summaryText(result));
    return result;
  } catch (error) {
    if (error instanceof ToolError) {
      recordAudit(channel, actorId, name, args, 'error', error.message);
    }
    throw error;
  }
}

export function recordToolFailure(
  channel: string, actorId: string, name: string,
  args: Record<string, unknown>, status: string, message: string,
): void {
  recordAudit(channel, actorId, name, args, status, message);
}

export function recordToolEvent(
  channel: string, actorId: string, name: string,
  args: Record<string, unknown>, status: string, message: string,
): void {
  recordAudit(channel, actorId, name, args, status, message);
}

export function recordModelUsage(options: {
  sessionId: string; channel: string; actorId: string; model: string;
  status: string; durationMs?: number; usage?: Record<string, unknown> | null;
  errorMessage?: string;
}): void {
  const usage = options.usage ?? {};
  const conn = getDb().connInstance;
  conn.prepare(
    'INSERT INTO agent_model_usage('
    + 'session_id, channel, actor_id, model, status, duration_ms, '
    + 'prompt_tokens, completion_tokens, error_message'
    + ') VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(
    options.sessionId, options.channel, options.actorId, options.model, options.status,
    Number(options.durationMs ?? 0),
    Number(usage['prompt_tokens'] ?? 0),
    Number(usage['completion_tokens'] ?? 0),
    sanitizeErrorMessage(options.errorMessage ?? ''),
  );
}

export function listAudits(
  limit = 50, scope?: { channel: string; actorId: string },
): Array<Record<string, unknown>> {
  const conn = getDb().connInstance;
  const rawLimit = Number(limit);
  const capped = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(Math.trunc(rawLimit), 200)) : 50;
  const where = scope ? 'WHERE channel=? AND actor_id=? ' : '';
  const params: unknown[] = scope ? [scope.channel, scope.actorId, capped] : [capped];
  const rows = conn.prepare(
    'SELECT id, channel, actor_id, tool_name, arguments, status, result_summary, created_at '
    + `FROM agent_audit ${where}ORDER BY id DESC LIMIT ?`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const item = { ...row };
    try {
      item['arguments'] = JSON.parse(String(item['arguments']));
    } catch {
      // 保持原样
    }
    return item;
  });
}

export function usageStats(scope?: { channel: string; actorId: string }): Record<string, unknown> {
  const conn = getDb().connInstance;
  const where = scope ? ' WHERE channel=? AND actor_id=?' : '';
  const scopeParams: unknown[] = scope ? [scope.channel, scope.actorId] : [];
  const totals = conn.prepare(
    'SELECT COUNT(*) AS total, '
    + "SUM(CASE WHEN status IN ('success','pending','executed') THEN 1 ELSE 0 END) AS successful, "
    + "SUM(CASE WHEN status IN ('error','denied','retry_exhausted') THEN 1 ELSE 0 END) AS failed "
    + `FROM agent_audit${where}`,
  ).get(...scopeParams) as { total: number | null; successful: number | null; failed: number | null };
  const byTool = conn.prepare(
    'SELECT tool_name, COUNT(*) AS calls, '
    + "SUM(CASE WHEN status IN ('success','pending','executed') THEN 1 ELSE 0 END) AS successful, "
    + "SUM(CASE WHEN status IN ('error','denied','retry_exhausted') THEN 1 ELSE 0 END) AS failed "
    + `FROM agent_audit${where} GROUP BY tool_name ORDER BY calls DESC, tool_name`,
  ).all(...scopeParams) as Array<Record<string, unknown>>;
  const byChannel = conn.prepare(
    'SELECT channel, COUNT(*) AS calls, '
    + "SUM(CASE WHEN status IN ('success','pending','executed') THEN 1 ELSE 0 END) AS successful, "
    + "SUM(CASE WHEN status IN ('error','denied','retry_exhausted') THEN 1 ELSE 0 END) AS failed "
    + `FROM agent_audit${where} GROUP BY channel ORDER BY calls DESC, channel`,
  ).all(...scopeParams) as Array<Record<string, unknown>>;
  const modelWhere = scope ? ' WHERE channel=? AND actor_id=?' : '';
  const modelUsage = conn.prepare(
    'SELECT model, COUNT(*) AS calls, '
    + "SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successful, "
    + "SUM(CASE WHEN status<>'success' THEN 1 ELSE 0 END) AS failed, "
    + 'SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens, '
    + 'AVG(duration_ms) AS average_duration_ms '
    + `FROM agent_model_usage${modelWhere} GROUP BY model ORDER BY calls DESC, model`,
  ).all(...scopeParams) as Array<Record<string, unknown>>;
  const total = Number(totals.total ?? 0);
  const successful = Number(totals.successful ?? 0);
  const failed = Number(totals.failed ?? 0);
  return {
    tool_calls: {
      total,
      successful,
      failed,
      failure_rate: total > 0 ? Math.round((failed / total) * 10000) / 10000 : 0,
    },
    by_tool: byTool,
    by_channel: byChannel,
    model_usage: modelUsage,
    note: '模型 Token 与耗时仅在模型响应提供 usage 且客户端记录时统计。',
  };
}

function sanitizeErrorMessage(message: string): string {
  return String(message ?? '')
    .replace(/(api[_ -]?key|authorization|bearer|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=***')
    .slice(0, 300);
}
