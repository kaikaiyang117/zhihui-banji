# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.services import reports
from app.services import education
from backend.tests.helpers import enroll_all_students


class ReportsWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        db.get_conn()
        conn = db.get_conn()
        conn.execute("INSERT INTO students(学号,姓名,性别) VALUES('2230','测试同学','女')")
        conn.commit()
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_report_uses_sources_and_archive_is_readable(self):
        meeting = education.create_meeting(
            held_on='2026-08-10', topic='安全教育', content='内容',
            action_items=[{'title': '提交反馈', 'due_at': '2026-08-12'}],
        )
        report = reports.build_report('monthly', '2026-08-01', '2026-08-31')
        self.assertEqual(report['metrics']['meetings'], 1)
        self.assertEqual(report['source_refs']['meetings'][0]['id'], meeting['id'])
        archive = reports.create_archive('monthly', '2026-08-01', '2026-08-31')
        loaded = reports.get_archive(archive['id'])
        self.assertEqual(loaded['payload']['period_start'], '2026-08-01')
        buf, filename = reports.export_archive(archive['id'])
        self.assertTrue(filename.endswith('.xlsx'))
        self.assertGreater(len(buf.getvalue()), 100)

    def test_student_growth_requires_in_scope_student(self):
        with self.assertRaises(reports.ReportError):
            reports.build_report('student_growth', '2026-08-01', '2026-08-31', student_id=999)


if __name__ == '__main__':
    unittest.main()
