# -*- coding: utf-8 -*-
"""P0 核心工作流：学生全景、事件、待办、关注、沟通与批量考勤。"""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import db
from ..services import (
    attendance as attendance_service,
    class_context,
    class_tasks as class_tasks_service,
    points as points_service,
    scores as scores_service,
    work_items,
)

router = APIRouter(prefix='/api')

EVENT_STATUSES = {'待处理', '处理中', '待复查', '已完成', '无需处理'}
FOCUS_STATUSES = {'待确认', '跟进中', '情况改善', '已结束'}
COMMUNICATION_STATUSES = {'待回访', '进行中', '已完成', '无需回访'}


def _scope(write: bool = False) -> tuple[int, int]:
    return class_context.scope_ids(write=write, conn=db.get_conn())


def _student(student_id: int, write: bool = False) -> dict:
    try:
        return class_context.ensure_student_in_scope(
            student_id, write=write, conn=db.get_conn())
    except class_context.ArchivedScopeError:
        raise
    except class_context.ScopeError as exc:
        raise HTTPException(404, str(exc)) from exc


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    return [dict(row) for row in db.get_conn().execute(sql, params).fetchall()]


def migrate_legacy_core_rows():
    """首次启动时把已有的沟通、谈心和特殊档案接入 P0 结构化记录。"""
    conn = db.get_conn()
    if conn.execute('SELECT 1 FROM app_flags WHERE key=?', ('p0_legacy_migrated',)).fetchone():
        return
    class_id, term_id = _scope(write=True)

    source_count = 0
    students = {str(row['姓名']).strip(): row['id'] for row in conn.execute(
        "SELECT id, 姓名 FROM students WHERE deleted_at=''").fetchall()}
    for row in db.get_rows('家校沟通记录'):
        data = row['data']
        name = str(data[1] or '').strip() if len(data) > 1 else ''
        student_id = students.get(name)
        if not student_id:
            continue
        source_count += 1
        conn.execute(
            'INSERT INTO communications(student_id, communicated_at, method, reason, summary, feedback, agreement, status, class_id, term_id) '
            'VALUES(?,?,?,?,?,?,?,?,?,?)',
            (student_id, str(data[0] or ''), str(data[2] or ''), str(data[3] or ''), str(data[4] or ''),
             str(data[5] or ''), str(data[6] or ''), str(data[7] or '已完成'), class_id, term_id))

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
            'followup_due, status, class_id, term_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
            (student_id, str(data[0] or ''), '谈心记录', str(data[4] or data[2] or ''),
             str(data[6] or ''), int(bool(next_review)), next_review,
             '待复查' if next_review else '已完成', class_id, term_id))

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
            'INSERT INTO focus_items(student_id, topic, reason, evidence, action_plan, status, next_review_at, class_id, term_id) '
            'VALUES(?,?,?,?,?,?,?,?,?)',
            (student_id, str(data[2] or '未分类'), str(data[3] or ''), str(data[4] or ''),
             str(data[5] or ''), status, str(data[7] or ''), class_id, term_id))

    conn.execute('INSERT OR IGNORE INTO app_flags(key, value) VALUES(?, ?)',
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
    owner: str = '班主任'
    scheduled_at: str = ''
    due_at: str = ''
    priority: str = '普通'
    status: str = '待处理'
    notes: str = ''


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    owner: Optional[str] = None
    priority: Optional[str] = None
    scheduled_at: Optional[str] = None
    due_at: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None
    result: Optional[str] = None


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
    progress: str = ''
    task_action: Optional[str] = None
    request_id: str = ''


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
    scene: str = '常规到校'
    records: list[AttendanceRecord]


@router.get('/students/{student_id}/detail')
def student_detail(student_id: int):
    student = _student(student_id)
    class_id, term_id = _scope()
    events = _rows(
        'SELECT e.*, s.姓名 AS student_name FROM student_events e '
        "JOIN students s ON s.id=e.student_id WHERE e.student_id=? AND e.class_id=? AND e.term_id=? AND e.deleted_at='' "
        'ORDER BY e.occurred_at DESC, e.id DESC',
        (student_id, class_id, term_id))
    tasks = _rows(
        'SELECT t.*, s.姓名 AS student_name FROM student_tasks t '
        "LEFT JOIN students s ON s.id=t.student_id WHERE t.student_id=? AND t.class_id=? AND t.term_id=? AND t.deleted_at='' "
        'ORDER BY CASE WHEN t.status IN (\'已完成\',\'已取消\') THEN 1 ELSE 0 END, t.due_at, t.id DESC',
        (student_id, class_id, term_id))
    focus = _rows(
        "SELECT * FROM focus_items WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at='' ORDER BY "
        'CASE WHEN status=\'已结束\' THEN 1 ELSE 0 END, next_review_at, id DESC',
        (student_id, class_id, term_id))
    communications = _rows(
        'SELECT c.*, s.姓名 AS student_name FROM communications c '
        "JOIN students s ON s.id=c.student_id WHERE c.student_id=? AND c.class_id=? AND c.term_id=? AND c.deleted_at='' "
        'ORDER BY c.communicated_at DESC, c.id DESC', (student_id, class_id, term_id))
    workflow_updates = _rows(
        'SELECT * FROM workflow_updates WHERE student_id=? AND class_id=? AND term_id=? '
        'ORDER BY created_at DESC, id DESC', (student_id, class_id, term_id))

    attendance = [{
        'id': row['id'], 'date': row['attendance_date'], 'scene': row['scene'],
        'status': row['status'], 'reason': row['reason'],
        'arrive': row['arrive_at'], 'leave': row['leave_at'], 'note': row['note'],
    } for row in attendance_service.list_records(
        student_id=student_id, limit=5_000, conn=db.get_conn())]

    score_data = scores_service.score_summary(student_id=student_id, conn=db.get_conn())
    score_student = score_data['students'][0] if score_data['students'] else None
    score_summary = {
        'exams': score_student['exams'] if score_student else [],
        'subjects': [item['name'] for item in score_data['subjects']],
        'definition': score_data['definition'],
    }

    points_summary = points_service.student_summary(student_id, conn=db.get_conn())
    points_summary['updated_at'] = max(
        (str(item.get('updated_at') or item.get('created_at') or '')
         for item in points_summary.get('entries', [])), default='')

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
        timeline.append({'kind': 'attendance', 'id': row['id'], 'at': row['date'],
                         'title': f"考勤 · {row['scene']} · {row['status']}",
                         'summary': row['reason'] or row['note'] or '无备注',
                         'status': row['status']})
    for row in tasks:
        if row.get('source_type') not in {'attendance_rule', 'score_rule'} or not row.get('result'):
            continue
        is_attendance = row.get('source_type') == 'attendance_rule'
        timeline.append({
            'kind': 'attendance_followup' if is_attendance else 'score_followup', 'id': row['id'],
            'at': row.get('completed_at') or row.get('cancelled_at') or row.get('updated_at'),
            'title': '考勤异常跟进' if is_attendance else '成绩异常跟进',
            'summary': row['result'], 'status': row['status'],
        })
    for row in focus:
        timeline.append({'kind': 'focus', 'id': row['id'], 'at': row['started_at'],
                         'title': f"关注 · {row['topic']}", 'summary': row['reason'],
                         'status': row['status']})
    source_names = {'event': '事件', 'communication': '家校沟通', 'focus': '关注事项'}
    for row in workflow_updates:
        status_text = f"{row['status_from']} → {row['status_to']}" if row['status_from'] != row['status_to'] else row['status_to']
        timeline.append({
            'kind': 'workflow', 'id': row['id'], 'at': row['created_at'],
            'title': f"{source_names.get(row['source_type'], '跟进')} · 过程记录",
            'summary': row['content'] or status_text or '更新记录',
            'status': status_text,
            'source_type': row['source_type'], 'source_id': row['source_id'],
        })
    timeline.sort(key=lambda x: str(x['at'] or ''), reverse=True)

    today_text = date.today().isoformat()
    open_actions = work_items.list_work_items(
        bucket='open', student_id=student_id, limit=50, conn=db.get_conn())
    overdue_actions = [item for item in open_actions
                       if item['timing_state'] == '已逾期']
    due_focus = [item for item in focus if item['status'] != '已结束'
                 and item['next_review_at']
                 and str(item['next_review_at'])[:10] <= today_text]
    recent_attendance = attendance[:5]
    attendance_risks = [item for item in recent_attendance
                        if item['status'] in {'迟到', '早退', '缺勤'}]
    risk_reasons = []
    if overdue_actions:
        risk_reasons.append(f'{len(overdue_actions)} 项行动已逾期')
    if due_focus:
        risk_reasons.append(f'{len(due_focus)} 项关注需要复查')
    if attendance_risks:
        risk_reasons.append(f'最近 5 次考勤有 {len(attendance_risks)} 次异常')
    if overdue_actions or attendance_risks:
        risk_level = '高'
    elif due_focus or open_actions:
        risk_level = '中'
    else:
        risk_level = '低'

    conclusions = []
    for row in events:
        if row.get('result'):
            conclusions.append((row.get('closed_at') or row['updated_at'], row['result']))
    for row in communications:
        if row.get('result'):
            conclusions.append((row.get('closed_at') or row['updated_at'], row['result']))
    for row in focus:
        if row.get('conclusion'):
            conclusions.append((row.get('ended_at') or row['updated_at'], row['conclusion']))
    conclusions.sort(key=lambda item: str(item[0] or ''), reverse=True)

    exams = score_summary['exams']
    comparable_exams = [item for item in exams if item['total'] is not None]
    if len(comparable_exams) >= 2:
        previous, latest = comparable_exams[-2], comparable_exams[-1]
        change = round(latest['total'] - previous['total'], 1)
        direction = '提升' if change > 0 else '下降' if change < 0 else '持平'
        score_summary['text_summary'] = (
            f"最近一次 {latest['exam_name']} 共 {latest['total']} 分，"
            f"较前一次{direction} {abs(change):g} 分。")
    elif comparable_exams:
        score_summary['text_summary'] = (
            f"当前有 1 次完整考试记录，{comparable_exams[0]['exam_name']} "
            f"共 {comparable_exams[0]['total']} 分。")
    elif exams:
        score_summary['text_summary'] = '已有成绩记录，但预期科目尚未录入完整，暂不计算总分趋势。'
    else:
        score_summary['text_summary'] = '暂无成绩趋势数据。'
    nonzero_weeks = sum(1 for point in points_summary['weekly'] if point)
    points_summary['text_summary'] = (
        f"累计 {points_summary['total']} 分，{nonzero_weeks} 个周次有积分记录。"
        if points_summary['weekly'] else '暂无行为积分趋势数据。')

    insights = {
        'risk_level': risk_level,
        'risk_reasons': risk_reasons or ['当前没有逾期行动、到期复查或近期考勤异常'],
        'recent_changes': timeline[:4],
        'open_actions': open_actions,
        'stage_conclusion': conclusions[0][1] if conclusions else
            '暂无阶段结论；完成一次跟进后可在这里回顾结果。',
    }

    return {'student': student, 'events': events, 'tasks': tasks, 'focus': focus,
            'communications': communications, 'attendance': attendance,
            'workflow_updates': workflow_updates,
            'score_summary': score_summary, 'points_summary': points_summary,
            'timeline': timeline, 'insights': insights}


@router.post('/events')
def create_event(body: EventBody):
    _student(body.student_id, write=True)
    if body.status not in EVENT_STATUSES:
        raise HTTPException(400, '事件状态不合法')
    if body.needs_followup and not body.followup_due:
        raise HTTPException(400, '需要跟进时必须填写跟进日期')
    conn = db.get_conn()
    class_id, term_id = _scope(write=True)
    event_status = '待复查' if body.needs_followup and body.status == '已完成' else body.status
    cur = conn.execute(
        'INSERT INTO student_events(student_id, occurred_at, event_type, description, handling, '
        'parent_contacted, needs_followup, followup_due, status, class_id, term_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        (body.student_id, body.occurred_at, body.event_type, body.description, body.handling,
         int(body.parent_contacted), int(body.needs_followup), body.followup_due, event_status,
         class_id, term_id))
    event_id = cur.lastrowid
    task_id = None
    if body.needs_followup:
        task = work_items.ensure_source_work_item(
            title=f'{body.event_type} · 跟进', student_id=body.student_id,
            source_type='event', source_id=event_id, due_at=body.followup_due,
            priority='重要', status='待复查', notes=body.description,
            conn=conn, commit=False)
        task_id = task['id']
    conn.commit()
    return {'ok': True, 'event_id': event_id, 'task_id': task_id}


