import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateMeetingPlan } from '../../src/agent/meetingPrepDrafter.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';
import { generateStudentSummary } from '../../src/services/meetingPrep.js';

let tempDir: string;
let db: WorkbenchDb;

function seed(): void {
  const conn = db.connInstance;
  conn.prepare("UPDATE terms SET name='2026春季学期', start_date='2026-02-23', end_date='2026-07-10', status='进行中' WHERE id=1").run();
  conn.prepare('INSERT INTO students(学号, 姓名, 性别, 家庭住址, 监护人电话) VALUES(?,?,?,?,?)')
    .run('S001', '测试学生', '女', '不应进入模型的地址', '13800138000');
  conn.prepare(
    `INSERT INTO student_enrollments(student_id, class_id, term_id, status)
     VALUES(1, 1, 1, '在读')`,
  ).run();
  conn.prepare(
    `INSERT INTO exam_records(student_id, class_id, term_id, exam_name, exam_date, subject, score)
     VALUES(1, 1, 1, '四月月考', '2026-04-10', '语文', 86)`,
  ).run();
  conn.prepare(
    `INSERT INTO exam_records(student_id, class_id, term_id, exam_name, exam_date, subject, score)
     VALUES(1, 1, 1, '未来考试', '2026-05-20', '语文', 90)`,
  ).run();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-prep-'));
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

describe('AI 会谈准备', () => {
  it('默认使用当前学期开始至业务今天，并排除未来记录和敏感字段', () => {
    const summary = generateStudentSummary({
      studentId: 1,
      includeAttendance: false,
      includePoints: false,
      includeCommunications: false,
      includeEvents: false,
    });
    expect(summary.date_range).toEqual({ start: '2026-02-23', end: '2026-04-15' });
    expect(summary.sections[0].items).toHaveLength(1);
    expect(summary.sections[0].items[0].exam_name).toBe('四月月考');
    expect(summary.student).not.toHaveProperty('家庭住址');
    expect(summary.student).not.toHaveProperty('监护人电话');
  });

  it('拒绝未来截止日期和空资料范围', () => {
    expect(() => generateStudentSummary({ studentId: 1, dateEnd: '2026-05-01' }))
      .toThrow('截止日期不能晚于今天');
    expect(() => generateStudentSummary({
      studentId: 1,
      includeScores: false,
      includeAttendance: false,
      includePoints: false,
      includeCommunications: false,
      includeEvents: false,
    })).toThrow('至少选择一类');
  });

  it('只把筛选后的结构化事实交给模型，并解析带依据的会谈方案', async () => {
    const summary = generateStudentSummary({
      studentId: 1,
      dateStart: '2026-04-01',
      dateEnd: '2026-04-15',
      includeAttendance: false,
      includePoints: false,
      includeCommunications: false,
      includeEvents: false,
    });
    const calls: Array<Array<Record<string, unknown>>> = [];
    const modelClient = {
      config: { model: 'fake-model' },
      async complete(messages: Array<Record<string, unknown>>) {
        calls.push(messages);
        return {
          content: JSON.stringify({
            meeting_focus: '围绕四月月考表现，与家长共同确认后续学习安排。',
            strengths: [{ text: '语文成绩为86分。', evidence_refs: ['F1'] }],
            concerns: [{ text: '没有事实支持的关注点。', evidence_refs: ['F999'] }],
            questions_to_verify: ['在家完成语文学习任务时是否存在困难？'],
            suggested_opening: '先肯定孩子近期投入，再说明本次沟通希望共同制定可执行安排。',
            talking_points: ['核对近期学习节奏', '了解家庭观察'],
            agreements_to_confirm: ['确认下一阶段复习安排'],
            outline: '一、肯定近期投入\n二、核对学习情况\n三、确认后续安排',
            warnings: [],
          }),
          tool_calls: [],
          reasoning_content: '',
          usage: null,
        };
      },
    };
    const result = await generateMeetingPlan({
      summary,
      purpose: '阶段学习沟通',
      teacherNotes: '重点了解语文学习节奏',
      modelClient,
    });
    const prompt = JSON.stringify(calls[0]);
    expect(prompt).toContain('2026-04-10');
    expect(prompt).not.toContain('2026-05-20');
    expect(prompt).not.toContain('不应进入模型的地址');
    expect(result.plan.strengths[0].evidence_refs).toEqual(['F1']);
    expect(result.plan.concerns).toEqual([]);
    expect(result.plan.warnings).toContain('“没有事实支持的关注点。”缺少可核对依据，请教师确认');
    expect(result.model).toBe('fake-model');
  });

  it('缺少会谈目的时不调用模型', async () => {
    const summary = generateStudentSummary({ studentId: 1 });
    let called = false;
    await expect(generateMeetingPlan({
      summary,
      purpose: '',
      modelClient: {
        async complete() {
          called = true;
          throw new Error('不应调用');
        },
      },
    })).rejects.toThrow('请选择本次会谈目的');
    expect(called).toBe(false);
  });
});
