# -*- coding: utf-8 -*-
"""使用共享模型客户端生成班级学期档案草稿。"""
from __future__ import annotations

import json
import re

from .model_client import ModelError, ModelResponse, OpenAICompatibleClient


class ReportAIDraftError(ValueError):
    pass


def _text(value) -> str:
    return str(value or '').strip()


def _clip(value, limit=240) -> str:
    text = _text(value)
    return text if len(text) <= limit else text[:limit - 1] + '…'


def _parse_json(content: str) -> dict:
    raw = re.sub(r'^```(?:json)?\s*|\s*```$', '', _text(content), flags=re.IGNORECASE | re.DOTALL).strip()
    start, end = raw.find('{'), raw.rfind('}')
    if start < 0 or end <= start:
        raise ReportAIDraftError('AI返回内容不是有效的结构化档案草稿')
    try:
        data = json.loads(raw[start:end + 1])
    except json.JSONDecodeError as exc:
        raise ReportAIDraftError('AI返回内容无法解析为档案草稿') from exc
    required = ('class_summary', 'next_term_plan', 'teacher_summary')
    if not isinstance(data, dict) or any(not isinstance(data.get(key), str) for key in required):
        raise ReportAIDraftError('AI返回结果缺少完整的档案草稿字段')
    return data


def _context(report: dict) -> dict:
    analysis = report.get('analysis') or {}
    academic = dict(analysis.get('academic') or {})
    # 学生姓名只保留在页面的班主任内部区域，不发送给 AI 生成公开总结。
    academic['improved_student_count'] = len(academic.pop('improved_students', []) or [])
    academic['declined_student_count'] = len(academic.pop('declined_students', []) or [])
    sections = report.get('sections') or {}
    education_materials = {
        'meetings': [
            {'date': row.get('date'), 'title': row.get('title'), 'conclusion': _clip(row.get('conclusion'))}
            for row in (sections.get('meetings') or [])[:12]
        ],
        'activities': [
            {'date': row.get('date'), 'title': row.get('title'), 'result': _clip(row.get('result')), 'retrospective': _clip(row.get('retrospective'))}
            for row in (sections.get('activities') or [])[:12]
        ],
        'diary': [
            {'date': row.get('date'), 'work': _clip(row.get('work')), 'event': _clip(row.get('event')), 'reflection': _clip(row.get('reflection'))}
            for row in (sections.get('diary') or [])[:12]
        ],
    }
    return {
        'scope': report.get('scope', {}),
        'period': {'start': report.get('period_start'), 'end': report.get('period_end')},
        'metrics': report.get('metrics', {}),
        'analysis': {'class_overview': analysis.get('class_overview', {}), 'academic': academic,
                     'attendance': analysis.get('attendance', {}), 'tasks': analysis.get('tasks', {})},
        'education_materials': education_materials,
        'data_notes': report.get('data_notes', []),
    }


async def generate_draft(*, report: dict, instruction: str = '', model_client=None) -> dict:
    client = model_client or OpenAICompatibleClient()
    system = (
        '你是高中班主任的学期总结助手。只能根据提供的结构化事实和教育记录生成草稿，绝不补充不存在的事实。'
        '输出中文，表达具体、克制、尊重学生；不要公开点名、排名或给学生贴标签，不做心理或医学诊断。'
        '班级整体表现要说明已知事实和需要老师判断的部分；下学期计划要可执行；班主任总结要有温度但不能空泛。'
        '如果数据不足，明确写“待老师补充”，不要猜测。只输出严格 JSON，不要 Markdown：'
        '{"class_summary":"...","next_term_plan":"...","teacher_summary":"...","evidence":["..."],"warnings":["..."]}'
    )
    user = {
        '任务': '生成高中班主任学期档案的三段草稿',
        '老师补充要求': _clip(instruction, 500),
        '事实与统计': _context(report),
    }
    try:
        response: ModelResponse = await client.complete([
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': json.dumps(user, ensure_ascii=False)},
        ])
    except ModelError as exc:
        raise ReportAIDraftError(str(exc)) from exc
    data = _parse_json(response.content)
    return {
        'draft': {key: _clip(data.get(key), 5000) for key in ('class_summary', 'next_term_plan', 'teacher_summary')},
        'evidence': [_clip(item, 180) for item in data.get('evidence', []) if _text(item)][:8],
        'warnings': [_clip(item, 180) for item in data.get('warnings', []) if _text(item)][:8],
        'model': getattr(getattr(client, 'config', None), 'model', ''),
    }
