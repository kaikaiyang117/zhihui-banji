# -*- coding: utf-8 -*-
import asyncio
import os
import sys
import unittest

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.agent.model_client import ModelConfig, OpenAICompatibleClient


class ModelClientTest(unittest.TestCase):
    def test_openai_compatible_response_and_tool_call_are_parsed(self):
        seen = {}

        def handler(request):
            seen['authorization'] = request.headers.get('Authorization')
            seen['payload'] = request.read().decode('utf-8')
            return httpx.Response(200, json={
                'choices': [{
                    'message': {
                        'content': '',
                        'tool_calls': [{
                            'id': 'call-1',
                            'type': 'function',
                            'function': {'name': 'students_search', 'arguments': '{"keyword":"张"}'},
                        }],
                    }
                }]
            })

        async def run():
            transport = httpx.MockTransport(handler)
            async with httpx.AsyncClient(transport=transport) as http_client:
                client = OpenAICompatibleClient(
                    ModelConfig('secret', 'https://model.test/v1', 'demo-model'),
                    http_client=http_client,
                )
                return await client.complete([{'role': 'user', 'content': '搜索张三'}], [])

        result = asyncio.run(run())
        self.assertEqual(result.tool_calls[0].name, 'students_search')
        self.assertEqual(seen['authorization'], 'Bearer secret')
        self.assertIn('demo-model', seen['payload'])

    def test_stream_response_is_parsed(self):
        body = (
            'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'
            'data: {"choices":[{"delta":{"content":"，凯凯小兵"}}]}\n\n'
            'data: [DONE]\n\n'
        )

        def handler(request):
            payload = request.read().decode('utf-8')
            self.assertIn('"stream":true', payload)
            return httpx.Response(200, text=body, headers={'content-type': 'text/event-stream'})

        async def run():
            transport = httpx.MockTransport(handler)
            async with httpx.AsyncClient(transport=transport) as http_client:
                client = OpenAICompatibleClient(
                    ModelConfig('secret', 'https://model.test/v1', 'demo-model'),
                    http_client=http_client,
                )
                chunks, final = [], None
                async for event in client.iter_complete([{'role': 'user', 'content': '你好'}], []):
                    chunks.append(event.content)
                    final = event.response or final
                return chunks, final

        chunks, final = asyncio.run(run())
        self.assertEqual(''.join(chunks), '你好，凯凯小兵')
        self.assertEqual(final.content, '你好，凯凯小兵')
