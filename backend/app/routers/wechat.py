# -*- coding: utf-8 -*-
"""微信 iLink 登录和连接状态接口。"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..wechat.ilink_client import ILinkError
from ..wechat.service import wechat_service

router = APIRouter(prefix='/api/wechat')


class WeChatPolicyBody(BaseModel):
    allow_all: bool = False
    allow_users: list[str] = Field(default_factory=list, max_length=200)


@router.get('/status')
def wechat_status():
    return wechat_service.status()


@router.get('/config')
def wechat_config():
    return wechat_service.policy()


@router.put('/config')
def update_wechat_config(body: WeChatPolicyBody):
    users = []
    for user_id in body.allow_users:
        normalized = user_id.strip()
        if normalized and normalized not in users:
            users.append(normalized)
    return {'ok': True, **wechat_service.update_policy(users, body.allow_all)}


@router.post('/login/start')
async def start_login():
    try:
        return await wechat_service.start_login()
    except ILinkError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.post('/login/poll')
async def poll_login():
    try:
        return await wechat_service.poll_login()
    except ILinkError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.post('/loop/start')
async def start_loop():
    try:
        return await wechat_service.start_loop()
    except ILinkError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post('/loop/stop')
async def stop_loop():
    await wechat_service.stop()
    return {'running': False}


@router.post('/reminders/send')
async def send_reminders():
    try:
        return await wechat_service.send_pending_reminders()
    except Exception as exc:
        raise HTTPException(400, f'微信提醒发送失败：{exc}') from exc
