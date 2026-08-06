# -*- coding: utf-8 -*-
"""P1-A/B/C：搜索、成绩、考勤规则、班级任务与值日安排。"""
from __future__ import annotations

import io
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from openpyxl import load_workbook
from pydantic import BaseModel, Field

from .. import db

router = APIRouter(prefix='/api')


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    return [dict(row) for row in db.get_conn().execute(sql, params).fetchall()]


def _student(student_id: int) -> dict:
    row = db.get_conn().execute('SELECT * FROM students WHERE id=?', (student_id,)).fetchone()
    if not row:
        raise HTTPException(404, '学生不存在')
    return dict(row)


def _find_student(xh: str, name: str = '') -> Optional[dict]:
    conn = db.get_conn()
    if xh:
        row = conn.execute('SELECT id, 学号, 姓名 FROM students WHERE 学号=?', (xh,)).fetchone()
        if row:
            return dict(row)
    if name:
        row = conn.execute('SELECT id, 学号, 姓名 FROM students WHERE 姓名=?', (name,)).fetchone()
        if row:
            return dict(row)
    return None


def _number(value):
    if value in (None, ''):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class ExamRecord(BaseModel):
    student_id: int
    exam_name: str = Field(min_length=1)
    exam_date: str = ''
    subject: str = Field(min_length=1)
    score: Optional[float] = None
    rank: Optional[int] = None


def upsert_exam_record(record: ExamRecord) -> int:
    _student(record.student_id)
    conn = db.get_conn()
    cur = conn.execute(
        'INSERT INTO exam_records(student_id, exam_name, exam_date, subject, score, rank) '
        'VALUES(?,?,?,?,?,?) ON CONFLICT(student_id, exam_name, subject) DO UPDATE SET '
        'exam_date=excluded.exam_date, score=excluded.score, rank=excluded.rank, '
        "updated_at=datetime('now','localtime')",
        (record.student_id, record.exam_name, record.exam_date, record.subject, record.score, record.rank))
    conn.commit()
    return cur.lastrowid or conn.execute(
        'SELECT id FROM exam_records WHERE student_id=? AND exam_name=? AND subject=?',
        (record.student_id, record.exam_name, record.subject)).fetchone()['id']


def import_exam_rows(rows: list[list]) -> dict:
    """导入 Excel 行；支持长表（科目/分数）和宽表（每科一列）。"""
    if not rows:
        raise HTTPException(400, 'Excel 没有数据')
    headers = [str(v or '').strip() for v in rows[0]]
    index = {v: i for i, v in enumerate(headers) if v}
    required = {'学号', '考试名称'}
    if not required.issubset(index):
        raise HTTPException(400, '成绩表必须包含：学号、考试名称')
    long_format = {'科目', '分数'}.issubset(index)
    metadata = {'学号', '姓名', '考试名称', '考试日期', '科目', '分数', '排名'}
    subjects = [h for h in headers if h and h not in metadata]
    if not long_format and not subjects:
        raise HTTPException(400, '成绩表需要科目列，或包含“科目、分数”列')

    imported = 0
    updated = 0
    errors = []
    conn = db.get_conn()
    for row_no, values in enumerate(rows[1:], start=2):
        value = lambda key: str(values[index[key]] or '').strip() if index[key] < len(values) else ''
        student = _find_student(value('学号'), value('姓名') if '姓名' in index else '')
        if not student:
            errors.append(f'第 {row_no} 行找不到学生：{value("学号")}')
            continue
        exam_name = value('考试名称')
        exam_date = value('考试日期') if '考试日期' in index else ''
        items = []
        if long_format:
            items = [(value('科目'), _number(values[index['分数']]), value('排名') if '排名' in index else '')]
        else:
            items = [(subject, _number(values[index[subject]] if index[subject] < len(values) else None), '')
                     for subject in subjects]
        for subject, score, rank_text in items:
            if not subject:
                continue
            rank = None
            try:
                rank = int(float(rank_text)) if rank_text else None
            except (TypeError, ValueError):
                pass
            existing = conn.execute(
                'SELECT id FROM exam_records WHERE student_id=? AND exam_name=? AND subject=?',
                (student['id'], exam_name, subject)).fetchone()
            upsert_exam_record(ExamRecord(student_id=student['id'], exam_name=exam_name,
                                           exam_date=exam_date, subject=subject, score=score, rank=rank))
            if existing:
                updated += 1
            else:
                imported += 1
    return {'imported': imported, 'updated': updated, 'errors': errors}


