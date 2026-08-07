# -*- coding: utf-8 -*-
"""Agent 第一阶段只读业务服务。

这些函数不依赖 FastAPI 路由，后续可同时被 HTTP、微信和 MCP 适配器调用。
"""
from __future__ import annotations

from typing import Optional

from .. import db
from .class_context import scope_ids
from . import attendance, scores, work_items


def _student_identity(student_id: int | None = None) -> tuple[int | None, str, str]:
    if not student_id:
        return None, '', ''
    class_id, term_id = scope_ids(conn=db.get_conn())
    row = db.get_conn().execute(
        'SELECT s.id, s.学号, s.姓名 FROM students s JOIN student_enrollments e ON e.student_id=s.id '
        "WHERE s.id=? AND e.class_id=? AND e.term_id=? AND s.deleted_at=''",
        (int(student_id), class_id, term_id)).fetchone()
    if not row:
        raise ValueError('学生不存在')
    return int(row['id']), str(row['学号'] or ''), str(row['姓名'] or '')


def get_class_student_count() -> dict:
    """返回当前工作台学生表中的班级人数。"""
    class_id, term_id = scope_ids(conn=db.get_conn())
    row = db.get_conn().execute(
        "SELECT COUNT(*) AS count FROM student_enrollments e JOIN students s ON s.id=e.student_id "
        "WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''",
        (class_id, term_id)).fetchone()
    return {'student_count': int(row['count'] if row else 0)}


def search_students(keyword: str = '', limit: int = 20) -> dict:
    keyword = str(keyword or '').strip()
    limit = max(1, min(int(limit), 100))
    conn = db.get_conn()
    class_id, term_id = scope_ids(conn=conn)
    sql = (
        'SELECT s.id, s.学号, s.姓名, s.性别, s.班级任职, s.是否住校 '
        'FROM students s JOIN student_enrollments e ON e.student_id=s.id '
        "WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''"
    )
    params: list = [class_id, term_id]
    if keyword:
        sql += ' AND (s.姓名 LIKE ? OR s.学号 LIKE ?)'
        params.extend((f'%{keyword}%', f'%{keyword}%'))
    sql += ' ORDER BY s.学号 LIMIT ?'
    rows = conn.execute(sql, (*params, limit)).fetchall()
    return {'students': [dict(row) for row in rows], 'count': len(rows)}


