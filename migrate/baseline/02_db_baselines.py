# -*- coding: utf-8 -*-
"""MIG-00 基线 3：数据库基线样本与 schema 快照。

产出：
- empty-v<N>：通过限定迁移集重建的历史空库（4/10/15/20/25）
- v4-sample：固定旧版 SQL 样本（backend/tests/fixtures/migration_v4.sql）
- v4-upgraded：旧版样本升级到当前版本的结果
- demo-p0 / demo-p1：当前版本 + 固定夹具数据

每个基线目录包含 workbench.db、schema.json、counts.json 和 meta.json。
全部在临时目录生成，不触碰 data/workbench.db。
"""
import json
import os
import shutil
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import BACKEND_DIR, FIXTURES, OUT_DB, schema_snapshot, row_counts, write_json  # noqa: E402

sys.path.insert(0, BACKEND_DIR)
sys.path.insert(0, os.path.dirname(BACKEND_DIR))  # 让 backend.tests 可导入


def snapshot_and_store(name: str, conn) -> dict:
    target = os.path.join(OUT_DB, name)
    shutil.rmtree(target, ignore_errors=True)
    os.makedirs(target, exist_ok=True)
    conn.commit()
    schema = schema_snapshot(conn)
    counts = row_counts(conn)
    # WAL 模式：先 checkpoint，否则只复制主文件会丢失 -wal 中的已提交数据。
    conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    source = os.path.abspath(conn.execute('SELECT file FROM pragma_database_list WHERE name="main"').fetchone()['file'])
    shutil.copy2(source, os.path.join(target, 'workbench.db'))
    write_json(os.path.join(target, 'schema.json'), schema)
    write_json(os.path.join(target, 'counts.json'), counts)
    write_json(os.path.join(target, 'meta.json'), {
        'name': name,
        'schema_version': schema['version'],
        'tables': len(schema['tables']),
        'rows': sum(counts.values()),
    })
    return schema['version']


def empty_at_version(version: int) -> int:
    """限定 MIGRATIONS 到目标版本，重建该版本的空库。"""
    from app import db
    old_path, old_data_dir = db.DB_PATH, db.DATA_DIR
    db.close()
    db.DATA_DIR = os.path.join(OUT_DB, '.tmp-empty')
    db.DB_PATH = os.path.join(OUT_DB, '.tmp-empty', 'workbench.db')
    os.makedirs(db.DATA_DIR, exist_ok=True)
    orig_migrations = db.MIGRATIONS
    try:
        db.MIGRATIONS = {v: orig_migrations[v] for v in orig_migrations if v <= version}
        conn = db.get_conn()
        result = snapshot_and_store(f'empty-v{version}', conn)
    finally:
        db.MIGRATIONS = orig_migrations
        db.close()
        db.DB_PATH, db.DATA_DIR = old_path, old_data_dir
        shutil.rmtree(os.path.join(OUT_DB, '.tmp-empty'), ignore_errors=True)
    return result


def v4_sample() -> int:
    shutil.rmtree(os.path.join(OUT_DB, '.tmp-v4'), ignore_errors=True)
    os.makedirs(os.path.join(OUT_DB, '.tmp-v4'), exist_ok=True)
    path = os.path.join(OUT_DB, '.tmp-v4', 'workbench.db')
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(open(os.path.join(FIXTURES, 'migration_v4.sql'), encoding='utf-8').read())
        conn.commit()
    finally:
        conn.close()
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        result = snapshot_and_store('v4-sample', conn)
    finally:
        conn.close()
    shutil.rmtree(os.path.join(OUT_DB, '.tmp-v4'), ignore_errors=True)
    return result


def v4_upgraded() -> int:
    """把 v4 样本复制到临时目录，交给当前迁移引擎升级。"""
    from app import db
    shutil.rmtree(os.path.join(OUT_DB, '.tmp-upgrade'), ignore_errors=True)
    os.makedirs(os.path.join(OUT_DB, '.tmp-upgrade'), exist_ok=True)
    shutil.copy2(os.path.join(OUT_DB, 'v4-sample', 'workbench.db'),
                 os.path.join(OUT_DB, '.tmp-upgrade', 'workbench.db'))
    old_path, old_data_dir = db.DB_PATH, db.DATA_DIR
    db.close()
    db.DATA_DIR = os.path.join(OUT_DB, '.tmp-upgrade')
    db.DB_PATH = os.path.join(OUT_DB, '.tmp-upgrade', 'workbench.db')
    try:
        conn = db.get_conn()
        result = snapshot_and_store('v4-upgraded', conn)
    finally:
        db.close()
        db.DB_PATH, db.DATA_DIR = old_path, old_data_dir
        shutil.rmtree(os.path.join(OUT_DB, '.tmp-upgrade'), ignore_errors=True)
    return result


def demo_sample(name: str) -> int:
    """当前版本 + 固定夹具数据。"""
    from app import db
    from backend.tests.helpers import enroll_all_students
    shutil.rmtree(os.path.join(OUT_DB, f'.tmp-{name}'), ignore_errors=True)
    os.makedirs(os.path.join(OUT_DB, f'.tmp-{name}'), exist_ok=True)
    old_path, old_data_dir = db.DB_PATH, db.DATA_DIR
    db.close()
    db.DATA_DIR = os.path.join(OUT_DB, f'.tmp-{name}')
    db.DB_PATH = os.path.join(OUT_DB, f'.tmp-{name}', 'workbench.db')
    try:
        conn = db.get_conn()
        fixture = json.load(open(os.path.join(FIXTURES, f'{name}.json'), encoding='utf-8'))
        for student in fixture.get('students', []):
            columns = ['学号', '姓名', '性别', '班级任职']
            conn.execute(
                'INSERT INTO students(学号, 姓名, 性别, 班级任职) VALUES(?,?,?,?)',
                tuple(student.get(c, '') for c in columns))
        conn.commit()
        enroll_all_students()
        result = snapshot_and_store(name, conn)
    finally:
        db.close()
        db.DB_PATH, db.DATA_DIR = old_path, old_data_dir
        shutil.rmtree(os.path.join(OUT_DB, f'.tmp-{name}'), ignore_errors=True)
    return result


def main():
    results = {}
    for version in (4, 10, 15, 20, 25):
        results[f'empty-v{version}'] = empty_at_version(version)
    results['v4-sample'] = v4_sample()
    results['v4-upgraded'] = v4_upgraded()
    results['p0_demo'] = demo_sample('p0_demo')
    results['p1_demo'] = demo_sample('p1_demo')
    write_json(os.path.join(OUT_DB, 'summary.json'), results)
    print('数据库基线已生成：')
    for name in results:
        meta = json.load(open(os.path.join(OUT_DB, name, 'meta.json'), encoding='utf-8'))
        print(f'  {name}: schema v{meta["schema_version"]}，{meta["tables"]} 张表，{meta["rows"]} 行')
    return 0


if __name__ == '__main__':
    sys.exit(main())
