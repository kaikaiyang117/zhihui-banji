# -*- coding: utf-8 -*-
"""结构化考勤、统计和规则自动评估。"""
from __future__ import annotations

from datetime import date, datetime, timedelta
import json

from .. import db
from . import audit, class_context


STATUSES = {'出勤', '迟到', '请假', '早退', '缺勤'}
SCENES = ('常规到校', '早自习', '上午', '下午', '晚自习')
RULE_SCENES = ('全部场景', *SCENES)
RULE_METRICS = {'迟到次数', '请假次数', '缺勤次数', '连续缺勤天数'}
TRIGGERS = {'save', 'startup', 'manual', 'rule_change'}
OPEN_TASK_STATUSES = {'待处理', '处理中', '待复查'}


class AttendanceError(ValueError):
    pass


def _today() -> str:
    return date.today().isoformat()


def _now() -> str:
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def _date(value: str | None, *, default_today: bool = False) -> str:
    text = str(value or (_today() if default_today else ''))[:10]
    if not text:
        return ''
    try:
        date.fromisoformat(text)
    except ValueError as exc:
        raise AttendanceError('日期格式必须为 YYYY-MM-DD') from exc
    return text


def _scene(value: str | None, *, allow_all: bool = False) -> str:
    text = str(value or ('全部场景' if allow_all else '常规到校')).strip()
    allowed = RULE_SCENES if allow_all else SCENES
    if text not in allowed:
        raise AttendanceError('不支持的考勤场景')
    return text


def _scope(*, write: bool = False, conn=None) -> tuple[int, int]:
    return class_context.scope_ids(write=write, conn=conn or db.get_conn())


def list_records(
    *,
    attendance_date: str = '',
    date_from: str = '',
    date_to: str = '',
    scene: str = '',
    student_id: int | None = None,
    status: str = '',
    limit: int = 5_000,
    conn=None,
) -> list[dict]:
    conn = conn or db.get_conn()
    class_id, term_id = _scope(conn=conn)
    where = ["a.class_id=?", "a.term_id=?", "a.deleted_at=''", "s.deleted_at=''"]
    params: list = [class_id, term_id]
    if attendance_date:
        where.append('a.attendance_date=?')
        params.append(_date(attendance_date))
    if date_from:
        where.append('a.attendance_date>=?')
        params.append(_date(date_from))
    if date_to:
        where.append('a.attendance_date<=?')
        params.append(_date(date_to))
    if scene and scene != '全部场景':
        where.append('a.scene=?')
        params.append(_scene(scene))
    if student_id is not None:
        where.append('a.student_id=?')
        params.append(int(student_id))
    if status:
        if status not in STATUSES:
            raise AttendanceError('考勤状态不合法')
        where.append('a.status=?')
        params.append(status)
    params.append(max(1, min(int(limit), 50_000)))
    rows = conn.execute(
        '''SELECT a.*, s.学号, s.姓名 AS student_name
           FROM attendance_records a JOIN students s ON s.id=a.student_id
           WHERE ''' + ' AND '.join(where) +
        ' ORDER BY a.attendance_date DESC, a.scene, s.学号, a.id DESC LIMIT ?',
        tuple(params),
    ).fetchall()
    return [dict(row) for row in rows]


def compatibility_rows(*, conn=None) -> list[dict]:
    """为旧只读接口提供稳定的九列考勤布局。"""
    rows = list_records(limit=50_000, conn=conn)
    output = []
    for row in rows:
        try:
            weekday = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][
                date.fromisoformat(row['attendance_date']).weekday()]
        except ValueError:
            weekday = ''
        output.append({
            'row_no': row['id'],
            'data': [row['attendance_date'], weekday, row['学号'], row['student_name'],
                     row['status'], row['arrive_at'], row['leave_at'], row['reason'],
                     row['note'], row['scene']],
        })
    return output


