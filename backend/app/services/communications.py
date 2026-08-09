# -*- coding: utf-8 -*-
"""结构化家校沟通记录服务，供页面和 Agent 共用。"""
from __future__ import annotations

from .. import db
from . import audit, class_context, work_items

STATUSES = {'待回访', '进行中', '已完成', '无需回访'}


class CommunicationError(ValueError):
    pass


def create_record(*, student_id: int, communicated_at: str, method: str,
                  reason: str, summary: str, feedback: str = '', agreement: str = '',
                  followup_at: str = '', status: str = '已完成', event_id: int | None = None,
                  source_type: str = 'manual', source_id: str = '', source_key: str = '',
                  conn=None) -> dict:
    conn = conn or db.get_conn()
    class_id, term_id = class_context.scope_ids(write=True, conn=conn)
    try:
        class_context.ensure_student_in_scope(student_id, write=True, conn=conn)
    except class_context.ScopeError as exc:
        raise CommunicationError(str(exc)) from exc
    status = '待回访' if followup_at and status == '已完成' else status
    if status not in STATUSES:
        raise CommunicationError('沟通状态不合法')
    required = (communicated_at, method, reason, summary)
    if any(not str(value or '').strip() for value in required):
        raise CommunicationError('沟通日期、方式、原因和摘要不能为空')
    communication_id = conn.execute(
        '''INSERT INTO communications(
               student_id, communicated_at, method, reason, summary, feedback,
               agreement, followup_at, status, event_id, class_id, term_id,
               source_type, source_id, source_key
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id''',
        (student_id, communicated_at, method, reason, summary, feedback,
         agreement, followup_at, status, event_id, class_id, term_id,
         source_type, source_id, source_key),
    ).fetchone()['id']
    task_id = None
    if followup_at:
        task = work_items.ensure_source_work_item(
            title='家校沟通回访', student_id=student_id,
            source_type='communication', source_id=communication_id,
            due_at=followup_at, priority='重要', status='待复查',
            notes=agreement or summary, conn=conn, commit=False)
        task_id = task['id']
    audit.record(
        'communication', communication_id, 'create', summary='新增家校沟通记录',
        params={'student_id': student_id, 'method': method, 'followup_at': followup_at},
        class_id=class_id, term_id=term_id, conn=conn, commit=False,
    )
    conn.commit()
    return {'ok': True, 'communication_id': int(communication_id), 'task_id': task_id}
