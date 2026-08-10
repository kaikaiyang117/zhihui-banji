# -*- coding: utf-8 -*-
"""班级任务、材料收集和提交凭证业务服务。"""
from __future__ import annotations

from datetime import date, datetime
import hashlib
import os
from pathlib import Path
import threading
from uuid import uuid4

from .. import clock, db
from . import audit, class_context


TASK_STATUSES = {'进行中', '已完成', '已取消'}
ITEM_STATUSES = {'未提交', '已提交', '免交'}
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
_write_lock = threading.RLock()


class ClassTaskError(ValueError):
    pass


class IncompleteTaskError(ClassTaskError):
    def __init__(self, missing: list[dict]):
        self.missing = missing
        super().__init__(f'仍有 {len(missing)} 名学生未提交材料，请确认后再完成任务')


def _conn(conn=None):
    return conn or db.get_conn()


def _now() -> str:
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def _text(value) -> str:
    return str(value or '').strip()


def _scope(*, write: bool = False, conn=None) -> tuple[int, int]:
    return class_context.scope_ids(write=write, conn=_conn(conn))


def _task_row(task_id: int, *, write: bool = False, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=write, conn=conn)
    row = conn.execute(
        "SELECT * FROM class_tasks WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (int(task_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise ClassTaskError('班级任务不存在')
    return dict(row)


def _template_row(template_id: int, *, write: bool = False, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=write, conn=conn)
    row = conn.execute(
        "SELECT * FROM class_task_templates WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (int(template_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise ClassTaskError('班级任务模板不存在')
    return dict(row)


def _item_rows(task_id: int, *, conn=None) -> list[dict]:
    conn = _conn(conn)
    rows = [dict(row) for row in conn.execute(
        '''SELECT i.*, s.学号, s.姓名
           FROM class_task_items i JOIN students s ON s.id=i.student_id
           WHERE i.task_id=? AND s.deleted_at=''
           ORDER BY s.学号''',
        (int(task_id),),
    ).fetchall()]
    attachments = [dict(row) for row in conn.execute(
        '''SELECT id, item_id, original_name, content_type, size_bytes, created_at
           FROM class_task_attachments WHERE task_id=? ORDER BY id''',
        (int(task_id),),
    ).fetchall()]
    by_item: dict[int, list[dict]] = {}
    for attachment in attachments:
        attachment['download_path'] = f"/api/class-tasks/attachments/{attachment['id']}"
        by_item.setdefault(int(attachment['item_id']), []).append(attachment)
    for item in rows:
        item['attachments'] = by_item.get(int(item['id']), [])
        item['attachment_count'] = len(item['attachments'])
    return rows


def _timing_state(task: dict, *, today: date | None = None) -> str:
    if task['status'] in {'已完成', '已取消'}:
        return task['status']
    today_text = (today or clock.today()).isoformat()
    due = _text(task.get('due_at'))[:10]
    start = _text(task.get('start_at'))[:10]
    if due and due < today_text:
        return '已逾期'
    if start and start > today_text:
        return '待开始'
    return '进行中'


def _serialize(task: dict, *, conn=None) -> dict:
    items = _item_rows(task['id'], conn=conn)
    total = len(items)
    submitted = sum(item['status'] in {'已提交', '免交'} for item in items)
    missing = [item for item in items if item['status'] == '未提交']
    task = dict(task)
    task['items'] = items
    task['total'] = total
    task['submitted'] = submitted
    task['missing_count'] = len(missing)
    task['missing_students'] = [
        {'student_id': item['student_id'], '学号': item['学号'], '姓名': item['姓名']}
        for item in missing
    ]
    task['progress'] = round(submitted * 100 / total) if total else 0
    task['timing_state'] = _timing_state(task)
    task['can_close'] = task['status'] == '进行中'
    return task


def list_tasks(*, status: str = '', timing_state: str = '', source_id: int | None = None,
               conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    if status and status not in TASK_STATUSES:
        raise ClassTaskError('班级任务状态不合法')
    where = ["class_id=?", "term_id=?", "deleted_at='' "]
    params: list = [class_id, term_id]
    if status:
        where.append('status=?')
        params.append(status)
    if source_id:
        where.append('id=?')
        params.append(int(source_id))
    rows = [dict(row) for row in conn.execute(
        'SELECT * FROM class_tasks WHERE ' + ' AND '.join(where) +
        ' ORDER BY CASE WHEN due_at=\'\' THEN 1 ELSE 0 END, due_at, id DESC',
        tuple(params),
    ).fetchall()]
    result = [_serialize(row, conn=conn) for row in rows]
    if timing_state:
        result = [item for item in result if item['timing_state'] == timing_state]
    return result


def get_task(task_id: int, *, conn=None) -> dict:
    return _serialize(_task_row(task_id, conn=conn), conn=conn)


def list_templates(*, include_disabled: bool = False, conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    where = ["class_id=?", "term_id=?", "deleted_at='' "]
    params: list = [class_id, term_id]
    if not include_disabled:
        where.append('enabled=1')
    return [dict(row) for row in conn.execute(
        'SELECT * FROM class_task_templates WHERE ' + ' AND '.join(where) +
        ' ORDER BY enabled DESC, name, id', tuple(params)
    ).fetchall()]


def create_template(*, name: str, task_type: str = '材料收集', material_name: str = '',
                    description: str = '', default_due_days: int = 7, enabled: bool = True,
                    conn=None) -> dict:
    conn = _conn(conn)
    name = _text(name)
    if not name:
        raise ClassTaskError('模板名称不能为空')
    if int(default_due_days) < 0 or int(default_due_days) > 366:
        raise ClassTaskError('默认截止天数必须在 0 到 366 天之间')
    class_id, term_id = _scope(write=True, conn=conn)
    try:
        template_id = conn.execute(
            '''INSERT INTO class_task_templates(
                   class_id, term_id, name, task_type, material_name,
                   description, default_due_days, enabled
               ) VALUES(?,?,?,?,?,?,?,?)''',
            (class_id, term_id, name, _text(task_type) or '材料收集',
             _text(material_name), _text(description), int(default_due_days), int(bool(enabled))),
        ).lastrowid
        audit.record(
            'class_task_template', template_id, 'create', summary=f'新增班级任务模板：{name}',
            params={'name': name, 'task_type': task_type},
            class_id=class_id, term_id=term_id, conn=conn, commit=False,
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return dict(conn.execute('SELECT * FROM class_task_templates WHERE id=?', (template_id,)).fetchone())


def update_template(template_id: int, *, name: str | None = None, task_type: str | None = None,
                    material_name: str | None = None, description: str | None = None,
                    default_due_days: int | None = None, enabled: bool | None = None,
                    conn=None) -> dict:
    conn = _conn(conn)
    current = _template_row(template_id, write=True, conn=conn)
    values = {
        'name': _text(name) if name is not None else current['name'],
        'task_type': _text(task_type) if task_type is not None else current['task_type'],
        'material_name': _text(material_name) if material_name is not None else current['material_name'],
        'description': _text(description) if description is not None else current['description'],
        'default_due_days': int(default_due_days) if default_due_days is not None else current['default_due_days'],
        'enabled': int(bool(enabled)) if enabled is not None else current['enabled'],
    }
    if not values['name']:
        raise ClassTaskError('模板名称不能为空')
    if not 0 <= values['default_due_days'] <= 366:
        raise ClassTaskError('默认截止天数必须在 0 到 366 天之间')
    try:
        conn.execute(
            '''UPDATE class_task_templates SET name=?, task_type=?, material_name=?,
                   description=?, default_due_days=?, enabled=?, updated_at=datetime('now','localtime')
               WHERE id=?''', (*values.values(), int(template_id)),
        )
        audit.record(
            'class_task_template', template_id, 'update', summary=f"更新班级任务模板：{values['name']}",
            params=values, conn=conn, commit=False,
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return dict(conn.execute('SELECT * FROM class_task_templates WHERE id=?', (template_id,)).fetchone())


def template_defaults(template_id: int, *, conn=None) -> dict:
    return _template_row(template_id, conn=conn)


def create_task(*, title: str, task_type: str = '材料收集', start_at: str = '', due_at: str = '',
                material_name: str = '', description: str = '', student_ids: list[int] | None = None,
                template_id: int | None = None, conn=None) -> dict:
    conn = _conn(conn)
    title = _text(title)
    student_ids = [int(item) for item in (student_ids or [])]
    if not title:
        raise ClassTaskError('任务名称不能为空')
    if not student_ids:
        raise ClassTaskError('至少选择一名参与学生')
    if len(set(student_ids)) != len(student_ids):
        raise ClassTaskError('参与学生不能重复')
    class_id, term_id = _scope(write=True, conn=conn)
    if template_id is not None:
        _template_row(template_id, write=True, conn=conn)
    for student_id in student_ids:
        class_context.ensure_student_in_scope(student_id, write=True, conn=conn)
    try:
        task_id = conn.execute(
            '''INSERT INTO class_tasks(
                   title, task_type, start_at, due_at, material_name, description,
                   status, class_id, term_id, template_id
               ) VALUES(?,?,?,?,?,?, '进行中', ?,?,?)''',
            (title, _text(task_type) or '材料收集', _text(start_at)[:19], _text(due_at)[:19],
             _text(material_name), _text(description), class_id, term_id, template_id),
        ).lastrowid
        conn.executemany(
            'INSERT INTO class_task_items(task_id, student_id) VALUES(?,?)',
            [(task_id, student_id) for student_id in student_ids],
        )
        from . import work_items
        work_items.ensure_source_work_item(
            title=title, source_type='class_task', source_id=task_id,
            scheduled_at=_text(start_at)[:19], due_at=_text(due_at)[:19],
            notes=_text(description), conn=conn, commit=False,
        )
        audit.record(
            'class_task', task_id, 'create', summary=f'新增班级任务：{title}',
            params={'task_type': task_type, 'student_count': len(student_ids), 'template_id': template_id},
            class_id=class_id, term_id=term_id, conn=conn, commit=False,
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return get_task(task_id, conn=conn)


def _missing(task_id: int, *, conn=None) -> list[dict]:
    return [item for item in _item_rows(task_id, conn=conn) if item['status'] == '未提交']


def update_task(task_id: int, *, status: str | None = None, description: str | None = None,
                start_at: str | None = None, due_at: str | None = None,
                completion_result: str | None = None, confirm_incomplete: bool = False,
                conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        current = _task_row(task_id, write=True, conn=conn)
        next_status = status or current['status']
        if next_status not in TASK_STATUSES:
            raise ClassTaskError('班级任务状态不合法')
        completion_result = _text(completion_result) if completion_result is not None else _text(current['completion_result'])
        closing = next_status in {'已完成', '已取消'} and current['status'] not in {'已完成', '已取消'}
        missing = _missing(task_id, conn=conn)
        if closing and next_status == '已完成' and missing and not confirm_incomplete:
            raise IncompleteTaskError(missing)
        if closing and not completion_result:
            raise ClassTaskError('完成或取消班级任务时必须填写结果')
        values = {
            'description': _text(description) if description is not None else current['description'],
            'start_at': _text(start_at)[:19] if start_at is not None else current['start_at'],
            'due_at': _text(due_at)[:19] if due_at is not None else current['due_at'],
            'status': next_status,
            'completed_at': _now() if next_status == '已完成' else '',
            'completion_result': completion_result if next_status in {'已完成', '已取消'} else '',
            'closed_with_missing_count': len(missing) if next_status in {'已完成', '已取消'} else 0,
        }
        class_id, term_id = _scope(write=True, conn=conn)
        try:
            conn.execute(
                '''UPDATE class_tasks SET description=?, start_at=?, due_at=?, status=?,
                       completed_at=?, completion_result=?, closed_with_missing_count=?,
                       updated_at=datetime('now','localtime')
                   WHERE id=? AND class_id=? AND term_id=?''',
                (values['description'], values['start_at'], values['due_at'], values['status'],
                 values['completed_at'], values['completion_result'], values['closed_with_missing_count'],
                 int(task_id), class_id, term_id),
            )
            _sync_work_item(current, values, conn=conn)
            audit.record(
                'class_task', task_id, 'update', summary=f"更新班级任务：{current['title']}",
                params={'status': next_status, 'completion_result': completion_result,
                        'missing_count': len(missing)},
                class_id=class_id, term_id=term_id, conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return get_task(task_id, conn=conn)


def _sync_work_item(before: dict, values: dict, *, conn):
    from . import work_items
    linked = conn.execute(
        '''SELECT * FROM student_tasks
           WHERE class_id=? AND term_id=? AND source_type='class_task' AND source_id=?
             AND deleted_at='' ORDER BY id LIMIT 1''',
        (before['class_id'], before['term_id'], before['id']),
    ).fetchone()
    if not linked:
        return
    next_status = '已完成' if values['status'] == '已完成' else '已取消' if values['status'] == '已取消' else '待处理'
    work_items.update_work_item(
        linked['id'], title=before['title'], scheduled_at=values['start_at'], due_at=values['due_at'],
        status=next_status, notes=values['description'], result=values['completion_result'],
        conn=conn, commit=False, sync_source=False,
    )


def update_item(task_id: int, student_id: int, *, status: str, note: str = '', conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        task = _task_row(task_id, write=True, conn=conn)
        if task['status'] != '进行中':
            raise ClassTaskError('已关闭的班级任务不能修改提交状态')
        if status not in ITEM_STATUSES:
            raise ClassTaskError('材料提交状态不合法')
        class_context.ensure_student_in_scope(student_id, write=True, conn=conn)
        row = conn.execute(
            'SELECT * FROM class_task_items WHERE task_id=? AND student_id=?',
            (int(task_id), int(student_id)),
        ).fetchone()
        if not row:
            raise ClassTaskError('任务中没有该学生')
        submitted_at = _now() if status in {'已提交', '免交'} else ''
        try:
            conn.execute(
                '''UPDATE class_task_items SET status=?, note=?, submitted_at=?,
                       updated_at=datetime('now','localtime')
                   WHERE task_id=? AND student_id=?''',
                (status, _text(note), submitted_at, int(task_id), int(student_id)),
            )
            audit.record(
                'class_task_item', row['id'], 'update', summary=f'更新材料提交状态：{status}',
                params={'task_id': task_id, 'student_id': student_id, 'status': status},
                conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return get_task(task_id, conn=conn)


def update_items(task_id: int, student_ids: list[int], *, status: str, note: str = '', conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        task = _task_row(task_id, write=True, conn=conn)
        if task['status'] != '进行中':
            raise ClassTaskError('已关闭的班级任务不能修改提交状态')
        if status not in ITEM_STATUSES:
            raise ClassTaskError('材料提交状态不合法')
        ids = sorted({int(student_id) for student_id in (student_ids or [])})
        if not ids:
            raise ClassTaskError('至少选择一名学生')
        for student_id in ids:
            class_context.ensure_student_in_scope(student_id, write=True, conn=conn)
        placeholders = ','.join('?' for _ in ids)
        rows = conn.execute(
            f'SELECT student_id FROM class_task_items WHERE task_id=? AND student_id IN ({placeholders})',
            (int(task_id), *ids),
        ).fetchall()
        if len(rows) != len(ids):
            raise ClassTaskError('任务中没有所选学生')
        submitted_at = _now() if status in {'已提交', '免交'} else ''
        try:
            conn.execute(
                f'''UPDATE class_task_items SET status=?, note=?, submitted_at=?,
                       updated_at=datetime('now','localtime')
                   WHERE task_id=? AND student_id IN ({placeholders})''',
                (status, _text(note), submitted_at, int(task_id), *ids),
            )
            class_id, term_id = _scope(write=True, conn=conn)
            audit.record(
                'class_task', task_id, 'bulk_update_items',
                summary=f'批量更新材料提交状态：{status}（{len(ids)}名学生）',
                params={'student_ids': ids, 'status': status},
                class_id=class_id, term_id=term_id, conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return get_task(task_id, conn=conn)


def remind(task_id: int, student_ids: list[int] | None = None, *, conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        task = _task_row(task_id, write=True, conn=conn)
        if task['status'] != '进行中':
            raise ClassTaskError('已关闭的班级任务不能催办')
        rows = _missing(task_id, conn=conn)
        allowed = {int(row['student_id']) for row in rows}
        selected = sorted(allowed if student_ids is None else {int(item) for item in student_ids} & allowed)
        if not selected:
            return {'ok': True, 'reminded': 0, 'items': []}
        try:
            now = _now()
            placeholders = ','.join('?' for _ in selected)
            conn.execute(
                f'''UPDATE class_task_items SET reminder_count=reminder_count+1,
                       last_reminded_at=?, updated_at=datetime('now','localtime')
                   WHERE task_id=? AND student_id IN ({placeholders}) AND status='未提交' ''',
                (now, int(task_id), *selected),
            )
            audit.record(
                'class_task', task_id, 'remind', summary=f'批量催办 {len(selected)} 名学生',
                params={'student_ids': selected}, conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {'ok': True, 'reminded': len(selected), 'items': selected}


def save_attachment(task_id: int, student_id: int, *, filename: str, content_type: str,
                    content: bytes, conn=None) -> dict:
    conn = _conn(conn)
    task = _task_row(task_id, write=True, conn=conn)
    if task['status'] != '进行中':
        raise ClassTaskError('已关闭的班级任务不能上传材料')
    item = conn.execute(
        '''SELECT i.* FROM class_task_items i
           JOIN students s ON s.id=i.student_id
           WHERE i.task_id=? AND i.student_id=? AND s.deleted_at='' ''',
        (int(task_id), int(student_id)),
    ).fetchone()
    if not item:
        raise ClassTaskError('任务中没有该学生')
    data = bytes(content or b'')
    if not data:
        raise ClassTaskError('附件不能为空')
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise ClassTaskError('附件不能超过 10MB')
    original_name = Path(os.path.basename(_text(filename) or '提交材料')).name[:160]
    suffix = Path(original_name).suffix[:12]
    stored_name = f'{uuid4().hex}{suffix}'
    relative_path = os.path.join('attachments', 'class-tasks', str(task_id), str(item['id']), stored_name)
    root = os.path.abspath(db.DATA_DIR)
    target = os.path.abspath(os.path.join(root, relative_path))
    if not target.startswith(root + os.sep):
        raise ClassTaskError('附件路径不合法')
    os.makedirs(os.path.dirname(target), exist_ok=True)
    temp_path = f'{target}.tmp-{uuid4().hex}'
    try:
        with open(temp_path, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
        digest = hashlib.sha256(data).hexdigest()
        attachment_id = conn.execute(
            '''INSERT INTO class_task_attachments(
                   task_id, item_id, original_name, stored_name, relative_path,
                   content_type, size_bytes, sha256
               ) VALUES(?,?,?,?,?,?,?,?)''',
            (int(task_id), int(item['id']), original_name, stored_name, relative_path,
             _text(content_type) or 'application/octet-stream', len(data), digest),
        ).lastrowid
        audit.record(
            'class_task_attachment', attachment_id, 'create', summary=f'上传材料：{original_name}',
            params={'task_id': task_id, 'student_id': student_id, 'size_bytes': len(data)},
            conn=conn, commit=False,
        )
        conn.commit()
    except Exception:
        conn.rollback()
        try:
            os.unlink(target)
        except FileNotFoundError:
            pass
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
        raise
    return {
        'id': int(attachment_id), 'item_id': int(item['id']), 'original_name': original_name,
        'content_type': _text(content_type) or 'application/octet-stream',
        'size_bytes': len(data), 'download_path': f'/api/class-tasks/attachments/{attachment_id}',
    }


def attachment_file(attachment_id: int, *, conn=None) -> tuple[dict, str]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    row = conn.execute(
        '''SELECT a.* FROM class_task_attachments a
           JOIN class_tasks t ON t.id=a.task_id
           WHERE a.id=? AND t.class_id=? AND t.term_id=? AND t.deleted_at='' ''',
        (int(attachment_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise ClassTaskError('材料附件不存在')
    root = os.path.abspath(db.DATA_DIR)
    path = os.path.abspath(os.path.join(root, row['relative_path']))
    if not path.startswith(root + os.sep) or not os.path.isfile(path):
        raise ClassTaskError('材料附件文件不存在')
    return dict(row), path


def on_work_item_transition(conn, before: dict, next_status: str, result: str):
    """统一工作项变化时回写班级任务；完成未收齐任务必须显式从来源页确认。"""
    task_id = before.get('source_id')
    if before.get('source_type') != 'class_task' or not task_id:
        return
    task = conn.execute(
        "SELECT * FROM class_tasks WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (task_id, before['class_id'], before['term_id']),
    ).fetchone()
    if not task:
        return
    if next_status == '已完成':
        missing = _missing(task_id, conn=conn)
        if missing:
            raise ClassTaskError('材料尚未收齐，请从班级任务页面确认未提交名单后完成')
        task_status = '已完成'
    elif next_status == '已取消':
        task_status = '已取消'
    else:
        task_status = '进行中'
    conn.execute(
        '''UPDATE class_tasks SET status=?, completed_at=?, completion_result=?,
               closed_with_missing_count=?, updated_at=datetime('now','localtime')
           WHERE id=?''',
        (task_status, _now() if task_status == '已完成' else '', _text(result),
         0, int(task_id)),
    )
