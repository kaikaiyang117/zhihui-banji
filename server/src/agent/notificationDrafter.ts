import type { Database } from 'better-sqlite3';

import { ModelError, ModelResponse, OpenAICompatibleClient } from './modelClient.js';
import * as notificationTemplates from '../services/notificationTemplates.js';

export class NotificationAIDraftError extends Error {}

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

export interface NotificationDraftOptions {
  templateId: number;
  variableValues: Record<string, string>;
  instruction?: string;
  modelClient?: Pick<OpenAICompatibleClient, 'complete'>;
  model_client?: Pick<OpenAICompatibleClient, 'complete'>;
  conn?: Database;
}

export async function generateNotificationDraft(options: NotificationDraftOptions): Promise<{
  content: string;
  source_content: string;
  missingVariables: string[];
}> {
  const source = notificationTemplates.generateContent({
    templateId: options.templateId,
    variableValues: options.variableValues,
    conn: options.conn,
  });
  if (source.missingVariables.length > 0) {
    throw new NotificationAIDraftError(`请填写必填变量：${source.missingVariables.join('、')}`);
  }

  const template = notificationTemplates.getTemplate(options.templateId, { conn: options.conn });
  const client = options.modelClient ?? options.model_client ?? new OpenAICompatibleClient();
  const system = [
    '你是班主任的家校通知编辑助手。请把事实底稿改写成清晰、自然、适合发给家长的中文通知。',
    '事实底稿中的日期、班级、活动名称、要求和对象是唯一事实来源，必须全部保留，不得新增、推测、替换或改变任何事实。',
    '只输出通知正文，不要 Markdown、解释、标题前缀或引号；保留称呼和落款的正式语气。',
  ].join('');
  const user = {
    任务: '生成一版可人工审核的通知草稿',
    场景: String(template.scene ?? ''),
    模板名称: String(template.name ?? ''),
    事实底稿: source.content,
    变量: options.variableValues,
    老师补充要求: clip(options.instruction, 300),
  };

  let response: ModelResponse;
  try {
    response = await client.complete([
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(user) },
    ]);
  } catch (error) {
    if (error instanceof ModelError) throw new NotificationAIDraftError(error.message);
    throw error;
  }

  const content = clip(response.content, 4000);
  if (!content) throw new NotificationAIDraftError('AI 未返回通知内容，请稍后重试');

  const variables = Array.isArray(template.variables) ? template.variables as Array<{ name?: string; format?: string }> : [];
  const strictFormats = new Set(['date', 'time', 'class_name']);
  for (const variable of variables) {
    if (!variable.name || !strictFormats.has(String(variable.format))) continue;
    const fact = clip(source.resolvedValues[variable.name], 120);
    if (fact && fact.length > 1 && !content.includes(fact)) {
      throw new NotificationAIDraftError('AI 草稿未完整保留日期、时间或班级信息，请重试或使用原模板文案');
    }
  }

  return {
    content,
    source_content: source.content,
    missingVariables: source.missingVariables,
  };
}
