# -*- coding: utf-8 -*-
"""学期校历 API。"""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from ..services import school_calendar

router = APIRouter(prefix='/api')


class CalendarEntryBody(BaseModel):
    calendar_date: str = Field(min_length=1, max_length=10)
    day_type: str = '上课日'
    title: str = ''
    is_school_day: bool = True
    note: str = ''


class CalendarImportCommitBody(BaseModel):
    filename: str = ''
    request_id: str = Field(min_length=1, max_length=120)
    rows: list[dict] = Field(default_factory=list)


def _run(action):
    try:
        return action()
    except school_calendar.CalendarError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/school-calendar')
def list_school_calendar(
    date_from: str = Query('', max_length=10),
    date_to: str = Query('', max_length=10),
    month: str = Query('', max_length=7),
):
    return _run(lambda: school_calendar.list_calendar(date_from=date_from, date_to=date_to, month=month))


@router.get('/school-calendar/term')
def term_school_calendar():
    return _run(school_calendar.term_calendar)


@router.post('/school-calendar/import/preview')
async def preview_school_calendar(file: UploadFile = File(...)):
    content = await file.read()
    return _run(lambda: school_calendar.preview_import(content, file.filename or ''))


@router.post('/school-calendar/import/commit')
def commit_school_calendar(body: CalendarImportCommitBody):
    return _run(lambda: school_calendar.commit_import(body.rows, body.filename, body.request_id))


@router.post('/school-calendar')
def create_school_calendar_entry(body: CalendarEntryBody):
    return _run(lambda: school_calendar.create_entry(
        body.calendar_date, body.day_type, body.title, body.is_school_day, body.note))


@router.put('/school-calendar/{entry_id}')
def update_school_calendar_entry(entry_id: int, body: CalendarEntryBody):
    return _run(lambda: school_calendar.update_entry(
        entry_id, body.calendar_date, body.day_type, body.title, body.is_school_day, body.note))
