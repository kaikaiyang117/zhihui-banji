# -*- coding: utf-8 -*-
"""通用工作表路由：读取 / 追加 / 更新 / 删除"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db
from ..config import SHEET_META
from ..derived import derive

router = APIRouter(prefix='/api')


class AppendBody(BaseModel):
    data: list


class UpdateBody(BaseModel):
    row_no: int
    col: int
    value: object = None


@router.get('/sheets')
def list_sheets():
    out = []
    for sheet, meta in SHEET_META.items():
        db_meta = db.get_sheet_meta(sheet)
        headers = db_meta['headers'] if db_meta else []
        out.append({
            'name': sheet,
            'category': meta['category'],
            'group': meta['group'],
            'headers': headers,
        })
    return out


@router.get('/sheet/{name}')
def get_sheet(name: str):
    if name not in SHEET_META:
        raise HTTPException(404, f'工作表 "{name}" 不存在')
    meta = db.get_sheet_meta(name)
    headers = meta['headers'] if meta else []
    rows = derive(name, db.get_rows(name))
    return {'name': name, 'headers': headers,
            'rows': [{'row_no': r['row_no'], 'data': r['data']} for r in rows]}


@router.post('/sheet/{name}/append')
def append_row(name: str, body: AppendBody):
    if name not in SHEET_META:
        raise HTTPException(404, f'工作表 "{name}" 不存在')
    if not body.data:
        raise HTTPException(400, '缺少 data 参数')
    row_no = db.insert_row(name, body.data)
    return {'ok': True, 'row_no': row_no}


@router.put('/sheet/{name}/update')
def update_cell(name: str, body: UpdateBody):
    if name not in SHEET_META:
        raise HTTPException(404, f'工作表 "{name}" 不存在')
    try:
        db.update_cell(name, body.row_no, body.col, body.value)
    except KeyError:
        raise HTTPException(404, f'行 {body.row_no} 不存在')
    return {'ok': True, 'row_no': body.row_no, 'col': body.col}


@router.delete('/sheet/{name}/row/{row_no}')
def delete_row(name: str, row_no: int):
    if name not in SHEET_META:
        raise HTTPException(404, f'工作表 "{name}" 不存在')
    db.delete_row(name, row_no)
    return {'ok': True}
