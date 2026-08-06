# -*- coding: utf-8 -*-
"""模型 + 工具循环。"""
from __future__ import annotations

import json
from typing import Any

from .agent_service import invoke_tool
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
            for call in response.tool_calls:
                result = self._call_tool(call.name, call.arguments, channel, actor_id)
                messages.append({
                    'role': 'tool',
                    'tool_call_id': call.id,
                    'content': json.dumps(result, ensure_ascii=False),
                })

        self.session_store.save(session_id, messages)
        return '这次查询步骤太多，请缩小问题范围后重试。'

    @staticmethod
    def _call_tool(name: str, raw_arguments: str, channel: str, actor_id: str) -> dict[str, Any]:
        try:
            arguments = json.loads(raw_arguments or '{}')
        except (TypeError, ValueError):
            return {'error': '工具参数不是有效 JSON'}
        if not isinstance(arguments, dict):
            return {'error': '工具参数必须是对象'}
        try:
            return invoke_tool(name, arguments, channel=channel, actor_id=actor_id)
        except ToolError as exc:
            return {'error': str(exc)}


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
