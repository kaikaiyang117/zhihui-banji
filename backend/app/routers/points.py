# -*- coding: utf-8 -*-
"""结构化行为积分接口。"""
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..services import points as points_service

router = APIRouter(prefix='/api/points')


class PointEntryBody(BaseModel):
    student_id: int
    amount: float
    occurred_at: str = ''
    category: str = '日常行为'
    reason: str = Field(min_length=1)
    rule_id: Optional[int] = None


class PointRevokeBody(BaseModel):
    reason: str = Field(min_length=1)


class PointRuleBody(BaseModel):
    name: str = Field(min_length=1)
    category: str = '日常行为'
    metric: str = '周期扣分'
    threshold: float = Field(default=5, gt=0)
    period_days: int = Field(default=7, ge=1, le=365)
    priority: str = '重要'
    enabled: bool = True


class PointRuleUpdate(BaseModel):
    enabled: Optional[bool] = None
    threshold: Optional[float] = Field(default=None, gt=0)
    period_days: Optional[int] = Field(default=None, ge=1, le=365)
    priority: Optional[str] = None
    category: Optional[str] = None


class PointRuleEvaluateBody(BaseModel):
    reference_date: str = ''


def _error(exc: points_service.PointsError):
    status = 404 if '不存在' in str(exc) or '不在当前' in str(exc) else 400
    raise HTTPException(status, str(exc)) from exc


@router.get('')
def get_points(
    student_id: Optional[int] = None,
    date_from: str = '',
    date_to: str = '',
    status: str = '',
    include_legacy: bool = True,
    limit: int = Query(500, ge=1, le=5000),
):
    try:
        return {
            'summary': points_service.class_summary(),
            'entries': points_service.list_entries(
                student_id=student_id, date_from=date_from, date_to=date_to,
                status=status, include_legacy=include_legacy, limit=limit),
        }
    except points_service.PointsError as exc:
        _error(exc)


@router.post('/entries')
def create_point_entry(body: PointEntryBody):
    try:
        return {'ok': True, 'entry': points_service.create_entry(**body.model_dump())}
    except points_service.PointsError as exc:
        _error(exc)


@router.post('/entries/{entry_id}/revoke')
def revoke_point_entry(entry_id: int, body: PointRevokeBody):
    try:
        return {'ok': True, 'entry': points_service.revoke_entry(entry_id, body.reason)}
    except points_service.PointsError as exc:
        _error(exc)


@router.get('/rules')
def list_point_rules(include_disabled: bool = False):
    try:
        return {'rules': points_service.list_rules(include_disabled=include_disabled)}
    except points_service.PointsError as exc:
        _error(exc)


@router.post('/rules')
def create_point_rule(body: PointRuleBody):
    try:
        return {'ok': True, 'rule': points_service.create_rule(**body.model_dump())}
    except points_service.PointsError as exc:
        _error(exc)


@router.put('/rules/{rule_id}')
def update_point_rule(rule_id: int, body: PointRuleUpdate):
    try:
        return {'ok': True, 'rule': points_service.update_rule(
            rule_id, **body.model_dump(exclude_none=True))}
    except points_service.PointsError as exc:
        _error(exc)


@router.post('/rules/evaluate')
def evaluate_point_rules(body: PointRuleEvaluateBody | None = None):
    try:
        return points_service.evaluate_rules(reference_date=body.reference_date if body else '')
    except points_service.PointsError as exc:
        _error(exc)


@router.get('/rule-hits')
def list_point_rule_hits(status: str = '', limit: int = Query(200, ge=1, le=5000)):
    try:
        return {'hits': points_service.list_rule_hits(status=status, limit=limit)}
    except points_service.PointsError as exc:
        _error(exc)
