# -*- coding: utf-8 -*-
"""班费分类账、结算、冲正、凭证和旧通用表迁移服务。"""
from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime
import hashlib
import json
import os
from pathlib import Path
import re
import threading
from uuid import uuid4

from .. import db
from . import audit, class_context


DIRECTIONS = {'收入', '支出'}
ENTRY_STATUSES = {'有效', '已撤销', '已冲正'}
SETTLEMENT_STATUSES = {'已结算', '需复核'}
DEFAULT_CATEGORIES = {
    '收入': ('班费收取', '其他收入'),
    '支出': ('教学材料', '活动费用', '日常支出', '其他支出'),
}
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
_write_lock = threading.RLock()


class FundError(ValueError):
    pass


def _conn(conn=None):
    return conn or db.get_conn()


def _text(value) -> str:
    return str(value or '').strip()


def _money(value, *, allow_zero: bool = False) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = round(float(str(value).strip()), 2)
    except (TypeError, ValueError):
        return None
    if result != result or result in (float('inf'), float('-inf')):
        return None
    if not allow_zero and result <= 0:
        return None
    return int(result) if result.is_integer() else result


def _date(value, label: str = '日期', *, required: bool = True, default_today: bool = False) -> str:
    text = _text(value)[:10]
    if not text and default_today:
        text = date.today().isoformat()
    if not text and not required:
        return ''
    try:
        return date.fromisoformat(text).isoformat()
    except (TypeError, ValueError) as exc:
        raise FundError(f'{label}格式不正确，应为 YYYY-MM-DD') from exc


def _scope(*, write: bool = False, conn=None) -> tuple[int, int]:
    return class_context.scope_ids(write=write, conn=_conn(conn))


def _direction(value) -> str:
    text = _text(value)
    if text not in DIRECTIONS:
        raise FundError('收支类型必须是“收入”或“支出”')
    return text


def _period(period_key: str = '', period_start: str = '', period_end: str = '') -> tuple[str, str, str]:
    key = _text(period_key)
    if key:
        if not re.fullmatch(r'\d{4}-\d{2}', key):
            raise FundError('结算月份必须是 YYYY-MM')
        year, month = (int(item) for item in key.split('-'))
        try:
            start = date(year, month, 1)
            end = date(year, month, monthrange(year, month)[1])
        except ValueError as exc:
            raise FundError('结算月份不合法') from exc
        return key, start.isoformat(), end.isoformat()
    start = _date(period_start, '结算开始日期')
    end = _date(period_end, '结算结束日期')
    if start > end:
        raise FundError('结算开始日期不能晚于结束日期')
    return f'{start}_{end}', start, end


def _ensure_category(name: str, direction: str, *, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=True, conn=conn)
    name = _text(name) or ('其他收入' if direction == '收入' else '其他支出')
    row = conn.execute(
        '''SELECT * FROM fund_categories
           WHERE class_id=? AND term_id=? AND name=? AND direction=?''',
        (class_id, term_id, name, direction),
    ).fetchone()
    if row:
        if row['deleted_at'] or not row['enabled']:
            conn.execute(
                "UPDATE fund_categories SET enabled=1, deleted_at='', deleted_by='', updated_at=datetime('now','localtime') WHERE id=?",
                (row['id'],),
            )
            conn.commit()
        return dict(conn.execute('SELECT * FROM fund_categories WHERE id=?', (row['id'],)).fetchone())
    category_id = conn.execute(
        '''INSERT INTO fund_categories(class_id, term_id, name, direction)
           VALUES(?,?,?,?)''', (class_id, term_id, name, direction),
    ).lastrowid
    conn.commit()
    return dict(conn.execute('SELECT * FROM fund_categories WHERE id=?', (category_id,)).fetchone())


def ensure_default_categories(*, conn=None):
    conn = _conn(conn)
    for direction, names in DEFAULT_CATEGORIES.items():
        for name in names:
            _ensure_category(name, direction, conn=conn)