def save_daily(
    attendance_date: str,
    scene: str,
    records: list[dict],
    *,
    evaluate: bool = True,
    conn=None,
) -> dict:
    conn = conn or db.get_conn()
    attendance_date = _date(attendance_date)
    scene = _scene(scene)
    if not records:
        raise AttendanceError('至少提交一名学生的考勤')
    class_id, term_id = _scope(write=True, conn=conn)
    students = {
        int(row['id']): dict(row)
        for row in conn.execute(
            '''SELECT s.id, s.学号, s.姓名 FROM students s
               JOIN student_enrollments e ON e.student_id=s.id
               WHERE e.class_id=? AND e.term_id=? AND e.status='在读'
                 AND s.deleted_at='' ''',
            (class_id, term_id),
        ).fetchall()
    }
    saved = 0
    try:
        for item in records:
            student_id = int(item.get('student_id') or 0)
            if student_id not in students:
                raise AttendanceError(f'学生 {student_id} 不存在或不在当前班级')
            status = str(item.get('status') or '出勤').strip()
            if status not in STATUSES:
                raise AttendanceError(f'考勤状态不合法：{status}')
            conn.execute(
                '''INSERT INTO attendance_records(
                       student_id, class_id, term_id, attendance_date, scene, status,
                       arrive_at, leave_at, reason, note
                   ) VALUES(?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(class_id, term_id, attendance_date, scene, student_id)
                   DO UPDATE SET status=excluded.status, arrive_at=excluded.arrive_at,
                     leave_at=excluded.leave_at, reason=excluded.reason, note=excluded.note,
                     deleted_at='', deleted_by='', updated_at=datetime('now','localtime')''',
                (student_id, class_id, term_id, attendance_date, scene, status,
                 str(item.get('arrive') or item.get('arrive_at') or '').strip(),
                 str(item.get('leave') or item.get('leave_at') or '').strip(),
                 str(item.get('reason') or '').strip(), str(item.get('note') or '').strip()),
            )
            saved += 1
        audit.record(
            'attendance_batch', f'{attendance_date}:{scene}', 'save',
            summary=f'保存{attendance_date} {scene}考勤 {saved} 人',
            params={'date': attendance_date, 'scene': scene, 'saved': saved},
            class_id=class_id, term_id=term_id, conn=conn, commit=False,
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    evaluation = None
    evaluation_error = ''
    if evaluate:
        try:
            evaluation = evaluate_rules(
                reference_date=attendance_date, trigger='save', conn=conn)
        except Exception as exc:  # 考勤已安全保存，规则失败作为可见警告返回。
            evaluation_error = str(exc)
    return {
        'ok': True, 'date': attendance_date, 'scene': scene, 'saved': saved,
        'evaluation': evaluation, 'evaluation_error': evaluation_error,
    }


def attendance_stats(
    *, date_from: str = '', date_to: str = '', scene: str = '全部场景', conn=None,
) -> dict:
    conn = conn or db.get_conn()
    date_from = _date(date_from) if date_from else ''
    date_to = _date(date_to) if date_to else ''
    if date_from and date_to and date_from > date_to:
        raise AttendanceError('开始日期不能晚于结束日期')
    scene = _scene(scene, allow_all=True)
    rows = list_records(
        date_from=date_from, date_to=date_to, scene=scene, limit=50_000, conn=conn)
    status_count = {status: 0 for status in STATUSES}
    date_stats: dict[str, dict] = {}
    student_stats: dict[int, dict] = {}
    month_stats: dict[str, dict] = {}
    week_stats: dict[str, dict] = {}
    anomalies = []

    def empty_bucket(label: str) -> dict:
        return {'label': label, '出勤': 0, '迟到': 0, '请假': 0, '早退': 0,
                '缺勤': 0, '总记录': 0, '异常': 0}

    for row in rows:
        status = row['status']
        status_count[status] = status_count.get(status, 0) + 1
        day = date_stats.setdefault(row['attendance_date'], empty_bucket(row['attendance_date']))
        month_key = row['attendance_date'][:7]
        month = month_stats.setdefault(month_key, empty_bucket(month_key))
        try:
            date_obj = date.fromisoformat(row['attendance_date'])
            iso = date_obj.isocalendar()
            week_key = f'{iso.year}-W{iso.week:02d}'
        except ValueError:
            week_key = '日期异常'
        week = week_stats.setdefault(week_key, empty_bucket(week_key))
        student = student_stats.setdefault(row['student_id'], {
            'student_id': row['student_id'], '学号': row['学号'],
            'student_name': row['student_name'], **empty_bucket(row['student_name']),
        })
        for bucket in (day, month, week, student):
            bucket[status] = bucket.get(status, 0) + 1
            bucket['总记录'] += 1
            if status != '出勤':
                bucket['异常'] += 1
        if status != '出勤':
            anomalies.append({
                'id': row['id'], 'student_id': row['student_id'], '学号': row['学号'],
                'student_name': row['student_name'], 'date': row['attendance_date'],
                'scene': row['scene'], 'status': status, 'reason': row['reason'],
                'note': row['note'],
            })
    for item in student_stats.values():
        attended = item['出勤'] + item['迟到'] + item['早退']
        item['attendance_rate'] = round(attended * 100 / item['总记录'], 1) if item['总记录'] else 0
    students = sorted(
        student_stats.values(),
        key=lambda item: (-item['异常'], item['学号'] or '', item['student_id']),
    )
    return {
        'date_from': date_from, 'date_to': date_to, 'scene': scene,
        'total_records': len(rows), 'status_count': status_count,
        'date_stats': [date_stats[key] for key in sorted(date_stats, reverse=True)],
        'student_stats': students,
        'month_stats': [month_stats[key] for key in sorted(month_stats, reverse=True)],
        'week_stats': [week_stats[key] for key in sorted(week_stats, reverse=True)],
        'anomalies': anomalies[:500],
        'definition': '出勤率=(出勤+迟到+早退)/总记录；请假和缺勤不计入出勤。',
    }


def dashboard_counts(target_date: str, *, conn=None) -> dict:
    """同一学生多场景时按最严重状态计入一次。"""
    rows = list_records(attendance_date=_date(target_date), limit=50_000, conn=conn)
    severity = {'出勤': 0, '迟到': 1, '早退': 2, '请假': 3, '缺勤': 4}
    by_student: dict[int, str] = {}
    for row in rows:
        current = by_student.get(row['student_id'], '出勤')
        if severity.get(row['status'], 0) >= severity.get(current, 0):
            by_student[row['student_id']] = row['status']
    counts = {status: 0 for status in STATUSES}
    for status in by_student.values():
        counts[status] += 1
    return counts


def _rule_value(rows: list[dict], metric: str) -> int:
    mapping = {'迟到次数': '迟到', '请假次数': '请假', '缺勤次数': '缺勤'}
    if metric in mapping:
        return sum(1 for row in rows if row['status'] == mapping[metric])
    if metric != '连续缺勤天数':
        raise AttendanceError('不支持的考勤指标')
    by_date: dict[str, list[str]] = {}
    for row in rows:
        by_date.setdefault(row['attendance_date'], []).append(row['status'])
    streak = best = 0
    for day in sorted(by_date):
        if '缺勤' in by_date[day]:
            streak += 1
            best = max(best, streak)
        else:
            streak = 0
    return best


def _rule_row(rule_id: int, *, write: bool = False, conn=None) -> dict:
    conn = conn or db.get_conn()
    class_id, term_id = _scope(write=write, conn=conn)
    row = conn.execute(
        "SELECT * FROM attendance_rules WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
        (rule_id, class_id, term_id),
    ).fetchone()
    if not row:
        raise AttendanceError('考勤规则不存在')
    return dict(row)


def list_rules(*, source_id: int | None = None, conn=None) -> dict:
    conn = conn or db.get_conn()
    class_id, term_id = _scope(conn=conn)
    params: list = [class_id, term_id]
    sql = "SELECT * FROM attendance_rules WHERE class_id=? AND term_id=? AND deleted_at=''"
    if source_id:
        sql += ' AND id=?'
        params.append(int(source_id))
    rules = [dict(row) for row in conn.execute(
        sql + ' ORDER BY enabled DESC, id', tuple(params)).fetchall()]
    for rule in rules:
        rule['enabled'] = bool(rule['enabled'])
        hits = [dict(row) for row in conn.execute(
            '''SELECT h.*, s.学号, s.姓名 AS student_name,
                      t.status AS task_status, t.result AS task_result
               FROM attendance_rule_hits h
               JOIN students s ON s.id=h.student_id
               LEFT JOIN student_tasks t ON t.id=h.task_id
               WHERE h.class_id=? AND h.term_id=? AND h.rule_id=?
               ORDER BY CASE h.status WHEN '待处理' THEN 0 WHEN '已处理' THEN 1 ELSE 2 END,
                        h.last_hit_at DESC, h.id DESC''',
            (class_id, term_id, rule['id']),
        ).fetchall()]
        rule['hits'] = hits
        rule['active_hit_count'] = sum(1 for item in hits if item['status'] == '待处理')
        rule['handled_hit_count'] = sum(1 for item in hits if item['status'] == '已处理')
    runs = [dict(row) for row in conn.execute(
        '''SELECT * FROM attendance_rule_runs
           WHERE class_id=? AND term_id=? ORDER BY id DESC LIMIT 20''',
        (class_id, term_id),
    ).fetchall()]
    for run in runs:
        try:
            run['summary'] = json.loads(run.pop('summary_json') or '[]')
        except (TypeError, ValueError):
            run['summary'] = []
    return {'rules': rules, 'recent_runs': runs}


def create_rule(
    *, name: str, metric: str, threshold: int = 2, period_days: int = 7,
    priority: str = '重要', enabled: bool = True, scene: str = '全部场景', conn=None,
) -> dict:
    conn = conn or db.get_conn()
    name = str(name or '').strip()
    if not name:
        raise AttendanceError('规则名称不能为空')
    if metric not in RULE_METRICS:
        raise AttendanceError('不支持的考勤指标')
    if int(threshold) < 1 or not 1 <= int(period_days) <= 365:
        raise AttendanceError('阈值或统计周期不合法')
    scene = _scene(scene, allow_all=True)
    class_id, term_id = _scope(write=True, conn=conn)
    rule_id = conn.execute(
        '''INSERT INTO attendance_rules(
               name, metric, threshold, period_days, priority, enabled, scene, class_id, term_id
           ) VALUES(?,?,?,?,?,?,?,?,?)''',
        (name, metric, int(threshold), int(period_days), str(priority or '重要'),
         int(bool(enabled)), scene, class_id, term_id),
    ).lastrowid
    audit.record(
        'attendance_rule', rule_id, 'create', summary=f'新增考勤规则：{name}',
        params={'metric': metric, 'threshold': threshold, 'period_days': period_days,
                'scene': scene, 'enabled': enabled},
        class_id=class_id, term_id=term_id, conn=conn, commit=False,
    )
    conn.commit()
    evaluation = evaluate_rules(trigger='rule_change', conn=conn) if enabled else None
    return {'ok': True, 'rule_id': int(rule_id), 'evaluation': evaluation}


def _resolve_open_task(task_id: int | None, result: str, *, conn) -> bool:
    if not task_id:
        return False
    task = conn.execute(
        "SELECT status FROM student_tasks WHERE id=? AND deleted_at=''", (task_id,)
    ).fetchone()
    if not task or task['status'] not in OPEN_TASK_STATUSES:
        return False
    from . import work_items
    work_items.update_work_item(
        int(task_id), status='已取消', result=result, conn=conn, commit=False)
    return True


def _resolve_rule_hits(rule_id: int, result: str, *, conn) -> int:
    class_id, term_id = _scope(write=True, conn=conn)
    hits = conn.execute(
        "SELECT * FROM attendance_rule_hits WHERE rule_id=? AND class_id=? AND term_id=? AND status<>'已解除'",
        (rule_id, class_id, term_id),
    ).fetchall()
    resolved = 0
    for hit in hits:
        _resolve_open_task(hit['task_id'], result, conn=conn)
        conn.execute(
            "UPDATE attendance_rule_hits SET status='已解除', resolved_at=?, updated_at=datetime('now','localtime') WHERE id=?",
            (_now(), hit['id']),
        )
        resolved += 1
    return resolved


def update_rule(rule_id: int, **changes) -> dict:
    conn = changes.pop('conn', None) or db.get_conn()
    current = _rule_row(rule_id, write=True, conn=conn)
    fields, params = [], []
    for key in ('enabled', 'threshold', 'period_days', 'priority', 'scene'):
        value = changes.get(key)
        if value is None:
            continue
        if key == 'enabled':
            value = int(bool(value))
        elif key == 'threshold' and int(value) < 1:
            raise AttendanceError('阈值不能小于 1')
        elif key == 'period_days' and not 1 <= int(value) <= 365:
            raise AttendanceError('统计周期必须在 1 到 365 天之间')
        elif key == 'scene':
            value = _scene(value, allow_all=True)
        fields.append(f'{key}=?')
        params.append(value)
    if not fields:
        return {'ok': True, 'evaluation': None}
    class_id, term_id = _scope(write=True, conn=conn)
    params.extend((rule_id, class_id, term_id))
    conn.execute(
        f"UPDATE attendance_rules SET {', '.join(fields)}, updated_at=datetime('now','localtime') "
        'WHERE id=? AND class_id=? AND term_id=?', tuple(params))
    resolved = 0
    next_enabled = bool(changes.get('enabled')) if changes.get('enabled') is not None else bool(current['enabled'])
    if not next_enabled:
        resolved = _resolve_rule_hits(rule_id, '考勤规则已停用，系统自动解除提醒', conn=conn)
    audit.record(
        'attendance_rule', rule_id, 'update', summary=f"更新考勤规则：{current['name']}",
        params=changes, class_id=class_id, term_id=term_id, conn=conn, commit=False,
    )
    conn.commit()
    evaluation = evaluate_rules(trigger='rule_change', conn=conn) if next_enabled else None
    return {'ok': True, 'resolved_count': resolved, 'evaluation': evaluation}


def _activate_task(rule: dict, student: dict, value: int, reference_date: str,
                   *, rehit: bool, conn) -> tuple[int, bool, bool]:
    from . import work_items
    title = f"考勤提醒 · {student['姓名']} · {rule['name']}"
    notes = (
        f"{rule['metric']}达到 {value}，阈值 {rule['threshold']}，"
        f"统计周期 {rule['period_days']} 天，场景 {rule['scene']}"
    )
    task = work_items.ensure_source_work_item(
        title=title, legacy_title=title, student_id=student['id'],
        source_type='attendance_rule', source_id=rule['id'], due_at=reference_date,
        priority=rule['priority'], status='待处理', notes=notes,
        conn=conn, commit=False,
    )
    task_id = int(task['id'])
    row = conn.execute(
        '''SELECT status, title, priority, due_at, notes
           FROM student_tasks WHERE id=? AND deleted_at='' ''', (task_id,)
    ).fetchone()
    reopened = False
    if row and row['status'] not in OPEN_TASK_STATUSES and (rehit or not task['created']):
        work_items.update_work_item(
            task_id, title=title, priority=rule['priority'], status='待处理', due_at=reference_date,
            notes=notes, conn=conn, commit=False)
        reopened = True
    elif row and row['status'] in OPEN_TASK_STATUSES and any((
        row['title'] != title,
        row['priority'] != rule['priority'],
        row['due_at'] != reference_date,
        row['notes'] != notes,
    )):
        work_items.update_work_item(
            task_id, title=title, priority=rule['priority'], due_at=reference_date, notes=notes,
            conn=conn, commit=False)
    return task_id, bool(task['created']), reopened


def evaluate_rules(
    *, reference_date: str | None = None, trigger: str = 'manual', conn=None,
) -> dict:
    conn = conn or db.get_conn()
    reference_date = _date(reference_date, default_today=True)
    if trigger not in TRIGGERS:
        raise AttendanceError('规则执行来源不合法')
    class_id, term_id = _scope(write=True, conn=conn)
    rules = [dict(row) for row in conn.execute(
        "SELECT * FROM attendance_rules WHERE enabled=1 AND class_id=? AND term_id=? AND deleted_at='' ORDER BY id",
        (class_id, term_id),
    ).fetchall()]
    students = [dict(row) for row in conn.execute(
        '''SELECT s.id, s.学号, s.姓名 FROM students s
           JOIN student_enrollments e ON e.student_id=s.id
           WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
           ORDER BY s.id''',
        (class_id, term_id),
    ).fetchall()]
    max_days = max((int(rule['period_days']) for rule in rules), default=1)
    start_date = (date.fromisoformat(reference_date) - timedelta(days=max_days - 1)).isoformat()
    raw_records = [dict(row) for row in conn.execute(
        '''SELECT * FROM attendance_records
           WHERE class_id=? AND term_id=? AND deleted_at=''
             AND attendance_date>=? AND attendance_date<=?
           ORDER BY attendance_date, id''',
        (class_id, term_id, start_date, reference_date),
    ).fetchall()]
    by_student: dict[int, list[dict]] = {}
    for record in raw_records:
        by_student.setdefault(int(record['student_id']), []).append(record)
    now = _now()
    hit_count = created_count = reopened_count = resolved_count = 0
    summary = []
    try:
        for rule in rules:
            rule_start = (
                date.fromisoformat(reference_date) - timedelta(days=int(rule['period_days']) - 1)
            ).isoformat()
            for student in students:
                records = [
                    row for row in by_student.get(int(student['id']), [])
                    if row['attendance_date'] >= rule_start
                    and (rule['scene'] == '全部场景' or row['scene'] == rule['scene'])
                ]
                value = _rule_value(records, rule['metric'])
                hit = conn.execute(
                    '''SELECT * FROM attendance_rule_hits
                       WHERE class_id=? AND term_id=? AND rule_id=? AND student_id=?''',
                    (class_id, term_id, rule['id'], student['id']),
                ).fetchone()
                if value >= int(rule['threshold']):
                    hit_count += 1
                    hit_dict = dict(hit) if hit else None
                    needs_activation = hit_dict is None or hit_dict['status'] == '已解除'
                    if needs_activation:
                        task_id, created, reopened = _activate_task(
                            rule, student, value, reference_date,
                            rehit=bool(hit_dict), conn=conn)
                        created_count += int(created)
                        reopened_count += int(reopened)
                        if hit_dict:
                            conn.execute(
                                '''UPDATE attendance_rule_hits SET status='待处理', current_value=?,
                                     task_id=?, last_hit_at=?, handled_at='', resolved_at='',
                                     updated_at=datetime('now','localtime') WHERE id=?''',
                                (value, task_id, now, hit_dict['id']),
                            )
                        else:
                            conn.execute(
                                '''INSERT INTO attendance_rule_hits(
                                       rule_id, student_id, class_id, term_id, status,
                                       current_value, task_id, first_hit_at, last_hit_at
                                   ) VALUES(?,?,?,?,'待处理',?,?,?,?)''',
                                (rule['id'], student['id'], class_id, term_id,
                                 value, task_id, now, now),
                            )
                        state = '重新命中' if hit_dict else '新命中'
                    else:
                        task = conn.execute(
                            'SELECT status FROM student_tasks WHERE id=?', (hit_dict['task_id'],)
                        ).fetchone() if hit_dict['task_id'] else None
                        next_status = hit_dict['status']
                        if next_status == '待处理' and task and task['status'] not in OPEN_TASK_STATUSES:
                            next_status = '已处理'
                        conn.execute(
                            '''UPDATE attendance_rule_hits SET status=?, current_value=?, last_hit_at=?,
                                 handled_at=CASE WHEN ?='已处理' AND handled_at='' THEN ? ELSE handled_at END,
                                 updated_at=datetime('now','localtime') WHERE id=?''',
                            (next_status, value, now, next_status, now, hit_dict['id']),
                        )
                        state = next_status
                    summary.append({
                        'rule_id': rule['id'], 'rule': rule['name'],
                        'student_id': student['id'], 'student_name': student['姓名'],
                        'value': value, 'state': state,
                    })
                elif hit and hit['status'] != '已解除':
                    _resolve_open_task(
                        hit['task_id'], '考勤指标已恢复，系统自动解除提醒', conn=conn)
                    conn.execute(
                        '''UPDATE attendance_rule_hits SET status='已解除', current_value=?,
                             resolved_at=?, updated_at=datetime('now','localtime') WHERE id=?''',
                        (value, now, hit['id']),
                    )
                    resolved_count += 1
            conn.execute(
                "UPDATE attendance_rules SET last_run_at=?, updated_at=datetime('now','localtime') WHERE id=?",
                (now, rule['id']),
            )
        run_id = conn.execute(
            '''INSERT INTO attendance_rule_runs(
                   class_id, term_id, trigger_type, reference_date, rules_evaluated,
                   students_evaluated, hit_count, created_count, reopened_count,
                   resolved_count, status, summary_json
               ) VALUES(?,?,?,?,?,?,?,?,?,?,'success',?)''',
            (class_id, term_id, trigger, reference_date, len(rules), len(students),
             hit_count, created_count, reopened_count, resolved_count,
             json.dumps(summary, ensure_ascii=False)),
        ).lastrowid
        audit.record(
            'attendance_rules', run_id, 'evaluate',
            summary=(f'执行 {len(rules)} 条考勤规则：命中 {hit_count}，'
                     f'新建 {created_count}，重开 {reopened_count}，解除 {resolved_count}'),
            params={'trigger': trigger, 'reference_date': reference_date},
            class_id=class_id, term_id=term_id, conn=conn, commit=False,
        )
        conn.commit()
    except Exception as exc:
        conn.rollback()
        conn.execute(
            '''INSERT INTO attendance_rule_runs(
                   class_id, term_id, trigger_type, reference_date, rules_evaluated,
                   students_evaluated, status, error
               ) VALUES(?,?,?,?,?,?,'failed',?)''',
            (class_id, term_id, trigger, reference_date, len(rules), len(students), str(exc)[:500]),
        )
        conn.commit()
        raise
    return {
        'run_id': int(run_id), 'reference_date': reference_date, 'trigger': trigger,
        'rules_evaluated': len(rules), 'students_evaluated': len(students),
        'hit_count': hit_count, 'created_count': created_count,
        'reopened_count': reopened_count, 'resolved_count': resolved_count,
        'summary': summary,
    }


def on_work_item_transition(conn, item: dict, next_status: str):
    """教师处理考勤提醒后保留已处理状态，等待指标真正回落后再解除。"""
    if item.get('source_type') != 'attendance_rule':
        return
    now = _now()
    if next_status in {'已完成', '已取消'}:
        conn.execute(
            '''UPDATE attendance_rule_hits SET status='已处理', handled_at=?,
                 updated_at=datetime('now','localtime')
               WHERE task_id=? AND status='待处理' ''',
            (now, item['id']),
        )
    elif next_status in OPEN_TASK_STATUSES:
        conn.execute(
            '''UPDATE attendance_rule_hits SET status='待处理', handled_at='', resolved_at='',
                 updated_at=datetime('now','localtime') WHERE task_id=?''',
            (item['id'],),
        )


def evaluate_startup(*, conn=None) -> list[dict]:
    """启动时评估所有进行中的班级/学期，而不依赖某个浏览器当前上下文。"""
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
