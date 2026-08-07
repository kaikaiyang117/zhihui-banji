# -*- coding: utf-8 -*-
"""统计接口：仪表盘 / 考勤 / 成绩 / 积分"""
from fastapi import APIRouter, HTTPException
from datetime import datetime

from .. import db
from ..services import attendance as attendance_service, funds as funds_service, points as points_service, scores as scores_service, work_items
from ..services.class_context import scope_ids

router = APIRouter(prefix='/api/stats')


@router.get('/dashboard')
def dashboard(date: str | None = None):
    conn = db.get_conn()
    class_id, term_id = scope_ids(conn=conn)
    total_students = conn.execute(
        "SELECT COUNT(*) AS n FROM student_enrollments e JOIN students s ON s.id=e.student_id "
        "WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''",
        (class_id, term_id)).fetchone()['n']

    target_date = (date or datetime.now().strftime('%Y-%m-%d'))[:10]
    try:
        reference_date = datetime.strptime(target_date, '%Y-%m-%d').date()
    except ValueError as exc:
        raise HTTPException(400, '日期格式必须为 YYYY-MM-DD') from exc
    today_att = attendance_service.dashboard_counts(target_date, conn=conn)

    point_summary = points_service.class_summary(reference_date=target_date, conn=conn)
    top = [{'name': item['name'], 'points': item['total']}
           for item in point_summary['students'] if item['entry_count']][:5]

    fund_summary = funds_service.class_summary(reference_date=target_date, conn=conn)
    balance = fund_summary['totals']['balance']

    log_rows = db.get_rows('班主任日志')
    logs = [{'date': str(r['data'][0])[:10], 'content': str(r['data'][3])[:50]}
            for r in log_rows if len(r['data']) > 3 and r['data'][0] and r['data'][3]][-5:]

    work_summary = work_items.work_item_summary(
        reference_date=reference_date, conn=conn)
    work_sections = {
        bucket: work_items.list_work_items(
            bucket=bucket, reference_date=reference_date, limit=8, conn=conn)
        for bucket in ('overdue', 'today', 'next7')
    }
    tasks = work_items.list_work_items(
        bucket='open', reference_date=reference_date, limit=20, conn=conn)
    all_rule_hits = work_items.list_work_items(
        bucket='open', source_type='attendance_rule',
        reference_date=reference_date, limit=1_000_000, conn=conn)
    rule_hits = all_rule_hits[:8]
    focus = [dict(r) for r in conn.execute(
        'SELECT f.id, f.student_id, s.姓名 AS student_name, f.topic, f.reason, f.status, f.next_review_at '
        'FROM focus_items f JOIN students s ON s.id=f.student_id '
        "WHERE f.class_id=? AND f.term_id=? AND f.deleted_at='' AND s.deleted_at='' AND f.status != '已结束' "
        'ORDER BY f.next_review_at, f.id DESC LIMIT 20', (class_id, term_id)).fetchall()]
    recent_events = [dict(r) for r in conn.execute(
        'SELECT e.id, e.occurred_at, e.event_type, e.description, e.status, e.student_id, s.姓名 AS student_name '
        'FROM student_events e JOIN students s ON s.id=e.student_id '
        "WHERE e.class_id=? AND e.term_id=? AND e.deleted_at='' AND s.deleted_at='' ORDER BY e.occurred_at DESC, e.id DESC LIMIT 10",
        (class_id, term_id)).fetchall()]
    pending_communications = [dict(r) for r in conn.execute(
        'SELECT c.id, c.student_id, s.姓名 AS student_name, c.followup_at, c.status, c.summary '
        'FROM communications c JOIN students s ON s.id=c.student_id '
        "WHERE c.class_id=? AND c.term_id=? AND c.deleted_at='' AND s.deleted_at='' AND c.followup_at != '' "
        'AND c.status NOT IN (\'已完成\',\'已解决\') '
        'ORDER BY c.followup_at, c.id DESC LIMIT 20', (class_id, term_id)).fetchall()]

    material_tasks = []
    for row in conn.execute(
        '''SELECT ct.id, ct.title, ct.task_type, ct.material_name, ct.due_at, ct.status,
                  COUNT(i.id) AS total,
                  SUM(CASE WHEN i.status='已提交' THEN 1 ELSE 0 END) AS submitted
           FROM class_tasks ct
           LEFT JOIN class_task_items i ON i.task_id=ct.id
           WHERE ct.class_id=? AND ct.term_id=? AND ct.deleted_at=''
             AND ct.status NOT IN ('已完成','已取消')
           GROUP BY ct.id
           ORDER BY CASE WHEN ct.due_at='' THEN 1 ELSE 0 END, ct.due_at, ct.id DESC
           ''',
        (class_id, term_id),
    ).fetchall():
        item = dict(row)
        item['submitted'] = int(item['submitted'] or 0)
        item['total'] = int(item['total'] or 0)
        item['progress'] = round(
            item['submitted'] * 100 / item['total']) if item['total'] else 0
        material_tasks.append(item)

    review_students = [dict(row) for row in conn.execute(
        '''SELECT f.id, f.student_id, s.姓名 AS student_name, f.topic, f.reason,
                  f.status, f.next_review_at
           FROM focus_items f
           JOIN students s ON s.id=f.student_id
           WHERE f.class_id=? AND f.term_id=? AND f.deleted_at='' AND s.deleted_at=''
             AND f.status<>'已结束' AND f.next_review_at<>''
             AND substr(f.next_review_at,1,10)<=?
           ORDER BY f.next_review_at, f.id DESC''',
        (class_id, term_id, target_date),
    ).fetchall()]

    return {'date': target_date,
            'total_students': total_students,
            'today_attendance': today_att,
            'top_points': top,
            'recent_logs': logs,
            'class_fund_balance': balance,
            'work_summary': work_summary,
            'work_sections': work_sections,
            'tasks': tasks,
            'rule_hits': rule_hits,
            'rule_hit_count': len(all_rule_hits),
            'material_tasks': material_tasks[:8],
            'material_task_count': len(material_tasks),
            'review_students': review_students[:8],
            'review_student_count': len(review_students),
            'focus': focus,
            'recent_events': recent_events,
            'pending_communications': pending_communications}


@router.get('/attendance')
def attendance(date_from: str = '', date_to: str = '', scene: str = '全部场景'):
    try:
        return attendance_service.attendance_stats(
            date_from=date_from, date_to=date_to, scene=scene)
    except attendance_service.AttendanceError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/scores')
def scores():
    return scores_service.score_summary()


@router.get('/points')
def points():
    return points_service.class_summary()


@router.get('/fund')
def fund():
    return funds_service.class_summary()
