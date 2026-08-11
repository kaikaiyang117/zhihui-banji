# -*- coding: utf-8 -*-
"""MIG-00 基线工具公共模块：隔离数据目录、固定夹具种子和输出归一化。

所有基线只使用临时数据目录，禁止触碰 data/workbench.db 与真实知识库。
"""
import json
import os
import sys
import tempfile
from contextlib import contextmanager

BACKEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'backend')
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURES = os.path.join(BACKEND_DIR, 'tests', 'fixtures')
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
OUT_DB = os.path.join(OUT_DIR, 'db')
OUT_API = os.path.join(OUT_DIR, 'api')
OUT_AGENT = os.path.join(OUT_DIR, 'agent')

for _d in (OUT_DIR, OUT_DB, OUT_API, OUT_AGENT):
    os.makedirs(_d, exist_ok=True)


def ensure_backend_importable():
    if BACKEND_DIR not in sys.path:
        sys.path.insert(0, BACKEND_DIR)


def write_json(path: str, payload):
    with open(path, 'w', encoding='utf-8') as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2, sort_keys=True)
    return path


def read_json(path: str):
    with open(path, encoding='utf-8') as stream:
        return json.load(stream)


@contextmanager
def temp_data_dir(seed_fixture: str | None = None):
    """切换到临时数据目录；可选按现有测试夹具种子学生并注册在班。

    seed_fixture: p0_demo / p1_demo / agent_regression / None
    """
    ensure_backend_importable()
    from app import db
    from backend.tests.helpers import enroll_all_students

    old_path, old_data_dir = db.DB_PATH, db.DATA_DIR
    db.close()
    tmp = tempfile.TemporaryDirectory()
    db.DATA_DIR = tmp.name
    db.DB_PATH = os.path.join(tmp.name, 'workbench.db')
    conn = db.get_conn()
    if seed_fixture:
        fixture = read_json(os.path.join(FIXTURES, f'{seed_fixture}.json'))
        for student in fixture.get('students', []):
            columns = ['学号', '姓名', '性别', '班级任职']
            conn.execute(
                'INSERT INTO students(学号, 姓名, 性别, 班级任职) VALUES(?,?,?,?)',
                tuple(student.get(c, '') for c in columns))
        conn.commit()
        enroll_all_students()
    try:
        yield db
    finally:
        db.close()
        db.DB_PATH, db.DATA_DIR = old_path, old_data_dir
        tmp.cleanup()


def schema_snapshot(conn) -> dict:
    """导出可比较的 schema：表、列、索引、触发器、外键和迁移版本。"""
    tables = {}
    for row in conn.execute(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall():
        name, kind = row['name'], row['type']
        if kind == 'table':
            columns = []
            for col in conn.execute(f'PRAGMA table_info("{name}")').fetchall():
                columns.append({
                    'name': col['name'],
                    'type': col['type'],
                    'notnull': bool(col['notnull']),
                    'default': col['dflt_value'],
                    'pk': col['pk'],
                })
            indexes = []
            for idx in conn.execute(f'PRAGMA index_list("{name}")').fetchall():
                columns_list = [row['name'] for row in
                                conn.execute(f'PRAGMA index_info("{idx["name"]}")').fetchall()]
                indexes.append({
                    'name': idx['name'],
                    'unique': bool(idx['unique']),
                    'origin': idx['origin'],
                    'columns': columns_list,
                })
            foreign_keys = []
            for fk in conn.execute(f'PRAGMA foreign_key_list("{name}")').fetchall():
                foreign_keys.append({
                    'table': fk['table'],
                    'from': fk['from'],
                    'to': fk['to'],
                    'on_update': fk['on_update'],
                    'on_delete': fk['on_delete'],
                })
            tables[name] = {
                'kind': kind,
                'columns': columns,
                'indexes': indexes,
                'foreign_keys': foreign_keys,
            }
        else:
            tables[name] = {'kind': kind}
    triggers = [
        dict(row) for row in conn.execute(
            "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name"
        ).fetchall()
    ]
    version = conn.execute('SELECT MAX(version) AS v FROM schema_migrations').fetchone()['v']
    return {'version': version, 'tables': tables, 'triggers': triggers}


def row_counts(conn) -> dict:
    """每个表的行数，用于数据基线比较。"""
    counts = {}
    for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall():
        counts[row['name']] = conn.execute(f'SELECT COUNT(*) AS c FROM "{row["name"]}"').fetchone()['c']
    return counts
