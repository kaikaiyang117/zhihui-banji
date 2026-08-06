# -*- coding: utf-8 -*-
"""Agent 工具注册与参数边界。"""
from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Callable

from ..services.agent_read import (
    get_class_student_count,
    get_student_profile,
    get_student_timeline,
    search_students,
)


class ToolError(Exception):
    """工具不存在或参数不符合工具边界。"""


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., dict]
    read_only: bool = True

    def public_schema(self) -> dict[str, Any]:
        return {
            'name': self.name,
            'description': self.description,
            'parameters': self.parameters,
            'read_only': self.read_only,
        }

    def model_schema(self) -> dict[str, Any]:
        """转换为常见 OpenAI-compatible tool calling 格式。"""
        return {
            'type': 'function',
            'function': {
                'name': self.name,
                'description': self.description,
                'parameters': self.parameters,
            },
        }


class ToolRegistry:
    def __init__(self, tools: list[ToolDefinition] | None = None):
        self._tools: dict[str, ToolDefinition] = {}
        for tool in tools or []:
            self.register(tool)

    def register(self, tool: ToolDefinition):
        if tool.name in self._tools:
            raise ToolError(f'工具已注册：{tool.name}')
        self._tools[tool.name] = tool

    def list(self) -> list[dict[str, Any]]:
        return [self._tools[name].public_schema() for name in sorted(self._tools)]

    def model_tools(self) -> list[dict[str, Any]]:
        return [self._tools[name].model_schema() for name in sorted(self._tools)]

    def execute(self, name: str, arguments: dict[str, Any] | None = None) -> dict:
        tool = self._tools.get(name)
        if not tool:
            raise ToolError(f'工具不存在：{name}')
        arguments = arguments or {}
        if not isinstance(arguments, dict):
            raise ToolError('工具参数必须是对象')

        signature = inspect.signature(tool.handler)
        accepted = set(signature.parameters)
        unknown = sorted(set(arguments) - accepted)
        if unknown:
            raise ToolError(f'工具参数不支持：{", ".join(unknown)}')
        missing = [
            key for key, parameter in signature.parameters.items()
            if parameter.default is inspect.Parameter.empty and key not in arguments
        ]
        if missing:
            raise ToolError(f'缺少工具参数：{", ".join(missing)}')
        try:
            return tool.handler(**arguments)
        except (TypeError, ValueError) as exc:
            raise ToolError(str(exc)) from exc


def build_registry() -> ToolRegistry:
    return ToolRegistry([
        ToolDefinition(
            name='class_student_count',
            description='查询当前工作台班级的学生总人数。用户问班级有多少人、多少名学生、学生总数时必须使用此工具。',
            parameters={
                'type': 'object',
                'properties': {},
                'additionalProperties': False,
            },
            handler=get_class_student_count,
        ),
        ToolDefinition(
            name='students_search',
            description='按姓名或学号搜索学生，只返回基础班级信息。',
            parameters={
                'type': 'object',
                'properties': {
                    'keyword': {'type': 'string', 'description': '姓名或学号，可为空'},
                    'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100, 'default': 20},
                },
                'additionalProperties': False,
            },
            handler=search_students,
        ),
        ToolDefinition(
            name='student_get_profile',
            description='根据学生 ID 查询学生档案。',
            parameters={
                'type': 'object',
                'properties': {'student_id': {'type': 'integer', 'minimum': 1}},
                'required': ['student_id'],
                'additionalProperties': False,
            },
            handler=get_student_profile,
        ),
        ToolDefinition(
            name='student_get_timeline',
            description='查询学生的事件、家校沟通和待办时间线。',
            parameters={
                'type': 'object',
                'properties': {
                    'student_id': {'type': 'integer', 'minimum': 1},
                    'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100, 'default': 30},
                },
                'required': ['student_id'],
                'additionalProperties': False,
            },
            handler=get_student_timeline,
        ),
    ])
