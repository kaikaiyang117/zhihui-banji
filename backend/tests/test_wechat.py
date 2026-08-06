# -*- coding: utf-8 -*-
import asyncio
import base64
import json
import os
import sys
import tempfile
import unittest

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.wechat.ilink_client import ILinkClient, ILinkConfig
from app.wechat.message_loop import MessageLoop
from app.wechat.message_parser import parse_text_messages
from app.wechat.models import ILinkCredentials


class WeChatProtocolTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        db.get_conn()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_client_uses_ilink_headers_and_message_shape(self):
        seen = {}

        def handler(request):
            seen['path'] = request.url.path
            seen['headers'] = dict(request.headers)
            seen['body'] = json.loads(request.content.decode('utf-8'))
            return httpx.Response(200, json={'ret': 0})

        async def run():
            transport = httpx.MockTransport(handler)
            async with httpx.AsyncClient(transport=transport) as http_client:
                client = ILinkClient(
                    ILinkConfig('https://ilink.test'),
                    ILinkCredentials('bot-secret'),
                    http_client=http_client,
                )
                return await client.send_message('wx-user', 'context-1', '你好')

        asyncio.run(run())
        self.assertEqual(seen['path'], '/ilink/bot/sendmessage')
        self.assertEqual(seen['headers']['authorization'], 'Bearer bot-secret')
        self.assertEqual(seen['headers']['authorizationtype'], 'ilink_bot_token')
        decoded_uin = base64.b64decode(seen['headers']['x-wechat-uin']).decode('ascii')
        self.assertTrue(decoded_uin.isdigit())
        self.assertEqual(seen['body']['msg']['item_list'][0]['text_item']['text'], '你好')

    def test_message_parser_and_loop_dedupe_messages(self):
        payload = {
            'msgs': [{
                'message_id': 'm-1',
                'from_user_id': 'wx-user',
                'context_token': 'ctx',
                'message_type': 1,
                'item_list': [{'type': 1, 'text_item': {'text': '查询张三'}}],
            }],
            'get_updates_buf': 'cursor-1',
        }
        messages = parse_text_messages(payload)
        self.assertEqual(messages[0].text, '查询张三')

        class FakeClient:
            async def get_updates(self, _cursor):
                return payload

        received = []

        async def handler(message):
            received.append(message.message_id)

        async def run():
            loop = MessageLoop(FakeClient(), handler)
            await loop.poll_once()
            await loop.poll_once()
            return loop

        loop = asyncio.run(run())
        self.assertEqual(received, ['m-1'])
        self.assertEqual(loop.cursor, 'cursor-1')
        self.assertEqual(db.get_agent_setting('wechat.get_updates_buf'), 'cursor-1')
