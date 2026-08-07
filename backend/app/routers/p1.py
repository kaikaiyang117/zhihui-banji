# -*- coding: utf-8 -*-
"""P1-A/B/C：搜索、成绩、考勤规则、班级任务与值日安排。"""
from __future__ import annotations

import io
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from openpyxl import load_workbook
from pydantic import BaseModel, Field

from .. import db
from ..services import attendance as attendance_service, class_context, scores as scores_service, work_items

router = APIRouter(prefix='/api')


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    return [dict(row) for row in db.get_conn().execute(sql, params).fetchall()]


def _scope(write: bool = False) -> tuple[int, int]:
    return class_context.scope_ids(write=write, conn=db.get_conn())


def _student(student_id: int, write: bool = False) -> dict:
    try:
        return class_context.ensure_student_in_scope(student_id, write=write, conn=db.get_conn())
    except class_context.ArchivedScopeError:
        raise
    except class_context.ScopeError as exc:
        raise HTTPException(404, str(exc)) from exc


class ExamRecord(BaseModel):
    student_id: int
    exam_name: str = Field(min_length=1)
    exam_date: str = ''
    subject: str = Field(min_length=1)
    score: Optional[float] = None
    rank: Optional[int] = None


def upsert_exam_record(record: ExamRecord) -> int:
    scores_service.commit_exam_rows([{
        'row': 1, 'valid': True, 'student_id': record.student_id,
        'exam_name': record.exam_name, 'exam_date': record.exam_date,
        'subject': record.subject, 'score': record.score, 'rank': record.rank,
        'record_status': '正常', 'note': '',
    }], filename='单条成绩', request_id=f'single-{record.student_id}-{record.exam_name}-{record.subject}-{record.score}-{record.rank}')
    class_id, term_id = _scope()
    return int(db.get_conn().execute(
        '''SELECT id FROM exam_records WHERE student_id=? AND class_id=? AND term_id=?
           AND exam_name=? AND subject=? AND deleted_at='' ''',
        (record.student_id, class_id, term_id, record.exam_name, record.subject),
    ).fetchone()['id'])


def import_exam_rows(rows: list[list]) -> dict:
    return scores_service.import_exam_rows(rows)


@router.post('/exams/import')
async def import_exams(file: UploadFile = File(...)):
    """兼容入口现在只做预览，不再收到文件后立即写库。"""
    return await preview_exams(file, 'update')


@router.post('/exams/import/preview')
async def preview_exams(file: UploadFile = File(...), duplicate_strategy: str = 'update'):
    try:
        workbook = load_workbook(io.BytesIO(await file.read()), read_only=True, data_only=True)
        sheet = workbook.active
        result = scores_service.preview_exam_rows(
            [list(row) for row in sheet.iter_rows(values_only=True)], duplicate_strategy)
        workbook.close()
        return {'ok': True, 'filename': file.filename or '', **result}
    except scores_service.ScoreError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(400, f'成绩文件读取失败：{exc}') from exc


class ExamImportCommitBody(BaseModel):
    filename: str = ''
    duplicate_strategy: str = 'update'
    request_id: str = ''
    rows: list[dict] = []


@router.post('/exams/import/commit')
def commit_exams(body: ExamImportCommitBody):
    try:
        return scores_service.commit_exam_rows(
            body.rows, filename=body.filename,
            duplicate_strategy=body.duplicate_strategy, request_id=body.request_id)
    except scores_service.ScoreError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/exams')
def list_exams(student_id: Optional[int] = None, exam_name: Optional[str] = None):
    records = scores_service.list_records(student_id=student_id)
    if exam_name:
        records = [item for item in records if item['exam_name'] == exam_name]
    return {'records': records}


@router.get('/exams/summary')
def exam_summary(student_id: Optional[int] = None):
    return scores_service.score_summary(student_id=student_id)


class ScoreSubjectBody(BaseModel):
    name: str = Field(min_length=1)
    full_score: float = Field(default=0, ge=0)
    enabled: bool = True
    sort_order: int = 0


class ScoreSubjectUpdate(BaseModel):
    name: Optional[str] = None
    full_score: Optional[float] = Field(default=None, ge=0)
    enabled: Optional[bool] = None
    sort_order: Optional[int] = None


class ScoreExamBody(BaseModel):
    name: str = Field(min_length=1)
    exam_date: str = ''
    subject_ids: list[int] = []
    enabled: bool = True
    sort_order: int = 0


class ScoreExamUpdate(BaseModel):
    name: Optional[str] = None
    exam_date: Optional[str] = None
    subject_ids: Optional[list[int]] = None
    enabled: Optional[bool] = None
    sort_order: Optional[int] = None


@router.get('/score-config')
def score_config():
    return scores_service.list_config()


