# -*- coding: utf-8 -*-
"""持久化 Agent 对话上下文。"""
from __future__ import annotations

from typing import Any

from .. import db


class SessionStore:
    def __init__(self, max_messages: int = 40):
        self.max_messages = max(10, max_messages)

    def load(self, session_id: str) -> list[dict[str, Any]]:
        return _compact_messages(db.load_agent_session(session_id), self.max_messages)

    def save(self, session_id: str, messages: list[dict[str, Any]]):
        db.save_agent_session(session_id, _compact_messages(messages, self.max_messages))

    def clear(self, session_id: str):
        db.delete_agent_session(session_id)


def _compact_messages(messages: list[dict[str, Any]], max_messages: int) -> list[dict[str, Any]]:
    """按完整用户回合压缩上下文，避免截断 assistant/tool 调用链。"""
    if not messages:
        return []
    system_index = next((index for index, message in enumerate(messages)
                         if message.get('role') == 'system'), None)
    system = messages[system_index] if system_index is not None else None
    body = [message for index, message in enumerate(messages) if index != system_index]
    first_user = next((index for index, message in enumerate(body) if message.get('role') == 'user'), None)
    if first_user is None:
        return [system] if system else []
    body = body[first_user:]

    turns: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for message in body:
        if message.get('role') == 'user' and current:
            turns.append(current)
            current = []
        current.append(message)
    if current:
        turns.append(current)

    budget = max(1, max_messages - (1 if system else 0))
    selected: list[list[dict[str, Any]]] = []
    used = 0
    for turn in reversed(turns):
        if used + len(turn) <= budget:
            selected.insert(0, turn)
            used += len(turn)
            continue
        if not selected:
            selected.insert(0, _shrink_turn(turn))
        break

    compacted = [message for turn in selected for message in turn]
    return ([system] if system else []) + compacted


def _shrink_turn(turn: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """单个超大工具回合只保留用户问题和最终回答。"""
    user = next((message for message in turn if message.get('role') == 'user'), None)
    final = next(
        (message for message in reversed(turn)
         if message.get('role') == 'assistant' and not message.get('tool_calls')),
        None,
    )
    if user and final:
        return [user, final]
    return [user] if user else []
