/* AGENT-01 LangGraph Harness 测试：确定性路由、计划执行、纠错、熔断、
 * 检查点恢复、流式事件序列（固定 mock 模型）。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';
import { AgentRunner } from '../../src/agent/runner.js';
import { type ModelResponse, type ModelStreamEvent } from '../../src/agent/modelClient.js';
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
    conn.prepare('INSERT INTO students(学号, 姓名, 性别, 班级任职, 监护人职业, 是否住校) VALUES(?,?,?,?,?,?)')
      .run(`S${String(index).padStart(3, '0')}`, `凯凯学生${index}`, index % 2 ? '男' : '女',
        index === 1 ? '班长' : '', index === 1 ? '务农' : index === 2 ? '教师' : '', index === 3 ? '住校' : '走读');
  }
  conn.prepare(
    `INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status)
     SELECT id, 1, 1, '在读' FROM students`,
  ).run();
}

class FakeModel {
  rounds: Array<Array<Record<string, unknown>>> = [];
  plan: Array<[string, Record<string, unknown>]>;
  answer: string;
  streamDeltas: string[];

  constructor(options: {
    plan?: Array<[string, Record<string, unknown>]>;
    answer?: string;
    streamDeltas?: string[];
  } = {}) {
    this.plan = options.plan ?? [];
    this.answer = options.answer ?? '查询完成。';
    this.streamDeltas = options.streamDeltas ?? [this.answer];
  }

  async complete(messages: Array<Record<string, unknown>>, _tools?: Array<Record<string, unknown>>): Promise<ModelResponse> {
    this.rounds.push(messages);
    if (this.plan.length > 0 && messages.some((m) => m.role === 'user')) {
      const [name, argumentsValue] = this.plan.shift()!;
      return { content: '', tool_calls: [{
        id: 'call-1', type: 'function',
        function: { name, arguments: JSON.stringify(argumentsValue) },
      }] } as ModelResponse;
    }
    return { content: this.answer, tool_calls: [] } as ModelResponse;
  }

  async *iter_complete(
    messages: Array<Record<string, unknown>>,
    _tools?: Array<Record<string, unknown>>,
  ): AsyncGenerator<ModelStreamEvent> {
    this.rounds.push(messages);
    for (const content of this.streamDeltas) {
      yield { content } as ModelStreamEvent;
    }
    const toolCalls = this.plan.length > 0 && messages.some((m) => m.role === 'user')
      ? [{ id: 'call-1', type: 'function',
        function: { name: this.plan[0][0], arguments: JSON.stringify(this.plan[0][1]) } }]
      : [];
    if (toolCalls.length > 0) {
      this.plan.shift();
      yield { content: '', response: { content: '', tool_calls: toolCalls } as ModelResponse } as ModelStreamEvent;
    } else {
      yield { content: '', response: { content: this.answer, tool_calls: [] } as ModelResponse } as ModelStreamEvent;
    }
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent01-'));
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

describe('确定性直接工具路由', () => {
  it('班级人数直接命中 class_student_count 工具', async () => {
    const model = new FakeModel({});
    const answer = await new AgentRunner({ modelClient: model as never }).chat(
      's-direct', '我们班总共有多少学生？', { channel: 'web', actorId: 'u' });
    expect(answer).toBe('查询完成。');
    const lastMessages = model.rounds[model.rounds.length - 1];
    const toolCall = lastMessages.find((m) => m.tool_calls);
    expect((toolCall!.tool_calls as Array<{ function: { name: string } }>)[0].function.name)
      .toBe('class_student_count');
  });

  it('待办/校历直接路由', async () => {
    const model = new FakeModel({});
    await new AgentRunner({ modelClient: model as never }).chat('s-todo', '看看班级有没有逾期待办', {
      channel: 'web', actorId: 'u',
    });
    const last = model.rounds[model.rounds.length - 1];
    const toolCall = last.find((m) => m.tool_calls);
    expect((toolCall!.tool_calls as Array<{ function: { name: string } }>)[0].function.name)
      .toBe('tasks_list');
  });
});

describe('计划执行与纠错', () => {
  it('模型计划：批量查询后回答', async () => {
    const model = new FakeModel({
      plan: [['students_query', { fields: ['student_no', 'student_name'] }]],
      answer: '共有 3 名学生。',
    });
    const answer = await new AgentRunner({ modelClient: model as never }).chat(
      's-plan', '查询所有学生的姓名', { channel: 'web', actorId: 'u' });
    expect(answer).toContain('3');
    // 计划工具结果进入最终消息
    const finalMessages = model.rounds[model.rounds.length - 1];
    expect(finalMessages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('全班问题被强制转为批量计划（不退化单学生搜索）', async () => {
    const model = new FakeModel({ plan: [] });
    const runner = new AgentRunner({ modelClient: model as never });
    const answer = await runner.chat('s-class', '查看所有学生的家长职业分布', { channel: 'web', actorId: 'u' });
    expect(answer).toBe('查询完成。');
    // 执行过的计划必须是 students_query/aggregate 而非 students_search
    const conn = db.connInstance;
    const audits = conn.prepare(
      "SELECT tool_name FROM agent_audit WHERE actor_id='u' AND status='success'",
    ).all() as Array<{ tool_name: string }>;
    expect(audits.some((item) => item.tool_name === 'students_aggregate'
      || item.tool_name === 'students_query')).toBe(true);
    expect(audits.every((item) => item.tool_name !== 'students_search')).toBe(true);
  });

  it('重复失败熔断（retry_exhausted 停止）', async () => {
    // 模型反复返回同一非法工具调用：第一次 invalid_arguments（不自动重试），
    // 第二次相同调用触发 retry_exhausted 熔断
    const model = new FakeModel({ answer: '' });
    const failingIter = async function* failingIter(): AsyncGenerator<ModelStreamEvent> {
      for (let index = 0; index < 2; index += 1) {
        yield {
          content: '',
          response: {
            content: '',
            tool_calls: [{ id: 'call-bad', name: 'students_search', arguments: '{"unknown_field":1}' }],
          } as ModelResponse,
        } as ModelStreamEvent;
      }
    };
    model.iter_complete = failingIter;
    const answer = await new AgentRunner({ modelClient: model as never }).chat(
      's-fail', '你好', { channel: 'web', actorId: 'u' });
    expect(answer).toBe('凯凯小兵尝试查询时工具连续失败，已停止重复调用。请换一种说法，或稍后再试。');
    const audits = db.connInstance.prepare(
      "SELECT status FROM agent_audit WHERE tool_name='students_search' ORDER BY id",
    ).all() as Array<{ status: string }>;
    expect(audits.some((item) => item.status === 'retry_exhausted')).toBe(true);
  });
});

describe('流式事件序列', () => {
  it('chatStream 输出 plan/plan_step/delta 事件', async () => {
    const model = new FakeModel({
      plan: [['students_query', { fields: ['student_no', 'student_name'] }]],
      streamDeltas: ['全班', '学生', '名单如下。'],
    });
    const runner = new AgentRunner({ modelClient: model as never });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of runner.chatStream('s-stream', '查看所有学生的姓名', {
      channel: 'web', actorId: 'u',
    })) {
      events.push(event);
    }
    const types = events.map((event) => event.type);
    expect(types).toContain('plan');
    expect(types).toContain('plan_step');
    expect(types).toContain('delta');
    const planEvent = events.find((event) => event.type === 'plan') as Record<string, unknown>;
    expect((planEvent.steps as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
  });
});

describe('检查点与恢复', () => {
  it('会话与检查点落库（agent-checkpoints.db 独立）', async () => {
    const model = new FakeModel({ answer: '检查点回答' });
    await new AgentRunner({ modelClient: model as never }).chat('s-checkpoint', '你好', {
      channel: 'web', actorId: 'u',
    });
    const checkpointsFile = path.join(db.paths.dataDir, 'agent-checkpoints.db');
    expect(fs.existsSync(checkpointsFile)).toBe(true);
    // 会话消息持久化（不含隐式思维链）
    const store = new SessionStore();
    const messages = store.load('s-checkpoint');
    expect(messages.some((m) => m.role === 'user')).toBe(true);
    expect(messages.some((m) => m.role === 'assistant')).toBe(true);
    for (const message of messages) {
      expect(message.reasoning_content).toBeUndefined();
    }
    store.save('s-private', [
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '可见结论', reasoning_content: '不应持久化' },
    ]);
    expect(store.load('s-private').some((message) => message.reasoning_content !== undefined)).toBe(false);
  });

  it('模型未配置时 Agent 报明确错误（业务不受影响）', async () => {
    const previous = { ...process.env };
    delete process.env.MEIMEI_MODEL_BASE_URL;
    delete process.env.MEIMEI_MODEL_API_KEY;
    delete process.env.MEIMEI_MODEL_NAME;
    try {
      const runner = new AgentRunner();
      await expect(runner.chat('s', '你好', { channel: 'web', actorId: 'u' }))
        .rejects.toThrow(/模型尚未配置/);
      // 普通业务不受影响
      const { listStudents } = await import('../../src/services/students.js');
      expect((listStudents() as { students: unknown[] }).students).toHaveLength(3);
    } finally {
      process.env = previous;
    }
  });
});

describe('HTTP 冒烟', () => {
  it('Agent 路由连通（未配置模型时返回明确错误）', async () => {
    const previous = { ...process.env };
    delete process.env.MEIMEI_MODEL_BASE_URL;
    delete process.env.MEIMEI_MODEL_API_KEY;
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const status = await app.inject({ method: 'GET', url: '/api/agent/status' });
    expect(status.statusCode).toBe(200);
    const tools = await app.inject({ method: 'GET', url: '/api/agent/tools' });
    expect(tools.statusCode).toBe(200);
    const chat = await app.inject({
      method: 'POST', url: '/api/agent/chat',
      payload: { session_id: 'web:x:1', message: '我们班有多少人？', channel: 'web', actor_id: 'u' },
    });
    expect(chat.statusCode).toBe(400); // 模型未配置 → 明确错误
    await app.close();
    process.env = previous;
  });
});
