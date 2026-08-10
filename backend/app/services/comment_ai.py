# -*- coding: utf-8 -*-
"""为学期评语准备安全的学生事实摘要。"""
from __future__ import annotations

from collections import Counter, defaultdict

from .. import clock, db
from . import attendance, class_context, points, scores, work_items


class CommentAIError(ValueError):
    pass


def _text(value) -> str:
    return str(value or '').strip()


def _clip(value, limit=120) -> str:
    text = _text(value)
    return text if len(text) <= limit else text[:limit - 1] + '…'


def _period(scope: dict) -> tuple[str, str]:
    return (
        (_text(scope.get('start_date')) or f'{clock.today().year}-01-01')[:10],
        (_text(scope.get('end_date')) or clock.today().isoformat())[:10],
    )


def _active_students(conn, class_id: int, term_id: int, student_ids: list[int] | None = None) -> list[dict]:
    rows = [dict(row) for row in conn.execute(
        '''SELECT s.id, s.学号, s.姓名, s.特长, s.班级任职
           FROM students s JOIN student_enrollments e ON e.student_id=s.id
           WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
           ORDER BY s.学号, s.id''', (class_id, term_id)
    ).fetchall()]
    requested = {int(value) for value in (student_ids or [])}
    if not requested:
        return rows
    found = {int(row['id']) for row in rows}
    if not requested.issubset(found):
        raise CommentAIError('选择的学生中有不在当前班级或学期的记录')
    return [row for row in rows if int(row['id']) in requested]


def _score_facts(student_id: int, start: str, end: str, conn) -> tuple[dict, list[dict]]:
    records = scores.list_records(student_id=student_id, conn=conn)
    records = [row for row in records if not row.get('exam_date') or start <= str(row.get('exam_date'))[:10] <= end]
    by_subject: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for row in records:
        try:
            value = float(row['score'])
        except (TypeError, ValueError):
            continue
        by_subject[_text(row.get('subject'))].append((str(row.get('exam_date') or ''), value))
    changes = []
    for subject, values in by_subject.items():
        values.sort(key=lambda item: item[0])
        if len(values) >= 2:
            changes.append({'subject': subject, 'delta': round(values[-1][1] - values[0][1], 1)})
    refs = ([{'source': '成绩', 'record_ids': [int(row['id']) for row in records[:20]],
              'detail': f'{len(records)}条学期成绩记录'}] if records else [])
    return {
        'record_count': len(records),
        'exam_count': len({str(row.get('exam_name') or '') for row in records}),
        'subject_changes': sorted(changes, key=lambda item: abs(item['delta']), reverse=True)[:8],
        'recent_scores': [
            {'exam': _text(row.get('exam_name')), 'subject': _text(row.get('subject')),
             'score': row.get('score'), 'status': _text(row.get('record_status'))}
            for row in records[-20:]
        ],
    }, refs


def _attendance_facts(student_id: int, start: str, end: str, conn) -> tuple[dict, list[dict]]:
    records = attendance.list_records(student_id=student_id, date_from=start, date_to=end, limit=5000, conn=conn)
    counts = Counter(_text(row.get('status')) for row in records)
    anomalies = [row for row in records if row.get('status') not in {'', '出勤'}]
    refs = ([{'source': '考勤', 'record_ids': [int(row['id']) for row in anomalies[:12]],
              'detail': f'{len(anomalies)}次异常考勤'}] if anomalies else [])
    return {
        'record_count': len(records), 'status_counts': dict(counts),
        'anomaly_count': len(anomalies),
        'recent_anomalies': [
            {'date': _text(row.get('attendance_date')), 'status': _text(row.get('status')),
             'reason': _clip(row.get('reason'), 80)} for row in anomalies[:6]
        ],
    }, refs


def _point_facts(student_id: int, start: str, end: str, conn) -> tuple[dict, list[dict]]:
    records = points.list_entries(student_id=student_id, date_from=start, date_to=end, limit=5000, conn=conn)
    records = [row for row in records if row.get('status') == '有效']
    categories: dict[str, dict] = {}
    for row in records:
        category = _text(row.get('category')) or '未分类'
        bucket = categories.setdefault(category, {'count': 0, 'positive': 0, 'negative': 0})
        bucket['count'] += 1
        bucket['positive' if float(row.get('amount') or 0) > 0 else 'negative'] += 1
    refs = ([{'source': '行为积分', 'record_ids': [int(row['id']) for row in records[:12]],
              'detail': f'{len(records)}条有效行为记录，不用于计算奖学金总分'}] if records else [])
    return {
        'record_count': len(records), 'categories': categories,
        'recent_reasons': [_clip(row.get('reason'), 80) for row in records[:6] if row.get('reason')],
    }, refs


