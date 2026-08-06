# -*- coding: utf-8 -*-
"""持久化 Agent 对话上下文。"""
from __future__ import annotations

from typing import Any

from .. import db


class SessionStore:
    def __init__(self, max_messages: int = 40):
        self.max_messages = max(10, max_messages)

    def load(self, session_id: str) -> list[dict[str, Any]]:
        return db.load_agent_session(session_id)

    def save(self, session_id: str, messages: list[dict[str, Any]]):
        db.save_agent_session(session_id, messages[-self.max_messages:])

    def clear(self, session_id: str):
        db.delete_agent_session(session_id)
