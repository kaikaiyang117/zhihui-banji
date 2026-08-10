# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.routers.p0 import student_detail
from app.services import attendance, work_items
from backend.tests.helpers import enroll_all_students


class AttendanceWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        conn = db.get_conn()
        conn.executemany(
            'INSERT INTO students(学号, 姓名) VALUES(?,?)',
            [('A001', '考勤学生甲'), ('A002', '考勤学生乙')],
        )
        conn.commit()
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def save(self, day, records, scene='常规到校', evaluate=True):
        return attendance.save_daily(day, scene, records, evaluate=evaluate)

    def test_scenes_and_student_month_week_statistics_share_one_source(self):
        self.save('2026-08-03', [
            {'student_id': 1, 'status': '迟到', 'reason': '交通'},
            {'student_id': 2, 'status': '出勤'},
        ], scene='早自习')
        self.save('2026-08-03', [
            {'student_id': 1, 'status': '出勤'},
            {'student_id': 2, 'status': '早退', 'note': '家长接走'},
        ], scene='晚自习')

        all_stats = attendance.attendance_stats(
            date_from='2026-08-01', date_to='2026-08-31')
        early_stats = attendance.attendance_stats(
            date_from='2026-08-01', date_to='2026-08-31', scene='早自习')
        self.assertEqual(all_stats['total_records'], 4)
        self.assertEqual(all_stats['status_count']['迟到'], 1)
        self.assertEqual(all_stats['status_count']['早退'], 1)
        self.assertEqual(len(all_stats['anomalies']), 2)
        self.assertEqual(all_stats['student_stats'][0]['异常'], 1)
        self.assertEqual(all_stats['total_sessions'], 2)
        self.assertEqual(all_stats['student_stats'][0]['punctual_rate'], 50.0)
        self.assertEqual(all_stats['student_stats'][0]['presence_rate'], 100.0)
        self.assertEqual(len(all_stats['month_stats']), 1)
        self.assertEqual(len(all_stats['week_stats']), 1)
        self.assertEqual(early_stats['total_records'], 2)
        self.assertIn('按时出勤率=', all_stats['definition'])
        self.assertEqual(attendance.dashboard_counts('2026-08-03')['早退'], 1)

    def test_save_automatically_evaluates_rule_without_duplicate_task(self):
        attendance.create_rule(
            name='两次迟到', metric='迟到次数', threshold=2, period_days=7,
            scene='早自习')
        first = self.save('2026-08-03', [
            {'student_id': 1, 'status': '迟到'},
            {'student_id': 2, 'status': '出勤'},
        ], scene='早自习')
        second = self.save('2026-08-04', [
            {'student_id': 1, 'status': '迟到'},
            {'student_id': 2, 'status': '出勤'},
        ], scene='早自习')
        repeated = self.save('2026-08-04', [
            {'student_id': 1, 'status': '迟到'},
            {'student_id': 2, 'status': '出勤'},
        ], scene='早自习')

        self.assertEqual(first['evaluation']['created_count'], 0)
        self.assertEqual(second['evaluation']['created_count'], 1)
        self.assertEqual(repeated['evaluation']['created_count'], 0)
        self.assertEqual(db.get_conn().execute(
            "SELECT COUNT(*) AS n FROM student_tasks WHERE source_type='attendance_rule'"
        ).fetchone()['n'], 1)
        rules = attendance.list_rules()
        self.assertEqual(rules['rules'][0]['active_hit_count'], 1)
        self.assertTrue(rules['rules'][0]['last_run_at'])
        self.assertGreaterEqual(len(rules['recent_runs']), 4)

    def test_handled_hit_waits_for_clear_then_reopens_same_task(self):
        attendance.create_rule(
            name='当天缺勤', metric='缺勤次数', threshold=1, period_days=1)
        hit = self.save('2026-08-03', [
            {'student_id': 1, 'status': '缺勤'},
            {'student_id': 2, 'status': '出勤'},
        ])
        hit_student_id = hit['evaluation']['summary'][0]['student_id']
        task = db.get_conn().execute(
            "SELECT * FROM student_tasks WHERE source_type='attendance_rule'"
        ).fetchone()
        self.assertEqual(hit_student_id, 1)
        work_items.update_work_item(
            task['id'], status='已完成', result='已联系家长，确认学生安全')
        self.assertEqual(db.get_conn().execute(
            'SELECT status FROM attendance_rule_hits'
        ).fetchone()['status'], '已处理')

        attendance.evaluate_rules(reference_date='2026-08-03')
        self.assertEqual(db.get_conn().execute(
            'SELECT status FROM student_tasks WHERE id=?', (task['id'],)
        ).fetchone()['status'], '已完成')

        cleared = self.save('2026-08-03', [
            {'student_id': 1, 'status': '出勤'},
            {'student_id': 2, 'status': '出勤'},
        ])
        self.assertEqual(cleared['evaluation']['resolved_count'], 1)
        self.assertEqual(db.get_conn().execute(
            'SELECT status FROM attendance_rule_hits'
        ).fetchone()['status'], '已解除')

        rehit = self.save('2026-08-04', [
            {'student_id': 1, 'status': '缺勤'},
            {'student_id': 2, 'status': '出勤'},
        ])
        self.assertEqual(rehit['evaluation']['reopened_count'], 1)
        self.assertEqual(db.get_conn().execute(
            "SELECT COUNT(*) AS n FROM student_tasks WHERE source_type='attendance_rule'"
        ).fetchone()['n'], 1)
        reopened = db.get_conn().execute(
            'SELECT status, result FROM student_tasks WHERE id=?', (task['id'],)
        ).fetchone()
        self.assertEqual((reopened['status'], reopened['result']), ('待处理', ''))

    def test_consecutive_absence_uses_recorded_school_days(self):
        attendance.create_rule(
            name='连续缺勤', metric='连续缺勤天数', threshold=2, period_days=7,
            scene='常规到校')
        self.save('2026-08-07', [
            {'student_id': 1, 'status': '缺勤'},
            {'student_id': 2, 'status': '出勤'},
        ])
        monday = self.save('2026-08-10', [
            {'student_id': 1, 'status': '缺勤'},
            {'student_id': 2, 'status': '出勤'},
        ])
        self.assertEqual(monday['evaluation']['created_count'], 1)
        self.assertEqual(monday['evaluation']['summary'][0]['value'], 2)

    def test_rule_disable_resolves_open_hit_and_result_enters_timeline(self):
        rule = attendance.create_rule(
            name='缺勤提醒', metric='缺勤次数', threshold=1, period_days=1)
        self.save('2026-08-03', [
            {'student_id': 1, 'status': '缺勤'},
            {'student_id': 2, 'status': '出勤'},
        ])
        task = db.get_conn().execute(
            "SELECT * FROM student_tasks WHERE source_type='attendance_rule'"
        ).fetchone()
        work_items.update_work_item(
            task['id'], status='已完成', result='已完成缺勤原因核验')
        detail = student_detail(1)
        self.assertTrue(any(
            item['kind'] == 'attendance_followup' and item['summary'] == '已完成缺勤原因核验'
            for item in detail['timeline']))

        result = attendance.update_rule(rule['rule_id'], enabled=False)
        self.assertEqual(result['resolved_count'], 1)
        self.assertEqual(db.get_conn().execute(
            'SELECT status FROM attendance_rule_hits'
        ).fetchone()['status'], '已解除')

    def test_startup_evaluation_keeps_trigger_history(self):
        attendance.create_rule(
            name='启动检查', metric='迟到次数', threshold=2, period_days=7)
        attendance.evaluate_startup()
        run = db.get_conn().execute(
            'SELECT trigger_type, status FROM attendance_rule_runs ORDER BY id DESC LIMIT 1'
        ).fetchone()
        self.assertEqual((run['trigger_type'], run['status']), ('startup', 'success'))


if __name__ == '__main__':
    unittest.main()
