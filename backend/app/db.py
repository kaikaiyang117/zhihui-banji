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
CURRENT_SCHEMA_VERSION = 4

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()


def get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        with _lock:
            if _conn is None:
                existing_database = os.path.isfile(DB_PATH)
                os.makedirs(DATA_DIR, exist_ok=True)
                _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
                _conn.row_factory = sqlite3.Row
                _conn.execute('PRAGMA journal_mode=WAL')
                _conn.execute('PRAGMA busy_timeout=5000')
                _conn.execute('PRAGMA foreign_keys=ON')
                init_schema(_conn, existing_database=existing_database)
    return _conn


def close():
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None


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


MIGRATIONS = {2: _migration_2, 3: _migration_3, 4: _migration_4}


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


def get_rows(sheet: str) -> list[dict]:
    rows = get_conn().execute(
        'SELECT row_no, data, created_at, updated_at FROM sheet_rows WHERE sheet=? ORDER BY row_no',
        (sheet,)).fetchall()
    return [{'row_no': r['row_no'], 'data': json.loads(r['data'])} for r in rows]


def next_row_no(sheet: str) -> int:
    row = get_conn().execute('SELECT COALESCE(MAX(row_no),0)+1 AS n FROM sheet_rows WHERE sheet=?',
                             (sheet,)).fetchone()
    return row['n']


def insert_row(sheet: str, data: list) -> int:
    row_no = next_row_no(sheet)
    get_conn().execute('INSERT INTO sheet_rows(sheet, row_no, data) VALUES(?,?,?)',
                       (sheet, row_no, json.dumps(data, ensure_ascii=False)))
    get_conn().commit()
    return row_no


def update_cell(sheet: str, row_no: int, col: int, value):
    row = get_rows(sheet)
    target = next((r for r in row if r['row_no'] == row_no), None)
    if not target:
        raise KeyError(f'行 {row_no} 不存在')
    data = list(target['data'])
    while len(data) <= col:
        data.append(None)
    data[col] = value
    get_conn().execute('UPDATE sheet_rows SET data=?, updated_at=datetime(\'now\',\'localtime\') WHERE sheet=? AND row_no=?',
                       (json.dumps(data, ensure_ascii=False), sheet, row_no))
    get_conn().commit()


def delete_row(sheet: str, row_no: int):
    get_conn().execute('DELETE FROM sheet_rows WHERE sheet=? AND row_no=?', (sheet, row_no))
    get_conn().commit()


def replace_row(sheet: str, row_no: int, data: list):
    """完整替换一行，供批量考勤等需要原子更新的流程使用。"""
    cur = get_conn().execute(
        'UPDATE sheet_rows SET data=?, updated_at=datetime(\'now\',\'localtime\') WHERE sheet=? AND row_no=?',
        (json.dumps(data, ensure_ascii=False), sheet, row_no))
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
