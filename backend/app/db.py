# -*- coding: utf-8 -*-
"""SQLite 数据层（WAL 模式，启动时建表）"""
import json
import os
import re
import sqlite3
import threading
from datetime import datetime

from .config import DATA_DIR, DB_PATH

BASE_SCHEMA_VERSION = 1
CURRENT_SCHEMA_VERSION = 13

_connections: dict[int, tuple[str, sqlite3.Connection]] = {}
_lock = threading.Lock()


def get_conn() -> sqlite3.Connection:
    """返回当前线程专用连接，避免 FastAPI 线程池并发复用同一连接。"""
    thread_id = threading.get_ident()
    path = os.path.abspath(DB_PATH)
    with _lock:
        current = _connections.get(thread_id)
        if current and current[0] == path:
            return current[1]
        if current:
            current[1].close()
            _connections.pop(thread_id, None)

        existing_database = os.path.isfile(path)
        os.makedirs(os.path.abspath(DATA_DIR), exist_ok=True)
        conn = sqlite3.connect(path, check_same_thread=False)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA busy_timeout=5000')
            conn.execute('PRAGMA foreign_keys=ON')
            init_schema(conn, existing_database=existing_database)
        except Exception:
            conn.close()
            raise
        _connections[thread_id] = (path, conn)
        return conn


def close():
    """关闭所有线程连接；测试切换数据库路径和应用退出时调用。"""
    with _lock:
        for _path, conn in list(_connections.values()):
            conn.close()
        _connections.clear()


def backup_dir() -> str:
    """返回当前数据目录下的备份目录。测试会临时替换 DATA_DIR，因此不能缓存路径。"""
    return os.path.join(DATA_DIR, 'backups')


def _backup_connection(conn: sqlite3.Connection, label: str) -> str:
    os.makedirs(backup_dir(), exist_ok=True)
    safe_label = re.sub(r'[^A-Za-z0-9_-]+', '-', label).strip('-') or 'backup'
    filename = f'workbench-{safe_label}-{datetime.now().strftime("%Y%m%d-%H%M%S-%f")}.db'
    path = os.path.join(backup_dir(), filename)
    target = sqlite3.connect(path)
    try:
        conn.backup(target)
    finally:
        target.close()
    return filename


def create_backup(label: str = 'manual') -> str:
    """以 SQLite backup API 创建一致性备份，返回备份文件名。"""
    return _backup_connection(get_conn(), label)


def schema_version(conn: sqlite3.Connection | None = None) -> int:
    conn = conn or get_conn()
    row = conn.execute('SELECT MAX(version) AS version FROM schema_migrations').fetchone()
    return int(row['version'] or 0)


def _migration_2(conn: sqlite3.Connection):
    """记录导入批次，便于后续追踪数据变更来源。"""
    conn.execute('''
        CREATE TABLE IF NOT EXISTS student_import_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL DEFAULT '',
            imported INTEGER NOT NULL DEFAULT 0,
            updated INTEGER NOT NULL DEFAULT 0,
            skipped INTEGER NOT NULL DEFAULT 0,
            error_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        )
    ''')


def _migration_3(conn: sqlite3.Connection):
    """为 Agent 保存配置和工具调用审计。"""
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS agent_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT '',
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS agent_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel TEXT NOT NULL DEFAULT 'local',
            actor_id TEXT NOT NULL DEFAULT '',
            tool_name TEXT NOT NULL,
            arguments TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL,
            result_summary TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );
    ''')


def _migration_4(conn: sqlite3.Connection):
    """为 Agent 会话和微信消息去重保存本地状态。"""
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS agent_sessions (
            session_id TEXT PRIMARY KEY,
            messages TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS wechat_message_receipts (
            message_id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'processing',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        );
    ''')


def _add_column(conn: sqlite3.Connection, table: str, column: str, definition: str):
    columns = {row['name'] for row in conn.execute(f'PRAGMA table_info({table})').fetchall()}
    if column not in columns:
        conn.execute(f'ALTER TABLE {table} ADD COLUMN {column} {definition}')


