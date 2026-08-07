# -*- coding: utf-8 -*-
"""班级、学期和在班关系 API。"""
import sqlite3
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services import class_context

router = APIRouter(prefix='/api')


class ClassCreate(BaseModel):
    name: str = Field(min_length=1)
    grade: str = ''
    term_name: str = Field(default='默认学期', min_length=1)
    start_date: str = ''
    end_date: str = ''


class ClassUpdate(BaseModel):
    name: Optional[str] = None
    grade: Optional[str] = None
    status: Optional[str] = None


class TermCreate(BaseModel):
    name: str = Field(min_length=1)
    start_date: str = ''
    end_date: str = ''


class TermUpdate(BaseModel):
    name: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    status: Optional[str] = None


class RolloverBody(BaseModel):
    name: str = Field(min_length=1)
    start_date: str = ''
    end_date: str = ''
    archive_source: bool = True


class EnrollmentBody(BaseModel):
    student_id: int
    status: str = '在读'


class EnrollmentUpdate(BaseModel):
    status: str


class EnrollmentTransfer(BaseModel):
    target_class_id: int
    target_term_id: int


def _run(action):
    try:
        return action()
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, '名称或在班关系已存在') from exc
    except class_context.ArchivedScopeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except class_context.ScopeError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/context')
def get_context():
    return _run(class_context.list_contexts)


@router.post('/classes')
def create_class(body: ClassCreate):
    result = _run(lambda: class_context.create_class(
        body.name, body.grade, body.term_name, body.start_date, body.end_date))
    return {'ok': True, **result}


@router.put('/classes/{class_id}')
def update_class(class_id: int, body: ClassUpdate):
    _run(lambda: class_context.update_class(
        class_id, name=body.name, grade=body.grade, status=body.status))
    return {'ok': True}


@router.post('/classes/{class_id}/terms')
def create_term(class_id: int, body: TermCreate):
    term_id = _run(lambda: class_context.create_term(
        class_id, body.name, body.start_date, body.end_date))
    return {'ok': True, 'term_id': term_id}


@router.put('/terms/{term_id}')
def update_term(term_id: int, body: TermUpdate):
    _run(lambda: class_context.update_term(
        term_id, name=body.name, start_date=body.start_date,
        end_date=body.end_date, status=body.status))
    return {'ok': True}


@router.post('/terms/{term_id}/rollover')
def rollover_term(term_id: int, body: RolloverBody):
    result = _run(lambda: class_context.rollover_term(
        term_id, body.name, body.start_date, body.end_date, body.archive_source))
    return {'ok': True, **result}


@router.get('/enrollments')
def list_enrollments():
    return {'enrollments': _run(class_context.list_enrollments)}


@router.post('/enrollments')
def create_enrollment(body: EnrollmentBody):
    enrollment_id = _run(lambda: class_context.enroll_student(
        body.student_id, status=body.status))
    return {'ok': True, 'enrollment_id': enrollment_id}


@router.put('/enrollments/{enrollment_id}')
def update_enrollment(enrollment_id: int, body: EnrollmentUpdate):
    _run(lambda: class_context.update_enrollment(enrollment_id, body.status))
    return {'ok': True}


@router.post('/enrollments/{enrollment_id}/transfer')
def transfer_enrollment(enrollment_id: int, body: EnrollmentTransfer):
    target_id = _run(lambda: class_context.transfer_enrollment(
        enrollment_id, body.target_class_id, body.target_term_id))
    return {'ok': True, 'enrollment_id': target_id}
