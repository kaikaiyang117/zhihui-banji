# -*- coding: utf-8 -*-
"""Agent 工具调用入口和审计。"""
from __future__ import annotations

import json
from typing import Any
from typing import Any

from .. import db
from . import actions
from .tool_registry import ToolError, build_registry


def get_registry():
    return build_registry()


def list_tools() -> list[dict[str, Any]]:
    return get_registry().list()


def model_tools() -> list[dict[str, Any]]:
    return get_registry().model_tools()


def invoke_tool(
    name: str,
    arguments: dict[str, Any] | None = None,
    *,
    channel: str = 'local',
    actor_id: str = '',
    session_id: str = '',
    confirmed: bool = False,
) -> dict:
    arguments = arguments or {}
    registry = get_registry()
    definition = registry.get(name)
    if definition and definition.write_action:
        if not actions.allowed(channel, name):
            message = '当前渠道没有该写入操作权限。'
            _record_audit(channel, actor_id, name, arguments, 'denied', message)
            raise ToolError(message, code='permission_denied')
        if not confirmed:
            try:
                result = actions.create_pending(
                    tool_name=name, arguments=arguments, session_id=session_id,
                    channel=channel, actor_id=actor_id,
                )
            except actions.ActionError as exc:
                _record_audit(channel, actor_id, name, arguments, 'error', str(exc))
                raise ToolError(str(exc), code='confirmation_required') from exc
            _record_audit(channel, actor_id, name, arguments, 'pending', result.get('preview', '等待确认'))
            return result
        raise ToolError('写入操作必须通过确认接口执行', code='permission_denied')
    if definition and definition.sensitive and channel == 'wechat':
        message = '微信渠道默认不提供敏感档案字段，请在工作台网页端查看。'
        _record_audit(channel, actor_id, name, arguments, 'denied', message)
        raise ToolError(message, code='permission_denied')
    try:
        result = registry.execute(name, arguments)
    except ToolError as exc:
        _record_audit(channel, actor_id, name, arguments, 'error', str(exc))
        raise
    _record_audit(channel, actor_id, name, arguments, 'success', _summary(result))
    return result


def record_tool_failure(channel: str, actor_id: str, name: str, arguments: dict, status: str, message: str):
    _record_audit(channel, actor_id, name, arguments, status, message)


def record_tool_event(channel: str, actor_id: str, name: str, arguments: dict, status: str, message: str):
    """记录 Agent 状态事件，参数仍经过同一套审计摘要入口。"""
    _record_audit(channel, actor_id, name, arguments, status, message)


def record_model_usage(*, session_id: str, channel: str, actor_id: str, model: str,
                       status: str, duration_ms: int = 0, usage: dict[str, Any] | None = None,
                       error_message: str = ''):
    usage = usage or {}
    db.record_agent_model_usage(
        session_id=session_id, channel=channel, actor_id=actor_id, model=model,
        status=status, duration_ms=duration_ms,
        prompt_tokens=usage.get('prompt_tokens', 0),
        completion_tokens=usage.get('completion_tokens', 0),
        error_message=error_message,
    )


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


def usage_stats() -> dict:
    """返回本地 Agent 工具使用统计，统计口径来自不可变审计记录。"""
    conn = db.get_conn()
    totals = conn.execute(
        '''SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status IN ('success', 'pending', 'executed') THEN 1 ELSE 0 END) AS successful,
                  SUM(CASE WHEN status IN ('error', 'denied', 'retry_exhausted') THEN 1 ELSE 0 END) AS failed
           FROM agent_audit''').fetchone()
    by_tool = [dict(row) for row in conn.execute(
        '''SELECT tool_name, COUNT(*) AS calls,
                  SUM(CASE WHEN status IN ('success', 'pending', 'executed') THEN 1 ELSE 0 END) AS successful,
                  SUM(CASE WHEN status IN ('error', 'denied', 'retry_exhausted') THEN 1 ELSE 0 END) AS failed
           FROM agent_audit GROUP BY tool_name ORDER BY calls DESC, tool_name''').fetchall()]
    by_channel = [dict(row) for row in conn.execute(
        '''SELECT channel, COUNT(*) AS calls,
                  SUM(CASE WHEN status IN ('success', 'pending', 'executed') THEN 1 ELSE 0 END) AS successful,
                  SUM(CASE WHEN status IN ('error', 'denied', 'retry_exhausted') THEN 1 ELSE 0 END) AS failed
           FROM agent_audit GROUP BY channel ORDER BY calls DESC, channel''').fetchall()]
    model_usage = [dict(row) for row in conn.execute(
        '''SELECT model, COUNT(*) AS calls,
                  SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successful,
                  SUM(CASE WHEN status<>'success' THEN 1 ELSE 0 END) AS failed,
                  SUM(prompt_tokens) AS prompt_tokens,
                  SUM(completion_tokens) AS completion_tokens,
                  AVG(duration_ms) AS average_duration_ms
           FROM agent_model_usage GROUP BY model ORDER BY calls DESC, model''').fetchall()]
    total = int(totals['total'] or 0)
    failed = int(totals['failed'] or 0)
    return {
        'tool_calls': {'total': total, 'successful': int(totals['successful'] or 0),
                       'failed': failed, 'failure_rate': round(failed / total, 4) if total else 0},
        'by_tool': by_tool,
        'by_channel': by_channel,
        'model_usage': model_usage,
        'note': '模型 Token 与耗时仅在模型响应提供 usage 且客户端记录时统计。',
    }


def _record_audit(channel, actor_id, name, arguments, status, result_summary):
    db.get_conn().execute(
        'INSERT INTO agent_audit(channel, actor_id, tool_name, arguments, status, result_summary) '
        'VALUES(?,?,?,?,?,?)',
        (channel, actor_id, name, json.dumps(arguments, ensure_ascii=False, sort_keys=True),
         status, result_summary),
    )
    db.get_conn().commit()


def _summary(result: dict) -> str:
    if 'student_count' in result:
        return f"班级共有 {result['student_count']} 名学生"
    if 'summary' in result and 'records' in result:
        return f"返回考勤统计和 {len(result['records'])} 条记录"
    if 'exams' in result:
        return f"返回 {len(result['exams'])} 组成绩"
    if 'tasks' in result:
        return f"返回 {len(result['tasks'])} 条待办"
    if 'communications' in result:
        return f"返回 {len(result['communications'])} 条家校沟通记录"
    if 'students' in result:
        return f"返回 {len(result['students'])} 名学生"
    if 'timeline' in result:
        return f"返回 {len(result['timeline'])} 条时间线记录"
    return '调用成功'
