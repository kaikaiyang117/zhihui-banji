# -*- coding: utf-8 -*-
"""班会、活动、日志的结构化记录与统一行动关联。"""
from __future__ import annotations

from datetime import date, datetime
import hashlib
import json
import os
import re
import threading
from uuid import uuid4

from .. import clock, db
from .. import config
from . import audit, class_context, work_items


MEETING_FORMATS = {'主题班会', '事务通知', '团队活动', '安全教育', '心理健康'}
MEETING_STATUSES = {'已记录', '待复盘'}
ACTIVITY_TYPES = {'文体活动', '社会实践', '志愿服务', '学科竞赛', '节日庆祝', '其他'}
ACTIVITY_STATUSES = {'计划中', '进行中', '已完成', '已复盘'}
LINK_TYPES = {'meeting', 'activity', 'event', 'work_item', 'student'}
_write_lock = threading.RLock()
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024


class EducationError(ValueError):
    pass


def _conn(conn=None):
    return conn or db.get_conn()


def _text(value) -> str:
    return str(value or '').strip()


def _now() -> str:
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def _date(value, label: str, *, default_today: bool = False) -> str:
    text = _text(value)[:10]
    if not text and default_today:
        text = clock.today().isoformat()
    try:
        return date.fromisoformat(text).isoformat()
    except (TypeError, ValueError) as exc:
        raise EducationError(f'{label}格式不正确，应为 YYYY-MM-DD') from exc


def _scope(*, write=False, conn=None):
    return class_context.scope_ids(write=write, conn=_conn(conn))


def _int(value, label: str, *, minimum: int = 0) -> int:
    try:
        number = int(value or 0)
    except (TypeError, ValueError) as exc:
        raise EducationError(f'{label}必须是整数') from exc
    if number < minimum:
        raise EducationError(f'{label}不能小于 {minimum}')
    return number


def _money(value) -> float:
    try:
        number = round(float(value or 0), 2)
    except (TypeError, ValueError) as exc:
        raise EducationError('预算必须是数字') from exc
    if number < 0:
        raise EducationError('预算不能为负数')
    return number


def _student_ids(values, *, conn=None):
    ids = []
    for value in values or []:
        student_id = _int(value, '学生 ID', minimum=1)
        class_context.ensure_student_in_scope(student_id, write=True, conn=_conn(conn))
        if student_id not in ids:
            ids.append(student_id)
    return ids