def _migration_5(conn: sqlite3.Connection):
    """增加班级、学期、在班关系，并把 v4 业务数据归入默认上下文。"""
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS classes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            grade TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '使用中',
            archived_at TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS terms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            start_date TEXT NOT NULL DEFAULT '',
            end_date TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '进行中',
            archived_at TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(class_id, name)
        );

        CREATE TABLE IF NOT EXISTS student_enrollments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
            term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT '在读',
            joined_at TEXT NOT NULL DEFAULT '',
            left_at TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(student_id, class_id, term_id)
        );

        INSERT INTO classes(name, grade, status)
        SELECT '默认班级', '', '使用中'
        WHERE NOT EXISTS (SELECT 1 FROM classes);
    ''')
    class_id = conn.execute('SELECT id FROM classes ORDER BY id LIMIT 1').fetchone()['id']
    conn.execute(
        "INSERT INTO terms(class_id, name, status) SELECT ?, '默认学期', '进行中' "
        'WHERE NOT EXISTS (SELECT 1 FROM terms WHERE class_id=?)',
        (class_id, class_id),
    )
    term_id = conn.execute(
        'SELECT id FROM terms WHERE class_id=? ORDER BY id LIMIT 1', (class_id,)
    ).fetchone()['id']

    scoped_tables = (
        'student_events', 'student_tasks', 'focus_items', 'communications',
        'attendance_rules', 'class_tasks', 'sheet_rows', 'student_import_runs',
    )
    for table in scoped_tables:
        _add_column(conn, table, 'class_id', 'INTEGER REFERENCES classes(id)')
        _add_column(conn, table, 'term_id', 'INTEGER REFERENCES terms(id)')
        conn.execute(
            f'UPDATE {table} SET class_id=COALESCE(class_id, ?), term_id=COALESCE(term_id, ?)',
            (class_id, term_id),
        )

    conn.execute(
        '''INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status)
           SELECT id, ?, ?, '在读' FROM students''',
        (class_id, term_id),
    )

    conn.executescript(f'''
        DROP TABLE IF EXISTS exam_records_scoped;
        CREATE TABLE exam_records_scoped (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            exam_name TEXT NOT NULL,
            exam_date TEXT DEFAULT '',
            subject TEXT NOT NULL,
            score REAL,
            rank INTEGER,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(student_id, class_id, term_id, exam_name, subject)
        );
        INSERT INTO exam_records_scoped
            (id, student_id, class_id, term_id, exam_name, exam_date, subject, score, rank, created_at, updated_at)
        SELECT id, student_id, {class_id}, {term_id}, exam_name, exam_date, subject, score, rank, created_at, updated_at
        FROM exam_records;
        DROP TABLE exam_records;
        ALTER TABLE exam_records_scoped RENAME TO exam_records;

        DROP TABLE IF EXISTS duty_assignments_scoped;
        CREATE TABLE duty_assignments_scoped (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            duty_date TEXT NOT NULL,
            area TEXT NOT NULL,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            status TEXT NOT NULL DEFAULT '待完成',
            note TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(class_id, term_id, duty_date, area, student_id)
        );
        INSERT INTO duty_assignments_scoped
            (id, duty_date, area, student_id, class_id, term_id, status, note, created_at, updated_at)
        SELECT id, duty_date, area, student_id, {class_id}, {term_id}, status, note, created_at, updated_at
        FROM duty_assignments;
        DROP TABLE duty_assignments;
        ALTER TABLE duty_assignments_scoped RENAME TO duty_assignments;

        DROP TABLE IF EXISTS seating_scoped;
        CREATE TABLE seating_scoped (
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            r INTEGER NOT NULL,
            c INTEGER NOT NULL,
            val TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (class_id, term_id, r, c)
        );
        INSERT INTO seating_scoped(class_id, term_id, r, c, val)
        SELECT {class_id}, {term_id}, r, c, val FROM seating;
        DROP TABLE seating;
        ALTER TABLE seating_scoped RENAME TO seating;

        CREATE INDEX IF NOT EXISTS idx_enrollments_scope
            ON student_enrollments(class_id, term_id, status, student_id);
        CREATE INDEX IF NOT EXISTS idx_events_scope ON student_events(class_id, term_id, student_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_scope ON student_tasks(class_id, term_id, status);
        CREATE INDEX IF NOT EXISTS idx_focus_scope ON focus_items(class_id, term_id, student_id);
        CREATE INDEX IF NOT EXISTS idx_communications_scope ON communications(class_id, term_id, student_id);
        CREATE INDEX IF NOT EXISTS idx_exams_scope ON exam_records(class_id, term_id, student_id);
        CREATE INDEX IF NOT EXISTS idx_sheet_rows_scope ON sheet_rows(class_id, term_id, sheet);
        CREATE INDEX IF NOT EXISTS idx_class_tasks_scope ON class_tasks(class_id, term_id, status);
        CREATE INDEX IF NOT EXISTS idx_duty_scope ON duty_assignments(class_id, term_id, duty_date);
    ''')


def _migration_6(conn: sqlite3.Connection):
    """把既有待办升级为带稳定来源的统一工作项。"""
    for column, definition in (
        ('source_type', "TEXT NOT NULL DEFAULT 'manual'"),
        ('source_id', 'INTEGER'),
        ('source_key', "TEXT NOT NULL DEFAULT ''"),
        ('owner', "TEXT NOT NULL DEFAULT '班主任'"),
        ('scheduled_at', "TEXT NOT NULL DEFAULT ''"),
        ('result', "TEXT NOT NULL DEFAULT ''"),
        ('cancelled_at', "TEXT NOT NULL DEFAULT ''"),
    ):
        _add_column(conn, 'student_tasks', column, definition)

    conn.executescript('''
        UPDATE student_tasks SET source_type=CASE source
            WHEN '学生事件' THEN 'event'
            WHEN '家校沟通' THEN 'communication'
            WHEN '关注事项' THEN 'focus'
            WHEN '考勤规则' THEN 'attendance_rule'
            WHEN '班级任务' THEN 'class_task'
            WHEN '值日安排' THEN 'duty_assignment'
            ELSE 'manual' END;

        UPDATE student_tasks
        SET source_id=event_id,
            source_key='event:' || event_id
        WHERE event_id IS NOT NULL
          AND id=(SELECT MIN(t2.id) FROM student_tasks t2 WHERE t2.event_id=student_tasks.event_id);

        UPDATE student_tasks
        SET source_id=(
                SELECT c.id FROM communications c
                WHERE c.student_id=student_tasks.student_id
                  AND c.class_id=student_tasks.class_id
                  AND c.term_id=student_tasks.term_id
                  AND c.followup_at=student_tasks.due_at
                ORDER BY c.id LIMIT 1
            )
        WHERE source_type='communication' AND source_id IS NULL;

        UPDATE student_tasks
        SET source_key='communication:' || source_id
        WHERE source_type='communication' AND source_id IS NOT NULL
          AND id=(SELECT MIN(t2.id) FROM student_tasks t2
                  WHERE t2.source_type='communication' AND t2.source_id=student_tasks.source_id);

        INSERT INTO student_tasks(
            student_id, title, source, source_type, source_id, source_key,
            due_at, priority, status, notes, class_id, term_id
        )
        SELECT f.student_id, f.topic || ' · 复查', '关注事项', 'focus', f.id,
               'focus:' || f.id, f.next_review_at, '重要', '待复查',
               COALESCE(NULLIF(f.action_plan, ''), f.reason), f.class_id, f.term_id
        FROM focus_items f
        WHERE f.next_review_at<>'' AND f.status<>'已结束'
          AND NOT EXISTS (
              SELECT 1 FROM student_tasks t
              WHERE t.class_id=f.class_id AND t.term_id=f.term_id
                AND t.source_type='focus' AND t.source_id=f.id
          );

        INSERT INTO student_tasks(
            student_id, title, source, source_type, source_id, source_key,
            due_at, priority, status, notes, class_id, term_id
        )
        SELECT c.student_id, '家校沟通回访', '家校沟通', 'communication', c.id,
               'communication:' || c.id, c.followup_at, '重要', '待复查',
               COALESCE(NULLIF(c.agreement, ''), c.summary), c.class_id, c.term_id
        FROM communications c
        WHERE c.followup_at<>'' AND c.status NOT IN ('已完成','已取消')
          AND NOT EXISTS (
              SELECT 1 FROM student_tasks t
              WHERE t.class_id=c.class_id AND t.term_id=c.term_id
                AND t.source_type='communication' AND t.source_id=c.id
          );

        INSERT INTO student_tasks(
            title, source, source_type, source_id, source_key,
            scheduled_at, due_at, priority, status, notes, class_id, term_id
        )
        SELECT ct.title, '班级任务', 'class_task', ct.id, 'class_task:' || ct.id,
               ct.start_at, ct.due_at, '普通', '待处理', ct.description,
               ct.class_id, ct.term_id
        FROM class_tasks ct
        WHERE ct.status NOT IN ('已完成','已取消')
          AND NOT EXISTS (
              SELECT 1 FROM student_tasks t
              WHERE t.class_id=ct.class_id AND t.term_id=ct.term_id
                AND t.source_type='class_task' AND t.source_id=ct.id
          );

        INSERT INTO student_tasks(
            student_id, title, source, source_type, source_id, source_key,
            scheduled_at, due_at, priority, status, notes, class_id, term_id
        )
        SELECT d.student_id, '值日 · ' || d.area, '值日安排', 'duty_assignment', d.id,
               'duty_assignment:' || d.id, d.duty_date, d.duty_date, '普通', '待处理',
               d.note, d.class_id, d.term_id
        FROM duty_assignments d
        WHERE d.status<>'已完成'
          AND NOT EXISTS (
              SELECT 1 FROM student_tasks t
              WHERE t.class_id=d.class_id AND t.term_id=d.term_id
                AND t.source_type='duty_assignment' AND t.source_id=d.id
          );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_key
            ON student_tasks(class_id, term_id, source_key) WHERE source_key<>'';
        CREATE INDEX IF NOT EXISTS idx_tasks_due
            ON student_tasks(class_id, term_id, status, due_at, scheduled_at);
    ''')


def _migration_7(conn: sqlite3.Connection):
    """增加来源过程记录、状态历史和关闭结果。"""
    _add_column(conn, 'student_events', 'result', "TEXT NOT NULL DEFAULT ''")
    _add_column(conn, 'student_events', 'closed_at', "TEXT NOT NULL DEFAULT ''")
    _add_column(conn, 'communications', 'result', "TEXT NOT NULL DEFAULT ''")
    _add_column(conn, 'communications', 'closed_at', "TEXT NOT NULL DEFAULT ''")
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS workflow_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_type TEXT NOT NULL,
            source_id INTEGER NOT NULL,
            student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            action TEXT NOT NULL DEFAULT 'progress',
            content TEXT NOT NULL DEFAULT '',
            status_from TEXT NOT NULL DEFAULT '',
            status_to TEXT NOT NULL DEFAULT '',
            next_action_at TEXT NOT NULL DEFAULT '',
            idempotency_key TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        UPDATE communications SET status='待回访'
        WHERE followup_at<>'' AND status IN ('待跟进','待回访','进行中');

        CREATE INDEX IF NOT EXISTS idx_workflow_updates_source
            ON workflow_updates(class_id, term_id, source_type, source_id, id);
        CREATE INDEX IF NOT EXISTS idx_workflow_updates_student
            ON workflow_updates(class_id, term_id, student_id, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_updates_idempotency
            ON workflow_updates(class_id, term_id, idempotency_key)
            WHERE idempotency_key<>'';
    ''')


