# -*- coding: utf-8 -*-
"""Agent 结构化规划：只描述目标、步骤和依赖，不保存隐式思维链。"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from .model_client import ModelResponse, OpenAICompatibleClient
from .tool_registry import ToolRegistry


MAX_PLAN_STEPS = 6
ALLOWED_CONDITIONS = {'exactly_one_student', 'student_found'}


class PlanningError(ValueError):
    """计划格式、工具或依赖不合法。"""


@dataclass(frozen=True)
class PlanStep:
    id: str
    tool: str
    arguments: dict[str, Any]
    depends_on: tuple[str, ...] = ()
    condition: str = ''


@dataclass(frozen=True)
class AgentPlan:
    goal: str
    steps: tuple[PlanStep, ...]

    @classmethod
    def from_payload(cls, payload: Any, registry: ToolRegistry) -> 'AgentPlan':
        if isinstance(payload, dict) and isinstance(payload.get('plan'), dict):
            payload = payload['plan']
        if not isinstance(payload, dict):
            raise PlanningError('计划必须是对象')
        goal = str(payload.get('goal') or '').strip()
        raw_steps = payload.get('steps')
        if not goal or not isinstance(raw_steps, list) or not raw_steps:
            raise PlanningError('计划必须包含目标和步骤')
        if len(raw_steps) > MAX_PLAN_STEPS:
            raise PlanningError(f'计划步骤不能超过 {MAX_PLAN_STEPS} 步')

        steps: list[PlanStep] = []
        seen: set[str] = set()
        for raw in raw_steps:
            if not isinstance(raw, dict):
                raise PlanningError('计划步骤格式不正确')
            step_id = str(raw.get('id') or '').strip()
            tool_name = str(raw.get('tool') or '').strip()
            arguments = raw.get('arguments', {})
            dependencies = raw.get('depends_on', [])
            condition = str(raw.get('condition') or '').strip()
            if not step_id or step_id in seen:
                raise PlanningError('计划步骤 ID 必须唯一')
            if not registry.get(tool_name):
                raise PlanningError(f'计划使用了不存在的工具：{tool_name}')
            if not isinstance(arguments, dict):
                raise PlanningError(f'步骤 {step_id} 的参数必须是对象')
            if not isinstance(dependencies, list) or any(not isinstance(item, str) for item in dependencies):
                raise PlanningError(f'步骤 {step_id} 的依赖格式不正确')
            if condition and condition not in ALLOWED_CONDITIONS:
                raise PlanningError(f'步骤 {step_id} 使用了不支持的条件')
            if any(item not in seen for item in dependencies):
                raise PlanningError(f'步骤 {step_id} 依赖了尚未定义的步骤')
            steps.append(PlanStep(
                id=step_id,
                tool=tool_name,
                arguments=arguments,
                depends_on=tuple(dependencies),
                condition=condition,
            ))
            seen.add(step_id)
        return cls(goal=goal, steps=tuple(steps))


class AgentPlanner:
    """生成并校验计划；模型只负责提出计划，执行由 AgentRunner 完成。"""

    def __init__(self, model_client: OpenAICompatibleClient):
        self.model_client = model_client

    async def create(
        self,
        text: str,
        registry: ToolRegistry,
        context: str = '',
    ) -> AgentPlan:
        response = await self.model_client.complete(
            [
                {'role': 'system', 'content': _planner_prompt(registry)},
                {'role': 'user', 'content': _planner_input(text, context)},
            ],
            None,
        )
        return self._from_response(response, registry)

    async def create_stream(
        self,
        text: str,
        registry: ToolRegistry,
        context: str = '',
    ) -> AgentPlan:
        response = None
        async for event in self.model_client.iter_complete(
            [
                {'role': 'system', 'content': _planner_prompt(registry)},
                {'role': 'user', 'content': _planner_input(text, context)},
            ],
            None,
        ):
            if event.response:
                response = event.response
        if response is None:
            raise PlanningError('规划器没有返回最终结果')
        return self._from_response(response, registry)

    @staticmethod
    def _from_response(response: ModelResponse, registry: ToolRegistry) -> AgentPlan:
        if response.tool_calls:
            return AgentPlan.from_payload(_tool_calls_to_payload(response), registry)
        return AgentPlan.from_payload(_parse_json(response.content), registry)


def build_rule_plan(text: str, registry: ToolRegistry) -> AgentPlan | None:
    """为明确的学生查询建立确定性计划，避免学号被误当成数据库 id。"""
    if not _is_student_lookup(text):
        return None
    keyword = _extract_student_keyword(text)
    if not keyword:
        return None

    target_tools = []
    if any(term in text for term in ('成绩', '分数', '考试', '排名')):
        target_tools.append('scores_summary')
    if any(term in text for term in ('考勤', '出勤', '迟到', '请假', '缺勤')):
        target_tools.append('attendance_summary')
    if any(term in text for term in ('待办', '任务', '跟进')):
        target_tools.append('tasks_list')
    if any(term in text for term in ('沟通', '家长联系', '家校')):
        target_tools.append('communications_list')
    if not target_tools:
        target_tools.append('student_get_profile')
    steps = [{
        'id': 'search_student',
        'tool': 'students_search',
        'arguments': {'keyword': keyword, 'limit': 20},
    }]
    for index, target_tool in enumerate(target_tools, 1):
        steps.append({
            'id': f'query_student_data_{index}',
            'tool': target_tool,
            'arguments': {'student_id': '$search_student.students[0].id'},
            'depends_on': ['search_student'],
            'condition': 'exactly_one_student',
        })
    return AgentPlan.from_payload({
        'goal': text.strip(),
        'steps': steps,
    }, registry)


def _is_student_lookup(text: str) -> bool:
    return (
        (any(term in text for term in ('学生', '同学', '学号'))
         or bool(re.search(r'(?<!\d)\d{2,}(?!\d)', text)))
        and any(term in text for term in ('查看', '查询', '了解', '详细', '档案', '信息', '成绩', '考勤', '待办', '沟通'))
    )


def _extract_student_keyword(text: str) -> str:
    token = r'([0-9A-Za-z_-]+|[\u4e00-\u9fff]{2,8})'
    patterns = (
        rf'(?:学生|同学|学号)\s*{token}',
        rf'(?:查看|查询|了解)\s*{token}',
    )
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            keyword = match.group(1).strip()
            if (keyword.startswith('的') or '学生' in keyword or '同学' in keyword
                    or keyword in {'信息', '详细信息', '基本信息'}):
                continue
            return keyword
    return ''


def _planner_prompt(registry: ToolRegistry) -> str:
    tools = []
    for tool in registry.list():
        tools.append({
            'name': tool['name'],
            'description': tool['description'],
            'parameters': tool['parameters'],
        })
    schema = {
        'goal': '一句话描述要完成的查询目标',
        'steps': [
            {
                'id': '唯一的小写步骤名',
                'tool': '工具名',
                'arguments': {'参数': '值或 $步骤名.结果路径'},
                'depends_on': ['前置步骤 id'],
                'condition': '可选：exactly_one_student 或 student_found',
            },
        ],
    }
    return '''你是“凯凯小兵”的任务规划器，不直接回答用户。
请把用户请求拆成最多 6 个只读工具步骤，并且只输出 JSON，不要 Markdown、解释或思维过程。
步骤必须按依赖顺序排列；涉及具体学生时先 students_search，再使用搜索结果中的 id。
如果搜索结果不唯一，依赖学生 id 的步骤使用 condition="exactly_one_student"。
工具结果引用格式为 $步骤id.结果字段[0].字段名。

JSON 格式示例：
''' + json.dumps(schema, ensure_ascii=False) + '''

可用工具：
''' + json.dumps(tools, ensure_ascii=False)


def _planner_input(text: str, context: str) -> str:
    if context:
        return f'最近上下文：\n{context}\n\n当前请求：\n{text}'
    return text


def _tool_calls_to_payload(response: ModelResponse) -> dict[str, Any]:
    return {
        'goal': '根据用户请求完成数据查询',
        'steps': [
            {
                'id': f'tool_step_{index + 1}',
                'tool': call.name,
                'arguments': _parse_json(call.arguments or '{}'),
            }
            for index, call in enumerate(response.tool_calls)
        ],
    }


def _parse_json(content: str) -> Any:
    text = str(content or '').strip()
    if text.startswith('```'):
        text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text, flags=re.IGNORECASE | re.DOTALL).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find('{'), text.rfind('}')
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
        raise PlanningError('模型没有返回有效的 JSON 计划')