@router.post('/exams/import')
async def import_exams(file: UploadFile = File(...)):
    try:
        workbook = load_workbook(io.BytesIO(await file.read()), read_only=True, data_only=True)
        sheet = workbook.active
        result = import_exam_rows([list(row) for row in sheet.iter_rows(values_only=True)])
        workbook.close()
        return {'ok': True, **result}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f'成绩文件读取失败：{exc}') from exc


@router.get('/exams')
def list_exams(student_id: Optional[int] = None, exam_name: Optional[str] = None):
    sql = 'SELECT e.*, s.学号, s.姓名 FROM exam_records e JOIN students s ON s.id=e.student_id'
    where, params = [], []
    if student_id:
        where.append('e.student_id=?')
        params.append(student_id)
    if exam_name:
        where.append('e.exam_name=?')
        params.append(exam_name)
    if where:
        sql += ' WHERE ' + ' AND '.join(where)
    return {'records': _rows(sql + ' ORDER BY e.exam_date, e.exam_name, s.学号, e.subject', tuple(params))}


@router.get('/exams/summary')
def exam_summary(student_id: Optional[int] = None):
    records = list_exams(student_id)['records']
    grouped = {}
    for row in records:
        key = (row['exam_name'], row['exam_date'])
        grouped.setdefault(key, {'exam_name': row['exam_name'], 'exam_date': row['exam_date'], 'subjects': {}, 'total': 0})
        grouped[key]['subjects'][row['subject']] = row['score']
        if row['score'] is not None:
            grouped[key]['total'] += row['score']
    exams = list(grouped.values())
    exams.sort(key=lambda item: (item['exam_date'], item['exam_name']))
    subjects = sorted({row['subject'] for row in records})
    return {'exams': exams, 'subjects': subjects, 'records': records}


class AttendanceRuleBody(BaseModel):
    name: str = Field(min_length=1)
    metric: str = '迟到次数'
    threshold: int = Field(default=2, ge=1)
    period_days: int = Field(default=7, ge=1, le=365)
    priority: str = '重要'
    enabled: bool = True


class AttendanceRuleUpdate(BaseModel):
    enabled: Optional[bool] = None
    threshold: Optional[int] = Field(default=None, ge=1)
    period_days: Optional[int] = Field(default=None, ge=1, le=365)
    priority: Optional[str] = None


@router.get('/attendance/rules')
def list_attendance_rules():
    rules = _rows('SELECT * FROM attendance_rules ORDER BY enabled DESC, id')
    for rule in rules:
        rule['enabled'] = bool(rule['enabled'])
    return {'rules': rules}


@router.post('/attendance/rules')
def create_attendance_rule(body: AttendanceRuleBody):
    if body.metric not in {'迟到次数', '请假次数', '缺勤次数', '连续缺勤天数'}:
        raise HTTPException(400, '不支持的考勤指标')
    cur = db.get_conn().execute(
        'INSERT INTO attendance_rules(name, metric, threshold, period_days, priority, enabled) VALUES(?,?,?,?,?,?)',
        (body.name, body.metric, body.threshold, body.period_days, body.priority, int(body.enabled)))
    db.get_conn().commit()
    return {'ok': True, 'rule_id': cur.lastrowid}


@router.put('/attendance/rules/{rule_id}')
def update_attendance_rule(rule_id: int, body: AttendanceRuleUpdate):
    fields, params = [], []
    for key in ('enabled', 'threshold', 'period_days', 'priority'):
        value = getattr(body, key)
        if value is not None:
            fields.append(f'{key}=?')
            params.append(int(value) if key == 'enabled' else value)
    if not fields:
        return {'ok': True}
    params.append(rule_id)
    cur = db.get_conn().execute(f"UPDATE attendance_rules SET {', '.join(fields)}, updated_at=datetime('now','localtime') WHERE id=?", params)
    db.get_conn().commit()
    if not cur.rowcount:
        raise HTTPException(404, '规则不存在')
    return {'ok': True}


