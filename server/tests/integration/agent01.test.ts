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
    expect(toolCall!.reasoning_content).toBe('');
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

  it('规划后的工具消息回传 reasoning_content', async () => {
    const rounds: Array<Array<Record<string, unknown>>> = [];
    const model = {
      async complete(messages: Array<Record<string, unknown>>): Promise<ModelResponse> {
        rounds.push(messages);
        return {
          content: JSON.stringify({
            goal: '查询学生人数',
            steps: [{ id: 'count', tool: 'class_student_count', arguments: {} }],
          }),
          tool_calls: [],
          reasoning_content: '规划阶段思考内容',
          usage: null,
        };
      },
      async *iter_complete(messages: Array<Record<string, unknown>>): AsyncGenerator<ModelStreamEvent> {
        rounds.push(messages);
        yield {
          content: '',
          response: { content: '共有 3 名学生。', tool_calls: [], reasoning_content: '', usage: null },
        };
      },
    };
    await new AgentRunner({ modelClient: model as never }).chat(
      's-plan-reasoning', '有多少学生', { channel: 'web', actorId: 'u' });
    const finalMessages = rounds[1];
    const toolCallMessage = finalMessages.find((message) => Array.isArray(message.tool_calls));
    expect(toolCallMessage?.reasoning_content).toBe('规划阶段思考内容');
  });

  it('模型工具循环回传 reasoning_content', async () => {
    const rounds: Array<Array<Record<string, unknown>>> = [];
    let turn = 0;
    const model = {
      async *iter_complete(messages: Array<Record<string, unknown>>): AsyncGenerator<ModelStreamEvent> {
        rounds.push(messages);
        if (turn === 0) {
          turn += 1;
          yield {
            content: '',
            response: {
              content: '',
              tool_calls: [{ id: 'call-reasoning', name: 'class_student_count', arguments: '{}' }],
              reasoning_content: '工具调用前思考内容',
              usage: null,
            },
          };
          return;
        }
        yield {
          content: '',
          response: { content: '查询完成。', tool_calls: [], reasoning_content: '', usage: null },
        };
      },
    };
    await new AgentRunner({ modelClient: model as never }).chat(
      's-loop-reasoning', '你好', { channel: 'web', actorId: 'u' });
    const assistantToolMessage = rounds[1].find((message) => Array.isArray(message.tool_calls));
    expect(assistantToolMessage?.reasoning_content).toBe('工具调用前思考内容');
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

  it('模型计划按姓名查询时，搜索结果 student_id 能传给后续工具', async () => {
    db.connInstance.prepare("UPDATE students SET 姓名='李子涵' WHERE 学号='S001'").run();
    const model = new FakeModel({ answer: '已整理李子涵最近的情况。' });
    model.complete = async (messages): Promise<ModelResponse> => {
      model.rounds.push(messages);
      return {
        content: JSON.stringify({
          goal: '查看李子涵最近的情况',
          steps: [
            { id: 'search', tool: 'students_search', arguments: { keyword: '李子涵', limit: 20 } },
            {
              id: 'profile', tool: 'student_get_profile',
              arguments: { student_id: '$search.students[0].student_id' },
              depends_on: ['search'], condition: 'exactly_one_student',
            },
            {
              id: 'timeline', tool: 'student_get_timeline',
              arguments: { student_id: '$search.students[0].student_id' },
              depends_on: ['search'], condition: 'exactly_one_student',
            },
            {
              id: 'attendance', tool: 'attendance_summary',
              arguments: { student_id: '$search.students[0].student_id' },
              depends_on: ['search'], condition: 'exactly_one_student',
            },
            {
              id: 'tasks', tool: 'tasks_list',
              arguments: { student_id: '$search.students[0].student_id' },
              depends_on: ['search'], condition: 'exactly_one_student',
            },
            {
              id: 'communications', tool: 'communications_list',
              arguments: { student_id: '$search.students[0].student_id' },
              depends_on: ['search'], condition: 'exactly_one_student',
            },
          ],
        }),
        tool_calls: [],
      } as ModelResponse;
    };

    const answer = await new AgentRunner({ modelClient: model as never }).chat(
      's-student-overview', '分析李子涵近期表现', { channel: 'web', actorId: 'u' });

    expect(answer).toContain('李子涵');
    const audits = db.connInstance.prepare(
      "SELECT tool_name, status FROM agent_audit WHERE actor_id='u' ORDER BY id",
    ).all() as Array<{ tool_name: string; status: string }>;
    expect(audits.filter((item) => item.status === 'error')).toEqual([]);
    expect(audits.filter((item) => item.status === 'success').map((item) => item.tool_name)).toEqual([
      'students_search', 'student_get_profile', 'student_get_timeline',
      'attendance_summary', 'tasks_list', 'communications_list',
    ]);
  });

  it('“查看姓名最近情况”使用确定性计划，不依赖模型猜测工具契约', async () => {
    db.connInstance.prepare("UPDATE students SET 姓名='李子涵' WHERE 学号='S001'").run();
    const model = new FakeModel({ answer: '已整理李子涵最近的情况。' });
    model.complete = async (): Promise<ModelResponse> => {
      throw new Error('该请求应由确定性计划处理');
    };

    const answer = await new AgentRunner({ modelClient: model as never }).chat(
      's-student-overview-rule', '查看 李子涵 最近的情况', { channel: 'web', actorId: 'rule-user' });

    expect(answer).toContain('李子涵');
    const audits = db.connInstance.prepare(
      "SELECT tool_name, status FROM agent_audit WHERE actor_id='rule-user' ORDER BY id",
    ).all() as Array<{ tool_name: string; status: string }>;
    expect(audits.every((item) => item.status === 'success')).toBe(true);
    expect(audits.map((item) => item.tool_name)).toEqual([
      'students_search', 'student_get_profile', 'student_get_timeline',
      'attendance_summary', 'tasks_list', 'communications_list',
    ]);
  });

  it('后续问题中的“这个学生”沿用上一轮明确提到的学生', async () => {
    const model = new FakeModel({ answer: '已查询完成。' });
    const runner = new AgentRunner({ modelClient: model as never });
    const options = { channel: 'web', actorId: 'followup-user' };

    await runner.chat('s-followup-student', '查询学号S001的学生最近的考试情况', options);
    const events: Array<Record<string, unknown>> = [];
    for await (const event of runner.chatStream(
      's-followup-student', '查看这个学生最近的考勤情况', options,
    )) {
      events.push(event);
    }

    const attendance = events.find((event) =>
      event.type === 'tool' && event.name === 'attendance_summary' && event.status === 'completed');
    expect(attendance).toBeDefined();
    expect((attendance?.input as Record<string, unknown>).student_id).toBe(1);
    expect(events.some((event) =>
      event.type === 'plan_step' && event.status === 'skipped')).toBe(false);
  });

  it('学生搜索无结果时直接说明原因，不输出协议残片', async () => {
    const model = new FakeModel({ answer: '<不应调用模型生成失败回答>' });
    const runner = new AgentRunner({ modelClient: model as never });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of runner.chatStream(
      's-missing-student', '查看不存在的学生最近的考勤情况',
      { channel: 'web', actorId: 'missing-user' },
    )) {
      events.push(event);
    }

    const answer = events.filter((event) => event.type === 'delta')
      .map((event) => String(event.content ?? '')).join('');
    expect(answer).toContain('没有找到匹配的学生');
    expect(answer).not.toContain('<');
    const skipped = events.find((event) => event.type === 'plan_step' && event.status === 'skipped');
    expect(skipped?.message).toContain('未找到匹配的学生');
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
    expect(answer).toBe('凯凯尝试查询时工具连续失败，已停止重复调用。请换一种说法，或稍后再试。');
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
    expect(types).toContain('tool');
    expect(types).toContain('delta');
    const planEvent = events.find((event) => event.type === 'plan') as Record<string, unknown>;
    expect((planEvent.steps as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
    const toolEvent = events.find((event) => event.type === 'tool' && event.status === 'completed');
    expect(toolEvent?.name).toBe('students_query');
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
