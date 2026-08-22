/* AGENT-00 Agent 基线与模型层测试：模型客户端（假 HTTP 服务）、配置脱敏、
 * 工具注册表（回归样例）、会话存储、AI 草稿。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';
import { OpenAICompatibleClient, ModelResponse } from '../../src/agent/modelClient.js';
import {
  createProfile,
  deleteProfile,
  duplicateProfile,
  listProfiles,
  saveConfig,
  loadConfig as loadModelConfig,
  publicConfig,
  revealProfileKey,
  selectProfile,
  ModelConfig,
} from '../../src/agent/modelConfig.js';
import { AgentPlan } from '../../src/agent/planner.js';
import { SessionStore } from '../../src/agent/sessionStore.js';
import { systemPrompt } from '../../src/agent/prompt.js';
import { getRegistry, listTools, invokeTool, ToolError } from '../../src/agent/agentService.js';

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
    conn.prepare('INSERT INTO students(学号, 姓名, 性别, 班级任职, 监护人职业) VALUES(?,?,?,?,?)')
      .run(`S${String(index).padStart(3, '0')}`, `工具学生${index}`, index % 2 ? '男' : '女',
        index === 1 ? '班长' : '', index === 1 ? '务农' : '');
  }
  conn.prepare(
    `INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status)
     SELECT id, 1, 1, '在读' FROM students`,
  ).run();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent00-'));
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

/** 本地假 OpenAI-compatible 服务。 */
function fakeModelServer(): Promise<{ url: string; close: () => void; calls: Array<Record<string, unknown>> }> {
  return new Promise((resolve) => {
    const calls: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        calls.push({ url: req.url, body: JSON.parse(body) });
        const payload = JSON.parse(body);
        if (req.headers.accept?.includes('text/event-stream')) {
          const chunks = [
            `data: {"choices":[{"delta":{"content":"你好"}}]}\n\n`,
            `data: {"choices":[{"delta":{"reasoning_content":"（思考）"}}]}\n\n`,
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"students_query","arguments":"{\\"fields\\":[\\"student_no\\",\\"student_name\\"]}"}}]}}]}\n\n`,
            'data: [DONE]\n\n',
          ];
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(chunks.join(''));
          return;
        }
        if (payload.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: '工具学生甲 是班长', tool_calls: [] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        close: () => server.close(),
        calls,
      });
    });
  });
}

describe('模型配置', () => {
  it('保存/加载/脱敏', () => {
    saveConfig({ base_url: 'http://localhost:9999/v1', model: 'gpt-test', api_key: 'sk-secret' });
    const loaded = loadModelConfig();
    expect(loaded.model).toBe('gpt-test');
    const pub = publicConfig({ api_key: 'sk-secret', model: 'gpt-test', base_url: 'http://x' });
    expect(pub.api_key_set).toBe(true);
    expect(pub.api_key_masked).toContain('…');
    expect(revealProfileKey('default').api_key).toBe('sk-secret');
  });

  it('校验必填字段', () => {
    expect(() => saveConfig({ base_url: '', model: '' })).toThrow();
  });

  it('留空或 null 字符串不会覆盖已有 API Key', () => {
    saveConfig({ base_url: 'http://localhost:9999/v1', model: 'gpt-test', api_key: 'sk-secret' });
    saveConfig({ base_url: 'http://localhost:9999/v1', model: 'gpt-test', api_key: null });
    expect(loadModelConfig().api_key).toBe('sk-secret');
    saveConfig({ base_url: 'http://localhost:9999/v1', model: 'gpt-test', api_key: 'null' });
    expect(loadModelConfig().api_key).toBe('sk-secret');
  });

  it('历史配置中的 null API Key 被视为未配置', () => {
    fs.writeFileSync(path.join(tempDir, 'agent-model.json'), JSON.stringify({
      model_api_key: 'null',
      model_base_url: 'https://api.deepseek.com',
      model_name: 'deepseek-chat',
      model_thinking: 'disabled',
    }), { mode: 0o600 });
    const loaded = loadModelConfig();
    expect(loaded.api_key).toBe('');
    expect(new ModelConfig(loaded).configured).toBe(false);
  });

  it('配置接口收到 JSON null 时保留已有 API Key', async () => {
    saveConfig({ base_url: 'http://localhost:9999/v1', model: 'gpt-test', api_key: 'sk-secret' });
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const saved = await app.inject({
      method: 'PUT', url: '/api/agent/config',
      payload: {
        api_key: null,
        base_url: 'http://localhost:9999/v1',
        model: 'gpt-test',
        thinking: 'disabled',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().api_key_set).toBe(true);
    expect(loadModelConfig().api_key).toBe('sk-secret');
    await app.close();
  });

  it('仅本机配置页可显式读取当前档案 API Key', async () => {
    saveConfig({ base_url: 'http://localhost:9999/v1', model: 'gpt-test', api_key: 'sk-secret' });
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const revealed = await app.inject({
      method: 'GET', url: '/api/agent/config/profiles/default/key',
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json()).toEqual({ api_key: 'sk-secret' });

    const denied = await app.inject({
      method: 'GET', url: '/api/agent/config/profiles/default/key', remoteAddress: '192.168.31.99',
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it('配置档案可创建、切换、保存与删除', () => {
    saveConfig({ base_url: 'https://api.deepseek.com', model: 'deepseek-chat', api_key: 'sk-default' });
    const created = createProfile({
      name: 'OpenAI 备用',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-test',
      thinking: 'disabled',
      api_key: 'sk-backup',
    });
    const createdId = String(created.profile_id);
    expect(listProfiles().active_profile_id).toBe(createdId);
    expect(listProfiles().profiles).toHaveLength(2);
    expect(loadModelConfig().model).toBe('gpt-test');

    selectProfile('default');
    expect(loadModelConfig().api_key).toBe('sk-default');
    saveConfig({
      profile_id: 'default',
      profile_name: 'DeepSeek 主配置',
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-reasoner',
      thinking: 'enabled',
      api_key: null,
    });
    expect(loadModelConfig().model).toBe('deepseek-reasoner');
    expect(loadModelConfig().api_key).toBe('sk-default');
    expect(loadModelConfig().profile_name).toBe('DeepSeek 主配置');

    const duplicated = duplicateProfile('default');
    expect(duplicated.api_key_set).toBe(true);
    expect(duplicated.profile_name).toBe('DeepSeek 主配置 副本');
    expect(loadModelConfig().api_key).toBe('sk-default');
    deleteProfile(String(duplicated.profile_id));
    deleteProfile(createdId);
    expect(listProfiles().profiles).toHaveLength(1);
    expect(listProfiles().active_profile_id).toBe('default');
  });
});

describe('模型客户端', () => {
  it('complete 与流式 iter_complete', async () => {
    const fake = await fakeModelServer();
    try {
      const client = new OpenAICompatibleClient(new ModelConfig({
        base_url: fake.url, model: 'fake', api_key: 'k', timeout_seconds: 10, thinking: 'disabled',
      }));
      const response = await client.complete([{ role: 'user', content: '谁是班长？' }], []);
      expect(String(response.content)).toContain('班长');

      const events: string[] = [];
      for await (const event of client.iter_complete([{ role: 'user', content: 'hi' }], [])) {
        events.push(event.content || '(tool-call)');
      }
      expect(events.join('')).toContain('你好');
      expect(fake.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      fake.close();
    }
  });

  it('未配置时抛 ModelNotConfigured', async () => {
    const previous = { ...process.env };
    delete process.env.MEIMEI_MODEL_BASE_URL;
    delete process.env.MEIMEI_MODEL_API_KEY;
    const client = new OpenAICompatibleClient();
    await expect(client.complete([], [])).rejects.toThrow(/模型尚未配置/);
    process.env = previous;
  });

  it('thinking 仅在启用时发送；temperature 可配置', async () => {
    const previous = { ...process.env };
    const fake = await fakeModelServer();
    try {
      process.env.MEIMEI_MODEL_BASE_URL = fake.url;
      process.env.MEIMEI_MODEL_API_KEY = 'k';
      process.env.MEIMEI_MODEL_NAME = 'fake';
      process.env.MEIMEI_MODEL_TEMPERATURE = '0.8';
      delete process.env.MEIMEI_MODEL_THINKING;
      const client = new OpenAICompatibleClient();
      await client.complete([{ role: 'user', content: 'hi' }]);
      const disabledPayload = fake.calls[fake.calls.length - 1].body as Record<string, unknown>;
      expect(disabledPayload.thinking).toBeUndefined();
      expect(disabledPayload.temperature).toBe(0.8);

      process.env.MEIMEI_MODEL_THINKING = 'enabled';
      const client2 = new OpenAICompatibleClient();
      await client2.complete([{ role: 'user', content: 'hi' }]);
      const enabledPayload = fake.calls[fake.calls.length - 1].body as Record<string, unknown>;
      expect(enabledPayload.thinking).toEqual({ type: 'enabled' });
    } finally {
      process.env = previous;
      fake.close();
    }
  });
});

describe('工具注册表与回归', () => {
  it('33 个工具，微信渠道过滤敏感工具', () => {
    const registry = getRegistry();
    expect(registry.list().length).toBe(33);
    const web = listTools('web');
    expect(web.length).toBe(33);
    const wechat = listTools('wechat');
    expect(wechat.length).toBe(26);
    expect(wechat.some((tool) => tool.name === 'student_get_profile')).toBe(false);
    expect(wechat.some((tool) => tool.name === 'scores_summary')).toBe(false);
    expect(registry.modelTools('wechat').some((tool) =>
      (tool.function as Record<string, unknown>).name === 'student_get_profile')).toBe(false);
  });

  it('班级人数与搜索（回归样例）', () => {
    const count = invokeTool('class_student_count', {}, { channel: 'web', actorId: 't' });
    expect(count.student_count).toBe(3);
    const search = invokeTool('students_search', { keyword: '工具学生1' }, { channel: 'web', actorId: 't' });
    const student = (search.students as Array<Record<string, unknown>>)[0];
    expect(student.姓名).toBe('工具学生1');
    expect(student.student_id).toBe(student.id);
  });

  it('批量查询与聚合', () => {
    const query = invokeTool('students_query', { fields: ['student_no', 'student_name'] },
      { channel: 'web', actorId: 't' });
    expect((query.students as Array<Record<string, unknown>>).length).toBe(3);
    const aggregate = invokeTool('students_aggregate', { group_by: 'guardian_occupation' },
      { channel: 'web', actorId: 't' });
    expect(aggregate.groups).toBeTruthy();
  });

  it('微信敏感拒绝与写工具确认', () => {
    expect(() => invokeTool('student_get_profile', { student_id: 1 },
      { channel: 'wechat', actorId: 'w' })).toThrowError(/权限|微信/);
    try {
      invokeTool('create_task', { title: '测试任务', student_id: 1 },
        { channel: 'wechat', actorId: 'w' });
      expect.unreachable?.();
    } catch (error) {
      expect((error as ToolError).code).toBe('confirmation_required');
    }
  });

  it('参数错误 invalid_arguments', () => {
    try {
      invokeTool('students_search', { student_id: 1 }, { channel: 'web', actorId: 't' });
      expect.unreachable?.();
    } catch (error) {
      expect((error as ToolError).code).toBe('invalid_arguments');
    }
  });

  it('不存在工具 unknown_tool', () => {
    expect(() => invokeTool('nonexistent', {}, { channel: 'web', actorId: 't' }))
      .toThrow(/不存在|未知/);
  });

  it('计划路径拒绝写入工具', () => {
    const registry = getRegistry();
    expect(() => AgentPlan.fromPayload({
      goal: '创建一个待办',
      steps: [{ id: 's1', tool: 'create_task', arguments: { title: '计划测试' } }],
    }, registry)).toThrow(/写入工具/);
  });
});

describe('会话存储', () => {
  it('保存/加载/列表/重命名/删除', () => {
    const store = new SessionStore();
    store.save('web:u:1', [{ role: 'user', content: 'hi' }], { title: '测试会话' });
    const loaded = store.load('web:u:1');
    expect(loaded).toHaveLength(1);
    const sessions = store.list('web:');
    expect(sessions.length).toBe(1);
    expect(sessions[0].title).toBe('测试会话');
    store.rename('web:u:1', '新标题');
    expect(store.list('web:')[0].title).toBe('新标题');
    store.clear('web:u:1');
    expect(store.list('web:')).toHaveLength(0);
  });
});

describe('系统提示与 HTTP 冒烟', () => {
  it('systemPrompt 包含凯凯与业务日期', () => {
    const prompt = systemPrompt();
    expect(prompt).toContain('凯凯');
    expect(prompt).toContain('2026-04-15');
  });

  it('AI 草稿端点未配置模型时返回 400', async () => {
    const previous = { ...process.env };
    delete process.env.MEIMEI_MODEL_BASE_URL;
    delete process.env.MEIMEI_MODEL_API_KEY;
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const comment = await app.inject({
      method: 'POST', url: '/api/comments/ai/preview',
      payload: { student_ids: [1] },
    });
    expect(comment.statusCode).toBe(400);
    expect(comment.json().detail).toContain('模型');
    const report = await app.inject({
      method: 'POST', url: '/api/reports/ai/preview',
      payload: { instruction: '总结' },
    });
    expect(report.statusCode).toBe(400);
    await app.close();
    process.env = previous;
  });
});

describe('HTTP 身份绑定', () => {
  it('body 中的 channel/actor 伪装无效，身份来自请求上下文', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    // 直接服务层：微信渠道拒绝敏感档案工具
    expect(() => invokeTool('student_get_profile', { student_id: 1 }, { channel: 'wechat', actorId: 'w' }))
      .toThrow(/微信/);
    // HTTP 层：即使 body 声称 channel=wechat，身份仍按本机 web 绑定，允许读取
    const spoof = await app.inject({
      method: 'POST', url: '/api/agent/tools/student_get_profile',
      payload: { arguments: { student_id: 1 }, channel: 'wechat', actor_id: 'spoofer', session_id: 'web:spoof:1' },
    });
    expect(spoof.statusCode).toBe(200);
    expect((spoof.json().result as Record<string, unknown>).student).toBeTruthy();
    await app.close();
  });

  it('会话 ID 必须使用 web: 前缀', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const tools = await app.inject({
      method: 'POST', url: '/api/agent/tools/class_student_count',
      payload: { arguments: {}, session_id: 'no-prefix' },
    });
    expect(tools.statusCode).toBe(422);
    const chat = await app.inject({
      method: 'POST', url: '/api/agent/chat',
      payload: { session_id: 'no-prefix', message: '我们班多少人？' },
    });
    expect(chat.statusCode).toBe(422);
    const sessions = await app.inject({ method: 'GET', url: '/api/agent/sessions/wechat:someone' });
    expect(sessions.statusCode).toBe(404);
    await app.close();
  });

  it('跨身份确认被拒绝', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const created = await app.inject({
      method: 'POST', url: '/api/agent/tools/create_task',
      headers: { 'x-workbench-actor': 'alice' },
      payload: { arguments: { title: '跨身份确认测试', student_id: 1 }, session_id: 'web:cross:1' },
    });
    expect(created.statusCode).toBe(200);
    const actionId = created.json().result.action_id;
    const wrongActor = await app.inject({
      method: 'POST', url: `/api/agent/actions/${actionId}/confirm`,
      headers: { 'x-workbench-actor': 'bob' },
      payload: { session_id: 'web:cross:1', confirmation_token: 'XXXXXX' },
    });
    expect(wrongActor.statusCode).toBe(400);
    expect(wrongActor.json().detail).toContain('不存在或不属于当前会话');
    const correctActor = await app.inject({
      method: 'POST', url: `/api/agent/actions/${actionId}/confirm`,
      headers: { 'x-workbench-actor': 'alice' },
      payload: { session_id: 'web:cross:1' },
    });
    expect(correctActor.statusCode).toBe(200);
    expect(correctActor.json().status).toBe('executed');
    await app.close();
  });

  it('网页会话由服务端创建并按操作者隔离', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const created = await app.inject({
      method: 'POST', url: '/api/agent/sessions',
      headers: { 'x-workbench-actor': 'alice' }, payload: {},
    });
    expect(created.statusCode).toBe(200);
    const sessionId = String(created.json().session_id);
    expect(sessionId).toMatch(/^web:[0-9a-f]{12}:[0-9a-f-]+$/);
    const own = await app.inject({
      method: 'GET', url: `/api/agent/sessions/${encodeURIComponent(sessionId)}`,
      headers: { 'x-workbench-actor': 'alice' },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().messages).toEqual([]);
    const other = await app.inject({
      method: 'GET', url: `/api/agent/sessions/${encodeURIComponent(sessionId)}`,
      headers: { 'x-workbench-actor': 'bob' },
    });
    expect(other.statusCode).toBe(404);
    const otherList = await app.inject({
      method: 'GET', url: '/api/agent/sessions',
      headers: { 'x-workbench-actor': 'bob' },
    });
    expect(otherList.json().sessions).toEqual([]);
    await app.close();
  });
});
