# -*- coding: utf-8 -*-
"""Agent 基础接口：工具发现、只读调用和审计查看。"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..agent.agent_service import invoke_tool, list_audits, list_tools
from ..agent.model_config import load_local_config, public_config, save_local_config
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


class ModelConfigBody(BaseModel):
    api_key: str | None = None
    base_url: str = Field(min_length=1, max_length=500)
    model: str = Field(min_length=1, max_length=120)
    thinking: str = 'disabled'
    clear_api_key: bool = False


@router.get('/status')
def agent_status():
    config = ModelConfig.from_env()
    wechat = wechat_service.status()
    return {
        'enabled': True,
        'model': config.model or 'not_configured',
        'model_configured': config.configured,
        'wechat': 'iLink',
        'wechat_configured': wechat['configured'],
        'wechat_running': wechat['running'],
        'tool_count': len(list_tools()),
        'message': 'Agent 工具、模型客户端和微信接入接口已就绪，是否启用取决于本地配置。',
    }


@router.get('/tools')
def agent_tools():
    return {'tools': list_tools()}


@router.get('/config')
def agent_config():
    local = load_local_config()
    effective = ModelConfig.from_env()
    data = public_config({
        'api_key': effective.api_key,
        'base_url': effective.base_url,
        'model': effective.model,
        'thinking': effective.thinking,
    })
    data['storage'] = 'local'
    data['local_override_active'] = bool(local)
    return data


@router.put('/config')
def update_agent_config(body: ModelConfigBody):
    if body.thinking not in {'disabled', 'enabled'}:
        raise HTTPException(400, 'thinking 只能是 disabled 或 enabled')
    values = load_local_config()
    if body.clear_api_key:
        values.pop('api_key', None)
    elif body.api_key:
        values['api_key'] = body.api_key.strip()
    values.update({
        'base_url': body.base_url.rstrip('/'),
        'model': body.model.strip(),
        'thinking': body.thinking,
    })
    save_local_config(values)
    return {'ok': True, **public_config(values), 'storage': 'local'}


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


@router.post('/chat/stream')
async def agent_chat_stream(body: ChatBody):
    async def events():
        try:
            runner = AgentRunner(session_store=SessionStore())
            async for event in runner.chat_stream(
                body.session_id,
                body.message,
                channel=body.channel,
                actor_id=body.actor_id,
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except ModelError as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"
        except Exception:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Agent 流式响应失败，请稍后重试。'}, ensure_ascii=False)}\n\n"
        yield 'data: {"type":"done"}\n\n'

    return StreamingResponse(
        events(),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


@router.delete('/sessions/{session_id}')
def clear_agent_session(session_id: str):
    SessionStore().clear(session_id)
    return {'ok': True}


@router.get('/audit')
def agent_audit(limit: int = Query(50, ge=1, le=200)):
    return {'audits': list_audits(limit)}
