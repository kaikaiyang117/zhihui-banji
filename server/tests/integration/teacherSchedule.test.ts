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
  createTeacherScheduleEntry, getTeacherSchedule, removeTeacherScheduleEntry, TeacherClassError,
  updateTeacherScheduleEntry,
} from '../../src/services/teacherClasses.js';

let tempDir: string;
let db: WorkbenchDb;

function testConfig(): ReturnType<typeof loadConfig> {
  const previous = { ...process.env };
  process.env.WORKBENCH_DATA_DIR = tempDir;
  process.env.WORKBENCH_STATIC_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'static');
  const config = loadConfig();
  process.env = previous;
  return config;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-schedule-'));
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
});

afterEach(() => {
  db.close();
  setDatabase(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function addClass(name = '高一5班'): number {
  const classId = Number(db.connInstance.prepare("INSERT INTO classes(name, grade) VALUES(?, '高一')").run(name).lastInsertRowid);
  db.connInstance.prepare("INSERT INTO terms(class_id, name, status) VALUES(?, '当前学期', '进行中')").run(classId);
  return classId;
}

describe('教师个人周课表', () => {
  it('迁移到 v40，并支持按星期、节次和班级维护个人课表', () => {
    expect(schemaVersion(db.connInstance)).toBe(40);
    const classId = addClass();
    const created = createTeacherScheduleEntry({ classId, weekday: 2, periodNo: 3, subject: '政治', room: '教学楼305' });
    expect(created).toMatchObject({ class_name: '高一5班', weekday: 2, period_no: 3, subject: '政治' });
    expect(() => createTeacherScheduleEntry({ classId, weekday: 2, periodNo: 3 }))
      .toThrowError(new TeacherClassError('该时间已有授课安排'));

    const updated = updateTeacherScheduleEntry(Number(created.id), { weekday: 4, periodNo: 2, subject: '思想政治' });
    expect(updated).toMatchObject({ weekday: 4, period_no: 2, subject: '思想政治' });
    const schedule = getTeacherSchedule();
    expect(schedule.periods).toHaveLength(8);
    expect(schedule.entries).toMatchObject([{ class_name: '高一5班', weekday: 4, period_no: 2 }]);

    removeTeacherScheduleEntry(Number(created.id));
    expect(getTeacherSchedule().entries).toEqual([]);
  });

  it('网页接口可以新增、读取、修改和移除授课安排', async () => {
    const classId = addClass('高二2班');
    const app = buildApp({ config: testConfig() });
    await app.ready();
    try {
      const created = await app.inject({
        method: 'POST', url: '/api/teacher/schedule',
        payload: { class_id: classId, weekday: 1, period_no: 1, subject: '政治' },
      });
      expect(created.statusCode).toBe(200);
      const entryId = Number(JSON.parse(created.body).entry.id);
      const listed = await app.inject({ method: 'GET', url: '/api/teacher/schedule' });
      expect(JSON.parse(listed.body).entries).toMatchObject([{ class_name: '高二2班', subject: '政治' }]);
      const updated = await app.inject({
        method: 'PUT', url: `/api/teacher/schedule/${entryId}`,
        payload: { weekday: 3, period_no: 4, room: '高二2班教室' },
      });
      expect(JSON.parse(updated.body).entry).toMatchObject({ weekday: 3, period_no: 4, room: '高二2班教室' });
      const removed = await app.inject({ method: 'DELETE', url: `/api/teacher/schedule/${entryId}` });
      expect(removed.statusCode).toBe(200);
      expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/teacher/schedule' })).body).entries).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
