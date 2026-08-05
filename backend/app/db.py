# -*- coding: utf-8 -*-
"""SQLite 数据层（WAL 模式，启动时建表）"""
import json
import os
import sqlite3
import threading

from .config import DATA_DIR, DB_PATH

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()


def get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        with _lock:
            if _conn is None:
                os.makedirs(DATA_DIR, exist_ok=True)
                _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
                _conn.row_factory = sqlite3.Row
                _conn.execute('PRAGMA journal_mode=WAL')
                _conn.execute('PRAGMA busy_timeout=5000')
                _conn.execute('PRAGMA foreign_keys=ON')
                init_schema(_conn)
    return _conn


def close():
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None


def init_schema(conn: sqlite3.Connection):
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
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

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
    ''')
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
