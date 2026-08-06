# -*- coding: utf-8 -*-
"""模型 + 工具循环。"""
from __future__ import annotations

import json
from typing import Any, AsyncIterator

from .agent_service import invoke_tool, record_tool_failure
from .model_client import ModelResponse, OpenAICompatibleClient
from .prompt import system_prompt
from .session_store import SessionStore
from .tool_registry import ToolError, build_registry


class AgentRunner:
    def __init__(
        self,
        model_client: OpenAICompatibleClient | None = None,
        session_store: SessionStore | None = None,
        max_turns: int = 5,
    ):
        self.model_client = model_client or OpenAICompatibleClient()
        self.session_store = session_store or SessionStore()
        self.max_turns = max(1, min(max_turns, 10))

    async def chat(
        self,
        session_id: str,
        text: str,
        *,
        channel: str = 'local',
        actor_id: str = '',
    ) -> str:
        text = str(text or '').strip()
        if not text:
            return '请输入要查询的内容。'
        messages = self.session_store.load(session_id)
        system_message = {'role': 'system', 'content': system_prompt()}
        if not messages or messages[0].get('role') != 'system':
            messages.insert(0, {'role': 'system', 'content': system_prompt()})
        else:
            messages[0] = system_message
        messages.append({'role': 'user', 'content': text})
        tools = build_registry().model_tools()
        _apply_direct_tool(messages, text, channel, actor_id)
        failure_counts: dict[str, int] = {}

        for _ in range(self.max_turns):
            response = await self.model_client.complete(messages, tools)
            if not response.tool_calls:
                answer = response.content.strip() or '模型没有返回可显示的内容。'
                assistant_message = {'role': 'assistant', 'content': answer}
                if response.reasoning_content:
                    assistant_message['reasoning_content'] = response.reasoning_content
                messages.append(assistant_message)
                self.session_store.save(session_id, messages)
                return answer

            messages.append(_assistant_tool_message(response))
            halt_message = ''
            for call in response.tool_calls:
                result = self._execute_tool_with_retry(
                    call.name, call.arguments, channel, actor_id, failure_counts
                )
                messages.append({
                    'role': 'tool',
                    'tool_call_id': call.id,
                    'content': json.dumps(result, ensure_ascii=False),
                })
                if result.get('error', {}).get('code') == 'retry_exhausted':
                    halt_message = _tool_failure_message()
                    break
            if halt_message:
                messages.append({'role': 'assistant', 'content': halt_message})
                self.session_store.save(session_id, messages)
                return halt_message

        self.session_store.save(session_id, messages)
        return '这次查询步骤太多，请缩小问题范围后重试。'

    async def chat_stream(
        self,
        session_id: str,
        text: str,
        *,
        channel: str = 'local',
        actor_id: str = '',
    ) -> AsyncIterator[dict[str, str]]:
        """流式输出最终回答；工具调用轮次仍然由服务端完整执行。"""
        text = str(text or '').strip()
        if not text:
            yield {'type': 'delta', 'content': '请输入要查询的内容。'}
            return
        messages = self.session_store.load(session_id)
        system_message = {'role': 'system', 'content': system_prompt()}
        if not messages or messages[0].get('role') != 'system':
            messages.insert(0, system_message)
        else:
            messages[0] = system_message
        messages.append({'role': 'user', 'content': text})
        tools = build_registry().model_tools()
        _apply_direct_tool(messages, text, channel, actor_id)
        failure_counts: dict[str, int] = {}

        for _ in range(self.max_turns):
            response = None
            async for event in self.model_client.iter_complete(messages, tools):
                if event.content:
                    yield {'type': 'delta', 'content': event.content}
                if event.response:
                    response = event.response
            if response is None:
                raise RuntimeError('模型流式响应缺少最终结果')
            if not response.tool_calls:
                answer = response.content.strip() or '模型没有返回可显示的内容。'
                messages.append({'role': 'assistant', 'content': answer})
                self.session_store.save(session_id, messages)
                return
            messages.append(_assistant_tool_message(response))
            halt_message = ''
            for call in response.tool_calls:
                result = self._execute_tool_with_retry(
                    call.name, call.arguments, channel, actor_id, failure_counts
                )
                messages.append({
                    'role': 'tool',
                    'tool_call_id': call.id,
                    'content': json.dumps(result, ensure_ascii=False),
                })
                if result.get('error', {}).get('code') == 'retry_exhausted':
                    halt_message = _tool_failure_message()
                    break
            if halt_message:
                messages.append({'role': 'assistant', 'content': halt_message})
                self.session_store.save(session_id, messages)
                yield {'type': 'delta', 'content': halt_message}
                return

        answer = '这次查询步骤太多，请缩小问题范围后重试。'
        messages.append({'role': 'assistant', 'content': answer})
        self.session_store.save(session_id, messages)
        yield {'type': 'delta', 'content': answer}

    @staticmethod
    def _call_tool(name: str, raw_arguments: str, channel: str, actor_id: str) -> dict[str, Any]:
        try:
            arguments = json.loads(raw_arguments or '{}')
        except (TypeError, ValueError):
            message = '工具参数不是有效 JSON'
            record_tool_failure(channel, actor_id, name, {}, 'error', message)
            return _tool_error('invalid_arguments', message, retryable=True)
        if not isinstance(arguments, dict):
            message = '工具参数必须是对象'
            record_tool_failure(channel, actor_id, name, {}, 'error', message)
            return _tool_error('invalid_arguments', message, retryable=True)
        try:
            return invoke_tool(name, arguments, channel=channel, actor_id=actor_id)
        except ToolError as exc:
            return _tool_error(exc.code, str(exc), retryable=exc.retryable, auto_retry=exc.auto_retry)

    @classmethod
    def _execute_tool_with_retry(
        cls,
        name: str,
        raw_arguments: str,
        channel: str,
        actor_id: str,
        failure_counts: dict[str, int],
    ) -> dict[str, Any]:
        key = f'{name}:{raw_arguments}'
        if failure_counts.get(key, 0) >= 1:
            message = '同一个工具调用已经失败并自动重试过一次，停止继续重复调用。'
            record_tool_failure(channel, actor_id, name, {}, 'retry_exhausted', message)
            return _tool_error('retry_exhausted', message, retryable=False)

        result = cls._call_tool(name, raw_arguments, channel, actor_id)
        error = result.get('error')
        if not error:
            return result
        failure_counts[key] = 1
        if not error.get('auto_retry'):
            return result

        retry_result = cls._call_tool(name, raw_arguments, channel, actor_id)
        if not retry_result.get('error'):
            return retry_result
        retry_result['error']['retry_attempts'] = 1
        return retry_result