@router.get('/events')
def list_events(student_id: Optional[int] = None, status: Optional[str] = None,
                source_id: Optional[int] = None, limit: int = Query(100, ge=1, le=500)):
    class_id, term_id = _scope()
    sql = 'SELECT e.*, s.姓名 AS student_name FROM student_events e JOIN students s ON s.id=e.student_id'
    where, params = ['e.class_id=?', 'e.term_id=?', "e.deleted_at=''", "s.deleted_at=''"], [class_id, term_id]
    if student_id:
        where.append('e.student_id=?')
        params.append(student_id)
    if status:
        where.append('e.status=?')
        params.append(status)
    if source_id:
        where.append('e.id=?')
        params.append(source_id)
    if where:
        sql += ' WHERE ' + ' AND '.join(where)
    sql += ' ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?'
    params.append(limit)
    return {'events': _rows(sql, tuple(params))}


@router.post('/tasks')
def create_task(body: TaskBody):
    if body.student_id:
        _student(body.student_id, write=True)
    try:
        result = work_items.create_work_item(
            title=body.title, student_id=body.student_id, source_type='manual',
            source_label=body.source, owner=body.owner, scheduled_at=body.scheduled_at,
            due_at=body.due_at, priority=body.priority, status=body.status,
            notes=body.notes)
    except work_items.WorkItemError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {'ok': True, 'task_id': result['id']}


