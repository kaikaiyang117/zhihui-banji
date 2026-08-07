# -*- coding: utf-8 -*-
"""班级、学期与学生在班关系业务服务。"""
from __future__ import annotations

from contextvars import ContextVar, Token
from datetime import datetime
from typing import Optional


class ScopeError(ValueError):
    pass


class ArchivedScopeError(ScopeError):
    pass


_request_scope: ContextVar[tuple[Optional[int], Optional[int]]] = ContextVar(
    'workbench_scope', default=(None, None))


def bind_request_scope(class_id: str | int | None, term_id: str | int | None) -> Token:
    try:
        parsed_class = int(class_id) if class_id not in (None, '') else None
        parsed_term = int(term_id) if term_id not in (None, '') else None
    except (TypeError, ValueError) as exc:
        raise ScopeError('班级或学期参数格式不正确') from exc
    return _request_scope.set((parsed_class, parsed_term))


def reset_request_scope(token: Token):
    _request_scope.reset(token)


def _conn(conn=None):
    if conn is not None:
        return conn
    from .. import db
    return db.get_conn()


def get_current_scope(*, write: bool = False, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _request_scope.get()
    params = []
    sql = (
        'SELECT c.id AS class_id, c.name AS class_name, c.grade, c.status AS class_status, '
        't.id AS term_id, t.name AS term_name, t.start_date, t.end_date, t.status AS term_status '
        'FROM terms t JOIN classes c ON c.id=t.class_id'
    )
    where = []
    if term_id is not None:
        where.append('t.id=?')
        params.append(term_id)
    if class_id is not None:
        where.append('c.id=?')
        params.append(class_id)
    if where:
        sql += ' WHERE ' + ' AND '.join(where)
    else:
        sql += " WHERE c.status='使用中' AND t.status='进行中'"
    sql += (
        " ORDER BY CASE WHEN c.status='使用中' THEN 0 ELSE 1 END, "
        "CASE WHEN t.status='进行中' THEN 0 ELSE 1 END, c.id, t.id DESC LIMIT 1"
    )
    row = conn.execute(sql, tuple(params)).fetchone()
    if not row:
        if class_id is not None or term_id is not None:
            raise ScopeError('所选班级或学期不存在，可能已被移除')
        row = conn.execute(
            'SELECT c.id AS class_id, c.name AS class_name, c.grade, c.status AS class_status, '
            't.id AS term_id, t.name AS term_name, t.start_date, t.end_date, t.status AS term_status '
            'FROM terms t JOIN classes c ON c.id=t.class_id ORDER BY t.id DESC LIMIT 1'
        ).fetchone()
    if not row:
        raise ScopeError('尚未创建班级和学期')
    result = dict(row)
    if write and (result['class_status'] == '已归档' or result['term_status'] == '已归档'):
        raise ArchivedScopeError('已归档的班级或学期只能查看，不能修改')
    return result


def scope_ids(*, write: bool = False, conn=None) -> tuple[int, int]:
    scope = get_current_scope(write=write, conn=conn)
    return int(scope['class_id']), int(scope['term_id'])


def list_contexts(conn=None) -> dict:
    conn = _conn(conn)
    current = get_current_scope(conn=conn)
    classes = []
    for class_row in conn.execute(
        'SELECT * FROM classes ORDER BY CASE WHEN status=\'使用中\' THEN 0 ELSE 1 END, id'
    ).fetchall():
        item = dict(class_row)
        terms = []
        for term_row in conn.execute(
            '''SELECT t.*,
                      COUNT(e.id) AS student_count,
                      SUM(CASE WHEN e.status='在读' THEN 1 ELSE 0 END) AS active_student_count
               FROM terms t
               LEFT JOIN student_enrollments e ON e.term_id=t.id AND e.class_id=t.class_id
               WHERE t.class_id=? GROUP BY t.id
               ORDER BY CASE WHEN t.status='进行中' THEN 0 ELSE 1 END, t.id DESC''',
            (class_row['id'],),
        ).fetchall():
            term = dict(term_row)
            term['student_count'] = int(term['student_count'] or 0)
            term['active_student_count'] = int(term['active_student_count'] or 0)
            terms.append(term)
        item['terms'] = terms
        classes.append(item)
    return {'current': current, 'classes': classes}


def create_class(name: str, grade: str = '', term_name: str = '默认学期',
                 start_date: str = '', end_date: str = '', conn=None) -> dict:
    conn = _conn(conn)
    name, term_name = str(name or '').strip(), str(term_name or '').strip()
    if not name or not term_name:
        raise ScopeError('班级名称和首个学期名称不能为空')
    try:
        class_id = conn.execute(
            'INSERT INTO classes(name, grade) VALUES(?,?)', (name, str(grade or '').strip())
        ).lastrowid
        term_id = conn.execute(
            'INSERT INTO terms(class_id, name, start_date, end_date) VALUES(?,?,?,?)',
            (class_id, term_name, start_date, end_date),
        ).lastrowid
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {'class_id': class_id, 'term_id': term_id}


def update_class(class_id: int, *, name: str | None = None, grade: str | None = None,
                 status: str | None = None, conn=None):
    conn = _conn(conn)
    fields, params = [], []
    if name is not None:
        if not str(name).strip():
            raise ScopeError('班级名称不能为空')
        fields.append('name=?')
        params.append(str(name).strip())
    if grade is not None:
        fields.append('grade=?')
        params.append(str(grade).strip())
    if status is not None:
        if status not in {'使用中', '已归档'}:
            raise ScopeError('班级状态不合法')
        if status == '已归档' and conn.execute(
            "SELECT 1 FROM terms WHERE class_id=? AND status='进行中'", (class_id,)
        ).fetchone():
            raise ScopeError('请先归档该班级下仍在进行的学期')
        fields.extend(['status=?', 'archived_at=?'])
        params.extend([status, datetime.now().strftime('%Y-%m-%d %H:%M') if status == '已归档' else ''])
    if not fields:
        return
    params.append(class_id)
    cur = conn.execute(
        f"UPDATE classes SET {', '.join(fields)}, updated_at=datetime('now','localtime') WHERE id=?",
        tuple(params),
    )
    if not cur.rowcount:
        conn.rollback()
        raise ScopeError('班级不存在')
    from . import audit
    audit.record(
        'class', class_id, 'archive' if status == '已归档' else 'update',
        summary='归档班级' if status == '已归档' else '更新班级',
        params={'name': name, 'grade': grade, 'status': status},
        class_id=class_id, term_id=None, conn=conn, commit=False,
    )
    conn.commit()


def create_term(class_id: int, name: str, start_date: str = '', end_date: str = '', conn=None) -> int:
    conn = _conn(conn)
    if not conn.execute("SELECT 1 FROM classes WHERE id=? AND status='使用中'", (class_id,)).fetchone():
        raise ScopeError('班级不存在或已归档')
    if not str(name or '').strip():
        raise ScopeError('学期名称不能为空')
    try:
        term_id = conn.execute(
            'INSERT INTO terms(class_id, name, start_date, end_date) VALUES(?,?,?,?)',
            (class_id, str(name).strip(), start_date, end_date),
        ).lastrowid
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return term_id


def update_term(term_id: int, *, name: str | None = None, start_date: str | None = None,
                end_date: str | None = None, status: str | None = None, conn=None):
    conn = _conn(conn)
    fields, params = [], []
    for key, value in (('name', name), ('start_date', start_date), ('end_date', end_date)):
        if value is not None:
            if key == 'name' and not str(value).strip():
                raise ScopeError('学期名称不能为空')
            fields.append(f'{key}=?')
            params.append(str(value).strip())
    if status is not None:
        if status not in {'进行中', '已归档'}:
            raise ScopeError('学期状态不合法')
        fields.extend(['status=?', 'archived_at=?'])
        params.extend([status, datetime.now().strftime('%Y-%m-%d %H:%M') if status == '已归档' else ''])
    if not fields:
        return
    params.append(term_id)
    cur = conn.execute(
        f"UPDATE terms SET {', '.join(fields)}, updated_at=datetime('now','localtime') WHERE id=?",
        tuple(params),
    )
    if not cur.rowcount:
        conn.rollback()
        raise ScopeError('学期不存在')
    from . import audit
    term = conn.execute('SELECT class_id FROM terms WHERE id=?', (term_id,)).fetchone()
    audit.record(
        'term', term_id, 'archive' if status == '已归档' else 'update',
        summary='归档学期' if status == '已归档' else '更新学期',
        params={'name': name, 'start_date': start_date, 'end_date': end_date, 'status': status},
        class_id=term['class_id'] if term else None, term_id=term_id, conn=conn, commit=False,
    )
    conn.commit()


def enroll_student(student_id: int, class_id: int | None = None, term_id: int | None = None,
                   status: str = '在读', conn=None, commit: bool = True) -> int:
    conn = _conn(conn)
    if class_id is None or term_id is None:
        scope = get_current_scope(write=True, conn=conn)
        class_id, term_id = scope['class_id'], scope['term_id']
    if status not in {'在读', '转出', '毕业'}:
        raise ScopeError('在班状态不合法')
    term = conn.execute('SELECT class_id, status FROM terms WHERE id=?', (term_id,)).fetchone()
    if not term or int(term['class_id']) != int(class_id):
        raise ScopeError('班级与学期不匹配')
    if term['status'] == '已归档':
        raise ArchivedScopeError('不能向已归档学期添加学生')
    if not conn.execute("SELECT 1 FROM students WHERE id=? AND deleted_at=''", (student_id,)).fetchone():
        raise ScopeError('学生不存在')
    conn.execute(
        '''INSERT INTO student_enrollments(student_id, class_id, term_id, status, joined_at, left_at)
           VALUES(?,?,?,?,date('now','localtime'),?)
           ON CONFLICT(student_id, class_id, term_id) DO UPDATE SET
             status=excluded.status,
             joined_at=CASE WHEN student_enrollments.joined_at='' THEN excluded.joined_at ELSE student_enrollments.joined_at END,
             left_at=excluded.left_at,
             updated_at=datetime('now','localtime')''',
        (student_id, class_id, term_id, status, '' if status == '在读' else datetime.now().date().isoformat()),
    )
    if commit:
        conn.commit()
    row = conn.execute(
        'SELECT id FROM student_enrollments WHERE student_id=? AND class_id=? AND term_id=?',
        (student_id, class_id, term_id),
    ).fetchone()
    return int(row['id'])


def update_enrollment(enrollment_id: int, status: str, conn=None):
    conn = _conn(conn)
    class_id, term_id = scope_ids(write=True, conn=conn)
    if status not in {'在读', '转出', '毕业'}:
        raise ScopeError('在班状态不合法')
    row = conn.execute(
        'SELECT e.*, t.status AS term_status FROM student_enrollments e '
        'JOIN terms t ON t.id=e.term_id WHERE e.id=? AND e.class_id=? AND e.term_id=?',
        (enrollment_id, class_id, term_id),
    ).fetchone()
    if not row:
        raise ScopeError('在班记录不存在')
    if row['term_status'] == '已归档':
        raise ArchivedScopeError('已归档学期不能修改在班状态')
    conn.execute(
        "UPDATE student_enrollments SET status=?, left_at=?, updated_at=datetime('now','localtime') WHERE id=?",
        (status, '' if status == '在读' else datetime.now().date().isoformat(), enrollment_id),
    )
    conn.commit()


def transfer_enrollment(enrollment_id: int, target_class_id: int, target_term_id: int, conn=None) -> int:
    conn = _conn(conn)
    source_class_id, source_term_id = scope_ids(write=True, conn=conn)
    source = conn.execute(
        '''SELECT e.*, t.status AS term_status FROM student_enrollments e
           JOIN terms t ON t.id=e.term_id
           WHERE e.id=? AND e.class_id=? AND e.term_id=?''',
        (enrollment_id, source_class_id, source_term_id),
    ).fetchone()
    if not source:
        raise ScopeError('当前班级中没有该在班记录')
    if source['status'] != '在读':
        raise ScopeError('只有在读学生可以办理转班')
    target = conn.execute(
        '''SELECT t.id, t.class_id, t.status AS term_status, c.status AS class_status
           FROM terms t JOIN classes c ON c.id=t.class_id
           WHERE t.id=? AND t.class_id=?''',
        (target_term_id, target_class_id),
    ).fetchone()
    if not target or target['term_status'] != '进行中' or target['class_status'] != '使用中':
        raise ScopeError('目标班级或学期不存在，或已经归档')
    if target_class_id == source_class_id and target_term_id == source_term_id:
        raise ScopeError('目标班级和学期不能与当前相同')
    today = datetime.now().date().isoformat()
    try:
        conn.execute(
            "UPDATE student_enrollments SET status='转出', left_at=?, updated_at=datetime('now','localtime') WHERE id=?",
            (today, enrollment_id),
        )
        conn.execute(
            '''INSERT INTO student_enrollments(student_id, class_id, term_id, status, joined_at, left_at)
               VALUES(?,?,?,'在读',?,'')
               ON CONFLICT(student_id, class_id, term_id) DO UPDATE SET
                 status='在读', joined_at=excluded.joined_at, left_at='',
                 updated_at=datetime('now','localtime')''',
            (source['student_id'], target_class_id, target_term_id, today),
        )
        target_row = conn.execute(
            'SELECT id FROM student_enrollments WHERE student_id=? AND class_id=? AND term_id=?',
            (source['student_id'], target_class_id, target_term_id),
        ).fetchone()
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return int(target_row['id'])


def list_student_directory(conn=None) -> list[dict]:
    conn = _conn(conn)
    rows = conn.execute(
        '''SELECT s.id, s.学号, s.姓名, s.性别,
                  GROUP_CONCAT(c.name || ' · ' || t.name || ' · ' || e.status, '；') AS memberships
           FROM students s
           LEFT JOIN student_enrollments e ON e.student_id=s.id
           LEFT JOIN classes c ON c.id=e.class_id
           LEFT JOIN terms t ON t.id=e.term_id
           WHERE s.deleted_at=''
           GROUP BY s.id ORDER BY s.学号'''
    ).fetchall()
    return [dict(row) for row in rows]


def list_enrollments(conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = scope_ids(conn=conn)
    return [dict(row) for row in conn.execute(
        '''SELECT e.id, e.student_id, e.status, e.joined_at, e.left_at,
                  s.学号, s.姓名, s.性别, s.班级任职
           FROM student_enrollments e JOIN students s ON s.id=e.student_id
           WHERE e.class_id=? AND e.term_id=? AND s.deleted_at='' ORDER BY s.学号''',
        (class_id, term_id),
    ).fetchall()]


def ensure_student_in_scope(student_id: int, *, write: bool = False, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = scope_ids(write=write, conn=conn)
    status_filter = " AND e.status='在读'" if write else ''
    row = conn.execute(
        '''SELECT s.*, e.id AS enrollment_id, e.status AS enrollment_status
           FROM students s JOIN student_enrollments e ON e.student_id=s.id
           WHERE s.id=? AND e.class_id=? AND e.term_id=? AND s.deleted_at='' ''' + status_filter,
        (student_id, class_id, term_id),
    ).fetchone()
    if not row:
        raise ScopeError('学生不在当前班级和学期中，或当前不是在读状态')
    return dict(row)


def rollover_term(source_term_id: int, name: str, start_date: str = '', end_date: str = '',
                  archive_source: bool = True, conn=None) -> dict:
    conn = _conn(conn)
    name = str(name or '').strip()
    if not name:
        raise ScopeError('新学期名称不能为空')
    source = conn.execute('SELECT * FROM terms WHERE id=?', (source_term_id,)).fetchone()
    if not source:
        raise ScopeError('原学期不存在')
    if source['status'] == '已归档':
        raise ArchivedScopeError('原学期已经归档，不能重复结转')
    try:
        term_id = conn.execute(
            'INSERT INTO terms(class_id, name, start_date, end_date) VALUES(?,?,?,?)',
            (source['class_id'], name, start_date, end_date),
        ).lastrowid
        conn.execute(
            '''INSERT INTO student_enrollments(student_id, class_id, term_id, status, joined_at)
               SELECT student_id, class_id, ?, '在读', date('now','localtime')
               FROM student_enrollments WHERE term_id=? AND status='在读' ''',
            (term_id, source_term_id),
        )
        conn.execute(
            '''INSERT INTO attendance_rules(name, metric, threshold, period_days, priority, enabled, scene, class_id, term_id)
               SELECT name, metric, threshold, period_days, priority, enabled, scene, class_id, ?
               FROM attendance_rules WHERE term_id=?''',
            (term_id, source_term_id),
        )
        conn.execute(
            '''INSERT INTO score_subjects(
                   class_id, term_id, name, full_score, sort_order, enabled
               )
               SELECT class_id, ?, name, full_score, sort_order, enabled
               FROM score_subjects WHERE term_id=?''',
            (term_id, source_term_id),
        )
        conn.execute(
            '''INSERT INTO score_rules(
                   class_id, term_id, name, metric, subject_id, threshold, priority, enabled
               )
               SELECT r.class_id, ?, r.name, r.metric, next_subject.id,
                      r.threshold, r.priority, r.enabled
               FROM score_rules r
               LEFT JOIN score_subjects old_subject ON old_subject.id=r.subject_id
               LEFT JOIN score_subjects next_subject
                 ON next_subject.class_id=r.class_id AND next_subject.term_id=?
                AND next_subject.name=old_subject.name
               WHERE r.term_id=? AND r.deleted_at='' ''',
            (term_id, term_id, source_term_id),
        )
        conn.execute(
            '''INSERT INTO point_rules(
                   class_id, term_id, name, category, metric, threshold,
                   period_days, priority, enabled
               )
               SELECT class_id, ?, name, category, metric, threshold,
                      period_days, priority, enabled
               FROM point_rules
               WHERE term_id=? AND deleted_at='' ''',
            (term_id, source_term_id),
        )
        conn.execute(
            '''INSERT INTO fund_categories(
                   class_id, term_id, name, direction, enabled
               )
               SELECT class_id, ?, name, direction, enabled
               FROM fund_categories
               WHERE term_id=? AND deleted_at='' ''',
            (term_id, source_term_id),
        )
        conn.execute(
            '''INSERT INTO class_task_templates(
                   class_id, term_id, name, task_type, material_name,
                   description, default_due_days, enabled
               )
               SELECT class_id, ?, name, task_type, material_name,
                      description, default_due_days, enabled
               FROM class_task_templates
               WHERE term_id=? AND deleted_at='' ''',
            (term_id, source_term_id),
        )
        conn.execute(
            '''INSERT INTO duty_rotation_rules(
                   class_id, term_id, name, area, start_date, end_date,
                   weekday_mask, enabled
               )
               SELECT class_id, ?, name, area, start_date, end_date,
                      weekday_mask, enabled
               FROM duty_rotation_rules
               WHERE term_id=? AND deleted_at='' ''',
            (term_id, source_term_id),
        )
        conn.execute(
            '''INSERT INTO duty_rotation_members(rule_id, student_id, position, enabled)
               SELECT next_rule.id, member.student_id, member.position, member.enabled
               FROM duty_rotation_members member
               JOIN duty_rotation_rules old_rule ON old_rule.id=member.rule_id
               JOIN duty_rotation_rules next_rule
                 ON next_rule.class_id=old_rule.class_id
                AND next_rule.term_id=?
                AND next_rule.name=old_rule.name
               WHERE old_rule.term_id=? AND old_rule.deleted_at='' ''',
            (term_id, source_term_id),
        )
        if archive_source:
            conn.execute(
                "UPDATE terms SET status='已归档', archived_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?",
                (source_term_id,),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {'term_id': term_id, 'class_id': source['class_id']}
