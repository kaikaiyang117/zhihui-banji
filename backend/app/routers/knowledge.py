# -*- coding: utf-8 -*-
"""知识库 Markdown 站内管理 API。"""
from fastapi import APIRouter, HTTPException

from ..services import knowledge

router = APIRouter(prefix='/api/knowledge')


def _error(exc: knowledge.KnowledgeError):
    status = 409 if isinstance(exc, knowledge.KnowledgeConflict) else 400
    raise HTTPException(status, str(exc)) from exc


@router.get('/notes')
def list_notes(query: str = '', tag: str = '', category: str = ''):
    try:
        return knowledge.list_notes(query=query, tag=tag, category=category)
    except knowledge.KnowledgeError as exc:
        _error(exc)


@router.get('/notes/read')
def read_note(path: str):
    try:
        return knowledge.read_note(path)
    except knowledge.KnowledgeError as exc:
        _error(exc)


@router.post('/create')
def create_note(body: dict):
    try:
        return knowledge.create_note(
            title=body.get('title', ''), category=body.get('category', '个人成长'),
            template=body.get('template', ''), content=body.get('content', ''),
            tags=body.get('tags') or [], links=body.get('links') or [],
        )
    except knowledge.KnowledgeError as exc:
        _error(exc)


@router.put('/notes/{note_id}')
def update_note(note_id: int, body: dict):
    try:
        return knowledge.update_note(
            note_id, content=body.get('content', ''), expected_hash=body.get('expected_hash', ''),
            force=bool(body.get('force', False)), title=body.get('title', ''),
            category=body.get('category', ''), tags=body.get('tags'), links=body.get('links'),
        )
    except knowledge.KnowledgeError as exc:
        _error(exc)


@router.post('/notes/{note_id}/adopt')
def adopt_external_change(note_id: int):
    try:
        return knowledge.adopt_external_change(note_id)
    except knowledge.KnowledgeError as exc:
        _error(exc)


@router.post('/sync')
def sync_notes():
    try:
        return knowledge.list_notes()
    except knowledge.KnowledgeError as exc:
        _error(exc)
