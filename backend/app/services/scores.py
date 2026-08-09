# -*- coding: utf-8 -*-
"""结构化成绩配置、导入、统计和异常跟进。"""
from __future__ import annotations

from datetime import date, datetime
import json
import uuid

from .. import clock, db
from . import audit, class_context


RECORD_STATUSES = {'正常', '缺考', '免考'}
DUPLICATE_STRATEGIES = {'update', 'skip'}
RULE_METRICS = {'总分下降', '排名下降', '单科下降'}
RULE_TRIGGERS = {'import', 'manual', 'rule_change', 'startup'}
OPEN_TASK_STATUSES = {'待处理', '处理中', '待复查'}
SUBJECT_GROUPS = {'必考', '首选', '再选', '选考'}
SCORE_TYPES = {'原始分', '等级赋分'}
SCORE_MODES = {'固定科目', '3+1+2', '3+3', '自定义'}


class ScoreError(ValueError):
    pass


def _now() -> str:
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def _scope(*, write: bool = False, conn=None) -> tuple[int, int]:
    return class_context.scope_ids(write=write, conn=conn or db.get_conn())


def _text(value) -> str:
    if value is None:
        return ''
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip()


def _date_text(value) -> str:
    text = _text(value)[:10]
    if not text:
        return ''
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError as exc:
        raise ScoreError('考试日期格式必须为 YYYY-MM-DD') from exc


def _positive_number(value, label: str, *, allow_zero: bool = True) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ScoreError(f'{label}必须是数字') from exc
    if number < 0 or (not allow_zero and number == 0):
        raise ScoreError(f'{label}不能小于零')
    return number


def _selection_status(mode: str, selected_ids: set[int], subject_by_id: dict[int, dict]) -> str:
    if mode in {'固定科目', '自定义'}:
        return '有效'
    selected = [subject_by_id[item] for item in selected_ids if item in subject_by_id]
    first_count = sum(item.get('subject_group') == '首选' for item in selected)
    second_count = sum(item.get('subject_group') == '再选' for item in selected)
    elective_count = sum(item.get('subject_group') == '选考' for item in selected)
    if mode == '3+1+2':
        return '有效' if first_count == 1 and second_count == 2 else '组合不完整'
    if mode == '3+3':
        return '有效' if elective_count == 3 else '组合不完整'
    return '有效'


def list_config(*, conn=None) -> dict:
    conn = conn or db.get_conn()
    class_id, term_id = _scope(conn=conn)
    subjects = [dict(row) for row in conn.execute(
        '''SELECT * FROM score_subjects WHERE class_id=? AND term_id=?
           ORDER BY enabled DESC, sort_order, id''', (class_id, term_id)
    ).fetchall()]
    settings_row = conn.execute(
        '''SELECT mode FROM score_term_settings WHERE class_id=? AND term_id=?''',
        (class_id, term_id),
    ).fetchone()
    exams = [dict(row) for row in conn.execute(
        '''SELECT * FROM score_exams WHERE class_id=? AND term_id=?
           ORDER BY enabled DESC, CASE WHEN exam_date='' THEN 1 ELSE 0 END,
                    exam_date, sort_order, id''', (class_id, term_id)
    ).fetchall()]
    links = conn.execute(
        '''SELECT es.exam_id, es.subject_id FROM score_exam_subjects es
           JOIN score_exams e ON e.id=es.exam_id
           WHERE e.class_id=? AND e.term_id=? ORDER BY es.sort_order, es.subject_id''',
        (class_id, term_id),
    ).fetchall()
    by_exam: dict[int, list[int]] = {}
    for row in links:
        by_exam.setdefault(int(row['exam_id']), []).append(int(row['subject_id']))
    for item in subjects:
        item['enabled'] = bool(item['enabled'])
    for item in exams:
        item['enabled'] = bool(item['enabled'])
        item['subject_ids'] = by_exam.get(int(item['id']), [])
    return {
        'exams': exams, 'subjects': subjects,
        'settings': {'mode': settings_row['mode'] if settings_row else '固定科目'},
    }


