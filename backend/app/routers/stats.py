# -*- coding: utf-8 -*-
"""统计接口：仪表盘 / 考勤 / 成绩 / 积分"""
from fastapi import APIRouter
from datetime import datetime

from .. import db
from ..derived import derive

router = APIRouter(prefix='/api/stats')


@router.get('/dashboard')
def dashboard(date: str | None = None):
    conn = db.get_conn()
    total_students = conn.execute('SELECT COUNT(*) AS n FROM students').fetchone()['n']

    target_date = (date or datetime.now().strftime('%Y-%m-%d'))[:10]
    att_rows = derive('考勤管理', db.get_rows('考勤管理'))
    today_att = {'出勤': 0, '迟到': 0, '请假': 0, '缺勤': 0}
    for r in att_rows:
        row_date = str(r['data'][0] or '')[:10] if r['data'] else ''
        if row_date != target_date:
            continue
        s = str(r['data'][4] or '').strip() if len(r['data']) > 4 else ''
        if s in today_att:
            today_att[s] += 1

    points_rows = derive('日常行为积分', db.get_rows('日常行为积分'))
    top = [{'name': r['data'][1], 'points': int(r['data'][10] or 0)}
           for r in points_rows if r['data'][1]][:5]

    fund_rows = derive('班费管理', db.get_rows('班费管理'))
    balance = 0.0
    for r in fund_rows:
        if len(r['data']) > 6 and r['data'][6] is not None:
            balance = r['data'][6]

    log_rows = db.get_rows('班主任日志')
    logs = [{'date': str(r['data'][0])[:10], 'content': str(r['data'][3])[:50]}
            for r in log_rows if len(r['data']) > 3 and r['data'][0] and r['data'][3]][-5:]

    tasks = [dict(r) for r in conn.execute(
        'SELECT t.id, t.title, t.source, t.due_at, t.priority, t.status, t.student_id, '
        's.姓名 AS student_name FROM student_tasks t LEFT JOIN students s ON s.id=t.student_id '
        'WHERE t.status NOT IN (\'已完成\',\'已取消\') ORDER BY t.due_at, t.id DESC LIMIT 20').fetchall()]
    focus = [dict(r) for r in conn.execute(
        'SELECT f.id, f.student_id, s.姓名 AS student_name, f.topic, f.reason, f.status, f.next_review_at '
        'FROM focus_items f JOIN students s ON s.id=f.student_id WHERE f.status != \'已结束\' '
        'ORDER BY f.next_review_at, f.id DESC LIMIT 20').fetchall()]
    recent_events = [dict(r) for r in conn.execute(
        'SELECT e.id, e.occurred_at, e.event_type, e.description, e.status, e.student_id, s.姓名 AS student_name '
        'FROM student_events e JOIN students s ON s.id=e.student_id ORDER BY e.occurred_at DESC, e.id DESC LIMIT 10').fetchall()]
    pending_communications = [dict(r) for r in conn.execute(
        'SELECT c.id, c.student_id, s.姓名 AS student_name, c.followup_at, c.status, c.summary '
        'FROM communications c JOIN students s ON s.id=c.student_id '
        'WHERE c.followup_at != \'\' AND c.status NOT IN (\'已完成\',\'已解决\') '
        'ORDER BY c.followup_at, c.id DESC LIMIT 20').fetchall()]

    return {'date': target_date,
            'total_students': total_students,
            'today_attendance': today_att,
            'top_points': top,
            'recent_logs': logs,
            'class_fund_balance': balance,
            'tasks': tasks,
            'focus': focus,
            'recent_events': recent_events,
            'pending_communications': pending_communications}


@router.get('/attendance')
def attendance():
    rows = db.get_rows('考勤管理')
    status_count: dict = {}
    date_stats: dict = {}
    for r in rows:
        d = r['data']
        status = str(d[4] or '').strip() if len(d) > 4 else ''
        if status:
            status_count[status] = status_count.get(status, 0) + 1
        date = str(d[0] or '')[:10]
        if date and status:
            day = date_stats.setdefault(date, {'出勤': 0, '迟到': 0, '请假': 0, '缺勤': 0, '总人数': 0})
            if status in day:
                day[status] += 1
            day['总人数'] += 1
    return {'status_count': status_count, 'date_stats': date_stats}


@router.get('/scores')
def scores():
    rows = derive('成绩跟踪', db.get_rows('成绩跟踪'))
    subjects = ['语文', '数学', '英语', '政治', '历史', '地理']
    students = []
    for r in rows:
        d = r['data']
        name = d[1] if len(d) > 1 else None
        if not name:
            continue
        students.append({
            'name': str(name),
            'yuekao1': [d[i] for i in range(2, 8)],
            'yuekao1_total': d[8] if len(d) > 8 else None,
            'rank1': d[9] if len(d) > 9 else None,
            'qizhong': [d[i] for i in range(10, 16)],
            'qizhong_total': d[16] if len(d) > 16 else None,
            'rank2': d[17] if len(d) > 17 else None,
            'change': d[18] if len(d) > 18 else None,
        })

    avg = {'yuekao1': {}, 'qizhong': {}}
    for i, subj in enumerate(subjects):
        def avg_of(key):
            vals = [s[key][i] for s in students
                    if i < len(s[key]) and s[key][i] is not None and isinstance(s[key][i], (int, float))]
            return round(sum(vals) / len(vals), 1) if vals else 0
        avg['yuekao1'][subj] = avg_of('yuekao1')
        avg['qizhong'][subj] = avg_of('qizhong')

    return {'students': students, 'avg_scores': avg, 'subjects': subjects}


@router.get('/points')
def points():
    rows = derive('日常行为积分', db.get_rows('日常行为积分'))
    students = []
    for r in rows:
        d = r['data']
        name = d[1] if len(d) > 1 else None
        if not name:
            continue
        students.append({
            'name': str(name),
            'weekly': [d[i] if i < len(d) and d[i] is not None else 0 for i in range(2, 10)],
            'total': int(d[10] or 0) if len(d) > 10 else 0,
        })
    students.sort(key=lambda x: x['total'], reverse=True)
    return {'students': students}
