# -*- coding: utf-8 -*-
import asyncio
import os
import sys
import tempfile
import unittest

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
