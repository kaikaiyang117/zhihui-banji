# -*- coding: utf-8 -*-
"""评语模板、批量生成、人工保护、审核交付和旧通用表迁移服务。"""
from __future__ import annotations

from datetime import datetime
import json
import re
import threading

from .. import db
from ..config import STUDENT_COLUMNS
from . import audit, class_context


COMMENT_TYPES = {'学期评语', '毕业评语', '日常评语'}
COMMENT_STATUSES = {'草稿', '待审核', '完成', '已发送'}
STATUS_TRANSITIONS = {
    '草稿': {'待审核'},
    '待审核': {'草稿', '完成'},
    '完成': {'待审核', '已发送'},
    '已发送': set(),
}
SUPPORTED_VARIABLES = tuple(STUDENT_COLUMNS) + ('班级', '年级', '学期')
_VARIABLE_RE = re.compile(r'{{\s*([^{}]+?)\s*}}')
_write_lock = threading.RLock()


class CommentError(ValueError):
    pass


def _conn(conn=None):
    return conn or db.get_conn()


def _text(value) -> str:
    return str(value or '').strip()


def _now() -> str:
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def _scope(*, write: bool = False, conn=None) -> tuple[int, int]:
    return class_context.scope_ids(write=write, conn=_conn(conn))


def _comment_type(value) -> str:
    text = _text(value) or '学期评语'
    if text not in COMMENT_TYPES:
        raise CommentError('评语类型不合法')
    return text


def _status(value) -> str:
    text = _text(value)
    if text not in COMMENT_STATUSES:
        raise CommentError('评语状态不合法')
    return text


def _actor() -> str:
    return audit.current_actor()[1] or 'local-user'


