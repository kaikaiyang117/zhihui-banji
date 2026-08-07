# -*- coding: utf-8 -*-
"""事件、沟通、关注与统一工作项之间的过程记录和状态联动。"""
from __future__ import annotations

from datetime import datetime
import threading

from .. import db
from . import audit, class_context

_lock = threading.RLock()

SOURCES = {
    'event': {
        'table': 'student_events',
        'statuses': {'待处理', '处理中', '待复查', '已完成', '无需处理'},
        'closed': {'已完成', '无需处理'},
        'reopen': '待复查',
        'date_field': 'followup_due',
        'result_field': 'result',
        'editable': {'handling', 'followup_due'},
    },
    'communication': {
        'table': 'communications',
        'statuses': {'待回访', '进行中', '已完成', '无需回访'},
        'closed': {'已完成', '无需回访'},
        'reopen': '待回访',
        'date_field': 'followup_at',
        'result_field': 'result',
        'editable': {'feedback', 'agreement', 'followup_at'},
    },
    'focus': {
        'table': 'focus_items',
        'statuses': {'待确认', '跟进中', '情况改善', '已结束'},
        'closed': {'已结束'},
        'reopen': '跟进中',
        'date_field': 'next_review_at',
        'result_field': 'conclusion',
        'editable': {'conclusion', 'next_review_at'},
    },
}

SOURCE_TO_TASK = {
    'event': {'待处理': '待处理', '处理中': '处理中', '待复查': '待复查'},
    'communication': {'待回访': '待复查', '进行中': '处理中'},
    'focus': {'待确认': '待处理', '跟进中': '处理中', '情况改善': '待复查'},
}
TASK_TO_SOURCE = {
    'event': {'待处理': '待处理', '处理中': '处理中', '待复查': '待复查'},
    'communication': {'待处理': '待回访', '处理中': '进行中', '待复查': '待回访'},
    'focus': {'待处理': '待确认', '处理中': '跟进中', '待复查': '情况改善'},
}


class WorkflowError(ValueError):
    pass


def _now() -> str:
    return datetime.now().strftime('%Y-%m-%d %H:%M')


def _source_row(source_type: str, source_id: int, *, write: bool = False, conn=None):
    conn = conn or db.get_conn()
    config = SOURCES.get(source_type)
    if not config:
        raise WorkflowError('不支持的来源类型')
    class_id, term_id = class_context.scope_ids(write=write, conn=conn)
    row = conn.execute(
        f"SELECT * FROM {config['table']} WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (source_id, class_id, term_id),
    ).fetchone()
    if not row:
        raise WorkflowError('来源记录不存在')
    return config, dict(row), class_id, term_id


def _linked_task(conn, class_id: int, term_id: int, source_type: str, source_id: int):
    return conn.execute(
        '''SELECT * FROM student_tasks
           WHERE class_id=? AND term_id=? AND source_type=? AND source_id=?
             AND deleted_at=''
           ORDER BY id LIMIT 1''',
        (class_id, term_id, source_type, source_id),
    ).fetchone()


