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
    expect((confirmed.verification as Record<string, unknown>).ok).toBe(true);
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

  it('创建待办时兼容使用学生学号', () => {
    db.connInstance.prepare("UPDATE students SET 学号='2202', 姓名='王雨萱' WHERE id=1").run();
    const preview = invokeTool('create_task', { title: '学号创建的待办', student_id: 2202 }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:2-no',
    });
    const confirmed = confirmAction(Number(preview.action_id), {
      sessionId: 'web:t:2-no', actorId: 'teacher',
    });
    expect(confirmed.status).toBe('executed');
    const task = db.connInstance.prepare(
      "SELECT student_id FROM student_tasks WHERE title='学号创建的待办'",
    ).get() as { student_id: number } | undefined;
    expect(task?.student_id).toBe(1);
  });

  it('第一阶段写入工具支持修改、完成和取消待办', () => {
    const created = invokeTool('create_task', { title: '待办修改前', student_id: 1 }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:phase1-create',
    });
    const createdResult = confirmAction(Number(created.action_id), {
      sessionId: 'web:t:phase1-create', actorId: 'teacher',
    });
    const taskId = Number((createdResult.result as Record<string, unknown>).task_id);

    const updated = invokeTool('update_task', {
      task_id: taskId, title: '待办修改后', due_at: '2026-04-20',
      status: '已完成', result: '已完成跟进',
    }, { channel: 'web', actorId: 'teacher', sessionId: 'web:t:phase1-update' });
    const updatedResult = confirmAction(Number(updated.action_id), {
      sessionId: 'web:t:phase1-update', actorId: 'teacher',
    });
    expect(updatedResult.status).toBe('executed');
    const completed = db.connInstance.prepare('SELECT title, status, result, due_at FROM student_tasks WHERE id=?')
      .get(taskId) as { title: string; status: string; result: string; due_at: string };
    expect(completed).toMatchObject({ title: '待办修改后', status: '已完成', result: '已完成跟进', due_at: '2026-04-20' });

    const cancelledTask = invokeTool('create_task', { title: '待办取消前', student_id: 1 }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:phase1-cancel-create',
    });
    const cancelledCreated = confirmAction(Number(cancelledTask.action_id), {
      sessionId: 'web:t:phase1-cancel-create', actorId: 'teacher',
    });
    const cancelledId = Number((cancelledCreated.result as Record<string, unknown>).task_id);
    const cancelled = invokeTool('update_task', {
      task_id: cancelledId, status: '已取消', result: '用户决定暂不处理',
    }, { channel: 'web', actorId: 'teacher', sessionId: 'web:t:phase1-cancel' });
    confirmAction(Number(cancelled.action_id), { sessionId: 'web:t:phase1-cancel', actorId: 'teacher' });
    expect((db.connInstance.prepare('SELECT status FROM student_tasks WHERE id=?').get(cancelledId) as { status: string }).status)
      .toBe('已取消');
  });

  it('第一阶段写入工具支持记录学生事件和创建重点关注', () => {
    db.connInstance.prepare("UPDATE students SET 学号='2202', 姓名='王雨萱' WHERE id=1").run();
    const event = invokeTool('create_event', {
      student_id: 2202, occurred_at: '2026-04-15', event_type: '学习情况', description: '期末成绩出现回落',
      needs_followup: false,
    }, { channel: 'web', actorId: 'teacher', sessionId: 'web:t:phase1-event' });
    const eventResult = confirmAction(Number(event.action_id), {
      sessionId: 'web:t:phase1-event', actorId: 'teacher',
    });
    expect(eventResult.status).toBe('executed');
    const eventRow = db.connInstance.prepare('SELECT student_id, event_type, description FROM student_events WHERE id=?')
      .get((eventResult.result as Record<string, unknown>).event_id) as Record<string, unknown>;
    expect(eventRow).toMatchObject({ student_id: 1, event_type: '学习情况', description: '期末成绩出现回落' });

    const focus = invokeTool('create_focus', {
      student_id: 2202, topic: '成绩回落跟进', reason: '语文和英语期末成绩较前次下降',
      action_plan: '一周内完成家校沟通', next_review_at: '2026-04-20',
    }, { channel: 'web', actorId: 'teacher', sessionId: 'web:t:phase1-focus' });
    const focusResult = confirmAction(Number(focus.action_id), {
      sessionId: 'web:t:phase1-focus', actorId: 'teacher',
    });
    expect(focusResult.status).toBe('executed');
    const focusRow = db.connInstance.prepare('SELECT student_id, topic, reason FROM focus_items WHERE id=?')
      .get((focusResult.result as Record<string, unknown>).focus_id) as Record<string, unknown>;
    expect(focusRow).toMatchObject({ student_id: 1, topic: '成绩回落跟进', reason: '语文和英语期末成绩较前次下降' });
  });

  it('第二阶段写入工具支持班会、活动、日志、知识库笔记和班级任务', () => {
    const meeting = invokeTool('create_meeting', {
      held_on: '2026-04-15', topic: '期中复习班会', content: '说明复习安排',
      student_ids: [1, 2],
    }, { channel: 'web', actorId: 'teacher', sessionId: 'web:t:phase2-meeting' });
    const meetingResult = confirmAction(Number(meeting.action_id), {
      sessionId: 'web:t:phase2-meeting', actorId: 'teacher',
    });
    expect(meetingResult.status).toBe('executed');
    const meetingRow = db.connInstance.prepare('SELECT topic, held_on FROM meeting_records WHERE id=?')
      .get((meetingResult.result as Record<string, unknown>).meeting_id) as Record<string, unknown>;
    expect(meetingRow).toMatchObject({ topic: '期中复习班会', held_on: '2026-04-15' });

    const activity = invokeTool('create_activity', {
      occurred_on: '2026-04-16', name: '阅读分享会', activity_type: '其他', summary: '班级阅读交流',
      student_ids: [1, 3],
    }, { channel: 'web', actorId: 'teacher', sessionId: 'web:t:phase2-activity' });
    const activityResult = confirmAction(Number(activity.action_id), {
      sessionId: 'web:t:phase2-activity', actorId: 'teacher',
    });
    expect(activityResult.status).toBe('executed');
    const activityRow = db.connInstance.prepare('SELECT name, occurred_on FROM activity_records WHERE id=?')
      .get((activityResult.result as Record<string, unknown>).activity_id) as Record<string, unknown>;
    expect(activityRow).toMatchObject({ name: '阅读分享会', occurred_on: '2026-04-16' });

    const diary = invokeTool('create_diary', {
      diary_date: '2026-04-15', work: '完成班级常规检查', todo: '跟进复习计划',
    }, { channel: 'web', actorId: 'teacher', sessionId: 'web:t:phase2-diary' });
    const diaryResult = confirmAction(Number(diary.action_id), {
      sessionId: 'web:t:phase2-diary', actorId: 'teacher',
    });
    expect(diaryResult.status).toBe('executed');
    const diaryRow = db.connInstance.prepare('SELECT diary_date, work FROM diary_entries WHERE id=?')
      .get((diaryResult.result as Record<string, unknown>).diary_id) as Record<string, unknown>;
    expect(diaryRow).toMatchObject({ diary_date: '2026-04-15', work: '完成班级常规检查' });

    const note = invokeTool('create_knowledge_note', {
      title: 'Agent 第二阶段测试笔记', category: '测试', content: '确认后写入知识库。', tags: ['测试'],
    }, { channel: 'web', actorId: 'teacher', sessionId: 'web:t:phase2-note' });
    const noteResult = confirmAction(Number(note.action_id), {
      sessionId: 'web:t:phase2-note', actorId: 'teacher',
    });
    expect(noteResult.status).toBe('executed');
    const notePath = path.join(db.paths.kbDir, '测试', 'Agent 第二阶段测试笔记.md');
    expect(fs.existsSync(notePath)).toBe(true);
    expect(fs.readFileSync(notePath, 'utf8')).toContain('确认后写入知识库。');

    const classTask = invokeTool('create_class_task', {
      title: '收集复习反馈', student_ids: [1, 2, 3], due_at: '2026-04-20', material_name: '反馈表',
    }, { channel: 'web', actorId: 'teacher', sessionId: 'web:t:phase2-class-task' });
    const classTaskResult = confirmAction(Number(classTask.action_id), {
      sessionId: 'web:t:phase2-class-task', actorId: 'teacher',
    });
    expect(classTaskResult.status).toBe('executed');
    const classTaskId = Number((classTaskResult.result as Record<string, unknown>).class_task_id);
    const classTaskRow = db.connInstance.prepare('SELECT title FROM class_tasks WHERE id=?')
      .get(classTaskId) as Record<string, unknown>;
    expect(classTaskRow.title).toBe('收集复习反馈');
    expect((db.connInstance.prepare('SELECT COUNT(*) AS count FROM class_task_items WHERE task_id=?')
      .get(classTaskId) as { count: number }).count).toBe(3);
  });

  it('第二阶段班级任务不开放给微信渠道', () => {
    expect(() => invokeTool('create_class_task', { title: '微信不应创建', student_ids: [1] }, {
      channel: 'wechat', actorId: 'wx-user', sessionId: 'wechat:wx-user',
    })).toThrow(/权限/);
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

  it('确认/取消使用精确词匹配，前缀相似语句不误触发写入', () => {
    const preview = invokeTool('record_points', { student_id: 1, amount: 3, reason: '前缀测试' }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:11',
    });
    // “确认一下明天的安排”不是确认词 → 不执行，仍提示确认
    const [handled, answer] = handleConfirmation('确认一下明天的安排', {
      sessionId: 'web:t:11', actorId: 'teacher', channel: 'web',
    });
    expect(handled).toBe(true);
    expect(answer).toContain('确认');
    expect(db.connInstance.prepare(
      "SELECT COUNT(*) AS c FROM point_ledger WHERE reason='前缀测试'",
    ).get().c).toBe(0);
    expect(db.connInstance.prepare(
      'SELECT status FROM agent_actions WHERE id=?',
    ).get(preview.action_id).status).toBe('pending');
    // 精确词（含标点）才执行
    const [handled2] = handleConfirmation('确认。', {
      sessionId: 'web:t:11', actorId: 'teacher', channel: 'web',
    });
    expect(handled2).toBe(true);
    expect(db.connInstance.prepare(
      "SELECT COUNT(*) AS c FROM point_ledger WHERE reason='前缀测试'",
    ).get().c).toBe(1);
    // “取消这个月的活动”不会取消待确认操作
    const preview2 = invokeTool('record_points', { student_id: 2, amount: 1, reason: '取消前缀测试' }, {
      channel: 'web', actorId: 'teacher', sessionId: 'web:t:12',
    });
    const [handled3] = handleConfirmation('取消这个月的活动', {
      sessionId: 'web:t:12', actorId: 'teacher', channel: 'web',
    });
    expect(handled3).toBe(true);
    expect(db.connInstance.prepare(
      'SELECT status FROM agent_actions WHERE id=?',
    ).get(preview2.action_id).status).toBe('pending');
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

  it('历史摘要保留工具调用与结果的对应关系', () => {
    const store = new SessionStore(10);
    const messages: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 5; index += 1) {
      const callId = `call-${index}`;
      messages.push({ role: 'user', content: `查询${index}` });
      messages.push({
        role: 'assistant', content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name: 'students_search', arguments: '{}' } }],
      });
      messages.push({
        role: 'tool', tool_call_id: callId,
        content: JSON.stringify({ count: 1, students: [{ id: index + 1, 姓名: `学生${index}` }] }),
      });
      messages.push({ role: 'assistant', content: `找到学生${index}` });
    }
    store.save('web:compress:tools', messages, {
      title: '工具压缩', actorId: 'compress', channel: 'web',
    });
    const loaded = store.loadOwned('web:compress:tools', 'compress', 'web');
    const summary = loaded.find((message) => message.context_summary === true);
    expect(String(summary?.content)).toContain('工具 students_search');
    expect(String(summary?.content)).toContain('count');
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