def _attendance_rule_value(rows: list[dict], metric: str) -> int:
    statuses = {'迟到次数': '迟到', '请假次数': '请假', '缺勤次数': '缺勤'}
    if metric in statuses:
        return sum(1 for row in rows if row['status'] == statuses[metric])
    dates = sorted({row['date'] for row in rows if row['status'] == '缺勤'}, reverse=True)
    streak = best = 0
    previous = None
    for raw in dates:
        try:
            current = date.fromisoformat(raw[:10])
        except ValueError:
            continue
        if previous is None or previous - current == timedelta(days=1):
            streak += 1
        else:
            streak = 1
        previous = current
        best = max(best, streak)
    return best


@router.post('/attendance/rules/evaluate')
def evaluate_attendance_rules():
    rules = _rows('SELECT * FROM attendance_rules WHERE enabled=1 ORDER BY id')
    students = _rows('SELECT id, 学号, 姓名 FROM students ORDER BY id')
    raw_rows = db.get_rows('考勤管理')
    today = date.today()
    created = []
    for rule in rules:
        for student in students:
            xh = str(student['学号'] or '').strip()
            records = []
            for item in raw_rows:
                data = item['data']
                if len(data) < 5 or str(data[2] or '').strip() != xh:
                    continue
                raw_date = str(data[0] or '')[:10]
                try:
                    if date.fromisoformat(raw_date) < today - timedelta(days=rule['period_days'] - 1):
                        continue
                except ValueError:
                    continue
                records.append({'date': raw_date, 'status': str(data[4] or '')})
            value = _attendance_rule_value(records, rule['metric'])
            if value < rule['threshold']:
                continue
            title = f"考勤提醒 · {student['姓名']} · {rule['name']}"
            existing = db.get_conn().execute(
                "SELECT id FROM student_tasks WHERE title=? AND status NOT IN ('已完成','已取消')", (title,)).fetchone()
            if existing:
                continue
            task_id = db.get_conn().execute(
                'INSERT INTO student_tasks(student_id, title, source, due_at, priority, status, notes) VALUES(?,?,?,?,?,?,?)',
                (student['id'], title, '考勤规则', str(today), rule['priority'], '待处理',
                 f"{rule['metric']}达到 {value} 次，阈值 {rule['threshold']}，统计周期 {rule['period_days']} 天" )).lastrowid
            db.get_conn().commit()
            created.append({'task_id': task_id, 'student_id': student['id'], 'student_name': student['姓名'], 'rule': rule['name'], 'value': value})
    return {'created': created, 'count': len(created)}


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
    row = db.get_conn().execute('SELECT * FROM class_tasks WHERE id=?', (task_id,)).fetchone()
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
def list_class_tasks(status: Optional[str] = None):
    sql, params = 'SELECT * FROM class_tasks', []
    if status:
        sql += ' WHERE status=?'
        params.append(status)
    tasks = [_task_with_items(row) for row in _rows(sql + ' ORDER BY due_at, id DESC', tuple(params))]
    return {'tasks': tasks}


@router.post('/class-tasks')
def create_class_task(body: ClassTaskBody):
    conn = db.get_conn()
    for student_id in body.student_ids:
        _student(student_id)
    cur = conn.execute(
        'INSERT INTO class_tasks(title, task_type, start_at, due_at, material_name, description) VALUES(?,?,?,?,?,?)',
        (body.title, body.task_type, body.start_at, body.due_at, body.material_name, body.description))
    task_id = cur.lastrowid
    for student_id in body.student_ids:
        conn.execute('INSERT INTO class_task_items(task_id, student_id) VALUES(?,?)', (task_id, student_id))
    conn.commit()
    return {'ok': True, 'task_id': task_id}


@router.put('/class-tasks/{task_id}')
def update_class_task(task_id: int, body: ClassTaskUpdate):
    _class_task(task_id)
    fields, params = [], []
    for key in ('status', 'description'):
        value = getattr(body, key)
        if value is not None:
            fields.append(f'{key}=?')
            params.append(value)
    if fields:
        params.append(task_id)
        db.get_conn().execute(f"UPDATE class_tasks SET {', '.join(fields)}, updated_at=datetime('now','localtime') WHERE id=?", params)
        db.get_conn().commit()
    return {'ok': True}


