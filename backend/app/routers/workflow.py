# -*- coding: utf-8 -*-
"""事件、沟通和关注的过程记录与状态联动 API。"""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import workflow

router = APIRouter(prefix='/api/workflows')


class WorkflowUpdateBody(BaseModel):
    status: Optional[str] = None
    progress: str = ''
    result: str = ''
    next_action_at: Optional[str] = None
    task_action: Optional[str] = None
    request_id: str = ''
    fields: dict[str, str] = {}


def _run(action):
    try:
        return action()
    except workflow.WorkflowError as exc:
        status = 404 if '不存在' in str(exc) else 400
        raise HTTPException(status, str(exc)) from exc


@router.get('/{source_type}/{source_id}')
def get_workflow(source_type: str, source_id: int):
    return _run(lambda: workflow.get_workflow(source_type, source_id))


@router.put('/{source_type}/{source_id}')
def update_workflow(source_type: str, source_id: int, body: WorkflowUpdateBody):
    return _run(lambda: workflow.update_source(
        source_type, source_id, fields=body.fields, status=body.status,
        progress=body.progress, result=body.result,
        next_action_at=body.next_action_at, task_action=body.task_action,
        request_id=body.request_id,
    ))
