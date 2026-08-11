/* MIG-06 行动闭环测试。
 *
 * 验收重点：来源幂等、完成/取消/重开双向回写、时间筛选、URL 定位、
 * 并发创建、审计和状态不矛盾、学生时间线。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';
import {
  createEvent, createFocus, createCommunication, saveDailyAttendance, studentDetail,
} from '../../src/services/p0Service.js';
import {
  createWorkItem, ensureSourceWorkItem, listWorkItems, updateWorkItem, workItemSummary,
  WorkItemError,
} from '../../src/services/workItems.js';
import { updateSource, getWorkflow } from '../../src/services/workflow.js';

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

function seedStudents(): void {
  const conn = db.connInstance;
  for (let index = 1; index <= 3; index += 1) {
    conn.prepare('INSERT INTO students(学号, 姓名, 性别) VALUES(?,?,?)')
      .run(`S${String(index).padStart(3, '0')}`, `行动学生${index}`, index % 2 ? '男' : '女');
  }
  conn.prepare(
    `INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status)
     SELECT id, 1, 1, '在读' FROM students`,
  ).run();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig06-'));
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
  seedStudents();
});

afterEach(() => {
  db.close();
  setDatabase(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('工作项创建与来源幂等', () => {
  it('来源键幂等：重复调用返回原工作项', () => {
    const first = createWorkItem({ title: '事件跟进', sourceType: 'event', sourceId: 7, studentId: 1 });
    const second = createWorkItem({ title: '事件跟进', sourceType: 'event', sourceId: 7, studentId: 1 });
    expect(first.id).toBe(second.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(db.connInstance.prepare('SELECT COUNT(*) AS c FROM student_tasks').get().c).toBe(1);
  });

  it('ensure_source_work_item 认领同标题旧待办', () => {
    const conn = db.connInstance;
    conn.prepare(
      `INSERT INTO student_tasks(student_id, title, source_type, source, class_id, term_id, status)
       VALUES(1, '迟到 · 跟进', 'manual', '手动创建', 1, 1, '待复查')`,
    ).run();
    const legacyId = Number(conn.prepare('SELECT last_insert_rowid() AS id').get().id);
    const result = ensureSourceWorkItem({
      title: '迟到 · 跟进', studentId: 1, sourceType: 'event', sourceId: 99,
      sourceLabel: '学生事件', legacyTitle: '迟到 · 跟进', priority: '重要', status: '待复查',
    });
    expect(result.id).toBe(legacyId);
    const row = conn.prepare('SELECT source_type, source_id FROM student_tasks WHERE id=?').get(legacyId);
    expect(row.source_type).toBe('event');
    expect(row.source_id).toBe(99);
  });

  it('校验：空标题、非法状态、完成必须填结果', () => {
    expect(() => createWorkItem({ title: '  ' })).toThrow(WorkItemError);
    const item = createWorkItem({ title: '测试', studentId: 1 });
    expect(() => updateWorkItem(item.id, { status: '已完成' })).toThrow(/处理结果/);
    expect(() => updateWorkItem(item.id, { status: '已完成', result: '已处理' })).not.toThrow();
  });
});

describe('事件/沟通/关注 → 工作项联动', () => {
  it('事件需跟进生成工作项，重复创建事件不重复生成', () => {
    const first = createEvent({
      studentId: 1, occurredAt: '2026-04-15 08:10', eventType: '迟到',
      description: '早读迟到', needsFollowup: true, followupDue: '2026-04-18',
    });
    const second = createEvent({
      studentId: 1, occurredAt: '2026-04-15 08:10', eventType: '迟到',
      description: '早读迟到', needsFollowup: true, followupDue: '2026-04-18',
    });
    expect(first.event_id).toBeGreaterThan(0);
    expect(second.event_id).toBeGreaterThan(first.event_id);
    // 两个事件 → 两个独立工作项（source_id 不同）
    const count = db.connInstance.prepare(
      "SELECT COUNT(*) AS c FROM student_tasks WHERE source_type='event'",
    ).get().c;
    expect(count).toBe(2);
  });

  it('家校沟通带回访生成工作项', () => {
    const result = createCommunication({
      studentId: 1, communicatedAt: '2026-04-15 09:00', method: '电话',
      reason: '迟到沟通', summary: '已提醒', followupAt: '2026-04-20',
    });
    expect(result.task_id).toBeGreaterThan(0);
    const task = db.connInstance.prepare(
      "SELECT * FROM student_tasks WHERE id=?",
    ).get(result.task_id);
    expect(task.source_type).toBe('communication');
    expect(task.status).toBe('待复查');
  });

  it('关注带复查日期生成工作项', () => {
    const result = createFocus({
      studentId: 2, topic: '课堂专注度', reason: '近期走神', nextReviewAt: '2026-04-25',
    });
    expect(result.task_id).toBeGreaterThan(0);
  });
});

describe('来源与工作项双向回写', () => {
  it('完成来源联动工作项（complete）', () => {
    const event = createEvent({
      studentId: 1, occurredAt: '2026-04-15 08:10', eventType: '迟到',
      description: '早读迟到', needsFollowup: true, followupDue: '2026-04-18',
    });
    const result = updateSource('event', Number(event.event_id), {
      status: '已完成', result: '已约谈家长', taskAction: 'complete',
    });
    expect(result.duplicate).toBe(false);
    const linked = (result.linked_work_item ?? {}) as Record<string, unknown>;
    expect(linked.status).toBe('已完成');
    expect(linked.result).toBe('已约谈家长');
  });

  it('取消来源联动工作项（cancel）', () => {
    const focus = createFocus({
      studentId: 2, topic: '作业完成度', reason: '连续未交', nextReviewAt: '2026-04-25',
    });
    const result = updateSource('focus', Number(focus.focus_id), {
      status: '已结束', result: '情况已改善', taskAction: 'cancel',
    });
    const linked = (result.linked_work_item ?? {}) as Record<string, unknown>;
    expect(linked.status).toBe('已取消');
  });

  it('工作项完成回写来源（on_work_item_transition）', () => {
    const event = createEvent({
      studentId: 1, occurredAt: '2026-04-15 08:10', eventType: '迟到',
      description: '早读迟到', needsFollowup: true, followupDue: '2026-04-18',
    });
    updateWorkItem(Number(event.task_id), { status: '已完成', result: '已处理完毕' });
    const source = db.connInstance.prepare(
      'SELECT status, result, closed_at FROM student_events WHERE id=?',
    ).get(Number(event.event_id));
    expect(source.status).toBe('已完成');
    expect(source.result).toBe('已处理完毕');
    expect(source.closed_at).not.toBe('');
    // 过程记录
    const updates = db.connInstance.prepare(
      'SELECT * FROM workflow_updates WHERE source_type=? AND source_id=?',
    ).all('event', Number(event.event_id));
    expect(updates.some((row) => row.action === 'work_item_completed')).toBe(true);
  });

  it('工作项重开回写来源（reopen）', () => {
    const event = createEvent({
      studentId: 1, occurredAt: '2026-04-15 08:10', eventType: '迟到',
      description: '早读迟到', needsFollowup: true, followupDue: '2026-04-18',
    });
    updateWorkItem(Number(event.task_id), { status: '已完成', result: '已处理' });
    updateWorkItem(Number(event.task_id), { status: '待复查', result: '' });
    const source = db.connInstance.prepare(
      'SELECT status, closed_at FROM student_events WHERE id=?',
    ).get(Number(event.event_id));
    expect(source.status).toBe('待复查');
    expect(source.closed_at).toBe('');
  });

  it('request_id 幂等：重复更新返回 duplicate', () => {
    const focus = createFocus({ studentId: 2, topic: '测试幂等', reason: 'x', nextReviewAt: '2026-04-25' });
    const first = updateSource('focus', Number(focus.focus_id), {
      status: '跟进中', progress: '第一次', requestId: 'req-123',
    });
    const second = updateSource('focus', Number(focus.focus_id), {
      status: '跟进中', progress: '第二次（应被忽略）', requestId: 'req-123',
    });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    const updates = db.connInstance.prepare(
      'SELECT COUNT(*) AS c FROM workflow_updates WHERE idempotency_key=?',
    ).get('req-123');
    expect(updates.c).toBe(1);
  });
});

describe('时间筛选、URL 定位与汇总', () => {
  it('bucket 筛选：逾期/今天/未来 7 天/完成', () => {
    createWorkItem({ title: '已逾期任务', dueAt: '2026-04-10' });
    createWorkItem({ title: '今天任务', dueAt: '2026-04-15' });
    createWorkItem({ title: '未来任务', dueAt: '2026-04-18' });
    const done = createWorkItem({ title: '已完成任务', dueAt: '2026-04-14' });
    updateWorkItem(done.id, { status: '已完成', result: '完成' });

    expect(listWorkItems({ bucket: 'overdue' }).map((t) => t.title)).toEqual(['已逾期任务']);
    expect(listWorkItems({ bucket: 'today' }).map((t) => t.title)).toEqual(['今天任务']);
    expect(listWorkItems({ bucket: 'next7' }).map((t) => t.title)).toEqual(['未来任务']);
    expect(listWorkItems({ bucket: 'completed' }).map((t) => t.title)).toEqual(['已完成任务']);
  });

  it('decorate 提供 source_path 与 timing_state', () => {
    const item = createWorkItem({ title: 'x', sourceType: 'event', sourceId: 5, dueAt: '2026-04-14' });
    const [listed] = listWorkItems({});
    const target = listed;
    expect(target.source_path).toBe('/events?source_id=5');
    expect(target.timing_state).toBe('已逾期');
    expect(target.source_label).toBe('学生事件');
    void item;
  });

  it('work_item_summary 返回各桶数量', () => {
    createWorkItem({ title: '任务A', dueAt: '2026-04-10' });
    createWorkItem({ title: '任务B', dueAt: '2026-04-15' });
    const summary = workItemSummary();
    expect(summary.overdue).toBe(1);
    expect(summary.today).toBe(1);
    expect(summary.open).toBe(2);
  });
});

describe('学生详情与时间线', () => {
  it('时间线按时间倒序聚合事件/沟通/关注/跟进', () => {
    const eventResult = createEvent({
      studentId: 1, occurredAt: '2026-04-16 08:10', eventType: '迟到',
      description: '二次迟到', needsFollowup: true, followupDue: '2026-04-20',
    });
    createCommunication({
      studentId: 1, communicatedAt: '2026-04-15 09:00', method: '电话',
      reason: '沟通', summary: '约谈',
    });
    // 完成任务触发来源回写，产生 workflow 过程记录
    updateWorkItem(Number(eventResult.task_id), { status: '已完成', result: '已约谈家长' });
    const detail = studentDetail(1);
    const kinds = (detail.timeline as Array<Record<string, unknown>>).map((item) => item.kind);
    expect(kinds).toContain('event');
    expect(kinds).toContain('communication');
    expect(kinds).toContain('workflow');
    // 时间倒序
    const ats = (detail.timeline as Array<Record<string, unknown>>).map((item) => String(item.at));
    expect([...ats].sort().reverse()).toEqual(ats);
    expect((detail.insights as Record<string, unknown>).risk_level).toBeTruthy();
  });

  it('考勤保存后学生详情可见异常记录', () => {
    saveDailyAttendance('2026-04-15', '常规到校', [
      { student_id: 1, status: '迟到', reason: '堵车' },
      { student_id: 2, status: '出勤' },
    ]);
    const detail = studentDetail(1);
    expect((detail.attendance as Array<Record<string, unknown>>).length).toBe(1);
    expect((detail.attendance as Array<Record<string, unknown>>)[0].status).toBe('迟到');
  });
});

describe('HTTP 冒烟', () => {
  it('事件→任务→完成 全链路', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const create = await app.inject({
      method: 'POST', url: '/api/events',
      payload: {
        student_id: 1, occurred_at: '2026-04-15 08:10', event_type: '迟到',
        description: 'HTTP 事件', needs_followup: true, followup_due: '2026-04-18',
      },
    });
    expect(create.statusCode).toBe(200);
    const { event_id, task_id } = create.json();

    const tasks = await app.inject({ method: 'GET', url: '/api/tasks?bucket=open' });
    expect(tasks.statusCode).toBe(200);
    const openTasks = (tasks.json() as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(openTasks.some((item) => item.id === task_id)).toBe(true);

    const complete = await app.inject({
      method: 'PUT', url: `/api/tasks/${task_id}`,
      payload: { status: '已完成', result: '已处理' },
    });
    expect(complete.statusCode).toBe(200);
    expect((complete.json() as { task: Record<string, unknown> }).task.status).toBe('已完成');

    const workflow = await app.inject({
      method: 'GET', url: `/api/workflows/event/${event_id}`,
    });
    expect(workflow.statusCode).toBe(200);
    const source = (workflow.json() as { source: Record<string, unknown> }).source;
    expect(source.status).toBe('已完成');

    const detail = await app.inject({ method: 'GET', url: '/api/students/1/detail' });
    expect(detail.statusCode).toBe(200);
    const timeline = (detail.json() as { timeline: Array<Record<string, unknown>> }).timeline;
    expect(timeline.length).toBeGreaterThanOrEqual(2);
    await app.close();
  });

  it('并发创建事件各自生成独立工作项', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const payloads = Array.from({ length: 10 }, (_unused, index) => ({
      method: 'POST', url: '/api/events',
      payload: {
        student_id: (index % 3) + 1, occurred_at: `2026-04-15 08:1${index % 10}`,
        event_type: '迟到', description: `并发事件${index}`,
        needs_followup: true, followup_due: '2026-04-18',
      },
    }));
    const responses = await Promise.all(payloads.map((payload) => app.inject(payload)));
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const taskCount = db.connInstance.prepare(
      "SELECT COUNT(*) AS c FROM student_tasks WHERE source_type='event'",
    ).get().c;
    expect(taskCount).toBe(10);
    await app.close();
  });

  it('关闭来源不指定工作项处理方式时被拒（400）', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const focus = await app.inject({
      method: 'POST', url: '/api/focus',
      payload: { student_id: 1, topic: '测试', reason: 'x', next_review_at: '2026-04-25' },
    });
    const { focus_id } = focus.json();
    const close = await app.inject({
      method: 'PUT', url: `/api/focus/${focus_id}`,
      payload: { status: '已结束', conclusion: '结论' },
    });
    expect(close.statusCode).toBe(400);
    expect(close.json().detail).toContain('明确完成或取消');
    await app.close();
  });
});
