# -*- coding: utf-8 -*-
"""Excel 导出：通用工作表导出 + 汇总报表"""
from __future__ import annotations

import io

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

from .config import STUDENT_COLUMNS
from .db import get_conn, get_rows, get_sheet_meta
from .derived import derive

HEADER_FILL = PatternFill('solid', fgColor='5B6ABF')
HEADER_FONT = Font(color='FFFFFF', bold=True)


def _sheet_bytes(title: str, headers: list[str], rows: list[list]) -> io.BytesIO:
    wb = Workbook()
    ws = wb.active
    ws.title = title[:31]
    for c, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=c, value=h)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
    for r, row in enumerate(rows, 2):
        for c, v in enumerate(row, 1):
            if v is not None:
                ws.cell(row=r, column=c, value=v)
    for c in range(1, len(headers) + 1):
        ws.column_dimensions[get_column_letter(c)].width = 16
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def export_sheet(sheet: str) -> tuple[io.BytesIO, str]:
    """通用工作表导出（含派生计算列）"""
    if sheet == '座位表':
        return export_seating()
    meta = get_sheet_meta(sheet)
    headers = meta['headers'] if meta else []
    rows = derive(sheet, get_rows(sheet))
    return _sheet_bytes(sheet, headers, [r['data'] for r in rows]), f'{sheet}.xlsx'


def export_seating() -> tuple[io.BytesIO, str]:
    """座位表导出（从 seating 表重建网格）"""
    rows = get_conn().execute('SELECT r, c, val FROM seating ORDER BY r, c').fetchall()
    max_r = max((row['r'] for row in rows), default=0)
    max_c = max((row['c'] for row in rows), default=0)
    grid = [['' for _ in range(max_c + 1)] for _ in range(max_r + 1)]
    for row in rows:
        grid[row['r']][row['c']] = row['val']
    while grid and all(v == '' for v in grid[0]):
        grid.pop(0)
    while grid and all(v == '' for v in grid[-1]):
        grid.pop()
    cols = len(grid[0]) if grid else 0
    for row in grid:
        while len(row) < cols:
            row.append('')
    headers = [f'第{c+1}列' for c in range(cols)]
    return _sheet_bytes('座位表', headers, grid), '座位表.xlsx'


def export_students() -> tuple[io.BytesIO, str]:
    rows = get_conn().execute(
        f'SELECT {",".join("["+k+"]" for k in STUDENT_COLUMNS)} FROM students ORDER BY 学号'
    ).fetchall()
    data = [[row[k] for k in STUDENT_COLUMNS] for row in rows]
    return _sheet_bytes('学生信息', STUDENT_COLUMNS, data), '学生信息总表.xlsx'


# ---------- 汇总报表 ----------

def export_score_report(exam: str) -> tuple[io.BytesIO, str]:
    """成绩汇总报表：exam = '月考1' 或 '期中'，输出各科+总分+排名"""
    rows = derive('成绩跟踪', get_rows('成绩跟踪'))
    if exam == '期中':
        idx_range, total_idx, rank_idx = range(10, 16), 16, 17
        subjects = ['语文期中', '数学期中', '英语期中', '政治期中', '历史期中', '地理期中']
        name = '期中'
    else:
        idx_range, total_idx, rank_idx = range(2, 8), 8, 9
        subjects = ['语文月考1', '数学月考1', '英语月考1', '政治月考1', '历史月考1', '地理月考1']
        name = '月考1'

    data = []
    for r in rows:
        d = r['data']
        if not any(v is not None for v in d[1:8]) and not any(v is not None for v in d[10:16]):
            continue
        total = sum(v for i in idx_range if (v := d[i]) is not None and isinstance(v, (int, float)))
        data.append([d[0], d[1]] + [d[i] for i in idx_range] + [total if total else None, d[rank_idx]])

    headers = ['学号', '姓名'] + subjects + ['总分', '班排名']
    # 按总分降序排序生成排名（若原表未填班排名）
    return _sheet_bytes(f'成绩汇总-{name}', headers, data), f'成绩汇总_{name}.xlsx'


def export_attendance_report(date_from: str | None, date_to: str | None) -> tuple[io.BytesIO, str]:
    """考勤汇总报表：按日期统计各状态数量"""
    rows = get_rows('考勤管理')
    headers = ['日期', '出勤', '迟到', '请假', '缺勤', '总人数']
    daily: dict[str, dict] = {}
    for r in rows:
        d = r['data']
        date = str(d[0] or '')[:10]
        if not date:
            continue
        if date_from and date < date_from:
            continue
        if date_to and date > date_to:
            continue
        status = str(d[4] or '').strip()
        day = daily.setdefault(date, {'出勤': 0, '迟到': 0, '请假': 0, '缺勤': 0, '总人数': 0})
        if status in day:
            day[status] += 1
        day['总人数'] += 1

    data = [[d, day['出勤'], day['迟到'], day['请假'], day['缺勤'], day['总人数']]
            for d, day in sorted(daily.items())]
    total = {'出勤': 0, '迟到': 0, '请假': 0, '缺勤': 0, '总人数': 0}
    for day in daily.values():
        for k in total:
            total[k] += day[k]
    data.append(['合计', total['出勤'], total['迟到'], total['请假'], total['缺勤'], total['总人数']])
    return _sheet_bytes('考勤汇总', headers, data), '考勤汇总.xlsx'