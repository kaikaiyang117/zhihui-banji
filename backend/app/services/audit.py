# -*- coding: utf-8 -*-
"""系统业务操作审计，集中处理渠道、操作者与敏感参数脱敏。"""
from __future__ import annotations

from contextvars import ContextVar, Token
import json

from .. import db
from . import class_context

_actor: ContextVar[tuple[str, str]] = ContextVar(
    'workbench_actor', default=('web', 'local-user'))
_request_recorded: ContextVar[bool] = ContextVar('workbench_audit_recorded', default=False)
_SENSITIVE = (
    'key', 'token', 'secret', 'password', 'credential', 'authorization',
    '密码', '电话', '手机', '地址', '住址',
)


def bind_actor(channel: str | None, actor_id: str | None) -> Token:
    return _actor.set((str(channel or 'web')[:30], str(actor_id or 'local-user')[:80]))


def reset_actor(token: Token):
    _actor.reset(token)


def current_actor() -> tuple[str, str]:
    return _actor.get()


def begin_request() -> Token:
    return _request_recorded.set(False)


def reset_request(token: Token):
    _request_recorded.reset(token)


def has_recorded() -> bool:
    return _request_recorded.get()


def _sanitize(value, key: str = ''):
    if any(marker.lower() in key.lower() for marker in _SENSITIVE):
        return '***'
    if isinstance(value, dict):
        return {str(k): _sanitize(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize(item) for item in value[:20]]
    text = str(value) if value is not None else ''
    return text[:200]


def record(
    object_type: str, object_id: str | int = '', action: str = '', *,
    status: str = 'success', summary: str = '', params: dict | None = None,
    class_id: int | None = None, term_id: int | None = None, conn=None,
    commit: bool = True,
):
    _request_recorded.set(True)
    conn = conn or db.get_conn()
    if class_id is None or term_id is None:
        try:
            class_id, term_id = class_context.scope_ids(conn=conn)
        except class_context.ScopeError:
            class_id = term_id = None
    channel, actor_id = _actor.get()
    conn.execute(
        '''INSERT INTO system_audit(
               channel, actor_id, object_type, object_id, action, status,
               summary, params_summary, class_id, term_id
           ) VALUES(?,?,?,?,?,?,?,?,?,?)''',
        (channel, actor_id, object_type, str(object_id), action, status,
         str(summary or '')[:300], json.dumps(_sanitize(params or {}), ensure_ascii=False),
         class_id, term_id),
    )
    if commit:
        conn.commit()


def list_audits(limit: int = 200, conn=None) -> list[dict]:
    conn = conn or db.get_conn()
    class_id, term_id = class_context.scope_ids(conn=conn)
    rows = conn.execute(
        '''SELECT * FROM system_audit
           WHERE (class_id=? AND term_id=?) OR class_id IS NULL
           ORDER BY id DESC LIMIT ?''',
        (class_id, term_id, max(1, min(int(limit), 500))),
    ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        try:
            item['params_summary'] = json.loads(item['params_summary'])
        except (TypeError, ValueError):
            pass
        result.append(item)
    return result
