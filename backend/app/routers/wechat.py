# -*- coding: utf-8 -*-
"""微信 iLink 登录和连接状态接口。"""
from fastapi import APIRouter, HTTPException

from ..wechat.ilink_client import ILinkError
from ..wechat.service import wechat_service

router = APIRouter(prefix='/api/wechat')


@router.get('/status')
def wechat_status():
    return wechat_service.status()


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
