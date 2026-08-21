import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';
import { ensureSystemTemplates, listTemplates } from '../../src/services/notificationTemplates.js';
import { generateNotificationDraft } from '../../src/agent/notificationDrafter.js';

let tempDir: string;
let db: WorkbenchDb;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-templates-'));
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
});

afterEach(() => {
  db.close();
  setDatabase(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('通知模板 AI 草稿', () => {
  it('提供八类系统通知场景', () => {
    ensureSystemTemplates();
    expect(listTemplates().map(item => item.scene)).toEqual([
      '放假通知', '安全提醒', '调课通知', '班级活动',
      '缴费回执', '学习提醒', '家长会', '材料收集',
    ]);
  });

  it('先生成事实底稿，再调用模型润色并返回原文', async () => {
    ensureSystemTemplates();
    const template = listTemplates({ scene: '放假通知' })[0];
    const calls: Array<Array<Record<string, unknown>>> = [];
    const modelClient = {
      async complete(messages: Array<Record<string, unknown>>) {
        calls.push(messages);
        return {
          content: '各位家长：根据学校安排，2026-04-15至2026-04-17放假，2026-04-18正常返校上课。请合理安排假期时间并注意安全。我的班级班主任',
          tool_calls: [],
          reasoning_content: '',
          usage: null,
        };
      },
    };

    const result = await generateNotificationDraft({
      templateId: Number(template.id),
      variableValues: {
        holiday_start: '2026-04-15',
        holiday_end: '2026-04-17',
        return_date: '2026-04-18',
      },
      modelClient,
    });

    expect(calls).toHaveLength(1);
    expect(result.content).toContain('2026-04-18');
    expect(result.source_content).toContain('2026-04-15');
    expect(result.content).not.toBe(result.source_content);
  });

  it('缺少必填变量时不会调用模型', async () => {
    ensureSystemTemplates();
    const template = listTemplates({ scene: '放假通知' })[0];
    let called = false;
    const modelClient = {
      async complete() {
        called = true;
        return { content: '不应生成', tool_calls: [], reasoning_content: '', usage: null };
      },
    };

    await expect(generateNotificationDraft({
      templateId: Number(template.id),
      variableValues: { holiday_start: '2026-04-15' },
      modelClient,
    })).rejects.toThrow('请填写必填变量');
    expect(called).toBe(false);
  });

  it('允许 AI 润色自然语言变量，但仍校验结构化事实', async () => {
    ensureSystemTemplates();
    const template = listTemplates({ scene: '安全提醒' })[0];
    const modelClient = {
      async complete() {
        return {
          content: '各位家长：请提醒孩子注意夏季防溺水安全，做好必要防护。我的班级班主任',
          tool_calls: [],
          reasoning_content: '',
          usage: null,
        };
      },
    };

    const result = await generateNotificationDraft({
      templateId: Number(template.id),
      variableValues: { reminder_content: '夏天防溺水' },
      modelClient,
    });

    expect(result.content).toContain('夏季防溺水');
  });
});
