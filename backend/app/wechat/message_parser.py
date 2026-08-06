# -*- coding: utf-8 -*-
"""将 iLink 消息转换为 Agent 可处理的文本消息。"""
from __future__ import annotations

from typing import Any

from .models import IncomingText


def parse_text_messages(payload: dict[str, Any]) -> list[IncomingText]:
    messages = []
    for message in payload.get('msgs') or []:
        if message.get('message_type') == 2:
            continue
        text_parts = []
        for item in message.get('item_list') or []:
            if item.get('type') == 1 and (item.get('text_item') or {}).get('text'):
                text_parts.append(str(item['text_item']['text']))
        text = ''.join(text_parts).strip()
        if not text:
            continue
        messages.append(IncomingText(
            message_id=str(message.get('message_id') or message.get('seq') or ''),
            from_user_id=str(message.get('from_user_id') or ''),
            to_user_id=str(message.get('to_user_id') or ''),
            context_token=str(message.get('context_token') or ''),
            text=text,
        ))
    return messages
