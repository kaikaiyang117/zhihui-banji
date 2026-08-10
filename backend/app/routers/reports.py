# -*- coding: utf-8 -*-
"""周报、月报、成长报告和学期档案接口。"""
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..services import reports
from ..agent import report_drafter

router = APIRouter(prefix='/api/reports')


class ReportRequest(BaseModel):
    report_type: str = Field(default='weekly', min_length=1)
    period_start: str = ''
    period_end: str = ''
    student_id: Optional[int] = None
    class_summary: str = Field(default='', max_length=5000)
    teacher_summary: str = Field(default='', max_length=5000)
    next_term_plan: str = Field(default='', max_length=5000)


class AIReportPreviewBody(BaseModel):
    instruction: str = Field(default='', max_length=1000)


def _call(action, *args, **kwargs):
    try:
        return action(*args, **kwargs)
    except reports.ReportError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post('/preview')
def preview(body: ReportRequest):
    return _call(reports.build_report, body.report_type, body.period_start,
                 body.period_end, body.student_id)


@router.get('/archives')
def list_archives(report_type: str = ''):
    return {'archives': _call(reports.list_archives, report_type)}


@router.post('/archives')
def create_archive(body: ReportRequest):
    return _call(reports.create_archive, body.report_type, body.period_start,
                 body.period_end, body.student_id,
                 class_summary=body.class_summary,
                 teacher_summary=body.teacher_summary,
                 next_term_plan=body.next_term_plan)


@router.post('/ai/preview')
async def preview_ai_report(body: AIReportPreviewBody):
    try:
        report = reports.build_report('term')
        return await report_drafter.generate_draft(report=report, instruction=body.instruction)
    except report_drafter.ReportAIDraftError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/archives/{archive_id}')
def get_archive(archive_id: int):
    return _call(reports.get_archive, archive_id)


@router.get('/archives/{archive_id}/export')
def export_archive(archive_id: int):
    try:
        buf, filename = reports.export_archive(archive_id)
    except reports.ReportError as exc:
        raise HTTPException(404, str(exc)) from exc
    import urllib.parse
    quoted = urllib.parse.quote(filename)
    return StreamingResponse(
        buf,
        media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        headers={'Content-Disposition': f"attachment; filename*=UTF-8''{quoted}"},
    )
