/* MIG-05 基础资料与通用数据测试。
 *
 * 验收重点：中文字段、空值、学号唯一、跨班级/学期隔离、归档写保护、
 * 导入整批回滚、故障行报告、头像路径与类型安全、派生列、座位表、结转。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase, scopeIds, bindRequestScope } from '../../src/services/context.js';
import { enrollStudent as contextEnrollStudent } from '../../src/services/context.js';

vi.mock('../../src/services/context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/context.js')>();
  return { ...actual, enrollStudent: vi.fn(actual.enrollStudent) };
});
import {
  createClass, createTerm, updateTerm, rolloverTerm, transferEnrollment,
  enrollStudent, updateEnrollment, listContexts, ArchivedScopeError,
} from '../../src/services/context.js';
import { createStudent, savePhoto, StudentDuplicateError, StudentPhotoError } from '../../src/services/students.js';
import { previewStudents, commitStudentImport, buildTemplate } from '../../src/services/importService.js';
import * as importService from '../../src/services/importService.js';
import { derive, getRows, insertRow, attendanceCompatibilityRows } from '../../src/services/sheets.js';
import { softDelete } from '../../src/services/recycle.js';
import { softDeleteSheetRow } from '../../src/services/recycleSheets.js';
import ExcelJS from 'exceljs';

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

function seedStudents(count = 3): void {
  const conn = db.connInstance;
  for (let index = 1; index <= count; index += 1) {
    conn.prepare('INSERT INTO students(学号, 姓名, 性别, 班级任职) VALUES(?,?,?,?)')
      .run(`S${String(index).padStart(3, '0')}`, `测试学生${index}`, index % 2 ? '男' : '女', index === 1 ? '班长' : '');
  }
  conn.prepare(
    `INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status)
     SELECT id, 1, 1, '在读' FROM students`,
  ).run();
}

async function buildImportXlsx(rows: Array<Array<unknown>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('学生信息');
  ws.getRow(1).values = ['学号', '姓名', '性别', '班级任职'];
  rows.forEach((row, index) => {
    ws.getRow(index + 2).values = row;
  });
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig05-'));
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
  seedStudents();
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  setDatabase(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('班级/学期/在班关系', () => {
  it('创建班级自动建首个学期，listContexts 展示结构与学生数', () => {
    const { class_id, term_id } = createClass('高一3班', '高一', '2026 春季');
    expect(class_id).toBeGreaterThan(1);
    expect(term_id).toBeGreaterThan(0);
    const ctx = listContexts();
    const target = (ctx.classes as Array<Record<string, unknown>>)
      .find((item) => item.id === class_id);
    expect(target).toBeTruthy();
    expect((target!.terms as Array<Record<string, unknown>>)[0].name).toBe('2026 春季');
  });

  it('学期结转复制在读学生与规则配置，原学期归档', () => {
    const sourceTerm = scopeIds()[1];
    db.connInstance.prepare(
      "INSERT INTO attendance_rules(name, metric, threshold, scene, class_id, term_id) "
      + "VALUES('早读规则', '迟到次数', 3, '早自习', 1, ?)",
    ).run(sourceTerm);
    const result = rolloverTerm(sourceTerm, '2026 秋季');
    expect(result.term_id).toBeGreaterThan(0);
    const copied = db.connInstance.prepare(
      'SELECT COUNT(*) AS c FROM attendance_rules WHERE term_id=?',
    ).get(result.term_id) as { c: number };
    expect(copied.c).toBe(1);
    const archived = db.connInstance.prepare(
      "SELECT status FROM terms WHERE id=?",
    ).get(sourceTerm) as { status: string };
    expect(archived.status).toBe('已归档');
  });

  it('转班：原在班转出、目标学期在读', () => {
    const [classId, termId] = scopeIds();
    const newClass = createClass('高一4班');
    const newTerm = createTerm(Number(newClass.class_id), '2026 秋季');
    const enrollmentId = enrollStudent(1);
    const targetId = transferEnrollment(enrollmentId, Number(newClass.class_id), newTerm);
    expect(targetId).toBeGreaterThan(0);
    const status = db.connInstance.prepare(
      'SELECT status FROM student_enrollments WHERE id=?',
    ).get(enrollmentId) as { status: string };
    expect(status.status).toBe('转出');
    const targetStatus = db.connInstance.prepare(
      'SELECT status FROM student_enrollments WHERE id=?',
    ).get(targetId) as { status: string };
    expect(targetStatus.status).toBe('在读');
    void classId; void termId;
  });

  it('归档学期禁止修改在班状态（ArchivedScopeError）', () => {
    const [classId] = scopeIds();
    const archivedTerm = createTerm(classId, '已归档学期');
    const enrollmentId = enrollStudent(1, { termId: archivedTerm });
    updateTerm(archivedTerm, { status: '已归档' });
    // 模拟请求绑定到已归档学期（与真实页面一致）
    bindRequestScope(classId, archivedTerm);
    expect(() => updateEnrollment(enrollmentId, '转出')).toThrow(ArchivedScopeError);
    expect(() => enrollStudent(2, { termId: archivedTerm })).toThrow(ArchivedScopeError);
    bindRequestScope(null, null);
  });

  it('班级与学期不匹配时拒绝在班', () => {
    const other = createClass('其他班');
    expect(() => enrollStudent(1, { classId: Number(other.class_id), termId: 1 }))
      .toThrow(/班级与学期不匹配/);
  });
});

describe('学生档案', () => {
  it('中文字段与空值读写正常', () => {
    const studentId = createStudent({
      学号: 'S101', 姓名: '王小明', 性别: '男', 出生年月: '2010-05',
      家庭住址: '', 特长: '', 备注: null as unknown as string,
    });
    const row = db.connInstance.prepare('SELECT * FROM students WHERE id=?').get(studentId) as
      Record<string, unknown>;
    expect(row.姓名).toBe('王小明');
    expect(row.家庭住址).toBe('');
    expect(row.备注).toBe('');
  });

  it('两个监护人的关系和职业字段对称保存', () => {
    const studentId = createStudent({
      学号: 'S102', 姓名: '李小明',
      监护人关系: '父亲', 监护人职业: '教师',
      监护人2关系: '母亲', 监护人2职业: '护士',
    });
    const row = db.connInstance.prepare('SELECT 监护人关系, 监护人职业, 监护人2关系, 监护人2职业 FROM students WHERE id=?').get(studentId) as Record<string, unknown>;
    expect(row.监护人关系).toBe('父亲');
    expect(row.监护人职业).toBe('教师');
    expect(row.监护人2关系).toBe('母亲');
    expect(row.监护人2职业).toBe('护士');
  });

  it('学号唯一：重复与回收站冲突均返回 409 语义', () => {
    createStudent({ 学号: 'S101', 姓名: '甲' });
    expect(() => createStudent({ 学号: 'S101', 姓名: '乙' }))
      .toThrow(StudentDuplicateError);
    // 软删除后仍占用学号
    const sid = (db.connInstance.prepare("SELECT id FROM students WHERE 学号=?").get('S101') as { id: number }).id;
    softDelete('student', sid);
    expect(() => createStudent({ 学号: 'S101', 姓名: '丙' }))
      .toThrow(/回收站/);
  });

  it('头像：拒绝非图片与超大文件，保存后可读取与删除', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const saved = savePhoto(1, png);
    expect(saved.content_type).toBe('image/png');
    const filePath = path.join(db.paths.dataDir, String(saved.relative_path));
    expect(fs.existsSync(filePath)).toBe(true);

    expect(() => savePhoto(1, Buffer.from('not-an-image')))
      .toThrow(StudentPhotoError);
    expect(() => savePhoto(1, Buffer.alloc(5 * 1024 * 1024 + 1)))
      .toThrow(/5MB/);
    expect(() => savePhoto(1, Buffer.alloc(0)))
      .toThrow(/不能为空/);
  });
});

describe('Excel 导入：预览、合并提交、故障报告与整批回滚', () => {
  it('预览解析表头并报告缺失学号/姓名与重复行', async () => {
    const file = await buildImportXlsx([
      ['S201', '新同学甲', '女', ''],
      ['', '缺学号同学', '男', ''],
      ['S202', '', '女', ''],
      ['S201', '重复学号', '男', ''],
    ]);
    const preview = await previewStudents(file, 'students.xlsx');
    expect(preview.summary.imported).toBe(1);
    expect(preview.summary.skipped).toBe(3);
    expect(preview.errors.map((e) => e.msg)).toEqual([
      expect.stringContaining('缺少学号'),
      expect.stringContaining('缺少姓名'),
      expect.stringContaining('重复'),
    ]);
  });

  it('提交按学号合并：新增 + 更新', async () => {
    createStudent({ 学号: 'S301', 姓名: '旧名字' });
    const file = await buildImportXlsx([
      ['S301', '新名字', '男', ''],
      ['S302', '全新同学', '女', ''],
    ]);
    const preview = await previewStudents(file);
    expect(preview.rows.map((r) => r.action)).toEqual(['更新', '新增']);
    const result = commitStudentImport(preview.rows, 'students.xlsx');
    expect(result.imported).toBe(1);
    expect(result.updated).toBe(1);
    const row = db.connInstance.prepare("SELECT 姓名 FROM students WHERE 学号='S301'").get() as { 姓名: string };
    expect(row.姓名).toBe('新名字');
    const run = db.connInstance.prepare(
      'SELECT * FROM student_import_runs ORDER BY id DESC LIMIT 1',
    ).get() as Record<string, unknown>;
    expect(run.imported).toBe(1);
    expect(run.updated).toBe(1);
  });

  it('提交时任一失败整批回滚（已插入行不残留）', async () => {
    const file = await buildImportXlsx([
      ['S401', '先插入', '男', ''],
      ['S402', '触发失败', '女', ''],
    ]);
    const preview = await previewStudents(file);
    // 注入失败：第二次入班时抛错（mock 的 enrollStudent 默认透传真实实现）
    (contextEnrollStudent as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => 0);
    (contextEnrollStudent as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => {
        throw new Error('注入的入班失败');
      });
    expect(() => commitStudentImport(preview.rows, 'students.xlsx')).toThrow(/入班失败/);
    const count = db.connInstance.prepare(
      "SELECT COUNT(*) AS c FROM students WHERE 学号 IN ('S401','S402')",
    ).get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('模板可生成且可被 ExcelJS 解析', async () => {
    const buffer = await buildTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    expect(sheet.name).toBe('学生信息');
    expect(sheet.getCell('A1').value).toBe('学号');
    expect(sheet.getCell('A2').value).toBe('2201');
  });
});

describe('通用工作表与派生列', () => {
  it('行数据按班级/学期隔离，个人表不隔离', () => {
    insertRow('班主任日志', ['2026-04-15', '内容']);
    insertRow('体重体脂追踪', ['2026-04-15']);
    const conn = db.connInstance;
    const otherTerm = createTerm(1, '另一个学期');
    conn.prepare(
      'UPDATE sheet_rows SET term_id=? WHERE sheet=?',
    ).run(otherTerm, '班主任日志');
    // 当前学期（1）看不到另一个学期的行
    bindRequestScope(1, 1);
    expect(getRows('班主任日志')).toHaveLength(0);
    // 个人表不受班级/学期过滤
    expect(getRows('体重体脂追踪')).toHaveLength(1);
    bindRequestScope(null, null);
  });

  it('派生列：班费余额滚动累计', () => {
    insertRow('班费管理', ['2026-03-01', '收入', 100]);
    insertRow('班费管理', ['2026-03-05', '支出', 30]);
    const rows = derive('班费管理', getRows('班费管理'));
    expect(rows[0].data[6]).toBe(100);
    expect(rows[1].data[6]).toBe(70);
  });

  it('派生列：积分月合计与排名', () => {
    insertRow('日常行为积分', ['', '', 5, 3]);
    insertRow('日常行为积分', ['', '', 2, 1]);
    const rows = derive('日常行为积分', getRows('日常行为积分'));
    expect(rows[0].data[10]).toBe(8); // 5+3
    expect(rows[1].data[10]).toBe(3); // 2+1
    expect(rows[0].data[11]).toBe(1); // 排名
    expect(rows[1].data[11]).toBe(2);
  });

  it('软删除行进入回收站并可从列表排除', () => {
    const rowNo = insertRow('班主任日志', ['内容']);
    const result = softDeleteSheetRow('班主任日志', rowNo);
    expect(result.ok).toBe(true);
    expect(getRows('班主任日志')).toHaveLength(0);
    expect(() => softDeleteSheetRow('班主任日志', rowNo)).toThrow(/不存在/);
  });

  it('考勤管理兼容视图渲染旧九列布局', () => {
    bindRequestScope(1, 1);
    const conn = db.connInstance;
    conn.prepare(
      `INSERT INTO attendance_records(student_id, class_id, term_id, attendance_date, scene, status)
       VALUES(1, 1, 1, '2026-04-15', '常规到校', '出勤')`,
    ).run();
    const rows = attendanceCompatibilityRows();
    bindRequestScope(null, null);
    expect(rows).toHaveLength(1);
    expect(rows[0].data[0]).toBe('2026-04-15');
    expect(rows[0].data[1]).toBe('周三');
    expect(rows[0].data[3]).toBe('测试学生1');
  });
});

describe('座位表与 HTTP 冒烟', () => {
  it('HTTP：创建学生 → 列表 → 更新 → 导出', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const create = await app.inject({
      method: 'POST', url: '/api/students',
      payload: { 学号: 'H001', 姓名: 'HTTP同学', 性别: '女' },
    });
    expect(create.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/students' });
    const students = (list.json() as { students: Array<Record<string, unknown>> }).students;
    expect(students.length).toBe(4);
    expect(students.find((s) => s.姓名 === 'HTTP同学')).toBeTruthy();

    const seats = await app.inject({
      method: 'POST', url: '/api/seating/update',
      payload: { row: 0, col: 0, value: '讲台' },
    });
    expect(seats.statusCode).toBe(200);
    const seating = await app.inject({ method: 'GET', url: '/api/seating' });
    const grid = (seating.json() as { grid: string[][] }).grid;
    expect(grid[0][0]).toBe('讲台');

    const exportRes = await app.inject({ method: 'GET', url: '/api/students/export' });
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.headers['content-type']).toContain('spreadsheetml');

    const template = await app.inject({ method: 'GET', url: '/api/students/template' });
    expect(template.statusCode).toBe(200);
    await app.close();
  });

  it('HTTP：归档学期写入被拒（409）', async () => {
    const conn = db.connInstance;
    conn.prepare("UPDATE terms SET status='已归档' WHERE id=1").run();
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: '/api/students',
      payload: { 学号: 'ARC1', 姓名: '归档同学' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toContain('归档');
    await app.close();
  });

  it('HTTP：座位表更新在归档范围被拒（409）', async () => {
    const conn = db.connInstance;
    conn.prepare("UPDATE terms SET status='已归档' WHERE id=1").run();
    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: '/api/seating/update',
      headers: { 'x-workbench-class': '1', 'x-workbench-term': '1' },
      payload: { row: 1, col: 1, value: 'x' },
    });
    expect(response.statusCode).toBe(409);
    await app.close();
  });
});
