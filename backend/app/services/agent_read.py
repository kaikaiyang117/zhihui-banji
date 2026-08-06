# -*- coding: utf-8 -*-
"""Agent 第一阶段只读业务服务。

这些函数不依赖 FastAPI 路由，后续可同时被 HTTP、微信和 MCP 适配器调用。
"""
from __future__ import annotations

from typing import Optional

from .. import db


def _student_identity(student_id: int | None = None) -> tuple[int | None, str, str]:
    if not student_id:
        return None, '', ''
    row = db.get_conn().execute('SELECT id, 学号, 姓名 FROM students WHERE id=?', (int(student_id),)).fetchone()
    if not row:
        raise ValueError('学生不存在')
    return int(row['id']), str(row['学号'] or ''), str(row['姓名'] or '')


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


def get_attendance_summary(
    student_id: int | None = None,
    date_from: str = '',
    date_to: str = '',
    limit: int = 30,
) -> dict:
    """查询全班或指定学生的考勤统计和最近记录。"""
    _, student_no, student_name = _student_identity(student_id)
    date_from, date_to = str(date_from or '')[:10], str(date_to or '')[:10]
    limit = max(1, min(int(limit), 100))
    summary: dict[str, int] = {}
    records = []
    for item in db.get_rows('考勤管理'):
        data = item['data']
        if len(data) < 5:
            continue
        date, xh = str(data[0] or '')[:10], str(data[2] or '').strip()
        if student_no and xh != student_no:
            continue
        if date_from and date < date_from or date_to and date > date_to:
            continue
        status = str(data[4] or '').strip()
        if not status:
            continue
        summary[status] = summary.get(status, 0) + 1
        records.append({
            'date': date,
            'student_name': str(data[3] or '').strip(),
            'status': status,
            'reason': str(data[5] or '').strip() if len(data) > 5 else '',
        })
    records.sort(key=lambda row: row['date'], reverse=True)
    return {
        'student': {'id': student_id, '姓名': student_name} if student_id else None,
        'date_from': date_from,
        'date_to': date_to,
        'summary': summary,
        'records': records[:limit],
    }


def get_scores_summary(
    student_id: int | None = None,
    exam_name: str = '',
    limit: int = 20,
) -> dict:
    """查询全班或指定学生的考试成绩汇总。"""
    _, _, student_name = _student_identity(student_id)
    limit = max(1, min(int(limit), 100))
    sql = (
        'SELECT e.exam_name, e.exam_date, e.subject, e.score, e.rank, '
        's.id AS student_id, s.姓名 AS student_name '
        'FROM exam_records e JOIN students s ON s.id=e.student_id'
    )
    where, params = [], []
    if student_id:
        where.append('e.student_id=?')
        params.append(int(student_id))
    if exam_name:
        where.append('e.exam_name LIKE ?')
        params.append(f'%{str(exam_name).strip()}%')
    if where:
        sql += ' WHERE ' + ' AND '.join(where)
    rows = [dict(row) for row in db.get_conn().execute(
        sql + ' ORDER BY e.exam_date DESC, e.exam_name, s.学号, e.subject', tuple(params)
    ).fetchall()]
    grouped = {}
    for row in rows:
        key = (row['student_id'], row['exam_name'], row['exam_date'])
        exam = grouped.setdefault(key, {
            'student_id': row['student_id'],
            'student_name': row['student_name'],
            'exam_name': row['exam_name'],
            'exam_date': row['exam_date'],
            'subjects': {},
            'total': 0,
        })
        exam['subjects'][row['subject']] = row['score']
        if row['score'] is not None:
            exam['total'] += row['score']
    exams = list(grouped.values())[:limit]
    return {'student': {'id': student_id, '姓名': student_name} if student_id else None, 'exams': exams}


def get_tasks_list(
    status: str = '',
    student_id: int | None = None,
    limit: int = 20,
) -> dict:
    """查询待办，默认优先返回未完成事项。"""
    student_id_value, _, student_name = _student_identity(student_id)
    limit = max(1, min(int(limit), 100))
    sql = (
        'SELECT t.id, t.title, t.source, t.due_at, t.priority, t.status, t.notes, '
        't.student_id, s.姓名 AS student_name FROM student_tasks t '
        'LEFT JOIN students s ON s.id=t.student_id'
    )
    where, params = [], []
    if status:
        where.append('t.status=?')
        params.append(str(status).strip())
    else:
        where.append("t.status NOT IN ('已完成','已取消')")
    if student_id_value:
        where.append('t.student_id=?')
        params.append(student_id_value)
    sql += ' WHERE ' + ' AND '.join(where)
    sql += " ORDER BY CASE t.priority WHEN '紧急' THEN 0 WHEN '重要' THEN 1 ELSE 2 END, t.due_at, t.id DESC LIMIT ?"
    params.append(limit)
    tasks = [dict(row) for row in db.get_conn().execute(sql, tuple(params)).fetchall()]
    return {'student': {'id': student_id, '姓名': student_name} if student_id else None, 'tasks': tasks}


def get_communications_list(
    status: str = '',
    student_id: int | None = None,
    limit: int = 20,
) -> dict:
    """查询家校沟通记录，只返回沟通摘要和跟进信息。"""
    student_id_value, _, student_name = _student_identity(student_id)
    limit = max(1, min(int(limit), 100))
    sql = (
        'SELECT c.id, c.student_id, s.姓名 AS student_name, c.communicated_at, '
        'c.method, c.reason, c.summary, c.feedback, c.agreement, c.followup_at, c.status '
        'FROM communications c JOIN students s ON s.id=c.student_id'
    )
    where, params = [], []
    if status:
        where.append('c.status=?')
        params.append(str(status).strip())
    if student_id_value:
        where.append('c.student_id=?')
        params.append(student_id_value)
    if where:
        sql += ' WHERE ' + ' AND '.join(where)
    sql += ' ORDER BY c.communicated_at DESC, c.id DESC LIMIT ?'
    params.append(limit)
    records = [dict(row) for row in db.get_conn().execute(sql, tuple(params)).fetchall()]
    return {'student': {'id': student_id, '姓名': student_name} if student_id else None, 'communications': records}