@router.get('/tasks')
def list_tasks(
    status: Optional[str] = None,
    student_id: Optional[int] = None,
    bucket: str = 'all',
    source_type: Optional[str] = None,
    q: str = '',
    date_from: str = '',
    date_to: str = '',
    limit: int = Query(200, ge=1, le=1000),
):
    try:
        tasks = work_items.list_work_items(
            status=status, student_id=student_id, bucket=bucket,
            source_type=source_type, query=q, date_from=date_from,
            date_to=date_to, limit=limit)
    except work_items.WorkItemError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {'tasks': tasks}


@router.get('/tasks/summary')
def task_summary():
    return {'summary': work_items.work_item_summary()}


@router.put('/tasks/{task_id}')
def update_task(task_id: int, body: TaskUpdate):
    try:
        item = work_items.update_work_item(
            task_id, title=body.title, owner=body.owner, priority=body.priority,
            scheduled_at=body.scheduled_at, due_at=body.due_at,
            status=body.status, notes=body.notes, result=body.result)
    except work_items.WorkItemError as exc:
        status_code = 404 if '不存在' in str(exc) else 400
        raise HTTPException(status_code, str(exc)) from exc
    except class_tasks_service.ClassTaskError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {'ok': True, 'task': item}


@router.post('/focus')
def create_focus(body: FocusBody):
    _student(body.student_id, write=True)
    if body.status not in FOCUS_STATUSES:
        raise HTTPException(400, '关注状态不合法')
    conn = db.get_conn()
    class_id, term_id = _scope(write=True)
    focus_id = conn.execute(
        'INSERT INTO focus_items(student_id, topic, reason, evidence, action_plan, status, next_review_at, class_id, term_id) '
        'VALUES(?,?,?,?,?,?,?,?,?)',
        (body.student_id, body.topic, body.reason, body.evidence, body.action_plan,
         body.status, body.next_review_at, class_id, term_id)).lastrowid
    task_id = None
    if body.next_review_at and body.status != '已结束':
        task = work_items.ensure_source_work_item(
            title=f'{body.topic} · 复查', student_id=body.student_id,
            source_type='focus', source_id=focus_id, due_at=body.next_review_at,
            priority='重要', status='待复查', notes=body.action_plan or body.reason,
            conn=conn, commit=False)
        task_id = task['id']
    conn.commit()
    return {'ok': True, 'focus_id': focus_id, 'task_id': task_id}


