# -*- coding: utf-8 -*-
"""班会、活动、日志的结构化业务 API。"""
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..services import education

router = APIRouter(prefix='/api/education')


def _error(exc: education.EducationError):
    raise HTTPException(400, str(exc)) from exc


@router.get('/templates')
def list_templates():
    return education.list_templates()


@router.post('/templates')
def create_template(body: dict):
    try:
        return education.create_template(
            str(body.get('kind', 'meeting')),
            name=body.get('name', ''), content=body.get('content', ''),
            format=body.get('format', '主题班会'), activity_type=body.get('activity_type', '其他'),
            description=body.get('description', ''),
        )
    except education.EducationError as exc:
        _error(exc)


@router.get('/meetings')
def list_meetings(query: str = '', date_from: str = '', date_to: str = ''):
    try:
        return {'meetings': education.list_meetings(query=query, date_from=date_from, date_to=date_to)}
    except education.EducationError as exc:
        _error(exc)


@router.get('/meetings/{meeting_id}')
def get_meeting(meeting_id: int):
    try:
        items = education.list_meetings(conn=None)
        return next(item for item in items if item['id'] == meeting_id)
    except StopIteration as exc:
        raise HTTPException(404, '班会记录不存在') from exc
    except education.EducationError as exc:
        _error(exc)


@router.post('/meetings')
def create_meeting(body: dict):
    try:
        return education.create_meeting(**body)
    except TypeError as exc:
        raise HTTPException(400, f'班会参数不完整：{exc}') from exc
    except education.EducationError as exc:
        _error(exc)


@router.put('/meetings/{meeting_id}')
def update_meeting(meeting_id: int, body: dict):
    try:
        return education.update_meeting(meeting_id, values=body)
    except education.EducationError as exc:
        _error(exc)


@router.delete('/meetings/{meeting_id}')
def delete_meeting(meeting_id: int):
    try:
        return education.delete_record('meeting', meeting_id)
    except education.EducationError as exc:
        _error(exc)


@router.get('/activities')
def list_activities(query: str = '', date_from: str = '', date_to: str = ''):
    try:
        return {'activities': education.list_activities(query=query, date_from=date_from, date_to=date_to)}
    except education.EducationError as exc:
        _error(exc)


@router.get('/activities/{activity_id}')
def get_activity(activity_id: int):
    try:
        items = education.list_activities()
        return next(item for item in items if item['id'] == activity_id)
    except StopIteration as exc:
        raise HTTPException(404, '活动记录不存在') from exc
    except education.EducationError as exc:
        _error(exc)


@router.post('/activities')
def create_activity(body: dict):
    try:
        return education.create_activity(**body)
    except TypeError as exc:
        raise HTTPException(400, f'活动参数不完整：{exc}') from exc
    except education.EducationError as exc:
        _error(exc)


@router.put('/activities/{activity_id}')
def update_activity(activity_id: int, body: dict):
    try:
        return education.update_activity(activity_id, values=body)
    except education.EducationError as exc:
        _error(exc)


@router.delete('/activities/{activity_id}')
def delete_activity(activity_id: int):
    try:
        return education.delete_record('activity', activity_id)
    except education.EducationError as exc:
        _error(exc)


@router.post('/activities/{activity_id}/attachments')
async def upload_activity_attachment(activity_id: int, file: UploadFile = File(...)):
    try:
        return education.save_activity_attachment(
            activity_id, filename=file.filename or '附件', content=await file.read(),
            mime_type=file.content_type or '',
        )
    except education.EducationError as exc:
        _error(exc)


@router.get('/activities/attachments/{attachment_id}')
def download_activity_attachment(attachment_id: int):
    try:
        path = education.activity_attachment_path(attachment_id)
        return FileResponse(path)
    except education.EducationError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get('/diary')
def list_diary(month: str = '', date_from: str = '', date_to: str = ''):
    try:
        return {'entries': education.list_diary(month=month, date_from=date_from, date_to=date_to)}
    except education.EducationError as exc:
        _error(exc)


@router.post('/diary')
def create_diary(body: dict):
    try:
        return education.create_diary(**body)
    except TypeError as exc:
        raise HTTPException(400, f'日志参数不完整：{exc}') from exc
    except education.EducationError as exc:
        _error(exc)


@router.put('/diary/{diary_id}')
def update_diary(diary_id: int, body: dict):
    try:
        return education.update_diary(diary_id, values=body)
    except education.EducationError as exc:
        _error(exc)


@router.delete('/diary/{diary_id}')
def delete_diary(diary_id: int):
    try:
        return education.delete_record('diary', diary_id)
    except education.EducationError as exc:
        _error(exc)


@router.post('/migrate')
def migrate_legacy_rows():
    try:
        return education.migrate_legacy_rows()
    except education.EducationError as exc:
        _error(exc)
