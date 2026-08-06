# -*- coding: utf-8 -*-
"""微信扫码授权状态机。"""
from __future__ import annotations

from dataclasses import dataclass
from time import time
from typing import Any

from .credential_store import CredentialStore
from .ilink_client import ILinkClient, ILinkError
from .models import ILinkCredentials


@dataclass
class QRLogin:
    qrcode: str
    image_content: str
    started_at: float
    status: str = 'waiting'


class AuthService:
    def __init__(self, client: ILinkClient, credential_store: CredentialStore):
        self.client = client
        self.credential_store = credential_store
        self.current: QRLogin | None = None

    async def start(self) -> dict[str, Any]:
        payload = await self.client.get_bot_qrcode()
        qrcode = str(payload.get('qrcode') or '')
        if not qrcode:
            raise ILinkError('iLink 没有返回二维码标识')
        self.current = QRLogin(
            qrcode=qrcode,
            image_content=str(payload.get('qrcode_img_content') or ''),
            started_at=time(),
        )
        return self.status()

    async def poll(self) -> dict[str, Any]:
        if not self.current:
            raise ILinkError('请先请求新的微信登录二维码')
        payload = await self.client.get_qrcode_status(self.current.qrcode)
        credentials = _credentials_from(payload)
        if credentials:
            self.credential_store.save(credentials)
            self.client.set_credentials(credentials)
            self.current.status = 'confirmed'
        else:
            self.current.status = _status_from(payload)
        result = self.status()
        if self.current.status == 'confirmed':
            result['account_id'] = credentials.account_id if credentials else ''
        return result

    def status(self) -> dict[str, Any]:
        if not self.current:
            return {'status': 'idle', 'qrcode': '', 'qrcode_img_content': ''}
        return {
            'status': self.current.status,
            'qrcode': self.current.qrcode,
            'qrcode_img_content': self.current.image_content,
            'started_at': self.current.started_at,
        }


def _credentials_from(payload: dict[str, Any]) -> ILinkCredentials | None:
    token = str(payload.get('bot_token') or payload.get('ilink_bot_token') or '')
    if not token:
        return None
    return ILinkCredentials(
        bot_token=token,
        base_url=str(payload.get('base_url') or payload.get('baseurl') or 'https://ilinkai.weixin.qq.com').rstrip('/'),
        account_id=str(payload.get('ilink_bot_id') or payload.get('account_id') or ''),
        ilink_user_id=str(payload.get('ilink_user_id') or ''),
    )


def _status_from(payload: dict[str, Any]) -> str:
    value = str(payload.get('status') or payload.get('state') or '').lower()
    if value in {'confirmed', 'confirm', '2', 'logged_in'}:
        return 'confirmed'
    if value in {'scanned', 'scaned', '1'}:
        return 'scanned'
    if value in {'expired', '3'}:
        return 'expired'
    return 'waiting'
