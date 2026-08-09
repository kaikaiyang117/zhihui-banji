# -*- coding: utf-8 -*-
"""个人健康目标、汇总、周期复盘和提醒配置。

健康表不带班级/学期字段，保持个人数据与教师业务隔离。
"""
from __future__ import annotations

from datetime import date, timedelta
import io
import json

from openpyxl import Workbook
from openpyxl.styles import Font

from .. import clock, db


class HealthError(ValueError):
    pass


SHEETS = ('体重体脂追踪', '运动记录', '睡眠记录', '饮食记录')


def _text(value):
    return str(value or '').strip()


def _period(period_type: str, start: str = '', end: str = ''):
    today = clock.today()
    if start or end:
        try:
            begin, finish = date.fromisoformat(start[:10]), date.fromisoformat(end[:10])
        except (TypeError, ValueError) as exc:
            raise HealthError('复盘日期必须为 YYYY-MM-DD') from exc
    elif period_type == 'week':
        begin = today - timedelta(days=today.weekday())
        finish = begin + timedelta(days=6)
    else:
        begin = today.replace(day=1)
        finish = today
    if begin > finish:
        raise HealthError('开始日期不能晚于结束日期')
    return begin.isoformat(), finish.isoformat()


def _rows(sheet: str, start: str, end: str):
    result = []
    for row in db.get_rows(sheet):
        data = row.get('data') or []
        raw_date = data[1] if sheet == '体重体脂追踪' and len(data) > 1 else data[0] if data else ''
        raw_date = _text(raw_date)[:10]
        if start <= raw_date <= end:
            result.append({'id': row.get('row_no'), 'date': raw_date, 'data': data})
    return result


def list_goals():
    rows = [dict(row) for row in db.get_conn().execute(
        'SELECT * FROM health_goals ORDER BY enabled DESC, metric, id').fetchall()]
    for row in rows:
        row['enabled'] = bool(row['enabled'])
    return rows


def create_goal(*, metric: str, target_value: float | None = None, unit: str = '', note: str = '', enabled: bool = True):
    metric = _text(metric)
    if not metric:
        raise HealthError('目标名称不能为空')
    conn = db.get_conn()
    try:
        row = conn.execute(
            '''INSERT INTO health_goals(metric, target_value, unit, note, enabled)
               VALUES(?,?,?,?,?) RETURNING *''',
            (metric, target_value, _text(unit), _text(note), int(enabled)),
        ).fetchone()
        conn.commit()
    except Exception as exc:
        conn.rollback()
        if 'UNIQUE' in str(exc).upper():
            raise HealthError('该健康目标已存在') from exc
        raise
    return dict(row)


def update_goal(goal_id: int, *, metric: str | None = None, target_value: float | None = None,
                unit: str | None = None, note: str | None = None, enabled: bool | None = None):
    conn = db.get_conn()
    current = conn.execute('SELECT * FROM health_goals WHERE id=?', (int(goal_id),)).fetchone()
    if not current:
        raise HealthError('健康目标不存在')
    fields, params = [], []
    for key, value in (('metric', metric), ('target_value', target_value), ('unit', unit), ('note', note), ('enabled', enabled)):
        if value is not None:
            fields.append(f'{key}=?')
            params.append(int(value) if key == 'enabled' else (_text(value) if key in {'metric', 'unit', 'note'} else value))
    if fields:
        params.append(int(goal_id))
        try:
            conn.execute('UPDATE health_goals SET ' + ', '.join(fields) + ", updated_at=datetime('now','localtime') WHERE id=?", tuple(params))
            conn.commit()
        except Exception as exc:
            conn.rollback()
            raise HealthError('健康目标更新失败，可能存在同名目标') from exc
    return dict(conn.execute('SELECT * FROM health_goals WHERE id=?', (int(goal_id),)).fetchone())


def summary(period_type: str = 'month', period_start: str = '', period_end: str = ''):
    start, end = _period(period_type, period_start, period_end)
    weight = _rows('体重体脂追踪', start, end)
    exercise = _rows('运动记录', start, end)
    sleep = _rows('睡眠记录', start, end)
    diet = _rows('饮食记录', start, end)

    def nums(rows, index):
        values = []
        for item in rows:
            try:
                value = float(item['data'][index])
                if value == value:
                    values.append(value)
            except (IndexError, TypeError, ValueError):
                pass
        return values

    weights, body_fat = nums(weight, 2), nums(weight, 4)
    exercise_minutes = nums(exercise, 4)
    sleep_hours = nums(sleep, 3)
    water = nums(diet, 6)
    protein_ok = sum(1 for item in diet if len(item['data']) > 5 and _text(item['data'][5]) == '达标')
    metrics = {
        'period_start': start, 'period_end': end,
        'weight_records': len(weight), 'latest_weight': weights[-1] if weights else None,
        'weight_change': round(weights[-1] - weights[0], 2) if len(weights) > 1 else None,
        'average_body_fat': round(sum(body_fat) / len(body_fat), 2) if body_fat else None,
        'exercise_days': len(exercise), 'exercise_minutes': round(sum(exercise_minutes), 1),
        'sleep_days': len(sleep), 'average_sleep_hours': round(sum(sleep_hours) / len(sleep_hours), 2) if sleep_hours else None,
        'diet_days': len(diet), 'protein_goal_days': protein_ok,
        'average_water_ml': round(sum(water) / len(water), 1) if water else None,
    }
    alerts = []
    if metrics['average_sleep_hours'] is not None and metrics['average_sleep_hours'] < 7:
        alerts.append('周期平均睡眠少于 7 小时')
    if metrics['diet_days'] and protein_ok < metrics['diet_days'] / 2:
        alerts.append('蛋白质达标天数不足周期饮食记录的一半')
    if not exercise:
        alerts.append('本周期暂无运动记录')
    return {'period_type': period_type, **metrics, 'alerts': alerts,
            'goals': list_goals(),
            'records': {'weight': weight, 'exercise': exercise, 'sleep': sleep, 'diet': diet}}