@router.get('/focus')
def list_focus(status: Optional[str] = None, source_id: Optional[int] = None,
               limit: int = Query(100, ge=1, le=500)):
    class_id, term_id = _scope()
    sql = 'SELECT f.*, s.姓名 AS student_name FROM focus_items f JOIN students s ON s.id=f.student_id'
    sql += " WHERE f.class_id=? AND f.term_id=? AND f.deleted_at='' AND s.deleted_at=''"
    params = [class_id, term_id]
    if status:
        sql += ' AND f.status=?'
        params.append(status)
    if source_id:
        sql += ' AND f.id=?'
        params.append(source_id)
    sql += ' ORDER BY CASE WHEN f.status=\'已结束\' THEN 1 ELSE 0 END, f.next_review_at, f.id DESC LIMIT ?'
    params.append(limit)
    return {'focus': _rows(sql, tuple(params))}


@router.put('/focus/{focus_id}')
def update_focus(focus_id: int, body: FocusUpdate):
    from ..services import workflow
    try:
        result = workflow.update_source(
            'focus', focus_id, status=body.status, progress=body.progress,
            result=body.conclusion, next_action_at=body.next_review_at,
            task_action=body.task_action, request_id=body.request_id)
    except workflow.WorkflowError as exc:
        status = 404 if '不存在' in str(exc) else 400
        raise HTTPException(status, str(exc)) from exc
    return {'ok': True, **result}