def _template_row(template_id: int, *, write: bool = False, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=write, conn=conn)
    row = conn.execute(
        "SELECT * FROM comment_templates WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (int(template_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise CommentError('评语模板不存在')
    return dict(row)


def _comment_row(comment_id: int, *, write: bool = False, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=write, conn=conn)
    row = conn.execute(
        '''SELECT c.*, s.学号, s.姓名 AS student_name, t.name AS template_name
           FROM student_comments c JOIN students s ON s.id=c.student_id
           LEFT JOIN comment_templates t ON t.id=c.template_id
           WHERE c.id=? AND c.class_id=? AND c.term_id=? AND c.deleted_at='' AND s.deleted_at='' ''',
        (int(comment_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise CommentError('学生评语不存在')
    return dict(row)


def _serialize(row: dict, *, conn=None) -> dict:
    conn = _conn(conn)
    item = dict(row)
    item['student_name'] = item.get('student_name') or item.get('姓名') or ''
    item['template_name'] = item.get('template_name') or ''
    item['is_manually_edited'] = bool(item.get('is_manually_edited'))
    item['version_count'] = int(conn.execute(
        'SELECT COUNT(*) FROM comment_versions WHERE comment_id=?', (item['id'],)
    ).fetchone()[0])
    item['source_label'] = {
        'manual': '手工创建', 'template': '模板生成', 'legacy_sheet': '旧版评语工作表',
        'agent': 'Agent 草稿', 'ai': 'AI生成草稿',
    }.get(item.get('source_type'), item.get('source_type') or '')
    return item


def _student_row(student_id: int, *, write: bool = False, conn=None) -> dict:
    try:
        return class_context.ensure_student_in_scope(student_id, write=write, conn=_conn(conn))
    except class_context.ArchivedScopeError:
        raise
    except class_context.ScopeError as exc:
        raise CommentError(str(exc)) from exc


def _active_students(*, conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    return [dict(row) for row in conn.execute(
        '''SELECT s.* FROM students s JOIN student_enrollments e ON e.student_id=s.id
           WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
           ORDER BY s.学号, s.id''', (class_id, term_id),
    ).fetchall()]


def extract_variables(content: str) -> list[str]:
    return list(dict.fromkeys(_text(item) for item in _VARIABLE_RE.findall(_text(content)) if _text(item)))


def variable_catalog() -> list[dict]:
    return [{'name': item, 'token': '{{' + item + '}}'} for item in SUPPORTED_VARIABLES]


def _render(content: str, student: dict, scope: dict) -> tuple[str, list[str]]:
    values = {key: _text(student.get(key)) for key in STUDENT_COLUMNS}
    values.update({
        '班级': _text(scope.get('class_name')),
        '年级': _text(scope.get('grade')),
        '学期': _text(scope.get('term_name')),
    })
    missing = []

    def replace(match):
        name = _text(match.group(1))
        value = values.get(name, '')
        if not value:
            missing.append(name)
            return f'〔{name}未填写〕'
        return value

    rendered = _VARIABLE_RE.sub(replace, _text(content))
    return rendered, list(dict.fromkeys(missing))


def list_templates(*, include_disabled: bool = False, conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    where = ['class_id=?', 'term_id=?', "deleted_at=''"]
    params: list = [class_id, term_id]
    if not include_disabled:
        where.append('enabled=1')
    rows = conn.execute(
        'SELECT * FROM comment_templates WHERE ' + ' AND '.join(where) +
        ' ORDER BY enabled DESC, comment_type, name, id', tuple(params),
    ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item['variables'] = extract_variables(item['content'])
        result.append(item)
    return result


def create_template(*, name: str, comment_type: str = '学期评语', content: str,
                    enabled: bool = True, conn=None) -> dict:
    conn = _conn(conn)
    name = _text(name)
    content = _text(content)
    if not name or not content:
        raise CommentError('模板名称和内容不能为空')
    comment_type = _comment_type(comment_type)
    unknown = [item for item in extract_variables(content) if item not in SUPPORTED_VARIABLES]
    if unknown:
        raise CommentError(f"模板含不支持的变量：{'、'.join(unknown)}")
    class_id, term_id = _scope(write=True, conn=conn)
    try:
        template_id = conn.execute(
            '''INSERT INTO comment_templates(class_id, term_id, name, comment_type, content, enabled)
               VALUES(?,?,?,?,?,?) RETURNING id''',
            (class_id, term_id, name, comment_type, content, int(bool(enabled))),
        ).fetchone()['id']
        audit.record('comment_template', template_id, 'create', summary=f'新增评语模板：{name}',
                     params={'name': name, 'comment_type': comment_type, 'variables': extract_variables(content)},
                     class_id=class_id, term_id=term_id, conn=conn, commit=False)
        conn.commit()
    except Exception as exc:
        conn.rollback()
        if 'UNIQUE constraint failed' in str(exc):
            raise CommentError('当前班级与学期已有同名评语模板') from exc
        raise
    return _template_row(template_id, conn=conn)


def update_template(template_id: int, *, name: str | None = None, comment_type: str | None = None,
                    content: str | None = None, enabled: bool | None = None, conn=None) -> dict:
    conn = _conn(conn)
    current = _template_row(template_id, write=True, conn=conn)
    values = {
        'name': _text(name) if name is not None else current['name'],
        'comment_type': _comment_type(comment_type) if comment_type is not None else current['comment_type'],
        'content': _text(content) if content is not None else current['content'],
        'enabled': int(bool(enabled)) if enabled is not None else int(current['enabled']),
    }
    if not values['name'] or not values['content']:
        raise CommentError('模板名称和内容不能为空')
    unknown = [item for item in extract_variables(values['content']) if item not in SUPPORTED_VARIABLES]
    if unknown:
        raise CommentError(f"模板含不支持的变量：{'、'.join(unknown)}")
    try:
        conn.execute(
            '''UPDATE comment_templates SET name=?, comment_type=?, content=?, enabled=?,
                   updated_at=datetime('now','localtime') WHERE id=?''',
            (*values.values(), int(template_id)),
        )
        audit.record('comment_template', template_id, 'update', summary=f"更新评语模板：{values['name']}",
                     params=values, conn=conn, commit=False)
        conn.commit()
    except Exception as exc:
        conn.rollback()
        if 'UNIQUE constraint failed' in str(exc):
            raise CommentError('当前班级与学期已有同名评语模板') from exc
        raise
    return _template_row(template_id, conn=conn)


def _record_version(comment_id: int, content: str, status: str, change_type: str,
                    note: str = '', *, conn=None):
    conn = _conn(conn)
    version_no = int(conn.execute(
        'SELECT COALESCE(MAX(version_no),0)+1 FROM comment_versions WHERE comment_id=?',
        (int(comment_id),),
    ).fetchone()[0])
    conn.execute(
        '''INSERT INTO comment_versions(
               comment_id, version_no, content, status, change_type, note, changed_by
           ) VALUES(?,?,?,?,?,?,?)''',
        (int(comment_id), version_no, _text(content), status, change_type, _text(note), _actor()),
    )


def migrate_legacy_rows(*, conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        class_id, term_id = _scope(write=True, conn=conn)
        existing = conn.execute(
            '''SELECT * FROM comment_migration_runs
               WHERE class_id=? AND term_id=? AND source_sheet=? AND source_version=?''',
            (class_id, term_id, '评语管理', 'v1'),
        ).fetchone()
        if existing:
            result = dict(existing)
            result['report'] = json.loads(result.get('report') or '{}')
            return result
        rows = conn.execute(
            '''SELECT row_no, data FROM sheet_rows
               WHERE sheet=? AND class_id=? AND term_id=? AND deleted_at='' ORDER BY row_no''',
            ('评语管理', class_id, term_id),
        ).fetchall()
        students = [dict(row) for row in conn.execute(
            '''SELECT s.id, s.学号, s.姓名 FROM students s
               JOIN student_enrollments e ON e.student_id=s.id
               WHERE e.class_id=? AND e.term_id=? AND s.deleted_at='' ''',
            (class_id, term_id),
        ).fetchall()]
        by_number = {_text(item['学号']): item for item in students if _text(item['学号'])}
        by_name: dict[str, list[dict]] = {}
        for item in students:
            by_name.setdefault(_text(item['姓名']), []).append(item)
        imported = 0
        skipped = 0
        reasons: dict[str, int] = {}
        for row in rows:
            try:
                data = json.loads(row['data'])
            except (TypeError, ValueError, json.JSONDecodeError):
                data = []
            number = _text(data[0] if len(data) > 0 else '')
            name = _text(data[1] if len(data) > 1 else '')
            student = by_number.get(number)
            if not student and len(by_name.get(name, [])) == 1:
                student = by_name[name][0]
            content = _text(data[3] if len(data) > 3 else '')
            if not student or not content:
                reason = '学生无法唯一匹配' if not student else '评语内容为空'
                skipped += 1
                reasons[reason] = reasons.get(reason, 0) + 1
                continue
            raw_type = _text(data[2] if len(data) > 2 else '')
            comment_type = raw_type if raw_type in COMMENT_TYPES else '学期评语'
            raw_status = _text(data[4] if len(data) > 4 else '')
            status = {'已完成': '完成', '完成': '完成', '已发送': '已发送', '待审核': '待审核'}.get(raw_status, '草稿')
            source_key = f'legacy-sheet:{row["row_no"]}'
            try:
                comment_id = conn.execute(
                    '''INSERT INTO student_comments(
                           class_id, term_id, student_id, comment_type, content, status,
                           source_type, source_id, source_key, is_manually_edited,
                           edited_at, edited_by, note
                       ) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?) RETURNING id''',
                    (class_id, term_id, student['id'], comment_type, content, status,
                     'legacy_sheet', str(row['row_no']), source_key, _now(), 'legacy-import',
                     _text(data[5] if len(data) > 5 else '')),
                ).fetchone()['id']
            except Exception as exc:
                if 'UNIQUE constraint failed' not in str(exc):
                    raise
                skipped += 1
                reasons['同学生同类型已有评语'] = reasons.get('同学生同类型已有评语', 0) + 1
                continue
            _record_version(comment_id, content, status, 'migrate', conn=conn)
            imported += 1
        report = {
            'source_rows': len(rows), 'imported_entries': imported,
            'skipped_entries': skipped, 'skipped_reasons': reasons,
            'legacy_sheet_retained': True,
        }
        run_id = conn.execute(
            '''INSERT INTO comment_migration_runs(
                   class_id, term_id, source_sheet, source_version,
                   source_rows, imported_entries, skipped_entries, report
               ) VALUES(?,?,?,?,?,?,?,?)''',
            (class_id, term_id, '评语管理', 'v1', len(rows), imported, skipped,
             json.dumps(report, ensure_ascii=False)),
        ).lastrowid
        audit.record('comment_migration', run_id, 'migrate', summary='迁移旧版评语',
                     params=report, class_id=class_id, term_id=term_id, conn=conn, commit=False)
        conn.commit()
        result = dict(conn.execute('SELECT * FROM comment_migration_runs WHERE id=?', (run_id,)).fetchone())
        result['report'] = report
        return result


def ensure_legacy_migrated(*, conn=None) -> dict | None:
    conn = _conn(conn)
    scope = class_context.get_current_scope(conn=conn)
    if scope['class_status'] == '已归档' or scope['term_status'] == '已归档':
        row = conn.execute(
            '''SELECT * FROM comment_migration_runs WHERE class_id=? AND term_id=?
               AND source_sheet=? AND source_version=?''',
            (scope['class_id'], scope['term_id'], '评语管理', 'v1'),
        ).fetchone()
        return dict(row) if row else None
    return migrate_legacy_rows(conn=conn)


def migration_report(*, conn=None) -> dict | None:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    row = conn.execute(
        '''SELECT * FROM comment_migration_runs WHERE class_id=? AND term_id=?
           AND source_sheet=? AND source_version=?''',
        (class_id, term_id, '评语管理', 'v1'),
    ).fetchone()
    if not row:
        return None
    item = dict(row)
    item['report'] = json.loads(item.get('report') or '{}')
    return item


def list_comments(*, student_id: int | None = None, comment_type: str = '', status: str = '',
                  keyword: str = '', limit: int = 500, conn=None) -> list[dict]:
    conn = _conn(conn)
    ensure_legacy_migrated(conn=conn)
    class_id, term_id = _scope(conn=conn)
    where = ['c.class_id=?', 'c.term_id=?', "c.deleted_at=''", "s.deleted_at=''"]
    params: list = [class_id, term_id]
    if student_id is not None:
        where.append('c.student_id=?')
        params.append(int(student_id))
    if comment_type:
        where.append('c.comment_type=?')
        params.append(_comment_type(comment_type))
    if status:
        where.append('c.status=?')
        params.append(_status(status))
    if keyword:
        where.append('(s.姓名 LIKE ? OR s.学号 LIKE ? OR c.content LIKE ?)')
        pattern = f'%{_text(keyword)}%'
        params.extend([pattern, pattern, pattern])
    params.append(max(1, min(int(limit), 5000)))
    rows = conn.execute(
        '''SELECT c.*, s.学号, s.姓名 AS student_name, t.name AS template_name
           FROM student_comments c JOIN students s ON s.id=c.student_id
           LEFT JOIN comment_templates t ON t.id=c.template_id
           WHERE ''' + ' AND '.join(where) +
        " ORDER BY CASE c.status WHEN '待审核' THEN 0 WHEN '草稿' THEN 1 WHEN '完成' THEN 2 ELSE 3 END, s.学号, c.id DESC LIMIT ?",
        tuple(params),
    ).fetchall()
    return [_serialize(dict(row), conn=conn) for row in rows]


def get_comment(comment_id: int, *, conn=None) -> dict:
    return _serialize(_comment_row(comment_id, conn=conn), conn=conn)


def comment_versions(comment_id: int, *, conn=None) -> list[dict]:
    conn = _conn(conn)
    _comment_row(comment_id, conn=conn)
    return [dict(row) for row in conn.execute(
        'SELECT * FROM comment_versions WHERE comment_id=? ORDER BY version_no DESC',
        (int(comment_id),),
    ).fetchall()]


def preview_generation(*, template_id: int, student_ids: list[int] | None = None,
                       comment_type: str = '', conn=None) -> dict:
    conn = _conn(conn)
    ensure_legacy_migrated(conn=conn)
    template = _template_row(template_id, conn=conn)
    selected_type = _comment_type(comment_type or template['comment_type'])
    scope = class_context.get_current_scope(conn=conn)
    students = _active_students(conn=conn)
    requested = {int(item) for item in (student_ids or [])}
    if requested:
        students = [item for item in students if int(item['id']) in requested]
        found = {int(item['id']) for item in students}
        if found != requested:
            raise CommentError('部分学生不在当前班级和学期中')
    if not students:
        raise CommentError('至少选择一名学生')
    class_id, term_id = _scope(conn=conn)
    rows = []
    for student in students:
        existing_row = conn.execute(
            '''SELECT c.*, s.学号, s.姓名 AS student_name, t.name AS template_name
               FROM student_comments c JOIN students s ON s.id=c.student_id
               LEFT JOIN comment_templates t ON t.id=c.template_id
               WHERE c.class_id=? AND c.term_id=? AND c.student_id=?
                 AND c.comment_type=? AND c.deleted_at='' ''',
            (class_id, term_id, student['id'], selected_type),
        ).fetchone()
        existing = dict(existing_row) if existing_row else None
        protected = bool(existing and (existing['is_manually_edited'] or existing['status'] != '草稿'))
        content, missing = _render(template['content'], student, scope)
        rows.append({
            'student_id': int(student['id']), '学号': student['学号'] or '', '姓名': student['姓名'] or '',
            'content': content, 'missing_variables': missing, 'has_missing': bool(missing),
            'existing_id': int(existing['id']) if existing else None,
            'existing_status': existing['status'] if existing else '',
            'is_manually_edited': bool(existing and existing['is_manually_edited']),
            'protected': protected,
            'action': '跳过受保护内容' if protected else '更新自动草稿' if existing else '新增草稿',
        })
    return {
        'template': {**template, 'variables': extract_variables(template['content'])},
        'comment_type': selected_type,
        'rows': rows,
        'summary': {
            'requested': len(rows),
            'creatable': sum(not row['existing_id'] for row in rows),
            'updatable': sum(bool(row['existing_id']) and not row['protected'] for row in rows),
            'protected': sum(row['protected'] for row in rows),
            'missing': sum(row['has_missing'] for row in rows),
        },
    }


def generate_batch(*, template_id: int, student_ids: list[int] | None = None,
                   comment_type: str = '', confirm_missing: bool = False, conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        _scope(write=True, conn=conn)
        preview = preview_generation(
            template_id=template_id, student_ids=student_ids, comment_type=comment_type, conn=conn)
        if preview['summary']['missing'] and not confirm_missing:
            raise CommentError(
                f"有 {preview['summary']['missing']} 名学生存在模板变量缺失，请确认后再生成")
        class_id, term_id = _scope(write=True, conn=conn)
        run_id = conn.execute(
            '''INSERT INTO comment_generation_runs(
                   class_id, term_id, template_id, comment_type, requested_count,
                   protected_count, missing_count, result_json
               ) VALUES(?,?,?,?,?,?,?,?) RETURNING id''',
            (class_id, term_id, int(template_id), preview['comment_type'],
             preview['summary']['requested'], preview['summary']['protected'],
             preview['summary']['missing'], json.dumps(preview['summary'], ensure_ascii=False)),
        ).fetchone()['id']
        created = updated = 0
        try:
            for row in preview['rows']:
                if row['protected']:
                    continue
                if row['existing_id']:
                    conn.execute(
                        '''UPDATE student_comments SET template_id=?, generation_run_id=?, content=?,
                               source_type='template', source_id=?, is_manually_edited=0,
                               updated_at=datetime('now','localtime') WHERE id=?''',
                        (int(template_id), int(run_id), row['content'], str(template_id), row['existing_id']),
                    )
                    _record_version(row['existing_id'], row['content'], '草稿', 'regenerate', conn=conn)
                    updated += 1
                else:
                    comment_id = conn.execute(
                        '''INSERT INTO student_comments(
                               class_id, term_id, student_id, template_id, generation_run_id,
                               comment_type, content, status, source_type, source_id
                           ) VALUES(?,?,?,?,?,?,?,'草稿','template',?) RETURNING id''',
                        (class_id, term_id, row['student_id'], int(template_id), int(run_id),
                         preview['comment_type'], row['content'], str(template_id)),
                    ).fetchone()['id']
                    _record_version(comment_id, row['content'], '草稿', 'generate', conn=conn)
                    created += 1
            result = {**preview['summary'], 'created': created, 'updated': updated, 'run_id': int(run_id)}
            conn.execute(
                '''UPDATE comment_generation_runs SET created_count=?, updated_count=?, result_json=? WHERE id=?''',
                (created, updated, json.dumps(result, ensure_ascii=False), int(run_id)),
            )
            audit.record('comment_generation', run_id, 'generate', summary='批量生成学生评语草稿',
                         params=result, class_id=class_id, term_id=term_id, conn=conn, commit=False)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return result


def create_comment(*, student_id: int, comment_type: str = '学期评语', content: str,
                   note: str = '', source_type: str = 'manual', conn=None) -> dict:
    conn = _conn(conn)
    content = _text(content)
    if not content:
        raise CommentError('评语内容不能为空')
    comment_type = _comment_type(comment_type)
    _student_row(student_id, write=True, conn=conn)
    class_id, term_id = _scope(write=True, conn=conn)
    if _text(source_type) == 'agent':
        source_type = 'agent'
    else:
        source_type = 'manual'
    manual = int(source_type == 'manual')
    try:
        comment_id = conn.execute(
            '''INSERT INTO student_comments(
                   class_id, term_id, student_id, comment_type, content, status,
                   source_type, is_manually_edited, edited_at, edited_by, note
               ) VALUES(?,?,?,?,?,'草稿',?,?,?,?,?) RETURNING id''',
            (class_id, term_id, int(student_id), comment_type, content, source_type,
             manual, _now() if manual else '', _actor() if manual else '', _text(note)),
        ).fetchone()['id']
        _record_version(comment_id, content, '草稿', 'create', conn=conn)
        audit.record('student_comment', comment_id, 'create', summary='新增学生评语草稿',
                     params={'student_id': student_id, 'comment_type': comment_type, 'source_type': source_type},
                     class_id=class_id, term_id=term_id, conn=conn, commit=False)
        conn.commit()
    except Exception as exc:
        conn.rollback()
        if 'UNIQUE constraint failed' in str(exc):
            raise CommentError('该学生在本学期已有同类型评语') from exc
        raise
    return get_comment(comment_id, conn=conn)


def save_ai_drafts(*, rows: list[dict], comment_type: str = '学期评语', model: str = '',
                   period: dict | None = None, conn=None) -> dict:
    """保存 AI 预览结果为草稿；人工内容和已进入审核流程的记录不会被覆盖。"""
    conn = _conn(conn)
    if not rows:
        raise CommentError('没有可保存的 AI 评语')
    comment_type = _comment_type(comment_type)
    with _write_lock:
        class_id, term_id = _scope(write=True, conn=conn)
        selected = {int(row.get('student_id')) for row in rows if row.get('content')}
        active = {int(row['id']) for row in _active_students(conn=conn)}
        if not selected or not selected.issubset(active):
            raise CommentError('AI评语中包含无效学生')
        payload = {
            'kind': 'ai_comment_generation', 'model': _text(model), 'period': period or {},
            'rows': [{
                'student_id': int(row['student_id']), 'content': _text(row.get('content')),
                'evidence': row.get('evidence', []), 'warnings': row.get('warnings', []),
            } for row in rows if row.get('content')],
        }
        try:
            run_id = conn.execute(
                '''INSERT INTO comment_generation_runs(
                       class_id, term_id, template_id, comment_type, requested_count, result_json
                   ) VALUES(?,?,NULL,?,?,?) RETURNING id''',
                (class_id, term_id, comment_type, len(rows), json.dumps(payload, ensure_ascii=False)),
            ).fetchone()['id']
            created = updated = protected = 0
            for row in rows:
                content = _text(row.get('content'))
                if not content:
                    continue
                student_id = int(row['student_id'])
                current = conn.execute(
                    '''SELECT * FROM student_comments
                       WHERE class_id=? AND term_id=? AND student_id=? AND comment_type=? AND deleted_at='' ''',
                    (class_id, term_id, student_id, comment_type),
                ).fetchone()
                if current:
                    current = dict(current)
                    if current['status'] != '草稿' or int(current['is_manually_edited']):
                        protected += 1
                        continue
                    conn.execute(
                        '''UPDATE student_comments SET content=?, generation_run_id=?, source_type='ai',
                               source_id=?, updated_at=datetime('now','localtime') WHERE id=?''',
                        (content, run_id, _text(model)[:120], int(current['id'])),
                    )
                    _record_version(current['id'], content, '草稿', 'ai_generate', conn=conn)
                    updated += 1
                else:
                    comment_id = conn.execute(
                        '''INSERT INTO student_comments(
                               class_id, term_id, student_id, generation_run_id, comment_type, content,
                               status, source_type, source_id
                           ) VALUES(?,?,?,?,?,?,'草稿','ai',?) RETURNING id''',
                        (class_id, term_id, student_id, run_id, comment_type, content, _text(model)[:120]),
                    ).fetchone()['id']
                    _record_version(comment_id, content, '草稿', 'ai_generate', conn=conn)
                    created += 1
            result = {'run_id': int(run_id), 'created': created, 'updated': updated, 'protected': protected,
                      'generated': created + updated, 'requested': len(rows)}
            conn.execute(
                '''UPDATE comment_generation_runs SET created_count=?, updated_count=?, protected_count=?
                   WHERE id=?''', (created, updated, protected, run_id),
            )
            audit.record('comment_generation', run_id, 'ai_generate', summary='AI生成学生评语草稿',
                         params={'requested': len(rows), 'created': created, 'updated': updated,
                                 'protected': protected, 'model': _text(model)[:120]},
                         class_id=class_id, term_id=term_id, conn=conn, commit=False)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return result


def update_comment(comment_id: int, *, content: str | None = None, note: str | None = None,
                   conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        current = _comment_row(comment_id, write=True, conn=conn)
        if current['status'] != '草稿':
            raise CommentError('只有草稿可以编辑；待审核评语请先退回草稿')
        next_content = _text(content) if content is not None else current['content']
        if not next_content:
            raise CommentError('评语内容不能为空')
        next_note = _text(note) if note is not None else current['note']
        now = _now()
        conn.execute(
            '''UPDATE student_comments SET content=?, note=?, is_manually_edited=1,
                   edited_at=?, edited_by=?, updated_at=datetime('now','localtime') WHERE id=?''',
            (next_content, next_note, now, _actor(), int(comment_id)),
        )
        _record_version(comment_id, next_content, '草稿', 'manual_edit', next_note, conn=conn)
        audit.record('student_comment', comment_id, 'update', summary='人工修改学生评语',
                     params={'student_id': current['student_id'], 'comment_type': current['comment_type']},
                     conn=conn, commit=False)
        conn.commit()
    return get_comment(comment_id, conn=conn)


def transition_comment(comment_id: int, target_status: str, *, note: str = '',
                       delivery_method: str = '', conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        current = _comment_row(comment_id, write=True, conn=conn)
        target = _status(target_status)
        if target not in STATUS_TRANSITIONS[current['status']]:
            raise CommentError(f"评语不能从“{current['status']}”直接变为“{target}”")
        now = _now()
        fields = ['status=?', "updated_at=datetime('now','localtime')"]
        params: list = [target]
        if target == '完成':
            fields.extend(['reviewed_at=?', 'reviewed_by=?', 'review_note=?'])
            params.extend([now, _actor(), _text(note)])
        elif target == '已发送':
            method = _text(delivery_method)
            if not method:
                raise CommentError('标记已发送时必须填写交付方式')
            fields.extend(['sent_at=?', 'delivery_method=?'])
            params.extend([now, method])
        elif target == '草稿':
            fields.extend(["reviewed_at=''", "reviewed_by=''", 'review_note=?'])
            params.append(_text(note))
        params.append(int(comment_id))
        conn.execute(f"UPDATE student_comments SET {', '.join(fields)} WHERE id=?", tuple(params))
        _record_version(comment_id, current['content'], target, 'status', note, conn=conn)
        audit.record('student_comment', comment_id, 'transition', summary=f"评语状态：{current['status']} → {target}",
                     params={'from': current['status'], 'to': target, 'note': note,
                             'delivery_method': delivery_method}, conn=conn, commit=False)
        conn.commit()
    return get_comment(comment_id, conn=conn)


def summary(*, conn=None) -> dict:
    conn = _conn(conn)
    ensure_legacy_migrated(conn=conn)
    class_id, term_id = _scope(conn=conn)
    counts = {status: 0 for status in COMMENT_STATUSES}
    for row in conn.execute(
        '''SELECT status, COUNT(*) AS count FROM student_comments
           WHERE class_id=? AND term_id=? AND deleted_at='' GROUP BY status''',
        (class_id, term_id),
    ).fetchall():
        counts[row['status']] = int(row['count'])
    counts['total'] = sum(counts.values())
    student_count = len(_active_students(conn=conn))
    term_comment_count = int(conn.execute(
        '''SELECT COUNT(*) FROM student_comments
           WHERE class_id=? AND term_id=? AND comment_type='学期评语' AND deleted_at='' ''',
        (class_id, term_id),
    ).fetchone()[0])
    generated_student_ids = [int(row['student_id']) for row in conn.execute(
        '''SELECT DISTINCT student_id FROM student_comments
           WHERE class_id=? AND term_id=? AND comment_type='学期评语' AND deleted_at='' ''',
        (class_id, term_id),
    ).fetchall()]
    return {
        'counts': counts,
        'coverage': {
            'student_count': student_count,
            'generated_count': term_comment_count,
            'missing_count': max(0, student_count - term_comment_count),
            'completion_rate': round(term_comment_count / student_count * 100, 1) if student_count else 0,
            'generated_student_ids': generated_student_ids,
        },
        'templates': list_templates(conn=conn),
        'migration': migration_report(conn=conn),
        'variables': variable_catalog(),
        'students': [
            {'id': int(item['id']), '学号': item['学号'] or '', '姓名': item['姓名'] or ''}
            for item in _active_students(conn=conn)
        ],
    }


def student_comment_summary(student_id: int, *, conn=None) -> dict:
    conn = _conn(conn)
    _student_row(student_id, conn=conn)
    rows = list_comments(student_id=student_id, limit=100, conn=conn)
    latest = max(
        rows,
        key=lambda item: (str(item.get('updated_at') or item.get('created_at') or ''), int(item['id'])),
        default=None,
    )
    return {'comments': rows, 'latest': latest}


def evaluate_startup(*, conn=None):
    return ensure_legacy_migrated(conn=conn)


def export_rows(*, status: str = '', comment_type: str = '', conn=None) -> list[list]:
    rows = list_comments(status=status, comment_type=comment_type, limit=5000, conn=conn)
    return [[
        item.get('学号', ''), item.get('student_name', ''), item.get('comment_type', ''),
        item.get('content', ''), item.get('status', ''), item.get('template_name', ''),
        '是' if item.get('is_manually_edited') else '否', item.get('reviewed_at', ''),
        item.get('reviewed_by', ''), item.get('review_note', ''), item.get('sent_at', ''),
        item.get('delivery_method', ''), item.get('note', ''), item.get('source_label', ''),
    ] for item in rows]
