# -*- coding: utf-8 -*-
"""个人健康目标、汇总、复盘和提醒接口。"""
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..services import health

router = APIRouter(prefix='/api/health')


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except health.HealthError as exc:
        raise HTTPException(400, str(exc)) from exc


class GoalBody(BaseModel):
    metric: str = Field(min_length=1)
    target_value: Optional[float] = None
    unit: str = ''
    note: str = ''
    enabled: bool = True


class GoalUpdate(BaseModel):
    metric: Optional[str] = None
    target_value: Optional[float] = None
    unit: Optional[str] = None
    note: Optional[str] = None
    enabled: Optional[bool] = None


class ReviewBody(BaseModel):
    period_type: str = 'month'
    period_start: str = ''
    period_end: str = ''
    summary: str = ''
    next_plan: str = ''
    metrics: dict = Field(default_factory=dict)


class ReminderBody(BaseModel):
    reminder_type: str = Field(min_length=1)
    enabled: bool = False
    remind_time: str = '21:00'
    message: str = ''


@router.get('/goals')
def list_goals():
    return {'goals': health.list_goals()}


@router.post('/goals')
def create_goal(body: GoalBody):
    return _call(health.create_goal, **body.model_dump())


@router.put('/goals/{goal_id}')
def update_goal(goal_id: int, body: GoalUpdate):
    return _call(health.update_goal, goal_id, **body.model_dump(exclude_unset=True))


@router.get('/summary')
def health_summary(period_type: str = 'month', period_start: str = '', period_end: str = ''):
    return _call(health.summary, period_type, period_start, period_end)


@router.get('/summary/export')
def export_health_summary(period_type: str = 'month', period_start: str = '', period_end: str = ''):
    try:
        buf, filename = health.export_summary(period_type, period_start, period_end)
    except health.HealthError as exc:
        raise HTTPException(400, str(exc)) from exc
    import urllib.parse
    quoted = urllib.parse.quote(filename)
    return StreamingResponse(
        buf,
        media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        headers={'Content-Disposition': f"attachment; filename*=UTF-8''{quoted}"},
    )


@router.post('/reviews/generate')
def generate_review(period_type: str = 'month', period_start: str = '', period_end: str = ''):
    return _call(health.generate_review, period_type, period_start, period_end)


@router.get('/reviews')
def list_reviews(limit: int = Query(50, ge=1, le=200)):
    return {'reviews': health.list_reviews(limit)}


@router.post('/reviews')
def save_review(body: ReviewBody):
    return _call(health.save_review, period_type=body.period_type, period_start=body.period_start,
                 period_end=body.period_end, summary_text=body.summary, next_plan=body.next_plan,
                 metrics=body.metrics)


@router.get('/reminders')
def list_reminders():
    return {'reminders': health.list_reminders()}


@router.post('/reminders')
def save_reminder(body: ReminderBody):
    return _call(health.save_reminder, **body.model_dump())
