PRAGMA foreign_keys=ON;

CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now','localtime'))
);
INSERT INTO schema_migrations(version) VALUES(1), (2), (3), (4);

CREATE TABLE students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    学号 TEXT UNIQUE,
    姓名 TEXT,
    性别 TEXT,
    出生年月 TEXT,
    民族 TEXT,
    家庭住址 TEXT,
    监护人姓名 TEXT,
    监护人电话 TEXT,
    监护人职业 TEXT,
    是否住校 TEXT,
    特长 TEXT,
    班级任职 TEXT,
    备注 TEXT,
    监护人2姓名 TEXT DEFAULT '',
    监护人2电话 TEXT DEFAULT '',
    监护人2关系 TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE sheet_meta (
    sheet TEXT PRIMARY KEY,
    headers TEXT NOT NULL DEFAULT '[]',
    category TEXT DEFAULT '',
    group_name TEXT DEFAULT 'teacher'
);

CREATE TABLE sheet_rows (
    sheet TEXT NOT NULL,
    row_no INTEGER NOT NULL,
    data TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (sheet, row_no)
);

CREATE TABLE seating (
    r INTEGER NOT NULL,
    c INTEGER NOT NULL,
    val TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (r, c)
);

CREATE TABLE app_flags (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE student_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    occurred_at TEXT NOT NULL,
    event_type TEXT NOT NULL,
    description TEXT NOT NULL,
    handling TEXT DEFAULT '',
    parent_contacted INTEGER NOT NULL DEFAULT 0,
    needs_followup INTEGER NOT NULL DEFAULT 0,
    followup_due TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT '已完成',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE student_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
    event_id INTEGER REFERENCES student_events(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    source TEXT DEFAULT '手动创建',
    due_at TEXT DEFAULT '',
    priority TEXT NOT NULL DEFAULT '普通',
    status TEXT NOT NULL DEFAULT '待处理',
    notes TEXT DEFAULT '',
    completed_at TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE focus_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence TEXT DEFAULT '',
    action_plan TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT '待确认',
    next_review_at TEXT DEFAULT '',
    started_at TEXT DEFAULT (date('now','localtime')),
    ended_at TEXT DEFAULT '',
    conclusion TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE communications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    communicated_at TEXT NOT NULL,
    method TEXT NOT NULL,
    reason TEXT NOT NULL,
    summary TEXT NOT NULL,
    feedback TEXT DEFAULT '',
    agreement TEXT DEFAULT '',
    followup_at TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT '已完成',
    event_id INTEGER REFERENCES student_events(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE exam_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    exam_name TEXT NOT NULL,
    exam_date TEXT DEFAULT '',
    subject TEXT NOT NULL,
    score REAL,
    rank INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(student_id, exam_name, subject)
);

CREATE TABLE attendance_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    metric TEXT NOT NULL,
    threshold INTEGER NOT NULL DEFAULT 1,
    period_days INTEGER NOT NULL DEFAULT 7,
    priority TEXT NOT NULL DEFAULT '重要',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE class_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    task_type TEXT NOT NULL DEFAULT '材料收集',
    start_at TEXT DEFAULT '',
    due_at TEXT DEFAULT '',
    material_name TEXT DEFAULT '',
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT '进行中',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE class_task_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES class_tasks(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT '未提交',
    note TEXT DEFAULT '',
    submitted_at TEXT DEFAULT '',
    UNIQUE(task_id, student_id)
);

CREATE TABLE duty_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    duty_date TEXT NOT NULL,
    area TEXT NOT NULL,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT '待完成',
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(duty_date, area, student_id)
);

CREATE TABLE student_import_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL DEFAULT '',
    imported INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE agent_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE agent_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL DEFAULT 'local',
    actor_id TEXT NOT NULL DEFAULT '',
    tool_name TEXT NOT NULL,
    arguments TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    result_summary TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE agent_sessions (
    session_id TEXT PRIMARY KEY,
    messages TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE wechat_message_receipts (
    message_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'processing',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
);

INSERT INTO students(id, 学号, 姓名, 性别) VALUES(1, 'M4001', '迁移样本学生', '女');
INSERT INTO sheet_meta(sheet, headers, category, group_name) VALUES
    ('考勤管理', '["日期","星期","学号","姓名","状态","到校时间","离校时间","原因","备注"]', '考勤', 'teacher'),
    ('班主任日志', '["日期","内容"]', '日志', 'teacher');
INSERT INTO sheet_rows(sheet, row_no, data) VALUES
    ('考勤管理', 1, '["2026-08-06","周四","M4001","迁移样本学生","迟到","08:10","","交通",""]'),
    ('班主任日志', 1, '["2026-08-06","迁移前日志记录"]');
INSERT INTO student_events(id, student_id, occurred_at, event_type, description, needs_followup, followup_due, status)
    VALUES(1, 1, '2026-08-06 08:10', '迟到', '早读迟到', 1, '2026-08-08', '待复查');
INSERT INTO student_tasks(id, student_id, event_id, title, source, due_at, status)
    VALUES(1, 1, 1, '跟进迟到情况', '学生事件', '2026-08-08', '待复查');
INSERT INTO focus_items(id, student_id, topic, reason, next_review_at)
    VALUES(1, 1, '出勤状态', '近期迟到', '2026-08-13');
INSERT INTO communications(id, student_id, communicated_at, method, reason, summary, followup_at, status, event_id)
    VALUES(1, 1, '2026-08-06 18:00', '电话', '迟到', '已和家长确认原因', '2026-08-08', '待回访', 1);
INSERT INTO exam_records(id, student_id, exam_name, exam_date, subject, score, rank)
    VALUES(1, 1, '第一次月考', '2026-08-01', '语文', 92, 3);
INSERT INTO attendance_rules(id, name, metric, threshold, period_days)
    VALUES(1, '一周迟到提醒', '迟到次数', 2, 7);
INSERT INTO class_tasks(id, title, due_at, material_name)
    VALUES(1, '收齐家长回执', '2026-08-10', '家长回执');
INSERT INTO class_task_items(id, task_id, student_id, status)
    VALUES(1, 1, 1, '未提交');
INSERT INTO duty_assignments(id, duty_date, area, student_id)
    VALUES(1, '2026-08-07', '教室前排', 1);
