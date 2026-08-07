# -*- coding: utf-8 -*-
"""学生信息（结构化表）+ Excel 导入"""
import urllib.parse

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import db
from ..config import STUDENT_COLUMNS
from ..import_service import (
    build_template,
    commit_student_import,
    import_students,
    preview_students,
)
from ..export_service import export_students
from ..services import audit, class_context, recycle

router = APIRouter(prefix='/api/students')

_MEDIA = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


class StudentBody(BaseModel):
    学号: str = ''
    姓名: str = ''
    性别: str = ''
    出生年月: str = ''
    民族: str = ''
    家庭住址: str = ''
    监护人姓名: str = ''
    监护人电话: str = ''
    监护人职业: str = ''
    是否住校: str = ''
    特长: str = ''
    班级任职: str = ''
    备注: str = ''
    监护人2姓名: str = ''
    监护人2电话: str = ''
    监护人2关系: str = ''


class StudentImportRow(BaseModel):
    row: int = 0
    fields: dict[str, str] = {}


class StudentImportCommitBody(BaseModel):
    filename: str = ''
    rows: list[StudentImportRow] = []


def _xlsx_response(buf, fname: str):
    quoted = urllib.parse.quote(fname)
    return StreamingResponse(
        buf, media_type=_MEDIA,
        headers={'Content-Disposition': f"attachment; filename*=UTF-8''{quoted}"})


@router.get('')
def list_students(keyword: str = ''):
    conn = db.get_conn()
    scope = class_context.get_current_scope(conn=conn)
    class_id, term_id = scope['class_id'], scope['term_id']
    sql = (
        f'SELECT s.id, {",".join("s.["+k+"]" for k in STUDENT_COLUMNS)}, '
        'e.id AS enrollment_id, e.status AS enrollment_status '
        'FROM students s JOIN student_enrollments e ON e.student_id=s.id '
        "WHERE e.class_id=? AND e.term_id=? AND s.deleted_at=''"
    )
    params: list = [class_id, term_id]
    if scope['term_status'] != '已归档':
        sql += " AND e.status='在读'"
    if keyword:
        sql += ' AND (s.姓名 LIKE ? OR s.学号 LIKE ?)'
        params.extend((f'%{keyword}%', f'%{keyword}%'))
    sql += ' ORDER BY s.学号'
    rows = conn.execute(sql, tuple(params)).fetchall()
    return {'students': [dict(r) for r in rows]}


@router.get('/directory')
def list_student_directory():
    return {'students': class_context.list_student_directory()}


@router.post('')
def create_student(body: StudentBody):
    conn = db.get_conn()
    class_context.get_current_scope(write=True, conn=conn)
    if body.学号:
        existing = conn.execute('SELECT id, deleted_at FROM students WHERE 学号=?', (body.学号,)).fetchone()
        if existing:
            if existing['deleted_at']:
                raise HTTPException(409, f'学号 {body.学号} 位于回收站，请先恢复')
            raise HTTPException(409, f'学号 {body.学号} 已存在')
    vals = tuple(getattr(body, k) for k in STUDENT_COLUMNS)
    cols = ','.join(f'[{k}]' for k in STUDENT_COLUMNS)
    placeholders = ','.join('?' for _ in STUDENT_COLUMNS)
    cur = conn.execute(f'INSERT INTO students({cols}) VALUES({placeholders})', vals)
    class_context.enroll_student(cur.lastrowid, conn=conn)
    audit.record('student', cur.lastrowid, 'create', summary=f'新增学生：{body.姓名}',
                 params=body.model_dump(), conn=conn, commit=False)
    conn.commit()
    return {'ok': True, 'id': cur.lastrowid}


@router.put('/{sid}')
def update_student(sid: int, body: StudentBody):
    conn = db.get_conn()
    try:
        class_context.ensure_student_in_scope(sid, write=True, conn=conn)
    except class_context.ArchivedScopeError:
        raise
    except class_context.ScopeError as exc:
        raise HTTPException(404, str(exc)) from exc
    if body.学号:
        dup = conn.execute("SELECT id FROM students WHERE 学号=? AND id!=? AND deleted_at=''", (body.学号, sid)).fetchone()
        if dup:
            raise HTTPException(409, f'学号 {body.学号} 已被其他学生使用')
    updates = ','.join(f'[{k}]=?' for k in STUDENT_COLUMNS)
    vals = tuple(getattr(body, k) for k in STUDENT_COLUMNS)
    conn.execute(
        f'UPDATE students SET {updates}, updated_at=datetime(\'now\',\'localtime\') WHERE id=?',
        (*vals, sid))
    audit.record('student', sid, 'update', summary=f'更新学生：{body.姓名}',
                 params=body.model_dump(), conn=conn, commit=False)
    conn.commit()
    return {'ok': True}


@router.delete('/{sid}')
def delete_student(sid: int):
    try:
        return recycle.soft_delete('student', sid)
    except class_context.ArchivedScopeError:
        raise
    except class_context.ScopeError as exc:
        raise HTTPException(404, str(exc)) from exc
    except recycle.RecycleError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get('/template')
def download_template():
    return _xlsx_response(build_template(), '学生信息导入模板.xlsx')


@router.post('/import')
async def upload_import(file: UploadFile = File(...)):
    data = await file.read()
    result = import_students(data, file.filename or '')
    return result


@router.post('/import/preview')
async def preview_import(file: UploadFile = File(...)):
    data = await file.read()
    return preview_students(data, file.filename or '')


@router.post('/import/commit')
def commit_import(body: StudentImportCommitBody):
    rows = [{'row': item.row, 'fields': item.fields} for item in body.rows]
    return commit_student_import(rows, body.filename)


@router.get('/export')
def export_students_xlsx():
    buf, fname = export_students()
    return _xlsx_response(buf, fname)