def _infer_direct_tool(text: str) -> tuple[str, str, str] | None:
    """为高频、明确的班级查询提供确定性工具路由。"""
    class_terms = ('班级', '我们班', '本班', '班里', '班上', '全班')
    student_terms = ('学生', '同学', '人数', '总数', '人')
    count_terms = ('多少', '几', '人数', '总数', '总共', '共有')
    if (any(term in text for term in class_terms)
            and any(term in text for term in student_terms)
            and any(term in text for term in count_terms)):
        return 'class_student_count', '{}', 'direct-class-student-count'
    if any(term in text for term in class_terms) and any(term in text for term in ('考勤', '出勤', '迟到', '请假', '缺勤')):
        return 'attendance_summary', '{}', 'direct-class-attendance-summary'
    if any(term in text for term in class_terms) and any(term in text for term in ('成绩', '分数', '考试', '排名')):
        return 'scores_summary', '{}', 'direct-class-scores-summary'
    if any(term in text for term in ('待办', '逾期', '跟进任务')) and not any(term in text for term in ('创建', '添加', '新建')):
        return 'tasks_list', '{}', 'direct-tasks-list'
    if any(term in text for term in ('家校沟通', '家长联系', '家访记录')):
        return 'communications_list', '{}', 'direct-communications-list'
    return None


def _apply_direct_tool(messages: list[dict[str, Any]], text: str, channel: str, actor_id: str):
    direct_tool = _infer_direct_tool(text)
    if not direct_tool:
        return
    tool_name, tool_arguments, tool_call_id = direct_tool
    messages.append({
        'role': 'assistant',
        'content': None,
        'tool_calls': [{
            'id': tool_call_id,
            'type': 'function',
            'function': {'name': tool_name, 'arguments': tool_arguments},
        }],
    })
    result = AgentRunner._call_tool(tool_name, tool_arguments, channel, actor_id)
    messages.append({
        'role': 'tool',
        'tool_call_id': tool_call_id,
        'content': json.dumps(result, ensure_ascii=False),
    })


def _tool_error(code: str, message: str, *, retryable: bool, auto_retry: bool = False) -> dict[str, Any]:
    return {
        'error': {
            'code': code,
            'message': message,
            'retryable': retryable,
            'auto_retry': auto_retry,
        },
    }


def _tool_failure_message() -> str:
    return '凯凯小兵尝试查询时工具连续失败，已停止重复调用。请换一种说法，或稍后再试。'


def _assistant_tool_message(response: ModelResponse) -> dict[str, Any]:
    return {
        'role': 'assistant',
        'content': response.content or None,
        'tool_calls': [
            {
                'id': call.id,
                'type': 'function',
                'function': {'name': call.name, 'arguments': call.arguments},
            }
            for call in response.tool_calls
        ],
        **({'reasoning_content': response.reasoning_content} if response.reasoning_content else {}),
    }
