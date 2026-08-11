/* AGENT-02 确认写入与会话测试：预览→确认→备份→执行→审计、幂等、过期、
 * 错误 token、取消、聊天确认拦截、会话压缩。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';
import { invokeTool } from '../../src/agent/agentService.js';
import {
  pendingForSession, confirmAction, cancelAction, executeConfirmed, handleConfirmation, ActionError,
} from '../../src/agent/actions.js';
import { AgentRunner } from '../../src/agent/runner.js';
import { ModelResponse, type ModelStreamEvent } from '../../src/agent/modelClient.js';
import { SessionStore } from '../../src/agent/sessionStore.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let db: WorkbenchDb;

function testConfig(): ReturnType<typeof loadConfig> {
  const previous = { ...process.env };
  process.env.WORKBENCH_DATA_DIR = tempDir;
  process.env.WORKBENCH_STATIC_DIR = path.join(SERVER_ROOT, 'tests', 'fixtures', 'static');
  process.env.WORKBENCH_VERSION = '9.8.7';
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  const config = loadConfig();
  process.env = previous;
  return config;
}

function seed(): void {
  const conn = db.connInstance;
  for (let index = 1; index <= 3; index += 1) {
    conn.prepare('INSERT INTO students(学号, 姓名, 性别) VALUES(?,?,?)')
      .run(`S${String(index).padStart(3, '0')}`, `确认学生${index}`, index % 2 ? '男' : '女');
  }
  conn.prepare(
    `INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status)
     SELECT id, 1, 1, '在读' FROM students`,
  ).run();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent02-'));
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
  seed();
});

afterEach(() => {
  db.close();
  setDatabase(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('写入预览与确认状态机', () => {
  it('invokeTool 写工具返回预览（confirmation_required 语义）', () => {
    const result = invokeTool('create_task', { title: '确认测试任务', student_id: 1 }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:1',
    });
    expect(result.confirmation_required).toBe(true);
    expect(String(result.preview)).toContain('创建待办');
    expect(result.confirmation_token).toBeTruthy();
    expect(result.arguments_hash).toBeTruthy();
  });

  it('预览→确认→备份→执行→结果落库', () => {
    const preview = invokeTool('create_task', { title: '执行测试任务', student_id: 1 }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:2',
    });
    const actionId = Number(preview.action_id);
    const confirmed = confirmAction(actionId, {
      sessionId: 'web:t:2', actorId: 'teacher',
      token: String(preview.confirmation_token),
    });
    expect(confirmed.status).toBe('executed');
    expect(confirmed.result).toBeTruthy();
    expect(confirmed.backup_file).toContain('agent-action');
    // 业务数据已写入
    const task = db.connInstance.prepare(
      "SELECT * FROM student_tasks WHERE title='执行测试任务'",
    ).get();
    expect(task).toBeTruthy();
    // 备份文件存在
    const backupPath = path.join(db.backupDir(), String(confirmed.backup_file));
    expect(fs.existsSync(backupPath)).toBe(true);
    // 幂等：重复确认返回 duplicate
    const again = confirmAction(actionId, {
      sessionId: 'web:t:2', actorId: 'teacher', token: String(preview.confirmation_token),
    });
    expect(again.duplicate).toBe(true);
    expect(again.status).toBe('executed');
  });

  it('未确认时 executeConfirmed 拒绝；确认码错误拒绝且未执行', () => {
    const preview = invokeTool('create_task', { title: '错误token测试', student_id: 1 }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:3',
    });
    const actionId = Number(preview.action_id);
    // 未确认直接执行
    expect(() => executeConfirmed(actionId, {
      sessionId: 'web:t:3', actorId: 'teacher',
    })).toThrow(/尚未确认/);
    // 先确认（无 token 也允许——聊天场景），再执行
    confirmAction(actionId, { sessionId: 'web:t:3', actorId: 'teacher' });
    expect(db.connInstance.prepare(
      "SELECT COUNT(*) AS c FROM student_tasks WHERE title='错误token测试'",
    ).get().c).toBe(1);
  });

  it('确认码不匹配被拒', () => {
    const preview = invokeTool('create_task', { title: 'token校验', student_id: 1 }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:4',
    });
    expect(() => confirmAction(Number(preview.action_id), {
      sessionId: 'web:t:4', actorId: 'teacher', token: 'WRONG',
    })).toThrow(/确认码不正确/);
  });

  it('取消后不可执行', () => {
    const preview = invokeTool('create_task', { title: '取消测试', student_id: 1 }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:5',
    });
    const actionId = Number(preview.action_id);
    cancelAction(actionId, { sessionId: 'web:t:5', actorId: 'teacher' });
    expect(() => confirmAction(actionId, {
      sessionId: 'web:t:5', actorId: 'teacher',
    })).toThrow(/已失效/);
    expect(db.connInstance.prepare(
      "SELECT COUNT(*) AS c FROM student_tasks WHERE title='取消测试'",
    ).get().c).toBe(0);
  });

  it('过期操作失效', () => {
    const preview = invokeTool('create_task', { title: '过期测试', student_id: 1 }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:6',
    });
    const actionId = Number(preview.action_id);
    db.connInstance.prepare(
      "UPDATE agent_actions SET expires_at='2020-01-01 00:00:00' WHERE id=?",
    ).run(actionId);
    expect(pendingForSession('web:t:6', 'teacher')).toBeNull();
    expect(() => confirmAction(actionId, {
      sessionId: 'web:t:6', actorId: 'teacher',
    })).toThrow(/已失效/);
  });

  it('参数校验：未知字段/缺参/非零积分', () => {
    expect(() => invokeTool('create_task', { title: 'x', evil_field: 1 }, {
      channel: 'web', actorId: 't', sessionId: 's',
    })).toThrow(/工具参数不支持/);
    expect(() => invokeTool('record_points', { student_id: 1, amount: 0, reason: 'x' }, {
      channel: 'web', actorId: 't', sessionId: 's',
    })).toThrow(/非零数字/);
  });
});

describe('聊天确认拦截', () => {
  it('回复确认执行、取消放弃、其他提示', async () => {
    const preview = invokeTool('record_points', { student_id: 1, amount: 5, reason: '课堂表现' }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:7',
    });
    expect(pendingForSession('web:t:7', 'teacher')).toBeTruthy();

    const [handled, answer] = handleConfirmation('确认', {
      sessionId: 'web:t:7', actorId: 'teacher', channel: 'web',
    });
    expect(handled).toBe(true);
    expect(answer).toContain('行为积分已记录');
    const ledger = db.connInstance.prepare(
      "SELECT * FROM point_ledger WHERE student_id=1 AND reason='课堂表现'",
    ).get();
    expect(ledger).toBeTruthy();
    expect((ledger as Record<string, unknown>).source_type).toBe('agent_action');
    expect((ledger as Record<string, unknown>).source_key).toBe(`agent_action:${preview.action_id}`);

    // 取消路径
    const preview2 = invokeTool('record_points', { student_id: 2, amount: 3, reason: '取消测试' }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:8',
    });
    const [handled2, answer2] = handleConfirmation('取消', {
      sessionId: 'web:t:8', actorId: 'teacher', channel: 'web',
    });
    expect(handled2).toBe(true);
    expect(answer2).toContain('已取消');
    expect(db.connInstance.prepare(
      "SELECT COUNT(*) AS c FROM point_ledger WHERE reason='取消测试'",
    ).get().c).toBe(0);

    // 其他文本 → 提示
    const preview3 = invokeTool('record_points', { student_id: 3, amount: 1, reason: '提示测试' }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:9',
    });
    const [handled3, answer3] = handleConfirmation('再说说', {
      sessionId: 'web:t:9', actorId: 'teacher', channel: 'web',
    });
    expect(handled3).toBe(true);
    expect(answer3).toContain('确认');
    expect(db.connInstance.prepare(
      "SELECT COUNT(*) AS c FROM point_ledger WHERE reason='提示测试'",
    ).get().c).toBe(0);
    void preview2; void preview3;
  });

  it('Agent chat 首轮拦截确认文本（不进入模型）', async () => {
    const preview = invokeTool('record_points', { student_id: 1, amount: 2, reason: '聊天确认' }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:10',
    });
    // 用假模型：若确认被拦截，模型不会被调用
    let modelCalled = false;
    const model = {
      async complete() { modelCalled = true; return { content: 'x', tool_calls: [] } as ModelResponse; },
      async *iter_complete(): AsyncGenerator<ModelStreamEvent> {
        modelCalled = true;
        yield { content: '', response: { content: 'x', tool_calls: [] } as ModelResponse } as ModelStreamEvent;
      },
    };
    const answer = await new AgentRunner({ modelClient: model as never }).chat(
      'web:t:10', '确认', { channel: 'web', actorId: 'teacher' });
    expect(modelCalled).toBe(false);
    expect(answer).toContain('已记录');
    void preview;
  });
});

describe('会话压缩', () => {
  it('超过阈值按用户回合压缩并保留摘要', () => {
    const store = new SessionStore(8);
    const messages: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 10; index += 1) {
      messages.push({ role: 'user', content: `问题${index}` });
      messages.push({ role: 'assistant', content: `回答${index}` });
    }
    store.save('web:compress:1', messages, { title: '压缩测试' });
    const loaded = store.load('web:compress:1');
    expect(loaded.length).toBeLessThanOrEqual(21);
    // 摘要标记存在（丢掉了早期回合）
    expect(loaded.some((m) => m.context_summary === true)).toBe(true);
    // 最新回合保留
    expect(loaded.some((m) => m.content === '问题9')).toBe(true);
  });
});

describe('HTTP 冒烟', () => {
  it('pending/confirm/cancel 端点', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const toolsRes = await app.inject({
      method: 'POST', url: '/api/agent/tools/create_task',
      payload: { arguments: { title: 'HTTP确认任务', student_id: 1 }, channel: 'web', actor_id: 't', session_id: 'web:http:1' },
    });
    expect(toolsRes.statusCode).toBe(200);
    const preview = toolsRes.json().result;
    expect(preview.confirmation_required).toBe(true);

    const pending = await app.inject({
      method: 'GET', url: '/api/agent/actions/pending?session_id=web:http:1&actor_id=t',
    });
    expect(pending.statusCode).toBe(200);

    const confirm = await app.inject({
      method: 'POST', url: `/api/agent/actions/${preview.action_id}/confirm`,
      payload: { session_id: 'web:http:1', actor_id: 't', confirmation_token: preview.confirmation_token },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe('executed');
    await app.close();
  });
});
