# -*- coding: utf-8 -*-
import asyncio
import base64
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.wechat.ilink_client import ILinkClient, ILinkConfig, ILinkSessionExpiredError
from app.wechat.message_loop import MessageLoop
from app.wechat.message_parser import parse_text_messages
from app.wechat.config import load_config, save_config
from app.wechat.models import ILinkCredentials, IncomingText
from app.wechat.service import WeChatService


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
        self.assertEqual(seen['headers']['ilink-app-id'], 'bot')
        self.assertEqual(seen['body']['base_info']['channel_version'], '2.4.6')
        self.assertEqual(seen['body']['msg']['message_type'], 2)
        self.assertEqual(seen['body']['msg']['message_state'], 2)
        self.assertTrue(seen['body']['msg']['client_id'].startswith('meimei-workbench-'))
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

    def test_policy_is_persisted_locally_and_rejects_unknown_sender(self):
        save_config(['wx-allowed'], False)
        self.assertEqual(load_config()['allow_users'], ['wx-allowed'])
        self.assertFalse(load_config()['allow_all'])

        sent = []

        class FakeClient:
            async def send_message(self, to_user_id, context_token, text):
                sent.append((to_user_id, context_token, text))

        service = WeChatService()
        service.client = FakeClient()

        async def run():
            await service._handle_message(IncomingText('m-2', 'wx-unknown', 'bot', 'ctx-2', '你好'))

        asyncio.run(run())
        self.assertEqual(service.recent_senders, ['wx-unknown'])
        self.assertEqual(sent[0][0:2], ('wx-unknown', 'ctx-2'))
        self.assertIn('wx-unknown', sent[0][2])

    def test_allowed_message_toggles_typing_around_agent_reply(self):
        save_config([], True)
        events = []

        class FakeClient:
            async def get_config(self, user_id, context_token):
                events.append(('get_config', user_id, context_token))
                return {'typing_ticket': 'ticket-1'}

            async def send_typing(self, user_id, ticket, status):
                events.append(('typing', user_id, ticket, status))

            async def send_message(self, user_id, context_token, text):
                events.append(('message', user_id, context_token, text))

        class FakeRunner:
            async def chat(self, *_args, **_kwargs):
                return '答复'

        service = WeChatService()
        service.client = FakeClient()
        with patch('app.wechat.service.AgentRunner', return_value=FakeRunner()):
            asyncio.run(service._handle_message(IncomingText('m-3', 'wx-user', 'bot', 'ctx-3', '你好')))

        self.assertEqual([item[3] for item in events if item[0] == 'typing'], [1, 2])
        self.assertEqual(events[-1][0], 'message')

    def test_message_loop_stops_when_session_expires(self):
        class FakeClient:
            async def get_updates(self, _cursor):
                raise ILinkSessionExpiredError('微信 iLink 会话已过期，请重新扫码登录')

        loop = MessageLoop(FakeClient(), lambda _message: None)
        asyncio.run(loop.run())
        self.assertTrue(loop.session_expired)
        self.assertIn('重新扫码', loop.last_error)

    def test_new_session_command_clears_only_current_wechat_context(self):
        save_config([], True)
        db.save_agent_session('wechat:wx-user', [{'role': 'system', 'content': 'old'}])
        sent = []

        class FakeClient:
            async def send_message(self, user_id, context_token, text):
                sent.append((user_id, context_token, text))

        service = WeChatService()
        service.client = FakeClient()
        asyncio.run(service._handle_message(IncomingText('m-4', 'wx-user', 'bot', 'ctx-4', '/新会话')))

        self.assertEqual(db.load_agent_session('wechat:wx-user'), [])
        self.assertIn('凯凯小兵', sent[0][2])
