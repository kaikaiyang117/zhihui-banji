# -*- coding: utf-8 -*-
"""微信登录、消息循环和 Agent 的组合服务。"""
from __future__ import annotations

import os
from typing import Any

from ..agent.model_client import ModelError
from ..agent.runner import AgentRunner
from .auth_service import AuthService
from .credential_store import CredentialStore
from .ilink_client import ILinkClient, ILinkConfig, ILinkError
from .message_loop import MessageLoop
from .models import IncomingText


class WeChatService:
    def __init__(self):
        self.credentials = CredentialStore()
        self.client = ILinkClient(ILinkConfig(
            base_url=os.environ.get('MEIMEI_WECHAT_BASE_URL', 'https://ilinkai.weixin.qq.com').rstrip('/'),
        ))
        self.auth = AuthService(self.client, self.credentials)
        self.loop: MessageLoop | None = None
        self.loop_task = None
        self.last_error = ''

    async def start_login(self):
        return await self.auth.start()

    async def poll_login(self):
        result = await self.auth.poll()
        if result['status'] == 'confirmed':
            await self.start_loop()
        return result

    async def start_loop(self):
        if self.loop_task and not self.loop_task.done():
            return {'running': True}
        credentials = self.credentials.load()
        if not credentials:
            raise ILinkError('微信尚未完成扫码授权，或未设置 MEIMEI_WECHAT_BOT_TOKEN')
        self.client.set_credentials(credentials)
        self.loop = MessageLoop(self.client, self._handle_message)
        import asyncio
        self.loop_task = asyncio.create_task(self.loop.run())
        return {'running': True}

    async def stop(self):
        import asyncio
        if self.loop:
            self.loop.stop()
        if self.loop_task:
            try:
                await asyncio.wait_for(asyncio.shield(self.loop_task), timeout=2.0)
            except asyncio.TimeoutError:
                self.loop_task.cancel()
                try:
                    await self.loop_task
                except asyncio.CancelledError:
                    pass
            except Exception:
                pass
            self.loop_task = None
        await self.client.close()

    def status(self) -> dict[str, Any]:
        credentials = self.credentials.load()
        return {
            'configured': bool(credentials),
            'running': bool(self.loop_task and not self.loop_task.done()),
            'login': self.auth.status(),
            'last_error': self.loop.last_error if self.loop else self.last_error,
            'processed': self.loop.processed if self.loop else 0,
            'account_id': credentials.account_id if credentials else '',
        }

    async def _handle_message(self, message: IncomingText):
        allowed = _allowed_users()
        if allowed and message.from_user_id not in allowed:
            await self.client.send_message(message.from_user_id, message.context_token, '你尚未获得美美工作台的使用授权。')
            return
        runner = AgentRunner()
        try:
            answer = await runner.chat(
                f'wechat:{message.from_user_id}',
                message.text,
                channel='wechat',
                actor_id=message.from_user_id,
            )
        except ModelError as exc:
            answer = f'美美助手暂时无法回答：{exc}'
        await self.client.send_message(message.from_user_id, message.context_token, answer)


def _allowed_users() -> set[str]:
    raw = os.environ.get('MEIMEI_WECHAT_ALLOW_USERS', '')
    return {item.strip() for item in raw.split(',') if item.strip()}


wechat_service = WeChatService()
