# -*- coding: utf-8 -*-
"""个人工作台的日期聚合：把校历和未完成工作项组织成近期可执行安排。"""
from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime, timedelta

from .. import clock
from . import school_calendar, work_items


WEEKDAYS = ('周一', '周二', '周三', '周四', '周五', '周六', '周日')


def _month_start(value: date) -> date:
    return value.replace(day=1)


def _month_from_query(value: str, fallback: date) -> date:
    text = str(value or '').strip()
    if not text:
        return _month_start(fallback)
    try:
        return datetime.strptime(f'{text[:7]}-01', '%Y-%m-%d').date()
    except ValueError as exc:
        raise ValueError('月份格式必须为 YYYY-MM') from exc


def calendar(*, reference_date: date | None = None, month: str = '', conn=None) -> dict:
    reference_date = reference_date or clock.today()
    start = _month_from_query(month, reference_date)
    end = start.replace(day=monthrange(start.year, start.month)[1])
    window_end = max(end, reference_date + timedelta(days=7))

    school_data = school_calendar.list_calendar(
        date_from=start.isoformat(), date_to=window_end.isoformat())
    entries_by_date = {
        row['calendar_date']: row for row in school_data['entries']
    }
    tasks = work_items.list_work_items(
        bucket='open', date_from=start.isoformat(), date_to=window_end.isoformat(),
        reference_date=reference_date, limit=100, conn=conn)
    tasks_by_date: dict[str, list[dict]] = {}
    for task in tasks:
        task_date = task.get('calendar_date', '')
        if task_date:
            tasks_by_date.setdefault(task_date, []).append(task)

    days = []
    current = start
    while current <= end:
        iso = current.isoformat()
        entry = entries_by_date.get(iso)
        day_tasks = tasks_by_date.get(iso, [])
        days.append({
            'date': iso,
            'day': current.day,
            'weekday': current.weekday(),
            'weekday_label': WEEKDAYS[current.weekday()],
            'is_today': current == reference_date,
            'school_calendar': entry,
            'tasks': day_tasks,
            'task_count': len(day_tasks),
            'has_plan': bool(entry or day_tasks),
        })
        current += timedelta(days=1)

    upcoming = []
    current = reference_date + timedelta(days=1)
    upcoming_end = reference_date + timedelta(days=7)
    while current <= upcoming_end:
        iso = current.isoformat()
        entry = entries_by_date.get(iso)
        day_tasks = tasks_by_date.get(iso, [])
        items = []
        if entry and (entry.get('title') or entry.get('day_type') not in {'上课日', '放假日'}):
            items.append({
                'kind': '校历',
                'title': entry.get('title') or entry.get('day_type') or '校历安排',
                'meta': '上课日' if entry.get('is_school_day') else '非上课日',
            })
        items.extend({
            'kind': '待办',
            'title': task.get('title') or '未命名事项',
            'meta': task.get('student_name') or task.get('source_label') or '班级事务',
            'task': task,
        } for task in day_tasks)
        upcoming.append({
            'date': iso,
            'day': current.day,
            'weekday_label': WEEKDAYS[current.weekday()],
            'school_calendar': entry,
            'tasks': day_tasks,
            'items': items,
            'item_count': len(items),
        })
        current += timedelta(days=1)

    return {
        'month': start.strftime('%Y-%m'),
        'month_title': f'{start.year}年{start.month}月',
        'start_date': start.isoformat(),
        'end_date': end.isoformat(),
        'days': days,
        'upcoming': upcoming,
        'summary': {
            'month_tasks': sum(day['task_count'] for day in days),
            'month_special': sum(
                bool(day['school_calendar'] and (
                    day['school_calendar'].get('title') or
                    day['school_calendar'].get('day_type') not in {'上课日', '放假日'}
                )) for day in days
            ),
            'upcoming_items': sum(item['item_count'] for item in upcoming),
        },
    }
