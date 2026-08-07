# -*- coding: utf-8 -*-
"""结构化班费分类账接口。"""
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..services import funds as funds_service

router = APIRouter(prefix='/api/fund')


class FundEntryBody(BaseModel):
    occurred_at: str = ''
    direction: str = '支出'
    amount: float
    category_id: Optional[int] = None
    category: str = ''
    description: str = Field(min_length=1)
    handler: str = ''
    witness: str = ''
    note: str = ''


class FundEntryUpdateBody(BaseModel):
    occurred_at: Optional[str] = None
    direction: Optional[str] = None
    amount: Optional[float] = None
    category_id: Optional[int] = None
    category: Optional[str] = None
    description: Optional[str] = None
    handler: Optional[str] = None
    witness: Optional[str] = None
    note: Optional[str] = None


class FundReasonBody(BaseModel):
    reason: str = Field(min_length=1)
    occurred_at: str = ''


class FundCategoryBody(BaseModel):
    name: str = Field(min_length=1)
    direction: str = '支出'


class FundCategoryUpdateBody(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None


class FundSettlementBody(BaseModel):
    period_key: str = ''
    period_start: str = ''
    period_end: str = ''
    counted_balance: Optional[float] = None
    note: str = ''


class FundSettlementReconcileBody(BaseModel):
    counted_balance: Optional[float] = None
    note: Optional[str] = None


def _error(exc: funds_service.FundError):
    message = str(exc)
    status = 404 if '不存在' in message or '不在当前' in message else 400
    raise HTTPException(status, message) from exc


@router.get('')
def get_fund(
    date_from: str = '', date_to: str = '', direction: str = '', status: str = '',
    category: str = '', limit: int = Query(500, ge=1, le=5000),
):
    try:
        return {
            'summary': funds_service.class_summary(),
            'entries': funds_service.list_entries(
                date_from=date_from, date_to=date_to, direction=direction,
                status=status, category=category, limit=limit),
        }
    except funds_service.FundError as exc:
        _error(exc)


@router.get('/categories')
def list_fund_categories(include_disabled: bool = False):
    try:
        return {'categories': funds_service.list_categories(include_disabled=include_disabled)}
    except funds_service.FundError as exc:
        _error(exc)


@router.post('/categories')
def create_fund_category(body: FundCategoryBody):
    try:
        return {'ok': True, 'category': funds_service.create_category(**body.model_dump())}
    except funds_service.FundError as exc:
        _error(exc)


@router.put('/categories/{category_id}')
def update_fund_category(category_id: int, body: FundCategoryUpdateBody):
    try:
        return {'ok': True, 'category': funds_service.update_category(
            category_id, **body.model_dump(exclude_none=True))}
    except funds_service.FundError as exc:
        _error(exc)


@router.post('/entries')
def create_fund_entry(body: FundEntryBody):
    try:
        return {'ok': True, 'entry': funds_service.create_entry(**body.model_dump())}
    except funds_service.FundError as exc:
        _error(exc)


@router.put('/entries/{entry_id}')
def update_fund_entry(entry_id: int, body: FundEntryUpdateBody):
    try:
        return {'ok': True, 'entry': funds_service.update_entry(
            entry_id, **body.model_dump(exclude_none=True))}
    except funds_service.FundError as exc:
        _error(exc)


@router.post('/entries/{entry_id}/revoke')
def revoke_fund_entry(entry_id: int, body: FundReasonBody):
    try:
        return {'ok': True, 'entry': funds_service.revoke_entry(entry_id, body.reason)}
    except funds_service.FundError as exc:
        _error(exc)


@router.post('/entries/{entry_id}/reverse')
def reverse_fund_entry(entry_id: int, body: FundReasonBody):
    try:
        return {'ok': True, 'entry': funds_service.reverse_entry(
            entry_id, body.reason, occurred_at=body.occurred_at)}
    except funds_service.FundError as exc:
        _error(exc)


@router.get('/settlements')
def list_fund_settlements():
    try:
        return {'settlements': funds_service.list_settlements()}
    except funds_service.FundError as exc:
        _error(exc)


@router.post('/settlements')
def create_fund_settlement(body: FundSettlementBody):
    try:
        return {'ok': True, 'settlement': funds_service.create_settlement(**body.model_dump())}
    except funds_service.FundError as exc:
        _error(exc)


@router.post('/settlements/{settlement_id}/reconcile')
def reconcile_fund_settlement(settlement_id: int, body: FundSettlementReconcileBody):
    try:
        return {'ok': True, 'settlement': funds_service.reconcile_settlement(
            settlement_id, **body.model_dump(exclude_none=True))}
    except funds_service.FundError as exc:
        _error(exc)


@router.post('/entries/{entry_id}/attachments')
async def upload_fund_attachment(entry_id: int, file: UploadFile = File(...)):
    try:
        attachment = funds_service.save_attachment(
            entry_id, filename=file.filename or '班费凭证',
            content_type=file.content_type or 'application/octet-stream', content=await file.read())
        return {'ok': True, 'attachment': attachment}
    except funds_service.FundError as exc:
        _error(exc)


@router.get('/attachments/{attachment_id}')
def download_fund_attachment(attachment_id: int):
    try:
        attachment, path = funds_service.attachment_file(attachment_id)
        return FileResponse(path, media_type=attachment['content_type'], filename=attachment['original_name'])
    except funds_service.FundError as exc:
        _error(exc)