def _meeting_row(meeting_id: int, *, write=False, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=write, conn=conn)
    row = conn.execute(
        '''SELECT m.*, t.name AS template_name
           FROM meeting_records m LEFT JOIN meeting_templates t ON t.id=m.template_id
           WHERE m.id=? AND m.class_id=? AND m.term_id=? AND m.deleted_at='' ''',
        (int(meeting_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise EducationError('班会记录不存在')
    return dict(row)


def _activity_row(activity_id: int, *, write=False, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=write, conn=conn)
    row = conn.execute(
        '''SELECT a.*, t.name AS template_name
           FROM activity_records a LEFT JOIN activity_templates t ON t.id=a.template_id
           WHERE a.id=? AND a.class_id=? AND a.term_id=? AND a.deleted_at='' ''',
        (int(activity_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise EducationError('活动记录不存在')
    return dict(row)


def _decorate_meeting(row: dict, *, conn=None) -> dict:
    conn = _conn(conn)
    item = dict(row)
    item['participants'] = [dict(r) for r in conn.execute(
        '''SELECT p.*, s.学号, s.姓名 AS student_name
           FROM meeting_participants p JOIN students s ON s.id=p.student_id
           WHERE p.meeting_id=? AND s.deleted_at='' ORDER BY s.学号, s.id''',
        (item['id'],),
    ).fetchall()]
    item['actions'] = [dict(r) for r in conn.execute(
        'SELECT * FROM meeting_actions WHERE meeting_id=? ORDER BY id', (item['id'],)
    ).fetchall()]
    item['participant_count'] = len(item['participants'])
    item['legacy'] = bool(item.get('legacy_row_no'))
    return item


def _decorate_activity(row: dict, *, conn=None) -> dict:
    conn = _conn(conn)
    item = dict(row)
    item['participants'] = [dict(r) for r in conn.execute(
        '''SELECT p.*, s.学号, s.姓名 AS student_name
           FROM activity_participants p JOIN students s ON s.id=p.student_id
           WHERE p.activity_id=? AND s.deleted_at='' ORDER BY s.学号, s.id''',
        (item['id'],),
    ).fetchall()]
    item['attachments'] = [dict(r) for r in conn.execute(
        'SELECT * FROM activity_attachments WHERE activity_id=? ORDER BY id', (item['id'],)
    ).fetchall()]
    item['legacy'] = bool(item.get('legacy_row_no'))
    return item


def list_meetings(*, query: str = '', date_from: str = '', date_to: str = '',
                  include_deleted: bool = False, conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    where = ['m.class_id=?', 'm.term_id=?']
    params = [class_id, term_id]
    if not include_deleted:
        where.append("m.deleted_at=''")
    if _text(query):
        where.append('(m.topic LIKE ? OR m.content LIKE ? OR m.conclusion LIKE ?)')
        value = f'%{_text(query)}%'
        params.extend([value, value, value])
    if date_from:
        where.append('m.held_on>=?')
        params.append(_date(date_from, '开始日期'))
    if date_to:
        where.append('m.held_on<=?')
        params.append(_date(date_to, '结束日期'))
    rows = conn.execute(
        'SELECT m.*, t.name AS template_name FROM meeting_records m '
        'LEFT JOIN meeting_templates t ON t.id=m.template_id WHERE ' + ' AND '.join(where) +
        ' ORDER BY m.held_on DESC, m.id DESC', params,
    ).fetchall()
    return [_decorate_meeting(dict(row), conn=conn) for row in rows]


def list_activities(*, query: str = '', date_from: str = '', date_to: str = '', conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    where = ["a.class_id=?", "a.term_id=?", "a.deleted_at=''"]
    params = [class_id, term_id]
    if _text(query):
        where.append('(a.name LIKE ? OR a.summary LIKE ? OR a.retrospective LIKE ?)')
        value = f'%{_text(query)}%'
        params.extend([value, value, value])
    if date_from:
        where.append('a.occurred_on>=?')
        params.append(_date(date_from, '开始日期'))
    if date_to:
        where.append('a.occurred_on<=?')
        params.append(_date(date_to, '结束日期'))
    rows = conn.execute(
        'SELECT a.*, t.name AS template_name FROM activity_records a '
        'LEFT JOIN activity_templates t ON t.id=a.template_id WHERE ' + ' AND '.join(where) +
        ' ORDER BY a.occurred_on DESC, a.id DESC', params,
    ).fetchall()
    return [_decorate_activity(dict(row), conn=conn) for row in rows]


def list_diary(*, month: str = '', date_from: str = '', date_to: str = '', conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    where = ["d.class_id=?", "d.term_id=?", "d.deleted_at=''"]
    params = [class_id, term_id]
    if _text(month):
        if len(_text(month)) != 7 or _text(month)[4] != '-':
            raise EducationError('月份格式不正确，应为 YYYY-MM')
        where.append('substr(d.diary_date,1,7)=?')
        params.append(_text(month))
    if date_from:
        where.append('d.diary_date>=?')
        params.append(_date(date_from, '开始日期'))
    if date_to:
        where.append('d.diary_date<=?')
        params.append(_date(date_to, '结束日期'))
    rows = conn.execute(
        'SELECT d.* FROM diary_entries d WHERE ' + ' AND '.join(where) +
        ' ORDER BY d.diary_date DESC, d.id DESC', params,
    ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item['links'] = [dict(link) for link in conn.execute(
            'SELECT * FROM diary_links WHERE diary_id=? ORDER BY id', (item['id'],)
        ).fetchall()]
        item['legacy'] = bool(item.get('legacy_row_no'))
        result.append(item)
    return result


def list_templates(*, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    return {
        'meetings': [dict(row) for row in conn.execute(
            'SELECT * FROM meeting_templates WHERE class_id=? AND term_id=? AND enabled=1 ORDER BY name',
            (class_id, term_id)).fetchall()],
        'activities': [dict(row) for row in conn.execute(
            'SELECT * FROM activity_templates WHERE class_id=? AND term_id=? AND enabled=1 ORDER BY name',
            (class_id, term_id)).fetchall()],
    }


def create_template(kind: str, *, name: str, content: str = '', format: str = '主题班会',
                    activity_type: str = '其他', description: str = '', conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=True, conn=conn)
    name = _text(name)
    if not name:
        raise EducationError('模板名称不能为空')
    try:
        if kind == 'meeting':
            if format not in MEETING_FORMATS:
                raise EducationError('班会形式不合法')
            row_id = conn.execute(
                'INSERT INTO meeting_templates(class_id,term_id,name,format,content) VALUES(?,?,?,?,?)',
                (class_id, term_id, name, format, _text(content)),
            ).lastrowid
        elif kind == 'activity':
            if activity_type not in ACTIVITY_TYPES:
                raise EducationError('活动类型不合法')
            row_id = conn.execute(
                'INSERT INTO activity_templates(class_id,term_id,name,activity_type,description) VALUES(?,?,?,?,?)',
                (class_id, term_id, name, activity_type, _text(description)),
            ).lastrowid
        else:
            raise EducationError('不支持的模板类型')
        audit.record(f'{kind}_template', row_id, 'create', summary=f'新增{kind}模板：{name}',
                     params={'name': name}, class_id=class_id, term_id=term_id, conn=conn)
    except EducationError:
        raise
    except Exception as exc:
        conn.rollback()
        if 'UNIQUE' in str(exc).upper():
            raise EducationError('当前班级与学期已有同名模板') from exc
        raise
    return {'id': int(row_id), 'name': name}


def create_meeting(*, held_on: str, topic: str, format: str = '主题班会', content: str = '',
                   participation: str = '', conclusion: str = '', status: str = '已记录',
                   template_id: int | None = None, student_ids=None, action_items=None,
                   followup_title: str = '', followup_due: str = '', conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=True, conn=conn)
    held_on, topic = _date(held_on, '班会日期', default_today=True), _text(topic)
    if not topic:
        raise EducationError('班会主题不能为空')
    if format not in MEETING_FORMATS or status not in MEETING_STATUSES:
        raise EducationError('班会形式或状态不合法')
    ids = _student_ids(student_ids, conn=conn)
    actions = list(action_items or [])
    if followup_title.strip():
        actions.append({'title': followup_title, 'due_at': followup_due})
    try:
        meeting_id = conn.execute(
            '''INSERT INTO meeting_records(
                 class_id,term_id,template_id,held_on,topic,format,content,participation,conclusion,status
               ) VALUES(?,?,?,?,?,?,?,?,?,?)''',
            (class_id, term_id, template_id, held_on, topic, format, _text(content),
             _text(participation), _text(conclusion), status),
        ).lastrowid
        conn.executemany(
            'INSERT INTO meeting_participants(meeting_id,student_id) VALUES(?,?)',
            [(meeting_id, student_id) for student_id in ids],
        )
        for action in actions:
            title = _text(action.get('title'))
            if not title:
                continue
            due_at = _text(action.get('due_at'))[:30]
            action_id = conn.execute(
                'INSERT INTO meeting_actions(meeting_id,title,owner,due_at) VALUES(?,?,?,?)',
                (meeting_id, title, _text(action.get('owner')) or '班主任', due_at),
            ).lastrowid
            item = work_items.ensure_source_work_item(
                title=title, source_type='meeting_action', source_id=action_id,
                source_label='班会行动项', due_at=due_at, priority=_text(action.get('priority')) or '普通',
                notes=f'来源：班会 #{meeting_id}', conn=conn, commit=False,
            )
            conn.execute('UPDATE meeting_actions SET work_item_id=? WHERE id=?', (item['id'], action_id))
        audit.record('meeting', meeting_id, 'create', summary=f'新增班会：{topic}',
                     params={'held_on': held_on, 'participant_count': len(ids), 'action_count': len(actions)},
                     class_id=class_id, term_id=term_id, conn=conn, commit=False)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _decorate_meeting(_meeting_row(meeting_id, conn=conn), conn=conn)


def update_meeting(meeting_id: int, *, values: dict, conn=None) -> dict:
    conn = _conn(conn)
    current = _meeting_row(meeting_id, write=True, conn=conn)
    allowed = {'held_on', 'topic', 'format', 'content', 'participation', 'conclusion', 'status', 'template_id'}
    updates, params = [], []
    for key in allowed:
        if key not in values:
            continue
        value = values[key]
        if key == 'held_on':
            value = _date(value, '班会日期')
        elif key == 'topic':
            value = _text(value)
            if not value:
                raise EducationError('班会主题不能为空')
        elif key == 'format' and value not in MEETING_FORMATS:
            raise EducationError('班会形式不合法')
        elif key == 'status' and value not in MEETING_STATUSES:
            raise EducationError('班会状态不合法')
        updates.append(f'{key}=?')
        params.append(value)
    ids = _student_ids(values['student_ids'], conn=conn) if 'student_ids' in values else None
    if not updates and ids is None:
        return _decorate_meeting(current, conn=conn)
    params.extend([_now(), meeting_id])
    try:
        if updates:
            conn.execute('UPDATE meeting_records SET ' + ','.join(updates) + ',updated_at=? WHERE id=?', params)
        if ids is not None:
            conn.execute('DELETE FROM meeting_participants WHERE meeting_id=?', (meeting_id,))
            conn.executemany('INSERT INTO meeting_participants(meeting_id,student_id) VALUES(?,?)',
                             [(meeting_id, student_id) for student_id in ids])
        audit.record('meeting', meeting_id, 'update', summary='更新班会记录',
                     params={'fields': sorted(set(allowed) & set(values))})
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _decorate_meeting(_meeting_row(meeting_id, conn=conn), conn=conn)


def create_activity(*, occurred_on: str, name: str, activity_type: str = '其他', budget=0,
                    participant_count=0, summary: str = '', result: str = '', retrospective: str = '',
                    status: str = '计划中', template_id: int | None = None, student_ids=None,
                    followup_title: str = '', followup_due: str = '', conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=True, conn=conn)
    occurred_on, name = _date(occurred_on, '活动日期', default_today=True), _text(name)
    if not name:
        raise EducationError('活动名称不能为空')
    if activity_type not in ACTIVITY_TYPES or status not in ACTIVITY_STATUSES:
        raise EducationError('活动类型或状态不合法')
    ids = _student_ids(student_ids, conn=conn)
    count = _int(participant_count, '参与人数')
    if ids:
        count = len(ids)
    try:
        activity_id = conn.execute(
            '''INSERT INTO activity_records(
                 class_id,term_id,template_id,occurred_on,name,activity_type,budget,participant_count,
                 summary,result,retrospective,status
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)''',
            (class_id, term_id, template_id, occurred_on, name, activity_type, _money(budget), count,
             _text(summary), _text(result), _text(retrospective), status),
        ).lastrowid
        conn.executemany('INSERT INTO activity_participants(activity_id,student_id) VALUES(?,?)',
                         [(activity_id, student_id) for student_id in ids])
        if _text(followup_title):
            action = work_items.ensure_source_work_item(
                title=_text(followup_title), source_type='activity', source_id=activity_id,
                source_label='班级活动', due_at=_text(followup_due)[:30], notes=f'来源：活动 #{activity_id}',
                conn=conn, commit=False,
            )
            conn.execute('UPDATE activity_records SET work_item_id=? WHERE id=?', (action['id'], activity_id))
        audit.record('activity', activity_id, 'create', summary=f'新增活动：{name}',
                     params={'occurred_on': occurred_on, 'participant_count': count, 'budget': _money(budget)},
                     class_id=class_id, term_id=term_id, conn=conn, commit=False)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _decorate_activity(_activity_row(activity_id, conn=conn), conn=conn)


def update_activity(activity_id: int, *, values: dict, conn=None) -> dict:
    conn = _conn(conn)
    current = _activity_row(activity_id, write=True, conn=conn)
    allowed = {'occurred_on', 'name', 'activity_type', 'budget', 'participant_count', 'summary', 'result', 'retrospective', 'status', 'template_id'}
    updates, params = [], []
    for key in allowed:
        if key not in values:
            continue
        value = values[key]
        if key == 'occurred_on':
            value = _date(value, '活动日期')
        elif key == 'name':
            value = _text(value)
            if not value:
                raise EducationError('活动名称不能为空')
        elif key == 'activity_type' and value not in ACTIVITY_TYPES:
            raise EducationError('活动类型不合法')
        elif key == 'status' and value not in ACTIVITY_STATUSES:
            raise EducationError('活动状态不合法')
        elif key == 'budget':
            value = _money(value)
        elif key == 'participant_count':
            value = _int(value, '参与人数')
        updates.append(f'{key}=?')
        params.append(value)
    ids = _student_ids(values['student_ids'], conn=conn) if 'student_ids' in values else None
    if not updates and ids is None:
        return _decorate_activity(current, conn=conn)
    params.extend([_now(), activity_id])
    try:
        if updates:
            conn.execute('UPDATE activity_records SET ' + ','.join(updates) + ',updated_at=? WHERE id=?', params)
        if ids is not None:
            conn.execute('DELETE FROM activity_participants WHERE activity_id=?', (activity_id,))
            conn.executemany('INSERT INTO activity_participants(activity_id,student_id) VALUES(?,?)',
                             [(activity_id, student_id) for student_id in ids])
            conn.execute('UPDATE activity_records SET participant_count=?,updated_at=? WHERE id=?',
                         (len(ids), _now(), activity_id))
        audit.record('activity', activity_id, 'update', summary='更新活动记录',
                     params={'fields': sorted(set(allowed) & set(values))})
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _decorate_activity(_activity_row(activity_id, conn=conn), conn=conn)


def create_diary(*, diary_date: str, weather: str = '', work: str = '', event: str = '',
                 reflection: str = '', todo: str = '', links=None, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=True, conn=conn)
    diary_date = _date(diary_date, '日志日期', default_today=True)
    try:
        diary_id = conn.execute(
            '''INSERT INTO diary_entries(class_id,term_id,diary_date,weather,work,event,reflection,todo)
               VALUES(?,?,?,?,?,?,?,?)''',
            (class_id, term_id, diary_date, _text(weather), _text(work), _text(event),
             _text(reflection), _text(todo)),
        ).lastrowid
        _replace_diary_links(diary_id, links or [], conn=conn)
        audit.record('diary', diary_id, 'create', summary=f'新增班主任日志：{diary_date}',
                     params={'link_count': len(links or [])}, class_id=class_id, term_id=term_id,
                     conn=conn, commit=False)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return next(item for item in list_diary(conn=conn) if item['id'] == diary_id)


def update_diary(diary_id: int, *, values: dict, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=True, conn=conn)
    row = conn.execute("SELECT * FROM diary_entries WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
                       (int(diary_id), class_id, term_id)).fetchone()
    if not row:
        raise EducationError('日志记录不存在')
    fields = {'diary_date', 'weather', 'work', 'event', 'reflection', 'todo'}
    updates, params = [], []
    for key in fields:
        if key in values:
            value = _date(values[key], '日志日期') if key == 'diary_date' else _text(values[key])
            updates.append(f'{key}=?')
            params.append(value)
    try:
        if updates:
            conn.execute('UPDATE diary_entries SET ' + ','.join(updates) + ',updated_at=? WHERE id=?',
                         (*params, _now(), diary_id))
        if 'links' in values:
            _replace_diary_links(diary_id, values['links'] or [], conn=conn)
        audit.record('diary', diary_id, 'update', summary='更新班主任日志',
                     params={'fields': sorted(set(fields) & set(values))})
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return next(item for item in list_diary(conn=conn) if item['id'] == diary_id)


def _replace_diary_links(diary_id: int, links, *, conn=None):
    conn = _conn(conn)
    conn.execute('DELETE FROM diary_links WHERE diary_id=?', (diary_id,))
    class_id, term_id = _scope(write=True, conn=conn)
    for link in links:
        link_type = _text(link.get('link_type') or link.get('type'))
        if link_type not in LINK_TYPES:
            raise EducationError('日志关联类型不合法')
        link_id = link.get('link_id', link.get('id'))
        student_id = link.get('student_id')
        if link_type == 'student':
            student_id = _int(student_id or link_id, '学生 ID', minimum=1)
            class_context.ensure_student_in_scope(student_id, write=True, conn=conn)
            link_id = None
        elif link_type in {'meeting', 'activity'}:
            link_id = _int(link_id, '关联记录 ID', minimum=1)
            table = 'meeting_records' if link_type == 'meeting' else 'activity_records'
            if not conn.execute(
                f"SELECT 1 FROM {table} WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
                (link_id, class_id, term_id)).fetchone():
                raise EducationError('关联的来源记录不存在')
        elif link_type == 'event':
            link_id = _int(link_id, '事件 ID', minimum=1)
            if not conn.execute("SELECT 1 FROM student_events WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
                                (link_id, class_id, term_id)).fetchone():
                raise EducationError('关联的学生事件不存在')
        elif link_type == 'work_item':
            link_id = _int(link_id, '工作项 ID', minimum=1)
            if not conn.execute("SELECT 1 FROM student_tasks WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
                                (link_id, class_id, term_id)).fetchone():
                raise EducationError('关联的工作项不存在')
        conn.execute(
            'INSERT OR IGNORE INTO diary_links(diary_id,link_type,link_id,student_id,label) VALUES(?,?,?,?,?)',
            (diary_id, link_type, link_id, student_id, _text(link.get('label'))),
        )


def delete_record(kind: str, record_id: int, *, conn=None) -> dict:
    from . import recycle
    object_type = {'meeting': 'meeting', 'activity': 'activity', 'diary': 'diary'}.get(kind)
    if not object_type:
        raise EducationError('不支持删除该记录')
    return recycle.soft_delete(object_type, int(record_id), conn=conn)


def save_activity_attachment(activity_id: int, *, filename: str, content: bytes,
                             mime_type: str = '', conn=None) -> dict:
    conn = _conn(conn)
    activity = _activity_row(activity_id, write=True, conn=conn)
    if not filename or not content:
        raise EducationError('附件不能为空')
    if len(content) > MAX_ATTACHMENT_BYTES:
        raise EducationError('附件不能超过 20MB')
    safe_name = re.sub(r'[^A-Za-z0-9._\-\u4e00-\u9fff]+', '-', os.path.basename(filename)).strip('-') or '附件'
    stored_name = f'{uuid4().hex}-{safe_name}'
    relative_path = os.path.join('activity-attachments', str(activity['class_id']),
                                 str(activity['term_id']), str(activity_id), stored_name)
    full_path = os.path.join(config.DATA_DIR, relative_path)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, 'wb') as target:
        target.write(content)
    digest = hashlib.sha256(content).hexdigest()
    try:
        attachment_id = conn.execute(
            '''INSERT INTO activity_attachments(
                 activity_id,original_name,stored_name,relative_path,mime_type,size,sha256
               ) VALUES(?,?,?,?,?,?,?)''',
            (activity_id, filename[:255], stored_name, relative_path, mime_type[:100], len(content), digest),
        ).lastrowid
        audit.record('activity_attachment', attachment_id, 'create', summary=f'上传活动材料：{filename}',
                     params={'activity_id': activity_id, 'size': len(content)}, conn=conn)
    except Exception:
        try:
            os.unlink(full_path)
        except OSError:
            pass
        conn.rollback()
        raise
    return dict(conn.execute('SELECT * FROM activity_attachments WHERE id=?', (attachment_id,)).fetchone())


def activity_attachment_path(attachment_id: int, *, conn=None) -> str:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    row = conn.execute(
        '''SELECT aa.* FROM activity_attachments aa
           JOIN activity_records a ON a.id=aa.activity_id
           WHERE aa.id=? AND a.class_id=? AND a.term_id=? AND a.deleted_at='' ''',
        (int(attachment_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise EducationError('活动材料不存在')
    path = os.path.abspath(os.path.join(config.DATA_DIR, row['relative_path']))
    if not path.startswith(os.path.abspath(config.DATA_DIR) + os.sep) or not os.path.isfile(path):
        raise EducationError('活动材料文件不存在，可能需要恢复备份')
    return path


def migrate_legacy_rows(*, conn=None) -> dict:
    """把旧通用表按来源键迁移为结构化记录，原行保留为归档来源。"""
    conn = _conn(conn)
    class_id, term_id = _scope(write=True, conn=conn)
    totals = {'imported': 0, 'skipped': 0, 'rows': 0, 'sources': []}
    mappings = {
        '班会记录': 'meeting', '班级活动': 'activity', '班主任日志': 'diary',
    }
    for sheet, kind in mappings.items():
        existing_run = conn.execute(
            'SELECT * FROM domain4_migration_runs WHERE class_id=? AND term_id=? AND source_sheet=? AND source_version=?',
            (class_id, term_id, sheet, 'v1')).fetchone()
        if existing_run:
            totals['sources'].append(dict(existing_run))
            continue
        rows = conn.execute(
            "SELECT row_no,data FROM sheet_rows WHERE sheet=? AND class_id=? AND term_id=? AND deleted_at='' ORDER BY row_no",
            (sheet, class_id, term_id)).fetchall()
        imported = skipped = 0
        for row in rows:
            try:
                values = json.loads(row['data'])
                key = f'legacy:{sheet}:{row["row_no"]}'
                if kind == 'meeting':
                    conn.execute(
                        '''INSERT INTO meeting_records(class_id,term_id,held_on,topic,format,content,participation,conclusion,
                           source_type,source_id,source_key,legacy_row_no,legacy_payload)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                        (class_id, term_id, _legacy_date(values[0] if values else ''), _legacy_value(values, 2, '未命名班会'),
                         _legacy_choice(values, 3, '主题班会', MEETING_FORMATS), _legacy_value(values, 4),
                         _legacy_value(values, 5), '；'.join(x for x in (_legacy_value(values, 6), _legacy_value(values, 7)) if x),
                         'legacy_sheet', str(row['row_no']), key, row['row_no'], row['data']),
                    )
                elif kind == 'activity':
                    count = _legacy_number(values, 3)
                    result = '；'.join(x for x in (_legacy_value(values, 5), _legacy_value(values, 6)) if x)
                    conn.execute(
                        '''INSERT INTO activity_records(class_id,term_id,occurred_on,name,activity_type,participant_count,summary,result,
                           source_type,source_id,source_key,legacy_row_no,legacy_payload)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                        (class_id, term_id, _legacy_date(values[0] if values else ''), _legacy_value(values, 1, '未命名活动'),
                         _legacy_choice(values, 2, '其他', ACTIVITY_TYPES), count, _legacy_value(values, 4), result,
                         'legacy_sheet', str(row['row_no']), key, row['row_no'], row['data']),
                    )
                else:
                    conn.execute(
                        '''INSERT INTO diary_entries(class_id,term_id,diary_date,weather,work,event,reflection,todo,
                           source_type,source_id,legacy_row_no,legacy_payload)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)''',
                        (class_id, term_id, _legacy_date(values[0] if values else ''), _legacy_value(values, 2),
                         _legacy_value(values, 3), _legacy_value(values, 4), _legacy_value(values, 5), _legacy_value(values, 6),
                         'legacy_sheet', str(row['row_no']), row['row_no'], row['data']),
                    )
                imported += 1
            except Exception:
                skipped += 1
        report = {'source_sheet': sheet, 'rows': len(rows), 'imported': imported, 'skipped': skipped}
        conn.execute(
            '''INSERT INTO domain4_migration_runs(class_id,term_id,source_sheet,source_rows,imported_entries,skipped_entries,report)
               VALUES(?,?,?,?,?,?,?)''',
            (class_id, term_id, sheet, len(rows), imported, skipped, json.dumps(report, ensure_ascii=False)),
        )
        totals['rows'] += len(rows)
        totals['imported'] += imported
        totals['skipped'] += skipped
        totals['sources'].append(report)
    conn.commit()
    return totals


def _legacy_value(values, index: int, default: str = '') -> str:
    if index >= len(values) or values[index] in (None, ''):
        return default
    return _text(values[index])


def _legacy_choice(values, index: int, default: str, choices) -> str:
    value = _legacy_value(values, index, default)
    return value if value in choices else default


def _legacy_number(values, index: int) -> int:
    try:
        return max(0, int(float(_legacy_value(values, index, '0'))))
    except ValueError:
        return 0


def _legacy_date(value: str) -> str:
    try:
        return date.fromisoformat(_text(value)[:10]).isoformat()
    except ValueError:
        return clock.today().isoformat()


def evaluate_startup(*, conn=None):
    try:
        return migrate_legacy_rows(conn=conn)
    except Exception:
        # 旧通用表迁移失败不能阻塞工作台启动，页面可重试并保留原始行。
        return {'ok': False, 'error': '旧通用表迁移失败'}
