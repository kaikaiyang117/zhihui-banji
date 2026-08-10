# -*- coding: utf-8 -*-
"""行为积分流水、规则命中和旧快照迁移服务。"""
from __future__ import annotations

from datetime import date, datetime, timedelta
import json
import threading

from .. import clock, db
from . import audit, class_context


POINT_STATUSES = {'有效', '已撤销'}
RULE_METRICS = {'周期扣分', '周期总分低于'}
PRIORITIES = {'普通', '重要', '紧急'}
_write_lock = threading.RLock()


class PointsError(ValueError):
    pass


def _conn(conn=None):
    return conn or db.get_conn()


def _text(value) -> str:
    return str(value or '').strip()


def _number(value, *, allow_zero: bool = True) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    if result != result or result in (float('inf'), float('-inf')):
        return None
    if not allow_zero and result == 0:
        return None
    return result


def _amount(value):
    number = _number(value)
    if number is None:
        return None
    return int(number) if number.is_integer() else round(number, 2)


def _date(value: str, label: str = '日期', default_today: bool = False) -> str:
    text = _text(value)[:10] or (clock.today().isoformat() if default_today else '')
    try:
        return date.fromisoformat(text).isoformat()
    except (TypeError, ValueError) as exc:
        raise PointsError(f'{label}格式不正确，应为 YYYY-MM-DD') from exc


def _scope(*, write: bool = False, conn=None):
    return class_context.scope_ids(write=write, conn=_conn(conn))


def _period_key(occurred_at: str) -> str:
    current = date.fromisoformat(_date(occurred_at))
    iso = current.isocalendar()
    return f'{iso.year}-W{iso.week:02d}'


def academic_year_label(reference: date | None = None) -> str:
    current = reference or clock.today()
    start_year = current.year if current.month >= 9 else current.year - 1
    return f'{start_year}-{start_year + 1}'


def academic_year_range(value: str = '', *, reference: date | None = None) -> tuple[str, date, date]:
    label = _text(value) or academic_year_label(reference)
    parts = label.split('-')
    try:
        start_year, end_year = int(parts[0]), int(parts[1])
        if len(parts) != 2 or end_year != start_year + 1:
            raise ValueError
        start = date(start_year, 9, 1)
        end = date(end_year, 8, 31)
    except (IndexError, TypeError, ValueError) as exc:
        raise PointsError('学年格式不正确，应为 YYYY-YYYY') from exc
    return label, start, end


def _academic_years(*, class_id: int, conn) -> list[str]:
    years = {academic_year_label(clock.today())}
    rows = conn.execute(
        "SELECT occurred_at FROM point_ledger WHERE class_id=? AND occurred_at<>''",
        (class_id,),
    ).fetchall()
    for row in rows:
        try:
            years.add(academic_year_label(date.fromisoformat(row['occurred_at'][:10])))
        except (TypeError, ValueError):
            continue
    return sorted(years, reverse=True)


def _serialize(row: dict) -> dict:
    item = dict(row)
    amount = _amount(item.get('amount'))
    item['amount'] = amount
    item['student_name'] = item.get('student_name') or item.get('姓名') or ''
    item['rule_name'] = item.get('rule_name') or ''
    item['source_label'] = '旧版积分快照' if item.get('source_type') == 'legacy_sheet' else '手工记录'
    return item


def _active_students(*, conn):
    class_id, term_id = _scope(conn=conn)
    return [dict(row) for row in conn.execute(
        '''SELECT s.id, s.学号, s.姓名
           FROM students s JOIN student_enrollments e ON e.student_id=s.id
           WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
           ORDER BY s.学号, s.id''', (class_id, term_id)).fetchall()]


def _ensure_student(student_id: int, *, write: bool = False, conn=None):
    try:
        return class_context.ensure_student_in_scope(student_id, write=write, conn=_conn(conn))
    except class_context.ArchivedScopeError:
        raise
    except class_context.ScopeError as exc:
        raise PointsError(str(exc)) from exc


