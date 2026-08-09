# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.services import health


class HealthWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close(); db.DATA_DIR = self.temp.name; db.DB_PATH = os.path.join(self.temp.name, 'test.db'); db.get_conn()

    def tearDown(self):
        db.close(); db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir; self.temp.cleanup()

    def test_personal_summary_goals_and_review_are_isolated(self):
        db.insert_row('体重体脂追踪', ['', '2026-08-05', 130, '', 24, '', '', ''])
        db.insert_row('运动记录', ['2026-08-05', '周三', '散步', '快走', 40, '中', '', '很好', '是'])
        db.insert_row('睡眠记录', ['2026-08-05', '23:00', '07:00', 8, '良', '', 0, ''])
        db.insert_row('饮食记录', ['2026-08-05', '鸡蛋', '米饭', '蔬菜', '', '达标', 1800, 3, ''])
        goal = health.create_goal(metric='体重', target_value=120, unit='斤')
        data = health.summary('month', '2026-08-01', '2026-08-31')
        self.assertEqual(data['latest_weight'], 130)
        self.assertEqual(data['exercise_minutes'], 40)
        self.assertEqual(data['average_sleep_hours'], 8)
        self.assertEqual(data['goals'][0]['id'], goal['id'])
        review = health.generate_review('month', '2026-08-01', '2026-08-31')
        saved = health.save_review(period_type='month', period_start='2026-08-01', period_end='2026-08-31', summary_text=review['summary'], metrics=review['metrics'])
        self.assertEqual(len(health.list_reviews()), 1)
        self.assertEqual(saved['period_start'], '2026-08-01')
        self.assertEqual(health.save_reminder(reminder_type='每日记录提醒', enabled=True)['enabled'], True)
        export, filename = health.export_summary('month', '2026-08-01', '2026-08-31')
        self.assertTrue(filename.endswith('.xlsx'))
        self.assertGreater(len(export.getvalue()), 100)
        self.assertNotIn('class_id', saved)


if __name__ == '__main__':
    unittest.main()