@router.post('/communications')
def create_communication(body: CommunicationBody):
    _student(body.student_id, write=True)
    communication_status = '待回访' if body.followup_at and body.status == '已完成' else body.status
    if communication_status not in COMMUNICATION_STATUSES:
        raise HTTPException(400, '沟通状态不合法')
    conn = db.get_conn()
    class_id, term_id = _scope(write=True)
    communication_id = conn.execute(
        'INSERT INTO communications(student_id, communicated_at, method, reason, summary, feedback, '
        'agreement, followup_at, status, event_id, class_id, term_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        (body.student_id, body.communicated_at, body.method, body.reason, body.summary, body.feedback,
         body.agreement, body.followup_at, communication_status, body.event_id, class_id, term_id)).lastrowid
    task_id = None
    if body.followup_at:
        task = work_items.ensure_source_work_item(
            title='家校沟通回访', student_id=body.student_id,
            source_type='communication', source_id=communication_id,
            due_at=body.followup_at, priority='重要', status='待复查',
            notes=body.agreement or body.summary, conn=conn, commit=False)
        task_id = task['id']
    conn.commit()
    return {'ok': True, 'communication_id': communication_id, 'task_id': task_id}


@router.get('/communications')
def list_communications(status: Optional[str] = None, source_id: Optional[int] = None,
                        limit: int = Query(100, ge=1, le=500)):
    class_id, term_id = _scope()
    sql = 'SELECT c.*, s.姓名 AS student_name FROM communications c JOIN students s ON s.id=c.student_id'
    sql += " WHERE c.class_id=? AND c.term_id=? AND c.deleted_at='' AND s.deleted_at=''"
    params = [class_id, term_id]
    if status:
        sql += ' AND c.status=?'
        params.append(status)
    if source_id:
        sql += ' AND c.id=?'
        params.append(source_id)
    sql += ' ORDER BY c.communicated_at DESC, c.id DESC LIMIT ?'
    params.append(limit)
    return {'communications': _rows(sql, tuple(params))}


@router.post('/attendance/daily')
def save_daily_attendance(body: DailyAttendanceBody):
    try:
        return attendance_service.save_daily(
            body.date, body.scene,
            [record.model_dump() for record in body.records],
        )
    except attendance_service.AttendanceError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/attendance/records')
def list_attendance_records(date: str = '', scene: str = '常规到校'):
    try:
        return {'records': attendance_service.list_records(
            attendance_date=date, scene=scene, limit=5_000)}
    except attendance_service.AttendanceError as exc:
        raise HTTPException(400, str(exc)) from exc