def _subject_row(subject_id: int, *, write: bool = False, conn=None):
    conn = conn or db.get_conn()
    class_id, term_id = _scope(write=write, conn=conn)
    row = conn.execute(
        'SELECT * FROM score_subjects WHERE id=? AND class_id=? AND term_id=?',
        (int(subject_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise ScoreError('科目配置不存在')
    return dict(row)


def _exam_row(exam_id: int, *, write: bool = False, conn=None):
    conn = conn or db.get_conn()
    class_id, term_id = _scope(write=write, conn=conn)
    row = conn.execute(
        'SELECT * FROM score_exams WHERE id=? AND class_id=? AND term_id=?',
        (int(exam_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise ScoreError('考试配置不存在')
    return dict(row)


def _replace_exam_subjects(exam_id: int, subject_ids: list[int], *, conn):
    clean_ids = []
    for subject_id in subject_ids:
        subject = _subject_row(int(subject_id), write=True, conn=conn)
        if subject['enabled'] and int(subject_id) not in clean_ids:
            clean_ids.append(int(subject_id))
    conn.execute('DELETE FROM score_exam_subjects WHERE exam_id=?', (exam_id,))
    conn.executemany(
        'INSERT INTO score_exam_subjects(exam_id, subject_id, sort_order) VALUES(?,?,?)',
        [(exam_id, subject_id, index) for index, subject_id in enumerate(clean_ids)],
    )


def create_subject(*, name: str, full_score: float = 0, enabled: bool = True,
                   sort_order: int = 0, subject_group: str = '必考',
                   score_type: str = '原始分', conn=None) -> dict:
    conn = conn or db.get_conn()
    name = _text(name)
    if not name:
        raise ScoreError('科目名称不能为空')
    if subject_group not in SUBJECT_GROUPS:
        raise ScoreError('科目分组不合法')
    if score_type not in SCORE_TYPES:
        raise ScoreError('成绩口径不合法')
    full_score = _positive_number(full_score, '满分')
    class_id, term_id = _scope(write=True, conn=conn)
    try:
        subject_id = conn.execute(
            '''INSERT INTO score_subjects(
                   class_id, term_id, name, full_score, sort_order, enabled,
                   subject_group, score_type
               ) VALUES(?,?,?,?,?,?,?,?)''',
            (class_id, term_id, name, full_score, int(sort_order), int(bool(enabled)),
             subject_group, score_type),
        ).lastrowid
        audit.record(
            'score_subject', subject_id, 'create', summary=f'新增成绩科目：{name}',
            params={'name': name, 'full_score': full_score,
                    'subject_group': subject_group, 'score_type': score_type},
            conn=conn, commit=False)
        conn.commit()
    except Exception as exc:
        conn.rollback()
        if 'UNIQUE' in str(exc):
            raise ScoreError('当前学期已存在同名科目') from exc
        raise
    return {'ok': True, 'subject_id': int(subject_id)}


def update_subject(subject_id: int, *, name: str | None = None,
                   full_score: float | None = None, enabled: bool | None = None,
                   sort_order: int | None = None, subject_group: str | None = None,
                   score_type: str | None = None, conn=None) -> dict:
    conn = conn or db.get_conn()
    current = _subject_row(subject_id, write=True, conn=conn)
    values = {
        'name': _text(name) if name is not None else current['name'],
        'full_score': (_positive_number(full_score, '满分')
                       if full_score is not None else current['full_score']),
        'enabled': int(bool(enabled)) if enabled is not None else current['enabled'],
        'sort_order': int(sort_order) if sort_order is not None else current['sort_order'],
        'subject_group': subject_group if subject_group is not None else current.get('subject_group', '必考'),
        'score_type': score_type if score_type is not None else current.get('score_type', '原始分'),
    }
    if not values['name']:
        raise ScoreError('科目名称不能为空')
    if values['subject_group'] not in SUBJECT_GROUPS:
        raise ScoreError('科目分组不合法')
    if values['score_type'] not in SCORE_TYPES:
        raise ScoreError('成绩口径不合法')
    try:
        conn.execute(
            '''UPDATE score_subjects SET name=:name, full_score=:full_score,
                   enabled=:enabled, sort_order=:sort_order,
                   subject_group=:subject_group, score_type=:score_type,
                   updated_at=datetime('now','localtime') WHERE id=:id''',
            {**values, 'id': int(subject_id)},
        )
        if values['name'] != current['name']:
            conn.execute(
                "UPDATE exam_records SET subject=?, updated_at=datetime('now','localtime') "
                "WHERE subject_id=? AND deleted_at=''", (values['name'], int(subject_id)))
        audit.record(
            'score_subject', subject_id, 'update', summary=f"更新成绩科目：{values['name']}",
            params=values, conn=conn, commit=False)
        conn.commit()
    except Exception as exc:
        conn.rollback()
        if 'UNIQUE' in str(exc):
            raise ScoreError('当前学期已存在同名科目') from exc
        raise
    return {'ok': True}


def update_term_settings(*, mode: str, conn=None) -> dict:
    if mode not in SCORE_MODES:
        raise ScoreError('选科模式不合法')
    conn = conn or db.get_conn()
    class_id, term_id = _scope(write=True, conn=conn)
    conn.execute(
        '''INSERT INTO score_term_settings(class_id, term_id, mode)
           VALUES(?,?,?)
           ON CONFLICT(class_id, term_id) DO UPDATE SET mode=excluded.mode,
           updated_at=datetime('now','localtime')''',
        (class_id, term_id, mode),
    )
    audit.record(
        'score_term_settings', term_id, 'update', summary=f'更新成绩选科模式：{mode}',
        params={'mode': mode}, class_id=class_id, term_id=term_id,
        conn=conn, commit=False,
    )
    conn.commit()
    return {'ok': True, 'mode': mode}


def save_student_subjects(student_id: int, subject_ids: list[int], *, conn=None) -> dict:
    conn = conn or db.get_conn()
    class_id, term_id = _scope(write=True, conn=conn)
    student = conn.execute(
        '''SELECT s.id FROM students s JOIN student_enrollments e ON e.student_id=s.id
           WHERE s.id=? AND e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at='' ''',
        (int(student_id), class_id, term_id),
    ).fetchone()
    if not student:
        raise ScoreError('学生不在当前班级和学期')
    clean_ids = []
    for subject_id in subject_ids or []:
        subject = _subject_row(int(subject_id), write=True, conn=conn)
        if not subject['enabled']:
            raise ScoreError('不能选择已停用科目')
        if int(subject['id']) not in clean_ids:
            clean_ids.append(int(subject['id']))
    conn.execute(
        '''INSERT INTO student_score_profiles(class_id, term_id, student_id)
           VALUES(?,?,?)
           ON CONFLICT(class_id, term_id, student_id) DO UPDATE SET
           updated_at=datetime('now','localtime')''',
        (class_id, term_id, int(student_id)),
    )
    conn.execute(
        'DELETE FROM student_score_subjects WHERE class_id=? AND term_id=? AND student_id=?',
        (class_id, term_id, int(student_id)),
    )
    conn.executemany(
        '''INSERT INTO student_score_subjects(
               class_id, term_id, student_id, subject_id
           ) VALUES(?,?,?,?)''',
        [(class_id, term_id, int(student_id), subject_id) for subject_id in clean_ids],
    )
    audit.record(
        'student_score_subjects', student_id, 'update', summary='更新学生选科',
        params={'student_id': int(student_id), 'subject_ids': clean_ids},
        class_id=class_id, term_id=term_id, conn=conn, commit=False,
    )
    conn.commit()
    return {'ok': True, 'student_id': int(student_id), 'subject_ids': clean_ids}


def create_exam(*, name: str, exam_date: str = '', subject_ids: list[int] | None = None,
                enabled: bool = True, sort_order: int = 0, conn=None) -> dict:
    conn = conn or db.get_conn()
    name = _text(name)
    if not name:
        raise ScoreError('考试名称不能为空')
    exam_date = _date_text(exam_date)
    class_id, term_id = _scope(write=True, conn=conn)
    try:
        exam_id = conn.execute(
            '''INSERT INTO score_exams(
                   class_id, term_id, name, exam_date, sort_order, enabled
               ) VALUES(?,?,?,?,?,?)''',
            (class_id, term_id, name, exam_date, int(sort_order), int(bool(enabled))),
        ).lastrowid
        _replace_exam_subjects(int(exam_id), subject_ids or [], conn=conn)
        audit.record(
            'score_exam', exam_id, 'create', summary=f'新增考试：{name}',
            params={'name': name, 'exam_date': exam_date, 'subject_ids': subject_ids or []},
            conn=conn, commit=False)
        conn.commit()
    except Exception as exc:
        conn.rollback()
        if 'UNIQUE' in str(exc):
            raise ScoreError('当前学期已存在同名考试') from exc
        raise
    return {'ok': True, 'exam_id': int(exam_id)}


def update_exam(exam_id: int, *, name: str | None = None,
                exam_date: str | None = None, subject_ids: list[int] | None = None,
                enabled: bool | None = None, sort_order: int | None = None,
                conn=None) -> dict:
    conn = conn or db.get_conn()
    current = _exam_row(exam_id, write=True, conn=conn)
    values = {
        'name': _text(name) if name is not None else current['name'],
        'exam_date': _date_text(exam_date) if exam_date is not None else current['exam_date'],
        'enabled': int(bool(enabled)) if enabled is not None else current['enabled'],
        'sort_order': int(sort_order) if sort_order is not None else current['sort_order'],
    }
    if not values['name']:
        raise ScoreError('考试名称不能为空')
    try:
        conn.execute(
            '''UPDATE score_exams SET name=:name, exam_date=:exam_date,
                   enabled=:enabled, sort_order=:sort_order,
                   updated_at=datetime('now','localtime') WHERE id=:id''',
            {**values, 'id': int(exam_id)},
        )
        conn.execute(
            '''UPDATE exam_records SET exam_name=?, exam_date=?,
                   updated_at=datetime('now','localtime')
               WHERE exam_id=? AND deleted_at='' ''',
            (values['name'], values['exam_date'], int(exam_id)),
        )
        if subject_ids is not None:
            _replace_exam_subjects(int(exam_id), subject_ids, conn=conn)
        audit.record(
            'score_exam', exam_id, 'update', summary=f"更新考试：{values['name']}",
            params={**values, 'subject_ids': subject_ids}, conn=conn, commit=False)
        conn.commit()
    except Exception as exc:
        conn.rollback()
        if 'UNIQUE' in str(exc):
            raise ScoreError('当前学期已存在同名考试') from exc
        raise
    return {'ok': True}


def _parse_rank(value) -> int | None:
    text = _text(value)
    if not text:
        return None
    try:
        rank = int(float(text))
    except (TypeError, ValueError) as exc:
        raise ScoreError('排名必须是正整数') from exc
    if rank < 1:
        raise ScoreError('排名必须是正整数')
    return rank


def _parse_score(value, explicit_status='') -> tuple[float | None, str]:
    raw = _text(value)
    status = _text(explicit_status) or '正常'
    if raw in {'缺考', '免考'}:
        status, raw = raw, ''
    if status not in RECORD_STATUSES:
        raise ScoreError('成绩状态仅支持正常、缺考、免考')
    if status != '正常':
        return None, status
    if not raw:
        raise ScoreError('正常成绩的分数不能为空')
    return _positive_number(raw, '分数'), status


def preview_exam_rows(rows: list[list], duplicate_strategy: str = 'update') -> dict:
    """解析成绩文件但不写数据库，支持长表与宽表。"""
    if duplicate_strategy not in DUPLICATE_STRATEGIES:
        raise ScoreError('重复记录策略不合法')
    if not rows:
        raise ScoreError('Excel 没有数据')
    headers = [_text(value) for value in rows[0]]
    if len([item for item in headers if item]) != len(set(item for item in headers if item)):
        raise ScoreError('Excel 表头存在重复列')
    index = {value: position for position, value in enumerate(headers) if value}
    if not {'学号', '考试名称'}.issubset(index):
        raise ScoreError('成绩表必须包含：学号、考试名称')
    long_format = {'科目', '分数'}.issubset(index)
    metadata = {'学号', '姓名', '考试名称', '考试日期', '科目', '分数', '排名', '状态', '备注'}
    wide_subjects = [header for header in headers if header and header not in metadata]
    if not long_format and not wide_subjects:
        raise ScoreError('成绩表需要科目列，或包含“科目、分数”列')

    conn = db.get_conn()
    class_id, term_id = _scope(conn=conn)
    students = {str(row['学号'] or '').strip(): dict(row) for row in conn.execute(
        '''SELECT s.id, s.学号, s.姓名 FROM students s
           JOIN student_enrollments e ON e.student_id=s.id
           WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at='' ''',
        (class_id, term_id),
    ).fetchall()}
    exams = {row['name']: dict(row) for row in conn.execute(
        'SELECT * FROM score_exams WHERE class_id=? AND term_id=?',
        (class_id, term_id),
    ).fetchall()}
    subjects = {row['name']: dict(row) for row in conn.execute(
        'SELECT * FROM score_subjects WHERE class_id=? AND term_id=?',
        (class_id, term_id),
    ).fetchall()}
    existing = {
        (int(row['student_id']), row['exam_name'], row['subject']): dict(row)
        for row in conn.execute(
            '''SELECT id, student_id, exam_name, subject, deleted_at FROM exam_records
               WHERE class_id=? AND term_id=?''', (class_id, term_id)
        ).fetchall()
    }

    output, errors, seen = [], [], set()

    def cell(values, key):
        position = index.get(key)
        return values[position] if position is not None and position < len(values) else None

    def append_item(row_no, values, subject_name, raw_score, explicit_status='', rank_value=None):
        student_no = _text(cell(values, '学号'))
        student = students.get(student_no)
        exam_name = _text(cell(values, '考试名称'))
        try:
            exam_date = _date_text(cell(values, '考试日期')) if '考试日期' in index else ''
            if not student_no:
                raise ScoreError('学号不能为空')
            if not student:
                raise ScoreError(f'找不到当前班级学生：{student_no}')
            if not exam_name:
                raise ScoreError('考试名称不能为空')
            subject_name = _text(subject_name)
            if not subject_name:
                raise ScoreError('科目不能为空')
            configured_exam = exams.get(exam_name)
            if (configured_exam and configured_exam['exam_date'] and exam_date
                    and configured_exam['exam_date'] != exam_date):
                raise ScoreError(
                    f'考试日期与配置不一致：{configured_exam["exam_date"]}')
            score, record_status = _parse_score(raw_score, explicit_status)
            rank = _parse_rank(rank_value)
            subject = subjects.get(subject_name)
            if score is not None and subject and float(subject['full_score'] or 0) > 0:
                if score > float(subject['full_score']):
                    raise ScoreError(f'分数超过科目满分 {subject["full_score"]:g}')
            key = (int(student['id']), exam_name, subject_name)
            if key in seen:
                raise ScoreError('文件内存在重复的学生、考试和科目')
            seen.add(key)
            old = existing.get(key)
            if old and old['deleted_at']:
                raise ScoreError('该成绩位于回收站，请先恢复或永久删除')
            action = '新增' if not old else ('更新' if duplicate_strategy == 'update' else '跳过')
            output.append({
                'row': row_no, 'valid': True, 'student_id': int(student['id']),
                '学号': student_no, '姓名': student['姓名'], 'exam_name': exam_name,
                'exam_date': exam_date or (configured_exam['exam_date'] if configured_exam else ''),
                'subject': subject_name, 'score': score, 'rank': rank,
                'record_status': record_status, 'note': _text(cell(values, '备注')),
                'action': action, 'new_exam': not bool(configured_exam),
                'new_subject': not bool(subject), 'error': '',
            })
        except ScoreError as exc:
            error = {'row': row_no, 'message': str(exc)}
            errors.append(error)
            output.append({
                'row': row_no, 'valid': False, '学号': student_no,
                '姓名': student['姓名'] if student else _text(cell(values, '姓名')),
                'exam_name': exam_name, 'exam_date': _text(cell(values, '考试日期')),
                'subject': _text(subject_name), 'score': _text(raw_score),
                'rank': _text(rank_value), 'record_status': _text(explicit_status) or '正常',
                'note': _text(cell(values, '备注')), 'action': '错误',
                'new_exam': False, 'new_subject': False, 'error': str(exc),
            })

    for row_no, values in enumerate(rows[1:], start=2):
        if not any(value not in (None, '') for value in values):
            continue
        if long_format:
            append_item(
                row_no, values, cell(values, '科目'), cell(values, '分数'),
                cell(values, '状态') if '状态' in index else '',
                cell(values, '排名') if '排名' in index else None,
            )
        else:
            produced = False
            for subject_name in wide_subjects:
                raw = cell(values, subject_name)
                if raw in (None, ''):
                    continue
                produced = True
                append_item(row_no, values, subject_name, raw)
            if not produced:
                errors.append({'row': row_no, 'message': '该行没有任何科目成绩'})
                output.append({
                    'row': row_no, 'valid': False, '学号': _text(cell(values, '学号')),
                    '姓名': _text(cell(values, '姓名')), 'exam_name': _text(cell(values, '考试名称')),
                    'exam_date': _text(cell(values, '考试日期')), 'subject': '', 'score': '',
                    'rank': '', 'record_status': '正常', 'note': _text(cell(values, '备注')),
                    'action': '错误', 'new_exam': False, 'new_subject': False,
                    'error': '该行没有任何科目成绩',
                })

    valid = [item for item in output if item['valid']]
    return {
        'rows': output, 'errors': errors,
        'summary': {
            'valid': len(valid), 'new': sum(item['action'] == '新增' for item in valid),
            'update': sum(item['action'] == '更新' for item in valid),
            'skip': sum(item['action'] == '跳过' for item in valid),
            'error': len(errors),
            'new_exams': len({item['exam_name'] for item in valid if item['new_exam']}),
            'new_subjects': len({item['subject'] for item in valid if item['new_subject']}),
        },
        'duplicate_strategy': duplicate_strategy,
        'format': 'long' if long_format else 'wide',
    }


def _ensure_exam(name: str, exam_date: str, *, conn) -> dict:
    class_id, term_id = _scope(write=True, conn=conn)
    row = conn.execute(
        'SELECT * FROM score_exams WHERE class_id=? AND term_id=? AND name=?',
        (class_id, term_id, name),
    ).fetchone()
    if row:
        row = dict(row)
        if row['exam_date'] and exam_date and row['exam_date'] != exam_date:
            raise ScoreError(f'考试“{name}”日期与配置不一致')
        if not row['exam_date'] and exam_date:
            conn.execute(
                "UPDATE score_exams SET exam_date=?, updated_at=datetime('now','localtime') WHERE id=?",
                (exam_date, row['id']),
            )
            row['exam_date'] = exam_date
        return row
    exam_id = conn.execute(
        '''INSERT INTO score_exams(class_id, term_id, name, exam_date, sort_order)
           VALUES(?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM score_exams
                                   WHERE class_id=? AND term_id=?),0))''',
        (class_id, term_id, name, exam_date, class_id, term_id),
    ).lastrowid
    return {'id': int(exam_id), 'name': name, 'exam_date': exam_date}


def _ensure_subject(name: str, *, conn) -> dict:
    class_id, term_id = _scope(write=True, conn=conn)
    row = conn.execute(
        'SELECT * FROM score_subjects WHERE class_id=? AND term_id=? AND name=?',
        (class_id, term_id, name),
    ).fetchone()
    if row:
        return dict(row)
    subject_id = conn.execute(
        '''INSERT INTO score_subjects(class_id, term_id, name, sort_order)
           VALUES(?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM score_subjects
                                  WHERE class_id=? AND term_id=?),0))''',
        (class_id, term_id, name, class_id, term_id),
    ).lastrowid
    return {'id': int(subject_id), 'name': name, 'full_score': 0}


def commit_exam_rows(
    rows: list[dict], *, filename: str = '', duplicate_strategy: str = 'update',
    request_id: str = '', conn=None,
) -> dict:
    """重新校验预览结果并在单个事务中提交，失败时不留下部分数据。"""
    if duplicate_strategy not in DUPLICATE_STRATEGIES:
        raise ScoreError('重复记录策略不合法')
    valid_rows = [dict(item) for item in rows if item.get('valid', True)]
    if not valid_rows:
        raise ScoreError('没有可提交的成绩')
    conn = conn or db.get_conn()
    class_id, term_id = _scope(write=True, conn=conn)
    request_id = _text(request_id)
    if request_id:
        existing_run = conn.execute(
            '''SELECT result_json FROM score_import_runs
               WHERE class_id=? AND term_id=? AND request_id=?''',
            (class_id, term_id, request_id),
        ).fetchone()
        if existing_run:
            result = json.loads(existing_run['result_json'] or '{}')
            return {**result, 'idempotent': True}

    students = {int(row['id']): dict(row) for row in conn.execute(
        '''SELECT s.id, s.学号, s.姓名 FROM students s
           JOIN student_enrollments e ON e.student_id=s.id
           WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at='' ''',
        (class_id, term_id),
    ).fetchall()}
    clean_rows, seen = [], set()
    for position, item in enumerate(valid_rows, start=1):
        try:
            student_id = int(item.get('student_id') or 0)
            if student_id not in students:
                raise ScoreError('学生不在当前班级和学期')
            exam_name = _text(item.get('exam_name'))
            subject_name = _text(item.get('subject'))
            if not exam_name or not subject_name:
                raise ScoreError('考试名称和科目不能为空')
            exam_date = _date_text(item.get('exam_date'))
            record_status = _text(item.get('record_status')) or '正常'
            if record_status not in RECORD_STATUSES:
                raise ScoreError('成绩状态不合法')
            score_value = item.get('score')
            if record_status == '正常':
                if score_value in (None, ''):
                    raise ScoreError('正常成绩的分数不能为空')
                score = _positive_number(score_value, '分数')
            else:
                score = None
            rank = _parse_rank(item.get('rank'))
            key = (student_id, exam_name, subject_name)
            if key in seen:
                raise ScoreError('提交内容包含重复的学生、考试和科目')
            seen.add(key)
            clean_rows.append({
                'student_id': student_id, 'exam_name': exam_name, 'exam_date': exam_date,
                'subject': subject_name, 'score': score, 'rank': rank,
                'record_status': record_status, 'note': _text(item.get('note')),
            })
        except ScoreError as exc:
            raise ScoreError(f'第 {item.get("row") or position} 行：{exc}') from exc

    imported = updated = skipped = 0
    try:
        run_id = conn.execute(
            '''INSERT INTO score_import_runs(
                   class_id, term_id, request_id, filename, duplicate_strategy
               ) VALUES(?,?,?,?,?)''',
            (class_id, term_id, request_id, _text(filename), duplicate_strategy),
        ).lastrowid
        for item in clean_rows:
            exam = _ensure_exam(item['exam_name'], item['exam_date'], conn=conn)
            subject = _ensure_subject(item['subject'], conn=conn)
            if item['score'] is not None and float(subject.get('full_score') or 0) > 0:
                if item['score'] > float(subject['full_score']):
                    raise ScoreError(
                        f"{item['subject']}分数超过满分 {float(subject['full_score']):g}")
            conn.execute(
                '''INSERT OR IGNORE INTO score_exam_subjects(exam_id, subject_id, sort_order)
                   VALUES(?,?,COALESCE((SELECT MAX(sort_order)+1 FROM score_exam_subjects
                                       WHERE exam_id=?),0))''',
                (exam['id'], subject['id'], exam['id']),
            )
            existing = conn.execute(
                '''SELECT id, deleted_at FROM exam_records
                   WHERE student_id=? AND class_id=? AND term_id=?
                     AND exam_name=? AND subject=?''',
                (item['student_id'], class_id, term_id,
                 item['exam_name'], item['subject']),
            ).fetchone()
            if existing and existing['deleted_at']:
                raise ScoreError(
                    f"{item['exam_name']} · {item['subject']}成绩位于回收站，请先处理")
            if existing and duplicate_strategy == 'skip':
                skipped += 1
                continue
            if existing:
                conn.execute(
                    '''UPDATE exam_records SET exam_id=?, subject_id=?, exam_date=?,
                           score=?, rank=?, record_status=?, note=?, import_run_id=?,
                           updated_at=datetime('now','localtime') WHERE id=?''',
                    (exam['id'], subject['id'], exam['exam_date'], item['score'], item['rank'],
                     item['record_status'], item['note'], run_id, existing['id']),
                )
                updated += 1
            else:
                conn.execute(
                    '''INSERT INTO exam_records(
                           student_id, class_id, term_id, exam_id, subject_id,
                           exam_name, exam_date, subject, score, rank,
                           record_status, note, import_run_id
                       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                    (item['student_id'], class_id, term_id, exam['id'], subject['id'],
                     exam['name'], exam['exam_date'], subject['name'], item['score'],
                     item['rank'], item['record_status'], item['note'], run_id),
                )
                imported += 1
        result = {
            'ok': True, 'run_id': int(run_id), 'imported': imported,
            'updated': updated, 'skipped': skipped, 'errors': [], 'idempotent': False,
        }
        conn.execute(
            '''UPDATE score_import_runs SET imported=?, updated=?, skipped=?,
                   result_json=? WHERE id=?''',
            (imported, updated, skipped, json.dumps(result, ensure_ascii=False), run_id),
        )
        audit.record(
            'score_import', run_id, 'import',
            summary=f'导入成绩：新增 {imported}，更新 {updated}，跳过 {skipped}',
            params={'filename': filename, 'duplicate_strategy': duplicate_strategy,
                    'rows': len(clean_rows)},
            class_id=class_id, term_id=term_id, conn=conn, commit=False,
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    try:
        evaluation = evaluate_rules(trigger='import', conn=conn)
        result['evaluation'] = evaluation
        result['evaluation_error'] = ''
    except Exception as exc:
        result['evaluation'] = None
        result['evaluation_error'] = str(exc)
    return result


def import_exam_rows(rows: list[list], duplicate_strategy: str = 'update') -> dict:
    """兼容旧内部调用；新界面必须先预览再确认。"""
    preview = preview_exam_rows(rows, duplicate_strategy)
    valid = [item for item in preview['rows'] if item['valid'] and item['action'] != '跳过']
    if not valid:
        return {'imported': 0, 'updated': 0, 'skipped': preview['summary']['skip'],
                'errors': [item['message'] for item in preview['errors']]}
    result = commit_exam_rows(
        valid, filename='兼容导入', duplicate_strategy=duplicate_strategy,
        request_id=f'compat-{uuid.uuid4().hex}',
    )
    result['errors'] = [f"第 {item['row']} 行：{item['message']}" for item in preview['errors']]
    return result


def list_records(*, student_id: int | None = None, exam_id: int | None = None,
                 conn=None) -> list[dict]:
    conn = conn or db.get_conn()
    class_id, term_id = _scope(conn=conn)
    where = ['r.class_id=?', 'r.term_id=?', "r.deleted_at=''", "s.deleted_at=''"]
    params: list = [class_id, term_id]
    if student_id:
        where.append('r.student_id=?')
        params.append(int(student_id))
    if exam_id:
        where.append('r.exam_id=?')
        params.append(int(exam_id))
    rows = conn.execute(
        '''SELECT r.*, s.学号, s.姓名,
                  COALESCE(x.name, r.exam_name) AS configured_exam_name,
                  COALESCE(x.exam_date, r.exam_date) AS configured_exam_date,
                  COALESCE(j.name, r.subject) AS configured_subject_name
           FROM exam_records r JOIN students s ON s.id=r.student_id
           LEFT JOIN score_exams x ON x.id=r.exam_id
           LEFT JOIN score_subjects j ON j.id=r.subject_id
           WHERE ''' + ' AND '.join(where) +
        ''' ORDER BY COALESCE(x.exam_date, r.exam_date), COALESCE(x.sort_order, r.id),
                    s.学号, COALESCE(j.sort_order, r.id), r.id''', tuple(params)
    ).fetchall()
    return [dict(row) for row in rows]


def score_summary(*, student_id: int | None = None, conn=None) -> dict:
    conn = conn or db.get_conn()
    class_id, term_id = _scope(conn=conn)
    config = list_config(conn=conn)
    selection_mode = config.get('settings', {}).get('mode', '固定科目')
    exams = [item for item in config['exams'] if item['enabled']]
    subjects = [item for item in config['subjects'] if item['enabled']]
    records = list_records(conn=conn)
    students = [dict(row) for row in conn.execute(
        '''SELECT s.id AS student_id, s.学号, s.姓名 FROM students s
           JOIN student_enrollments e ON e.student_id=s.id
           WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
           ORDER BY s.学号''', (class_id, term_id)
    ).fetchall()]
    selection_rows = conn.execute(
        '''SELECT student_id, subject_id FROM student_score_subjects
           WHERE class_id=? AND term_id=? ORDER BY student_id, subject_id''',
        (class_id, term_id),
    ).fetchall()
    selected_subjects_by_student: dict[int, set[int]] = {}
    for row in selection_rows:
        selected_subjects_by_student.setdefault(int(row['student_id']), set()).add(int(row['subject_id']))
    configured_selection_students = {
        int(row['student_id']) for row in conn.execute(
            '''SELECT student_id FROM student_score_profiles
               WHERE class_id=? AND term_id=?''', (class_id, term_id)
        ).fetchall()
    }
    if not exams and records:
        seen = set()
        for row in records:
            key = int(row['exam_id'] or 0)
            if key and key not in seen:
                exams.append({'id': key, 'name': row['exam_name'], 'exam_date': row['exam_date'],
                              'subject_ids': [], 'enabled': True})
                seen.add(key)
    exams.sort(key=lambda item: (item['exam_date'] or '9999-99-99', item.get('sort_order', 0), item['id']))
    subject_by_id = {int(item['id']): item for item in subjects}
    records_by_key = {
        (int(row['student_id']), int(row['exam_id'] or 0), int(row['subject_id'] or 0)): row
        for row in records if row.get('exam_id') and row.get('subject_id')
    }
    student_output = []
    exam_student_map: dict[int, list[dict]] = {int(exam['id']): [] for exam in exams}
    for student in students:
        selected_subject_ids = selected_subjects_by_student.get(int(student['student_id']))
        selection_configured = int(student['student_id']) in configured_selection_students
        exam_results = []
        for exam in exams:
            expected_ids = [int(value) for value in exam.get('subject_ids', []) if int(value) in subject_by_id]
            if not expected_ids:
                expected_ids = sorted({
                    int(row['subject_id']) for row in records
                    if int(row['exam_id'] or 0) == int(exam['id']) and row.get('subject_id')
                }, key=lambda value: subject_by_id.get(value, {}).get('sort_order', value))
            if selection_configured:
                expected_ids = [
                    subject_id_value for subject_id_value in expected_ids
                    if subject_by_id.get(subject_id_value, {}).get('subject_group', '必考') == '必考'
                    or subject_id_value in selected_subject_ids
                ]
            detail, missing = {}, []
            for subject_id_value in expected_ids:
                subject = subject_by_id.get(subject_id_value, {'name': f'科目{subject_id_value}'})
                row = records_by_key.get((int(student['student_id']), int(exam['id']), subject_id_value))
                value = {
                    'subject_id': subject_id_value, 'subject': subject['name'],
                    'score': row['score'] if row else None,
                    'status': row['record_status'] if row else '未录入',
                    'note': row['note'] if row else '',
                }
                detail[subject['name']] = value
                if not row or row['record_status'] != '正常' or row['score'] is None:
                    missing.append(subject['name'])
            has_any = any(
                key[0] == int(student['student_id']) and key[1] == int(exam['id'])
                for key in records_by_key
            )
            complete = bool(expected_ids) and not missing
            total = round(sum(float(item['score']) for item in detail.values()), 2) if complete else None
            result = {
                'exam_id': int(exam['id']), 'exam_name': exam['name'],
                'exam_date': exam['exam_date'], 'subjects': detail,
                'expected_subject_count': len(expected_ids), 'missing_subjects': missing,
                'complete': complete, 'has_any': has_any, 'total': total,
                'rank': None, 'stratum': '未分层', 'total_change': None, 'rank_change': None,
            }
            exam_results.append(result)
            exam_student_map[int(exam['id'])].append(result)
        student_output.append({
            **student,
            'exams': exam_results,
            'selected_subject_ids': sorted(selected_subject_ids or []),
            'selection_configured': selection_configured,
            'selection_status': _selection_status(
                selection_mode, selected_subject_ids or set(), subject_by_id
            ) if selection_configured else '未配置',
        })

    exam_output = []
    for exam in exams:
        exam_id_value = int(exam['id'])
        result_rows = exam_student_map[exam_id_value]
        complete_rows = sorted(
            [item for item in result_rows if item['total'] is not None],
            key=lambda item: -item['total'],
        )
        previous_total = None
        previous_rank = 0
        layer_size = max(1, round(len(complete_rows) * .25)) if len(complete_rows) > 1 else 0
        for position, item in enumerate(complete_rows, start=1):
            if previous_total is None or item['total'] != previous_total:
                previous_rank = position
                previous_total = item['total']
            item['rank'] = previous_rank
            if len(complete_rows) == 1:
                item['stratum'] = 'B层'
            elif position <= layer_size:
                item['stratum'] = 'A层'
            elif position > len(complete_rows) - layer_size:
                item['stratum'] = 'C层'
            else:
                item['stratum'] = 'B层'
        expected_ids = [int(value) for value in exam.get('subject_ids', []) if int(value) in subject_by_id]
        if not expected_ids:
            expected_ids = sorted({
                int(row['subject_id']) for row in records
                if int(row['exam_id'] or 0) == exam_id_value and row.get('subject_id')
            }, key=lambda value: subject_by_id.get(value, {}).get('sort_order', value))
        subject_stats = []
        for subject_id_value in expected_ids:
            subject = subject_by_id.get(subject_id_value, {'name': f'科目{subject_id_value}', 'full_score': 0})
            eligible_student_ids = {
                int(item['student_id']) for item in students
                if int(item['student_id']) not in configured_selection_students
                or subject.get('subject_group', '必考') == '必考'
                or subject_id_value in selected_subjects_by_student.get(int(item['student_id']), set())
            }
            values = [
                row for row in records
                if int(row['exam_id'] or 0) == exam_id_value
                and int(row['subject_id'] or 0) == subject_id_value
                and int(row['student_id']) in eligible_student_ids
            ]
            normal_scores = [float(row['score']) for row in values
                             if row['record_status'] == '正常' and row['score'] is not None]
            explicit_absence = sum(row['record_status'] == '缺考' for row in values)
            subject_stats.append({
                'subject_id': subject_id_value, 'subject': subject['name'],
                'full_score': subject.get('full_score', 0),
                'average': round(sum(normal_scores) / len(normal_scores), 1) if normal_scores else None,
                'eligible_count': len(eligible_student_ids), 'recorded_count': len(normal_scores),
                'absent_count': explicit_absence,
                'missing_count': max(0, len(eligible_student_ids) - len(normal_scores) - explicit_absence),
            })
        totals = [item['total'] for item in complete_rows]
        exam_output.append({
            **exam, 'subject_stats': subject_stats, 'student_count': len(students),
            'complete_count': len(complete_rows),
            'missing_count': len(students) - len(complete_rows),
            'class_average_total': round(sum(totals) / len(totals), 1) if totals else None,
        })

    for student in student_output:
        previous = None
        for item in student['exams']:
            if previous and previous['total'] is not None and item['total'] is not None:
                item['total_change'] = round(item['total'] - previous['total'], 2)
                if previous['rank'] is not None and item['rank'] is not None:
                    item['rank_change'] = previous['rank'] - item['rank']
            if item['total'] is not None:
                previous = item

    if student_id is not None:
        student_output = [item for item in student_output if int(item['student_id']) == int(student_id)]
    return {
        'exams': exam_output, 'subjects': subjects, 'students': student_output,
        'records': [row for row in records
                    if student_id is None or int(row['student_id']) == int(student_id)],
        'definition': {
            'missing': '缺考、免考和未录入均不按 0 分计入平均分。',
            'total': '只有考试配置中的预期科目全部为正常数值成绩时才计算总分。',
            'rank': '班级排名仅在总分完整的学生中按总分降序计算，同分同名次。',
            'stratum': 'A/B/C 层按完整总分排名的前 25%/中间 50%/后 25% 划分。',
        },
    }


def list_rules(*, source_id: int | None = None, conn=None) -> dict:
    conn = conn or db.get_conn()
    class_id, term_id = _scope(conn=conn)
    params: list = [class_id, term_id]
    sql = '''SELECT r.*, s.name AS subject_name FROM score_rules r
             LEFT JOIN score_subjects s ON s.id=r.subject_id
             WHERE r.class_id=? AND r.term_id=? AND r.deleted_at='' '''
    if source_id:
        sql += ' AND r.id=?'
        params.append(int(source_id))
    rules = [dict(row) for row in conn.execute(
        sql + ' ORDER BY r.enabled DESC, r.id', tuple(params)).fetchall()]
    for rule in rules:
        rule['enabled'] = bool(rule['enabled'])
        rule['hits'] = [dict(row) for row in conn.execute(
            '''SELECT h.*, s.学号, s.姓名 AS student_name,
                      p.name AS previous_exam_name, c.name AS current_exam_name,
                      t.status AS task_status, t.result AS task_result
               FROM score_rule_hits h JOIN students s ON s.id=h.student_id
               LEFT JOIN score_exams p ON p.id=h.previous_exam_id
               LEFT JOIN score_exams c ON c.id=h.current_exam_id
               LEFT JOIN student_tasks t ON t.id=h.task_id
               WHERE h.class_id=? AND h.term_id=? AND h.rule_id=?
               ORDER BY CASE h.status WHEN '待处理' THEN 0 WHEN '已处理' THEN 1 ELSE 2 END,
                        h.last_hit_at DESC, h.id DESC''',
            (class_id, term_id, rule['id']),
        ).fetchall()]
        rule['active_hit_count'] = sum(item['status'] == '待处理' for item in rule['hits'])
        rule['handled_hit_count'] = sum(item['status'] == '已处理' for item in rule['hits'])
    runs = [dict(row) for row in conn.execute(
        '''SELECT * FROM score_rule_runs WHERE class_id=? AND term_id=?
           ORDER BY id DESC LIMIT 20''', (class_id, term_id)
    ).fetchall()]
    for run in runs:
        try:
            run['summary'] = json.loads(run.pop('summary_json') or '[]')
        except (TypeError, ValueError):
            run['summary'] = []
    return {'rules': rules, 'recent_runs': runs}


def create_rule(*, name: str, metric: str, threshold: float,
                subject_id: int | None = None, priority: str = '重要',
                enabled: bool = True, conn=None) -> dict:
    conn = conn or db.get_conn()
    name = _text(name)
    if not name:
        raise ScoreError('规则名称不能为空')
    if metric not in RULE_METRICS:
        raise ScoreError('不支持的成绩规则指标')
    threshold = _positive_number(threshold, '阈值', allow_zero=False)
    if metric == '单科下降':
        if not subject_id:
            raise ScoreError('单科下降规则必须选择科目')
        _subject_row(subject_id, write=True, conn=conn)
    else:
        subject_id = None
    class_id, term_id = _scope(write=True, conn=conn)
    rule_id = conn.execute(
        '''INSERT INTO score_rules(
               class_id, term_id, name, metric, subject_id, threshold, priority, enabled
           ) VALUES(?,?,?,?,?,?,?,?)''',
        (class_id, term_id, name, metric, subject_id, threshold,
         _text(priority) or '重要', int(bool(enabled))),
    ).lastrowid
    audit.record(
        'score_rule', rule_id, 'create', summary=f'新增成绩规则：{name}',
        params={'metric': metric, 'subject_id': subject_id, 'threshold': threshold},
        conn=conn, commit=False)
    conn.commit()
    evaluation = evaluate_rules(trigger='rule_change', conn=conn) if enabled else None
    return {'ok': True, 'rule_id': int(rule_id), 'evaluation': evaluation}


def _resolve_open_task(task_id: int | None, result: str, *, conn) -> bool:
    if not task_id:
        return False
    row = conn.execute(
        "SELECT status FROM student_tasks WHERE id=? AND deleted_at=''", (task_id,)
    ).fetchone()
    if not row or row['status'] not in OPEN_TASK_STATUSES:
        return False
    from . import work_items
    work_items.update_work_item(
        int(task_id), status='已取消', result=result, conn=conn, commit=False)
    return True


def _resolve_hits(rule_id: int, result: str, *, conn) -> int:
    class_id, term_id = _scope(write=True, conn=conn)
    rows = conn.execute(
        '''SELECT * FROM score_rule_hits WHERE rule_id=? AND class_id=? AND term_id=?
           AND status<>'已解除' ''', (rule_id, class_id, term_id)
    ).fetchall()
    for row in rows:
        _resolve_open_task(row['task_id'], result, conn=conn)
        conn.execute(
            "UPDATE score_rule_hits SET status='已解除', resolved_at=?, "
            "updated_at=datetime('now','localtime') WHERE id=?", (_now(), row['id']))
    return len(rows)


def update_rule(rule_id: int, *, enabled: bool | None = None,
                threshold: float | None = None, priority: str | None = None,
                conn=None) -> dict:
    conn = conn or db.get_conn()
    class_id, term_id = _scope(write=True, conn=conn)
    current = conn.execute(
        "SELECT * FROM score_rules WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (int(rule_id), class_id, term_id),
    ).fetchone()
    if not current:
        raise ScoreError('成绩规则不存在')
    fields, params, changes = [], [], {}
    if enabled is not None:
        fields.append('enabled=?'); params.append(int(bool(enabled))); changes['enabled'] = bool(enabled)
    if threshold is not None:
        value = _positive_number(threshold, '阈值', allow_zero=False)
        fields.append('threshold=?'); params.append(value); changes['threshold'] = value
    if priority is not None:
        fields.append('priority=?'); params.append(_text(priority)); changes['priority'] = _text(priority)
    if not fields:
        return {'ok': True, 'evaluation': None, 'resolved_count': 0}
    conn.execute(
        f"UPDATE score_rules SET {', '.join(fields)}, updated_at=datetime('now','localtime') WHERE id=?",
        (*params, int(rule_id)),
    )
    next_enabled = bool(enabled) if enabled is not None else bool(current['enabled'])
    resolved = _resolve_hits(
        int(rule_id), '成绩规则已停用，系统自动解除提醒', conn=conn
    ) if not next_enabled else 0
    audit.record(
        'score_rule', rule_id, 'update', summary=f"更新成绩规则：{current['name']}",
        params=changes, conn=conn, commit=False)
    conn.commit()
    evaluation = evaluate_rules(trigger='rule_change', conn=conn) if next_enabled else None
    return {'ok': True, 'evaluation': evaluation, 'resolved_count': resolved}


def _activate_task(rule: dict, student: dict, previous_exam: dict, current_exam: dict,
                   value: float, *, rehit: bool, conn) -> tuple[int, bool, bool]:
    from . import work_items
    subject_text = f" · {rule['subject_name']}" if rule.get('subject_name') else ''
    title = f"成绩提醒 · {student['姓名']} · {rule['name']}"
    notes = (
        f"{previous_exam['exam_name']} → {current_exam['exam_name']}，"
        f"{rule['metric']}{subject_text}达到 {value:g}，阈值 {float(rule['threshold']):g}"
    )
    task = work_items.ensure_source_work_item(
        title=title, legacy_title=title, student_id=student['student_id'],
        source_type='score_rule', source_id=rule['id'],
        due_at=current_exam['exam_date'] or clock.today().isoformat(),
        priority=rule['priority'], status='待处理', notes=notes,
        conn=conn, commit=False,
    )
    task_id = int(task['id'])
    row = conn.execute(
        '''SELECT status, title, priority, due_at, notes FROM student_tasks
           WHERE id=? AND deleted_at='' ''', (task_id,)
    ).fetchone()
    due_at = current_exam['exam_date'] or clock.today().isoformat()
    reopened = False
    if row and row['status'] not in OPEN_TASK_STATUSES and (rehit or not task['created']):
        work_items.update_work_item(
            task_id, title=title, priority=rule['priority'], status='待处理',
            due_at=due_at, notes=notes, conn=conn, commit=False)
        reopened = True
    elif row and row['status'] in OPEN_TASK_STATUSES and any((
        row['title'] != title, row['priority'] != rule['priority'],
        row['due_at'] != due_at, row['notes'] != notes,
    )):
        work_items.update_work_item(
            task_id, title=title, priority=rule['priority'], due_at=due_at,
            notes=notes, conn=conn, commit=False)
    return task_id, bool(task['created']), reopened


def _rule_pair(rule: dict, student: dict) -> tuple[dict, dict, float] | None:
    comparable = []
    for exam in student['exams']:
        value = None
        if rule['metric'] == '总分下降' and exam['total'] is not None:
            value = float(exam['total'])
        elif rule['metric'] == '排名下降' and exam['rank'] is not None:
            value = float(exam['rank'])
        elif rule['metric'] == '单科下降':
            subject = exam['subjects'].get(rule.get('subject_name') or '')
            if subject and subject['status'] == '正常' and subject['score'] is not None:
                value = float(subject['score'])
        if value is not None:
            comparable.append((exam, value))
    if len(comparable) < 2:
        return None
    previous, current = comparable[-2], comparable[-1]
    decline = (current[1] - previous[1]) if rule['metric'] == '排名下降' else (previous[1] - current[1])
    return previous[0], current[0], round(decline, 2)


def evaluate_rules(*, trigger: str = 'manual', conn=None) -> dict:
    conn = conn or db.get_conn()
    if trigger not in RULE_TRIGGERS:
        raise ScoreError('规则执行来源不合法')
    class_id, term_id = _scope(write=True, conn=conn)
    rules = [dict(row) for row in conn.execute(
        '''SELECT r.*, s.name AS subject_name FROM score_rules r
           LEFT JOIN score_subjects s ON s.id=r.subject_id
           WHERE r.class_id=? AND r.term_id=? AND r.enabled=1 AND r.deleted_at=''
           ORDER BY r.id''', (class_id, term_id)
    ).fetchall()]
    data = score_summary(conn=conn)
    students = data['students']
    now = _now()
    hit_count = created_count = reopened_count = resolved_count = 0
    output = []
    try:
        for rule in rules:
            for student in students:
                pair = _rule_pair(rule, student)
                hit = conn.execute(
                    '''SELECT * FROM score_rule_hits
                       WHERE class_id=? AND term_id=? AND rule_id=? AND student_id=?''',
                    (class_id, term_id, rule['id'], student['student_id']),
                ).fetchone()
                previous_exam, current_exam, value = pair if pair else (None, None, 0)
                matched = bool(pair and value >= float(rule['threshold']))
                if matched:
                    hit_count += 1
                    hit_dict = dict(hit) if hit else None
                    new_exam = int(current_exam['exam_id'])
                    new_cycle = (
                        hit_dict is None or hit_dict['status'] == '已解除'
                        or (hit_dict['status'] == '已处理'
                            and int(hit_dict['current_exam_id'] or 0) != new_exam)
                    )
                    if new_cycle or (hit_dict and hit_dict['status'] == '待处理'):
                        task_id, created, reopened = _activate_task(
                            rule, student, previous_exam, current_exam, value,
                            rehit=bool(hit_dict and new_cycle), conn=conn,
                        )
                    else:
                        task_id = int(hit_dict['task_id']) if hit_dict and hit_dict['task_id'] else None
                        created = reopened = False
                    created_count += int(created)
                    reopened_count += int(reopened)
                    next_status = '待处理' if new_cycle else hit_dict['status']
                    if hit_dict:
                        conn.execute(
                            '''UPDATE score_rule_hits SET status=?, current_value=?,
                                   previous_exam_id=?, current_exam_id=?, task_id=?, last_hit_at=?,
                                   handled_at=CASE WHEN ?='待处理' THEN '' ELSE handled_at END,
                                   resolved_at='', updated_at=datetime('now','localtime') WHERE id=?''',
                            (next_status, value, previous_exam['exam_id'], current_exam['exam_id'],
                             task_id, now, next_status, hit_dict['id']),
                        )
                    else:
                        conn.execute(
                            '''INSERT INTO score_rule_hits(
                                   rule_id, student_id, class_id, term_id, status,
                                   current_value, previous_exam_id, current_exam_id,
                                   task_id, first_hit_at, last_hit_at
                               ) VALUES(?,?,?,?,'待处理',?,?,?,?,?,?)''',
                            (rule['id'], student['student_id'], class_id, term_id, value,
                             previous_exam['exam_id'], current_exam['exam_id'], task_id, now, now),
                        )
                    output.append({
                        'rule_id': rule['id'], 'rule': rule['name'],
                        'student_id': student['student_id'], 'student_name': student['姓名'],
                        'previous_exam': previous_exam['exam_name'],
                        'current_exam': current_exam['exam_name'], 'value': value,
                        'state': '新命中' if not hit_dict else ('重新命中' if new_cycle else next_status),
                    })
                elif hit and hit['status'] != '已解除':
                    _resolve_open_task(
                        hit['task_id'], '成绩指标已恢复，系统自动解除提醒', conn=conn)
                    conn.execute(
                        '''UPDATE score_rule_hits SET status='已解除', current_value=?,
                               resolved_at=?, updated_at=datetime('now','localtime') WHERE id=?''',
                        (value, now, hit['id']),
                    )
                    resolved_count += 1
            conn.execute(
                "UPDATE score_rules SET last_run_at=?, updated_at=datetime('now','localtime') WHERE id=?",
                (now, rule['id']),
            )
        run_id = conn.execute(
            '''INSERT INTO score_rule_runs(
                   class_id, term_id, trigger_type, rules_evaluated, students_evaluated,
                   hit_count, created_count, reopened_count, resolved_count, status, summary_json
               ) VALUES(?,?,?,?,?,?,?,?,?,'success',?)''',
            (class_id, term_id, trigger, len(rules), len(students), hit_count,
             created_count, reopened_count, resolved_count, json.dumps(output, ensure_ascii=False)),
        ).lastrowid
        audit.record(
            'score_rules', run_id, 'evaluate',
            summary=(f'执行 {len(rules)} 条成绩规则：命中 {hit_count}，'
                     f'新建 {created_count}，重开 {reopened_count}，解除 {resolved_count}'),
            params={'trigger': trigger}, class_id=class_id, term_id=term_id,
            conn=conn, commit=False,
        )
        conn.commit()
    except Exception as exc:
        conn.rollback()
        conn.execute(
            '''INSERT INTO score_rule_runs(
                   class_id, term_id, trigger_type, rules_evaluated,
                   students_evaluated, status, error
               ) VALUES(?,?,?,?,?,'failed',?)''',
            (class_id, term_id, trigger, len(rules), len(students), str(exc)[:500]),
        )
        conn.commit()
        raise
    return {
        'run_id': int(run_id), 'trigger': trigger, 'rules_evaluated': len(rules),
        'students_evaluated': len(students), 'hit_count': hit_count,
        'created_count': created_count, 'reopened_count': reopened_count,
        'resolved_count': resolved_count, 'summary': output,
    }


def on_work_item_transition(conn, item: dict, next_status: str):
    if item.get('source_type') != 'score_rule':
        return
    now = _now()
    if next_status in {'已完成', '已取消'}:
        conn.execute(
            '''UPDATE score_rule_hits SET status='已处理', handled_at=?,
                   updated_at=datetime('now','localtime')
               WHERE task_id=? AND status='待处理' ''', (now, item['id']))
    elif next_status in OPEN_TASK_STATUSES:
        conn.execute(
            '''UPDATE score_rule_hits SET status='待处理', handled_at='', resolved_at='',
                   updated_at=datetime('now','localtime') WHERE task_id=?''', (item['id'],))


def evaluate_startup(*, conn=None) -> list[dict]:
    conn = conn or db.get_conn()
    scopes = conn.execute(
        '''SELECT c.id AS class_id, t.id AS term_id FROM classes c
           JOIN terms t ON t.class_id=c.id
           WHERE c.status='使用中' AND t.status='进行中' ORDER BY c.id, t.id'''
    ).fetchall()
    results = []
    for scope in scopes:
        token = class_context.bind_request_scope(scope['class_id'], scope['term_id'])
        try:
            results.append(evaluate_rules(trigger='startup', conn=conn))
        finally:
            class_context.reset_request_scope(token)
    return results