def migrate_legacy_rows(*, conn=None) -> dict:
    """将旧版每周快照拆成带稳定 student_id 的历史流水，且只执行一次。"""
    conn = _conn(conn)
    with _write_lock:
        class_id, term_id = _scope(write=True, conn=conn)
        existing = conn.execute(
            '''SELECT * FROM point_migration_runs
               WHERE class_id=? AND term_id=? AND source_sheet=? AND source_version=?''',
            (class_id, term_id, '日常行为积分', 'v1'),
        ).fetchone()
        if existing:
            result = dict(existing)
            result['report'] = json.loads(result.get('report') or '{}')
            return result

        rows = conn.execute(
            '''SELECT row_no, data FROM sheet_rows
               WHERE sheet=? AND class_id=? AND term_id=? AND deleted_at=''
               ORDER BY row_no''', ('日常行为积分', class_id, term_id),
        ).fetchall()
        students = {
            _text(row['学号']): int(row['id']) for row in conn.execute(
                '''SELECT s.id, s.学号 FROM students s
                   JOIN student_enrollments e ON e.student_id=s.id
                   WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at='' ''',
                (class_id, term_id),
            ).fetchall() if _text(row['学号'])
        }
        imported = 0
        skipped = 0
        skipped_reasons: dict[str, int] = {}
        for row in rows:
            try:
                data = json.loads(row['data'])
            except (TypeError, ValueError):
                data = []
            xh = _text(data[0] if len(data) > 0 else '')
            student_id = students.get(xh)
            if not student_id:
                skipped += 1
                skipped_reasons['学号不在当前班级'] = skipped_reasons.get('学号不在当前班级', 0) + 1
                continue
            for week in range(8):
                amount = _amount(data[week + 2] if len(data) > week + 2 else None)
                if amount is None or amount == 0:
                    continue
                source_key = f'legacy-sheet:{row["row_no"]}:w{week + 1}'
                inserted = conn.execute(
                    '''INSERT OR IGNORE INTO point_ledger(
                           class_id, term_id, student_id, occurred_at, period_key,
                           amount, category, reason, source_type, source_id, source_key
                       ) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
                    (class_id, term_id, student_id, '', f'legacy-W{week + 1}', amount,
                     '历史积分', f'旧版日常行为积分第{week + 1}周', 'legacy_sheet',
                     str(row['row_no']), source_key),
                )
                imported += int(inserted.rowcount or 0)

        report = {
            'source_rows': len(rows), 'imported_entries': imported,
            'skipped_entries': skipped, 'skipped_reasons': skipped_reasons,
            'legacy_sheet_retained': True,
        }
        run_id = conn.execute(
            '''INSERT INTO point_migration_runs(
                   class_id, term_id, source_sheet, source_version,
                   source_rows, imported_entries, skipped_entries, report
               ) VALUES(?,?,?,?,?,?,?,?)''',
            (class_id, term_id, '日常行为积分', 'v1', len(rows), imported, skipped,
             json.dumps(report, ensure_ascii=False)),
        ).lastrowid
        audit.record(
            'point_migration', run_id, 'migrate', summary='迁移旧版行为积分快照',
            params=report, class_id=class_id, term_id=term_id, conn=conn, commit=False,
        )
        conn.commit()
        result = dict(conn.execute(
            'SELECT * FROM point_migration_runs WHERE id=?', (run_id,)).fetchone())
        result['report'] = report
        return result


def ensure_legacy_migrated(*, conn=None) -> dict | None:
    conn = _conn(conn)
    scope = class_context.get_current_scope(conn=conn)
    if scope['class_status'] == '已归档' or scope['term_status'] == '已归档':
        row = conn.execute(
            '''SELECT * FROM point_migration_runs WHERE class_id=? AND term_id=?
               AND source_sheet=? AND source_version=?''',
            (scope['class_id'], scope['term_id'], '日常行为积分', 'v1'),
        ).fetchone()
        return dict(row) if row else None
    return migrate_legacy_rows(conn=conn)


def migration_report(*, conn=None) -> dict | None:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    row = conn.execute(
        '''SELECT * FROM point_migration_runs WHERE class_id=? AND term_id=?
           AND source_sheet=? AND source_version=?''',
        (class_id, term_id, '日常行为积分', 'v1'),
    ).fetchone()
    if not row:
        return None
    item = dict(row)
    item['report'] = json.loads(item.get('report') or '{}')
    return item


def create_entry(*, student_id: int, amount, occurred_at: str = '', category: str = '日常行为',
                 reason: str = '', rule_id: int | None = None, source_type: str = 'manual',
                 source_id: str = '', source_key: str = '', created_by: str = '班主任', conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        class_id, term_id = _scope(write=True, conn=conn)
        amount = _amount(amount)
        if amount is None or amount == 0:
            raise PointsError('积分分值必须是非零数字')
        occurred_at = _date(occurred_at, default_today=True)
        category = _text(category) or '日常行为'
        reason = _text(reason)
        if not reason:
            raise PointsError('积分原因不能为空')
        _ensure_student(student_id, write=True, conn=conn)
        if rule_id is not None:
            _rule(rule_id, conn=conn)
        period_key = _period_key(occurred_at)
        try:
            row = conn.execute(
                '''INSERT INTO point_ledger(
                       class_id, term_id, student_id, rule_id, occurred_at, period_key,
                       amount, category, reason, source_type, source_id, source_key, created_by
                   ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id''',
                (class_id, term_id, int(student_id), rule_id, occurred_at, period_key,
                 amount, category, reason, _text(source_type) or 'manual', _text(source_id),
                 _text(source_key), _text(created_by) or '班主任'),
            ).fetchone()
            entry_id = int(row['id'])
            audit.record(
                'point_ledger', entry_id, 'create', summary=f'新增行为积分：{amount:g}',
                params={'student_id': student_id, 'amount': amount, 'category': category,
                        'reason': reason, 'occurred_at': occurred_at},
                class_id=class_id, term_id=term_id, conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return get_entry(entry_id, conn=conn)


def get_entry(entry_id: int, *, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    row = conn.execute(
        '''SELECT p.*, s.学号, s.姓名, r.name AS rule_name
           FROM point_ledger p JOIN students s ON s.id=p.student_id
           LEFT JOIN point_rules r ON r.id=p.rule_id
           WHERE p.id=? AND p.class_id=? AND p.term_id=? AND s.deleted_at='' ''',
        (int(entry_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise PointsError('积分流水不存在')
    return _serialize(dict(row))


def list_entries(*, student_id: int | None = None, date_from: str = '', date_to: str = '',
                 status: str = '', academic_year: str = '', include_legacy: bool = True,
                 limit: int = 500, conn=None) -> list[dict]:
    conn = _conn(conn)
    ensure_legacy_migrated(conn=conn)
    scope = class_context.get_current_scope(conn=conn)
    class_id, term_id = int(scope['class_id']), int(scope['term_id'])
    where = ["p.class_id=?", "p.status IN ('有效','已撤销')", "s.deleted_at='' "]
    params: list = [class_id]
    if academic_year:
        _, period_start, period_end = academic_year_range(academic_year)
        where.extend(['p.occurred_at>=?', 'p.occurred_at<=?'])
        params.extend((period_start.isoformat(), period_end.isoformat()))
    else:
        where.append('p.term_id=?')
        params.append(term_id)
    if student_id:
        _ensure_student(student_id, conn=conn)
        where.append('p.student_id=?')
        params.append(int(student_id))
    if date_from:
        where.append("(p.occurred_at='' OR p.occurred_at>=?)" if include_legacy else 'p.occurred_at>=?')
        params.append(_date(date_from, '开始日期'))
    if date_to:
        where.append("(p.occurred_at='' OR p.occurred_at<=?)" if include_legacy else 'p.occurred_at<=?')
        params.append(_date(date_to, '结束日期'))
    if status:
        if status not in POINT_STATUSES:
            raise PointsError('积分流水状态不合法')
        where.append('p.status=?')
        params.append(status)
    if not include_legacy:
        where.append("p.source_type<>'legacy_sheet'")
    rows = conn.execute(
        '''SELECT p.*, s.学号, s.姓名, r.name AS rule_name,
                  t.name AS term_name, t.status AS term_status
           FROM point_ledger p JOIN students s ON s.id=p.student_id
           JOIN terms t ON t.id=p.term_id
           LEFT JOIN point_rules r ON r.id=p.rule_id
           WHERE ''' + ' AND '.join(where) +
        ' ORDER BY CASE WHEN p.occurred_at=\'\' THEN 0 ELSE 1 END, p.occurred_at DESC, p.id DESC LIMIT ?',
        (*params, max(1, min(int(limit), 5_000))),
    ).fetchall()
    result = []
    for row in rows:
        item = _serialize(dict(row))
        item['can_revoke'] = (
            int(item.get('term_id') or 0) == term_id and
            scope['term_status'] != '已归档' and scope['class_status'] != '已归档'
        )
        result.append(item)
    return result


def revoke_entry(entry_id: int, reason: str, *, conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        current = get_entry(entry_id, conn=conn)
        reason = _text(reason)
        if not reason:
            raise PointsError('撤销积分必须填写原因')
        if current['status'] == '已撤销':
            return current
        class_id, term_id = _scope(write=True, conn=conn)
        try:
            conn.execute(
                '''UPDATE point_ledger SET status='已撤销', reversed_at=?, reversal_reason=?,
                       updated_at=datetime('now','localtime')
                   WHERE id=? AND class_id=? AND term_id=? AND status='有效' ''',
                (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), reason,
                 int(entry_id), class_id, term_id),
            )
            audit.record(
                'point_ledger', entry_id, 'revoke', summary='撤销行为积分',
                params={'reason': reason}, class_id=class_id, term_id=term_id,
                conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return get_entry(entry_id, conn=conn)


def _rule(rule_id: int, *, write: bool = False, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=write, conn=conn)
    row = conn.execute(
        "SELECT * FROM point_rules WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (int(rule_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise PointsError('积分规则不存在')
    return dict(row)


def list_rules(*, include_disabled: bool = False, conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    where = ["class_id=?", "term_id=?", "deleted_at='' "]
    params: list = [class_id, term_id]
    if not include_disabled:
        where.append('enabled=1')
    return [dict(row) for row in conn.execute(
        'SELECT * FROM point_rules WHERE ' + ' AND '.join(where) +
        ' ORDER BY enabled DESC, name, id', tuple(params)).fetchall()]


def create_rule(*, name: str, category: str = '日常行为', metric: str = '周期扣分',
                threshold=5, period_days: int = 7, priority: str = '重要',
                enabled: bool = True, conn=None) -> dict:
    conn = _conn(conn)
    name = _text(name)
    threshold = _number(threshold, allow_zero=False)
    if not name:
        raise PointsError('规则名称不能为空')
    if metric not in RULE_METRICS:
        raise PointsError('积分规则指标不合法')
    if threshold is None or threshold <= 0:
        raise PointsError('阈值必须是正数')
    if int(period_days) < 1 or int(period_days) > 365:
        raise PointsError('规则周期必须在 1 到 365 天之间')
    if priority not in PRIORITIES:
        raise PointsError('优先级不合法')
    class_id, term_id = _scope(write=True, conn=conn)
    try:
        rule_id = conn.execute(
            '''INSERT INTO point_rules(
                   class_id, term_id, name, category, metric, threshold, period_days, priority, enabled
               ) VALUES(?,?,?,?,?,?,?,?,?)''',
            (class_id, term_id, name, _text(category) or '日常行为', metric, threshold,
             int(period_days), priority, int(bool(enabled))),
        ).lastrowid
        audit.record(
            'point_rule', rule_id, 'create', summary=f'新增积分规则：{name}',
            params={'metric': metric, 'threshold': threshold, 'period_days': period_days},
            class_id=class_id, term_id=term_id, conn=conn, commit=False,
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _rule(rule_id, conn=conn)


def update_rule(rule_id: int, *, enabled: bool | None = None, threshold=None,
                period_days: int | None = None, priority: str | None = None,
                category: str | None = None, conn=None) -> dict:
    conn = _conn(conn)
    current = _rule(rule_id, write=True, conn=conn)
    values = {
        'enabled': int(bool(enabled)) if enabled is not None else current['enabled'],
        'threshold': _number(threshold, allow_zero=False) if threshold is not None else current['threshold'],
        'period_days': int(period_days) if period_days is not None else current['period_days'],
        'priority': priority if priority is not None else current['priority'],
        'category': _text(category) if category is not None else current['category'],
    }
    if values['threshold'] is None or values['threshold'] <= 0:
        raise PointsError('阈值必须是正数')
    if not 1 <= values['period_days'] <= 365:
        raise PointsError('规则周期必须在 1 到 365 天之间')
    if values['priority'] not in PRIORITIES:
        raise PointsError('优先级不合法')
    class_id, term_id = _scope(write=True, conn=conn)
    try:
        conn.execute(
            '''UPDATE point_rules SET enabled=?, threshold=?, period_days=?, priority=?, category=?,
                   updated_at=datetime('now','localtime') WHERE id=? AND class_id=? AND term_id=?''',
            (values['enabled'], values['threshold'], values['period_days'], values['priority'],
             values['category'], int(rule_id), class_id, term_id),
        )
        audit.record('point_rule', rule_id, 'update', summary=f"更新积分规则：{current['name']}",
                     params=values, class_id=class_id, term_id=term_id, conn=conn, commit=False)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _rule(rule_id, conn=conn)


def _period_total(conn, student_id: int, start: str, end: str) -> float:
    row = conn.execute(
        '''SELECT COALESCE(SUM(amount), 0) AS total FROM point_ledger
           WHERE class_id=? AND term_id=? AND student_id=? AND status='有效'
             AND occurred_at<>'' AND occurred_at>=? AND occurred_at<=?''',
        (*_scope(conn=conn), int(student_id), start, end),
    ).fetchone()
    return float(row['total'] or 0)


def _rule_hit(rule: dict, value: float) -> bool:
    if rule['metric'] == '周期扣分':
        return value <= -float(rule['threshold'])
    if rule['metric'] == '周期总分低于':
        return value < float(rule['threshold'])
    return False


def _ensure_hit_work_item(hit_id: int, rule: dict, student_id: int, period_end: str,
                          value: float, *, conn):
    from . import work_items
    task = work_items.ensure_source_work_item(
        title=f'积分异常 · {rule["name"]}', student_id=student_id,
        source_type='point_rule', source_id=hit_id, source_label='积分规则',
        scheduled_at=period_end, due_at=period_end, priority=rule['priority'],
        notes=f'周期值 {value:g}，阈值 {rule["threshold"]:g}', conn=conn, commit=False)
    conn.execute('UPDATE point_rule_hits SET task_id=? WHERE id=?', (task['id'], hit_id))


def evaluate_rules(*, reference_date: str = '', trigger: str = 'manual', conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        class_id, term_id = _scope(write=True, conn=conn)
        reference = date.fromisoformat(_date(reference_date, default_today=True))
        rules = list_rules(conn=conn)
        students = _active_students(conn=conn)
        created_count = 0
        resolved_count = 0
        try:
            run_id = conn.execute(
                '''INSERT INTO point_rule_runs(class_id, term_id, reference_date)
                   VALUES(?,?,?)''', (class_id, term_id, reference.isoformat()),
            ).lastrowid
            for rule in rules:
                start = reference - timedelta(days=int(rule['period_days']) - 1)
                end = reference
                for student in students:
                    value = _period_total(conn, student['id'], start.isoformat(), end.isoformat())
                    existing = conn.execute(
                        '''SELECT * FROM point_rule_hits
                           WHERE rule_id=? AND student_id=? AND period_start=? AND period_end=?''',
                        (rule['id'], student['id'], start.isoformat(), end.isoformat()),
                    ).fetchone()
                    hit = _rule_hit(rule, value)
                    if hit and not existing:
                        hit_id = conn.execute(
                            '''INSERT INTO point_rule_hits(
                                   run_id, rule_id, class_id, term_id, student_id,
                                   period_start, period_end, value, threshold, status
                               ) VALUES(?,?,?,?,?,?,?,?,?,?)''',
                            (run_id, rule['id'], class_id, term_id, student['id'],
                             start.isoformat(), end.isoformat(), value, rule['threshold'], '新命中'),
                        ).lastrowid
                        _ensure_hit_work_item(hit_id, rule, student['id'], end.isoformat(), value, conn=conn)
                        created_count += 1
                    elif hit and existing and existing['status'] == '已解除':
                        conn.execute(
                            '''UPDATE point_rule_hits SET run_id=?, value=?, threshold=?, status='新命中',
                                   resolved_at='', updated_at=datetime('now','localtime') WHERE id=?''',
                            (run_id, value, rule['threshold'], existing['id']),
                        )
                        _ensure_hit_work_item(existing['id'], rule, student['id'], end.isoformat(), value, conn=conn)
                        created_count += 1
                    elif not hit and existing and existing['status'] in {'新命中', '已处理'}:
                        conn.execute(
                            '''UPDATE point_rule_hits SET run_id=?, value=?, status='已解除',
                                   resolved_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
                               WHERE id=?''', (run_id, value, existing['id']),
                        )
                        if existing['task_id']:
                            from . import work_items
                            try:
                                work_items.update_work_item(
                                    existing['task_id'], status='已完成', result='积分异常条件已解除',
                                    conn=conn, commit=False, sync_source=False)
                            except work_items.WorkItemError:
                                pass
                        resolved_count += 1
            conn.execute(
                'UPDATE point_rule_runs SET created_count=?, resolved_count=? WHERE id=?',
                (created_count, resolved_count, run_id),
            )
            audit.record(
                'point_rule_run', run_id, 'evaluate', summary=f'检查积分规则：新增 {created_count} 项',
                params={'trigger': trigger, 'created_count': created_count, 'resolved_count': resolved_count},
                class_id=class_id, term_id=term_id, conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {'run_id': int(run_id), 'reference_date': reference.isoformat(),
            'created_count': created_count, 'resolved_count': resolved_count}


def evaluate_startup(*, conn=None) -> dict:
    conn = _conn(conn)
    if not list_rules(conn=conn):
        return {'created_count': 0, 'resolved_count': 0}
    return evaluate_rules(trigger='startup', conn=conn)


def list_rule_hits(*, status: str = '', limit: int = 200, conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    where = ['h.class_id=?', 'h.term_id=?', "s.deleted_at='' "]
    params: list = [class_id, term_id]
    if status:
        if status not in {'新命中', '已处理', '已解除'}:
            raise PointsError('规则命中状态不合法')
        where.append('h.status=?')
        params.append(status)
    return [dict(row) for row in conn.execute(
        '''SELECT h.*, s.学号, s.姓名, r.name AS rule_name, r.priority
           FROM point_rule_hits h JOIN students s ON s.id=h.student_id
           JOIN point_rules r ON r.id=h.rule_id WHERE ''' + ' AND '.join(where) +
        ' ORDER BY CASE WHEN h.status=\'新命中\' THEN 0 ELSE 1 END, h.period_end DESC, h.id DESC LIMIT ?',
        (*params, max(1, min(int(limit), 5_000))),
    ).fetchall()]


def on_work_item_transition(conn, before: dict, next_status: str, result: str):
    hit_id = before.get('source_id')
    if before.get('source_type') != 'point_rule' or not hit_id:
        return
    hit = conn.execute(
        "SELECT * FROM point_rule_hits WHERE id=? AND class_id=? AND term_id=?",
        (int(hit_id), before['class_id'], before['term_id']),
    ).fetchone()
    if not hit:
        return
    if next_status == '已完成':
        conn.execute(
            "UPDATE point_rule_hits SET status='已处理', updated_at=datetime('now','localtime') WHERE id=?",
            (int(hit_id),),
        )
    elif next_status not in {'已取消'}:
        conn.execute(
            "UPDATE point_rule_hits SET status='新命中', resolved_at='', updated_at=datetime('now','localtime') WHERE id=?",
            (int(hit_id),),
        )


def _period_buckets(reference: date, count: int = 8):
    monday = reference - timedelta(days=reference.weekday())
    return [(monday - timedelta(weeks=count - index - 1), monday - timedelta(weeks=count - index - 2) - timedelta(days=1))
            for index in range(count)]


def _month_buckets(start: date, count: int = 12):
    buckets = []
    for offset in range(count):
        year = start.year + (start.month - 1 + offset) // 12
        month = (start.month - 1 + offset) % 12 + 1
        first = date(year, month, 1)
        if month == 12:
            next_first = date(year + 1, 1, 1)
        else:
            next_first = date(year, month + 1, 1)
        buckets.append((first, next_first - timedelta(days=1)))
    return buckets


def _summary_for_student(student: dict, entries: list[dict], *, reference: date,
                         period_start: date | None = None, period_end: date | None = None,
                         count: int = 8) -> dict:
    valid = [item for item in entries if item['status'] == '有效']
    if period_start and period_end:
        valid = [item for item in valid if item.get('occurred_at') and
                 period_start.isoformat() <= item['occurred_at'][:10] <= period_end.isoformat()]
    total = sum(float(item['amount'] or 0) for item in valid)
    buckets = _period_buckets(reference, count)
    weekly = []
    dated = [item for item in valid if item.get('occurred_at')]
    for start, end in buckets:
        weekly.append(_amount(sum(
            float(item['amount'] or 0) for item in dated
            if start.isoformat() <= item['occurred_at'][:10] <= end.isoformat())) or 0)
    if not dated:
        legacy = {int(item['period_key'].split('-W')[-1]): item['amount']
                  for item in valid if item.get('period_key', '').startswith('legacy-W')}
        weekly = [_amount(legacy.get(index, 0)) or 0 for index in range(1, count + 1)]
    positive_total = sum(float(item['amount'] or 0) for item in valid if float(item['amount'] or 0) > 0)
    negative_total = sum(float(item['amount'] or 0) for item in valid if float(item['amount'] or 0) < 0)
    monthly = []
    if period_start and period_end:
        for start, end in _month_buckets(period_start):
            monthly.append(_amount(sum(
                float(item['amount'] or 0) for item in valid
                if item.get('occurred_at') and start.isoformat() <= item['occurred_at'][:10] <= end.isoformat())) or 0)
    return {
        'student_id': student['id'], '学号': student['学号'], 'name': student['姓名'],
        'weekly': weekly, 'total': _amount(total) or 0,
        'positive_total': _amount(positive_total) or 0,
        'negative_total': _amount(negative_total) or 0,
        'monthly': monthly,
        'entry_count': len(valid), 'revoked_count': len(entries) - len(valid),
    }


def class_summary(*, reference_date: str = '', academic_year: str = '', conn=None) -> dict:
    conn = _conn(conn)
    ensure_legacy_migrated(conn=conn)
    reference = date.fromisoformat(_date(reference_date, default_today=True))
    students = _active_students(conn=conn)
    class_id, term_id = _scope(conn=conn)
    year_label = ''
    period_start = period_end = None
    if academic_year:
        year_label, period_start, period_end = academic_year_range(academic_year, reference=reference)
    else:
        year_label = academic_year_label(reference)
    query = (
        '''SELECT p.*, s.学号, s.姓名 FROM point_ledger p JOIN students s ON s.id=p.student_id
           WHERE p.class_id=? AND s.deleted_at='' '''
    )
    params: list = [class_id]
    if period_start and period_end:
        query += ' AND p.occurred_at>=? AND p.occurred_at<=?'
        params.extend((period_start.isoformat(), period_end.isoformat()))
    else:
        query += ' AND p.term_id=?'
        params.append(term_id)
    rows = [dict(row) for row in conn.execute(
        query, tuple(params),
    ).fetchall()]
    by_student: dict[int, list[dict]] = {}
    for row in rows:
        by_student.setdefault(int(row['student_id']), []).append(_serialize(row))
    summaries = [_summary_for_student(
        student, by_student.get(student['id'], []), reference=reference,
        period_start=period_start, period_end=period_end)
                 for student in students]
    summaries.sort(key=lambda item: (-float(item['total']), item['学号']))
    for index, item in enumerate(summaries, 1):
        item['rank'] = index if item['entry_count'] else None
    valid_rows = [row for row in rows if row['status'] == '有效']
    category_totals: dict[str, dict[str, int]] = {}
    for row in valid_rows:
        category = _text(row.get('category')) or '未分类'
        item = category_totals.setdefault(category, {'category': category, 'total': 0, 'positive': 0, 'negative': 0})
        amount = float(row.get('amount') or 0)
        item['total'] = _amount(item['total'] + amount) or 0
        if amount > 0:
            item['positive'] = _amount(item['positive'] + amount) or 0
        elif amount < 0:
            item['negative'] = _amount(item['negative'] + amount) or 0
    monthly = []
    if period_start and period_end:
        for start, end in _month_buckets(period_start):
            month_rows = [row for row in valid_rows if row.get('occurred_at') and
                          start.isoformat() <= row['occurred_at'][:10] <= end.isoformat()]
            monthly.append({
                'label': f'{start.year}-{start.month:02d}',
                'total': _amount(sum(float(row['amount'] or 0) for row in month_rows)) or 0,
                'positive': _amount(sum(float(row['amount'] or 0) for row in month_rows if float(row['amount'] or 0) > 0)) or 0,
                'negative': _amount(sum(float(row['amount'] or 0) for row in month_rows if float(row['amount'] or 0) < 0)) or 0,
            })
    return {'reference_date': reference.isoformat(), 'academic_year': year_label,
            'academic_year_start': period_start.isoformat() if period_start else '',
            'academic_year_end': period_end.isoformat() if period_end else '',
            'academic_years': _academic_years(class_id=class_id, conn=conn),
            'students': summaries,
            'totals': {
                'valid_entries': len(valid_rows),
                'students_with_entries': sum(1 for item in summaries if item['entry_count']),
                'total': _amount(sum(float(row['amount'] or 0) for row in valid_rows)) or 0,
                'positive': _amount(sum(float(row['amount'] or 0) for row in valid_rows if float(row['amount'] or 0) > 0)) or 0,
                'negative': _amount(sum(float(row['amount'] or 0) for row in valid_rows if float(row['amount'] or 0) < 0)) or 0,
            },
            'monthly': monthly,
            'categories': sorted(category_totals.values(), key=lambda item: (-abs(item['total']), item['category'])),
            'migration': migration_report(conn=conn), 'rules': list_rules(conn=conn),
            'hits': list_rule_hits(status='新命中', conn=conn)}


def student_summary(student_id: int, *, reference_date: str = '', conn=None) -> dict:
    conn = _conn(conn)
    ensure_legacy_migrated(conn=conn)
    students = [student for student in _active_students(conn=conn) if int(student['id']) == int(student_id)]
    if not students:
        raise PointsError('学生不在当前班级和学期')
    class_id, term_id = _scope(conn=conn)
    rows = [dict(row) for row in conn.execute(
        '''SELECT p.*, s.学号, s.姓名 FROM point_ledger p JOIN students s ON s.id=p.student_id
           WHERE p.class_id=? AND p.term_id=? AND p.student_id=? AND s.deleted_at='' ''',
        (class_id, term_id, int(student_id)),
    ).fetchall()]
    reference = date.fromisoformat(_date(reference_date, default_today=True))
    result = _summary_for_student(students[0], [_serialize(row) for row in rows], reference=reference)
    result['entries'] = [_serialize(row) for row in rows]
    return result