def get_student_profile(student_id: int) -> dict:
    class_id, term_id = scope_ids(conn=db.get_conn())
    row = db.get_conn().execute(
        'SELECT id, 学号, 姓名, 性别, 出生年月, 民族, 家庭住址, 监护人姓名, '
        '监护人电话, 监护人职业, 是否住校, 特长, 班级任职, 备注, '
        '监护人2姓名, 监护人2电话, 监护人2关系 '
        "FROM students s WHERE id=? AND s.deleted_at='' AND EXISTS("
        'SELECT 1 FROM student_enrollments e WHERE e.student_id=s.id AND e.class_id=? AND e.term_id=?)',
        (int(student_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise ValueError('学生不存在')
    return {'student': dict(row)}


def get_student_timeline(student_id: int, limit: int = 30) -> dict:
    student_id = int(student_id)
    limit = max(1, min(int(limit), 100))
    profile = get_student_profile(student_id)['student']
    conn = db.get_conn()
    class_id, term_id = scope_ids(conn=conn)
    timeline = []

    events = conn.execute(
        'SELECT id, occurred_at AS at, event_type AS title, description AS summary, status '
        "FROM student_events WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at='' "
        'ORDER BY occurred_at DESC, id DESC LIMIT ?',
        (student_id, class_id, term_id, limit),
    ).fetchall()
    timeline.extend({'kind': 'event', **dict(row)} for row in events)

    communications = conn.execute(
        "SELECT id, communicated_at AS at, '家校沟通' AS title, summary, status "
        "FROM communications WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at='' "
        'ORDER BY communicated_at DESC, id DESC LIMIT ?',
        (student_id, class_id, term_id, limit),
    ).fetchall()
    timeline.extend({'kind': 'communication', **dict(row)} for row in communications)

    tasks = conn.execute(
        "SELECT id, COALESCE(due_at, created_at) AS at, '待办' AS title, title AS summary, status "
        "FROM student_tasks WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at='' "
        'ORDER BY due_at DESC, id DESC LIMIT ?',
        (student_id, class_id, term_id, limit),
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
    _, _, student_name = _student_identity(student_id)
    date_from, date_to = str(date_from or '')[:10], str(date_to or '')[:10]
    limit = max(1, min(int(limit), 100))
    records = attendance.list_records(
        student_id=student_id, date_from=date_from, date_to=date_to,
        limit=max(limit, 100))
    summary: dict[str, int] = {}
    for row in records:
        summary[row['status']] = summary.get(row['status'], 0) + 1
    return {
        'student': {'id': student_id, '姓名': student_name} if student_id else None,
        'date_from': date_from,
        'date_to': date_to,
        'summary': summary,
        'records': [{
            'date': row['attendance_date'], 'scene': row['scene'],
            'student_name': row['student_name'], 'status': row['status'],
            'reason': row['reason'], 'note': row['note'],
        } for row in records[:limit]],
    }


def get_scores_summary(
    student_id: int | None = None,
    exam_name: str = '',
    limit: int = 20,
) -> dict:
    """查询全班或指定学生的考试成绩汇总。"""
    _, _, student_name = _student_identity(student_id)
    limit = max(1, min(int(limit), 100))
    data = scores.score_summary(student_id=student_id)
    exams = []
    query = str(exam_name or '').strip()
    for student in data['students']:
        for exam in reversed(student['exams']):
            if query and query not in exam['exam_name']:
                continue
            if not exam['has_any']:
                continue
            exams.append({
                'student_id': student['student_id'], 'student_name': student['姓名'],
                'exam_name': exam['exam_name'], 'exam_date': exam['exam_date'],
                'subjects': {name: item['score'] if item['status'] == '正常' else item['status']
                             for name, item in exam['subjects'].items()},
                'total': exam['total'], 'rank': exam['rank'],
                'complete': exam['complete'], 'missing_subjects': exam['missing_subjects'],
                'total_change': exam['total_change'], 'rank_change': exam['rank_change'],
            })
            if len(exams) >= limit:
                break
        if len(exams) >= limit:
            break
    return {'student': {'id': student_id, '姓名': student_name} if student_id else None, 'exams': exams}


def get_tasks_list(
    status: str = '',
    student_id: int | None = None,
    limit: int = 20,
) -> dict:
    """查询统一工作项，默认返回当前班级和学期的未关闭事项。"""
    student_id_value, _, student_name = _student_identity(student_id)
    limit = max(1, min(int(limit), 100))
    tasks = work_items.list_work_items(
        status=str(status).strip() or None,
        bucket='all' if status else 'open',
        student_id=student_id_value,
        limit=limit,
    )
    return {'student': {'id': student_id, '姓名': student_name} if student_id else None, 'tasks': tasks}


def get_communications_list(
    status: str = '',
    student_id: int | None = None,
    limit: int = 20,
) -> dict:
    """查询家校沟通记录，只返回沟通摘要和跟进信息。"""
    student_id_value, _, student_name = _student_identity(student_id)
    class_id, term_id = scope_ids(conn=db.get_conn())
    limit = max(1, min(int(limit), 100))
    sql = (
        'SELECT c.id, c.student_id, s.姓名 AS student_name, c.communicated_at, '
        'c.method, c.reason, c.summary, c.feedback, c.agreement, c.followup_at, c.status '
        'FROM communications c JOIN students s ON s.id=c.student_id'
    )
    where, params = ['c.class_id=?', 'c.term_id=?', "c.deleted_at=''", "s.deleted_at=''"], [class_id, term_id]
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
