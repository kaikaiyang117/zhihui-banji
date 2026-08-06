# -*- coding: utf-8 -*-
"""Agent 基础接口：工具发现、只读调用和审计查看。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..agent.agent_service import invoke_tool, list_audits, list_tools
from ..agent.model_client import ModelError, ModelConfig
from ..agent.runner import AgentRunner
from ..agent.session_store import SessionStore
from ..agent.tool_registry import ToolError
from ..wechat.service import wechat_service

router = APIRouter(prefix='/api/agent')


class ToolExecuteBody(BaseModel):
    arguments: dict = Field(default_factory=dict)
    channel: str = 'local'
    actor_id: str = ''


class ChatBody(BaseModel):
    session_id: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=4000)
    channel: str = 'local'
    actor_id: str = ''


@router.get('/status')
def agent_status():
    config = ModelConfig.from_env()
    return {
        'enabled': True,
        'model': config.model or 'not_configured',
        'model_configured': config.configured,
        'wechat': 'iLink',
        'wechat_configured': wechat_service.status()['configured'],
        'wechat_running': wechat_service.status()['running'],
        'tool_count': len(list_tools()),
        'message': 'Agent 工具、模型客户端和微信接入接口已就绪，是否启用取决于本地配置。',
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


@router.post('/chat')
async def agent_chat(body: ChatBody):
    try:
        answer = await AgentRunner(session_store=SessionStore()).chat(
            body.session_id,
            body.message,
            channel=body.channel,
            actor_id=body.actor_id,
        )
        return {'ok': True, 'session_id': body.session_id, 'answer': answer}
    except ModelError as exc:
        raise HTTPException(503, str(exc)) from exc


@router.delete('/sessions/{session_id}')
def clear_agent_session(session_id: str):
    SessionStore().clear(session_id)
    return {'ok': True}


@router.get('/audit')
def agent_audit(limit: int = Query(50, ge=1, le=200)):
    return {'audits': list_audits(limit)}
