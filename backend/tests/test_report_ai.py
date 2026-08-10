# -*- coding: utf-8 -*-
import asyncio
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.agent.model_client import ModelResponse
from app.agent.report_drafter import generate_draft
from app.services import reports
from backend.tests.helpers import enroll_all_students


class FakeReportModel:
    config = SimpleNamespace(model='test-report-model')

    async def complete(self, messages):
        return ModelResponse(
            '{"class_summary":"班级整体运行稳定，活动参与情况待老师补充。",'
            '"next_term_plan":"加强考试复盘和学习习惯跟进。",'
            '"teacher_summary":"希望大家保持目标感，继续互相支持。",'
            '"evidence":["班级统计"],"warnings":["班风学风需要老师确认"]}', [],
        )


class ReportAITest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        conn = db.get_conn()
        conn.execute("INSERT INTO students(学号,姓名,性别) VALUES('AI001','AI测试生','女')")
        conn.commit()
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_report_draft_has_three_editable_sections(self):
        report = reports.build_report('term')
        result = asyncio.run(generate_draft(report=report, model_client=FakeReportModel()))
        self.assertEqual(result['model'], 'test-report-model')
        self.assertIn('class_summary', result['draft'])
        self.assertIn('next_term_plan', result['draft'])
        self.assertIn('teacher_summary', result['draft'])
        self.assertEqual(result['warnings'], ['班风学风需要老师确认'])


if __name__ == '__main__':
    unittest.main()