@router.post('/score-config/subjects')
def add_score_subject(body: ScoreSubjectBody):
    try:
        return scores_service.create_subject(**body.model_dump())
    except scores_service.ScoreError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put('/score-config/subjects/{subject_id}')
def edit_score_subject(subject_id: int, body: ScoreSubjectUpdate):
    try:
        return scores_service.update_subject(
            subject_id, **body.model_dump(exclude_none=True))
    except scores_service.ScoreError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post('/score-config/exams')
def add_score_exam(body: ScoreExamBody):
    try:
        return scores_service.create_exam(**body.model_dump())
    except scores_service.ScoreError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put('/score-config/exams/{exam_id}')
def edit_score_exam(exam_id: int, body: ScoreExamUpdate):
    try:
        return scores_service.update_exam(exam_id, **body.model_dump(exclude_none=True))
    except scores_service.ScoreError as exc:
        raise HTTPException(400, str(exc)) from exc


class ScoreRuleBody(BaseModel):
    name: str = Field(min_length=1)
    metric: str = '总分下降'
    subject_id: Optional[int] = None
    threshold: float = Field(default=10, gt=0)
    priority: str = '重要'
    enabled: bool = True


class ScoreRuleUpdate(BaseModel):
    enabled: Optional[bool] = None
    threshold: Optional[float] = Field(default=None, gt=0)
    priority: Optional[str] = None


@router.get('/score-rules')
def get_score_rules(source_id: Optional[int] = None):
    return scores_service.list_rules(source_id=source_id)


@router.post('/score-rules')
def add_score_rule(body: ScoreRuleBody):
    try:
        return scores_service.create_rule(**body.model_dump())
    except scores_service.ScoreError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put('/score-rules/{rule_id}')
def edit_score_rule(rule_id: int, body: ScoreRuleUpdate):
    try:
        return scores_service.update_rule(rule_id, **body.model_dump(exclude_none=True))
    except scores_service.ScoreError as exc:
        status = 404 if '不存在' in str(exc) else 400
        raise HTTPException(status, str(exc)) from exc


@router.post('/score-rules/evaluate')
def evaluate_score_rules():
    try:
        return scores_service.evaluate_rules(trigger='manual')
    except scores_service.ScoreError as exc:
        raise HTTPException(400, str(exc)) from exc


class AttendanceRuleBody(BaseModel):
    name: str = Field(min_length=1)
    metric: str = '迟到次数'
    threshold: int = Field(default=2, ge=1)
    period_days: int = Field(default=7, ge=1, le=365)
    priority: str = '重要'
    enabled: bool = True
    scene: str = '全部场景'


class AttendanceRuleUpdate(BaseModel):
    enabled: Optional[bool] = None
    threshold: Optional[int] = Field(default=None, ge=1)
    period_days: Optional[int] = Field(default=None, ge=1, le=365)
    priority: Optional[str] = None
    scene: Optional[str] = None


class AttendanceRuleEvaluation(BaseModel):
    reference_date: str = ''


@router.get('/attendance/rules')
def list_attendance_rules(source_id: Optional[int] = None):
    return attendance_service.list_rules(source_id=source_id)


@router.post('/attendance/rules')
def create_attendance_rule(body: AttendanceRuleBody):
    try:
        return attendance_service.create_rule(**body.model_dump())
    except attendance_service.AttendanceError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put('/attendance/rules/{rule_id}')
def update_attendance_rule(rule_id: int, body: AttendanceRuleUpdate):
    try:
        return attendance_service.update_rule(
            rule_id, **body.model_dump(exclude_none=True))
    except attendance_service.AttendanceError as exc:
        status = 404 if '不存在' in str(exc) else 400
        raise HTTPException(status, str(exc)) from exc


@router.post('/attendance/rules/evaluate')
def evaluate_attendance_rules(body: AttendanceRuleEvaluation | None = None):
    try:
        result = attendance_service.evaluate_rules(
            reference_date=body.reference_date if body else '', trigger='manual')
        return {**result, 'created': [
            item for item in result['summary'] if item['state'] == '新命中'
        ], 'count': result['created_count']}
    except attendance_service.AttendanceError as exc:
        raise HTTPException(400, str(exc)) from exc


class ClassTaskBody(BaseModel):
    title: str = Field(min_length=1)
    task_type: str = '材料收集'
    start_at: str = ''
    due_at: str = ''
    material_name: str = ''
    description: str = ''
    student_ids: list[int] = []


class ClassTaskUpdate(BaseModel):
    status: Optional[str] = None
    description: Optional[str] = None


class ClassTaskItemUpdate(BaseModel):
    status: str = '已提交'
    note: str = ''


