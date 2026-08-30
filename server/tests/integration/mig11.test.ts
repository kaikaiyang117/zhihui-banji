/* MIG-11 课程表：节次、固定周课表、临时变更和导入。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { schemaVersion } from '../../src/db/schema.js';
import { setDatabase } from '../../src/services/context.js';
import {
  cancelChange, commitImport, createEntry, createPeriod, daySchedule, listTimetable,
  previewImport, saveChange,
} from '../../src/services/timetable.js';
import { getTeacherTimetable } from '../../src/services/teacherClasses.js';

let tempDir: string;
let db: WorkbenchDb;

function testConfig(): ReturnType<typeof loadConfig> {
  const previous = { ...process.env };
  process.env.WORKBENCH_DATA_DIR = tempDir;
  process.env.WORKBENCH_STATIC_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'static');
  process.env.WORKBENCH_VERSION = '9.8.7';
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  const config = loadConfig();
  process.env = previous;
  return config;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig11-'));
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
  db.connInstance.prepare("UPDATE terms SET start_date='2026-04-13', end_date='2026-07-10' WHERE id=1").run();
  db.connInstance.prepare(
    "INSERT INTO school_calendar_days(academic_term_id, calendar_date, day_type, is_school_day) "
      + "SELECT academic_term_id, '2026-04-15', '上课日', 1 FROM terms WHERE id=1",
  ).run();
});

afterEach(() => {
  db.close();
  setDatabase(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('课程表服务', () => {
  it('迁移到 v40，支持固定周课表和按日解析', () => {
    expect(schemaVersion(db.connInstance)).toBe(40);
    createPeriod({ periodNo: 1, label: '第1节', startTime: '08:00', endTime: '08:45' });
    createPeriod({ periodNo: 2, label: '第2节', startTime: '08:55', endTime: '09:40' });
    createEntry({ weekday: 3, periodNo: 1, subject: '数学', teacherName: '王老师', room: '高一1班' });
    createEntry({ weekday: 3, periodNo: 2, subject: '物理', teacherName: '李老师', weekPattern: '双周' });
    const day = daySchedule('2026-04-15');
    expect(day.week_no).toBe(1);
    expect((day.entries as Array<Record<string, unknown>>)[0].entry).toMatchObject({ subject: '数学', teacher_name: '王老师' });
    expect((day.entries as Array<Record<string, unknown>>)[1].entry).toBeNull();
    const list = listTimetable({ teacherName: '王老师' });
    expect(list.entries).toHaveLength(1);
  });

  it('临时调课覆盖原课程，取消后恢复', () => {
    createPeriod({ periodNo: 1 });
    createEntry({ weekday: 3, periodNo: 1, subject: '数学', teacherName: '王老师' });
    const change = saveChange({ changeDate: '2026-04-15', periodNo: 1, action: '代课', subject: '物理', teacherName: '李老师', note: '王老师外出' });
    expect(daySchedule('2026-04-15').entries[0].entry).toMatchObject({ subject: '物理', is_change: true, original_subject: '数学' });
    cancelChange(Number(change.id));
    expect(daySchedule('2026-04-15').entries[0].entry).toMatchObject({ subject: '数学' });
  });

  it('导入预览校验并按 request_id 幂等提交', () => {
    const rows = [
      ['星期', '节次', '节次名称', '开始时间', '结束时间', '科目', '任课教师', '教室', '单双周'],
      ['周三', 1, '第1节', '08:00', '08:45', '语文', '张老师', '高一1班', '全周'],
      ['周八', 2, '第2节', '09:00', '09:45', '错误', '', '', '全周'],
    ];
    const preview = previewImport(rows, '课程表.xlsx');
    expect((preview.summary as Record<string, number>).valid).toBe(1);
    const result = commitImport(preview.rows as Array<Record<string, unknown>>, '课程表.xlsx', 'req-1');
    expect(result.imported).toBe(1);
    expect(commitImport(preview.rows as Array<Record<string, unknown>>, '课程表.xlsx', 'req-1')).toMatchObject({ duplicate: true });
    expect(db.connInstance.prepare('SELECT COUNT(*) AS count FROM timetable_entries').get()).toMatchObject({ count: 1 });
  });

  it('任课教师汇总只返回已配置学科的课程', () => {
    createPeriod({ periodNo: 1 });
    createPeriod({ periodNo: 2 });
    createEntry({ weekday: 1, periodNo: 1, subject: '英语', teacherName: '陈老师' });
    createEntry({ weekday: 1, periodNo: 2, subject: '数学', teacherName: '李老师' });
    const classResult = db.connInstance.prepare(
      "INSERT INTO classes(name, grade) VALUES('高一1班', '高一')",
    ).run();
    const classId = Number(classResult.lastInsertRowid);
    const termResult = db.connInstance.prepare(
      "INSERT INTO terms(class_id, name, start_date, end_date) VALUES(?, '当前学期', '2026-04-13', '2026-07-10')",
    ).run(classId);
    const termId = Number(termResult.lastInsertRowid);
    db.connInstance.prepare(
      "INSERT INTO timetable_entries(class_id, term_id, weekday, period_no, subject, teacher_name, status) VALUES(?,?,?,?,?,?, '启用')",
    ).run(classId, termId, 1, 1, '英语', '陈老师');
    db.connInstance.prepare(
      "INSERT INTO timetable_entries(class_id, term_id, weekday, period_no, subject, teacher_name, status) VALUES(?,?,?,?,?,?, '启用')",
    ).run(classId, termId, 1, 2, '物理', '张老师');
    db.connInstance.prepare(
      "INSERT INTO teacher_classes(teacher_name, class_id, role, subjects) VALUES('default', 1, '任课教师', '英语')",
    ).run();
    db.connInstance.prepare(
      "INSERT INTO teacher_classes(teacher_name, class_id, role, subjects) VALUES('default', ?, '任课教师', '英语')",
    ).run(classId);

    const entries = getTeacherTimetable({ conn: db.connInstance });
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.subject)).toEqual(['英语', '英语']);
    expect(entries.map((entry) => entry.class_name)).toEqual(['我的班级', '高一1班']);
  });

  it('接口支持课程表读取与模板下载', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/timetable/day?date=2026-04-15' });
    expect(response.statusCode).toBe(200);
    const template = await app.inject({ method: 'GET', url: '/api/timetable/template' });
    expect(template.statusCode).toBe(200);
    expect(template.headers['content-type']).toContain('spreadsheetml');
    await app.close();
  });

  it('未传日期时使用全局业务日期', async () => {
    const previous = process.env.WORKBENCH_BUSINESS_DATE;
    process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
    const app = buildApp({ config: testConfig() });
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/timetable/day' });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).date).toBe('2026-04-15');
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.WORKBENCH_BUSINESS_DATE;
      else process.env.WORKBENCH_BUSINESS_DATE = previous;
    }
  });
});