def _migration_8(conn: sqlite3.Connection):
    """增加系统业务审计、软删除标记和回收站索引。"""
    for table in (
        'students', 'student_events', 'student_tasks', 'focus_items', 'communications',
        'exam_records', 'attendance_rules', 'class_tasks', 'duty_assignments', 'sheet_rows',
    ):
        _add_column(conn, table, 'deleted_at', "TEXT NOT NULL DEFAULT ''")
        _add_column(conn, table, 'deleted_by', "TEXT NOT NULL DEFAULT ''")
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS recycle_bin (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            object_type TEXT NOT NULL,
            object_id TEXT NOT NULL,
            class_id INTEGER,
            term_id INTEGER,
            label TEXT NOT NULL DEFAULT '',
            snapshot TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT '已删除',
            deleted_by TEXT NOT NULL DEFAULT '',
            deleted_at TEXT DEFAULT (datetime('now','localtime')),
            restored_at TEXT NOT NULL DEFAULT '',
            purged_at TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS system_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel TEXT NOT NULL DEFAULT 'web',
            actor_id TEXT NOT NULL DEFAULT 'local-user',
            object_type TEXT NOT NULL,
            object_id TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'success',
            summary TEXT NOT NULL DEFAULT '',
            params_summary TEXT NOT NULL DEFAULT '{}',
            class_id INTEGER,
            term_id INTEGER,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE INDEX IF NOT EXISTS idx_recycle_scope
            ON recycle_bin(class_id, term_id, status, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_system_audit_scope
            ON system_audit(class_id, term_id, created_at);
    ''')


def _migration_9(conn: sqlite3.Connection):
    """增加局域网短时配对会话和可撤权设备凭证。"""
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS pairing_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code_hash TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT '待使用',
            expires_at TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            used_at TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS paired_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL DEFAULT '移动设备',
            credential_hash TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT '已授权',
            paired_at TEXT DEFAULT (datetime('now','localtime')),
            last_seen_at TEXT NOT NULL DEFAULT '',
            expires_at TEXT NOT NULL,
            revoked_at TEXT NOT NULL DEFAULT '',
            user_agent TEXT NOT NULL DEFAULT '',
            last_ip TEXT NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_pairing_status
            ON pairing_sessions(status, expires_at);
        CREATE INDEX IF NOT EXISTS idx_paired_devices_status
            ON paired_devices(status, expires_at, last_seen_at);
    ''')


def _migration_10(conn: sqlite3.Connection):
    """把考勤升级为结构化记录，并增加规则运行与命中历史。"""
    _add_column(conn, 'attendance_rules', 'scene', "TEXT NOT NULL DEFAULT '全部场景'")
    _add_column(conn, 'attendance_rules', 'last_run_at', "TEXT NOT NULL DEFAULT ''")
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS attendance_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            attendance_date TEXT NOT NULL,
            scene TEXT NOT NULL DEFAULT '常规到校',
            status TEXT NOT NULL DEFAULT '出勤',
            arrive_at TEXT NOT NULL DEFAULT '',
            leave_at TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            legacy_row_no INTEGER,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            deleted_at TEXT NOT NULL DEFAULT '',
            deleted_by TEXT NOT NULL DEFAULT '',
            UNIQUE(class_id, term_id, attendance_date, scene, student_id)
        );

        CREATE TABLE IF NOT EXISTS attendance_rule_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            trigger_type TEXT NOT NULL DEFAULT 'manual',
            reference_date TEXT NOT NULL,
            rules_evaluated INTEGER NOT NULL DEFAULT 0,
            students_evaluated INTEGER NOT NULL DEFAULT 0,
            hit_count INTEGER NOT NULL DEFAULT 0,
            created_count INTEGER NOT NULL DEFAULT 0,
            reopened_count INTEGER NOT NULL DEFAULT 0,
            resolved_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'success',
            error TEXT NOT NULL DEFAULT '',
            summary_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS attendance_rule_hits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id INTEGER NOT NULL REFERENCES attendance_rules(id) ON DELETE CASCADE,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            status TEXT NOT NULL DEFAULT '待处理',
            current_value INTEGER NOT NULL DEFAULT 0,
            task_id INTEGER REFERENCES student_tasks(id) ON DELETE SET NULL,
            first_hit_at TEXT NOT NULL DEFAULT '',
            last_hit_at TEXT NOT NULL DEFAULT '',
            handled_at TEXT NOT NULL DEFAULT '',
            resolved_at TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(class_id, term_id, rule_id, student_id)
        );

        CREATE INDEX IF NOT EXISTS idx_attendance_scope_date
            ON attendance_records(class_id, term_id, attendance_date, scene, student_id);
        CREATE INDEX IF NOT EXISTS idx_attendance_student
            ON attendance_records(class_id, term_id, student_id, attendance_date);
        CREATE INDEX IF NOT EXISTS idx_attendance_rule_runs
            ON attendance_rule_runs(class_id, term_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_attendance_rule_hits
            ON attendance_rule_hits(class_id, term_id, rule_id, status, student_id);
    ''')

    migrated = 0
    skipped = 0
    rows = conn.execute(
        "SELECT row_no, data, class_id, term_id FROM sheet_rows "
        "WHERE sheet='考勤管理' AND deleted_at='' ORDER BY row_no"
    ).fetchall()
    time_pattern = re.compile(r'^\d{1,2}:\d{2}$')
    for row in rows:
        try:
            data = json.loads(row['data'])
        except (TypeError, ValueError, json.JSONDecodeError):
            skipped += 1
            continue
        if len(data) < 5:
            skipped += 1
            continue
        attendance_date = str(data[0] or '')[:10]
        student_no = str(data[2] or '').strip() if len(data) > 2 else ''
        student_name = str(data[3] or '').strip() if len(data) > 3 else ''
        student = conn.execute(
            '''SELECT s.id FROM students s
               JOIN student_enrollments e ON e.student_id=s.id
               WHERE e.class_id=? AND e.term_id=?
                 AND ((?<>'' AND s.学号=?) OR (?='' AND ?<>'' AND s.姓名=?))
               ORDER BY CASE WHEN s.学号=? THEN 0 ELSE 1 END, s.id LIMIT 1''',
            (row['class_id'], row['term_id'], student_no, student_no,
             student_no, student_name, student_name, student_no),
        ).fetchone()
        if not attendance_date or not student:
            skipped += 1
            continue
        fifth = str(data[5] or '').strip() if len(data) > 5 else ''
        sixth = str(data[6] or '').strip() if len(data) > 6 else ''
        seventh = str(data[7] or '').strip() if len(data) > 7 else ''
        # 旧 Excel 顺序为到校/离校/原因；旧网页保存曾写成原因/到校/离校。
        if time_pattern.match(fifth) or (not fifth and seventh and not time_pattern.match(seventh)):
            arrive_at, leave_at, reason = fifth, sixth, seventh
        else:
            reason, arrive_at, leave_at = fifth, sixth, seventh
        cur = conn.execute(
            '''INSERT INTO attendance_records(
                   student_id, class_id, term_id, attendance_date, scene, status,
                   arrive_at, leave_at, reason, note, legacy_row_no
               ) VALUES(?,?,?,?,'常规到校',?,?,?,?,?,?)
               ON CONFLICT(class_id, term_id, attendance_date, scene, student_id)
               DO NOTHING''',
            (student['id'], row['class_id'], row['term_id'], attendance_date,
             str(data[4] or '出勤').strip() or '出勤', arrive_at, leave_at,
             reason, str(data[8] or '').strip() if len(data) > 8 else '', row['row_no']),
        )
        if cur.rowcount:
            migrated += 1
        else:
            skipped += 1
    conn.execute(
        'INSERT OR REPLACE INTO app_flags(key, value) VALUES(?,?)',
        ('attendance_v10_migration', json.dumps(
            {'migrated': migrated, 'skipped': skipped}, ensure_ascii=False)),
    )


def _migration_11(conn: sqlite3.Connection):
    """增加成绩配置、原子导入记录和异常规则，并关联既有成绩。"""
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS score_exams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            name TEXT NOT NULL,
            exam_date TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(class_id, term_id, name)
        );

        CREATE TABLE IF NOT EXISTS score_subjects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            name TEXT NOT NULL,
            full_score REAL NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(class_id, term_id, name)
        );

        CREATE TABLE IF NOT EXISTS score_exam_subjects (
            exam_id INTEGER NOT NULL REFERENCES score_exams(id) ON DELETE CASCADE,
            subject_id INTEGER NOT NULL REFERENCES score_subjects(id) ON DELETE CASCADE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(exam_id, subject_id)
        );

        INSERT OR IGNORE INTO score_exams(class_id, term_id, name, exam_date, sort_order)
        SELECT class_id, term_id, exam_name, MAX(exam_date), MIN(id)
        FROM exam_records GROUP BY class_id, term_id, exam_name;

        INSERT OR IGNORE INTO score_subjects(class_id, term_id, name, sort_order)
        SELECT class_id, term_id, subject, MIN(id)
        FROM exam_records GROUP BY class_id, term_id, subject;
    ''')


