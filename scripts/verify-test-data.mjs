#!/usr/bin/env node

/**
 * 检查隔离测试数据库是否具备指定场景所需的最小数据。
 * 用法：node scripts/verify-test-data.mjs --data-dir=/tmp/workbench-test --profile=minimal
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const requireFromServer = createRequire(path.join(projectRoot, 'server', 'package.json'));
const Database = requireFromServer('better-sqlite3');
const args = process.argv.slice(2);
const dataArg = args.find((arg) => arg.startsWith('--data-dir='));
const profileArg = args.find((arg) => arg.startsWith('--profile='));
const dataDir = path.resolve(dataArg ? dataArg.slice('--data-dir='.length) : path.join(projectRoot, 'data'));
const profile = profileArg ? profileArg.slice('--profile='.length) : 'demo';
const dbPath = path.join(dataDir, 'workbench.db');

if (!['minimal', 'demo', 'edge'].includes(profile)) {
  console.error(`不支持的数据配置：${profile}`);
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error(`找不到测试数据库：${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const count = (sql, ...params) => Number(db.prepare(sql).get(...params).count ?? 0);
const checks = [
  ['进行中班级', count(`SELECT COUNT(*) AS count FROM classes WHERE status='使用中'`), 1],
  ['进行中学期', count(`SELECT COUNT(*) AS count FROM terms WHERE status='进行中'`), 1],
  ['学校学期', count(`SELECT COUNT(*) AS count FROM academic_terms`), 1],
  ['共享校历日期', count(`SELECT COUNT(*) AS count FROM school_calendar_days`), 2],
  ['学生', count(`SELECT COUNT(*) AS count FROM students WHERE deleted_at=''`), profile === 'minimal' || profile === 'edge' ? 8 : 1],
  ['课程节次', count(`SELECT COUNT(*) AS count FROM timetable_periods WHERE enabled=1`), profile === 'minimal' || profile === 'edge' ? 9 : 18],
  ['课程记录', count(`SELECT COUNT(*) AS count FROM timetable_entries WHERE status='启用'`), profile === 'minimal' || profile === 'edge' ? 48 : 96],
  ['考试', count(`SELECT COUNT(*) AS count FROM score_exams WHERE enabled=1`), profile === 'minimal' || profile === 'edge' ? 2 : 1],
  ['考勤记录', count(`SELECT COUNT(*) AS count FROM attendance_records WHERE deleted_at=''`), profile === 'minimal' || profile === 'edge' ? 3 : 1],
  ['通知模板', count(`SELECT COUNT(*) AS count FROM notification_templates WHERE enabled=1 AND deleted_at=''`), profile === 'minimal' || profile === 'edge' ? 1 : 1],
  ['证据附件', count(`SELECT COUNT(*) AS count FROM evidence_attachments WHERE deleted_at=''`), profile === 'minimal' || profile === 'edge' ? 1 : 1],
];
if (profile === 'demo') {
  checks.push(['教师关联班级', count(`SELECT COUNT(*) AS count FROM teacher_classes WHERE teacher_name='default' AND enabled=1`), 2]);
  checks.push(['高二1班在读人数', count(`
    SELECT COUNT(*) AS count
    FROM student_enrollments e
    JOIN students s ON s.id=e.student_id
    JOIN classes c ON c.id=e.class_id
    WHERE c.name='高二1班' AND e.status='在读' AND s.deleted_at=''
  `), 50]);
  checks.push(['高二2班在读人数', count(`
    SELECT COUNT(*) AS count
    FROM student_enrollments e
    JOIN students s ON s.id=e.student_id
    JOIN classes c ON c.id=e.class_id
    WHERE c.name='高二2班' AND e.status='在读' AND s.deleted_at=''
  `), 50]);
  checks.push(['班级共享学校学期', count(`SELECT COUNT(*) AS count FROM (
    SELECT academic_term_id FROM terms GROUP BY academic_term_id HAVING COUNT(*) >= 2
  )`), 1]);
  checks.push(['工作入口', count(`SELECT COUNT(*) AS count FROM tool_links WHERE deleted_at=''`), 1]);
}
if (profile === 'edge') {
  checks.push(['边界空班级', count(`SELECT COUNT(*) AS count FROM classes WHERE name='边界空班级' AND status='使用中'`), 1]);
}

const failed = checks.filter(([, actual, minimum]) => actual < minimum);
const result = {
  ok: failed.length === 0,
  db: dbPath,
  profile,
  checks: Object.fromEntries(checks.map(([name, actual, minimum]) => [name, { actual, minimum, ok: actual >= minimum }])),
};
console.log(JSON.stringify(result, null, 2));
db.close();
if (failed.length > 0) process.exit(1);
