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
  db.connInstance.prepare("INSERT INTO school_calendar_days(class_id, term_id, calendar_date, day_type, is_school_day) VALUES(1,1,'2026-04-15','上课日',1)").run();
});

afterEach(() => {
  db.close();
  setDatabase(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('课程表服务', () => {
  it('迁移到 v29，支持固定周课表和按日解析', () => {
    expect(schemaVersion(db.connInstance)).toBe(33);
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
});