def _class_task(task_id: int) -> dict:
    class_id, term_id = _scope()
    row = db.get_conn().execute(
        "SELECT * FROM class_tasks WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (task_id, class_id, term_id)).fetchone()
    if not row:
        raise HTTPException(404, '班级任务不存在')
    return dict(row)


def _task_with_items(task: dict) -> dict:
    items = _rows('SELECT i.*, s.学号, s.姓名 FROM class_task_items i JOIN students s ON s.id=i.student_id WHERE i.task_id=? ORDER BY s.学号', (task['id'],))
    task['items'] = items
    task['total'] = len(items)
    task['submitted'] = sum(1 for item in items if item['status'] == '已提交')
    return task


@router.get('/class-tasks')
def list_class_tasks(status: Optional[str] = None, source_id: Optional[int] = None):
    class_id, term_id = _scope()
    sql, params = "SELECT * FROM class_tasks WHERE class_id=? AND term_id=? AND deleted_at=''", [class_id, term_id]
    if status:
        sql += ' AND status=?'
        params.append(status)
    if source_id:
        sql += ' AND id=?'
        params.append(source_id)
    tasks = [_task_with_items(row) for row in _rows(sql + ' ORDER BY due_at, id DESC', tuple(params))]
    return {'tasks': tasks}


@router.post('/class-tasks')
def create_class_task(body: ClassTaskBody):
    conn = db.get_conn()
    class_id, term_id = _scope(write=True)
    for student_id in body.student_ids:
        _student(student_id, write=True)
    cur = conn.execute(
        'INSERT INTO class_tasks(title, task_type, start_at, due_at, material_name, description, class_id, term_id) '
        'VALUES(?,?,?,?,?,?,?,?)',
        (body.title, body.task_type, body.start_at, body.due_at,
         body.material_name, body.description, class_id, term_id))
    task_id = cur.lastrowid
    for student_id in body.student_ids:
        conn.execute('INSERT INTO class_task_items(task_id, student_id) VALUES(?,?)', (task_id, student_id))
    work_items.ensure_source_work_item(
        title=body.title, source_type='class_task', source_id=task_id,
        scheduled_at=body.start_at, due_at=body.due_at,
        notes=body.description, conn=conn, commit=False)
    conn.commit()
    return {'ok': True, 'task_id': task_id}


@router.put('/class-tasks/{task_id}')
def update_class_task(task_id: int, body: ClassTaskUpdate):
    class_id, term_id = _scope(write=True)
    _class_task(task_id)
    fields, params = [], []
    for key in ('status', 'description'):
        value = getattr(body, key)
        if value is not None:
            fields.append(f'{key}=?')
            params.append(value)
    if fields:
        params.extend((task_id, class_id, term_id))
        db.get_conn().execute(
            f"UPDATE class_tasks SET {', '.join(fields)}, updated_at=datetime('now','localtime') "
            'WHERE id=? AND class_id=? AND term_id=?', params)
        db.get_conn().commit()
    return {'ok': True}


@router.put('/class-tasks/{task_id}/items/{student_id}')
def update_class_task_item(task_id: int, student_id: int, body: ClassTaskItemUpdate):
    _scope(write=True)
    _class_task(task_id)
    _student(student_id, write=True)
    cur = db.get_conn().execute(
        "UPDATE class_task_items SET status=?, note=?, submitted_at=CASE WHEN ?='已提交' THEN datetime('now','localtime') ELSE '' END WHERE task_id=? AND student_id=?",
        (body.status, body.note, body.status, task_id, student_id))
    db.get_conn().commit()
    if not cur.rowcount:
        raise HTTPException(404, '任务中没有该学生')
    return {'ok': True}


class DutyBody(BaseModel):
    duty_date: str = Field(min_length=10)
    area: str = Field(min_length=1)
    student_id: int
    status: str = '待完成'
    note: str = ''


@router.get('/duty')
def list_duty(duty_date: Optional[str] = None, source_id: Optional[int] = None):
    class_id, term_id = _scope()
    if source_id:
        rows = _rows(
            'SELECT d.*, s.学号, s.姓名 FROM duty_assignments d JOIN students s ON s.id=d.student_id '
            "WHERE d.class_id=? AND d.term_id=? AND d.id=? AND d.deleted_at='' AND s.deleted_at=''",
            (class_id, term_id, source_id))
        return {'assignments': rows}
    if duty_date:
        rows = _rows(
            'SELECT d.*, s.学号, s.姓名 FROM duty_assignments d JOIN students s ON s.id=d.student_id '
            "WHERE d.class_id=? AND d.term_id=? AND duty_date=? AND d.deleted_at='' AND s.deleted_at='' ORDER BY area, s.学号",
            (class_id, term_id, duty_date))
    else:
        rows = _rows(
            'SELECT d.*, s.学号, s.姓名 FROM duty_assignments d JOIN students s ON s.id=d.student_id '
            "WHERE d.class_id=? AND d.term_id=? AND d.deleted_at='' AND s.deleted_at='' ORDER BY duty_date DESC, area, s.学号",
            (class_id, term_id))
    return {'assignments': rows}


@router.post('/duty')
def create_duty(body: DutyBody):
    _student(body.student_id, write=True)
    conn = db.get_conn()
    class_id, term_id = _scope(write=True)
    conn.execute(
        'INSERT INTO duty_assignments(duty_date, area, student_id, class_id, term_id, status, note) VALUES(?,?,?,?,?,?,?) '
        "ON CONFLICT(class_id, term_id, duty_date, area, student_id) DO UPDATE SET "
        "status=excluded.status, note=excluded.note, updated_at=datetime('now','localtime')",
        (body.duty_date, body.area, body.student_id, class_id, term_id, body.status, body.note))
    conn.commit()
    row = conn.execute(
        'SELECT id FROM duty_assignments WHERE class_id=? AND term_id=? AND duty_date=? AND area=? AND student_id=?',
        (class_id, term_id, body.duty_date, body.area, body.student_id)).fetchone()
    if body.status != '已完成':
        work_items.ensure_source_work_item(
            title=f'值日 · {body.area}', student_id=body.student_id,
            source_type='duty_assignment', source_id=row['id'],
            scheduled_at=body.duty_date, due_at=body.duty_date,
            status='待处理', notes=body.note)
    return {'ok': True, 'assignment_id': row['id']}


class DutyUpdate(BaseModel):
    status: str
    note: str = ''


@router.put('/duty/{assignment_id}')
def update_duty(assignment_id: int, body: DutyUpdate):
    class_id, term_id = _scope(write=True)
    cur = db.get_conn().execute(
        "UPDATE duty_assignments SET status=?, note=?, updated_at=datetime('now','localtime') "
        'WHERE id=? AND class_id=? AND term_id=?',
        (body.status, body.note, assignment_id, class_id, term_id))
    db.get_conn().commit()
    if not cur.rowcount:
        raise HTTPException(404, '值日安排不存在')
    return {'ok': True}


@router.get('/search')
def search(q: str = '', limit: int = 30):
    query = q.strip()
    if not query:
        return {'results': []}
    like = f'%{query}%'
    class_id, term_id = _scope()
    results = []
    for row in _rows(
        'SELECT s.id, s.学号, s.姓名, s.班级任职 FROM students s '
        'JOIN student_enrollments e ON e.student_id=s.id '
        "WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at='' "
        'AND (s.学号 LIKE ? OR s.姓名 LIKE ? OR s.备注 LIKE ?) '
        'ORDER BY s.学号 LIMIT ?', (class_id, term_id, like, like, like, limit)):
        results.append({'kind': 'student', 'id': row['id'], 'student_id': row['id'], 'title': row['姓名'], 'summary': f"{row['学号'] or '暂无学号'} · {row['班级任职'] or '班级成员'}", 'path': f"/student/{row['id']}"})
    sources = [
        ('student_events', 'x.id, x.student_id, x.event_type AS title, x.description AS summary', '事件', '/events'),
        ('student_tasks', 'x.id, x.student_id, x.title, x.notes AS summary', '待办', '/tasks'),
        ('focus_items', 'x.id, x.student_id, x.topic AS title, x.reason AS summary', '关注', '/special'),
        ('communications', 'x.id, x.student_id, x.reason AS title, x.summary', '沟通', '/parent-comm'),
    ]
    for table, fields, kind, path in sources:
        for row in _rows(
            f'SELECT {fields}, s.姓名 AS student_name FROM {table} x JOIN students s ON s.id=x.student_id '
            "WHERE x.class_id=? AND x.term_id=? AND x.deleted_at='' AND s.deleted_at='' AND (title LIKE ? OR summary LIKE ?) LIMIT ?",
            (class_id, term_id, like, like, limit)):
            results.append({'kind': kind, 'id': row['id'], 'student_id': row['student_id'], 'title': row['title'], 'summary': f"{row['student_name']} · {row['summary'] or ''}", 'path': path})
    for row in _rows(
        'SELECT e.id, e.student_id, e.exam_name AS title, e.subject || " " || COALESCE(e.score, "") AS summary, '
        's.姓名 AS student_name FROM exam_records e JOIN students s ON s.id=e.student_id '
        "WHERE e.class_id=? AND e.term_id=? AND e.deleted_at='' AND s.deleted_at='' AND (e.exam_name LIKE ? OR e.subject LIKE ?) LIMIT ?",
        (class_id, term_id, like, like, limit)):
        results.append({'kind': '成绩', 'id': row['id'], 'student_id': row['student_id'], 'title': row['title'], 'summary': f"{row['student_name']} · {row['summary']}", 'path': '/scores'})
    return {'results': results[:limit]}
