#!/usr/bin/env node

/**
 * 为本地开发/演示库补齐新增工作台能力的脱敏样例数据。
 *
 * 设计目标：
 * - 只新增，不删除、不覆盖已有业务记录；重复执行安全。
 * - 默认操作 data/workbench.db；可用 --data-dir 指定隔离目录。
 * - 执行前先复制一份数据库备份；--dry-run 只检查，不写入。
 * - 证据附件是明确标注的 1x1 PNG 占位文件，不代表真实家长材料。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const requireFromServer = createRequire(path.join(projectRoot, 'server', 'package.json'));
const Database = requireFromServer('better-sqlite3');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noBackup = args.includes('--no-backup');
const dataArg = args.find((arg) => arg.startsWith('--data-dir='));
const profileArg = args.find((arg) => arg.startsWith('--profile='));
const profile = profileArg ? profileArg.slice('--profile='.length) : 'demo';
const dataDir = path.resolve(dataArg ? dataArg.slice('--data-dir='.length) : path.join(projectRoot, 'data'));
const dbPath = path.join(dataDir, 'workbench.db');

if (!['minimal', 'demo', 'edge'].includes(profile)) {
  console.error(`不支持的数据配置：${profile}，可选 minimal、demo、edge`);
  process.exit(1);
}

const demoPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function backupPath() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `workbench-before-demo-seed-${stamp}.db`);
}

function firstRow(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

async function initializeDatabaseIfNeeded() {
  if (fs.existsSync(dbPath) || dryRun) return false;
  const connectionModule = path.join(projectRoot, 'server', 'dist', 'db', 'connection.js');
  if (!fs.existsSync(connectionModule)) {
    throw new Error('隔离数据库尚未创建，且未找到 server/dist/db/connection.js；请先执行 cd server && npm run build:server');
  }
  const { WorkbenchDb } = await import(pathToFileURL(connectionModule).href);
  const bootstrap = new WorkbenchDb({
    dataDir,
    kbDir: path.join(dataDir, '知识库'),
  });
  bootstrap.open();
  bootstrap.close();
  return true;
}

function addTimetableData(db, classId, termId, subjectTeacherName) {
  const periods = [
    [1, '第1节', '08:00', '08:45', '早读'],
    [2, '第2节', '08:55', '09:40', '普通课'],
    [3, '第3节', '10:00', '10:45', '普通课'],
    [4, '第4节', '10:55', '11:40', '普通课'],
    [5, '第5节', '14:00', '14:45', '普通课'],
    [6, '第6节', '14:55', '15:40', '普通课'],
    [7, '第7节', '15:50', '16:35', '普通课'],
    [8, '第8节', '16:45', '17:30', '普通课'],
    [9, '晚自习', '19:00', '20:00', '晚自习'],
  ];
  const periodStmt = db.prepare(
    `INSERT INTO timetable_periods
      (class_id, term_id, period_no, label, start_time, end_time, session_type)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM timetable_periods
       WHERE class_id=? AND term_id=? AND period_no=?
     )`,
  );
  periods.forEach((row) => periodStmt.run(classId, termId, ...row, classId, termId, row[0]));

  const subjects = ['语文', '数学', '英语', '思想政治', '历史', '地理'];
  const entryStmt = db.prepare(
    `INSERT INTO timetable_entries
      (class_id, term_id, weekday, period_no, subject, teacher_name, room, session_type, week_pattern, week_start, week_end, note)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM timetable_entries
       WHERE class_id=? AND term_id=? AND weekday=? AND period_no=?
         AND week_pattern=? AND week_start=? AND week_end=? AND status='启用'
     )`,
  );
  for (let weekday = 1; weekday <= 5; weekday += 1) {
    for (let period = 1; period <= periods.length; period += 1) {
      const sessionType = period === 1 ? '早读' : period === 9 ? '晚自习' : '普通课';
      const subject = period === 1 ? '语文早读' : period === 9 ? '晚自习' : subjects[(weekday + period) % subjects.length];
      const teacher = period === 1 || period === 9
        ? (period === 1 ? '语文老师' : '年级组')
        : subject === '思想政治' ? subjectTeacherName : `${subject}老师`;
      const room = `${classId === 1 ? '教学楼A' : '教学楼B'}-${101 + period}`;
      const note = period === 1 ? '演示：晨读安排' : period === 9 ? '演示：晚自习安排' : '演示课程';
      entryStmt.run(
        classId,
        termId,
        weekday,
        period,
        subject,
        teacher,
        room,
        sessionType,
        '全周',
        1,
        99,
        note,
        classId,
        termId,
        weekday,
        period,
        '全周',
        1,
        99,
      );
    }
  }

  // 早读记录在旧版演示数据中曾被当作普通课写入；仅修正本脚本生成的记录，避免影响用户自建课表。
  db.prepare(
    `UPDATE timetable_entries
     SET subject='语文早读', teacher_name='语文老师', session_type='早读', note='演示：晨读安排', updated_at=datetime('now','localtime')
     WHERE class_id=? AND term_id=? AND weekday BETWEEN 1 AND 5 AND period_no=1
       AND status='启用' AND note='演示课程' AND session_type='普通课'`,
  ).run(classId, termId);

  const building = classId === 1 ? '教学楼A' : '教学楼B';
  const weekendEntries = [
    [6, 1, '社团活动', '年级组', '社团活动', '报告厅', '单周', 1, 17, '演示：单周社团活动'],
    [6, 2, '自主学习', '班主任', '自习', '自习室', '双周', 2, 18, '演示：双周自主学习'],
    [6, 3, '政治学科拓展', subjectTeacherName, '活动', `${building}-303`, '全周', 1, 18, '演示：周六学科拓展'],
  ];
  weekendEntries.forEach(([weekday, period, subject, teacher, sessionType, room, weekPattern, weekStart, weekEnd, note]) => {
    entryStmt.run(
      classId,
      termId,
      weekday,
      period,
      subject,
      teacher,
      room,
      sessionType,
      weekPattern,
      weekStart,
      weekEnd,
      note,
      classId,
      termId,
      weekday,
      period,
      weekPattern,
      weekStart,
      weekEnd,
    );
  });

  const changeStmt = db.prepare(
    `INSERT INTO timetable_changes
      (class_id, term_id, change_date, period_no, action, subject, teacher_name, room, session_type, note)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM timetable_changes
       WHERE class_id=? AND term_id=? AND change_date=? AND period_no=? AND status='生效'
     )`,
  );
  const changes = [
    ['2026-04-20', 3, '调课', '思想政治', subjectTeacherName, classId === 1 ? '教学楼A-203' : '教学楼B-203', '普通课', '演示：政治课调整至第3节'],
    ['2026-04-21', 9, '停课', '', '', '', '晚自习', '演示：年级考试周暂停晚自习'],
    ['2026-04-23', 2, '代课', '思想政治', '刘老师', classId === 1 ? '教学楼A-202' : '教学楼B-202', '普通课', '演示：教师外出，由刘老师代课'],
  ];
  changes.forEach(([changeDate, period, action, subject, teacher, room, sessionType, note]) => {
    changeStmt.run(
      classId,
      termId,
      changeDate,
      period,
      action,
      subject,
      teacher,
      room,
      sessionType,
      note,
      classId,
      termId,
      changeDate,
      period,
    );
  });
}

function addNotificationTemplates(db, classId, termId) {
  const templates = [
    ['放假/返校通知', '放假通知', '各位家长：\n{holiday_start}至{holiday_end}放假，{return_date}正常返校。\n\n{class_name}班主任', [
      { name: 'holiday_start', label: '放假开始日期', required: true, format: 'date', default_value: '' },
      { name: 'holiday_end', label: '放假结束日期', required: true, format: 'date', default_value: '' },
      { name: 'return_date', label: '返校日期', required: true, format: 'date', default_value: '' },
      { name: 'class_name', label: '班级名称', required: false, format: 'class_name', default_value: '' },
    ]],
    ['安全提醒', '安全提醒', '各位家长：\n{reminder_content}\n请家长关注孩子安全。\n\n{class_name}班主任', [
      { name: 'reminder_content', label: '提醒内容', required: true, format: 'text', default_value: '' },
      { name: 'class_name', label: '班级名称', required: false, format: 'class_name', default_value: '' },
    ]],
    ['调课/考试安排通知', '调课通知', '各位家长：\n{arrangement_content}\n请留意时间安排。\n\n{class_name}班主任', [
      { name: 'arrangement_content', label: '安排内容', required: true, format: 'text', default_value: '' },
      { name: 'class_name', label: '班级名称', required: false, format: 'class_name', default_value: '' },
    ]],
    ['班级活动/研学通知', '班级活动', '各位家长：\n{activity_name}将于{activity_date}举行，{activity_details}。\n\n{class_name}班主任', [
      { name: 'activity_name', label: '活动名称', required: true, format: 'text', default_value: '' },
      { name: 'activity_date', label: '活动日期', required: true, format: 'date', default_value: '' },
      { name: 'activity_details', label: '活动详情', required: false, format: 'text', default_value: '' },
      { name: 'class_name', label: '班级名称', required: false, format: 'class_name', default_value: '' },
    ]],
    ['材料收集/学习安排提醒', '材料收集', '各位家长：\n{material_name}需在{deadline}前{material_action}。\n\n{class_name}班主任', [
      { name: 'material_name', label: '材料名称', required: true, format: 'text', default_value: '' },
      { name: 'deadline', label: '截止日期', required: true, format: 'date', default_value: '' },
      { name: 'material_action', label: '要求动作', required: false, format: 'text', default_value: '提交' },
      { name: 'class_name', label: '班级名称', required: false, format: 'class_name', default_value: '' },
    ]],
  ];
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO notification_templates
      (class_id, term_id, name, scene, content, variables_json, is_system, enabled)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
  );
  templates.forEach(([name, scene, content, variables]) => {
    stmt.run(classId, termId, name, scene, content, JSON.stringify(variables));
  });
}

function addEvidencePlaceholder(db, dataDir, classId, termId) {
  const attendance = firstRow(
    db,
    `SELECT id, student_id FROM attendance_records
     WHERE class_id=? AND term_id=? AND status='请假' ORDER BY id LIMIT 1`,
    classId,
    termId,
  );
  if (!attendance) return false;
  const exists = firstRow(
    db,
    `SELECT id FROM evidence_attachments
     WHERE class_id=? AND term_id=? AND owner_type='attendance' AND owner_id=? AND deleted_at=''`,
    classId,
    termId,
    attendance.id,
  );
  if (exists) return false;

  const storedName = 'demo-leave-placeholder.png';
  const relativePath = `evidence/${classId}/${termId}/attendance/${attendance.id}/${storedName}`;
  const target = path.join(dataDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, demoPng, { flag: 'wx' });
  const digest = crypto.createHash('sha256').update(demoPng).digest('hex');
  db.prepare(
    `INSERT INTO evidence_attachments
      (class_id, term_id, owner_type, owner_id, student_id, evidence_kind,
       original_name, stored_name, relative_path, mime_type, size_bytes, sha256,
       source_channel, note, created_by)
     VALUES (?, ?, 'attendance', ?, ?, '请假凭证', ?, ?, ?, 'image/png', ?, ?, 'web', ?, 'demo-seed')`,
  ).run(
    classId,
    termId,
    attendance.id,
    attendance.student_id,
    '演示-家长请假截图.png',
    storedName,
    relativePath,
    demoPng.length,
    digest,
    '演示占位图片，仅用于验证证据留痕界面；不是实际家长材料。',
  );
  return true;
}

function ensureScope(db, className = '我的班级', termName = '当前学期') {
  let classRow = firstRow(
    db,
    `SELECT id, name FROM classes WHERE name=? AND status='使用中' ORDER BY id LIMIT 1`,
    className,
  );
  if (!classRow) {
    db.prepare(
      `INSERT INTO classes(name, grade, status) VALUES (?, '高二', '使用中')`,
    ).run(className);
    classRow = firstRow(
      db,
      `SELECT id, name FROM classes WHERE name=? AND status='使用中' ORDER BY id LIMIT 1`,
      className,
    );
  }
  db.prepare(
    `INSERT OR IGNORE INTO terms(class_id, name, start_date, end_date, status)
     VALUES (?, ?, '2026-02-23', '2026-07-10', '进行中')`,
  ).run(classRow.id, termName);
  const termRow = firstRow(
    db,
    `SELECT id, name FROM terms WHERE class_id=? AND name=?`,
    classRow.id,
    termName,
  );
  return {
    class_id: classRow.id,
    term_id: termRow.id,
    class_name: classRow.name,
    term_name: termRow.name,
  };
}

function addMinimalStudents(db, scope) {
  const students = [
    ['DEMO-MIN-001', '林晓雨', '女', '家长林先生', '13800000001'],
    ['DEMO-MIN-002', '周子涵', '男', '家长周女士', '13800000002'],
    ['DEMO-MIN-003', '陈思远', '男', '家长陈先生', '13800000003'],
    ['DEMO-MIN-004', '赵一诺', '女', '家长赵女士', '13800000004'],
    ['DEMO-MIN-005', '黄嘉乐', '男', '家长黄先生', '13800000005'],
    ['DEMO-MIN-006', '何语嫣', '女', '家长何女士', '13800000006'],
    ['DEMO-MIN-007', '吴承泽', '男', '家长吴先生', '13800000007'],
    ['DEMO-MIN-008', '杨可欣', '女', '家长杨女士', '13800000008'],
  ];
  const studentStmt = db.prepare(
    `INSERT OR IGNORE INTO students
      ("学号", "姓名", "性别", "监护人姓名", "监护人电话", "是否住校")
     VALUES (?, ?, ?, ?, ?, '否')`,
  );
  const enrollmentStmt = db.prepare(
    `INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status, joined_at)
     VALUES (?, ?, ?, '在读', '2026-02-23')`,
  );
  students.forEach(([studentNo, name, gender, guardian, phone]) => {
    studentStmt.run(studentNo, name, gender, guardian, phone);
    const student = firstRow(db, `SELECT id FROM students WHERE "学号"=?`, studentNo);
    enrollmentStmt.run(student.id, scope.class_id, scope.term_id);
  });
  return students.map(([studentNo]) => firstRow(db, `SELECT id FROM students WHERE "学号"=?`, studentNo).id);
}

function addMinimalSupportData(db, dataDir, scope) {
  const studentIds = addMinimalStudents(db, scope);
  db.prepare(
    `INSERT OR IGNORE INTO teacher_classes(teacher_name, class_id, role, subjects, sort_order)
     VALUES ('default', ?, '班主任兼任课教师', '思想政治', 0)`,
  ).run(scope.class_id);
  addTimetableData(db, scope.class_id, scope.term_id, '王老师');

  const examStmt = db.prepare(
    `INSERT OR IGNORE INTO score_exams(class_id, term_id, name, exam_date, sort_order, enabled)
     VALUES (?, ?, ?, ?, ?, 1)`,
  );
  examStmt.run(scope.class_id, scope.term_id, '高二政治月考', '2026-04-20', 1);
  examStmt.run(scope.class_id, scope.term_id, '期中考试', '2026-05-08', 2);

  const attendanceStmt = db.prepare(
    `INSERT OR IGNORE INTO attendance_records
      (student_id, class_id, term_id, attendance_date, scene, status, reason, note)
     VALUES (?, ?, ?, ?, '常规到校', ?, ?, 'minimal 演示数据')`,
  );
  attendanceStmt.run(studentIds[0], scope.class_id, scope.term_id, '2026-04-15', '出勤', '',);
  attendanceStmt.run(studentIds[1], scope.class_id, scope.term_id, '2026-04-15', '迟到', '公交晚点');
  attendanceStmt.run(studentIds[2], scope.class_id, scope.term_id, '2026-04-15', '请假', '身体不适');

  const eventExists = firstRow(
    db,
    `SELECT id FROM student_events WHERE class_id=? AND term_id=? AND student_id=? AND description=? AND deleted_at=''`,
    scope.class_id,
    scope.term_id,
    studentIds[1],
    '课堂发言积极，完成一次学习分享',
  );
  if (!eventExists) {
    db.prepare(
      `INSERT INTO student_events
        (student_id, occurred_at, event_type, description, handling, parent_contacted, needs_followup, status, class_id, term_id)
       VALUES (?, '2026-04-15', '学习表现', ?, '课堂即时表扬', 0, 0, '已完成', ?, ?)`,
    ).run(studentIds[1], '课堂发言积极，完成一次学习分享', scope.class_id, scope.term_id);
  }

  const taskStmt = db.prepare(
    `INSERT INTO student_tasks(student_id, title, source, due_at, priority, status, notes, class_id, term_id, source_key)
     SELECT ?, ?, 'minimal 演示', ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM student_tasks WHERE class_id=? AND term_id=? AND source_key=? AND deleted_at=''
     )`,
  );
  taskStmt.run(studentIds[0], '确认家长会时间', '2026-04-16', '重要', '待处理', '准备家长会沟通材料', scope.class_id, scope.term_id, 'demo-min-task-1', scope.class_id, scope.term_id, 'demo-min-task-1');
  taskStmt.run(studentIds[2], '补充请假凭证', '2026-04-17', '普通', '进行中', '等待家长发送截图', scope.class_id, scope.term_id, 'demo-min-task-2', scope.class_id, scope.term_id, 'demo-min-task-2');
  taskStmt.run(null, '整理本周班级动态', '2026-04-18', '普通', '已完成', 'minimal 演示数据', scope.class_id, scope.term_id, 'demo-min-task-3', scope.class_id, scope.term_id, 'demo-min-task-3');

  const communicationStmt = db.prepare(
    `INSERT INTO communications
      (student_id, communicated_at, method, reason, summary, feedback, status, class_id, term_id, source_type, source_key)
     SELECT ?, ?, '微信', ?, ?, ?, '已完成', ?, ?, 'manual', ?
     WHERE NOT EXISTS (
       SELECT 1 FROM communications WHERE class_id=? AND term_id=? AND source_key=? AND deleted_at=''
     )`,
  );
  communicationStmt.run(studentIds[0], '2026-04-15 17:20', '学习情况', '反馈近期课堂表现和作息安排', '家长已了解', scope.class_id, scope.term_id, 'demo-min-communication-1', scope.class_id, scope.term_id, 'demo-min-communication-1');
  communicationStmt.run(studentIds[2], '2026-04-15 18:10', '请假确认', '确认身体不适请假情况', '家长承诺次日反馈恢复情况', scope.class_id, scope.term_id, 'demo-min-communication-2', scope.class_id, scope.term_id, 'demo-min-communication-2');

  const calendarStmt = db.prepare(
    `INSERT OR IGNORE INTO school_calendar_days
      (class_id, term_id, calendar_date, day_type, title, is_school_day, note, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'demo-seed')`,
  );
  calendarStmt.run(scope.class_id, scope.term_id, '2026-04-15', '上课日', '', 1, 'minimal 演示数据');
  calendarStmt.run(scope.class_id, scope.term_id, '2026-04-20', '考试日', '高二政治月考', 1, 'minimal 演示数据');

  addNotificationTemplates(db, scope.class_id, scope.term_id);
  const linksStmt = db.prepare(
    `INSERT INTO tool_links(name, url, category, color, sort_order, pinned)
     SELECT '学校教务系统', 'https://jw.example.edu.cn', '教务系统', '#6d5dfc', 0, 1
     WHERE NOT EXISTS (SELECT 1 FROM tool_links WHERE name='学校教务系统' AND deleted_at='')`,
  );
  linksStmt.run();
  const evidenceAdded = addEvidencePlaceholder(db, dataDir, scope.class_id, scope.term_id);
  return { student_ids: studentIds, evidence_placeholder_added: evidenceAdded };
}

function seedMinimal(db, dataDir) {
  const scope = ensureScope(db);
  const support = addMinimalSupportData(db, dataDir, scope);
  return {
    profile: 'minimal',
    scope: `${scope.class_name} / ${scope.term_name}`,
    students: support.student_ids.length,
    timetable_entries: firstRow(db, `SELECT COUNT(*) AS count FROM timetable_entries WHERE class_id=? AND term_id=? AND status='启用'`, scope.class_id, scope.term_id).count,
    exams: firstRow(db, `SELECT COUNT(*) AS count FROM score_exams WHERE class_id=? AND term_id=? AND enabled=1`, scope.class_id, scope.term_id).count,
    evidence_placeholder_added: support.evidence_placeholder_added,
  };
}

function seedEdge(db, dataDir) {
  const minimal = seedMinimal(db, dataDir);
  const edgeScope = ensureScope(db, '边界空班级', '边界测试学期');
  return {
    ...minimal,
    profile: 'edge',
    edge_scope: `${edgeScope.class_name} / ${edgeScope.term_name}`,
  };
}

function seed(db) {
  const scope = firstRow(
    db,
    `SELECT c.id AS class_id, t.id AS term_id, c.name AS class_name, t.name AS term_name
     FROM classes c JOIN terms t ON t.class_id=c.id
     WHERE c.status='使用中' AND t.status='进行中'
     ORDER BY c.id, t.id LIMIT 1`,
  );
  if (!scope) throw new Error('没有可用的进行中班级/学期');

  // teacher_classes 当前是本地单用户配置，服务层使用 default 作为教师身份；课表展示仍使用王老师。
  const teacherAccount = 'default';
  const teacherDisplayName = '王老师';
  const class2Name = '高二2班';
  let class2 = firstRow(db, `SELECT id FROM classes WHERE name=? AND status='使用中' ORDER BY id LIMIT 1`, class2Name);
  if (!class2) {
    db.prepare(
      `INSERT INTO classes(name, grade, status) VALUES (?, '高二', '使用中')`,
    ).run(class2Name);
    class2 = firstRow(db, 'SELECT id FROM classes WHERE name=? AND status=\'使用中\' ORDER BY id LIMIT 1', class2Name);
  }
  db.prepare(
    `INSERT OR IGNORE INTO terms(class_id, name, start_date, end_date, status)
     VALUES (?, '2026春季学期', '2026-02-23', '2026-07-10', '进行中')`,
  ).run(class2.id);
  const term2 = firstRow(db, `SELECT id FROM terms WHERE class_id=? AND name='2026春季学期'`, class2.id);

  db.prepare(
    `INSERT OR IGNORE INTO teacher_classes(teacher_name, class_id, role, subjects, sort_order)
     VALUES (?, ?, '班主任兼任课教师', '思想政治', 0)`,
  ).run(teacherAccount, scope.class_id);
  db.prepare(
    `INSERT OR IGNORE INTO teacher_classes(teacher_name, class_id, role, subjects, sort_order)
     VALUES (?, ?, '任课教师', '思想政治', 1)`,
  ).run(teacherAccount, class2.id);

  addTimetableData(db, scope.class_id, scope.term_id, teacherDisplayName);
  addTimetableData(db, class2.id, term2.id, teacherDisplayName);
  db.prepare(
    `INSERT OR IGNORE INTO score_exams(class_id, term_id, name, exam_date, sort_order, enabled)
     VALUES (?, ?, '高二2班政治阶段测验', '2026-04-24', 10, 1)`,
  ).run(class2.id, term2.id);

  const links = [
    ['教务系统', 'https://jw.example.edu.cn', '教务系统', '#6d5dfc', 1],
    ['智慧教育平台', 'https://edu.example.edu.cn', '教学平台', '#3b82f6', 1],
    ['备课资源库', 'https://resource.example.edu.cn', '备课资源', '#10b981', 0],
    ['班级家长群公告', 'https://work.weixin.qq.com', '班级沟通', '#f59e0b', 0],
    ['学校报修服务', 'https://service.example.edu.cn', '学校服务', '#ef4444', 0],
  ];
  const linkStmt = db.prepare(
    `INSERT INTO tool_links(name, url, category, color, sort_order, pinned)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM tool_links WHERE name=? AND deleted_at=''
     )`,
  );
  links.forEach((row, index) => linkStmt.run(row[0], row[1], row[2], row[3], index, row[4], row[0]));

  addNotificationTemplates(db, scope.class_id, scope.term_id);
  const evidenceAdded = addEvidencePlaceholder(db, dataDir, scope.class_id, scope.term_id);
  const timetableEntryCount = firstRow(
    db,
    `SELECT COUNT(*) AS count FROM timetable_entries WHERE status='启用'`,
  ).count;

  return {
    scope: `${scope.class_name} / ${scope.term_name}`,
    second_class: class2Name,
    timetable_entries: timetableEntryCount,
    teacher_classes: 2,
    tool_links: links.length,
    notification_templates: 5,
    evidence_placeholder_added: evidenceAdded,
  };
}

const initialized = await initializeDatabaseIfNeeded();
if (dryRun && !fs.existsSync(dbPath)) {
  console.log(JSON.stringify({
    dry_run: true,
    db: dbPath,
    profile,
    schema_version: null,
    will_initialize: true,
  }, null, 2));
  process.exit(0);
}

const db = new Database(dbPath);
try {
  const version = Number(firstRow(db, 'SELECT MAX(version) AS version FROM schema_migrations')?.version ?? 0);
  if (version < 33) throw new Error(`数据库版本为 v${version}，需要先完成迁移到 v33`);
  if (dryRun) {
    console.log(JSON.stringify({ dry_run: true, db: dbPath, profile, schema_version: version }, null, 2));
  } else {
    db.pragma('wal_checkpoint(FULL)');
    let backup = '';
    if (!noBackup && !initialized) {
      backup = backupPath();
      fs.copyFileSync(dbPath, backup);
    }
    const runProfile = () => {
      if (profile === 'minimal') return seedMinimal(db, dataDir);
      if (profile === 'edge') return seedEdge(db, dataDir);
      const existingScope = firstRow(db, `SELECT c.id FROM classes c JOIN terms t ON t.class_id=c.id WHERE c.status='使用中' AND t.status='进行中' LIMIT 1`);
      if (!existingScope) seedMinimal(db, dataDir);
      return seed(db);
    };
    const result = db.transaction(runProfile)();
    console.log(JSON.stringify({ ok: true, db: dbPath, profile, backup, ...result }, null, 2));
  }
} finally {
  db.close();
}
