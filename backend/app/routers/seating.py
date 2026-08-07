# -*- coding: utf-8 -*-
"""座位表路由"""
from fastapi import APIRouter
from pydantic import BaseModel

from .. import db
from ..services.class_context import scope_ids

router = APIRouter(prefix='/api/seating')


class SeatingUpdate(BaseModel):
    row: int
    col: int
    value: str = ''


@router.get('')
def get_seating():
    class_id, term_id = scope_ids(conn=db.get_conn())
    rows = db.get_conn().execute(
        'SELECT r, c, val FROM seating WHERE class_id=? AND term_id=?',
        (class_id, term_id),
    ).fetchall()
    grid = []
    specials = {}
    for row in rows:
        while len(grid) <= row['r']:
            grid.append([])
        while len(grid[row['r']]) <= row['c']:
            grid[row['r']].append('')
        grid[row['r']][row['c']] = row['val']
        if row['val'] in ('讲台', '前门', '后门', '过道'):
            specials[f"{row['r']},{row['c']}"] = row['val']
    return {'grid': grid, 'specials': specials,
            'rows': len(grid), 'cols': len(grid[0]) if grid else 0}


@router.post('/update')
def update_seating(body: SeatingUpdate):
    conn = db.get_conn()
    class_id, term_id = scope_ids(write=True, conn=conn)
    conn.execute(
        'INSERT OR REPLACE INTO seating(class_id, term_id, r, c, val) VALUES(?,?,?,?,?)',
        (class_id, term_id, body.row, body.col, body.value))
    conn.commit()
    return {'ok': True}
