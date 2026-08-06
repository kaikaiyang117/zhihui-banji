# -*- coding: utf-8 -*-
"""Agent 第一阶段只读业务服务。

这些函数不依赖 FastAPI 路由，后续可同时被 HTTP、微信和 MCP 适配器调用。
"""
from __future__ import annotations

from typing import Optional

from .. import db


def get_class_student_count() -> dict:
    """返回当前工作台学生表中的班级人数。"""
    row = db.get_conn().execute('SELECT COUNT(*) AS count FROM students').fetchone()
    return {'student_count': int(row['count'] if row else 0)}


def search_students(keyword: str = '', limit: int = 20) -> dict:
    keyword = str(keyword or '').strip()
    limit = max(1, min(int(limit), 100))
    conn = db.get_conn()
    sql = (
        'SELECT id, 学号, 姓名, 性别, 班级任职, 是否住校 '
        'FROM students'
    )
    params: tuple = ()
    if keyword:
        sql += ' WHERE 姓名 LIKE ? OR 学号 LIKE ?'
        params = (f'%{keyword}%', f'%{keyword}%')
    sql += ' ORDER BY 学号 LIMIT ?'
    rows = conn.execute(sql, (*params, limit)).fetchall()
    return {'students': [dict(row) for row in rows], 'count': len(rows)}


def get_student_profile(student_id: int) -> dict:
    row = db.get_conn().execute(
        'SELECT id, 学号, 姓名, 性别, 出生年月, 民族, 家庭住址, 监护人姓名, '
        '监护人电话, 监护人职业, 是否住校, 特长, 班级任职, 备注, '
        '监护人2姓名, 监护人2电话, 监护人2关系 '
        'FROM students WHERE id=?',
        (int(student_id),),
    ).fetchone()
    if not row:
        raise ValueError('学生不存在')
    return {'student': dict(row)}


def get_student_timeline(student_id: int, limit: int = 30) -> dict:
    student_id = int(student_id)
    limit = max(1, min(int(limit), 100))
    profile = get_student_profile(student_id)['student']
    conn = db.get_conn()
    timeline = []

    events = conn.execute(
        'SELECT id, occurred_at AS at, event_type AS title, description AS summary, status '
        'FROM student_events WHERE student_id=? ORDER BY occurred_at DESC, id DESC LIMIT ?',
        (student_id, limit),
    ).fetchall()
    timeline.extend({'kind': 'event', **dict(row)} for row in events)

    communications = conn.execute(
        "SELECT id, communicated_at AS at, '家校沟通' AS title, summary, status "
        'FROM communications WHERE student_id=? '
        'ORDER BY communicated_at DESC, id DESC LIMIT ?',
        (student_id, limit),
    ).fetchall()
    timeline.extend({'kind': 'communication', **dict(row)} for row in communications)

    tasks = conn.execute(
        "SELECT id, COALESCE(due_at, created_at) AS at, '待办' AS title, title AS summary, status "
        'FROM student_tasks WHERE student_id=? ORDER BY due_at DESC, id DESC LIMIT ?',
        (student_id, limit),
    ).fetchall()
    timeline.extend({'kind': 'task', **dict(row)} for row in tasks)

    timeline.sort(key=lambda item: str(item.get('at') or ''), reverse=True)
    return {
        'student': {'id': profile['id'], '学号': profile['学号'], '姓名': profile['姓名']},
        'timeline': timeline[:limit],
    }
