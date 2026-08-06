# -*- coding: utf-8 -*-
import asyncio
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.agent.agent_service import invoke_tool, list_audits, list_tools
from app.agent.model_client import ModelResponse, ToolCall
from app.agent.runner import AgentRunner
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
            ['student_get_profile', 'student_get_timeline', 'students_search'],
        )
        self.assertTrue(all(tool['read_only'] for tool in tools))

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


if __name__ == '__main__':
    unittest.main()
