# -*- coding: utf-8 -*-
"""通过共享 Agent 模型客户端生成学生学期评语草稿。"""
from __future__ import annotations

import json
import re

from .model_client import ModelError, ModelResponse, OpenAICompatibleClient
from ..services import comment_ai


class CommentAIDraftError(ValueError):
    pass


def _text(value) -> str:
    return str(value or '').strip()


def _clip(value, limit=120) -> str:
    text = _text(value)
    return text if len(text) <= limit else text[:limit - 1] + '…'


def _parse_json(content: str) -> dict:
    raw = re.sub(r'^```(?:json)?\s*|\s*```$', '', _text(content), flags=re.IGNORECASE | re.DOTALL).strip()
    start, end = raw.find('{'), raw.rfind('}')
    if start < 0 or end <= start:
        raise CommentAIDraftError('AI返回内容不是有效的结构化评语结果')
    try:
        data = json.loads(raw[start:end + 1])
    except json.JSONDecodeError as exc:
        raise CommentAIDraftError('AI返回内容无法解析为评语结果') from exc
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        raise CommentAIDraftError('AI返回结果缺少评语列表')
    return data


async def preview_generation(*, student_ids: list[int] | None = None, comment_type: str = '学期评语',
                             tone: str = '温和、客观、鼓励', length: str = '120-160字', instruction: str = '',
                             model_client=None, conn=None) -> dict:
    if comment_type != '学期评语':
        raise CommentAIDraftError('AI学期评语暂只支持“学期评语”类型')
    try:
        contexts = comment_ai.build_student_term_contexts(student_ids, conn=conn)
    except comment_ai.CommentAIError as exc:
        raise CommentAIDraftError(str(exc)) from exc
    if not contexts:
        raise CommentAIDraftError('请至少选择一名学生')
    if len(contexts) > 30:
        raise CommentAIDraftError('一次最多生成30名学生的评语')
    client = model_client or OpenAICompatibleClient()
    system = (
        '你是高中班主任的评语助手。只能根据用户提供的学生学期事实生成评语草稿，绝不补充不存在的事实。'
        '使用中文，客观、具体、尊重学生；避免同学比较、排名、医学或心理诊断、家庭隐私和标签化判断；'
        '正常出勤不要逐日罗列；行为积分只作为行为记录参考，不计算奖学金或综合分数；数据不足时省略对应判断。'
        '输出严格 JSON，不要 Markdown：{"items":[{"student_id":1,"content":"评语草稿","evidence":["成绩：..."],"warnings":[]}] }。每名学生必须返回一条。'
    )
    user = {
        '任务': '生成本学期学生评语草稿', '评语类型': comment_type, '语言风格': tone,
        '建议字数': length, '老师补充要求': _clip(instruction, 300), '学生学期事实': contexts,
    }
    try:
        response: ModelResponse = await client.complete([
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': json.dumps(user, ensure_ascii=False)},
        ])
    except ModelError as exc:
        raise CommentAIDraftError(str(exc)) from exc
    data = _parse_json(response.content)
    context_by_id = {int(item['student_id']): item for item in contexts}
    rows = []
    for item in data['items']:
        try:
            student_id = int(item.get('student_id'))
        except (TypeError, ValueError):
            continue
        context = context_by_id.get(student_id)
        content = _clip(item.get('content'), 500)
        if not context or not content:
            continue
        rows.append({
            'student_id': student_id, '学号': context['学号'], '姓名': context['姓名'], 'content': content,
            'evidence': [str(value) for value in item.get('evidence', [])][:6],
            'warnings': [str(value) for value in item.get('warnings', [])][:6], 'coverage': context['coverage'],
        })
    returned_ids = {int(row['student_id']) for row in rows}
    for context in contexts:
        if int(context['student_id']) not in returned_ids:
            rows.append({
                'student_id': int(context['student_id']), '学号': context['学号'], '姓名': context['姓名'],
                'content': '', 'evidence': [], 'warnings': ['AI未返回评语，请手工填写或重新生成'],
                'coverage': context['coverage'],
            })
    return {
        'comment_type': comment_type, 'model': getattr(getattr(client, 'config', None), 'model', ''),
        'period': contexts[0]['period'], 'rows': rows,
        'summary': {
            'requested': len(contexts), 'generated': sum(1 for row in rows if row['content']),
            'warnings': sum(1 for row in rows if row['warnings']),
            'low_coverage': sum(1 for row in rows if row['coverage']['source_count'] == 0),
        },
    }
