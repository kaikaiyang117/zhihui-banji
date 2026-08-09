# -*- coding: utf-8 -*-
"""统一工作项业务规则：创建、来源幂等、筛选与状态变更。"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from functools import wraps
import threading

from .. import clock, db
from . import audit, class_context

STATUSES = {'待处理', '处理中', '待复查', '已完成', '已取消'}
PRIORITIES = {'普通', '重要', '紧急'}
CLOSED_STATUSES = {'已完成', '已取消'}

SOURCE_LABELS = {
    'manual': '手动创建',
    'event': '学生事件',
    'communication': '家校沟通',
    'focus': '关注事项',
    'attendance_rule': '考勤规则',
    'score_rule': '成绩规则',
    'class_task': '班级任务',
    'duty_assignment': '值日安排',
    'point_rule': '积分规则',
    'meeting_action': '班会行动项',
    'activity': '班级活动',
    'agent_action': 'Agent 创建',
}

SOURCE_PATHS = {
    'event': '/events',
    'communication': '/parent-comm',
    'focus': '/special',
    'attendance_rule': '/attendance',
    'score_rule': '/scores',
    'class_task': '/class-tasks',
    'duty_assignment': '/duty',
    'point_rule': '/points',
    'meeting_action': '/meetings',
    'activity': '/activities',
}

_write_lock = threading.RLock()


def _serialized_write(action):
    @wraps(action)
    def wrapped(*args, **kwargs):
        with _write_lock:
            return action(*args, **kwargs)
    return wrapped


class WorkItemError(ValueError):
    pass


def _now() -> str:
    return datetime.now().strftime('%Y-%m-%d %H:%M')


def _validate(status: str, priority: str):
    if status not in STATUSES:
        raise WorkItemError('工作项状态不合法')
    if priority not in PRIORITIES:
        raise WorkItemError('优先级不合法')


def _source_key(source_type: str, source_id: int | None, student_id: int | None = None) -> str:
    if source_type == 'manual' or source_id is None:
        return ''
    key = f'{source_type}:{int(source_id)}'
    if source_type in {'attendance_rule', 'score_rule', 'point_rule'} and student_id is not None:
        key += f':student:{int(student_id)}'
    return key


def _decorate(row: dict, today: date | None = None) -> dict:
    today = today or clock.today()
    item = dict(row)
    item['source_label'] = SOURCE_LABELS.get(item.get('source_type'), item.get('source') or '其他')
    path = SOURCE_PATHS.get(item.get('source_type'), '')
    item['source_path'] = f"{path}?source_id={item['source_id']}" if path and item.get('source_id') else path
    item['calendar_date'] = str(item.get('scheduled_at') or item.get('due_at') or '')[:10]
    if item.get('status') in CLOSED_STATUSES:
        item['timing_state'] = item['status']
    else:
        due = str(item.get('due_at') or '')[:10]
        if due and due < today.isoformat():
            item['timing_state'] = '已逾期'
        elif item['calendar_date'] == today.isoformat():
            item['timing_state'] = '今天'
        else:
            item['timing_state'] = '待安排'
    return item


@_serialized_write
def create_work_item(
    *,
    title: str,
    student_id: int | None = None,
    source_type: str = 'manual',
    source_id: int | None = None,
    source_label: str | None = None,
    owner: str = '班主任',
    priority: str = '普通',
    scheduled_at: str = '',
    due_at: str = '',
    status: str = '待处理',
    notes: str = '',
    conn=None,
    commit: bool = True,
) -> dict:
    """创建工作项；有来源键时重复调用返回原工作项，不重复插入。"""
    conn = conn or db.get_conn()
    title = str(title or '').strip()
    if not title:
        raise WorkItemError('工作项标题不能为空')
    _validate(status, priority)
    class_id, term_id = class_context.scope_ids(write=True, conn=conn)
    if student_id is not None:
        class_context.ensure_student_in_scope(int(student_id), write=True, conn=conn)
    source_type = str(source_type or 'manual').strip() or 'manual'
    source_key = _source_key(source_type, source_id, student_id)
    if source_key:
        existing = conn.execute(
            "SELECT id FROM student_tasks WHERE class_id=? AND term_id=? AND source_key=? AND deleted_at=''",
            (class_id, term_id, source_key),
        ).fetchone()
        if existing:
            return {'id': int(existing['id']), 'created': False}

    source = str(source_label or SOURCE_LABELS.get(source_type, source_type)).strip()
    inserted = conn.execute(
        '''INSERT INTO student_tasks(
               student_id, title, source, source_type, source_id, source_key,
               owner, priority, scheduled_at, due_at, status, notes, class_id, term_id
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id''',
        (student_id, title, source, source_type, source_id, source_key,
         str(owner or '班主任').strip() or '班主任', priority, scheduled_at, due_at,
         status, str(notes or ''), class_id, term_id),
    ).fetchone()
    item_id = int(inserted['id'])
    audit.record(
        'work_item', item_id, 'create', summary=f'新增工作项：{title}',
        params={'title': title, 'owner': owner, 'priority': priority,
                'scheduled_at': scheduled_at, 'due_at': due_at,
                'source_type': source_type, 'source_id': source_id},
        class_id=class_id, term_id=term_id, conn=conn, commit=False,
    )
    if commit:
        conn.commit()
    return {'id': item_id, 'created': True}


@_serialized_write
def ensure_source_work_item(*, legacy_title: str = '', **kwargs) -> dict:
    """为来源生成工作项，并把同标题的旧式未关闭待办认领为该来源。"""
    conn = kwargs.get('conn') or db.get_conn()
    class_id, term_id = class_context.scope_ids(write=True, conn=conn)
    source_type = kwargs.get('source_type', 'manual')
    source_id = kwargs.get('source_id')
    student_id = kwargs.get('student_id')
    source_key = _source_key(source_type, source_id, student_id)
    if source_key:
        existing = conn.execute(
            "SELECT id FROM student_tasks WHERE class_id=? AND term_id=? AND source_key=? AND deleted_at=''",
            (class_id, term_id, source_key),
        ).fetchone()
        if existing:
            return {'id': int(existing['id']), 'created': False}
        if legacy_title:
            legacy = conn.execute(
                '''SELECT id FROM student_tasks
                   WHERE class_id=? AND term_id=? AND title=?
                     AND COALESCE(source_key, '')=''
                     AND deleted_at=''
                     AND status NOT IN ('已完成','已取消')
                   ORDER BY id LIMIT 1''',
                (class_id, term_id, legacy_title),
            ).fetchone()
            if legacy:
                conn.execute(
                    '''UPDATE student_tasks
                       SET source=?, source_type=?, source_id=?, source_key=?,
                           updated_at=datetime('now','localtime') WHERE id=?''',
                    (kwargs.get('source_label') or SOURCE_LABELS.get(source_type, source_type),
                     source_type, source_id, source_key, legacy['id']),
                )
                if kwargs.get('commit', True):
                    conn.commit()
                return {'id': int(legacy['id']), 'created': False}
    return create_work_item(**kwargs)


def list_work_items(
    *,
    status: str | None = None,
    bucket: str = 'all',
    student_id: int | None = None,
    source_type: str | None = None,
    query: str = '',
    date_from: str = '',
    date_to: str = '',
    reference_date: date | None = None,
    limit: int = 500,
    conn=None,
) -> list[dict]:
    conn = conn or db.get_conn()
    class_id, term_id = class_context.scope_ids(conn=conn)
    today = reference_date or clock.today()
    action_date = "substr(COALESCE(NULLIF(t.scheduled_at,''), NULLIF(t.due_at,''), ''),1,10)"
    where = ["t.class_id=?", "t.term_id=?", "t.deleted_at=''",
             "(t.student_id IS NULL OR COALESCE(s.deleted_at, '')='')"]
    params: list = [class_id, term_id]
    if status:
        if status not in STATUSES:
            raise WorkItemError('工作项状态不合法')
        where.append('t.status=?')
        params.append(status)
    if student_id:
        where.append('t.student_id=?')
        params.append(student_id)
    if source_type:
        where.append('t.source_type=?')
        params.append(source_type)
    if query.strip():
        where.append("(t.title LIKE ? OR t.notes LIKE ? OR COALESCE(s.姓名,'') LIKE ?)")
        like = f'%{query.strip()}%'
        params.extend((like, like, like))
    if date_from:
        where.append(f'{action_date}>=?')
        params.append(date_from[:10])
    if date_to:
        where.append(f'{action_date}<=?')
        params.append(date_to[:10])

    today_text = today.isoformat()
    if bucket == 'open':
        where.append("t.status NOT IN ('已完成','已取消')")
    elif bucket == 'overdue':
        where.extend(("t.status NOT IN ('已完成','已取消')", "t.due_at<>''", 'substr(t.due_at,1,10)<?'))
        params.append(today_text)
    elif bucket == 'today':
        where.extend(("t.status NOT IN ('已完成','已取消')", f'({action_date}=? OR substr(t.due_at,1,10)=?)'))
        params.extend((today_text, today_text))
    elif bucket == 'next7':
        where.extend(("t.status NOT IN ('已完成','已取消')", f'{action_date}>?', f'{action_date}<=?'))
        params.extend((today_text, (today + timedelta(days=7)).isoformat()))
    elif bucket == 'completed':
        where.append("t.status='已完成'")
    elif bucket == 'cancelled':
        where.append("t.status='已取消'")
    elif bucket != 'all':
        raise WorkItemError('不支持的工作项筛选')

    sql = (
        'SELECT t.*, s.姓名 AS student_name FROM student_tasks t '
        'LEFT JOIN students s ON s.id=t.student_id WHERE ' + ' AND '.join(where) +
        " ORDER BY CASE WHEN t.status IN ('已完成','已取消') THEN 1 ELSE 0 END, "
        "CASE WHEN t.due_at<>'' AND substr(t.due_at,1,10)<? THEN 0 ELSE 1 END, "
        "CASE t.priority WHEN '紧急' THEN 0 WHEN '重要' THEN 1 ELSE 2 END, "
        f"CASE WHEN {action_date}='' THEN 1 ELSE 0 END, {action_date}, t.id DESC LIMIT ?"
    )
    params.extend((today_text, max(1, min(int(limit), 1_000_000))))
    return [_decorate(dict(row), today) for row in conn.execute(sql, tuple(params)).fetchall()]


def work_item_summary(*, reference_date: date | None = None, conn=None) -> dict:
    conn = conn or db.get_conn()
    result = {}
    for bucket in ('all', 'open', 'overdue', 'today', 'next7', 'completed', 'cancelled'):
        result[bucket] = len(list_work_items(
            bucket=bucket, reference_date=reference_date, limit=1_000_000, conn=conn))
    return result


@_serialized_write
def update_work_item(
    item_id: int,
    *,
    title: str | None = None,
    owner: str | None = None,
    priority: str | None = None,
    scheduled_at: str | None = None,
    due_at: str | None = None,
    status: str | None = None,
    notes: str | None = None,
    result: str | None = None,
    conn=None,
    commit: bool = True,
    sync_source: bool = True,
) -> dict:
    conn = conn or db.get_conn()
    class_id, term_id = class_context.scope_ids(write=True, conn=conn)
    row = conn.execute(
        "SELECT * FROM student_tasks WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (item_id, class_id, term_id),
    ).fetchone()
    if not row:
        raise WorkItemError('工作项不存在')
    next_status = status or row['status']
    next_priority = priority or row['priority']
    _validate(next_status, next_priority)
    next_result = str(result if result is not None else row['result'] or '').strip()
    if next_status in CLOSED_STATUSES and not next_result:
        raise WorkItemError('完成或取消工作项时必须填写处理结果')
    if title is not None and not str(title).strip():
        raise WorkItemError('工作项标题不能为空')

    if (
        next_status == row['status']
        and next_status in CLOSED_STATUSES
        and next_result == str(row['result'] or '').strip()
        and all(value is None for value in (title, owner, priority, scheduled_at, due_at, notes))
    ):
        current = conn.execute(
            'SELECT t.*, s.姓名 AS student_name FROM student_tasks t '
            "LEFT JOIN students s ON s.id=t.student_id WHERE t.id=? AND t.deleted_at=''", (item_id,)
        ).fetchone()
        return _decorate(dict(current))

    values = {
        'title': str(title).strip() if title is not None else row['title'],
        'owner': str(owner).strip() if owner is not None else row['owner'],
        'priority': next_priority,
        'scheduled_at': scheduled_at if scheduled_at is not None else row['scheduled_at'],
        'due_at': due_at if due_at is not None else row['due_at'],
        'status': next_status,
        'notes': notes if notes is not None else row['notes'],
        'result': next_result if next_status in CLOSED_STATUSES else '',
        'completed_at': _now() if next_status == '已完成' else '',
        'cancelled_at': _now() if next_status == '已取消' else '',
    }
    try:
        conn.execute(
            '''UPDATE student_tasks SET
                   title=:title, owner=:owner, priority=:priority,
                   scheduled_at=:scheduled_at, due_at=:due_at, status=:status,
                   notes=:notes, result=:result, completed_at=:completed_at,
                   cancelled_at=:cancelled_at, updated_at=datetime('now','localtime')
               WHERE id=:id AND class_id=:class_id AND term_id=:term_id''',
            {**values, 'id': item_id, 'class_id': class_id, 'term_id': term_id},
        )
        from .workflow import on_work_item_transition
        on_work_item_transition(conn, dict(row), next_status, values['result'])
        if row['source_type'] == 'attendance_rule':
            from .attendance import on_work_item_transition as on_attendance_transition
            on_attendance_transition(conn, dict(row), next_status)
        elif row['source_type'] == 'score_rule':
            from .scores import on_work_item_transition as on_score_transition
            on_score_transition(conn, dict(row), next_status)
        elif sync_source and row['source_type'] == 'class_task':
            from .class_tasks import on_work_item_transition as on_class_task_transition
            on_class_task_transition(conn, dict(row), next_status, values['result'])
        elif sync_source and row['source_type'] == 'duty_assignment':
            from .duty import on_work_item_transition as on_duty_transition
            on_duty_transition(conn, dict(row), next_status, values['result'])
        elif sync_source and row['source_type'] == 'point_rule':
            from .points import on_work_item_transition as on_points_transition
            on_points_transition(conn, dict(row), next_status, values['result'])
        audit.record(
            'work_item', item_id, 'update', summary=f"更新工作项：{values['title']}",
            params=values, class_id=class_id, term_id=term_id, conn=conn, commit=False,
        )
        if commit:
            conn.commit()
    except Exception:
        if commit:
            conn.rollback()
        raise
    updated = conn.execute(
        'SELECT t.*, s.姓名 AS student_name FROM student_tasks t '
        "LEFT JOIN students s ON s.id=t.student_id WHERE t.id=? AND t.deleted_at=''",
        (item_id,),
    ).fetchone()
    return _decorate(dict(updated))
