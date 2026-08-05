# -*- coding: utf-8 -*-
"""学生信息 Excel 导入：模板下载 + 文件解析 + 按学号合并去重"""
from __future__ import annotations

import io
import re

from openpyxl import Workbook, load_workbook

from .config import STUDENT_COLUMNS
from .db import get_conn

NORMALIZE = {
    '学号': '学号', '姓名': '姓名', '性别': '性别', '出生年月': '出生年月',
    '民族': '民族', '家庭住址': '家庭住址', '监护人姓名': '监护人姓名',
    '监护人电话': '监护人电话', '监护人职业': '监护人职业', '是否住校': '是否住校',
    '特长': '特长', '班级任职': '班级任职', '备注': '备注',
}


def _norm(s: str) -> str:
    return re.sub(r'\s+', '', str(s or '')).strip()


def build_template() -> io.BytesIO:
    """生成学生信息导入模板 xlsx"""
    wb = Workbook()
    ws = wb.active
    ws.title = '学生信息'
    for i, h in enumerate(STUDENT_COLUMNS, 1):
        ws.cell(row=1, column=i, value=h)
        ws.cell(row=1, column=i).font = ws.cell(row=1, column=i).font.copy(weight='bold')
    for i, example in enumerate(['2201', '张三', '男', '2010-05', '汉', '汶川县威州镇',
                                 '张大明', '13800000000', '务农', '住校', '书法', '纪律委员'], 1):
        ws.cell(row=2, column=i, value=example)
    ws.cell(row=1, column=13).comment = None
    for col, width in zip('ABCDEFGHIJKLM', [10, 10, 6, 10, 6, 22, 10, 14, 8, 8, 10, 10, 30]):
        ws.column_dimensions[col].width = width
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def import_students(file_bytes: bytes, filename: str = '') -> dict:
    """解析上传的 Excel，按学号合并导入。
    返回 {imported, updated, skipped, errors:[{row,msg}]}
    """
    conn = get_conn()
    result = {'imported': 0, 'updated': 0, 'skipped': 0, 'errors': []}
    try:
        wb = load_workbook(io.BytesIO(file_bytes), data_only=True)
    except Exception as e:
        return {'imported': 0, 'updated': 0, 'skipped': 0,
                'errors': [{'row': 0, 'msg': f'文件无法解析: {e}'}]}

    ws = wb.active if wb.active is not None else wb.worksheets[0]

    # 定位表头行（第一个包含「学号」「姓名」的行）
    header_row = -1
    col_map = {}
    for r in range(1, min(ws.max_row, 10) + 1):
        row_hdr = {}
        for c in range(1, ws.max_column + 1):
            v = ws.cell(row=r, column=c).value
            key = _norm(v)
            if not key:
                continue
            mapped = NORMALIZE.get(key)
            if mapped:
                row_hdr[mapped] = c
        if '学号' in row_hdr and '姓名' in row_hdr:
            header_row = r
            col_map = row_hdr
            break

    if header_row <= 0:
        return {'imported': 0, 'updated': 0, 'skipped': 0,
                'errors': [{'row': 1, 'msg': '未找到表头，需包含「学号」「姓名」列（列名不能带多余空格/换行）'}]}

    def get_val(r, key):
        c = col_map.get(key)
        if not c:
            return None
        v = ws.cell(row=r, column=c).value
        if isinstance(v, float) and v.is_integer():
            return str(int(v))
        return v

    for r in range(header_row + 1, ws.max_row + 1):
        xh = _norm(get_val(r, '学号'))
        name = _norm(get_val(r, '姓名'))
        if not xh and not name:
            continue  # 跳过空行
        if not xh:
            result['errors'].append({'row': r, 'msg': f'姓名「{name}」缺少学号，已跳过'})
            result['skipped'] += 1
            continue
        fields = {k: get_val(r, k) for k in STUDENT_COLUMNS}
        fields['学号'] = xh
        fields['姓名'] = name
        vals = tuple(fields.values())
        cols = ','.join(f'[{k}]' for k in STUDENT_COLUMNS)
        placeholders = ','.join('?' for _ in STUDENT_COLUMNS)
        existing = conn.execute('SELECT id FROM students WHERE 学号=?', (xh,)).fetchone()
        if existing:
            upd = ','.join(f'[{k}]=?' for k in STUDENT_COLUMNS)
            conn.execute(
                f'UPDATE students SET {upd}, updated_at=datetime(\'now\',\'localtime\') WHERE 学号=?',
                (*vals, xh))
            result['updated'] += 1
        else:
            conn.execute(
                f'INSERT INTO students({cols}) VALUES({placeholders})', vals)
            result['imported'] += 1

    conn.commit()
    wb.close()
    return result