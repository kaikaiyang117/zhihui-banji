# -*- coding: utf-8 -*-
"""微信登录、消息循环和 Agent 的组合服务。"""
from __future__ import annotations

import os
from typing import Any

from ..agent.model_client import ModelError
from ..agent.runner import AgentRunner
from ..agent.session_store import SessionStore
from .auth_service import AuthService
from .config import public_config, save_config
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
        self.recent_senders: list[str] = []

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
        policy = public_config()
        session_expired = bool(self.loop and self.loop.session_expired)
        return {
            'configured': bool(credentials),
            'running': bool(self.loop_task and not self.loop_task.done()),
            'login': self.auth.status(),
            'last_error': self.loop.last_error if self.loop else self.last_error,
            'processed': self.loop.processed if self.loop else 0,
            'needs_relogin': session_expired,
            'account_id': credentials.account_id if credentials else '',
            'policy': policy,
            'recent_senders': list(self.recent_senders),
        }

    def policy(self) -> dict[str, Any]:
        return public_config()

    def update_policy(self, allow_users: list[str], allow_all: bool) -> dict[str, Any]:
        return save_config(allow_users, allow_all)

    async def _handle_message(self, message: IncomingText):
        self._remember_sender(message.from_user_id)
        policy = public_config()
        if not policy['allow_all'] and message.from_user_id not in set(policy['allow_users']):
            await self.client.send_message(
                message.from_user_id,
                message.context_token,
                f'你尚未获得美美工作台的使用授权。请管理员将此用户 ID 加入白名单：{message.from_user_id}',
            )
            return
        command = message.text.strip()
        if command in {'/新会话', '/清空会话'}:
            SessionStore().clear(f'wechat:{message.from_user_id}')
            await self.client.send_message(
                message.from_user_id,
                message.context_token,
                '已清空当前对话上下文，凯凯小兵准备开始新的对话。',
            )
            return
        typing_ticket = await self._start_typing(message)
        runner = AgentRunner()
        try:
            answer = await runner.chat(
                f'wechat:{message.from_user_id}',
                message.text,
                channel='wechat',
                actor_id=message.from_user_id,
            )
        except ModelError as exc:
            answer = f'凯凯小兵暂时无法回答：{exc}'
        finally:
            await self._stop_typing(message, typing_ticket)
        await self.client.send_message(message.from_user_id, message.context_token, answer)

    async def _start_typing(self, message: IncomingText) -> str:
        try:
            config = await self.client.get_config(message.from_user_id, message.context_token)
            ticket = str(config.get('typing_ticket') or '')
            if ticket:
                await self.client.send_typing(message.from_user_id, ticket, 1)
            return ticket
        except ILinkError:
            return ''

    async def _stop_typing(self, message: IncomingText, ticket: str):
        if not ticket:
            return
        try:
            await self.client.send_typing(message.from_user_id, ticket, 2)
        except ILinkError:
            pass

    def _remember_sender(self, user_id: str):
        if not user_id:
            return
        self.recent_senders = [item for item in self.recent_senders if item != user_id]
        self.recent_senders.insert(0, user_id)
        del self.recent_senders[20:]


wechat_service = WeChatService()
