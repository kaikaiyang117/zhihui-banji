# -*- coding: utf-8 -*-
"""座位表路由"""
from fastapi import APIRouter
from pydantic import BaseModel

from .. import db

router = APIRouter(prefix='/api/seating')


class SeatingUpdate(BaseModel):
    row: int
    col: int
    value: str = ''


@router.get('')
def get_seating():
    rows = db.get_conn().execute('SELECT r, c, val FROM seating').fetchall()
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
    conn.execute('INSERT OR REPLACE INTO seating(r, c, val) VALUES(?,?,?)',
                 (body.row, body.col, body.value))
    conn.commit()
    return {'ok': True}
