# -*- coding: utf-8 -*-
"""Agent 固定问题集：不依赖真实模型，验证工具、权限和错误边界。"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.agent.agent_service import invoke_tool
from app.agent.runner import AgentRunner
from app.agent.tool_registry import ToolError
from backend.tests.helpers import enroll_all_students


class AgentRegressionTest(unittest.TestCase):
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
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_fixed_regression_cases(self):
        fixture = os.path.join(os.path.dirname(__file__), 'fixtures', 'agent_regression.json')
        with open(fixture, encoding='utf-8') as stream:
            cases = json.load(stream)
        for case in cases:
            with self.subTest(case=case['name']):
                kind = case['kind']
                if kind == 'tool':
                    result = invoke_tool(case['tool'], case['arguments'])
                    for key in case.get('required_keys', []):
                        self.assertIn(key, result)
                    if 'expected_first_name' in case:
                        self.assertEqual(result['students'][0]['姓名'], case['expected_first_name'])
                elif kind == 'denied':
                    with self.assertRaises(ToolError) as error:
                        invoke_tool(case['tool'], case['arguments'], channel=case['channel'], actor_id='regression')
                    self.assertEqual(error.exception.code, case['expected_code'])
                elif kind == 'invalid_arguments':
                    result = AgentRunner._call_tool(case['tool'], case['raw_arguments'], 'web', 'regression')
                    self.assertEqual(result['error']['code'], case['expected_code'])


if __name__ == '__main__':
    unittest.main()