def _process_facts(student_id: int, class_id: int, term_id: int, start: str, end: str, conn) -> tuple[dict, list[dict]]:
    work = work_items.list_work_items(student_id=student_id, date_from=start, date_to=end, limit=200, conn=conn)
    events = [dict(row) for row in conn.execute(
        '''SELECT id, occurred_at, event_type, description, status FROM student_events
           WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at=''
             AND substr(occurred_at,1,10) BETWEEN ? AND ?
           ORDER BY occurred_at DESC, id DESC LIMIT 20''',
        (student_id, class_id, term_id, start, end),
    ).fetchall()]
    focus = [dict(row) for row in conn.execute(
        '''SELECT id, topic, status, conclusion FROM focus_items
           WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at=''
             AND (conclusion<>'' OR status IN ('情况改善','已结束'))
           ORDER BY updated_at DESC, id DESC LIMIT 8''',
        (student_id, class_id, term_id),
    ).fetchall()]
    refs = []
    if events:
        refs.append({'source': '学生事件', 'record_ids': [int(row['id']) for row in events], 'detail': f'{len(events)}条学期事件'})
    if focus:
        refs.append({'source': '关注事项', 'record_ids': [int(row['id']) for row in focus], 'detail': f'{len(focus)}条已形成结论的关注事项'})
    if work:
        refs.append({'source': '待办跟进', 'record_ids': [int(row['id']) for row in work[:12]], 'detail': f'{len(work)}条跟进工作项'})
    return {
        'work_items': {
            'total': len(work), 'completed': sum(1 for row in work if row.get('status') == '已完成'),
            'open': sum(1 for row in work if row.get('status') not in {'已完成', '已取消'}),
        },
        'events': [
            {'date': _text(row.get('occurred_at'))[:10], 'type': _text(row.get('event_type')),
             'description': _clip(row.get('description')), 'status': _text(row.get('status'))}
            for row in events[:8]
        ],
        'followups': [
            {'topic': _clip(row.get('topic'), 60), 'status': _text(row.get('status')),
             'conclusion': _clip(row.get('conclusion'), 100)} for row in focus
        ],
    }, refs


def build_student_term_context(student_id: int, *, conn=None) -> dict:
    conn = conn or db.get_conn()
    scope = class_context.get_current_scope(conn=conn)
    class_id, term_id = int(scope['class_id']), int(scope['term_id'])
    student = next(iter(_active_students(conn, class_id, term_id, [student_id])), None)
    if not student:
        raise CommentAIError('学生不存在或不在当前班级/学期')
    start, end = _period(scope)
    score_data, score_refs = _score_facts(student_id, start, end, conn)
    attendance_data, attendance_refs = _attendance_facts(student_id, start, end, conn)
    point_data, point_refs = _point_facts(student_id, start, end, conn)
    process_data, process_refs = _process_facts(student_id, class_id, term_id, start, end, conn)
    evidence = score_refs + attendance_refs + point_refs + process_refs
    available = []
    if score_data['record_count']:
        available.append('成绩')
    if attendance_data['anomaly_count']:
        available.append('异常考勤')
    if point_data['record_count']:
        available.append('行为记录')
    if process_data['events'] or process_data['followups']:
        available.append('过程记录')
    return {
        'student_id': int(student['id']), '学号': _text(student.get('学号')), '姓名': _text(student.get('姓名')),
        'profile': {'特长': _clip(student.get('特长'), 80), '班级任职': _clip(student.get('班级任职'), 80)},
        'period': {'start': start, 'end': end, 'term': _text(scope.get('term_name'))},
        'facts': {'成绩': score_data, '考勤': attendance_data, '行为记录': point_data, '过程记录': process_data},
        'evidence': evidence, 'coverage': {'available_sources': available, 'source_count': len(evidence)},
    }


def build_student_term_contexts(student_ids: list[int] | None = None, *, conn=None) -> list[dict]:
    conn = conn or db.get_conn()
    scope = class_context.get_current_scope(conn=conn)
    students = _active_students(conn, int(scope['class_id']), int(scope['term_id']), student_ids)
    return [build_student_term_context(int(row['id']), conn=conn) for row in students]
