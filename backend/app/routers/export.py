# -*- coding: utf-8 -*-
"""导出路由：工作表导出 + 成绩/考勤汇总报表"""
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..config import SHEET_META
from ..export_service import export_sheet, export_score_report, export_attendance_report

router = APIRouter(prefix='/api/export')

_MEDIA = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


def _response(buf, fname: str):
    import urllib.parse
    quoted = urllib.parse.quote(fname)
    return StreamingResponse(
        buf, media_type=_MEDIA,
        headers={'Content-Disposition': f"attachment; filename*=UTF-8''{quoted}"})


@router.get('/sheet/{name}')
def export_work_sheet(name: str, academic_year: str = ''):
    if name not in SHEET_META:
        raise HTTPException(404, f'工作表 "{name}" 不存在')
    buf, fname = export_sheet(name, academic_year=academic_year)
    return _response(buf, fname)


@router.get('/report/scores')
def report_scores(exam: str = '月考1'):
    try:
        buf, fname = export_score_report(exam)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return _response(buf, fname)


@router.get('/report/attendance')
def report_attendance(date_from: Optional[str] = None, date_to: Optional[str] = None):
    buf, fname = export_attendance_report(date_from, date_to)
    return _response(buf, fname)