def _record_update(
    conn, *, source_type: str, source_id: int, student_id: int | None,
    class_id: int, term_id: int, action: str, content: str = '',
    status_from: str = '', status_to: str = '', next_action_at: str = '',
    idempotency_key: str = '',
):
    conn.execute(
        '''INSERT INTO workflow_updates(
               source_type, source_id, student_id, class_id, term_id,
               action, content, status_from, status_to, next_action_at, idempotency_key
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
        (source_type, source_id, student_id, class_id, term_id, action,
         str(content or '').strip(), status_from, status_to,
         str(next_action_at or ''), str(idempotency_key or '')),
    )


def get_workflow(source_type: str, source_id: int, conn=None) -> dict:
    conn = conn or db.get_conn()
    config, source, class_id, term_id = _source_row(source_type, source_id, conn=conn)
    updates = [dict(row) for row in conn.execute(
        '''SELECT * FROM workflow_updates
           WHERE class_id=? AND term_id=? AND source_type=? AND source_id=?
           ORDER BY id DESC''',
        (class_id, term_id, source_type, source_id),
    ).fetchall()]
    linked = _linked_task(conn, class_id, term_id, source_type, source_id)
    return {
        'source': source,
        'updates': updates,
        'linked_work_item': dict(linked) if linked else None,
        'allowed_statuses': sorted(config['statuses']),
        'closed_statuses': sorted(config['closed']),
    }


def update_source(
    source_type: str,
    source_id: int,
    *,
    fields: dict | None = None,
    status: str | None = None,
    progress: str = '',
    result: str = '',
    next_action_at: str | None = None,
    task_action: str | None = None,
    request_id: str = '',
    conn=None,
) -> dict:
    """更新来源并明确处理关联工作项；request_id 重复时保持幂等。"""
    with _lock:
        conn = conn or db.get_conn()
        config, source, class_id, term_id = _source_row(
            source_type, source_id, write=True, conn=conn)
        request_id = str(request_id or '').strip()
        if request_id and conn.execute(
            'SELECT 1 FROM workflow_updates WHERE class_id=? AND term_id=? AND idempotency_key=?',
            (class_id, term_id, request_id),
        ).fetchone():
            return {'duplicate': True, **get_workflow(source_type, source_id, conn=conn)}

        old_status = source['status']
        next_status = status or old_status
        if next_status not in config['statuses']:
            raise WorkflowError('来源状态不合法')
        closing = next_status in config['closed'] and old_status not in config['closed']
        result = str(result or '').strip()
        if closing and not result:
            raise WorkflowError('关闭来源记录时必须填写处理结论')

        linked = _linked_task(conn, class_id, term_id, source_type, source_id)
        linked_open = linked and linked['status'] not in {'已完成', '已取消'}
        if closing and linked_open and task_action not in {'complete', 'cancel'}:
            raise WorkflowError('关闭来源记录前，请明确完成或取消关联工作项')
        if task_action not in {None, '', 'complete', 'cancel'}:
            raise WorkflowError('关联工作项处理方式不合法')

        updates = {}
        for key, value in (fields or {}).items():
            if key in config['editable'] and value is not None:
                updates[key] = str(value)
        date_field = config['date_field']
        if next_action_at is not None:
            updates[date_field] = str(next_action_at)
        updates['status'] = next_status
        if result:
            updates[config['result_field']] = result
        if 'closed_at' in source:
            updates['closed_at'] = _now() if next_status in config['closed'] else ''
        if source_type == 'focus':
            updates['ended_at'] = _now() if next_status in config['closed'] else ''

        try:
            assignments = ', '.join(f'{key}=?' for key in updates)
            conn.execute(
                f"UPDATE {config['table']} SET {assignments}, updated_at=datetime('now','localtime') "
                'WHERE id=? AND class_id=? AND term_id=?',
                (*updates.values(), source_id, class_id, term_id),
            )
            if linked_open and closing:
                task_status = '已完成' if task_action == 'complete' else '已取消'
                conn.execute(
                    '''UPDATE student_tasks SET status=?, result=?, completed_at=?, cancelled_at=?,
                           updated_at=datetime('now','localtime') WHERE id=?''',
                    (task_status, result,
                     _now() if task_status == '已完成' else '',
                     _now() if task_status == '已取消' else '', linked['id']),
                )
            elif linked and next_status not in config['closed']:
                task_status = SOURCE_TO_TASK.get(source_type, {}).get(next_status, linked['status'])
                task_due = updates.get(date_field, source.get(date_field, ''))
                conn.execute(
                    '''UPDATE student_tasks SET status=?, due_at=?, result='',
                           completed_at='', cancelled_at='', updated_at=datetime('now','localtime')
                       WHERE id=?''',
                    (task_status, task_due, linked['id']),
                )
            action = 'status' if next_status != old_status else 'progress' if progress else 'edit'
            content = progress or result
            _record_update(
                conn, source_type=source_type, source_id=source_id,
                student_id=source.get('student_id'), class_id=class_id, term_id=term_id,
                action=action, content=content, status_from=old_status,
                status_to=next_status, next_action_at=updates.get(date_field, source.get(date_field, '')),
                idempotency_key=request_id,
            )
            audit.record(
                source_type, source_id, action,
                summary=f'{source_type} 状态：{old_status} → {next_status}',
                params={'fields': fields or {}, 'progress': progress, 'result': result,
                        'next_action_at': next_action_at, 'task_action': task_action},
                class_id=class_id, term_id=term_id, conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return {'duplicate': False, **get_workflow(source_type, source_id, conn=conn)}


def on_work_item_transition(conn, before: dict, next_status: str, result: str):
    """工作项状态变化时回写事件、沟通或关注；由 work_items 事务内调用。"""
    source_type = before.get('source_type')
    source_id = before.get('source_id')
    config = SOURCES.get(source_type)
    if not config or not source_id or before.get('status') == next_status:
        return
    source = conn.execute(
        f"SELECT * FROM {config['table']} WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (source_id, before['class_id'], before['term_id']),
    ).fetchone()
    if not source:
        return
    source = dict(source)
    old_source_status = source['status']
    target_source_status = old_source_status
    if next_status == '已完成':
        target_source_status = next(iter(config['closed']))
        if source_type == 'event':
            target_source_status = '已完成'
        elif source_type == 'communication':
            target_source_status = '已完成'
    elif next_status not in {'已完成', '已取消'}:
        target_source_status = TASK_TO_SOURCE.get(source_type, {}).get(next_status, old_source_status)
    if before.get('status') in {'已完成', '已取消'} and next_status not in {'已完成', '已取消'}:
        target_source_status = config['reopen']

    assignments = ['status=?']
    params = [target_source_status]
    if next_status == '已完成':
        assignments.append(f"{config['result_field']}=?")
        params.append(result)
        if 'closed_at' in source:
            assignments.append('closed_at=?')
            params.append(_now())
        if source_type == 'focus':
            assignments.append('ended_at=?')
            params.append(_now())
    elif target_source_status not in config['closed']:
        if 'closed_at' in source:
            assignments.append("closed_at='' ")
        if source_type == 'focus':
            assignments.append("ended_at='' ")
    params.extend((source_id, before['class_id'], before['term_id']))
    conn.execute(
        f"UPDATE {config['table']} SET {', '.join(assignments)}, updated_at=datetime('now','localtime') "
        'WHERE id=? AND class_id=? AND term_id=?', tuple(params))

    action = 'work_item_completed' if next_status == '已完成' else (
        'work_item_cancelled' if next_status == '已取消' else 'work_item_reopened')
    _record_update(
        conn, source_type=source_type, source_id=source_id,
        student_id=source.get('student_id'), class_id=before['class_id'],
        term_id=before['term_id'], action=action, content=result,
        status_from=old_source_status, status_to=target_source_status,
        next_action_at=source.get(config['date_field'], ''),
    )