def generate_review(period_type: str = 'month', period_start: str = '', period_end: str = ''):
    data = summary(period_type, period_start, period_end)
    parts = [f"记录 {data['diet_days']} 天饮食、{data['exercise_days']} 天运动、{data['sleep_days']} 天睡眠。"]
    if data['latest_weight'] is not None:
        parts.append(f"最近体重 {data['latest_weight']} 斤。")
    if data['alerts']:
        parts.append('需要关注：' + '；'.join(data['alerts']) + '。')
    else:
        parts.append('本周期没有检测到明显异常。')
    return {'period_type': period_type, 'period_start': data['period_start'], 'period_end': data['period_end'],
            'summary': ''.join(parts), 'next_plan': '', 'metrics': data}


def save_review(*, period_type: str, period_start: str, period_end: str, summary_text: str, next_plan: str = '', metrics: dict | None = None):
    start, end = _period(period_type, period_start, period_end)
    conn = db.get_conn()
    row = conn.execute(
        '''INSERT INTO health_reviews(period_type, period_start, period_end, summary, next_plan, metrics_json)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(period_type, period_start, period_end) DO UPDATE SET
             summary=excluded.summary, next_plan=excluded.next_plan, metrics_json=excluded.metrics_json,
             updated_at=datetime('now','localtime') RETURNING *''',
        (period_type, start, end, _text(summary_text), _text(next_plan), json.dumps(metrics or {}, ensure_ascii=False)),
    ).fetchone()
    conn.commit()
    item = dict(row)
    item['metrics'] = json.loads(item.pop('metrics_json') or '{}')
    return item


def list_reviews(limit: int = 50):
    rows = [dict(row) for row in db.get_conn().execute(
        'SELECT * FROM health_reviews ORDER BY period_end DESC, id DESC LIMIT ?', (max(1, min(int(limit), 200)),)
    ).fetchall()]
    for row in rows:
        row['metrics'] = json.loads(row.pop('metrics_json') or '{}')
    return rows


def list_reminders():
    rows = [dict(row) for row in db.get_conn().execute(
        'SELECT * FROM health_reminders ORDER BY reminder_type').fetchall()]
    for row in rows:
        row['enabled'] = bool(row['enabled'])
    return rows


def save_reminder(*, reminder_type: str, enabled: bool = False, remind_time: str = '21:00', message: str = ''):
    if not _text(reminder_type):
        raise HealthError('提醒类型不能为空')
    if not _text(remind_time) or len(_text(remind_time)) != 5:
        raise HealthError('提醒时间应为 HH:MM')
    conn = db.get_conn()
    row = conn.execute(
        '''INSERT INTO health_reminders(reminder_type, enabled, remind_time, message)
           VALUES(?,?,?,?) ON CONFLICT(reminder_type) DO UPDATE SET enabled=excluded.enabled,
           remind_time=excluded.remind_time, message=excluded.message, updated_at=datetime('now','localtime')
           RETURNING *''', (_text(reminder_type), int(enabled), _text(remind_time), _text(message))
    ).fetchone()
    conn.commit()
    item = dict(row); item['enabled'] = bool(item['enabled']); return item


def export_summary(period_type: str = 'month', period_start: str = '', period_end: str = ''):
    """导出个人健康周期汇总，不混入班级或学生数据。"""
    data = summary(period_type, period_start, period_end)
    wb = Workbook()
    sheet = wb.active
    sheet.title = '健康周期汇总'
    sheet.append(['个人健康周期汇总'])
    sheet['A1'].font = Font(bold=True, size=14)
    sheet.append(['周期', f"{data['period_start']} 至 {data['period_end']}"])
    sheet.append([])
    sheet.append(['指标', '数值'])
    sheet['A4'].font = sheet['B4'].font = Font(bold=True)
    labels = [
        ('体重记录数', 'weight_records'), ('最近体重', 'latest_weight'),
        ('体重变化', 'weight_change'), ('平均体脂', 'average_body_fat'),
        ('运动天数', 'exercise_days'), ('运动分钟数', 'exercise_minutes'),
        ('睡眠天数', 'sleep_days'), ('平均睡眠小时', 'average_sleep_hours'),
        ('饮食记录天数', 'diet_days'), ('蛋白质达标天数', 'protein_goal_days'),
        ('平均饮水量（毫升）', 'average_water_ml'),
    ]
    for label, key in labels:
        sheet.append([label, data.get(key)])
    sheet.append([])
    sheet.append(['周期提醒'])
    for alert in data.get('alerts') or []:
        sheet.append([alert])
    for column in ('A', 'B'):
        sheet.column_dimensions[column].width = 28

    for name, rows in data.get('records', {}).items():
        detail = wb.create_sheet(name)
        detail.append(['日期', '原始记录'])
        detail['A1'].font = detail['B1'].font = Font(bold=True)
        for row in rows:
            detail.append([row.get('date', ''), json.dumps(row.get('data', []), ensure_ascii=False)])
        detail.column_dimensions['A'].width = 16
        detail.column_dimensions['B'].width = 80
    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    return output, f"个人健康汇总-{data['period_start']}-{data['period_end']}.xlsx"
