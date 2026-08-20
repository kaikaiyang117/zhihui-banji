/* MIG-10 小组与宿舍管理：范围、成员冲突、床位冲突和入住历史。 */
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
  createGroup, createGroup as createStudentGroup, replaceMembers, listUnassigned,
  GroupError,
} from '../../src/services/groups.js';
import {
  assignBed, checkoutAssignment, createRoom, listAssignments, listRooms,
  moveAssignment, updateRoom, setRoomLeader, createInspection, getInspection, listInspections, DormitoryError,
} from '../../src/services/dormitories.js';

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

function seedStudents(): void {
  const conn = db.connInstance;
  const students = [
    ['S001', '男生一', '男'], ['S002', '男生二', '男'],
    ['S003', '女生一', '女'], ['S004', '女生二', '女'],
  ];
  for (const [studentNo, name, gender] of students) {
    conn.prepare('INSERT INTO students(学号, 姓名, 性别) VALUES(?,?,?)').run(studentNo, name, gender);
  }
  conn.prepare(
    `INSERT INTO student_enrollments(student_id, class_id, term_id, status)
     SELECT id, 1, 1, '在读' FROM students`,
  ).run();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig10-'));
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

describe('小组管理', () => {
  it('迁移到 v29，并按小组类型阻止学生重复分组', () => {
    expect(schemaVersion(db.connInstance)).toBe(33);
    const group = createStudentGroup({ name: '第一组', groupType: '学习小组' });
    const updated = replaceMembers(Number(group.id), [
      { studentId: 1, role: '组长', sortOrder: 0 },
      { studentId: 2, role: '成员', sortOrder: 1 },
    ]);
    expect(updated.member_count).toBe(2);
    expect((updated.members as Array<Record<string, unknown>>)[0].role).toBe('组长');

    const second = createGroup({ name: '第二组', groupType: '学习小组' });
    expect(() => replaceMembers(Number(second.id), [{ studentId: 1 }])).toThrow(GroupError);
    expect(listUnassigned('学习小组').map(student => student.学号)).toEqual(['S003', 'S004']);
  });

  it('同一学生可以加入不同类型的小组，退出后可以重新加入', () => {
    const study = createGroup({ name: '学习组', groupType: '学习小组' });
    const duty = createGroup({ name: '值日组', groupType: '值日小组' });
    replaceMembers(Number(study.id), [{ studentId: 1 }]);
    replaceMembers(Number(duty.id), [{ studentId: 1 }]);
    replaceMembers(Number(study.id), []);
    const restored = replaceMembers(Number(study.id), [{ studentId: 1, role: '组长' }]);
    expect(restored.member_count).toBe(1);
    expect((restored.members as Array<Record<string, unknown>>)[0].status).toBe('在组');
  });
});

describe('宿舍与床位', () => {
  it('校验性别和床位占用，支持调宿与退宿历史', () => {
    const maleRoom = createRoom({ building: '一号楼', floor: '1', roomNo: '101', genderLimit: '男', capacity: 2 });
    const targetRoom = createRoom({ building: '一号楼', floor: '1', roomNo: '102', genderLimit: '男', capacity: 1 });
    const femaleRoom = createRoom({ building: '一号楼', floor: '2', roomNo: '201', genderLimit: '女', capacity: 1 });
    const maleBed1 = (maleRoom.beds as Array<Record<string, unknown>>)[0].id as number;
    const maleBed2 = (maleRoom.beds as Array<Record<string, unknown>>)[1].id as number;
    const targetBed = (targetRoom.beds as Array<Record<string, unknown>>)[0].id as number;
    const femaleBed = (femaleRoom.beds as Array<Record<string, unknown>>)[0].id as number;

    const first = assignBed({ studentId: 1, bedId: maleBed1, moveInAt: '2026-08-15' });
    expect(() => assignBed({ studentId: 2, bedId: maleBed1 })).toThrow('该床位已经有人入住');
    expect(() => assignBed({ studentId: 3, bedId: maleBed2 })).toThrow('该宿舍仅限男生入住');
    assignBed({ studentId: 2, bedId: maleBed2 });
    expect(() => updateRoom(Number(maleRoom.id), { capacity: 1 })).toThrow('不能移除当前入住床位');
    expect(() => assignBed({ studentId: 4, bedId: targetBed })).toThrow('该宿舍仅限男生入住');

    const moved = moveAssignment(Number(first.id), { bedId: targetBed, reason: '同楼调宿', moveInAt: '2026-08-20' });
    expect(moved.room_no).toBe('102');
    const checkedOut = checkoutAssignment(Number(moved.id), { reason: '离校' });
    expect(checkedOut.status).toBe('退宿');
    expect(listAssignments().map(item => item.姓名)).toEqual(['男生二']);
    expect(listRooms().find(room => room.room_no === '102')?.occupied_count).toBe(0);
    const remaining = listAssignments().find(item => Number(item.student_id) === 2);
    checkoutAssignment(Number(remaining?.id), { reason: '容量测试' });
    const shrunk = updateRoom(Number(maleRoom.id), { capacity: 1 });
    expect(shrunk.capacity).toBe(1);
    expect((shrunk.beds as Array<Record<string, unknown>>)).toHaveLength(1);
  });

  it('房间接口返回当前占用和未分配学生', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/dormitories/unassigned' });
    expect(response.statusCode).toBe(200);
    expect(response.json().students).toHaveLength(4);
    await app.close();
    expect(() => createRoom({ roomNo: '无效', capacity: 0 })).toThrow(DormitoryError);
    expect(() => createRoom({ roomNo: '超容量', capacity: 9 })).toThrow('床位数必须在 1 到 8 之间');
  });

  it('支持指定寝室长和记录查寝状态', () => {
    const room = createRoom({ building: '一号楼', floor: '1', roomNo: '103', genderLimit: '男', capacity: 2 });
    const beds = room.beds as Array<Record<string, unknown>>;
    assignBed({ studentId: 1, bedId: Number(beds[0].id) });
    assignBed({ studentId: 2, bedId: Number(beds[1].id) });

    const leader = setRoomLeader(Number(room.id), 1, { assignedAt: '2026-08-15' });
    expect(leader?.姓名).toBe('男生一');
    expect(listRooms().find(item => Number(item.id) === Number(room.id))?.leader).toMatchObject({ student_id: 1 });
    expect(() => setRoomLeader(Number(room.id), 3)).toThrow('当前入住学生');

    const inspection = createInspection({
      inspectionDate: '2026-08-15', inspectionTime: '20:30', inspector: '班主任',
      records: [
        { studentId: 1, status: '在寝' },
        { studentId: 2, status: '晚归', note: '20:40返回' },
      ],
    });
    expect((inspection.records as Array<Record<string, unknown>>)).toHaveLength(2);
    expect((getInspection(Number(inspection.id)).records as Array<Record<string, unknown>>)[1].status).toBe('晚归');
    expect(listInspections()[0]).toMatchObject({ record_count: 2, present_count: 1, late_count: 1 });

    const targetRoom = createRoom({ building: '一号楼', floor: '1', roomNo: '104', genderLimit: '男', capacity: 1 });
    const targetBed = (targetRoom.beds as Array<Record<string, unknown>>)[0].id as number;
    const firstAssignment = listAssignments().find(item => Number(item.student_id) === 1);
    const moved = moveAssignment(Number(firstAssignment?.id), { bedId: targetBed, reason: '自动解除寝室长测试' });
    expect(listRooms().find(item => Number(item.id) === Number(room.id))?.leader).toBeNull();
    setRoomLeader(Number(targetRoom.id), 1);
    checkoutAssignment(Number(moved.id), { reason: '测试退宿' });
    expect(listRooms().find(item => Number(item.id) === Number(targetRoom.id))?.leader).toBeNull();
  });
});
