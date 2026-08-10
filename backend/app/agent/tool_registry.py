# -*- coding: utf-8 -*-
"""Agent 工具注册与参数边界。"""
from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Callable

from ..services.agent_read import (
    get_attendance_summary,
    get_class_student_count,
    get_communications_list,
    get_school_calendar,
    get_scores_summary,
    get_student_profile,
    get_student_term_comment_context,
    get_student_timeline,
    aggregate_students,
    get_tasks_list,
    query_students,
    search_students,
)


class ToolError(Exception):
    """工具不存在或参数不符合工具边界。"""

    def __init__(self, message: str, *, code: str = 'tool_error', retryable: bool = False, auto_retry: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.auto_retry = auto_retry


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., dict]
    read_only: bool = True
    sensitive: bool = False
    write_action: bool = False

    def public_schema(self) -> dict[str, Any]:
        return {
            'name': self.name,
            'description': self.description,
            'parameters': self.parameters,
            'read_only': self.read_only,
            'sensitive': self.sensitive,
            'write_action': self.write_action,
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

    def get(self, name: str) -> ToolDefinition | None:
        return self._tools.get(name)

    def execute(self, name: str, arguments: dict[str, Any] | None = None) -> dict:
        tool = self._tools.get(name)
        if not tool:
            raise ToolError(f'工具不存在：{name}', code='unknown_tool', retryable=True)
        arguments = arguments or {}
        if not isinstance(arguments, dict):
            raise ToolError('工具参数必须是对象', code='invalid_arguments', retryable=True)
        if tool.write_action:
            raise ToolError('写入工具必须先生成操作预览并获得用户确认', code='confirmation_required')

        signature = inspect.signature(tool.handler)
        accepted = set(signature.parameters)
        unknown = sorted(set(arguments) - accepted)
        if unknown:
            raise ToolError(
                f'工具参数不支持：{", ".join(unknown)}',
                code='invalid_arguments',
                retryable=True,
            )
        missing = [
            key for key, parameter in signature.parameters.items()
            if parameter.default is inspect.Parameter.empty and key not in arguments
        ]
        if missing:
            raise ToolError(
                f'缺少工具参数：{", ".join(missing)}',
                code='invalid_arguments',
                retryable=True,
            )
        try:
            return tool.handler(**arguments)
        except (TypeError, ValueError) as exc:
            raise ToolError(str(exc), code='invalid_arguments', retryable=True) from exc
        except Exception as exc:
            raise ToolError(
                f'工具执行失败：{exc}',
                code='execution_error',
                retryable=True,
                auto_retry=True,
            ) from exc


def build_registry() -> ToolRegistry:
    tools = [
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
            name='attendance_summary',
            description='查询全班或指定学生的考勤统计。可按日期范围筛选，适合回答出勤、迟到、请假、缺勤问题。',
            parameters={
                'type': 'object',
                'properties': {
                    'student_id': {'type': 'integer', 'minimum': 1},
                    'date_from': {'type': 'string', 'description': '起始日期 YYYY-MM-DD，可为空'},
                    'date_to': {'type': 'string', 'description': '结束日期 YYYY-MM-DD，可为空'},
                    'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100, 'default': 30},
                },
                'additionalProperties': False,
            },
            handler=get_attendance_summary,
        ),
        ToolDefinition(
            name='scores_summary',
            description='查询全班或指定学生的考试成绩、科目分数和总分。',
            parameters={
                'type': 'object',
                'properties': {
                    'student_id': {'type': 'integer', 'minimum': 1},
                    'exam_name': {'type': 'string', 'description': '考试名称，可为空'},
                    'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100, 'default': 20},
                },
                'additionalProperties': False,
            },
            handler=get_scores_summary,
        ),
        ToolDefinition(
            name='tasks_list',
            description='查询待办、逾期事项和学生跟进任务，默认只返回未完成事项。',
            parameters={
                'type': 'object',
                'properties': {
                    'status': {'type': 'string', 'description': '待处理、处理中、待复查等状态，可为空'},
                    'student_id': {'type': 'integer', 'minimum': 1},
                    'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100, 'default': 20},
                },
                'additionalProperties': False,
            },
            handler=get_tasks_list,
        ),
        ToolDefinition(
            name='school_calendar_query',
            description='查询当前学期校历中的上课日、放假日、调休、考试和活动安排。用户询问校历、哪天上课、哪天放假、调休或考试安排时必须使用此工具。',
            parameters={
                'type': 'object',
                'properties': {
                    'date_from': {'type': 'string', 'description': '起始日期 YYYY-MM-DD，可为空'},
                    'date_to': {'type': 'string', 'description': '结束日期 YYYY-MM-DD，可为空'},
                    'day_type': {'type': 'string', 'enum': ['上课日', '放假日', '调休上课', '考试日', '活动日', '其他'], 'description': '日期类型，可为空'},
                    'limit': {'type': 'integer', 'minimum': 1, 'maximum': 200, 'default': 100},
                },
                'additionalProperties': False,
            },
            handler=get_school_calendar,
        ),
        ToolDefinition(
            name='communications_list',
            description='查询家校沟通记录和后续跟进信息，只返回沟通摘要，不返回家长电话等敏感字段。',
            parameters={
                'type': 'object',
                'properties': {
                    'status': {'type': 'string', 'description': '沟通状态，可为空'},
                    'student_id': {'type': 'integer', 'minimum': 1},
                    'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100, 'default': 20},
                },
                'additionalProperties': False,
            },
            handler=get_communications_list,
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
            sensitive=True,
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
        ToolDefinition(
            name='student_term_comment_context',
            description='整理当前学期生成学生评语所需的安全事实摘要。只返回成绩变化、异常考勤、行为记录和已形成结论的过程记录，不返回家庭电话、住址或家校沟通原文。生成评语前必须使用此工具。',
            parameters={
                'type': 'object', 'properties': {
                    'student_ids': {
                        'type': 'array', 'items': {'type': 'integer', 'minimum': 1},
                        'minItems': 1, 'maxItems': 30,
                    },
                    'limit': {'type': 'integer', 'minimum': 1, 'maximum': 30, 'default': 30},
                },
                'required': ['student_ids'], 'additionalProperties': False,
            },
            handler=get_student_term_comment_context,
        ),
        ToolDefinition(
            name='students_query',
            description='按字段白名单批量查询当前班级学生。适合回答“所有学生”“每个学生”“哪些学生的家长职业”等需要一次获取多名学生数据的问题；不返回电话、家庭住址或备注。',
            parameters={
                'type': 'object',
                'properties': {
                    'fields': {
                        'type': 'array',
                        'items': {
                            'type': 'string',
                            'enum': [
                                'student_id', 'student_no', 'student_name', 'gender', 'birth_month',
                                'ethnicity', 'guardian_name', 'guardian_occupation', 'guardian2_name',
                                'guardian2_relationship', 'is_boarding', 'specialty', 'class_role',
                            ],
                        },
                        'minItems': 1,
                        'maxItems': 10,
                        'description': '需要返回的字段；未指定时返回学号、姓名、性别、住校和班级任职',
                    },
                    'keyword': {'type': 'string', 'description': '按姓名或学号筛选，可为空'},
                    'gender': {'type': 'string', 'description': '按性别筛选，可为空'},
                    'boarding_status': {'type': 'string', 'description': '按是否住校筛选，可为空'},
                    'class_role': {'type': 'string', 'description': '按班级任职包含文字筛选，可为空'},
                    'limit': {'type': 'integer', 'minimum': 1, 'maximum': 500, 'default': 100},
                },
                'additionalProperties': False,
            },
            handler=query_students,
        ),
        ToolDefinition(
            name='students_aggregate',
            description='按字段统计当前班级学生分布。适合回答家长职业分布、住校分布、性别分布或每种分类对应哪些学生的问题；不返回电话、家庭住址或备注。',
            parameters={
                'type': 'object',
                'properties': {
                    'group_by': {
                        'type': 'string',
                        'enum': [
                            'gender', 'guardian_occupation', 'is_boarding',
                            'guardian2_relationship', 'class_role', 'ethnicity',
                        ],
                        'description': '分组字段',
                    },
                    'keyword': {'type': 'string', 'description': '按姓名或学号筛选，可为空'},
                    'gender': {'type': 'string', 'description': '按性别筛选，可为空'},
                    'boarding_status': {'type': 'string', 'description': '按是否住校筛选，可为空'},
                    'class_role': {'type': 'string', 'description': '按班级任职包含文字筛选，可为空'},
                    'include_empty': {'type': 'boolean', 'default': False, 'description': '是否把未填写字段计入“未填写”分组'},
                    'include_students': {'type': 'boolean', 'default': True, 'description': '是否返回每个分组的学生名单'},
                    'limit': {'type': 'integer', 'minimum': 1, 'maximum': 500, 'default': 500},
                },
                'required': ['group_by'],
                'additionalProperties': False,
            },
            handler=aggregate_students,
        ),
    ]
    # 写工具只让模型提出参数；真正执行由 Agent 确认状态机完成。
    tools.extend([
        ToolDefinition(
            name='create_task',
            description='提出创建一条待办的操作预览。模型不得声称已创建；用户回复确认后才会执行。',
            parameters={
                'type': 'object', 'properties': {
                    'title': {'type': 'string', 'minLength': 1},
                    'student_id': {'type': 'integer', 'minimum': 1},
                    'owner': {'type': 'string'}, 'scheduled_at': {'type': 'string'},
                    'due_at': {'type': 'string'}, 'priority': {'type': 'string', 'enum': ['普通', '重要', '紧急']},
                    'notes': {'type': 'string'},
                }, 'required': ['title'], 'additionalProperties': False,
            }, handler=lambda: {}, read_only=False, write_action=True,
        ),
        ToolDefinition(
            name='record_communication',
            description='提出记录家校沟通的操作预览。必须得到用户确认后才写入。',
            parameters={
                'type': 'object', 'properties': {
                    'student_id': {'type': 'integer', 'minimum': 1}, 'communicated_at': {'type': 'string'},
                    'method': {'type': 'string'}, 'reason': {'type': 'string'}, 'summary': {'type': 'string'},
                    'feedback': {'type': 'string'}, 'agreement': {'type': 'string'}, 'followup_at': {'type': 'string'},
                    'status': {'type': 'string'}, 'event_id': {'type': 'integer'},
                }, 'required': ['student_id', 'communicated_at', 'method', 'reason', 'summary'], 'additionalProperties': False,
            }, handler=lambda: {}, read_only=False, write_action=True,
        ),
        ToolDefinition(
            name='save_attendance',
            description='提出保存单名学生考勤的操作预览。只允许单条记录，必须得到用户确认后才写入。',
            parameters={
                'type': 'object', 'properties': {
                    'student_id': {'type': 'integer', 'minimum': 1}, 'date': {'type': 'string'},
                    'scene': {'type': 'string'}, 'status': {'type': 'string', 'enum': ['出勤', '迟到', '请假', '早退', '缺勤']},
                    'reason': {'type': 'string'}, 'arrive': {'type': 'string'}, 'leave': {'type': 'string'}, 'note': {'type': 'string'},
                }, 'required': ['student_id', 'date', 'status'], 'additionalProperties': False,
            }, handler=lambda: {}, read_only=False, write_action=True,
        ),
        ToolDefinition(
            name='record_points',
            description='提出记录单名学生行为积分的操作预览。必须得到用户确认后才写入。',
            parameters={
                'type': 'object', 'properties': {
                    'student_id': {'type': 'integer', 'minimum': 1}, 'amount': {'type': 'number'},
                    'occurred_at': {'type': 'string'}, 'category': {'type': 'string'}, 'reason': {'type': 'string'},
                }, 'required': ['student_id', 'amount', 'reason'], 'additionalProperties': False,
            }, handler=lambda: {}, read_only=False, write_action=True,
        ),
    ])
    return ToolRegistry(tools)
