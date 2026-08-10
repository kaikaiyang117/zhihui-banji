# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.services import class_context, points, work_items
from backend.tests.helpers import enroll_all_students


class PointsLedgerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        db.get_conn()
        conn = db.get_conn()
        conn.executemany('INSERT INTO students(学号, 姓名) VALUES(?,?)', [
            ('P001', '积分甲'), ('P002', '积分乙'),
        ])
        conn.commit()
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_legacy_snapshot_migrates_once_and_is_recomputed_by_student_id(self):
        db.set_sheet_meta('日常行为积分', ['学号', '学生姓名', '第1周', '第2周'])
        db.insert_row('日常行为积分', ['P001', '错误姓名也不影响关联', 3, -1])
        summary = points.class_summary(reference_date='2026-08-07')
        student = next(item for item in summary['students'] if item['学号'] == 'P001')
        self.assertEqual(student['total'], 2)
        self.assertEqual(summary['migration']['imported_entries'], 2)
        self.assertTrue(summary['migration']['report']['legacy_sheet_retained'])
        second = points.class_summary(reference_date='2026-08-07')
        self.assertEqual(second['migration']['imported_entries'], 2)
        self.assertEqual(db.get_conn().execute('SELECT COUNT(*) FROM point_ledger').fetchone()[0], 2)

    def test_valid_total_and_ranking_change_after_revoke_without_deleting_entry(self):
        entry = points.create_entry(
            student_id=1, amount=5, occurred_at='2026-08-07', category='课堂', reason='积极发言')
        points.create_entry(
            student_id=2, amount=2, occurred_at='2026-08-07', category='课堂', reason='完成任务')
        self.assertEqual(points.class_summary(reference_date='2026-08-07')['students'][0]['学号'], 'P001')
        revoked = points.revoke_entry(entry['id'], '录入错误')
        self.assertEqual(revoked['status'], '已撤销')
        summary = points.class_summary(reference_date='2026-08-07')
        self.assertEqual(summary['students'][0]['学号'], 'P002')
        stored = db.get_conn().execute(
            'SELECT status, reversal_reason FROM point_ledger WHERE id=?', (entry['id'],)).fetchone()
        self.assertEqual((stored['status'], stored['reversal_reason']), ('已撤销', '录入错误'))
        audit_row = db.get_conn().execute(
            "SELECT action FROM system_audit WHERE object_type='point_ledger' AND object_id=? ORDER BY id DESC LIMIT 1",
            (str(entry['id']),)).fetchone()
        self.assertEqual(audit_row['action'], 'revoke')

    def test_threshold_hit_creates_followup_and_work_item_transition_updates_hit(self):
        points.create_entry(
            student_id=1, amount=-3, occurred_at='2026-08-07', category='纪律', reason='迟到')
        rule = points.create_rule(
            name='周期扣分提醒', metric='周期扣分', threshold=2, period_days=7)
        result = points.evaluate_rules(reference_date='2026-08-07')
        self.assertEqual(result['created_count'], 1)
        hit = points.list_rule_hits()[0]
        self.assertEqual(hit['status'], '新命中')
        task = db.get_conn().execute(
            "SELECT * FROM student_tasks WHERE source_type='point_rule' AND source_id=?",
            (hit['id'],)).fetchone()
        self.assertIsNotNone(task)
        work_items.update_work_item(task['id'], status='已完成', result='已完成谈话')
        self.assertEqual(points.list_rule_hits()[0]['status'], '已处理')
        self.assertEqual(rule['name'], '周期扣分提醒')

    def test_new_database_schema_and_export_use_structured_rows(self):
        points.create_entry(student_id=1, amount=1, occurred_at='2026-08-07', reason='值日认真')
        from app.export_service import export_sheet
        buffer, filename = export_sheet('日常行为积分')
        self.assertEqual(filename, '行为积分流水.xlsx')
        self.assertGreater(len(buffer.getvalue()), 100)

    def test_academic_year_summary_spans_terms_and_excludes_other_years(self):
        current = class_context.get_current_scope()
        fall_term = class_context.create_term(
            current['class_id'], '2025 秋季', '2025-09-01', '2026-01-31')
        conn = db.get_conn()
        conn.executemany(
            '''INSERT INTO student_enrollments(student_id, class_id, term_id, status)
               VALUES(?,?,?,'在读')''',
            [(1, current['class_id'], fall_term), (2, current['class_id'], fall_term)],
        )
        conn.commit()
        token = class_context.bind_request_scope(current['class_id'], fall_term)
        try:
            points.create_entry(
                student_id=1, amount=4, occurred_at='2025-10-01', category='品德', reason='秋季表现')
            points.create_entry(
                student_id=2, amount=2, occurred_at='2025-12-01', category='劳动', reason='秋季值日')
        finally:
            class_context.reset_request_scope(token)
        token = class_context.bind_request_scope(current['class_id'], current['term_id'])
        try:
            points.create_entry(
                student_id=1, amount=3, occurred_at='2026-03-01', category='学习', reason='春季表现')
            points.create_entry(
                student_id=1, amount=9, occurred_at='2026-09-01', category='学习', reason='下一学年')
            summary = points.class_summary(
                academic_year='2025-2026', reference_date='2026-04-15')
            entries = points.list_entries(academic_year='2025-2026')
        finally:
            class_context.reset_request_scope(token)
        first = next(item for item in summary['students'] if item['学号'] == 'P001')
        second = next(item for item in summary['students'] if item['学号'] == 'P002')
        self.assertEqual(first['total'], 7)
        self.assertEqual(second['total'], 2)
        self.assertEqual(summary['totals']['valid_entries'], 3)
        self.assertEqual(summary['academic_year'], '2025-2026')
        self.assertEqual(len(entries), 3)


if __name__ == '__main__':
    unittest.main()