@router.put('/class-tasks/{task_id}/items/{student_id}')
def update_class_task_item(task_id: int, student_id: int, body: ClassTaskItemUpdate):
    _class_task(task_id)
    _student(student_id)
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
def list_duty(duty_date: Optional[str] = None):
    if duty_date:
        rows = _rows('SELECT d.*, s.学号, s.姓名 FROM duty_assignments d JOIN students s ON s.id=d.student_id WHERE duty_date=? ORDER BY area, s.学号', (duty_date,))
    else:
        rows = _rows('SELECT d.*, s.学号, s.姓名 FROM duty_assignments d JOIN students s ON s.id=d.student_id ORDER BY duty_date DESC, area, s.学号')
    return {'assignments': rows}


@router.post('/duty')
def create_duty(body: DutyBody):
    _student(body.student_id)
    conn = db.get_conn()
    conn.execute(
        'INSERT INTO duty_assignments(duty_date, area, student_id, status, note) VALUES(?,?,?,?,?) '
        "ON CONFLICT(duty_date, area, student_id) DO UPDATE SET status=excluded.status, note=excluded.note, updated_at=datetime('now','localtime')",
        (body.duty_date, body.area, body.student_id, body.status, body.note))
    conn.commit()
    row = conn.execute('SELECT id FROM duty_assignments WHERE duty_date=? AND area=? AND student_id=?', (body.duty_date, body.area, body.student_id)).fetchone()
    return {'ok': True, 'assignment_id': row['id']}


class DutyUpdate(BaseModel):
    status: str
    note: str = ''


@router.put('/duty/{assignment_id}')
def update_duty(assignment_id: int, body: DutyUpdate):
    cur = db.get_conn().execute("UPDATE duty_assignments SET status=?, note=?, updated_at=datetime('now','localtime') WHERE id=?", (body.status, body.note, assignment_id))
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
    results = []
    for row in _rows('SELECT id, 学号, 姓名, 班级任职 FROM students WHERE 学号 LIKE ? OR 姓名 LIKE ? OR 备注 LIKE ? ORDER BY 学号 LIMIT ?', (like, like, like, limit)):
        results.append({'kind': 'student', 'id': row['id'], 'student_id': row['id'], 'title': row['姓名'], 'summary': f"{row['学号'] or '暂无学号'} · {row['班级任职'] or '班级成员'}", 'path': f"/student/{row['id']}"})
    sources = [
        ('student_events', 'x.id, x.student_id, x.event_type AS title, x.description AS summary', '事件', '/events'),
        ('student_tasks', 'x.id, x.student_id, x.title, x.notes AS summary', '待办', '/tasks'),
        ('focus_items', 'x.id, x.student_id, x.topic AS title, x.reason AS summary', '关注', '/special'),
        ('communications', 'x.id, x.student_id, x.reason AS title, x.summary', '沟通', '/parent-comm'),
    ]
    for table, fields, kind, path in sources:
        for row in _rows(f'SELECT {fields}, s.姓名 AS student_name FROM {table} x JOIN students s ON s.id=x.student_id WHERE title LIKE ? OR summary LIKE ? LIMIT ?', (like, like, limit)):
            results.append({'kind': kind, 'id': row['id'], 'student_id': row['student_id'], 'title': row['title'], 'summary': f"{row['student_name']} · {row['summary'] or ''}", 'path': path})
    for row in _rows('SELECT e.id, e.student_id, e.exam_name AS title, e.subject || " " || COALESCE(e.score, "") AS summary, s.姓名 AS student_name FROM exam_records e JOIN students s ON s.id=e.student_id WHERE e.exam_name LIKE ? OR e.subject LIKE ? LIMIT ?', (like, like, limit)):
        results.append({'kind': '成绩', 'id': row['id'], 'student_id': row['student_id'], 'title': row['title'], 'summary': f"{row['student_name']} · {row['summary']}", 'path': '/scores'})
    return {'results': results[:limit]}
