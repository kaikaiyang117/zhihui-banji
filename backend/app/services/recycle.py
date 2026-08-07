# -*- coding: utf-8 -*-
"""核心业务记录的软删除、回收站恢复与受控永久删除。"""
from __future__ import annotations

from datetime import datetime
import json
import threading

from .. import db
from . import audit, class_context


class RecycleError(ValueError):
    pass


OBJECTS = {
    'student': {'table': 'students', 'label': ('学号', '姓名'), 'scoped': False},
    'event': {'table': 'student_events', 'label': ('event_type', 'description'), 'scoped': True},
    'work_item': {'table': 'student_tasks', 'label': ('title',), 'scoped': True},
    'focus': {'table': 'focus_items', 'label': ('topic',), 'scoped': True},
    'communication': {'table': 'communications', 'label': ('reason', 'summary'), 'scoped': True},
    'exam': {'table': 'exam_records', 'label': ('exam_name', 'subject'), 'scoped': True},
    'attendance_rule': {'table': 'attendance_rules', 'label': ('name',), 'scoped': True},
    'score_rule': {'table': 'score_rules', 'label': ('name',), 'scoped': True},
    'class_task': {'table': 'class_tasks', 'label': ('title',), 'scoped': True},
    'duty_assignment': {'table': 'duty_assignments', 'label': ('duty_date', 'area'), 'scoped': True},
}

_write_lock = threading.RLock()


def _now() -> str:
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def _label(row: dict, fields: tuple[str, ...]) -> str:
    values = [str(row.get(field) or '').strip() for field in fields]
    return ' · '.join(value for value in values if value)[:160]


def _entry(entry_id: int, *, status: str = '已删除', conn=None) -> dict:
    conn = conn or db.get_conn()
    class_id, term_id = class_context.scope_ids(conn=conn)
    row = conn.execute(
        'SELECT * FROM recycle_bin WHERE id=? AND class_id=? AND term_id=? AND status=?',
        (entry_id, class_id, term_id, status),
    ).fetchone()
    if not row:
        raise RecycleError('回收站记录不存在或已处理')
    return dict(row)


def _load_active(object_type: str, object_id: int, conn) -> tuple[dict, int, int]:
    config = OBJECTS.get(object_type)
    if not config:
        raise RecycleError('不支持的记录类型')
    class_id, term_id = class_context.scope_ids(write=True, conn=conn)
    if object_type == 'student':
        class_context.ensure_student_in_scope(object_id, write=True, conn=conn)
        row = conn.execute(
            "SELECT * FROM students WHERE id=? AND deleted_at=''", (object_id,)
        ).fetchone()
    else:
        row = conn.execute(
            f"SELECT * FROM {config['table']} "
            "WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
            (object_id, class_id, term_id),
        ).fetchone()
    if not row:
        raise RecycleError('记录不存在或已删除')
    return dict(row), class_id, term_id


def soft_delete(object_type: str, object_id: int, *, conn=None, commit: bool = True) -> dict:
    conn = conn or db.get_conn()
    with _write_lock:
        row, class_id, term_id = _load_active(object_type, int(object_id), conn)
        config = OBJECTS[object_type]
        channel, actor_id = audit.current_actor()
        deleted_at = _now()
        linked_ids = []
        if object_type in {
            'event', 'focus', 'communication', 'attendance_rule', 'score_rule',
            'class_task', 'duty_assignment',
        }:
            linked_ids = [int(item['id']) for item in conn.execute(
                "SELECT id FROM student_tasks WHERE class_id=? AND term_id=? "
                "AND source_type=? AND source_id=? AND deleted_at=''",
                (class_id, term_id, object_type, object_id),
            ).fetchall()]
            if linked_ids:
                row['__linked_work_items'] = linked_ids
        try:
            if object_type == 'student':
                cur = conn.execute(
                    "UPDATE students SET deleted_at=?, deleted_by=? WHERE id=? AND deleted_at=''",
                    (deleted_at, actor_id, object_id),
                )
            else:
                cur = conn.execute(
                    f"UPDATE {config['table']} SET deleted_at=?, deleted_by=? "
                    "WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
                    (deleted_at, actor_id, object_id, class_id, term_id),
                )
            if not cur.rowcount:
                raise RecycleError('记录不存在或已删除')
            if linked_ids:
                placeholders = ','.join('?' for _ in linked_ids)
                conn.execute(
                    f"UPDATE student_tasks SET deleted_at=?, deleted_by=? WHERE id IN ({placeholders})",
                    (deleted_at, actor_id, *linked_ids),
                )
            recycle_id = conn.execute(
                '''INSERT INTO recycle_bin(
                       object_type, object_id, class_id, term_id, label, snapshot,
                       status, deleted_by, deleted_at
                   ) VALUES(?,?,?,?,?,?, '已删除', ?,?)''',
                (object_type, str(object_id), class_id, term_id,
                 _label(row, config['label']), json.dumps(row, ensure_ascii=False),
                 actor_id, deleted_at),
            ).lastrowid
            audit.record(
                object_type, object_id, 'delete', summary=f"移入回收站：{_label(row, config['label'])}",
                params={'channel': channel}, class_id=class_id, term_id=term_id,
                conn=conn, commit=False,
            )
            if commit:
                conn.commit()
        except Exception:
            if commit:
                conn.rollback()
            raise
    return {'ok': True, 'recycle_id': int(recycle_id)}


