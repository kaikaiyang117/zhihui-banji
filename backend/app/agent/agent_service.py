# -*- coding: utf-8 -*-
"""Agent 工具调用入口和审计。"""
from __future__ import annotations

import json
from typing import Any

from .. import db
from .tool_registry import ToolError, build_registry


def get_registry():
    return build_registry()


def list_tools() -> list[dict[str, Any]]:
    return get_registry().list()


def invoke_tool(
    name: str,
    arguments: dict[str, Any] | None = None,
    *,
    channel: str = 'local',
    actor_id: str = '',
) -> dict:
    arguments = arguments or {}
    registry = get_registry()
    try:
        result = registry.execute(name, arguments)
    except ToolError as exc:
        _record_audit(channel, actor_id, name, arguments, 'error', str(exc))
        raise
    _record_audit(channel, actor_id, name, arguments, 'success', _summary(result))
    return result


def list_audits(limit: int = 50) -> list[dict]:
    limit = max(1, min(int(limit), 200))
    rows = db.get_conn().execute(
        'SELECT id, channel, actor_id, tool_name, arguments, status, result_summary, created_at '
        'FROM agent_audit ORDER BY id DESC LIMIT ?',
        (limit,),
    ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        try:
            item['arguments'] = json.loads(item['arguments'])
        except (TypeError, ValueError):
            pass
        result.append(item)
    return result


def _record_audit(channel, actor_id, name, arguments, status, result_summary):
    db.get_conn().execute(
        'INSERT INTO agent_audit(channel, actor_id, tool_name, arguments, status, result_summary) '
        'VALUES(?,?,?,?,?,?)',
        (channel, actor_id, name, json.dumps(arguments, ensure_ascii=False, sort_keys=True),
         status, result_summary),
    )
    db.get_conn().commit()


def _summary(result: dict) -> str:
    if 'students' in result:
        return f"返回 {len(result['students'])} 名学生"
    if 'timeline' in result:
        return f"返回 {len(result['timeline'])} 条时间线记录"
    return '调用成功'
