# -*- coding: utf-8 -*-
"""结构化评语模板、批量生成、审核与交付接口。"""
import html
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from ..agent import comment_drafter
from ..services import class_context, comments as comments_service

router = APIRouter(prefix='/api/comments')


class CommentTemplateBody(BaseModel):
    name: str = Field(min_length=1)
    comment_type: str = '学期评语'
    content: str = Field(min_length=1)
    enabled: bool = True


class CommentTemplateUpdate(BaseModel):
    name: Optional[str] = None
    comment_type: Optional[str] = None
    content: Optional[str] = None
    enabled: Optional[bool] = None


class CommentGenerationBody(BaseModel):
    template_id: int
    student_ids: list[int] = []
    comment_type: str = ''
    confirm_missing: bool = False


class AICommentPreviewBody(BaseModel):
    student_ids: list[int] = Field(default_factory=list)
    comment_type: str = '学期评语'
    tone: str = '温和、客观、鼓励'
    length: str = '120-160字'
    instruction: str = ''


class AICommentSaveBody(BaseModel):
    rows: list[dict] = Field(default_factory=list)
    comment_type: str = '学期评语'
    model: str = ''
    period: dict = Field(default_factory=dict)


class CommentEntryBody(BaseModel):
    student_id: int
    comment_type: str = '学期评语'
    content: str = Field(min_length=1)
    note: str = ''


class CommentEntryUpdate(BaseModel):
    content: Optional[str] = None
    note: Optional[str] = None


class CommentTransitionBody(BaseModel):
    target_status: str
    note: str = ''
    delivery_method: str = ''


def _error(exc: comments_service.CommentError):
    message = str(exc)
    status = 404 if '不存在' in message or '不在当前' in message else 400
    raise HTTPException(status, message) from exc


@router.get('')
def get_comments(
    student_id: Optional[int] = None, comment_type: str = '', status: str = '',
    keyword: str = '', limit: int = Query(500, ge=1, le=5000),
):
    try:
        return {
            'summary': comments_service.summary(),
            'comments': comments_service.list_comments(
                student_id=student_id, comment_type=comment_type,
                status=status, keyword=keyword, limit=limit),
        }
    except comments_service.CommentError as exc:
        _error(exc)


@router.get('/templates')
def list_comment_templates(include_disabled: bool = False):
    try:
        return {'templates': comments_service.list_templates(include_disabled=include_disabled)}
    except comments_service.CommentError as exc:
        _error(exc)


@router.post('/templates')
def create_comment_template(body: CommentTemplateBody):
    try:
        return {'ok': True, 'template': comments_service.create_template(**body.model_dump())}
    except comments_service.CommentError as exc:
        _error(exc)


@router.put('/templates/{template_id}')
def update_comment_template(template_id: int, body: CommentTemplateUpdate):
    try:
        return {'ok': True, 'template': comments_service.update_template(
            template_id, **body.model_dump(exclude_none=True))}
    except comments_service.CommentError as exc:
        _error(exc)


@router.post('/generate/preview')
def preview_comment_generation(body: CommentGenerationBody):
    try:
        return comments_service.preview_generation(
            template_id=body.template_id, student_ids=body.student_ids,
            comment_type=body.comment_type)
    except comments_service.CommentError as exc:
        _error(exc)


@router.post('/generate')
def generate_comments(body: CommentGenerationBody):
    try:
        return {'ok': True, **comments_service.generate_batch(**body.model_dump())}
    except comments_service.CommentError as exc:
        _error(exc)


@router.post('/ai/preview')
async def preview_ai_comments(body: AICommentPreviewBody):
    try:
        return await comment_drafter.preview_generation(**body.model_dump())
    except comment_drafter.CommentAIDraftError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post('/ai/generate')
def generate_ai_comments(body: AICommentSaveBody):
    try:
        return {'ok': True, **comments_service.save_ai_drafts(**body.model_dump())}
    except comments_service.CommentError as exc:
        _error(exc)


@router.post('/entries')
def create_comment_entry(body: CommentEntryBody):
    try:
        return {'ok': True, 'comment': comments_service.create_comment(**body.model_dump())}
    except comments_service.CommentError as exc:
        _error(exc)


@router.put('/entries/{comment_id}')
def update_comment_entry(comment_id: int, body: CommentEntryUpdate):
    try:
        return {'ok': True, 'comment': comments_service.update_comment(
            comment_id, **body.model_dump(exclude_none=True))}
    except comments_service.CommentError as exc:
        _error(exc)


@router.post('/entries/{comment_id}/transition')
def transition_comment_entry(comment_id: int, body: CommentTransitionBody):
    try:
        return {'ok': True, 'comment': comments_service.transition_comment(
            comment_id, body.target_status, note=body.note,
            delivery_method=body.delivery_method)}
    except comments_service.CommentError as exc:
        _error(exc)


@router.get('/entries/{comment_id}/versions')
def get_comment_versions(comment_id: int):
    try:
        return {'versions': comments_service.comment_versions(comment_id)}
    except comments_service.CommentError as exc:
        _error(exc)


@router.get('/print', response_class=HTMLResponse)
def print_comments(student_id: Optional[int] = None, comment_type: str = '', status: str = ''):
    try:
        rows = comments_service.list_comments(
            student_id=student_id, comment_type=comment_type, status=status, limit=5000)
        scope = class_context.get_current_scope()
    except comments_service.CommentError as exc:
        _error(exc)
    title = f"{scope['class_name']} · {scope['term_name']} · 学生评语"
    cards = ''.join(
        '<article><h2>' + html.escape(item['student_name']) +
        '<small>' + html.escape(item.get('学号') or '') + '</small></h2>' +
        '<p>' + html.escape(item['content']).replace('\n', '<br>') + '</p>' +
        '<footer>' + html.escape(item['comment_type']) + ' · ' + html.escape(item['status']) + '</footer></article>'
        for item in rows
    ) or '<p class="empty">没有符合条件的评语。</p>'
    document = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <title>{html.escape(title)}</title><link rel="icon" href="/favicon.svg"><style>
    @page{{size:A4 portrait;margin:14mm}}
    body{{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#1d1d1f;margin:0}}
    header{{display:flex;justify-content:space-between;border-bottom:2px solid #5968bd;padding-bottom:12px;margin-bottom:20px}}
    header h1{{font-size:22px;margin:0}}header button{{padding:8px 14px}}
    article{{break-inside:avoid;border:1px solid #ddd;border-radius:10px;padding:18px;margin:0 0 14px}}
    h2{{font-size:17px;margin:0 0 12px}}h2 small{{font-size:12px;color:#777;margin-left:10px;font-weight:400}}
    p{{font-size:14px;line-height:1.8;margin:0}}footer{{font-size:11px;color:#777;margin-top:12px}}
    .empty{{text-align:center;color:#777}}@media print{{header button{{display:none}}article{{border-color:#aaa;break-inside:avoid}}}}
    </style></head><body><header><h1>{html.escape(title)}</h1><button onclick="window.print()">打印</button></header>{cards}</body></html>'''
    return HTMLResponse(document)
