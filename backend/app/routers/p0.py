# -*- coding: utf-8 -*-
"""P0 核心工作流：学生全景、事件、待办、关注、沟通与批量考勤。"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import db

router = APIRouter(prefix='/api')

EVENT_STATUSES = {'待处理', '处理中', '待复查', '已完成', '无需处理'}
TASK_STATUSES = {'待处理', '处理中', '待复查', '已完成', '已取消'}
FOCUS_STATUSES = {'待确认', '跟进中', '情况改善', '已结束'}
ATTENDANCE_STATUSES = {'出勤', '迟到', '请假', '早退', '缺勤'}


def _now() -> str:
    return datetime.now().strftime('%Y-%m-%d %H:%M')


def _student(student_id: int) -> dict:
    row = db.get_conn().execute(
        'SELECT id, 学号, 姓名, 性别, 出生年月, 民族, 家庭住址, 监护人姓名, 监护人电话, '
        '监护人职业, 是否住校, 特长, 班级任职, 备注, 监护人2姓名, 监护人2电话, 监护人2关系 '
        'FROM students WHERE id=?', (student_id,)).fetchone()
    if not row:
        raise HTTPException(404, '学生不存在')
    return dict(row)


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    return [dict(row) for row in db.get_conn().execute(sql, params).fetchall()]


def migrate_legacy_core_rows():
    """首次启动时把已有的沟通、谈心和特殊档案接入 P0 结构化记录。"""
    conn = db.get_conn()
    if conn.execute('SELECT 1 FROM app_flags WHERE key=?', ('p0_legacy_migrated',)).fetchone():
        return

    source_count = 0
    students = {str(row['姓名']).strip(): row['id'] for row in conn.execute('SELECT id, 姓名 FROM students').fetchall()}
    for row in db.get_rows('家校沟通记录'):
        data = row['data']
        name = str(data[1] or '').strip() if len(data) > 1 else ''
        student_id = students.get(name)
        if not student_id:
            continue
        source_count += 1
        conn.execute(
            'INSERT INTO communications(student_id, communicated_at, method, reason, summary, feedback, agreement, status) '
            'VALUES(?,?,?,?,?,?,?,?)',
            (student_id, str(data[0] or ''), str(data[2] or ''), str(data[3] or ''), str(data[4] or ''),
             str(data[5] or ''), str(data[6] or ''), str(data[7] or '已完成')))

    for row in db.get_rows('谈心记录'):
        data = row['data']
        name = str(data[1] or '').strip() if len(data) > 1 else ''
        student_id = students.get(name)
        if not student_id:
            continue
        source_count += 1
        next_review = str(data[7] or '') if len(data) > 7 else ''
        conn.execute(
            'INSERT INTO student_events(student_id, occurred_at, event_type, description, handling, needs_followup, '
            'followup_due, status) VALUES(?,?,?,?,?,?,?,?)',
            (student_id, str(data[0] or ''), '谈心记录', str(data[4] or data[2] or ''),
             str(data[6] or ''), int(bool(next_review)), next_review, '待复查' if next_review else '已完成'))

    for row in db.get_rows('特殊学生档案'):
        data = row['data']
        name = str(data[1] or '').strip() if len(data) > 1 else ''
        student_id = students.get(name)
        if not student_id:
            continue
        source_count += 1
        old_status = str(data[6] or '') if len(data) > 6 else ''
        status = '已结束' if '结束' in old_status else '跟进中' if '跟进' in old_status else '待确认'
        conn.execute(
            'INSERT INTO focus_items(student_id, topic, reason, evidence, action_plan, status, next_review_at) '
            'VALUES(?,?,?,?,?,?,?)',
            (student_id, str(data[2] or '未分类'), str(data[3] or ''), str(data[4] or ''),
             str(data[5] or ''), status, str(data[7] or '')))

    if source_count:
        conn.execute('INSERT INTO app_flags(key, value) VALUES(?, ?)',
                     ('p0_legacy_migrated', f'{source_count} rows'))
        conn.commit()


class EventBody(BaseModel):
    student_id: int
    occurred_at: str = Field(min_length=1)
    event_type: str = Field(min_length=1)
    description: str = Field(min_length=1)
    handling: str = ''
    parent_contacted: bool = False
    needs_followup: bool = False
    followup_due: str = ''
    status: str = '已完成'


class TaskBody(BaseModel):
    title: str = Field(min_length=1)
    student_id: Optional[int] = None
    event_id: Optional[int] = None
    source: str = '手动创建'
    due_at: str = ''
    priority: str = '普通'
    status: str = '待处理'
    notes: str = ''


class TaskUpdate(BaseModel):
    status: str
    notes: Optional[str] = None


class FocusBody(BaseModel):
    student_id: int
    topic: str = Field(min_length=1)
    reason: str = Field(min_length=1)
    evidence: str = ''
    action_plan: str = ''
    status: str = '待确认'
    next_review_at: str = ''


class FocusUpdate(BaseModel):
    status: str
    conclusion: str = ''
    next_review_at: str = ''


class CommunicationBody(BaseModel):
    student_id: int
    communicated_at: str = Field(min_length=1)
    method: str = Field(min_length=1)
    reason: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    feedback: str = ''
    agreement: str = ''
    followup_at: str = ''
    status: str = '已完成'
    event_id: Optional[int] = None


class AttendanceRecord(BaseModel):
    student_id: int
    status: str = '出勤'
    reason: str = ''
    arrive: str = ''
    leave: str = ''
    note: str = ''


class DailyAttendanceBody(BaseModel):
    date: str = Field(min_length=10)
    records: list[AttendanceRecord]


@router.get('/students/{student_id}/detail')
def student_detail(student_id: int):
    student = _student(student_id)
    events = _rows(
        'SELECT e.*, s.姓名 AS student_name FROM student_events e '
        'JOIN students s ON s.id=e.student_id WHERE e.student_id=? ORDER BY e.occurred_at DESC, e.id DESC',
        (student_id,))
    tasks = _rows(
        'SELECT t.*, s.姓名 AS student_name FROM student_tasks t '
        'LEFT JOIN students s ON s.id=t.student_id WHERE t.student_id=? '
        'ORDER BY CASE WHEN t.status IN (\'已完成\',\'已取消\') THEN 1 ELSE 0 END, t.due_at, t.id DESC',
        (student_id,))
    focus = _rows(
        'SELECT * FROM focus_items WHERE student_id=? ORDER BY '
        'CASE WHEN status=\'已结束\' THEN 1 ELSE 0 END, next_review_at, id DESC',
        (student_id,))
    communications = _rows(
        'SELECT c.*, s.姓名 AS student_name FROM communications c '
        'JOIN students s ON s.id=c.student_id WHERE c.student_id=? '
        'ORDER BY c.communicated_at DESC, c.id DESC', (student_id,))

    attendance = []
    xh = str(student.get('学号') or '').strip()
    for row in db.get_rows('考勤管理'):
        data = row['data']
        if len(data) > 3 and str(data[2] or '').strip() == xh:
            attendance.append({
                'row_no': row['row_no'], 'date': data[0] if len(data) > 0 else '',
                'status': data[4] if len(data) > 4 else '',
                'reason': data[5] if len(data) > 5 else '',
                'arrive': data[6] if len(data) > 6 else '',
                'leave': data[7] if len(data) > 7 else '',
                'note': data[8] if len(data) > 8 else '',
            })
    attendance.sort(key=lambda x: str(x['date']), reverse=True)

    score_rows = _rows(
        'SELECT exam_name, exam_date, subject, score, rank FROM exam_records '
        'WHERE student_id=? ORDER BY exam_date, exam_name, subject', (student_id,))
    score_exams = {}
    for row in score_rows:
        key = (row['exam_name'], row['exam_date'])
        exam = score_exams.setdefault(key, {'exam_name': row['exam_name'], 'exam_date': row['exam_date'], 'subjects': {}, 'total': 0})
        exam['subjects'][row['subject']] = row['score']
        if row['score'] is not None:
            exam['total'] += row['score']
    score_summary = {'exams': list(score_exams.values()), 'subjects': sorted({row['subject'] for row in score_rows})}

    points_summary = {'total': 0, 'weekly': [], 'updated_at': ''}
    for row in db.get_rows('日常行为积分'):
        data = row['data']
        if len(data) > 0 and str(data[0] or '').strip() == xh:
            weekly = [data[i] if i < len(data) and isinstance(data[i], (int, float)) else 0 for i in range(2, 10)]
            points_summary = {'total': data[10] if len(data) > 10 and isinstance(data[10], (int, float)) else sum(weekly),
                              'weekly': weekly, 'updated_at': row.get('updated_at', '')}
            break

    timeline = []
    for row in events:
        timeline.append({'kind': 'event', 'id': row['id'], 'at': row['occurred_at'],
                         'title': row['event_type'], 'summary': row['description'],
                         'status': row['status']})
    for row in communications:
        timeline.append({'kind': 'communication', 'id': row['id'], 'at': row['communicated_at'],
                         'title': f"家校沟通 · {row['method']}", 'summary': row['summary'],
                         'status': row['status']})
    for row in attendance:
        timeline.append({'kind': 'attendance', 'id': row['row_no'], 'at': row['date'],
                         'title': f"考勤 · {row['status']}", 'summary': row['reason'] or '无备注',
                         'status': row['status']})
    for row in focus:
        timeline.append({'kind': 'focus', 'id': row['id'], 'at': row['started_at'],
                         'title': f"关注 · {row['topic']}", 'summary': row['reason'],
                         'status': row['status']})
    timeline.sort(key=lambda x: str(x['at'] or ''), reverse=True)

    return {'student': student, 'events': events, 'tasks': tasks, 'focus': focus,
            'communications': communications, 'attendance': attendance,
            'score_summary': score_summary, 'points_summary': points_summary,
            'timeline': timeline}


@router.post('/events')
def create_event(body: EventBody):
    _student(body.student_id)
    if body.status not in EVENT_STATUSES:
        raise HTTPException(400, '事件状态不合法')
    conn = db.get_conn()
    cur = conn.execute(
        'INSERT INTO student_events(student_id, occurred_at, event_type, description, handling, '
        'parent_contacted, needs_followup, followup_due, status) VALUES(?,?,?,?,?,?,?,?,?)',
        (body.student_id, body.occurred_at, body.event_type, body.description, body.handling,
         int(body.parent_contacted), int(body.needs_followup), body.followup_due, body.status))
    event_id = cur.lastrowid
    task_id = None
    if body.needs_followup:
        if not body.followup_due:
            raise HTTPException(400, '需要跟进时必须填写跟进日期')
        task = conn.execute(
            'INSERT INTO student_tasks(student_id, event_id, title, source, due_at, priority, status, notes) '
            'VALUES(?,?,?,?,?,?,?,?)',
            (body.student_id, event_id, f'{body.event_type} · 跟进', '学生事件', body.followup_due,
             '重要', '待复查', body.description)).lastrowid
        task_id = task
    conn.commit()
    return {'ok': True, 'event_id': event_id, 'task_id': task_id}


@router.get('/events')
def list_events(student_id: Optional[int] = None, status: Optional[str] = None, limit: int = Query(100, ge=1, le=500)):
    sql = 'SELECT e.*, s.姓名 AS student_name FROM student_events e JOIN students s ON s.id=e.student_id'
    where, params = [], []
    if student_id:
        where.append('e.student_id=?')
        params.append(student_id)
    if status:
        where.append('e.status=?')
        params.append(status)
    if where:
        sql += ' WHERE ' + ' AND '.join(where)
    sql += ' ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?'
    params.append(limit)
    return {'events': _rows(sql, tuple(params))}


@router.post('/tasks')
def create_task(body: TaskBody):
    if body.student_id:
        _student(body.student_id)
    if body.status not in TASK_STATUSES:
        raise HTTPException(400, '待办状态不合法')
    if body.priority not in {'普通', '重要', '紧急'}:
        raise HTTPException(400, '优先级不合法')
    conn = db.get_conn()
    task_id = conn.execute(
        'INSERT INTO student_tasks(student_id, event_id, title, source, due_at, priority, status, notes) '
        'VALUES(?,?,?,?,?,?,?,?)',
        (body.student_id, body.event_id, body.title, body.source, body.due_at, body.priority,
         body.status, body.notes)).lastrowid
    conn.commit()
    return {'ok': True, 'task_id': task_id}


@router.get('/tasks')
def list_tasks(status: Optional[str] = None, student_id: Optional[int] = None, limit: int = Query(100, ge=1, le=500)):
    sql = 'SELECT t.*, s.姓名 AS student_name FROM student_tasks t LEFT JOIN students s ON s.id=t.student_id'
    where, params = [], []
    if status:
        where.append('t.status=?')
        params.append(status)
    if student_id:
        where.append('t.student_id=?')
        params.append(student_id)
    if where:
        sql += ' WHERE ' + ' AND '.join(where)
    sql += ' ORDER BY CASE WHEN t.status IN (\'已完成\',\'已取消\') THEN 1 ELSE 0 END, '
    sql += 'CASE t.priority WHEN \'紧急\' THEN 0 WHEN \'重要\' THEN 1 ELSE 2 END, t.due_at, t.id DESC LIMIT ?'
    params.append(limit)
    return {'tasks': _rows(sql, tuple(params))}


@router.put('/tasks/{task_id}')
def update_task(task_id: int, body: TaskUpdate):
    if body.status not in TASK_STATUSES:
        raise HTTPException(400, '待办状态不合法')
    conn = db.get_conn()
    exists = conn.execute('SELECT id FROM student_tasks WHERE id=?', (task_id,)).fetchone()
    if not exists:
        raise HTTPException(404, '待办不存在')
    completed_at = _now() if body.status == '已完成' else ''
    if body.notes is None:
        conn.execute('UPDATE student_tasks SET status=?, completed_at=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?',
                     (body.status, completed_at, task_id))
    else:
        conn.execute('UPDATE student_tasks SET status=?, notes=?, completed_at=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?',
                     (body.status, body.notes, completed_at, task_id))
    conn.commit()
    return {'ok': True}


@router.post('/focus')
def create_focus(body: FocusBody):
    _student(body.student_id)
    if body.status not in FOCUS_STATUSES:
        raise HTTPException(400, '关注状态不合法')
    conn = db.get_conn()
    focus_id = conn.execute(
        'INSERT INTO focus_items(student_id, topic, reason, evidence, action_plan, status, next_review_at) '
        'VALUES(?,?,?,?,?,?,?)',
        (body.student_id, body.topic, body.reason, body.evidence, body.action_plan,
         body.status, body.next_review_at)).lastrowid
    conn.commit()
    return {'ok': True, 'focus_id': focus_id}


@router.get('/focus')
def list_focus(status: Optional[str] = None, limit: int = Query(100, ge=1, le=500)):
    sql = 'SELECT f.*, s.姓名 AS student_name FROM focus_items f JOIN students s ON s.id=f.student_id'
    params = []
    if status:
        sql += ' WHERE f.status=?'
        params.append(status)
    sql += ' ORDER BY CASE WHEN f.status=\'已结束\' THEN 1 ELSE 0 END, f.next_review_at, f.id DESC LIMIT ?'
    params.append(limit)
    return {'focus': _rows(sql, tuple(params))}


@router.put('/focus/{focus_id}')
def update_focus(focus_id: int, body: FocusUpdate):
    if body.status not in FOCUS_STATUSES:
        raise HTTPException(400, '关注状态不合法')
    conn = db.get_conn()
    exists = conn.execute('SELECT id FROM focus_items WHERE id=?', (focus_id,)).fetchone()
    if not exists:
        raise HTTPException(404, '关注事项不存在')
    ended_at = _now() if body.status == '已结束' else ''
    conn.execute(
        'UPDATE focus_items SET status=?, conclusion=?, next_review_at=?, ended_at=?, '
        'updated_at=datetime(\'now\',\'localtime\') WHERE id=?',
        (body.status, body.conclusion, body.next_review_at, ended_at, focus_id))
    conn.commit()
    return {'ok': True}


@router.post('/communications')
def create_communication(body: CommunicationBody):
    _student(body.student_id)
    conn = db.get_conn()
    communication_id = conn.execute(
        'INSERT INTO communications(student_id, communicated_at, method, reason, summary, feedback, '
        'agreement, followup_at, status, event_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
        (body.student_id, body.communicated_at, body.method, body.reason, body.summary, body.feedback,
         body.agreement, body.followup_at, body.status, body.event_id)).lastrowid
    task_id = None
    if body.followup_at:
        task_id = conn.execute(
            'INSERT INTO student_tasks(student_id, title, source, due_at, priority, status, notes) '
            'VALUES(?,?,?,?,?,?,?)',
            (body.student_id, '家校沟通回访', '家校沟通', body.followup_at, '重要', '待复查', body.agreement or body.summary)).lastrowid
    conn.commit()
    return {'ok': True, 'communication_id': communication_id, 'task_id': task_id}


@router.get('/communications')
def list_communications(status: Optional[str] = None, limit: int = Query(100, ge=1, le=500)):
    sql = 'SELECT c.*, s.姓名 AS student_name FROM communications c JOIN students s ON s.id=c.student_id'
    params = []
    if status:
        sql += ' WHERE c.status=?'
        params.append(status)
    sql += ' ORDER BY c.communicated_at DESC, c.id DESC LIMIT ?'
    params.append(limit)
    return {'communications': _rows(sql, tuple(params))}


@router.post('/attendance/daily')
def save_daily_attendance(body: DailyAttendanceBody):
    try:
        date_obj = datetime.strptime(body.date[:10], '%Y-%m-%d')
    except ValueError:
        raise HTTPException(400, '日期格式必须为 YYYY-MM-DD')
    if not body.records:
        raise HTTPException(400, '至少提交一名学生的考勤')

    conn = db.get_conn()
    students = {row['id']: dict(row) for row in conn.execute('SELECT id, 学号, 姓名 FROM students').fetchall()}
    existing = db.get_rows('考勤管理')
    existing_by_xh = {}
    for row in existing:
        data = row['data']
        if len(data) > 2 and str(data[0] or '')[:10] == body.date[:10]:
            existing_by_xh[str(data[2] or '').strip()] = row

    saved = 0
    for record in body.records:
        student = students.get(record.student_id)
        if not student:
            raise HTTPException(400, f'学生 {record.student_id} 不存在')
        if record.status not in ATTENDANCE_STATUSES:
            raise HTTPException(400, f'考勤状态不合法：{record.status}')
        xh = str(student['学号'] or '').strip()
        data = [body.date[:10], ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][date_obj.weekday()],
                xh, student['姓名'], record.status, record.reason, record.arrive, record.leave, record.note]
        old = existing_by_xh.get(xh)
        if old:
            db.replace_row('考勤管理', old['row_no'], data)
        else:
            db.insert_row('考勤管理', data)
        saved += 1
    return {'ok': True, 'date': body.date[:10], 'saved': saved}
