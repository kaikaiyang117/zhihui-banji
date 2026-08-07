# -*- coding: utf-8 -*-
"""值日安排、轮换规则和冲突检查业务服务。"""
from __future__ import annotations

from datetime import date, datetime, timedelta
import threading

from .. import db
from . import audit, class_context


ASSIGNMENT_STATUSES = {'待完成', '已完成'}
_write_lock = threading.RLock()


class DutyError(ValueError):
    pass


class DutyConflictError(DutyError):
    def __init__(self, conflicts: list[dict]):
        self.conflicts = conflicts
        super().__init__(f'发现 {len(conflicts)} 项值日冲突，请调整后再生成')


def _conn(conn=None):
    return conn or db.get_conn()


def _now() -> str:
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def _text(value) -> str:
    return str(value or '').strip()


def _scope(*, write: bool = False, conn=None) -> tuple[int, int]:
    return class_context.scope_ids(write=write, conn=_conn(conn))


def _date(value: str, label: str = '日期') -> date:
    try:
        return date.fromisoformat(_text(value)[:10])
    except (TypeError, ValueError) as exc:
        raise DutyError(f'{label}格式不正确，应为 YYYY-MM-DD') from exc


def _assignment_row(assignment_id: int, *, write: bool = False, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=write, conn=conn)
    row = conn.execute(
        "SELECT * FROM duty_assignments WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (int(assignment_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise DutyError('值日安排不存在')
    return dict(row)


def _decorate(row: dict) -> dict:
    result = dict(row)
    result['is_overdue'] = result['status'] == '待完成' and result['duty_date'] < date.today().isoformat()
    return result


def list_assignments(*, duty_date: str = '', date_from: str = '', date_to: str = '',
                     source_id: int | None = None, conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    where = ["d.class_id=?", "d.term_id=?", "d.deleted_at='' ", "s.deleted_at='' "]
    params: list = [class_id, term_id]
    if source_id:
        where.append('d.id=?')
        params.append(int(source_id))
    if duty_date:
        where.append('d.duty_date=?')
        params.append(_date(duty_date).isoformat())
    else:
        if date_from:
            where.append('d.duty_date>=?')
            params.append(_date(date_from, '开始日期').isoformat())
        if date_to:
            where.append('d.duty_date<=?')
            params.append(_date(date_to, '结束日期').isoformat())
    rows = conn.execute(
        '''SELECT d.*, s.学号, s.姓名, r.name AS rotation_rule_name
           FROM duty_assignments d
           JOIN students s ON s.id=d.student_id
           LEFT JOIN duty_rotation_rules r ON r.id=d.rotation_rule_id
           WHERE ''' + ' AND '.join(where) +
        ' ORDER BY d.duty_date, d.area, s.学号', tuple(params),
    ).fetchall()
    return [_decorate(dict(row)) for row in rows]


def get_assignment(assignment_id: int, *, conn=None) -> dict:
    rows = list_assignments(source_id=assignment_id, conn=conn)
    if not rows:
        raise DutyError('值日安排不存在')
    return rows[0]


def _student_ids(student_ids: list[int], *, conn) -> list[int]:
    values = [int(item) for item in student_ids]
    if not values:
        raise DutyError('轮换规则至少需要一名学生')
    if len(set(values)) != len(values):
        raise DutyError('轮换学生不能重复')
    for student_id in values:
        class_context.ensure_student_in_scope(student_id, write=True, conn=conn)
    return values


def _conflicts_for_assignment(*, duty_date: str, area: str, student_id: int,
                              rotation_rule_id: int | None = None, conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    rows = conn.execute(
        '''SELECT d.id, d.duty_date, d.area, d.student_id, s.姓名
           FROM duty_assignments d JOIN students s ON s.id=d.student_id
           WHERE d.class_id=? AND d.term_id=? AND d.duty_date=?
             AND d.student_id=? AND d.deleted_at='' AND d.area<>?''',
        (class_id, term_id, duty_date, int(student_id), _text(area)),
    ).fetchall()
    return [dict(row) for row in rows]


def _sync_work_item(before: dict | None, values: dict, *, conn):
    if not before:
        return
    from . import work_items
    linked = conn.execute(
        '''SELECT * FROM student_tasks
           WHERE class_id=? AND term_id=? AND source_type='duty_assignment' AND source_id=?
             AND deleted_at='' ORDER BY id LIMIT 1''',
        (before['class_id'], before['term_id'], before['id']),
    ).fetchone()
    if not linked:
        return
    next_status = '已完成' if values['status'] == '已完成' else '待处理'
    work_items.update_work_item(
        linked['id'], title=f"值日 · {before['area']}",
        scheduled_at=values['duty_date'], due_at=values['duty_date'],
        status=next_status, notes=values['note'], result=values['completion_result'],
        conn=conn, commit=False, sync_source=False,
    )


def create_assignment(*, duty_date: str, area: str, student_id: int,
                      status: str = '待完成', note: str = '',
                      rotation_rule_id: int | None = None, rotation_index: int | None = None,
                      completion_result: str = '', conn=None, commit: bool = True) -> dict:
    conn = _conn(conn)
    duty_date = _date(duty_date).isoformat()
    area = _text(area)
    if not area:
        raise DutyError('值日区域不能为空')
    if status not in ASSIGNMENT_STATUSES:
        raise DutyError('值日状态不合法')
    if status == '已完成' and not _text(completion_result):
        raise DutyError('完成值日时必须填写完成记录')
    class_id, term_id = _scope(write=True, conn=conn)
    class_context.ensure_student_in_scope(student_id, write=True, conn=conn)
    conflicts = _conflicts_for_assignment(
        duty_date=duty_date, area=area, student_id=student_id, conn=conn)
    if conflicts:
        raise DutyConflictError(conflicts)
    existing = conn.execute(
        '''SELECT * FROM duty_assignments
           WHERE class_id=? AND term_id=? AND duty_date=? AND area=? AND student_id=?
             AND deleted_at='' ''',
        (class_id, term_id, duty_date, area, int(student_id)),
    ).fetchone()
    values = {
        'duty_date': duty_date, 'area': area, 'student_id': int(student_id),
        'status': status, 'note': _text(note),
        'completed_at': _now() if status == '已完成' else '',
        'completion_result': _text(completion_result) if status == '已完成' else '',
    }
    try:
        conn.execute(
            '''INSERT INTO duty_assignments(
                   duty_date, area, student_id, class_id, term_id, status, note,
                   rotation_rule_id, rotation_index, completed_at, completion_result
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(class_id, term_id, duty_date, area, student_id)
               DO UPDATE SET status=excluded.status, note=excluded.note,
                   rotation_rule_id=excluded.rotation_rule_id,
                   rotation_index=excluded.rotation_index,
                   completed_at=excluded.completed_at,
                   completion_result=excluded.completion_result,
                   updated_at=datetime('now','localtime')''',
            (duty_date, area, int(student_id), class_id, term_id, status, values['note'],
             rotation_rule_id, rotation_index, values['completed_at'], values['completion_result']),
        )
        row = conn.execute(
            '''SELECT * FROM duty_assignments
               WHERE class_id=? AND term_id=? AND duty_date=? AND area=? AND student_id=?
                 AND deleted_at='' ''',
            (class_id, term_id, duty_date, area, int(student_id)),
        ).fetchone()
        before = dict(existing) if existing else None
        if before:
            _sync_work_item(before, values, conn=conn)
        elif status != '已完成':
            from . import work_items
            work_items.ensure_source_work_item(
                title=f'值日 · {area}', student_id=int(student_id),
                source_type='duty_assignment', source_id=row['id'],
                scheduled_at=duty_date, due_at=duty_date, status='待处理',
                notes=values['note'], conn=conn, commit=False,
            )
        audit.record(
            'duty_assignment', row['id'], 'create' if not before else 'update',
            summary=f'保存值日安排：{area}',
            params={'duty_date': duty_date, 'student_id': student_id, 'status': status},
            class_id=class_id, term_id=term_id, conn=conn, commit=False,
        )
        if commit:
            conn.commit()
    except Exception:
        if commit:
            conn.rollback()
        raise
    return get_assignment(row['id'], conn=conn)


def update_assignment(assignment_id: int, *, status: str, note: str = '',
                      completion_result: str = '', conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        current = _assignment_row(assignment_id, write=True, conn=conn)
        if status not in ASSIGNMENT_STATUSES:
            raise DutyError('值日状态不合法')
        completion_result = _text(completion_result) or (_text(current['completion_result']) if status == '已完成' else '')
        if status == '已完成' and not completion_result:
            raise DutyError('完成值日时必须填写完成记录')
        values = {
            'duty_date': current['duty_date'], 'status': status, 'note': _text(note),
            'completion_result': completion_result,
        }
        class_id, term_id = _scope(write=True, conn=conn)
        try:
            conn.execute(
                '''UPDATE duty_assignments SET status=?, note=?, completed_at=?,
                       completion_result=?, updated_at=datetime('now','localtime')
                   WHERE id=? AND class_id=? AND term_id=? AND deleted_at='' ''',
                (status, values['note'], _now() if status == '已完成' else '', completion_result,
                 int(assignment_id), class_id, term_id),
            )
            _sync_work_item(current, values, conn=conn)
            audit.record(
                'duty_assignment', assignment_id, 'update', summary=f'更新值日状态：{status}',
                params={'status': status, 'completion_result': completion_result},
                class_id=class_id, term_id=term_id, conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return get_assignment(assignment_id, conn=conn)


def list_rotation_rules(*, include_disabled: bool = False, conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    where = ["r.class_id=?", "r.term_id=?", "r.deleted_at='' "]
    params: list = [class_id, term_id]
    if not include_disabled:
        where.append('r.enabled=1')
    result = []
    for row in conn.execute(
        '''SELECT r.* FROM duty_rotation_rules r WHERE ''' + ' AND '.join(where) +
        ' ORDER BY r.enabled DESC, r.area, r.id', tuple(params),
    ).fetchall():
        item = dict(row)
        item['members'] = [dict(member) for member in conn.execute(
            '''SELECT m.*, s.学号, s.姓名 FROM duty_rotation_members m
               JOIN students s ON s.id=m.student_id WHERE m.rule_id=? AND m.enabled=1
               ORDER BY m.position''', (item['id'],)
        ).fetchall()]
        result.append(item)
    return result


def create_rotation_rule(*, name: str, area: str, start_date: str, end_date: str = '',
                         weekday_mask: int = 31, student_ids: list[int], enabled: bool = True,
                         conn=None) -> dict:
    conn = _conn(conn)
    name, area = _text(name), _text(area)
    start = _date(start_date, '开始日期').isoformat()
    end = _date(end_date, '结束日期').isoformat() if _text(end_date) else ''
    if end and end < start:
        raise DutyError('结束日期不能早于开始日期')
    mask = int(weekday_mask)
    if mask < 1 or mask > 127:
        raise DutyError('值日星期范围不合法')
    if not name or not area:
        raise DutyError('轮换规则名称和区域不能为空')
    class_id, term_id = _scope(write=True, conn=conn)
    members = _student_ids(student_ids, conn=conn)
    try:
        rule_id = conn.execute(
            '''INSERT INTO duty_rotation_rules(
                   class_id, term_id, name, area, start_date, end_date, weekday_mask, enabled
               ) VALUES(?,?,?,?,?,?,?,?)''',
            (class_id, term_id, name, area, start, end, mask, int(bool(enabled))),
        ).lastrowid
        conn.executemany(
            'INSERT INTO duty_rotation_members(rule_id, student_id, position) VALUES(?,?,?)',
            [(rule_id, student_id, position) for position, student_id in enumerate(members)],
        )
        audit.record(
            'duty_rotation_rule', rule_id, 'create', summary=f'新增值日轮换规则：{name}',
            params={'area': area, 'student_count': len(members)},
            class_id=class_id, term_id=term_id, conn=conn, commit=False,
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return next(rule for rule in list_rotation_rules(include_disabled=True, conn=conn) if rule['id'] == rule_id)


def _rule(rule_id: int, *, write: bool = False, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=write, conn=conn)
    row = conn.execute(
        "SELECT * FROM duty_rotation_rules WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (int(rule_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise DutyError('值日轮换规则不存在')
    item = dict(row)
    item['members'] = [dict(member) for member in conn.execute(
        'SELECT * FROM duty_rotation_members WHERE rule_id=? AND enabled=1 ORDER BY position',
        (int(rule_id),),
    ).fetchall()]
    if not item['members']:
        raise DutyError('值日轮换规则没有可用学生')
    return item


def preview_rotation(rule_id: int, *, date_from: str = '', date_to: str = '', conn=None) -> dict:
    conn = _conn(conn)
    rule = _rule(rule_id, conn=conn)
    start = _date(date_from or rule['start_date'], '开始日期')
    end = _date(date_to or rule['end_date'] or (start + timedelta(days=30)).isoformat(), '结束日期')
    if end < start:
        raise DutyError('结束日期不能早于开始日期')
    rule_start = _date(rule['start_date'])
    members = rule['members']
    proposals = []
    cursor = start
    while cursor <= end:
        bit = 1 << cursor.weekday()
        if cursor >= rule_start and int(rule['weekday_mask']) & bit:
            occurrence = (cursor - rule_start).days
            eligible_days = sum(
                1 for offset in range(max(0, occurrence) + 1)
                if int(rule['weekday_mask']) & (1 << ((rule_start + timedelta(days=offset)).weekday()))
            ) - 1
            member = members[eligible_days % len(members)]
            existing_same_area = conn.execute(
                '''SELECT d.id, d.student_id, s.姓名 FROM duty_assignments d
                   JOIN students s ON s.id=d.student_id
                   WHERE d.class_id=? AND d.term_id=? AND d.duty_date=? AND d.area=?
                     AND d.deleted_at='' ''',
                (rule['class_id'], rule['term_id'], cursor.isoformat(), rule['area']),
            ).fetchall()
            conflicts = _conflicts_for_assignment(
                duty_date=cursor.isoformat(), area=rule['area'], student_id=member['student_id'], conn=conn)
            for existing in existing_same_area:
                if int(existing['student_id']) != int(member['student_id']):
                    conflicts.append({**dict(existing), 'reason': '同一区域已有其他学生'})
            proposals.append({
                'duty_date': cursor.isoformat(), 'area': rule['area'],
                'student_id': member['student_id'], '姓名': member.get('姓名', ''),
                'rotation_index': eligible_days, 'conflicts': conflicts,
                'existing': [dict(item) for item in existing_same_area],
            })
        cursor += timedelta(days=1)
    conflicts = [item for item in proposals if item['conflicts']]
    return {'rule': rule, 'proposals': proposals, 'conflicts': conflicts,
            'can_generate': not conflicts and bool(proposals)}


def generate_rotation(rule_id: int, *, date_from: str = '', date_to: str = '',
                      confirm: bool = False, conn=None) -> dict:
    conn = _conn(conn)
    preview = preview_rotation(rule_id, date_from=date_from, date_to=date_to, conn=conn)
    if preview['conflicts']:
        raise DutyConflictError(preview['conflicts'])
    if not confirm:
        return {'preview': True, **preview}
    with _write_lock:
        try:
            created = 0
            for item in preview['proposals']:
                existing = conn.execute(
                    '''SELECT * FROM duty_assignments
                       WHERE class_id=? AND term_id=? AND duty_date=? AND area=? AND student_id=?
                         AND deleted_at='' ''',
                    (preview['rule']['class_id'], preview['rule']['term_id'], item['duty_date'],
                     item['area'], item['student_id']),
                ).fetchone()
                create_assignment(
                    duty_date=item['duty_date'], area=item['area'], student_id=item['student_id'],
                    rotation_rule_id=rule_id, rotation_index=item['rotation_index'], conn=conn,
                    commit=False,
                )
                if not existing:
                    created += 1
            audit.record(
                'duty_rotation_rule', rule_id, 'generate', summary=f'生成值日安排 {created} 项',
                params={'date_from': date_from, 'date_to': date_to, 'created': created},
                conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {'preview': False, 'created': created, **preview}


def on_work_item_transition(conn, before: dict, next_status: str, result: str):
    """统一工作项变化时回写值日完成状态。"""
    assignment_id = before.get('source_id')
    if before.get('source_type') != 'duty_assignment' or not assignment_id:
        return
    assignment = conn.execute(
        "SELECT * FROM duty_assignments WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (assignment_id, before['class_id'], before['term_id']),
    ).fetchone()
    if not assignment:
        return
    status = '已完成' if next_status == '已完成' else '待完成'
    conn.execute(
        '''UPDATE duty_assignments SET status=?, completed_at=?, completion_result=?,
               updated_at=datetime('now','localtime') WHERE id=?''',
        (status, _now() if status == '已完成' else '', _text(result), int(assignment_id)),
    )
