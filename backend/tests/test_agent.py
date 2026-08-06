# -*- coding: utf-8 -*-
import asyncio
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.agent.agent_service import invoke_tool, list_audits, list_tools
from app.agent.model_client import ModelResponse, ModelStreamEvent, ToolCall
from app.agent.runner import AgentRunner
from app.agent.session_store import SessionStore
from app.agent.tool_registry import ToolError


class AgentFoundationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        conn = db.get_conn()
        conn.executemany(
            'INSERT INTO students(学号, 姓名, 性别, 班级任职) VALUES(?,?,?,?)',
            [('A001', '张三', '男', '班长'), ('A002', '李四', '女', '')],
        )
        conn.commit()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_registry_exposes_only_read_tools(self):
        tools = list_tools()
        self.assertEqual(
            [tool['name'] for tool in tools],
            [
                'attendance_summary',
                'class_student_count',
                'communications_list',
                'scores_summary',
                'student_get_profile',
                'student_get_timeline',
                'students_search',
                'tasks_list',
            ],
        )
        self.assertTrue(all(tool['read_only'] for tool in tools))

    def test_class_student_count(self):
        result = invoke_tool('class_student_count')
        self.assertEqual(result, {'student_count': 2})
        self.assertEqual(list_audits(1)[0]['result_summary'], '班级共有 2 名学生')

    def test_common_read_tools_are_callable(self):
        self.assertIn('summary', invoke_tool('attendance_summary'))
        self.assertIn('exams', invoke_tool('scores_summary'))
        self.assertIn('tasks', invoke_tool('tasks_list'))
        self.assertIn('communications', invoke_tool('communications_list'))

    def test_search_and_profile_are_audited(self):
        result = invoke_tool('students_search', {'keyword': '张'})
        self.assertEqual(result['students'][0]['姓名'], '张三')

        profile = invoke_tool('student_get_profile', {'student_id': 1}, actor_id='teacher')
        self.assertEqual(profile['student']['姓名'], '张三')

        audits = list_audits()
        self.assertEqual(len(audits), 2)
        self.assertEqual(audits[0]['actor_id'], 'teacher')
        self.assertEqual(audits[0]['status'], 'success')
        self.assertIsInstance(audits[0]['arguments'], dict)

    def test_unknown_tool_is_rejected_and_audited(self):
        with self.assertRaises(ToolError):
            invoke_tool('student_delete', {'student_id': 1}, channel='wechat', actor_id='wx-user')
        audit = list_audits(1)[0]
        self.assertEqual(audit['status'], 'error')
        self.assertEqual(audit['channel'], 'wechat')

    def test_sensitive_profile_is_denied_on_wechat(self):
        with self.assertRaises(ToolError):
            invoke_tool('student_get_profile', {'student_id': 1}, channel='wechat', actor_id='wx-user')
        audit = list_audits(1)[0]
        self.assertEqual(audit['status'], 'denied')

    def test_runner_uses_tool_then_saves_session(self):
        class FakeModel:
            def __init__(self):
                self.calls = 0

            async def complete(self, _messages, _tools):
                self.calls += 1
                if self.calls == 1:
                    return ModelResponse('', [ToolCall(
                        id='call-1', name='students_search', arguments='{"keyword":"张"}'
                    )])
                return ModelResponse('找到了张三。', [])

        runner = AgentRunner(model_client=FakeModel())
        answer = asyncio.run(runner.chat('test-session', '帮我找张三'))
        self.assertEqual(answer, '找到了张三。')
        self.assertEqual(len(db.load_agent_session('test-session')), 5)
        self.assertEqual(list_audits(1)[0]['tool_name'], 'students_search')

    def test_runner_returns_structured_tool_error_and_can_recover(self):
        class FakeModel:
            def __init__(self):
                self.calls = 0
                self.snapshots = []

            async def complete(self, messages, _tools):
                self.calls += 1
                self.snapshots.append([dict(message) for message in messages])
                if self.calls == 1:
                    return ModelResponse('', [ToolCall(
                        id='bad-call-1', name='student_delete', arguments='{}'
                    )])
                return ModelResponse('这个工具不可用，我已经停止继续调用。', [])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model).chat(
            'error-recover-session', '查询一个学生的信息'
        ))
        self.assertEqual(answer, '这个工具不可用，我已经停止继续调用。')
        tool_message = next(
            message for message in model.snapshots[1] if message['role'] == 'tool'
        )
        error = json.loads(tool_message['content'])['error']
        self.assertEqual(error['code'], 'unknown_tool')
        self.assertTrue(error['retryable'])

    def test_runner_stops_repeated_failed_tool_calls(self):
        class FakeModel:
            def __init__(self):
                self.calls = 0

            async def complete(self, _messages, _tools):
                self.calls += 1
                return ModelResponse('', [ToolCall(
                    id=f'bad-call-{self.calls}', name='student_delete', arguments='{}'
                )])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model, max_turns=5).chat(
            'repeated-error-session', '查询一个学生的信息'
        ))
        self.assertIn('连续失败', answer)
        self.assertEqual(model.calls, 2)
        audits = list_audits(2)
        self.assertEqual(audits[0]['status'], 'retry_exhausted')
        self.assertEqual(audits[1]['status'], 'error')

    def test_invalid_tool_json_is_structured_and_audited(self):
        result = AgentRunner._call_tool(
            'students_search', '{not-json', 'web', 'web-user'
        )
        self.assertEqual(result['error']['code'], 'invalid_arguments')
        self.assertTrue(result['error']['retryable'])
        self.assertEqual(list_audits(1)[0]['status'], 'error')

    def test_execution_error_is_retried_once(self):
        calls = 0

        def flaky_invoke(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ToolError(
                    '临时失败', code='execution_error', retryable=True, auto_retry=True
                )
            return {'student_count': 2}

        with patch('app.agent.runner.invoke_tool', side_effect=flaky_invoke):
            result = AgentRunner._execute_tool_with_retry(
                'class_student_count', '{}', 'web', 'web-user', {}
            )
        self.assertEqual(result, {'student_count': 2})
        self.assertEqual(calls, 2)

    def test_runner_routes_class_count_without_model_guessing(self):
        class FakeModel:
            async def complete(self, messages, _tools):
                self.messages = messages
                return ModelResponse('当前班级共有 2 名学生。', [])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model).chat(
            'class-count-session', '我们班级有多少个学生？', channel='web', actor_id='web-user'
        ))
        self.assertEqual(answer, '当前班级共有 2 名学生。')
        self.assertEqual(list_audits(1)[0]['tool_name'], 'class_student_count')
        self.assertEqual(model.messages[-2]['role'], 'tool')

    def test_runner_streams_final_answer(self):
        class FakeStreamModel:
            async def iter_complete(self, _messages, _tools):
                yield ModelStreamEvent(content='班级共有 ')
                yield ModelStreamEvent(content='2 名学生。')
                yield ModelStreamEvent(response=ModelResponse('班级共有 2 名学生。', []))

        async def run():
            chunks = []
            runner = AgentRunner(model_client=FakeStreamModel())
            async for event in runner.chat_stream('stream-session', '请告诉我一个结果'):
                chunks.append(event['content'])
            return ''.join(chunks)

        self.assertEqual(asyncio.run(run()), '班级共有 2 名学生。')

    def test_session_store_keeps_tool_messages_with_their_call(self):
        store = SessionStore(max_messages=8)
        db.save_agent_session('trim-session', [
            {'role': 'tool', 'tool_call_id': 'orphan', 'content': '{}'},
            {'role': 'system', 'content': 'system'},
            {'role': 'user', 'content': '旧问题'},
            {'role': 'assistant', 'content': None, 'tool_calls': [{
                'id': 'call-1', 'type': 'function',
                'function': {'name': 'students_search', 'arguments': '{}'},
            }]},
            {'role': 'tool', 'tool_call_id': 'call-1', 'content': '{}'},
            {'role': 'assistant', 'content': '旧回答'},
            {'role': 'user', 'content': '新问题'},
            {'role': 'assistant', 'content': '新回答'},
        ])
        messages = store.load('trim-session')
        self.assertEqual(messages[0]['role'], 'system')
        for index, message in enumerate(messages):
            if message['role'] == 'tool':
                self.assertTrue(index > 0 and messages[index - 1].get('tool_calls'))


if __name__ == '__main__':
    unittest.main()
