# -*- coding: utf-8 -*-
"""iLink getUpdates 长轮询和消息去重。"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from .. import db
from .ilink_client import ILinkClient, ILinkError
from .message_parser import parse_text_messages
from .models import IncomingText


MessageHandler = Callable[[IncomingText], Awaitable[None]]


class MessageLoop:
    def __init__(self, client: ILinkClient, handler: MessageHandler):
        self.client = client
        self.handler = handler
        self.cursor = db.get_agent_setting('wechat.get_updates_buf')
        self.stop_event = asyncio.Event()
        self.last_error = ''
        self.processed = 0

    async def run(self):
        delay = 1.0
        while not self.stop_event.is_set():
            try:
                await self.poll_once()
                delay = 1.0
            except ILinkError as exc:
                self.last_error = str(exc)
                await _sleep_or_stop(self.stop_event, delay)
                delay = min(delay * 2, 30.0)
            except Exception as exc:  # 不能让消息循环因单个未知错误退出
                self.last_error = str(exc)
                await _sleep_or_stop(self.stop_event, delay)
                delay = min(delay * 2, 30.0)

    async def poll_once(self):
        payload = await self.client.get_updates(self.cursor)
        for message in parse_text_messages(payload):
            if not db.claim_wechat_message(message.message_id):
                continue
            try:
                await self.handler(message)
            except Exception:
                db.mark_wechat_message(message.message_id, 'error')
                raise
            db.mark_wechat_message(message.message_id, 'processed')
            self.processed += 1
        cursor = str(payload.get('get_updates_buf') or '')
        if cursor:
            self.cursor = cursor
            db.set_agent_setting('wechat.get_updates_buf', cursor)

    def stop(self):
        self.stop_event.set()


async def _sleep_or_stop(event: asyncio.Event, seconds: float):
    try:
        await asyncio.wait_for(event.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass
