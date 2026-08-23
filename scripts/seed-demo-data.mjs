#!/usr/bin/env node

/**
 * 为本地开发/演示库补齐新增工作台能力的脱敏样例数据。
 *
 * 设计目标：
 * - 只新增，或更新明确标注的演示占位记录；不删除业务记录，重复执行安全。
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

const DEMO_NAMES = [
  [
    '李子涵', '王雨萱', '张浩然', '刘思琪', '陈嘉豪', '杨雨欣', '赵天佑', '周晓萌', '吴明辉', '郑婉儿',
    '钱一鸣', '孙雅琪', '李思远', '马晓燕', '朱文博', '胡佳怡', '林俊杰', '何紫萱', '高子昂', '罗婷婷',
    '郭宇航', '蔡雨桐', '唐瑞泽', '韩梦琪', '冯子轩', '曹雅婷', '许博文', '邓雪儿', '彭浩宇', '沈若兰',
    '周子轩', '林思妍', '黄俊杰', '谢雨桐', '蒋欣怡', '郑博文', '何俊熙', '赵婉婷', '陈宇航', '徐梦瑶',
    '梁浩宇', '张欣悦', '吴昊然', '杨紫涵', '王泽楷', '罗欣怡', '李昊宇', '陈诗涵', '刘嘉豪', '郭欣怡',
  ],
  [
    '周梓轩', '林语桐', '陈俊熙', '许嘉怡', '唐宇辰', '宋雨菲', '何明泽', '谢依诺', '邓博文', '彭诗涵',
    '曹睿哲', '苏婉清', '罗子墨', '袁欣妍', '蒋承宇', '韩若曦', '冯奕辰', '曾可馨', '董浩宇', '潘雅琪',
    '叶晨阳', '余思妍', '杜嘉航', '龚悦宁', '陆星泽', '顾安然', '江皓轩', '傅芷晴', '白景程', '石梦洁',
    '杜雨泽', '何思妍', '周沐阳', '邱雅雯', '吕俊驰', '段欣怡', '秦浩轩', '邹佳宁', '贺文博', '康语嫣',
    '方子墨', '梁诗琪', '叶俊安', '田馨月', '白宇辰', '宋佳怡', '沈嘉铭', '顾雨桐', '陆子昂', '何宛凝',
  ],
];
const DEMO_NATIONS = ['汉族', '汉族', '羌族', '汉族', '藏族', '汉族', '回族', '汉族', '彝族', '汉族'];
const DEMO_GUARDIAN_GIVEN_NAMES = ['明辉', '建国', '志强', '永刚', '文斌', '志华', '大海', '建军', '光明', '远航'];
const DEMO_GUARDIAN_JOBS = ['教师', '个体经营', '工程技术人员', '医护人员', '公务员', '企业职员', '农业技术员', '运输从业人员'];
const DEMO_TALENTS = ['书法', '篮球', '绘画', '主持', '羽毛球', '摄影', '长跑', '器乐', '阅读', '志愿服务'];

function demoStudentProfile(classNumber, sequence) {
  const index = sequence - 1;
  const name = DEMO_NAMES[classNumber - 1][index];
  const surname = name.slice(0, 1);
  const numberPrefix = classNumber === 1 ? '22' : '23';
  const guardianGivenName = DEMO_GUARDIAN_GIVEN_NAMES[(index + classNumber * 2) % DEMO_GUARDIAN_GIVEN_NAMES.length];
  const boarding = index % 5 === 0 || index % 5 === 2 ? '住校' : '走读';
  return {
    studentNo: `${numberPrefix}${String(sequence).padStart(2, '0')}`,
    name,
    gender: index % 2 === 0 ? '男' : '女',
    birth: `2009-${String((index * 3 + classNumber) % 12 + 1).padStart(2, '0')}`,
    nation: DEMO_NATIONS[(index + classNumber) % DEMO_NATIONS.length],
    address: `汶川县映秀镇育才路${classNumber}${String(index + 1).padStart(2, '0')}号`,
    guardianName: `${surname}${guardianGivenName}`,
    guardianPhone: `138000${classNumber}${String(index + 1).padStart(4, '0')}`,
    guardianRelation: index % 2 === 0 ? '父亲' : '母亲',
    guardianJob: DEMO_GUARDIAN_JOBS[(index + classNumber) % DEMO_GUARDIAN_JOBS.length],
    boarding,
    talent: DEMO_TALENTS[(index + classNumber * 2) % DEMO_TALENTS.length],
    role: index === 0 ? '班长' : index === 1 ? '副班长' : index === 2 ? '学习委员' : index === 3 ? '体育委员' : '',
    note: index % 7 === 0 ? '学习习惯良好，积极参加班级活动。' : '',
  };
}

function backupPath() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `workbench-before-demo-seed-${stamp}.db`);
}

function firstRow(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function ensureAcademicTerm(db, name, startDate, endDate) {
  const existing = firstRow(
    db,
    'SELECT id FROM academic_terms WHERE name=? AND start_date=? AND end_date=?',
    name,
    startDate,
    endDate,
  );
  if (existing) return existing.id;
  const inserted = db.prepare(
    'INSERT INTO academic_terms(name, start_date, end_date) VALUES(?,?,?)',
  ).run(name, startDate, endDate);
  return Number(inserted.lastInsertRowid);
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
  db.prepare(
    `UPDATE timetable_periods
     SET enabled=1, updated_at=datetime('now','localtime')
     WHERE class_id=? AND term_id=? AND period_no=9 AND label='晚自习'`,
  ).run(classId, termId);

  const subjects = ['语文', '数学', '英语', '思想政治', '历史', '地理'];
  const entryStmt = db.prepare(
    `INSERT OR IGNORE INTO timetable_entries
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
  db.prepare(
    `UPDATE timetable_entries
     SET status='启用', updated_at=datetime('now','localtime')
     WHERE class_id=? AND term_id=? AND status='已停用' AND note LIKE '演示：%'`,
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
    `INSERT OR IGNORE INTO timetable_changes
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

function demoStudents(db, classId, termId) {
  return db.prepare(
    `SELECT s.id, s."学号" AS student_no, s."姓名" AS name
     FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
     ORDER BY s."学号"`,
  ).all(classId, termId);
}

function addDemoExamRecords(db, classId, termId) {
  const exams = db.prepare(
    `SELECT id, name, exam_date FROM score_exams
     WHERE class_id=? AND term_id=? AND enabled=1 ORDER BY sort_order, id`,
  ).all(classId, termId);
  const students = demoStudents(db, classId, termId);
  const subjects = db.prepare(
    `SELECT es.exam_id, es.subject_id, s.name, s.full_score
     FROM score_exam_subjects es
     JOIN score_subjects s ON s.id=es.subject_id
     WHERE s.class_id=? AND s.term_id=?
     ORDER BY es.exam_id, es.sort_order, es.subject_id`,
  ).all(classId, termId);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO exam_records
      (student_id, class_id, term_id, exam_name, exam_date, subject, score,
       exam_id, subject_id, record_status, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '正常', '演示数据')`,
  );
  let added = 0;
  exams.forEach((exam) => {
    const examSubjects = subjects.filter((subject) => subject.exam_id === exam.id);
    const existing = firstRow(
      db,
      `SELECT COUNT(*) AS count FROM exam_records
       WHERE class_id=? AND term_id=? AND exam_id=? AND deleted_at=''`,
      classId,
      termId,
      exam.id,
    );
    if (Number(existing.count) > 0 || !examSubjects.length) return;
    students.forEach((student, studentIndex) => {
      examSubjects.forEach((subject, subjectIndex) => {
        const fullScore = Number(subject.full_score) || 100;
        const ratio = 0.62 + ((studentIndex * 7 + subjectIndex * 11 + exam.id) % 30) / 100;
        const score = Math.min(fullScore, Math.round(fullScore * ratio));
        added += stmt.run(
          student.id,
          classId,
          termId,
          exam.name,
          exam.exam_date,
          subject.name,
          score,
          exam.id,
          subject.subject_id,
        ).changes;
      });
    });
  });
  return added;
}

function addDemoSheetRows(db, classId, termId) {
  const students = demoStudents(db, classId, termId);
  if (students.length < 2) return 0;
  const [first, second] = students;
  const rowsBySheet = {
    '特殊学生档案': [
      ['1', first.name, '学习适应', '阶段测验后信心不足，近期主动寻求学习方法指导。', '每周检查错题整理情况，及时给予正向反馈。', '已完成一次谈心，制定两周复习计划。', '持续关注', '2026-04-18'],
      ['2', second.name, '家校协同', '作息调整后课堂专注度有所提升，需要继续保持。', '与家长保持每两周一次沟通。', '已完成一次电话沟通，家长反馈良好。', '持续关注', '2026-04-17'],
    ],
    '谈心记录': [
      ['2026-04-18', first.name, '了解阶段测验后的学习状态', '办公室', '学生能够说出薄弱学科和下一步安排，情绪稳定。', '积极', '两周后检查复习计划执行情况', '2026-05-02'],
      ['2026-04-17', second.name, '沟通作息和课堂专注', '操场散步', '共同确认晚间学习时段，学生愿意尝试减少熬夜。', '平稳', '下周家校沟通一次', '2026-04-24'],
    ],
    '班委管理': [
      ['班长', first.name, '统筹班级事务，组织班会和班级活动', '2026-02-23', ''],
      ['学习委员', second.name, '收集各科作业提醒，协助学习小组交流', '2026-02-23', ''],
      ['纪律委员', students[2]?.name || first.name, '协助维护课堂和自习纪律', '2026-02-23', ''],
    ],
    '工作计划总结': [
      ['2026年春季学期', '重点推进学风建设、错题整理、班委轮值和家校沟通；每周完成一次学习小组反馈。', '阶段执行稳定，学生参与度较高；后续继续关注偏科学生的个别辅导。'],
      ['2026年春季学期四月计划', '完成阶段测验分析，组织一次学习方法分享，更新班级卫生和值日安排。', '已完成测验分析和学习分享，值日安排按计划运行。'],
    ],
  };
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO sheet_rows(sheet, row_no, data, class_id, term_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let added = 0;
  Object.entries(rowsBySheet).forEach(([sheet, rows]) => {
    const existing = firstRow(
      db,
      `SELECT COUNT(*) AS count FROM sheet_rows
       WHERE sheet=? AND class_id=? AND term_id=? AND deleted_at=''`,
      sheet,
      classId,
      termId,
    );
    if (Number(existing.count) > 0) return;
    let nextRow = Number(firstRow(db, 'SELECT COALESCE(MAX(row_no),0)+1 AS n FROM sheet_rows WHERE sheet=?', sheet).n);
    rows.forEach((row) => {
      added += stmt.run(sheet, nextRow, JSON.stringify(row), classId, termId).changes;
      nextRow += 1;
    });
  });
  return added;
}

function addDemoModuleData(db, classId, termId, classNumber, className, termName) {
  const configSummary = {};
  const activityTemplates = [
    ['主题班会复盘', '主题班会', '用于记录班会目标、参与情况和后续改进。'],
    ['校园志愿服务', '志愿服务', '用于登记志愿服务安排、参与人数和成果。'],
  ];
  const activityStmt = db.prepare(
    `INSERT OR IGNORE INTO activity_templates(class_id, term_id, name, activity_type, description, enabled)
     VALUES (?, ?, ?, ?, ?, 1)`,
  );
  activityTemplates.forEach((row) => activityStmt.run(classId, termId, ...row));
  configSummary.activity_templates = Number(firstRow(db, 'SELECT COUNT(*) AS count FROM activity_templates WHERE class_id=? AND term_id=? AND enabled=1', classId, termId).count);

  const meetingTemplates = [
    ['阶段学习总结', '主题班会', '总结近期学习情况，明确下一阶段目标和班级协作安排。'],
    ['安全教育提醒', '安全教育', '围绕交通、网络和校园安全开展提醒与讨论。'],
  ];
  const meetingStmt = db.prepare(
    `INSERT OR IGNORE INTO meeting_templates(class_id, term_id, name, format, content, enabled)
     VALUES (?, ?, ?, ?, ?, 1)`,
  );
  meetingTemplates.forEach((row) => meetingStmt.run(classId, termId, ...row));
  configSummary.meeting_templates = Number(firstRow(db, 'SELECT COUNT(*) AS count FROM meeting_templates WHERE class_id=? AND term_id=? AND enabled=1', classId, termId).count);

  const taskTemplates = [
    ['阶段测验反馈收集', '材料收集', '阶段测验反馈表', '收集学生和家长对阶段测验的反馈，便于调整复习安排。', 5],
    ['班级活动回执', '材料收集', '家长签字回执', '收齐活动回执并记录未提交学生，及时提醒家长。', 7],
  ];
  const taskStmt = db.prepare(
    `INSERT OR IGNORE INTO class_task_templates
      (class_id, term_id, name, task_type, material_name, description, default_due_days, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  taskTemplates.forEach((row) => taskStmt.run(classId, termId, ...row));
  configSummary.class_task_templates = Number(firstRow(db, 'SELECT COUNT(*) AS count FROM class_task_templates WHERE class_id=? AND term_id=? AND enabled=1 AND deleted_at=\'\'', classId, termId).count);

  if (Number(firstRow(db, 'SELECT COUNT(*) AS count FROM attendance_rules WHERE class_id=? AND term_id=? AND deleted_at=\'\'', classId, termId).count) === 0) {
    const attendanceRuleStmt = db.prepare(
      `INSERT INTO attendance_rules(name, metric, threshold, period_days, priority, enabled, class_id, term_id, scene)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, '全部场景')`,
    );
    attendanceRuleStmt.run('两周内出现缺勤', '缺勤次数', 1, 14, '重要', classId, termId);
    attendanceRuleStmt.run('一周内迟到达到两次', '迟到次数', 2, 7, '提醒', classId, termId);
  }
  configSummary.attendance_rules = Number(firstRow(db, 'SELECT COUNT(*) AS count FROM attendance_rules WHERE class_id=? AND term_id=? AND deleted_at=\'\'', classId, termId).count);

  let rotationRule = firstRow(db, 'SELECT id FROM duty_rotation_rules WHERE class_id=? AND term_id=? AND deleted_at=\'\' ORDER BY id LIMIT 1', classId, termId);
  if (!rotationRule) {
    const result = db.prepare(
      `INSERT INTO duty_rotation_rules(class_id, term_id, name, area, start_date, end_date, weekday_mask, enabled)
       VALUES (?, ?, '教室卫生轮换', '教室卫生', '2026-02-23', '2026-07-10', 31, 1)`,
    ).run(classId, termId);
    rotationRule = { id: Number(result.lastInsertRowid) };
  }
  const rotationMemberStmt = db.prepare(
    `INSERT OR IGNORE INTO duty_rotation_members(rule_id, student_id, position, enabled)
     VALUES (?, ?, ?, 1)`,
  );
  demoStudents(db, classId, termId).slice(0, 10).forEach((student, index) => rotationMemberStmt.run(rotationRule.id, student.id, index));
  configSummary.duty_rotation_rules = Number(firstRow(db, 'SELECT COUNT(*) AS count FROM duty_rotation_rules WHERE class_id=? AND term_id=? AND deleted_at=\'\'', classId, termId).count);

  if (Number(firstRow(db, 'SELECT COUNT(*) AS count FROM point_rules WHERE class_id=? AND term_id=? AND deleted_at=\'\'', classId, termId).count) === 0) {
    const pointRuleStmt = db.prepare(
      `INSERT INTO point_rules(class_id, term_id, name, category, metric, threshold, period_days, priority, enabled)
       VALUES (?, ?, ?, '日常行为', ?, ?, ?, ?, 1)`,
    );
    pointRuleStmt.run(classId, termId, '一周累计扣分达到3分', '周期扣分', 3, 7, '重要');
    pointRuleStmt.run(classId, termId, '一周累计加分达到10分', '周期加分', 10, 7, '提醒');
  }
  configSummary.point_rules = Number(firstRow(db, 'SELECT COUNT(*) AS count FROM point_rules WHERE class_id=? AND term_id=? AND deleted_at=\'\'', classId, termId).count);

  db.prepare(
    `INSERT OR IGNORE INTO score_term_settings(class_id, term_id, mode) VALUES (?, ?, '3+1+2')`,
  ).run(classId, termId);
  if (Number(firstRow(db, 'SELECT COUNT(*) AS count FROM score_rules WHERE class_id=? AND term_id=? AND deleted_at=\'\'', classId, termId).count) === 0) {
    const scoreRuleStmt = db.prepare(
      `INSERT INTO score_rules(class_id, term_id, name, metric, subject_id, threshold, priority, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const subject = firstRow(db, 'SELECT id FROM score_subjects WHERE class_id=? AND term_id=? ORDER BY sort_order, id LIMIT 1', classId, termId);
    scoreRuleStmt.run(classId, termId, '总分下降超过20分', '总分下降', null, 20, '重要');
    scoreRuleStmt.run(classId, termId, '语文成绩下降超过5分', '单科下降', subject?.id ?? null, 5, '提醒');
  }
  const students = demoStudents(db, classId, termId);
  const profileStmt = db.prepare('INSERT OR IGNORE INTO student_score_profiles(class_id, term_id, student_id) VALUES (?, ?, ?)');
  students.forEach((student) => profileStmt.run(classId, termId, student.id));
  const subjectIds = db.prepare('SELECT id FROM score_subjects WHERE class_id=? AND term_id=? AND enabled=1 ORDER BY sort_order, id').all(classId, termId);
  const studentSubjectStmt = db.prepare('INSERT OR IGNORE INTO student_score_subjects(class_id, term_id, student_id, subject_id) VALUES (?, ?, ?, ?)');
  students.forEach((student) => subjectIds.forEach((subject) => studentSubjectStmt.run(classId, termId, student.id, subject.id)));
  configSummary.score_rules = Number(firstRow(db, 'SELECT COUNT(*) AS count FROM score_rules WHERE class_id=? AND term_id=? AND deleted_at=\'\'', classId, termId).count);
  configSummary.score_profiles = Number(firstRow(db, 'SELECT COUNT(*) AS count FROM student_score_profiles WHERE class_id=? AND term_id=?', classId, termId).count);
  configSummary.score_subject_assignments = Number(firstRow(db, 'SELECT COUNT(*) AS count FROM student_score_subjects WHERE class_id=? AND term_id=?', classId, termId).count);

  if (Number(firstRow(db, 'SELECT COUNT(*) AS count FROM fund_settlements WHERE class_id=? AND term_id=?', classId, termId).count) === 0) {
    const totals = firstRow(
      db,
      `SELECT COALESCE(SUM(CASE WHEN direction='收入' AND status='有效' THEN amount ELSE 0 END),0) AS income,
              COALESCE(SUM(CASE WHEN direction='支出' AND status='有效' THEN amount ELSE 0 END),0) AS expense
       FROM fund_ledger WHERE class_id=? AND term_id=?`,
      classId,
      termId,
    );
    const closing = Number(totals.income) - Number(totals.expense);
    db.prepare(
      `INSERT INTO fund_settlements
        (class_id, term_id, period_key, period_start, period_end, opening_balance,
         income_total, expense_total, closing_balance, counted_balance, difference, status, note, settled_at)
       VALUES (?, ?, '2026-04', '2026-03-01', '2026-04-30', 0, ?, ?, ?, ?, 0, '已结算', '演示学期阶段结算', '2026-04-30 17:00:00')`,
    ).run(classId, termId, totals.income, totals.expense, closing, closing);
  }
  configSummary.fund_settlements = Number(firstRow(db, 'SELECT COUNT(*) AS count FROM fund_settlements WHERE class_id=? AND term_id=?', classId, termId).count);

  if (Number(firstRow(db, 'SELECT COUNT(*) AS count FROM report_archives WHERE class_id=? AND term_id=?', classId, termId).count) === 0) {
    const studentCount = students.length;
    const reportStmt = db.prepare(
      `INSERT INTO report_archives
        (class_id, term_id, report_type, period_start, period_end, student_id, title, payload_json, archived_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, '2026-04-30 17:30:00')`,
    );
    for (const [reportType, start, end, title] of [
      ['weekly', '2026-04-20', '2026-04-24', '班级周报'],
      ['monthly', '2026-04-01', '2026-04-30', '班级月报'],
    ]) {
      reportStmt.run(
        classId,
        termId,
        reportType,
        start,
        end,
        title,
        JSON.stringify({
          report_type: reportType,
          report_label: title,
          period_start: start,
          period_end: end,
          scope: { class_id: classId, term_id: termId, class_name: className, term_name: termName },
          metrics: { student_count: studentCount, attendance_total: 0, work_items_total: 2, points_entries: 0, score_records: 0, comments: 3 },
          note: '演示归档数据',
        }),
      );
    }
  }
  configSummary.report_archives = Number(firstRow(db, 'SELECT COUNT(*) AS count FROM report_archives WHERE class_id=? AND term_id=?', classId, termId).count);
  configSummary.exam_records_added = addDemoExamRecords(db, classId, termId);
  configSummary.sheet_rows_added = addDemoSheetRows(db, classId, termId);
  configSummary.class_number = classNumber;
  return configSummary;
}

function addPointDemoData(db, classId, termId) {
  const students = db.prepare(
    `SELECT s.id, s.姓名 AS name
     FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
     ORDER BY s.学号
     LIMIT 8`,
  ).all(classId, termId);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO point_ledger
      (class_id, term_id, student_id, occurred_at, period_key, amount, category, reason,
       status, source_type, source_id, source_key, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '有效', 'demo-seed', ?, ?, 'demo-seed')`,
  );
  let added = 0;
  students.forEach((student, studentIndex) => {
    for (let entryIndex = 0; entryIndex < 4; entryIndex += 1) {
      const amount = ((studentIndex + entryIndex) % 5 === 0) ? -2 : 2 + ((studentIndex * 2 + entryIndex) % 4);
      const date = `2026-04-${String(15 + entryIndex).padStart(2, '0')}`;
      const sourceKey = `demo-class2-point-${student.id}-${entryIndex + 1}`;
      const result = stmt.run(
        classId,
        termId,
        student.id,
        date,
        `demo-class2-${student.id}-${entryIndex + 1}`,
        amount,
        '日常行为',
        amount > 0 ? `课堂表现积极（${student.name}）` : '课堂纪律提醒',
        sourceKey,
        sourceKey,
      );
      added += result.changes;
    }
  });
  return added;
}

function addCommentDemoData(db, classId, termId) {
  const template = firstRow(
    db,
    `SELECT id FROM comment_templates
     WHERE class_id=? AND term_id=? AND name='学期综合表现' AND deleted_at=''`,
    classId,
    termId,
  );
  let templateId = template?.id;
  if (!templateId) {
    const result = db.prepare(
      `INSERT INTO comment_templates
        (class_id, term_id, name, comment_type, content, enabled)
       VALUES (?, ?, '学期综合表现', '学期评语',
         '{{姓名}}本学期学习态度认真，能够按时完成学习任务；希望继续保持良好习惯，稳步提升。', 1)`,
    ).run(classId, termId);
    templateId = result.lastInsertRowid;
  }
  const students = db.prepare(
    `SELECT s.id, s.姓名 AS name
     FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
     ORDER BY s.学号
     LIMIT 3`,
  ).all(classId, termId);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO student_comments
      (class_id, term_id, student_id, template_id, comment_type, content, status,
       source_type, source_id, source_key, is_manually_edited, edited_by, note)
     VALUES (?, ?, ?, ?, '学期评语', ?, '完成', 'demo-seed', ?, ?, 1, 'demo-seed', '演示样例')`,
  );
  let added = 0;
  students.forEach((student, index) => {
    const sourceKey = `demo-class2-comment-${student.id}`;
    const result = stmt.run(
      classId,
      termId,
      student.id,
      templateId,
      `${student.name}本学期学习态度认真，能够按时完成学习任务；希望继续保持良好习惯，稳步提升。`,
      String(index + 1),
      sourceKey,
    );
    added += result.changes;
  });
  return added;
}

function addDiaryDemoData(db, classId, termId) {
  const rows = [
    ['2026-04-15', '晴', '完成班级作业检查，提醒学生准备阶段测验。', '两名学生主动分享了复习计划。', '整理阶段测验反馈'],
    ['2026-04-16', '多云', '核对考勤和家校沟通记录。', '班级整体学习节奏稳定。', '准备周末班级活动'],
    ['2026-04-17', '小雨', '完成周五班会和下周任务安排。', '材料收集提醒需要提前发布。', '更新下周通知草稿'],
  ];
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO diary_entries
      (class_id, term_id, diary_date, weather, work, event, reflection, todo, source_type, source_id, legacy_row_no, legacy_payload)
     SELECT ?, ?, ?, ?, ?, '', ?, ?, 'demo-seed', ?, ?, '[]'
     WHERE NOT EXISTS (
       SELECT 1 FROM diary_entries
       WHERE class_id=? AND term_id=? AND diary_date=? AND deleted_at=''
     )`,
  );
  let added = 0;
  rows.forEach((row, index) => {
    const result = stmt.run(
      classId,
      termId,
      ...row,
      `demo-class2-diary-${index + 1}`,
      index + 1,
      classId,
      termId,
      row[0],
    );
    added += result.changes;
  });
  return added;
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
  const academicTermId = ensureAcademicTerm(db, termName, '2026-02-23', '2026-07-10');
  db.prepare(
    `INSERT OR IGNORE INTO terms(class_id, academic_term_id, name, start_date, end_date, status)
     VALUES (?, ?, ?, '2026-02-23', '2026-07-10', '进行中')`,
  ).run(classRow.id, academicTermId, termName);
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

function ensureDemoClassSize(db, classId, termId, target = 50, classNumber = 1) {
  const countActive = () => Number(firstRow(
    db,
    `SELECT COUNT(*) AS count
     FROM student_enrollments e
     JOIN students s ON s.id=e.student_id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''`,
    classId,
    termId,
  ).count);
  const studentStmt = db.prepare(
    `INSERT OR IGNORE INTO students
      ("学号", "姓名", "性别", "出生年月", "民族", "家庭住址", "监护人姓名", "监护人电话",
       "监护人关系", "监护人职业", "是否住校", "特长", "班级任职", "备注")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const enrollmentStmt = db.prepare(
    `INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status, joined_at)
     VALUES (?, ?, ?, '在读', '2026-02-23')`,
  );
  let current = countActive();
  let sequence = 1;
  while (current < target) {
    const profile = demoStudentProfile(classNumber, sequence);
    studentStmt.run(
      profile.studentNo,
      profile.name,
      profile.gender,
      profile.birth,
      profile.nation,
      profile.address,
      profile.guardianName,
      profile.guardianPhone,
      profile.guardianRelation,
      profile.guardianJob,
      profile.boarding,
      profile.talent,
      profile.role,
      profile.note,
    );
    const student = firstRow(db, `SELECT id FROM students WHERE "学号"=?`, profile.studentNo);
    enrollmentStmt.run(student.id, classId, termId);
    const next = countActive();
    if (next === current) throw new Error(`无法补齐班级 ${classId} 的演示人数`);
    current = next;
    sequence += 1;
  }
  const students = db.prepare(
    `SELECT s.id, s."学号" AS student_no, s."姓名" AS name
     FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
     ORDER BY s."学号"`,
  ).all(classId, termId);
  const updatePlaceholder = db.prepare(
    `UPDATE students SET
      "学号"=?, "姓名"=?, "性别"=?, "出生年月"=?, "民族"=?, "家庭住址"=?,
      "监护人姓名"=?, "监护人电话"=?, "监护人关系"=?, "监护人职业"=?, "是否住校"=?,
      "特长"=?, "班级任职"=?, "备注"=?, updated_at=datetime('now','localtime')
     WHERE id=?`,
  );
  students.forEach((student, index) => {
    const numberPrefix = classNumber === 1 ? '22' : '23';
    const isDemoNumber = new RegExp(`^${numberPrefix}\\d{2}$`).test(String(student.student_no));
    if (!isDemoNumber && !String(student.student_no).startsWith('DEMO-CLASS') && !String(student.name).startsWith('演示学生')) return;
    const profile = demoStudentProfile(classNumber, index + 1);
    updatePlaceholder.run(
      profile.studentNo,
      profile.name,
      profile.gender,
      profile.birth,
      profile.nation,
      profile.address,
      profile.guardianName,
      profile.guardianPhone,
      profile.guardianRelation,
      profile.guardianJob,
      profile.boarding,
      profile.talent,
      profile.role,
      profile.note,
      student.id,
    );
  });
  return current;
}

function addMinimalSupportData(db, dataDir, scope) {
  const studentIds = addMinimalStudents(db, scope);
  const academicTermId = firstRow(
    db,
    'SELECT academic_term_id FROM terms WHERE id=? AND class_id=?',
    scope.term_id,
    scope.class_id,
  ).academic_term_id;
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
      (academic_term_id, calendar_date, day_type, title, is_school_day, note, source)
     VALUES (?, ?, ?, ?, ?, ?, 'demo-seed')`,
  );
  calendarStmt.run(academicTermId, '2026-04-15', '上课日', '', 1, 'minimal 演示数据');
  calendarStmt.run(academicTermId, '2026-04-20', '考试日', '高二政治月考', 1, 'minimal 演示数据');

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
    `SELECT c.id AS class_id, t.id AS term_id, c.name AS class_name, t.name AS term_name,
            t.start_date, t.end_date, t.academic_term_id
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
  const academicTermId = scope.academic_term_id ?? ensureAcademicTerm(
    db,
    scope.term_name,
    scope.start_date,
    scope.end_date,
  );
  db.prepare(
    `INSERT OR IGNORE INTO terms(class_id, academic_term_id, name, start_date, end_date, status)
     VALUES (?, ?, ?, ?, ?, '进行中')`,
  ).run(class2.id, academicTermId, scope.term_name, scope.start_date, scope.end_date);
  const term2 = firstRow(db, 'SELECT id FROM terms WHERE class_id=? AND name=?', class2.id, scope.term_name);
  const class1StudentCount = ensureDemoClassSize(db, scope.class_id, scope.term_id, 50, 1);
  const class2StudentCount = ensureDemoClassSize(db, class2.id, term2.id, 50, 2);

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
  const class2PointsAdded = addPointDemoData(db, class2.id, term2.id);
  const class2CommentsAdded = addCommentDemoData(db, class2.id, term2.id);
  const class2DiaryAdded = addDiaryDemoData(db, class2.id, term2.id);
  addNotificationTemplates(db, class2.id, term2.id);
  const evidenceAdded = addEvidencePlaceholder(db, dataDir, scope.class_id, scope.term_id);
  const class2EvidenceAdded = addEvidencePlaceholder(db, dataDir, class2.id, term2.id);
  const class1Modules = addDemoModuleData(db, scope.class_id, scope.term_id, 1, scope.class_name, scope.term_name);
  const class2Modules = addDemoModuleData(db, class2.id, term2.id, 2, class2Name, term2.name);
  const timetableEntryCount = firstRow(
    db,
    `SELECT COUNT(*) AS count FROM timetable_entries WHERE status='启用'`,
  ).count;

  return {
    scope: `${scope.class_name} / ${scope.term_name}`,
    second_class: class2Name,
    class1_students: class1StudentCount,
    class2_students: class2StudentCount,
    timetable_entries: timetableEntryCount,
    teacher_classes: 2,
    tool_links: links.length,
    notification_templates: 10,
    evidence_placeholder_added: evidenceAdded || class2EvidenceAdded,
    class2_completed: {
      point_entries_added: class2PointsAdded,
      comments_added: class2CommentsAdded,
      diary_entries_added: class2DiaryAdded,
      evidence_placeholder_added: class2EvidenceAdded,
      modules: class2Modules,
    },
    class1_modules: class1Modules,
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