def soft_delete_sheet_row(sheet: str, row_no: int, *, conn=None) -> dict:
    from ..config import SHEET_META
    if sheet not in SHEET_META:
        raise RecycleError('工作表不存在')
    conn = conn or db.get_conn()
    class_id, term_id = class_context.scope_ids(
        write=SHEET_META[sheet].get('group') != 'personal', conn=conn)
    with _write_lock:
        row = conn.execute(
            "SELECT * FROM sheet_rows WHERE sheet=? AND row_no=? AND deleted_at='' "
            'AND (class_id=? AND term_id=?)',
            (sheet, row_no, class_id, term_id),
        ).fetchone()
        if not row:
            raise RecycleError('记录不存在或已删除')
        row = dict(row)
        _, actor_id = audit.current_actor()
        deleted_at = _now()
        object_id = f'{sheet}:{row_no}'
        try:
            conn.execute(
                "UPDATE sheet_rows SET deleted_at=?, deleted_by=? "
                "WHERE sheet=? AND row_no=? AND class_id=? AND term_id=? AND deleted_at=''",
                (deleted_at, actor_id, sheet, row_no, class_id, term_id),
            )
            recycle_id = conn.execute(
                '''INSERT INTO recycle_bin(
                       object_type, object_id, class_id, term_id, label, snapshot,
                       status, deleted_by, deleted_at
                   ) VALUES('sheet_row',?,?,?,?,?, '已删除', ?,?)''',
                (object_id, class_id, term_id, f'{sheet} · 第 {row_no} 行',
                 json.dumps(row, ensure_ascii=False), actor_id, deleted_at),
            ).lastrowid
            audit.record(
                'sheet_row', object_id, 'delete', summary=f'{sheet} 第 {row_no} 行移入回收站',
                params={'sheet': sheet, 'row_no': row_no}, class_id=class_id,
                term_id=term_id, conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {'ok': True, 'recycle_id': int(recycle_id)}


def list_entries(*, object_type: str = '', status: str = '已删除', limit: int = 300,
                 conn=None) -> list[dict]:
    conn = conn or db.get_conn()
    class_id, term_id = class_context.scope_ids(conn=conn)
    where = ['class_id=?', 'term_id=?']
    params: list = [class_id, term_id]
    if object_type:
        where.append('object_type=?')
        params.append(object_type)
    if status:
        where.append('status=?')
        params.append(status)
    params.append(max(1, min(int(limit), 500)))
    rows = conn.execute(
        'SELECT id, object_type, object_id, label, status, deleted_by, deleted_at, '
        'restored_at, purged_at FROM recycle_bin WHERE ' + ' AND '.join(where) +
        ' ORDER BY id DESC LIMIT ?', tuple(params),
    ).fetchall()
    return [dict(row) for row in rows]


def restore(entry_id: int, *, conn=None) -> dict:
    conn = conn or db.get_conn()
    with _write_lock:
        entry = _entry(entry_id, conn=conn)
        class_context.scope_ids(write=True, conn=conn)
        object_type = entry['object_type']
        snapshot = json.loads(entry['snapshot'])
        try:
            if object_type == 'sheet_row':
                cur = conn.execute(
                    "UPDATE sheet_rows SET deleted_at='', deleted_by='' "
                    'WHERE sheet=? AND row_no=? AND class_id=? AND term_id=? AND deleted_at<>\'\'',
                    (snapshot['sheet'], snapshot['row_no'], entry['class_id'], entry['term_id']),
                )
            else:
                config = OBJECTS.get(object_type)
                if not config:
                    raise RecycleError('不支持恢复该记录')
                if object_type == 'student':
                    cur = conn.execute(
                        "UPDATE students SET deleted_at='', deleted_by='' WHERE id=? AND deleted_at<>''",
                        (int(entry['object_id']),),
                    )
                else:
                    cur = conn.execute(
                        f"UPDATE {config['table']} SET deleted_at='', deleted_by='' "
                        "WHERE id=? AND class_id=? AND term_id=? AND deleted_at<>''",
                        (int(entry['object_id']), entry['class_id'], entry['term_id']),
                    )
            if not cur.rowcount:
                raise RecycleError('原记录已不存在，无法恢复')
            linked_ids = snapshot.get('__linked_work_items', [])
            if linked_ids:
                placeholders = ','.join('?' for _ in linked_ids)
                conn.execute(
                    f"UPDATE student_tasks SET deleted_at='', deleted_by='' "
                    f"WHERE id IN ({placeholders}) AND class_id=? AND term_id=?",
                    (*linked_ids, entry['class_id'], entry['term_id']),
                )
            restored_at = _now()
            conn.execute(
                "UPDATE recycle_bin SET status='已恢复', restored_at=? WHERE id=?",
                (restored_at, entry_id),
            )
            audit.record(
                object_type, entry['object_id'], 'restore', summary=f"从回收站恢复：{entry['label']}",
                class_id=entry['class_id'], term_id=entry['term_id'], conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {'ok': True}


def purge(entry_id: int, confirmation: str, *, conn=None) -> dict:
    conn = conn or db.get_conn()
    with _write_lock:
        entry = _entry(entry_id, conn=conn)
        class_context.scope_ids(write=True, conn=conn)
        if confirmation != '永久删除':
            audit.record(
                entry['object_type'], entry['object_id'], 'purge', status='failed',
                summary='永久删除确认文字不正确', class_id=entry['class_id'],
                term_id=entry['term_id'], conn=conn,
            )
            raise RecycleError('请输入“永久删除”完成二次确认')
        object_type = entry['object_type']
        snapshot = json.loads(entry['snapshot'])
        try:
            if object_type == 'sheet_row':
                cur = conn.execute(
                    "DELETE FROM sheet_rows WHERE sheet=? AND row_no=? AND class_id=? AND term_id=? AND deleted_at<>''",
                    (snapshot['sheet'], snapshot['row_no'], entry['class_id'], entry['term_id']),
                )
            else:
                config = OBJECTS.get(object_type)
                if not config:
                    raise RecycleError('不支持永久删除该记录')
                if object_type == 'student':
                    cur = conn.execute(
                        "DELETE FROM students WHERE id=? AND deleted_at<>''", (int(entry['object_id']),)
                    )
                else:
                    linked_ids = snapshot.get('__linked_work_items', [])
                    if linked_ids:
                        placeholders = ','.join('?' for _ in linked_ids)
                        conn.execute(
                            f"DELETE FROM student_tasks WHERE id IN ({placeholders}) "
                            "AND class_id=? AND term_id=? AND deleted_at<>''",
                            (*linked_ids, entry['class_id'], entry['term_id']),
                        )
                    cur = conn.execute(
                        f"DELETE FROM {config['table']} WHERE id=? AND class_id=? AND term_id=? AND deleted_at<>''",
                        (int(entry['object_id']), entry['class_id'], entry['term_id']),
                    )
            if not cur.rowcount:
                raise RecycleError('原记录已不存在')
            purged_at = _now()
            conn.execute(
                "UPDATE recycle_bin SET status='已永久删除', purged_at=? WHERE id=?",
                (purged_at, entry_id),
            )
            audit.record(
                object_type, entry['object_id'], 'purge', summary=f"永久删除：{entry['label']}",
                class_id=entry['class_id'], term_id=entry['term_id'], conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {'ok': True}
