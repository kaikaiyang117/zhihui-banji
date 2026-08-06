# -*- coding: utf-8 -*-
"""iLink 消息和凭证数据结构。"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ILinkCredentials:
    bot_token: str
    base_url: str = 'https://ilinkai.weixin.qq.com'
    account_id: str = ''
    ilink_user_id: str = ''


@dataclass(frozen=True)
class IncomingText:
    message_id: str
    from_user_id: str
    to_user_id: str
    context_token: str
    text: str
