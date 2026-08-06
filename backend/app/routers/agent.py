# -*- coding: utf-8 -*-
"""Agent 基础接口：工具发现、只读调用和审计查看。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..agent.agent_service import invoke_tool, list_audits, list_tools
from ..agent.tool_registry import ToolError

router = APIRouter(prefix='/api/agent')


class ToolExecuteBody(BaseModel):
    arguments: dict = Field(default_factory=dict)
    channel: str = 'local'
    actor_id: str = ''


@router.get('/status')
def agent_status():
    return {
        'enabled': True,
        'model': 'not_configured',
        'wechat': 'not_configured',
        'tool_count': len(list_tools()),
        'message': 'Agent 工具基础层已就绪，微信和模型尚未接入。',
    }


@router.get('/tools')
def agent_tools():
    return {'tools': list_tools()}


@router.post('/tools/{tool_name}')
def execute_agent_tool(tool_name: str, body: ToolExecuteBody):
    try:
        result = invoke_tool(
            tool_name,
            body.arguments,
            channel=body.channel,
            actor_id=body.actor_id,
        )
        return {'ok': True, 'tool': tool_name, 'result': result}
    except ToolError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/audit')
def agent_audit(limit: int = Query(50, ge=1, le=200)):
    return {'audits': list_audits(limit)}