def list_categories(*, include_disabled: bool = False, conn=None) -> list[dict]:
    conn = _conn(conn)
    ensure_default_categories(conn=conn)
    class_id, term_id = _scope(conn=conn)
    where = ['class_id=?', 'term_id=?']
    params: list = [class_id, term_id]
    if not include_disabled:
        where.extend(['enabled=1', "deleted_at=''"])
    return [dict(row) for row in conn.execute(
        'SELECT * FROM fund_categories WHERE ' + ' AND '.join(where) +
        ' ORDER BY direction, name, id', tuple(params),
    ).fetchall()]


def create_category(*, name: str, direction: str, conn=None) -> dict:
    conn = _conn(conn)
    direction = _direction(direction)
    name = _text(name)
    if not name:
        raise FundError('分类名称不能为空')
    category = _ensure_category(name, direction, conn=conn)
    class_id, term_id = _scope(conn=conn)
    audit.record('fund_category', category['id'], 'create', summary=f'新增班费分类：{name}',
                 params={'name': name, 'direction': direction},
                 class_id=class_id, term_id=term_id, conn=conn)
    return category


def update_category(category_id: int, *, name: str | None = None, enabled: bool | None = None,
                    conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=True, conn=conn)
    row = conn.execute(
        'SELECT * FROM fund_categories WHERE id=? AND class_id=? AND term_id=? AND deleted_at=\'\'',
        (int(category_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise FundError('班费分类不存在')
    next_name = _text(name) if name is not None else row['name']
    if not next_name:
        raise FundError('分类名称不能为空')
    next_enabled = int(bool(enabled)) if enabled is not None else int(row['enabled'])
    conn.execute(
        "UPDATE fund_categories SET name=?, enabled=?, updated_at=datetime('now','localtime') WHERE id=?",
        (next_name, next_enabled, int(category_id)),
    )
    audit.record('fund_category', category_id, 'update', summary=f'更新班费分类：{next_name}',
                 params={'name': next_name, 'enabled': bool(next_enabled)},
                 class_id=class_id, term_id=term_id, conn=conn)
    return dict(conn.execute('SELECT * FROM fund_categories WHERE id=?', (int(category_id),)).fetchone())


def _category_for_entry(category_id, category_name: str, direction: str, *, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=True, conn=conn)
    if category_id is not None:
        row = conn.execute(
            '''SELECT * FROM fund_categories
               WHERE id=? AND class_id=? AND term_id=? AND enabled=1 AND deleted_at='' ''',
            (int(category_id), class_id, term_id),
        ).fetchone()
        if not row:
            raise FundError('班费分类不存在、已停用或类型不匹配')
        if row['direction'] != direction:
            raise FundError('收入和支出不能使用相反类型的分类')
        return dict(row)
    return _ensure_category(category_name, direction, conn=conn)


def _entry_row(entry_id: int, *, write: bool = False, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(write=write, conn=conn)
    row = conn.execute(
        '''SELECT f.*, COALESCE(c.name, f.category_name) AS category,
                  s.period_key AS settlement_period, s.status AS settlement_status
           FROM fund_ledger f
           LEFT JOIN fund_categories c ON c.id=f.category_id
           LEFT JOIN fund_settlements s ON s.id=f.settlement_id
           WHERE f.id=? AND f.class_id=? AND f.term_id=?''',
        (int(entry_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise FundError('班费流水不存在')
    return dict(row)


def _serialize(row: dict, *, conn=None) -> dict:
    conn = _conn(conn)
    item = dict(row)
    item['amount'] = _money(item.get('amount'), allow_zero=True) or 0
    item['category'] = item.get('category') or item.get('category_name') or ''
    item['source_label'] = {
        'legacy_sheet': '旧版班费工作表', 'reversal': '冲正流水', 'manual': '手工记录',
    }.get(item.get('source_type'), item.get('source_type') or '')
    item['attachments'] = [dict(attachment) for attachment in conn.execute(
        '''SELECT id, original_name, content_type, size_bytes, created_at
           FROM fund_attachments WHERE ledger_id=? ORDER BY id''', (item['id'],)
    ).fetchall()]
    for attachment in item['attachments']:
        attachment['download_path'] = f"/api/fund/attachments/{attachment['id']}"
    item['attachment_count'] = len(item['attachments'])
    return item


def migrate_legacy_rows(*, conn=None) -> dict:
    """把旧班费通用表按原始行迁入流水，保留旧表作为只读历史来源。"""
    conn = _conn(conn)
    with _write_lock:
        class_id, term_id = _scope(write=True, conn=conn)
        existing = conn.execute(
            '''SELECT * FROM fund_migration_runs
               WHERE class_id=? AND term_id=? AND source_sheet=? AND source_version=?''',
            (class_id, term_id, '班费管理', 'v1'),
        ).fetchone()
        if existing:
            result = dict(existing)
            result['report'] = json.loads(result.get('report') or '{}')
            return result
        rows = conn.execute(
            '''SELECT row_no, data FROM sheet_rows
               WHERE sheet=? AND class_id=? AND term_id=? AND deleted_at=''
               ORDER BY row_no''', ('班费管理', class_id, term_id),
        ).fetchall()
        imported = 0
        skipped = 0
        reasons: dict[str, int] = {}
        for row in rows:
            try:
                data = json.loads(row['data'])
            except (TypeError, ValueError, json.JSONDecodeError):
                data = []
            direction_text = _text(data[1] if len(data) > 1 else '')
            if direction_text not in DIRECTIONS:
                skipped += 1
                reasons['收支类型无效'] = reasons.get('收支类型无效', 0) + 1
                continue
            amount = _money(data[2] if len(data) > 2 else None)
            if amount is None:
                skipped += 1
                reasons['金额无效'] = reasons.get('金额无效', 0) + 1
                continue
            category = '历史收入' if direction_text == '收入' else '历史支出'
            category_row = _ensure_category(category, direction_text, conn=conn)
            occurred_at = _date(data[0] if len(data) > 0 else '', required=False)
            source_key = f'legacy-sheet:{row["row_no"]}'
            inserted = conn.execute(
                '''INSERT OR IGNORE INTO fund_ledger(
                       class_id, term_id, occurred_at, direction, amount,
                       category_id, category_name, description, handler, witness, note,
                       source_type, source_id, source_key
                   ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                (class_id, term_id, occurred_at, direction_text, amount,
                 category_row['id'], category, _text(data[3] if len(data) > 3 else ''),
                 _text(data[4] if len(data) > 4 else ''), _text(data[5] if len(data) > 5 else ''),
                 _text(data[6] if len(data) > 6 else ''), 'legacy_sheet', str(row['row_no']), source_key),
            )
            imported += int(inserted.rowcount or 0)
        report = {
            'source_rows': len(rows), 'imported_entries': imported,
            'skipped_entries': skipped, 'skipped_reasons': reasons,
            'legacy_sheet_retained': True,
        }
        run_id = conn.execute(
            '''INSERT INTO fund_migration_runs(
                   class_id, term_id, source_sheet, source_version,
                   source_rows, imported_entries, skipped_entries, report
               ) VALUES(?,?,?,?,?,?,?,?)''',
            (class_id, term_id, '班费管理', 'v1', len(rows), imported, skipped,
             json.dumps(report, ensure_ascii=False)),
        ).lastrowid
        audit.record('fund_migration', run_id, 'migrate', summary='迁移旧版班费流水',
                     params=report, class_id=class_id, term_id=term_id, conn=conn, commit=False)
        conn.commit()
        result = dict(conn.execute('SELECT * FROM fund_migration_runs WHERE id=?', (run_id,)).fetchone())
        result['report'] = report
        return result


def ensure_legacy_migrated(*, conn=None) -> dict | None:
    conn = _conn(conn)
    scope = class_context.get_current_scope(conn=conn)
    if scope['class_status'] == '已归档' or scope['term_status'] == '已归档':
        row = conn.execute(
            '''SELECT * FROM fund_migration_runs WHERE class_id=? AND term_id=?
               AND source_sheet=? AND source_version=?''',
            (scope['class_id'], scope['term_id'], '班费管理', 'v1'),
        ).fetchone()
        return dict(row) if row else None
    return migrate_legacy_rows(conn=conn)


def migration_report(*, conn=None) -> dict | None:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    row = conn.execute(
        '''SELECT * FROM fund_migration_runs WHERE class_id=? AND term_id=?
           AND source_sheet=? AND source_version=?''',
        (class_id, term_id, '班费管理', 'v1'),
    ).fetchone()
    if not row:
        return None
    item = dict(row)
    item['report'] = json.loads(item.get('report') or '{}')
    return item


def create_entry(*, occurred_at: str = '', direction: str = '支出', amount,
                 category_id: int | None = None, category: str = '', description: str = '',
                 handler: str = '', witness: str = '', note: str = '', source_type: str = 'manual',
                 source_id: str = '', source_key: str = '', created_by: str = '班主任', conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        class_id, term_id = _scope(write=True, conn=conn)
        direction = _direction(direction)
        amount = _money(amount)
        if amount is None:
            raise FundError('金额必须是大于 0 的数字')
        occurred_at = _date(occurred_at, default_today=True)
        description = _text(description)
        if not description:
            raise FundError('用途说明不能为空')
        category_row = _category_for_entry(category_id, category, direction, conn=conn)
        source_key = _text(source_key)
        if source_key and conn.execute(
            'SELECT 1 FROM fund_ledger WHERE class_id=? AND term_id=? AND source_key=?',
            (class_id, term_id, source_key),
        ).fetchone():
            raise FundError('相同来源的班费流水已经存在')
        try:
            entry_id = conn.execute(
                '''INSERT INTO fund_ledger(
                       class_id, term_id, occurred_at, direction, amount,
                       category_id, category_name, description, handler, witness, note,
                       source_type, source_id, source_key, created_by
                   ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id''',
                (class_id, term_id, occurred_at, direction, amount, category_row['id'], category_row['name'],
                 description, _text(handler), _text(witness), _text(note), _text(source_type) or 'manual',
                 _text(source_id), source_key, _text(created_by) or '班主任'),
            ).fetchone()['id']
            audit.record('fund_ledger', entry_id, 'create', summary=f'新增班费{direction}：{amount:g}',
                         params={'direction': direction, 'amount': amount, 'category': category_row['name'],
                                 'description': description, 'occurred_at': occurred_at},
                         class_id=class_id, term_id=term_id, conn=conn, commit=False)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return get_entry(entry_id, conn=conn)


def get_entry(entry_id: int, *, conn=None) -> dict:
    return _serialize(_entry_row(entry_id, conn=conn), conn=conn)


def list_entries(*, date_from: str = '', date_to: str = '', direction: str = '',
                 status: str = '', category: str = '', limit: int = 500, conn=None) -> list[dict]:
    conn = _conn(conn)
    ensure_legacy_migrated(conn=conn)
    class_id, term_id = _scope(conn=conn)
    where = ['f.class_id=?', 'f.term_id=?']
    params: list = [class_id, term_id]
    if date_from:
        where.append("(f.occurred_at>=? AND f.occurred_at<>'')")
        params.append(_date(date_from, '开始日期'))
    if date_to:
        where.append("(f.occurred_at<=? AND f.occurred_at<>'')")
        params.append(_date(date_to, '结束日期'))
    if direction:
        where.append('f.direction=?')
        params.append(_direction(direction))
    if status:
        if status not in ENTRY_STATUSES:
            raise FundError('班费流水状态不合法')
        where.append('f.status=?')
        params.append(status)
    if category:
        where.append('COALESCE(c.name, f.category_name)=?')
        params.append(_text(category))
    params.append(max(1, min(int(limit), 5000)))
    rows = conn.execute(
        '''SELECT f.*, COALESCE(c.name, f.category_name) AS category,
                  s.period_key AS settlement_period, s.status AS settlement_status
           FROM fund_ledger f
           LEFT JOIN fund_categories c ON c.id=f.category_id
           LEFT JOIN fund_settlements s ON s.id=f.settlement_id
           WHERE ''' + ' AND '.join(where) +
        ' ORDER BY CASE WHEN f.occurred_at=\'\' THEN 1 ELSE 0 END, f.occurred_at DESC, f.id DESC LIMIT ?',
        tuple(params),
    ).fetchall()
    return [_serialize(dict(row), conn=conn) for row in rows]


def update_entry(entry_id: int, *, occurred_at: str | None = None, direction: str | None = None,
                 amount=None, category_id: int | None = None, category: str | None = None,
                 description: str | None = None, handler: str | None = None,
                 witness: str | None = None, note: str | None = None, conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        current = _entry_row(entry_id, write=True, conn=conn)
        if current['status'] != '有效':
            raise FundError('只有有效流水可以修改')
        if current['settlement_id']:
            raise FundError('已结算流水不能直接修改，请使用冲正或撤销')
        next_direction = _direction(direction) if direction is not None else current['direction']
        next_amount = _money(amount) if amount is not None else current['amount']
        if next_amount is None:
            raise FundError('金额必须是大于 0 的数字')
        next_date = _date(occurred_at, default_today=False) if occurred_at is not None else current['occurred_at']
        if not next_date:
            raise FundError('日期不能为空')
        next_description = _text(description) if description is not None else current['description']
        if not next_description:
            raise FundError('用途说明不能为空')
        category_row = _category_for_entry(
            category_id, category if category is not None else current['category'], next_direction, conn=conn)
        values = (
            next_date, next_direction, next_amount, category_row['id'], category_row['name'], next_description,
            _text(handler) if handler is not None else current['handler'],
            _text(witness) if witness is not None else current['witness'],
            _text(note) if note is not None else current['note'], int(entry_id),
        )
        conn.execute(
            '''UPDATE fund_ledger SET occurred_at=?, direction=?, amount=?, category_id=?, category_name=?,
               description=?, handler=?, witness=?, note=?, updated_at=datetime('now','localtime') WHERE id=?''',
            values,
        )
        audit.record('fund_ledger', entry_id, 'update', summary='修改班费流水',
                     params={'direction': next_direction, 'amount': next_amount, 'category': category_row['name']},
                     conn=conn)
    return get_entry(entry_id, conn=conn)


def revoke_entry(entry_id: int, reason: str, *, conn=None) -> dict:
    conn = _conn(conn)
    reason = _text(reason)
    if not reason:
        raise FundError('撤销原因不能为空')
    with _write_lock:
        current = _entry_row(entry_id, write=True, conn=conn)
        if current['status'] != '有效':
            raise FundError('只有有效流水可以撤销')
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        conn.execute(
            "UPDATE fund_ledger SET status='已撤销', reversed_at=?, reversal_reason=?, updated_at=datetime('now','localtime') WHERE id=?",
            (now, reason, int(entry_id)),
        )
        audit.record('fund_ledger', entry_id, 'revoke', summary='撤销班费流水',
                     params={'reason': reason, 'settlement_period': current.get('settlement_period', '')}, conn=conn)
    return get_entry(entry_id, conn=conn)


def reverse_entry(entry_id: int, reason: str, *, occurred_at: str = '', conn=None) -> dict:
    conn = _conn(conn)
    reason = _text(reason)
    if not reason:
        raise FundError('冲正原因不能为空')
    with _write_lock:
        current = _entry_row(entry_id, write=True, conn=conn)
        if current['status'] != '有效':
            raise FundError('只有有效流水可以冲正')
        if not current['settlement_id']:
            raise FundError('未结算流水可直接修改或撤销，只有已结算流水需要冲正')
        reverse_direction = '支出' if current['direction'] == '收入' else '收入'
        reverse_date = _date(occurred_at, default_today=True)
        class_id, term_id = _scope(write=True, conn=conn)
        reversal_category = _ensure_category(
            current.get('category') or current.get('category_name', ''), reverse_direction, conn=conn)
        source_key = f'reversal:{entry_id}'
        try:
            reversal_id = conn.execute(
                '''INSERT INTO fund_ledger(
                       class_id, term_id, occurred_at, direction, amount,
                       category_id, category_name, description, handler, witness, note,
                       status, reversal_reason, reversal_of_id, source_type, source_id, source_key
                   ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id''',
                (class_id, term_id, reverse_date, reverse_direction, current['amount'], reversal_category['id'],
                 reversal_category['name'], f'冲正：{current["description"]}', current['handler'], current['witness'],
                 reason, '有效', reason, int(entry_id), 'reversal', str(entry_id), source_key),
            ).fetchone()['id']
            now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            conn.execute(
                "UPDATE fund_ledger SET status='已冲正', reversed_at=?, reversal_reason=?, updated_at=datetime('now','localtime') WHERE id=?",
                (now, reason, int(entry_id)),
            )
            audit.record('fund_ledger', reversal_id, 'reverse', summary='冲正已结算班费流水',
                         params={'original_id': entry_id, 'reason': reason, 'amount': current['amount']},
                         class_id=class_id, term_id=term_id, conn=conn, commit=False)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return get_entry(reversal_id, conn=conn)


def _totals(*, before: str = '', start: str = '', end: str = '', conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    # 已冲正的原流水仍参与账务重算，冲正流水以相反方向抵消它；已撤销才完全排除。
    where = ["class_id=?", "term_id=?", "status IN ('有效','已冲正')"]
    params: list = [class_id, term_id]
    if before:
        where.extend(["occurred_at<>''", 'occurred_at<?'])
        params.append(before)
    if start:
        where.extend(["occurred_at<>''", 'occurred_at>=?'])
        params.append(start)
    if end:
        where.extend(["occurred_at<>''", 'occurred_at<=?'])
        params.append(end)
    rows = conn.execute(
        'SELECT direction, COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM fund_ledger WHERE ' +
        ' AND '.join(where) + ' GROUP BY direction', tuple(params),
    ).fetchall()
    values = {'收入': 0.0, '支出': 0.0, 'count': 0}
    for row in rows:
        values[row['direction']] = round(float(row['total'] or 0), 2)
        values['count'] += int(row['count'] or 0)
    values['balance'] = round(values['收入'] - values['支出'], 2)
    return values


def _month_rows(*, conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    rows = conn.execute(
        '''SELECT substr(occurred_at,1,7) AS month, direction,
                  ROUND(SUM(amount),2) AS total, COUNT(*) AS count
           FROM fund_ledger
           WHERE class_id=? AND term_id=? AND status IN ('有效','已冲正') AND occurred_at<>''
           GROUP BY month, direction ORDER BY month DESC''', (class_id, term_id),
    ).fetchall()
    buckets: dict[str, dict] = {}
    for row in rows:
        item = buckets.setdefault(row['month'], {'month': row['month'], 'income': 0, 'expense': 0, 'count': 0})
        item['income' if row['direction'] == '收入' else 'expense'] = float(row['total'] or 0)
        item['count'] += int(row['count'] or 0)
    for item in buckets.values():
        item['balance'] = round(item['income'] - item['expense'], 2)
    return list(buckets.values())


def list_settlements(*, conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    result = []
    for row in conn.execute(
        'SELECT * FROM fund_settlements WHERE class_id=? AND term_id=? ORDER BY period_start DESC, id DESC',
        (class_id, term_id),
    ).fetchall():
        item = dict(row)
        actual = _totals(end=item['period_end'], conn=conn)
        item['actual_closing_balance'] = actual['balance']
        item['drift'] = round(actual['balance'] - float(item['closing_balance']), 2)
        if item['status'] == '已结算' and abs(item['drift']) > 0.005:
            item['status_display'] = '需复核'
        else:
            item['status_display'] = item['status']
        result.append(item)
    return result


def create_settlement(*, period_key: str = '', period_start: str = '', period_end: str = '',
                      counted_balance=None, note: str = '', conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        class_id, term_id = _scope(write=True, conn=conn)
        key, start, end = _period(period_key, period_start, period_end)
        if conn.execute(
            'SELECT 1 FROM fund_settlements WHERE class_id=? AND term_id=? AND period_key=?',
            (class_id, term_id, key),
        ).fetchone():
            raise FundError('该期间已经结算，请在原结算记录上复核')
        opening = _totals(before=start, conn=conn)
        current = _totals(start=start, end=end, conn=conn)
        closing = round(opening['balance'] + current['balance'], 2)
        counted = _money(counted_balance, allow_zero=True) if counted_balance is not None else closing
        if counted is None:
            raise FundError('盘点余额必须是数字')
        difference = round(counted - closing, 2)
        status = '已结算' if abs(difference) <= 0.005 else '需复核'
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        try:
            settlement_id = conn.execute(
                '''INSERT INTO fund_settlements(
                       class_id, term_id, period_key, period_start, period_end,
                       opening_balance, income_total, expense_total, closing_balance,
                       counted_balance, difference, status, note, settled_at
                   ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id''',
                (class_id, term_id, key, start, end, opening['balance'], current['收入'], current['支出'],
                 closing, counted, difference, status, _text(note), now),
            ).fetchone()['id']
            conn.execute(
                '''UPDATE fund_ledger SET settlement_id=?, updated_at=datetime('now','localtime')
                   WHERE class_id=? AND term_id=? AND status='有效' AND occurred_at>=? AND occurred_at<=?
                     AND settlement_id IS NULL''',
                (settlement_id, class_id, term_id, start, end),
            )
            audit.record('fund_settlement', settlement_id, 'create', summary=f'结算班费：{key}',
                         params={'period_start': start, 'period_end': end, 'closing_balance': closing,
                                 'counted_balance': counted, 'difference': difference},
                         class_id=class_id, term_id=term_id, conn=conn, commit=False)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return get_settlement(settlement_id, conn=conn)


def get_settlement(settlement_id: int, *, conn=None) -> dict:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    row = conn.execute(
        'SELECT * FROM fund_settlements WHERE id=? AND class_id=? AND term_id=?',
        (int(settlement_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise FundError('班费结算记录不存在')
    item = dict(row)
    actual = _totals(end=item['period_end'], conn=conn)
    item['actual_closing_balance'] = actual['balance']
    item['drift'] = round(actual['balance'] - float(item['closing_balance']), 2)
    item['status_display'] = '需复核' if abs(item['drift']) > 0.005 else item['status']
    return item


def reconcile_settlement(settlement_id: int, *, counted_balance=None, note: str | None = None,
                         conn=None) -> dict:
    conn = _conn(conn)
    with _write_lock:
        current = get_settlement(settlement_id, conn=conn)
        counted = _money(counted_balance, allow_zero=True) if counted_balance is not None else current['counted_balance']
        if counted is None:
            raise FundError('盘点余额必须是数字')
        actual = _totals(end=current['period_end'], conn=conn)
        difference = round(counted - actual['balance'], 2)
        status = '已结算' if abs(difference) <= 0.005 else '需复核'
        conn.execute(
            "UPDATE fund_settlements SET counted_balance=?, difference=?, status=?, note=?, updated_at=datetime('now','localtime') WHERE id=?",
            (counted, difference, status, _text(note) if note is not None else current['note'], int(settlement_id)),
        )
        audit.record('fund_settlement', settlement_id, 'reconcile', summary='复核班费结算',
                     params={'counted_balance': counted, 'difference': difference, 'status': status}, conn=conn)
    return get_settlement(settlement_id, conn=conn)


def class_summary(*, reference_date: str | None = None, conn=None) -> dict:
    conn = _conn(conn)
    ensure_legacy_migrated(conn=conn)
    overall = _totals(conn=conn)
    current = _date(reference_date, '参考日期', default_today=True) if reference_date else date.today().isoformat()
    current_date = date.fromisoformat(current)
    period_start = current_date.replace(day=1).isoformat()
    month = _totals(start=period_start, end=current, conn=conn)
    entries = list_entries(limit=300, conn=conn)
    return {
        'totals': overall,
        'current_period': {'month': current[:7], **month},
        'monthly': _month_rows(conn=conn),
        'categories': _category_totals(conn=conn),
        'settlements': list_settlements(conn=conn),
        'migration': migration_report(conn=conn),
        'entries': entries,
        'categories_config': list_categories(conn=conn),
    }


def _category_totals(*, conn=None) -> list[dict]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    rows = conn.execute(
        '''SELECT COALESCE(c.name, f.category_name) AS category, f.direction,
                  ROUND(SUM(f.amount),2) AS total, COUNT(*) AS count
           FROM fund_ledger f LEFT JOIN fund_categories c ON c.id=f.category_id
           WHERE f.class_id=? AND f.term_id=? AND f.status IN ('有效','已冲正')
           GROUP BY category, f.direction ORDER BY f.direction, total DESC''',
        (class_id, term_id),
    ).fetchall()
    return [dict(row) for row in rows]


def evaluate_startup(*, conn=None):
    return ensure_legacy_migrated(conn=conn)


def save_attachment(ledger_id: int, *, filename: str, content_type: str, content: bytes, conn=None) -> dict:
    conn = _conn(conn)
    entry = _entry_row(ledger_id, write=True, conn=conn)
    if entry['status'] not in {'有效'}:
        raise FundError('已撤销或已冲正流水不能上传凭证')
    data = bytes(content or b'')
    if not data:
        raise FundError('凭证不能为空')
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise FundError('凭证不能超过 10MB')
    original_name = Path(os.path.basename(_text(filename) or '班费凭证')).name[:160]
    suffix = Path(original_name).suffix[:12]
    stored_name = f'{uuid4().hex}{suffix}'
    relative_path = os.path.join('attachments', 'fund', str(ledger_id), stored_name)
    root = os.path.abspath(db.DATA_DIR)
    target = os.path.abspath(os.path.join(root, relative_path))
    if not target.startswith(root + os.sep):
        raise FundError('凭证路径不合法')
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
            '''INSERT INTO fund_attachments(
                   ledger_id, original_name, stored_name, relative_path,
                   content_type, size_bytes, sha256
               ) VALUES(?,?,?,?,?,?,?)''',
            (ledger_id, original_name, stored_name, relative_path,
             _text(content_type) or 'application/octet-stream', len(data), digest),
        ).lastrowid
        audit.record('fund_attachment', attachment_id, 'create', summary=f'上传班费凭证：{original_name}',
                     params={'ledger_id': ledger_id, 'size_bytes': len(data)}, conn=conn, commit=False)
        conn.commit()
    except Exception:
        conn.rollback()
        for path in (target, temp_path):
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
        raise
    return {'id': int(attachment_id), 'ledger_id': int(ledger_id), 'original_name': original_name,
            'content_type': _text(content_type) or 'application/octet-stream', 'size_bytes': len(data),
            'download_path': f'/api/fund/attachments/{attachment_id}'}


def attachment_file(attachment_id: int, *, conn=None) -> tuple[dict, str]:
    conn = _conn(conn)
    class_id, term_id = _scope(conn=conn)
    row = conn.execute(
        '''SELECT a.* FROM fund_attachments a JOIN fund_ledger f ON f.id=a.ledger_id
           WHERE a.id=? AND f.class_id=? AND f.term_id=?''',
        (int(attachment_id), class_id, term_id),
    ).fetchone()
    if not row:
        raise FundError('班费凭证不存在')
    root = os.path.abspath(db.DATA_DIR)
    path = os.path.abspath(os.path.join(root, row['relative_path']))
    if not path.startswith(root + os.sep) or not os.path.isfile(path):
        raise FundError('班费凭证文件不存在')
    return dict(row), path


def export_entries(*, conn=None) -> list[list]:
    entries = list_entries(limit=5000, conn=conn)
    return [[
        item.get('occurred_at', ''), item.get('direction', ''), item.get('amount', 0),
        item.get('category', ''), item.get('description', ''), item.get('handler', ''),
        item.get('witness', ''), item.get('note', ''), item.get('status', ''),
        item.get('settlement_period', '') or '', item.get('reversal_reason', '') or '',
        item.get('source_label', ''), item.get('attachment_count', 0),
    ] for item in entries]
