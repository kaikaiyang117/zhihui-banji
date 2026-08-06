# -*- coding: utf-8 -*-
"""OpenAI-compatible模型客户端，不绑定具体模型供应商。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx

from .model_config import load_local_config


class ModelError(Exception):
    """模型调用失败。"""


class ModelNotConfigured(ModelError):
    """缺少模型地址、模型名或 API Key。"""


@dataclass(frozen=True)
class ModelConfig:
    api_key: str
    base_url: str
    model: str
    timeout_seconds: float = 45.0
    thinking: str = 'disabled'

    @classmethod
    def from_env(cls) -> 'ModelConfig':
        local = load_local_config()
        api_key = os.environ.get('MEIMEI_MODEL_API_KEY') or os.environ.get('OPENAI_API_KEY') or str(local.get('api_key') or '')
        base_url = (os.environ.get('MEIMEI_MODEL_BASE_URL') or str(local.get('base_url') or 'https://api.openai.com/v1')).rstrip('/')
        model = (os.environ.get('MEIMEI_MODEL_NAME') or str(local.get('model') or '')).strip()
        thinking = (os.environ.get('MEIMEI_MODEL_THINKING') or str(local.get('thinking') or 'disabled')).strip().lower()
        if thinking not in {'disabled', 'enabled'}:
            thinking = 'disabled'
        timeout_text = os.environ.get('MEIMEI_MODEL_TIMEOUT', '45')
        try:
            timeout = max(5.0, min(float(timeout_text), 180.0))
        except ValueError:
            timeout = 45.0
        return cls(api_key=api_key, base_url=base_url, model=model, timeout_seconds=timeout, thinking=thinking)

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.model and self.base_url)


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass(frozen=True)
class ModelResponse:
    content: str
    tool_calls: list[ToolCall]
    reasoning_content: str = ''


class OpenAICompatibleClient:
    def __init__(self, config: ModelConfig | None = None, http_client: httpx.AsyncClient | None = None):
        self.config = config or ModelConfig.from_env()
        self._http_client = http_client

    async def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> ModelResponse:
        if not self.config.configured:
            raise ModelNotConfigured(
                '模型尚未配置，请设置 MEIMEI_MODEL_API_KEY 和 MEIMEI_MODEL_NAME'
            )
        payload: dict[str, Any] = {
            'model': self.config.model,
            'messages': messages,
            'temperature': 0.2,
            'thinking': {'type': self.config.thinking},
        }
        if tools:
            payload['tools'] = tools
            payload['tool_choice'] = 'auto'

        headers = {
            'Authorization': f'Bearer {self.config.api_key}',
            'Content-Type': 'application/json',
        }
        client = self._http_client
        owns_client = client is None
        if owns_client:
            client = httpx.AsyncClient(timeout=self.config.timeout_seconds)
        try:
            response = await client.post(
                f'{self.config.base_url}/chat/completions',
                headers=headers,
                json=payload,
            )
            if response.status_code >= 400:
                raise ModelError(f'模型接口返回 HTTP {response.status_code}: {_error_text(response)}')
            try:
                data = response.json()
            except ValueError as exc:
                raise ModelError('模型接口返回了无效 JSON') from exc
            return _parse_response(data)
        except httpx.HTTPError as exc:
            raise ModelError(f'模型网络请求失败：{exc}') from exc
        finally:
            if owns_client:
                await client.aclose()


def _parse_response(data: dict[str, Any]) -> ModelResponse:
    try:
        message = data['choices'][0]['message']
    except (KeyError, IndexError, TypeError) as exc:
        raise ModelError('模型响应缺少 choices[0].message') from exc
    calls = []
    for item in message.get('tool_calls') or []:
        function = item.get('function') or {}
        calls.append(ToolCall(
            id=str(item.get('id') or ''),
            name=str(function.get('name') or ''),
            arguments=str(function.get('arguments') or '{}'),
        ))
    content = message.get('content') or ''
    reasoning_content = message.get('reasoning_content') or ''
    return ModelResponse(
        content=str(content),
        tool_calls=calls,
        reasoning_content=str(reasoning_content),
    )


def _error_text(response: httpx.Response) -> str:
    try:
        data = response.json()
        return str(data.get('error', data))[:500]
    except ValueError:
        return response.text[:500]