def _migration_12(conn: sqlite3.Connection):
    """补齐班级任务、材料收集和值日的业务闭环数据。"""
    for column, definition in (
        ('template_id', 'INTEGER REFERENCES class_task_templates(id) ON DELETE SET NULL'),
        ('completed_at', "TEXT NOT NULL DEFAULT ''"),
        ('completion_result', "TEXT NOT NULL DEFAULT ''"),
        ('closed_with_missing_count', 'INTEGER NOT NULL DEFAULT 0'),
    ):
        _add_column(conn, 'class_tasks', column, definition)
    for column, definition in (
        ('reminder_count', 'INTEGER NOT NULL DEFAULT 0'),
        ('last_reminded_at', "TEXT NOT NULL DEFAULT ''"),
        ('updated_at', "TEXT NOT NULL DEFAULT ''"),
    ):
        _add_column(conn, 'class_task_items', column, definition)
    for column, definition in (
        ('rotation_rule_id', 'INTEGER REFERENCES duty_rotation_rules(id) ON DELETE SET NULL'),
        ('rotation_index', 'INTEGER'),
        ('completed_at', "TEXT NOT NULL DEFAULT ''"),
        ('completion_result', "TEXT NOT NULL DEFAULT ''"),
    ):
        _add_column(conn, 'duty_assignments', column, definition)

    conn.executescript('''
        CREATE TABLE IF NOT EXISTS class_task_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            name TEXT NOT NULL,
            task_type TEXT NOT NULL DEFAULT '材料收集',
            material_name TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            default_due_days INTEGER NOT NULL DEFAULT 7,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            deleted_at TEXT NOT NULL DEFAULT '',
            deleted_by TEXT NOT NULL DEFAULT '',
            UNIQUE(class_id, term_id, name)
        );

        CREATE TABLE IF NOT EXISTS class_task_attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL REFERENCES class_tasks(id) ON DELETE CASCADE,
            item_id INTEGER NOT NULL REFERENCES class_task_items(id) ON DELETE CASCADE,
            original_name TEXT NOT NULL,
            stored_name TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
            size_bytes INTEGER NOT NULL DEFAULT 0,
            sha256 TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(item_id, stored_name)
        );

        CREATE TABLE IF NOT EXISTS duty_rotation_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            name TEXT NOT NULL,
            area TEXT NOT NULL,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL DEFAULT '',
            weekday_mask INTEGER NOT NULL DEFAULT 31,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            deleted_at TEXT NOT NULL DEFAULT '',
            deleted_by TEXT NOT NULL DEFAULT '',
            UNIQUE(class_id, term_id, name)
        );

        CREATE TABLE IF NOT EXISTS duty_rotation_members (
            rule_id INTEGER NOT NULL REFERENCES duty_rotation_rules(id) ON DELETE CASCADE,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY(rule_id, student_id),
            UNIQUE(rule_id, position)
        );

        CREATE INDEX IF NOT EXISTS idx_class_task_templates_scope
            ON class_task_templates(class_id, term_id, enabled, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_class_task_attachments_task
            ON class_task_attachments(task_id, item_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_duty_rotation_scope
            ON duty_rotation_rules(class_id, term_id, enabled, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_duty_rotation_members
            ON duty_rotation_members(rule_id, position, student_id);
        CREATE INDEX IF NOT EXISTS idx_duty_assignment_student_date
            ON duty_assignments(class_id, term_id, student_id, duty_date, deleted_at);
    ''')


