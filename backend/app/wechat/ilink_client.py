# -*- coding: utf-8 -*-
"""微信 iLink HTTP + JSON 客户端。"""
from __future__ import annotations

import base64
import secrets
from dataclasses import dataclass
from typing import Any

import httpx

from .models import ILinkCredentials


class ILinkError(Exception):
    """iLink 请求或协议错误。"""


@dataclass(frozen=True)
class ILinkConfig:
    base_url: str = 'https://ilinkai.weixin.qq.com'
    timeout_seconds: float = 40.0


class ILinkClient:
    def __init__(
        self,
        config: ILinkConfig | None = None,
        credentials: ILinkCredentials | None = None,
        http_client: httpx.AsyncClient | None = None,
    ):
        self.config = config or ILinkConfig()
        self.credentials = credentials
        self._http_client = http_client

    def set_credentials(self, credentials: ILinkCredentials | None):
        self.credentials = credentials
        if credentials and credentials.base_url:
            self.config = ILinkConfig(
                base_url=credentials.base_url.rstrip('/'),
                timeout_seconds=self.config.timeout_seconds,
            )

    async def get_bot_qrcode(self, bot_type: int = 3) -> dict[str, Any]:
        return await self._request('GET', 'get_bot_qrcode', params={'bot_type': bot_type}, auth=False)

    async def get_qrcode_status(self, qrcode: str) -> dict[str, Any]:
        return await self._request('GET', 'get_qrcode_status', params={'qrcode': qrcode}, auth=False)

    async def get_updates(self, get_updates_buf: str = '') -> dict[str, Any]:
        return await self._request('POST', 'getupdates', {'get_updates_buf': get_updates_buf})

    async def send_message(self, to_user_id: str, context_token: str, text: str) -> dict[str, Any]:
        return await self._request('POST', 'sendmessage', {
            'msg': {
                'to_user_id': to_user_id,
                'context_token': context_token,
                'item_list': [{'type': 1, 'text_item': {'text': text}}],
            }
        })

    async def get_config(self, ilink_user_id: str, context_token: str = '') -> dict[str, Any]:
        return await self._request('POST', 'getconfig', {
            'ilink_user_id': ilink_user_id,
            'context_token': context_token,
        })

    async def send_typing(self, ilink_user_id: str, typing_ticket: str, status: int) -> dict[str, Any]:
        return await self._request('POST', 'sendtyping', {
            'ilink_user_id': ilink_user_id,
            'typing_ticket': typing_ticket,
            'status': status,
        })

    async def close(self):
        if self._http_client is not None:
            await self._http_client.aclose()

    async def _request(
        self,
        method: str,
        endpoint: str,
        body: dict[str, Any] | None = None,
        *,
        params: dict[str, Any] | None = None,
        auth: bool = True,
    ) -> dict[str, Any]:
        headers = {'Content-Type': 'application/json'}
        if auth:
            if not self.credentials or not self.credentials.bot_token:
                raise ILinkError('微信尚未完成扫码授权')
            headers.update({
                'AuthorizationType': 'ilink_bot_token',
                'Authorization': f'Bearer {self.credentials.bot_token}',
                'X-WECHAT-UIN': _random_uin(),
            })
        url = f'{self.config.base_url.rstrip("/")}/ilink/bot/{endpoint}'
        client = self._http_client
        owns_client = client is None
        if owns_client:
            client = httpx.AsyncClient(timeout=self.config.timeout_seconds)
        try:
            response = await client.request(method, url, headers=headers, params=params, json=body)
            if response.status_code >= 400:
                raise ILinkError(f'iLink 返回 HTTP {response.status_code}: {response.text[:300]}')
            try:
                data = response.json()
            except ValueError as exc:
                raise ILinkError('iLink 返回了无效 JSON') from exc
            if isinstance(data, dict) and data.get('ret') not in (None, 0):
                raise ILinkError(f"iLink 错误 {data.get('errcode', data.get('ret'))}: {data.get('errmsg', '')}")
            return data
        except httpx.HTTPError as exc:
            raise ILinkError(f'iLink 网络请求失败：{exc}') from exc
        finally:
            if owns_client:
                await client.aclose()


def _random_uin() -> str:
    value = str(secrets.randbelow(2**32))
    return base64.b64encode(value.encode('ascii')).decode('ascii')
