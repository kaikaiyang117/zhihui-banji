# -*- coding: utf-8 -*-
"""系统回收站与业务审计接口。"""
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from ..services import audit, recycle

router = APIRouter(prefix='/api')


class PurgeBody(BaseModel):
    confirmation: str = ''


def _error(exc: recycle.RecycleError):
    raise HTTPException(400, str(exc)) from exc


def _is_local_host(host: str) -> bool:
    return host in {'127.0.0.1', '::1', 'localhost', 'testclient'}


@router.get('/recycle-bin')
def list_recycle_bin(object_type: str = '', status: str = '已删除',
                     limit: int = Query(300, ge=1, le=500)):
    return {'items': recycle.list_entries(
        object_type=object_type, status=status, limit=limit)}


@router.delete('/records/{object_type}/{object_id}')
def delete_record(object_type: str, object_id: int):
    try:
        return recycle.soft_delete(object_type, object_id)
    except recycle.RecycleError as exc:
        _error(exc)


@router.post('/recycle-bin/{entry_id}/restore')
def restore_record(entry_id: int):
    try:
        return recycle.restore(entry_id)
    except recycle.RecycleError as exc:
        _error(exc)


@router.delete('/recycle-bin/{entry_id}/purge')
def purge_record(entry_id: int, body: PurgeBody, request: Request):
    host = request.client.host if request.client else ''
    if not _is_local_host(host):
        raise HTTPException(403, '永久删除只能在工作台本机操作')
    try:
        return recycle.purge(entry_id, body.confirmation)
    except recycle.RecycleError as exc:
        _error(exc)


@router.get('/system/audit')
def list_system_audit(limit: int = Query(200, ge=1, le=500)):
    return {'items': audit.list_audits(limit=limit)}