def _migration_13(conn: sqlite3.Connection):
    """增加行为积分流水、规则命中和旧快照迁移报告。"""
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS point_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            name TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT '日常行为',
            metric TEXT NOT NULL DEFAULT '周期扣分',
            threshold REAL NOT NULL DEFAULT 5,
            period_days INTEGER NOT NULL DEFAULT 7,
            priority TEXT NOT NULL DEFAULT '重要',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            deleted_at TEXT NOT NULL DEFAULT '',
            deleted_by TEXT NOT NULL DEFAULT '',
            UNIQUE(class_id, term_id, name)
        );

        CREATE TABLE IF NOT EXISTS point_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            rule_id INTEGER REFERENCES point_rules(id) ON DELETE SET NULL,
            occurred_at TEXT NOT NULL DEFAULT '',
            period_key TEXT NOT NULL DEFAULT '',
            amount REAL NOT NULL,
            category TEXT NOT NULL DEFAULT '日常行为',
            reason TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '有效',
            reversed_at TEXT NOT NULL DEFAULT '',
            reversal_reason TEXT NOT NULL DEFAULT '',
            source_type TEXT NOT NULL DEFAULT 'manual',
            source_id TEXT NOT NULL DEFAULT '',
            source_key TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL DEFAULT '班主任',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS point_rule_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            reference_date TEXT NOT NULL,
            created_count INTEGER NOT NULL DEFAULT 0,
            resolved_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS point_rule_hits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL REFERENCES point_rule_runs(id) ON DELETE CASCADE,
            rule_id INTEGER NOT NULL REFERENCES point_rules(id) ON DELETE CASCADE,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            period_start TEXT NOT NULL,
            period_end TEXT NOT NULL,
            value REAL NOT NULL DEFAULT 0,
            threshold REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT '新命中',
            task_id INTEGER REFERENCES student_tasks(id) ON DELETE SET NULL,
            resolved_at TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(rule_id, student_id, period_start, period_end)
        );

        CREATE TABLE IF NOT EXISTS point_migration_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            source_sheet TEXT NOT NULL DEFAULT '日常行为积分',
            source_version TEXT NOT NULL DEFAULT 'v1',
            source_rows INTEGER NOT NULL DEFAULT 0,
            imported_entries INTEGER NOT NULL DEFAULT 0,
            skipped_entries INTEGER NOT NULL DEFAULT 0,
            report TEXT NOT NULL DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(class_id, term_id, source_sheet, source_version)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_point_ledger_source_key
            ON point_ledger(class_id, term_id, source_key)
            WHERE source_key<>'';
        CREATE INDEX IF NOT EXISTS idx_point_ledger_scope_date
            ON point_ledger(class_id, term_id, occurred_at, student_id, status);
        CREATE INDEX IF NOT EXISTS idx_point_ledger_student
            ON point_ledger(class_id, term_id, student_id, status, occurred_at);
        CREATE INDEX IF NOT EXISTS idx_point_rules_scope
            ON point_rules(class_id, term_id, enabled, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_point_rule_hits_scope
            ON point_rule_hits(class_id, term_id, status, period_end, student_id);
    ''')
    for column, definition in (
        ('exam_id', 'INTEGER REFERENCES score_exams(id)'),
        ('subject_id', 'INTEGER REFERENCES score_subjects(id)'),
        ('record_status', "TEXT NOT NULL DEFAULT '正常'"),
        ('note', "TEXT NOT NULL DEFAULT ''"),
        ('import_run_id', 'INTEGER'),
    ):
        _add_column(conn, 'exam_records', column, definition)
    conn.executescript('''
        UPDATE exam_records SET exam_id=(
            SELECT x.id FROM score_exams x
            WHERE x.class_id=exam_records.class_id AND x.term_id=exam_records.term_id
              AND x.name=exam_records.exam_name
        ) WHERE exam_id IS NULL;

        UPDATE exam_records SET subject_id=(
            SELECT s.id FROM score_subjects s
            WHERE s.class_id=exam_records.class_id AND s.term_id=exam_records.term_id
              AND s.name=exam_records.subject
        ) WHERE subject_id IS NULL;

        INSERT OR IGNORE INTO score_exam_subjects(exam_id, subject_id, sort_order)
        SELECT exam_id, subject_id, MIN(id) FROM exam_records
        WHERE exam_id IS NOT NULL AND subject_id IS NOT NULL
        GROUP BY exam_id, subject_id;

        CREATE TABLE IF NOT EXISTS score_import_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            request_id TEXT NOT NULL DEFAULT '',
            filename TEXT NOT NULL DEFAULT '',
            duplicate_strategy TEXT NOT NULL DEFAULT 'update',
            imported INTEGER NOT NULL DEFAULT 0,
            updated INTEGER NOT NULL DEFAULT 0,
            skipped INTEGER NOT NULL DEFAULT 0,
            error_count INTEGER NOT NULL DEFAULT 0,
            result_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS score_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            name TEXT NOT NULL,
            metric TEXT NOT NULL,
            subject_id INTEGER REFERENCES score_subjects(id) ON DELETE SET NULL,
            threshold REAL NOT NULL DEFAULT 10,
            priority TEXT NOT NULL DEFAULT '重要',
            enabled INTEGER NOT NULL DEFAULT 1,
            last_run_at TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            deleted_at TEXT NOT NULL DEFAULT '',
            deleted_by TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS score_rule_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            trigger_type TEXT NOT NULL DEFAULT 'manual',
            rules_evaluated INTEGER NOT NULL DEFAULT 0,
            students_evaluated INTEGER NOT NULL DEFAULT 0,
            hit_count INTEGER NOT NULL DEFAULT 0,
            created_count INTEGER NOT NULL DEFAULT 0,
            reopened_count INTEGER NOT NULL DEFAULT 0,
            resolved_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'success',
            error TEXT NOT NULL DEFAULT '',
            summary_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS score_rule_hits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id INTEGER NOT NULL REFERENCES score_rules(id) ON DELETE CASCADE,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            class_id INTEGER NOT NULL REFERENCES classes(id),
            term_id INTEGER NOT NULL REFERENCES terms(id),
            status TEXT NOT NULL DEFAULT '待处理',
            current_value REAL NOT NULL DEFAULT 0,
            previous_exam_id INTEGER REFERENCES score_exams(id) ON DELETE SET NULL,
            current_exam_id INTEGER REFERENCES score_exams(id) ON DELETE SET NULL,
            task_id INTEGER REFERENCES student_tasks(id) ON DELETE SET NULL,
            first_hit_at TEXT NOT NULL DEFAULT '',
            last_hit_at TEXT NOT NULL DEFAULT '',
            handled_at TEXT NOT NULL DEFAULT '',
            resolved_at TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(class_id, term_id, rule_id, student_id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_score_import_request
            ON score_import_runs(class_id, term_id, request_id) WHERE request_id<>'';
        CREATE INDEX IF NOT EXISTS idx_score_exams_scope
            ON score_exams(class_id, term_id, exam_date, sort_order);
        CREATE INDEX IF NOT EXISTS idx_score_subjects_scope
            ON score_subjects(class_id, term_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_exam_records_config
            ON exam_records(class_id, term_id, exam_id, subject_id, student_id);
        CREATE INDEX IF NOT EXISTS idx_score_rule_runs
            ON score_rule_runs(class_id, term_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_score_rule_hits
            ON score_rule_hits(class_id, term_id, rule_id, status, student_id);
    ''')


MIGRATIONS = {
    2: _migration_2,
    3: _migration_3,
    4: _migration_4,
    5: _migration_5,
    6: _migration_6,
    7: _migration_7,
    8: _migration_8,
    9: _migration_9,
    10: _migration_10,
    11: _migration_11,
    12: _migration_12,
    13: _migration_13,
}


def init_schema(conn: sqlite3.Connection, existing_database: bool = True):
    migration_table_exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
    ).fetchone() is not None
    if not migration_table_exists and existing_database and MIGRATIONS:
        _backup_connection(conn, f'pre-migrate-v{min(MIGRATIONS)}')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT DEFAULT (datetime('now','localtime'))
        )
    ''')
    marker = conn.execute('SELECT MAX(version) AS version FROM schema_migrations').fetchone()
    if marker['version'] is None:
        conn.execute(
            'INSERT INTO schema_migrations(version) VALUES(?)',
            (BASE_SCHEMA_VERSION,))
        # SQLite backup API 不能在当前连接存在未提交写事务时可靠完成。
        conn.commit()
    current = schema_version(conn)
    if current > CURRENT_SCHEMA_VERSION:
        raise RuntimeError(
            f'数据库版本 {current} 高于当前程序支持的版本 {CURRENT_SCHEMA_VERSION}')
    pending = [version for version in sorted(MIGRATIONS) if version > current]
    if pending and existing_database and migration_table_exists:
        _backup_connection(conn, f'pre-migrate-v{pending[0]}')

    conn.executescript('''
    -- 学生信息（结构化，学号唯一，导入合并去重的依据）
    CREATE TABLE IF NOT EXISTS students (
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
    ''')
    # 兼容旧库：补全新列
    for col, typ in [('监护人2姓名', "TEXT DEFAULT ''"), ('监护人2电话', "TEXT DEFAULT ''"), ('监护人2关系', "TEXT DEFAULT ''")]:
        try:
            conn.execute(f'ALTER TABLE students ADD COLUMN "{col}" {typ}')
        except sqlite3.OperationalError:
            pass
    conn.executescript('''
    -- 通用工作表：表头元数据
    CREATE TABLE IF NOT EXISTS sheet_meta (
        sheet TEXT PRIMARY KEY,
        headers TEXT NOT NULL DEFAULT '[]',
        category TEXT DEFAULT '',
        group_name TEXT DEFAULT 'teacher'
    );

    -- 通用工作表：数据行（JSON 数组，与 headers 对齐）
    CREATE TABLE IF NOT EXISTS sheet_rows (
        sheet TEXT NOT NULL,
        row_no INTEGER NOT NULL,           -- 逻辑行号（1 起，稳定不变）
        data TEXT NOT NULL DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        PRIMARY KEY (sheet, row_no)
    );

    -- 座位表
    CREATE TABLE IF NOT EXISTS seating (
        r INTEGER NOT NULL,
        c INTEGER NOT NULL,
        val TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (r, c)
    );

    CREATE TABLE IF NOT EXISTS app_flags (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
    );

    -- P0 核心流程：结构化记录，统一通过 student_id 关联学生
    CREATE TABLE IF NOT EXISTS student_events (
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

    CREATE TABLE IF NOT EXISTS student_tasks (
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

    CREATE TABLE IF NOT EXISTS focus_items (
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

    CREATE TABLE IF NOT EXISTS communications (
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

    -- P1：结构化成绩记录（支持长表与宽表 Excel 导入）
    CREATE TABLE IF NOT EXISTS exam_records (
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

    -- P1：考勤规则，命中后生成待办提醒
    CREATE TABLE IF NOT EXISTS attendance_rules (
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

    -- P1：班级任务与学生材料收集项
    CREATE TABLE IF NOT EXISTS class_tasks (
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

    CREATE TABLE IF NOT EXISTS class_task_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES class_tasks(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT '未提交',
        note TEXT DEFAULT '',
        submitted_at TEXT DEFAULT '',
        UNIQUE(task_id, student_id)
    );

    -- P1：值日安排
    CREATE TABLE IF NOT EXISTS duty_assignments (
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
    ''')

    for version in pending:
        MIGRATIONS[version](conn)
        conn.execute('INSERT INTO schema_migrations(version) VALUES(?)', (version,))
    conn.commit()


# ---------- 通用工作表 ----------

def get_sheet_meta(sheet: str) -> dict | None:
    row = get_conn().execute('SELECT * FROM sheet_meta WHERE sheet=?', (sheet,)).fetchone()
    if not row:
        return None
    return {'sheet': sheet, 'headers': json.loads(row['headers']),
            'category': row['category'], 'group': row['group_name']}


def set_sheet_meta(sheet: str, headers: list[str], category: str = '', group_name: str = 'teacher'):
    get_conn().execute(
        'INSERT OR REPLACE INTO sheet_meta(sheet, headers, category, group_name) VALUES(?,?,?,?)',
        (sheet, json.dumps(headers, ensure_ascii=False), category, group_name))
    get_conn().commit()


def _scope_ids(write: bool = False) -> tuple[int, int]:
    from .services.class_context import get_current_scope
    scope = get_current_scope(write=write)
    return int(scope['class_id']), int(scope['term_id'])


def _personal_sheet(sheet: str) -> bool:
    from .config import SHEET_META
    return SHEET_META.get(sheet, {}).get('group') == 'personal'


def get_rows(sheet: str) -> list[dict]:
    if _personal_sheet(sheet):
        rows = get_conn().execute(
            'SELECT row_no, data, created_at, updated_at FROM sheet_rows '
            "WHERE sheet=? AND deleted_at='' ORDER BY row_no", (sheet,)).fetchall()
    else:
        class_id, term_id = _scope_ids()
        rows = get_conn().execute(
            'SELECT row_no, data, created_at, updated_at FROM sheet_rows '
            "WHERE sheet=? AND class_id=? AND term_id=? AND deleted_at='' ORDER BY row_no",
            (sheet, class_id, term_id)).fetchall()
    return [{'row_no': r['row_no'], 'data': json.loads(r['data']),
             'created_at': r['created_at'], 'updated_at': r['updated_at']} for r in rows]


def next_row_no(sheet: str) -> int:
    row = get_conn().execute('SELECT COALESCE(MAX(row_no),0)+1 AS n FROM sheet_rows WHERE sheet=?',
                             (sheet,)).fetchone()
    return row['n']


def insert_row(sheet: str, data: list) -> int:
    class_id, term_id = _scope_ids(write=not _personal_sheet(sheet))
    row_no = next_row_no(sheet)
    get_conn().execute(
        'INSERT INTO sheet_rows(sheet, row_no, data, class_id, term_id) VALUES(?,?,?,?,?)',
        (sheet, row_no, json.dumps(data, ensure_ascii=False), class_id, term_id))
    get_conn().commit()
    return row_no


def update_cell(sheet: str, row_no: int, col: int, value):
    class_id, term_id = _scope_ids(write=not _personal_sheet(sheet))
    row = get_rows(sheet)
    target = next((r for r in row if r['row_no'] == row_no), None)
    if not target:
        raise KeyError(f'行 {row_no} 不存在')
    data = list(target['data'])
    while len(data) <= col:
        data.append(None)
    data[col] = value
    if _personal_sheet(sheet):
        get_conn().execute(
            'UPDATE sheet_rows SET data=?, updated_at=datetime(\'now\',\'localtime\') '
            "WHERE sheet=? AND row_no=? AND deleted_at=''",
            (json.dumps(data, ensure_ascii=False), sheet, row_no))
    else:
        get_conn().execute(
            'UPDATE sheet_rows SET data=?, updated_at=datetime(\'now\',\'localtime\') '
            "WHERE sheet=? AND row_no=? AND class_id=? AND term_id=? AND deleted_at=''",
            (json.dumps(data, ensure_ascii=False), sheet, row_no, class_id, term_id))
    get_conn().commit()


def replace_row(sheet: str, row_no: int, data: list):
    """完整替换一行，供批量考勤等需要原子更新的流程使用。"""
    class_id, term_id = _scope_ids(write=not _personal_sheet(sheet))
    if _personal_sheet(sheet):
        cur = get_conn().execute(
            'UPDATE sheet_rows SET data=?, updated_at=datetime(\'now\',\'localtime\') '
            "WHERE sheet=? AND row_no=? AND deleted_at=''",
            (json.dumps(data, ensure_ascii=False), sheet, row_no))
    else:
        cur = get_conn().execute(
            'UPDATE sheet_rows SET data=?, updated_at=datetime(\'now\',\'localtime\') '
            "WHERE sheet=? AND row_no=? AND class_id=? AND term_id=? AND deleted_at=''",
            (json.dumps(data, ensure_ascii=False), sheet, row_no, class_id, term_id))
    get_conn().commit()
    if cur.rowcount == 0:
        raise KeyError(f'行 {row_no} 不存在')


# ---------- Agent / 微信状态 ----------

def get_agent_setting(key: str, default: str = '') -> str:
    row = get_conn().execute(
        'SELECT value FROM agent_settings WHERE key=?', (key,)
    ).fetchone()
    return str(row['value']) if row else default


def set_agent_setting(key: str, value: str):
    get_conn().execute(
        "INSERT INTO agent_settings(key, value, updated_at) VALUES(?,?,datetime('now','localtime')) "
        'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
        (key, str(value)),
    )
    get_conn().commit()


def load_agent_session(session_id: str) -> list[dict]:
    row = get_conn().execute(
        'SELECT messages FROM agent_sessions WHERE session_id=?', (session_id,)
    ).fetchone()
    if not row:
        return []
    try:
        value = json.loads(row['messages'])
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def save_agent_session(session_id: str, messages: list[dict]):
    get_conn().execute(
        "INSERT INTO agent_sessions(session_id, messages, updated_at) VALUES(?,?,datetime('now','localtime')) "
        'ON CONFLICT(session_id) DO UPDATE SET messages=excluded.messages, updated_at=excluded.updated_at',
        (session_id, json.dumps(messages, ensure_ascii=False)),
    )
    get_conn().commit()


def delete_agent_session(session_id: str):
    get_conn().execute('DELETE FROM agent_sessions WHERE session_id=?', (session_id,))
    get_conn().commit()


def claim_wechat_message(message_id: str) -> bool:
    if not message_id:
        return True
    conn = get_conn()
    existing = conn.execute(
        'SELECT status FROM wechat_message_receipts WHERE message_id=?', (message_id,)
    ).fetchone()
    if existing and existing['status'] == 'processed':
        return False
    if existing:
        conn.execute(
            "UPDATE wechat_message_receipts SET status='processing', updated_at=datetime('now','localtime') "
            'WHERE message_id=?',
            (message_id,),
        )
        conn.commit()
        return True
    cur = conn.execute(
        'INSERT INTO wechat_message_receipts(message_id) VALUES(?)', (message_id,)
    )
    conn.commit()
    return cur.rowcount == 1


def mark_wechat_message(message_id: str, status: str):
    if not message_id:
        return
    get_conn().execute(
        "UPDATE wechat_message_receipts SET status=?, updated_at=datetime('now','localtime') WHERE message_id=?",
        (status, message_id),
    )
    get_conn().commit()
