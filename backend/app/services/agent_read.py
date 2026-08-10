# -*- coding: utf-8 -*-
"""Agent 第一阶段只读业务服务。

这些函数不依赖 FastAPI 路由，后续可同时被 HTTP、微信和 MCP 适配器调用。
"""
from __future__ import annotations

from typing import Optional

from .. import db
from .class_context import scope_ids
from . import attendance, comment_ai, scores, school_calendar, work_items


STUDENT_QUERY_FIELDS = {
    'student_id': ('s.id', 'id'),
    'student_no': ('s.学号', '学号'),
    'student_name': ('s.姓名', '姓名'),
    'gender': ('s.性别', '性别'),
    'birth_month': ('s.出生年月', '出生年月'),
    'ethnicity': ('s.民族', '民族'),
    'guardian_name': ('s.监护人姓名', '监护人姓名'),
    'guardian_occupation': ('s.监护人职业', '监护人职业'),
    'guardian2_name': ('s.监护人2姓名', '监护人2姓名'),
    'guardian2_relationship': ('s.监护人2关系', '监护人2关系'),
    'is_boarding': ('s.是否住校', '是否住校'),
    'specialty': ('s.特长', '特长'),
    'class_role': ('s.班级任职', '班级任职'),
}
DEFAULT_STUDENT_QUERY_FIELDS = ('student_no', 'student_name', 'gender', 'is_boarding', 'class_role')
MAX_STUDENT_QUERY_LIMIT = 500


def _student_query_fields(fields: list[str] | None) -> list[tuple[str, str, str]]:
    selected = list(fields or DEFAULT_STUDENT_QUERY_FIELDS)
    if not selected:
        selected = list(DEFAULT_STUDENT_QUERY_FIELDS)
    result = []
    seen = set()
    for name in selected:
        name = str(name or '').strip()
        if name not in STUDENT_QUERY_FIELDS:
            raise ValueError(f'不支持的学生字段：{name}')
        if name in seen:
            continue
        seen.add(name)
        expression, label = STUDENT_QUERY_FIELDS[name]
        result.append((name, expression, label))
    if len(result) > 10:
        raise ValueError('一次最多查询 10 个学生字段')
    return result


def _student_query_scope(*, keyword: str, gender: str, boarding_status: str,
                         class_role: str) -> tuple[str, list]:
    class_id, term_id = scope_ids(conn=db.get_conn())
    where = [
        'e.class_id=?', 'e.term_id=?', "e.status='在读'", "s.deleted_at=''",
    ]
    params: list = [class_id, term_id]
    keyword = str(keyword or '').strip()
    if keyword:
        where.append('(s.姓名 LIKE ? OR s.学号 LIKE ?)')
        params.extend((f'%{keyword}%', f'%{keyword}%'))
    if gender:
        where.append('s.性别=?')
        params.append(str(gender).strip())
    if boarding_status:
        where.append('s.是否住校=?')
        params.append(str(boarding_status).strip())
    if class_role:
        where.append('s.班级任职 LIKE ?')
        params.append(f'%{str(class_role).strip()}%')
    return ' AND '.join(where), params


def query_students(
    fields: list[str] | None = None,
    keyword: str = '',
    gender: str = '',
    boarding_status: str = '',
    class_role: str = '',
    limit: int = 100,
) -> dict:
    """按字段白名单批量查询当前班级学生，不返回电话、住址或备注。"""
    selected = _student_query_fields(fields)
    limit = max(1, min(int(limit), MAX_STUDENT_QUERY_LIMIT))
    conn = db.get_conn()
    scope, params = _student_query_scope(
        keyword=keyword, gender=gender, boarding_status=boarding_status, class_role=class_role,
    )
    count = conn.execute(
        'SELECT COUNT(*) AS count FROM students s JOIN student_enrollments e ON e.student_id=s.id '
        f'WHERE {scope}', tuple(params),
    ).fetchone()
    columns = ', '.join(f'{expression} AS "{label}"' for _, expression, label in selected)
    rows = conn.execute(
        'SELECT ' + columns + ' FROM students s JOIN student_enrollments e ON e.student_id=s.id '
        f'WHERE {scope} ORDER BY s.学号, s.id LIMIT ?',
        (*params, limit),
    ).fetchall()
    total = int(count['count'] if count else 0)
    return {
        'fields': [name for name, _, _ in selected],
        'students': [dict(row) for row in rows],
        'count': len(rows),
        'total_count': total,
        'truncated': total > limit,
    }


def aggregate_students(
    group_by: str,
    keyword: str = '',
    gender: str = '',
    boarding_status: str = '',
    class_role: str = '',
    include_empty: bool = False,
    include_students: bool = True,
    limit: int = MAX_STUDENT_QUERY_LIMIT,
) -> dict:
    """按字段白名单聚合当前班级学生，适合职业、住校和性别分布分析。"""
    selected = _student_query_fields([group_by])
    group_field = selected[0][0]
    query = query_students(
        fields=['student_id', 'student_no', 'student_name', group_field],
        keyword=keyword, gender=gender, boarding_status=boarding_status,
        class_role=class_role, limit=limit,
    )
    group_column = STUDENT_QUERY_FIELDS[group_field][1].split('.')[-1]
    groups: dict[str, dict] = {}
    empty_count = 0
    for row in query['students']:
        value = str(row.get(group_column) or '').strip()
        if not value:
            empty_count += 1
            if not include_empty:
                continue
            value = '未填写'
        group = groups.setdefault(value, {'value': value, 'count': 0, 'students': []})
        group['count'] += 1
        if include_students:
            group['students'].append({
                'id': row.get('id'),
                '学号': row.get('学号', ''),
                '姓名': row.get('姓名', ''),
            })
    ordered = sorted(groups.values(), key=lambda item: (-item['count'], item['value']))
    if not include_students:
        for item in ordered:
            item.pop('students', None)
    return {
        'group_by': group_field,
        'groups': ordered,
        'student_count': query['total_count'],
        'included_student_count': query['count'],
        'empty_count': empty_count,
        'truncated': query['truncated'],
    }


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


def get_school_calendar(
    date_from: str = '',
    date_to: str = '',
    day_type: str = '',
    limit: int = 100,
) -> dict:
    """查询当前学期校历，不返回学生敏感信息。"""
    return school_calendar.query_calendar(
        date_from=date_from, date_to=date_to, day_type=day_type, limit=limit)


def get_student_term_comment_context(
    student_ids: list[int] | None = None,
    limit: int = 30,
) -> dict:
    """返回生成学期评语所需的安全事实摘要，不包含家庭电话、住址或沟通原文。"""
    selected = [int(value) for value in (student_ids or [])]
    if not selected:
        raise ValueError('请至少提供一名学生')
    if len(selected) > min(int(limit), 30):
        raise ValueError('一次最多整理30名学生的学期评语事实')
    contexts = comment_ai.build_student_term_contexts(selected)
    return {'period': contexts[0]['period'] if contexts else {}, 'students': contexts}
