/* MIG-05 学生档案：列表/创建/更新/头像（魔术字节校验、原子写入）。
 * 提供学生资料、照片和导入相关能力。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { getDb, ensureStudentInScope, getCurrentScope, enrollStudent } from './context.js';
import * as audit from './audit.js';
import { STUDENT_COLUMNS } from '../config/sheets.js';
import { FileSafetyError } from './files.js';

export class StudentPhotoError extends Error {}

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_ROOT = 'student_photos';

function detectType(content: Buffer): [string, string] {
  if (content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return ['image/jpeg', '.jpg'];
  }
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return ['image/png', '.png'];
  }
  if (content.subarray(0, 4).toString('ascii') === 'RIFF'
    && content.subarray(8, 12).toString('ascii') === 'WEBP') {
    return ['image/webp', '.webp'];
  }
  throw new StudentPhotoError('只支持 JPG、PNG 或 WebP 图片');
}

function resolve(relativePath: string): string {
  const root = path.resolve(getDb().paths.dataDir);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(root + path.sep)) {
    throw new StudentPhotoError('头像路径不合法');
  }
  return target;
}

export function savePhoto(studentId: number, content: Buffer): Record<string, unknown> {
  const data = Buffer.from(content ?? Buffer.alloc(0));
  if (data.length === 0) throw new StudentPhotoError('头像不能为空');
  if (data.length > MAX_PHOTO_BYTES) throw new StudentPhotoError('头像不能超过 5MB');
  const [contentType, suffix] = detectType(data);
  const relativePath = path.join(PHOTO_ROOT, String(studentId), `${randomBytes(16).toString('hex')}${suffix}`);
  const target = resolve(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tempPath = `${target}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, target);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* 忽略 */ }
    throw error;
  }
  return {
    relative_path: relativePath,
    content_type: contentType,
    size_bytes: data.length,
  };
}

export function removePhoto(relativePath: string | null): void {
  if (!relativePath) return;
  try {
    fs.rmSync(resolve(relativePath), { force: true });
  } catch (error) {
    if (!(error instanceof FileSafetyError)) throw error;
  }
}

export function photoPath(relativePath: string | null): string | null {
  if (!relativePath) return null;
  const target = resolve(relativePath);
  return fs.existsSync(target) && fs.statSync(target).isFile() ? target : null;
}

export interface StudentFields {
  学号?: string;
  姓名?: string;
  身份证号码?: string;
  性别?: string;
  出生年月?: string;
  民族?: string;
  家庭住址?: string;
  监护人姓名?: string;
  监护人电话?: string;
  监护人关系?: string;
  监护人职业?: string;
  是否住校?: string;
  特长?: string;
  班级任职?: string;
  备注?: string;
  监护人2姓名?: string;
  监护人2电话?: string;
  监护人2关系?: string;
  监护人2职业?: string;
}

function columnsSql(prefix = 's.'): string {
  return STUDENT_COLUMNS.map((key) => `${prefix}[${key}]`).join(', ');
}

export function listStudents(keyword = ''): Record<string, unknown> {
  const conn = getDb().connInstance;
  const scope = getCurrentScope({ conn });
  const [classId, termId] = [Number(scope.class_id), Number(scope.term_id)];
  let sql = `SELECT s.id, ${columnsSql()}, e.id AS enrollment_id, e.status AS enrollment_status
             FROM students s JOIN student_enrollments e ON e.student_id=s.id
             WHERE e.class_id=? AND e.term_id=? AND s.deleted_at=''`;
  const params: unknown[] = [classId, termId];
  if (scope.term_status !== '已归档') {
    sql += " AND e.status='在读'";
  }
  if (keyword) {
    sql += ' AND (s.姓名 LIKE ? OR s.学号 LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  sql += ` ORDER BY
    CASE WHEN trim(s.学号) <> '' AND trim(s.学号) NOT GLOB '*[^0-9]*' THEN 0 ELSE 1 END,
    CASE WHEN trim(s.学号) <> '' AND trim(s.学号) NOT GLOB '*[^0-9]*' THEN CAST(trim(s.学号) AS INTEGER) END,
    trim(s.学号) COLLATE NOCASE,
    s.id`;
  return { students: conn.prepare(sql).all(...params) };
}

export function createStudent(fields: StudentFields): number {
  const conn = getDb().connInstance;
  getCurrentScope({ write: true, conn });
  const 学号 = String(fields.学号 ?? '').trim();
  if (学号) {
    const existing = conn.prepare('SELECT id, deleted_at FROM students WHERE 学号=?').get(学号) as
      { id: number; deleted_at: string } | undefined;
    if (existing) {
      if (existing.deleted_at) throw new StudentDuplicateError(`学号 ${学号} 位于回收站，请先恢复`);
      throw new StudentDuplicateError(`学号 ${学号} 已存在`);
    }
  }
  const values = STUDENT_COLUMNS.map((key) => String(fields[key as keyof StudentFields] ?? ''));
  const cols = STUDENT_COLUMNS.map((key) => `[${key}]`).join(',');
  const placeholders = STUDENT_COLUMNS.map(() => '?').join(',');
  const inserted = conn.prepare(`INSERT INTO students(${cols}) VALUES(${placeholders})`).run(...values);
  const studentId = Number(inserted.lastInsertRowid);
  enrollStudent(studentId, { conn });
  audit.record('student', studentId, 'create', {
    summary: `新增学生：${fields.姓名 ?? ''}`,
    params: fields as Record<string, unknown>,
    conn,
  });
  return studentId;
}

export class StudentDuplicateError extends Error {}

export function updateStudent(studentId: number, fields: StudentFields): void {
  const conn = getDb().connInstance;
  ensureStudentInScope(studentId, { write: true, conn });
  const 学号 = String(fields.学号 ?? '').trim();
  if (学号) {
    const dup = conn.prepare(
      "SELECT id FROM students WHERE 学号=? AND id!=? AND deleted_at=''",
    ).get(学号, studentId);
    if (dup) throw new StudentDuplicateError(`学号 ${学号} 已被其他学生使用`);
  }
  const updates = STUDENT_COLUMNS.map((key) => `[${key}]=?`).join(',');
  const values = STUDENT_COLUMNS.map((key) => String(fields[key as keyof StudentFields] ?? ''));
  conn.prepare(
    `UPDATE students SET ${updates}, updated_at=datetime('now','localtime') WHERE id=?`,
  ).run(...values, studentId);
  audit.record('student', studentId, 'update', {
    summary: `更新学生：${fields.姓名 ?? ''}`,
    params: fields as Record<string, unknown>,
    conn,
  });
}

export { FileSafetyError };
