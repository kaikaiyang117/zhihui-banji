# -*- coding: utf-8 -*-
"""学生信息（结构化表）+ Excel 导入"""
import urllib.parse

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse

from .. import db
from ..config import STUDENT_COLUMNS
from ..import_service import build_template, import_students
from ..export_service import export_students

router = APIRouter(prefix='/api/students')

_MEDIA = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


def _xlsx_response(buf, fname: str):
    quoted = urllib.parse.quote(fname)
    return StreamingResponse(
        buf, media_type=_MEDIA,
        headers={'Content-Disposition': f"attachment; filename*=UTF-8''{quoted}"})


@router.get('')
def list_students(keyword: str = ''):
    conn = db.get_conn()
    sql = f'SELECT id, {",".join("["+k+"]" for k in STUDENT_COLUMNS)} FROM students'
    params: tuple = ()
    if keyword:
        sql += ' WHERE 姓名 LIKE ? OR 学号 LIKE ?'
        params = (f'%{keyword}%', f'%{keyword}%')
    sql += ' ORDER BY 学号'
    rows = conn.execute(sql, params).fetchall()
    return {'students': [dict(r) for r in rows]}


@router.delete('/{sid}')
def delete_student(sid: int):
    conn = db.get_conn()
    cur = conn.execute('DELETE FROM students WHERE id=?', (sid,))
    conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, '学生不存在')
    return {'ok': True}


@router.get('/template')
def download_template():
    return _xlsx_response(build_template(), '学生信息导入模板.xlsx')


@router.post('/import')
async def upload_import(file: UploadFile = File(...)):
    data = await file.read()
    result = import_students(data, file.filename or '')
    return result


@router.get('/export')
def export_students_xlsx():
    buf, fname = export_students()
    return _xlsx_response(buf, fname)