/* MIG-07 高频教师业务测试：考勤规则、成绩、班级任务、值日、校历。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';
import * as attendance from '../../src/services/attendance.js';
import * as scores from '../../src/services/scores.js';
import * as classTasks from '../../src/services/classTasks.js';
import * as duty from '../../src/services/duty.js';
import * as calendar from '../../src/services/schoolCalendar.js';
import * as scoresRules from '../../src/services/scoresRules.js';
import { saveDailyAttendance } from '../../src/services/p0Service.js';
import { updateWorkItem } from '../../src/services/workItems.js';

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
      .run(`S${String(index).padStart(3, '0')}`, `教师学生${index}`, index % 2 ? '男' : '女');
  }
  conn.prepare(
    `INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status)
     SELECT id, 1, 1, '在读' FROM students`,
  ).run();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig07-'));
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

describe('考勤规则：命中/工作项联动/解除/重开', () => {
  it('连续迟到达到阈值生成工作项与命中记录', () => {
    const rule = attendance.createRule({
      name: '早读迟到规则', metric: '迟到次数', threshold: 2, periodDays: 7, scene: '早自习',
    }) as Record<string, unknown>;
    const ruleId = Number(rule.rule_id);
    let evaluation: Record<string, unknown> = {};
    for (const date of ['2026-04-13', '2026-04-14']) {
      const saved = saveDailyAttendance(date, '早自习', [{ student_id: 1, status: '迟到' }]);
      // 保存后自动评估（与 Python save_daily 一致）
      evaluation = (saved.evaluation ?? {}) as Record<string, unknown>;
    }
    expect(evaluation.created_count).toBe(1);
    const task = db.connInstance.prepare(
      "SELECT * FROM student_tasks WHERE source_type='attendance_rule' AND source_id=?",
    ).get(ruleId);
    expect(task).toBeTruthy();
    const hit = db.connInstance.prepare(
      'SELECT * FROM attendance_rule_hits WHERE rule_id=? AND student_id=1',
    ).get(ruleId);
    expect(hit.status).toBe('待处理');
  });

  it('完成工作项 → 命中标记已处理；指标恢复 → 自动解除', () => {
    attendance.createRule({ name: '规则A', metric: '迟到次数', threshold: 1, periodDays: 7 });
    saveDailyAttendance('2026-04-15', '常规到校', [{ student_id: 1, status: '迟到' }]);
    const task = db.connInstance.prepare(
      "SELECT id FROM student_tasks WHERE source_type='attendance_rule'",
    ).get() as { id: number };

    updateWorkItem(Number(task.id), { status: '已完成', result: '已教育' });
    const handled = db.connInstance.prepare(
      "SELECT status FROM attendance_rule_hits WHERE task_id=?",
    ).get(task.id) as { status: string };
    expect(handled.status).toBe('已处理');

    // 指标恢复（当天改为出勤）后保存自动评估 → 解除
    const recovery = saveDailyAttendance('2026-04-15', '常规到校', [{ student_id: 1, status: '出勤' }]);
    expect((recovery.evaluation as Record<string, unknown>).resolved_count).toBe(1);
    const resolved = db.connInstance.prepare(
      "SELECT status FROM attendance_rule_hits WHERE task_id=?",
    ).get(task.id) as { status: string };
    expect(resolved.status).toBe('已解除');
  });

  it('停用规则自动解除未处理命中', () => {
    attendance.createRule({ name: '规则B', metric: '缺勤次数', threshold: 1, periodDays: 7 });
    saveDailyAttendance('2026-04-15', '常规到校', [{ student_id: 1, status: '缺勤' }]);
    const rule = db.connInstance.prepare(
      "SELECT id FROM attendance_rules WHERE name='规则B'",
    ).get() as { id: number };
    const result = attendance.updateRule(Number(rule.id), { enabled: false }) as
      { resolved_count: number };
    expect(result.resolved_count).toBe(1);
  });

  it('统计：异常/出勤率/日期桶', () => {
    saveDailyAttendance('2026-04-15', '常规到校', [
      { student_id: 1, status: '迟到' }, { student_id: 2, status: '出勤' },
    ]);
    saveDailyAttendance('2026-04-16', '常规到校', [
      { student_id: 1, status: '出勤' }, { student_id: 2, status: '出勤' },
    ]);
    const stats = attendance.attendanceStats({ dateFrom: '2026-04-01', dateTo: '2026-04-30' });
    expect(stats.total_records).toBe(4);
    expect(stats.status_count.迟到).toBe(1);
    const student1 = (stats.student_stats as Array<Record<string, unknown>>)
      .find((item) => item.student_id === 1);
    expect(student1?.punctual_rate).toBe(50);
    expect(student1?.presence_rate).toBe(100);
  });
});

describe('成绩：配置/导入/统计/规则', () => {
  it('科目+考试+成绩提交 → 汇总口径（缺考不计 0 分）', () => {
    scores.createSubject({ name: '物理', fullScore: 100 });
    scores.createSubject({ name: '化学', fullScore: 100 });
    scores.createExam({ name: '月考1', subjectIds: [1, 2] });
    scores.commitExamRows([
      { row: 1, valid: true, student_id: 1, exam_name: '月考1', exam_date: '2026-04-20', subject: '物理', score: 90, rank: 1, record_status: '正常', note: '' },
      { row: 2, valid: true, student_id: 1, exam_name: '月考1', exam_date: '2026-04-20', subject: '化学', score: null, rank: null, record_status: '缺考', note: '' },
    ], { filename: 'a.xlsx', requestId: 'r1' });
    const summary = scores.scoreSummary();
    const student = (summary.students as Array<Record<string, unknown>>)
      .find((item) => item.student_id === 1);
    const exam = (student!.exams as Array<Record<string, unknown>>)[0];
    // 缺考 → 总分不完整
    expect(exam.total).toBe(null);
    const records = scores.listRecords({ studentId: 1 });
    expect(records).toHaveLength(2);
  });

  it('完整成绩 → 总分与同分同名次排名', () => {
    scores.createSubject({ name: '语文', fullScore: 150 });
    scores.createSubject({ name: '数学', fullScore: 150 });
    scores.createExam({ name: '期末', subjectIds: [1, 2] });
    for (const [studentId, scoresList] of [
      [1, [100, 90]], [2, [100, 90]], [3, [80, 60]],
    ] as Array<[number, number[]]>) {
      scores.commitExamRows([
        { row: 1, valid: true, student_id: studentId, exam_name: '期末', subject: '语文', score: scoresList[0], record_status: '正常' },
        { row: 2, valid: true, student_id: studentId, exam_name: '期末', subject: '数学', score: scoresList[1], record_status: '正常' },
      ], { filename: 'x.xlsx', requestId: `r-${studentId}` });
    }
    const summary = scores.scoreSummary();
    const students = (summary.students as Array<Record<string, unknown>>).filter(
      (item) => (item.exams as Array<Record<string, unknown>>).some((e) => e.total !== null));
    expect(students).toHaveLength(3);
    // 班排名在每场考试的 exam 结果上（同分同名次）
    const ranks = students.map((item) =>
      ((item.exams as Array<Record<string, unknown>>)[0].rank as number) ?? 0);
    expect(ranks).toEqual([1, 1, 3]);
  });

  it('成绩规则：下降命中 + 工作项联动 + 完成已处理', () => {
    scores.createSubject({ name: '英语', fullScore: 100 });
    scores.createExam({ name: '考试1', subjectIds: [1] });
    scores.createExam({ name: '考试2', subjectIds: [1] });
    scores.commitExamRows([
      { row: 1, valid: true, student_id: 1, exam_name: '考试1', subject: '英语', score: 90, record_status: '正常' },
    ], { filename: 'x.xlsx', requestId: 'r-a' });
    const rule = scoresRulesCreate('下降规则', '总分下降', 5);
    scores.commitExamRows([
      { row: 1, valid: true, student_id: 1, exam_name: '考试2', subject: '英语', score: 70, record_status: '正常' },
    ], { filename: 'y.xlsx', requestId: 'r-b' });
    const evaluation = evaluateScoreRules();
    expect(evaluation.hit_count).toBe(1);
    const task = db.connInstance.prepare(
      "SELECT id FROM student_tasks WHERE source_type='score_rule'",
    ).get() as { id: number };
    updateWorkItem(Number(task.id), { status: '已完成', result: '已辅导' });
    const hit = db.connInstance.prepare(
      'SELECT status FROM score_rule_hits WHERE rule_id=? AND student_id=1',
    ).get(Number(rule)) as { status: string };
    expect(hit.status).toBe('已处理');
  });
});

describe('班级任务：材料收集/缺交例外/附件', () => {
  it('创建任务按学生生成收集项，缺交完成被拒并给出名单', () => {
    const task = classTasks.createTask({
      title: '收作业', taskType: '材料收集', dueAt: '2026-04-18',
      materialName: '作业本', studentIds: [1, 2, 3],
    });
    classTasks.updateItem(Number(task.id), 1, { status: '已提交' });
    expect(() => classTasks.updateTask(Number(task.id), { status: '已完成', completionResult: '收齐' }))
      .toThrow(/未提交材料/);
    const confirm = classTasks.updateTask(Number(task.id), {
      status: '已完成', completionResult: '2 人缺交', confirmIncomplete: true,
    });
    expect(confirm.closed_with_missing_count).toBe(2);
  });

  it('附件保存到数据目录并可读取', () => {
    const task = classTasks.createTask({ title: '带附件任务', studentIds: [1] });
    const saved = classTasks.saveAttachment(Number(task.id), 1, {
      filename: '材料.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 测试'),
    });
    expect(saved.original_name).toBe('材料.pdf');
    const result = classTasks.attachmentFile(Number(saved.id));
    expect(result.path).toContain(db.paths.dataDir);
    expect(fs.existsSync(result.path)).toBe(true);
  });
});

describe('值日与轮换', () => {
  it('创建值日冲突检测（409 语义）', () => {
    duty.createAssignment({ dutyDate: '2026-04-15', area: '教室', studentId: 1 });
    expect(() => duty.createAssignment({ dutyDate: '2026-04-15', area: '走廊', studentId: 1 }))
      .toThrow(duty.DutyConflictError);
  });

  it('轮换规则按周生成安排', () => {
    duty.createRotationRule({
      name: '教室轮换', area: '教室', startDate: '2026-04-13', weekdayMask: 31,
      studentIds: [1, 2, 3],
    });
    const rule = db.connInstance.prepare(
      "SELECT id FROM duty_rotation_rules WHERE name='教室轮换'",
    ).get() as { id: number };
    const result = duty.generateRotation(Number(rule.id), {
      dateFrom: '2026-04-13', dateTo: '2026-04-19', confirm: true,
    });
    expect(result.preview).toBe(false);
    expect(Number(result.created ?? 0)).toBeGreaterThan(0);
    const assignments = duty.listAssignments({ dateFrom: '2026-04-13', dateTo: '2026-04-19' });
    expect(assignments.length).toBeGreaterThanOrEqual(5);
  });
});

describe('学期校历', () => {
  it('创建/更新校历条目与学期网格', () => {
    const created = calendar.createEntry('2026-04-15', '考试日', '期中考试', true, '');
    expect(Number(created.id)).toBeGreaterThan(0);
    const list = calendar.listCalendar('2026-04-01', '2026-04-30');
    const entries = (list.entries as Array<Record<string, unknown>>);
    expect(entries.length).toBe(1);
    calendar.updateEntry(Number(entries[0].id), '2026-04-15', '放假日', '', false, '');
    const term = calendar.termCalendar();
    expect(term.scope).toBeTruthy();
    expect((term.weeks as Array<unknown>).length).toBeGreaterThan(0);
  });

  it('提交导入（request_id 幂等）', () => {
    const first = calendar.commitImport([
      { calendar_date: '2026-04-06', day_type: '上课日', title: '', is_school_day: true, note: '' },
    ], 'a.xlsx', 'req-cal-1');
    expect(first.imported).toBe(1);
    const second = calendar.commitImport([
      { calendar_date: '2026-04-06', day_type: '上课日', title: '', is_school_day: true, note: '' },
    ], 'a.xlsx', 'req-cal-1');
    expect(second.idempotent).toBe(true);
  });
});

describe('HTTP 冒烟', () => {
  it('规则/成绩/任务/值日/校历端点连通', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const rule = await app.inject({
      method: 'POST', url: '/api/attendance/rules',
      payload: { name: 'HTTP规则', metric: '迟到次数', threshold: 2, period_days: 7, scene: '早自习' },
    });
    expect(rule.statusCode).toBe(200);

    const subject = await app.inject({
      method: 'POST', url: '/api/score-config/subjects',
      payload: { name: '物理', full_score: 100 },
    });
    expect(subject.statusCode).toBe(200);

    const task = await app.inject({
      method: 'POST', url: '/api/class-tasks',
      payload: { title: 'HTTP任务', student_ids: [1, 2] },
    });
    expect(task.statusCode).toBe(200);

    const dutyRes = await app.inject({
      method: 'POST', url: '/api/duty',
      payload: { duty_date: '2026-04-15', area: '走廊', student_id: 1 },
    });
    expect(dutyRes.statusCode).toBe(200);

    const cal = await app.inject({
      method: 'POST', url: '/api/school-calendar',
      payload: { calendar_date: '2026-04-15', day_type: '上课日' },
    });
    expect(cal.statusCode).toBe(200);

    const search = await app.inject({ method: 'GET', url: '/api/search?q=教师' });
    expect(search.statusCode).toBe(200);
    expect((search.json() as { results: unknown[] }).results.length).toBeGreaterThan(0);

    const summary = await app.inject({ method: 'GET', url: '/api/exams/summary' });
    expect(summary.statusCode).toBe(200);
    await app.close();
  });

  it('缺交完成返回 409 与名单', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const created = await app.inject({
      method: 'POST', url: '/api/class-tasks',
      payload: { title: '收齐检查', student_ids: [1, 2] },
    });
    const { task_id } = created.json();
    const close = await app.inject({
      method: 'PUT', url: `/api/class-tasks/${task_id}`,
      payload: { status: '已完成', completion_result: '收齐' },
    });
    expect(close.statusCode).toBe(409);
    expect(close.json().missing_students).toBeTruthy();
    await app.close();
  });
});

function scoresRulesCreate(name: string, metric: string, threshold: number): number {
  const result = scoresRules.createRule({ name, metric, threshold, priority: '重要', enabled: true }) as
    { rule_id: number };
  return Number(result.rule_id);
}

function evaluateScoreRules(): Record<string, unknown> {
  return scoresRules.evaluateRules({ trigger: 'manual' }) as Record<string, unknown>;
}
