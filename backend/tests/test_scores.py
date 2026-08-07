# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app import db
from app.routers.p0 import student_detail
from app.services import scores, work_items
from backend.tests.helpers import enroll_all_students


class ScoreServiceTest(unittest.TestCase):
    def setUp(self):
        db.close()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        self.temp = tempfile.TemporaryDirectory()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        conn = db.get_conn()
        conn.executemany('INSERT INTO students(学号, 姓名, 性别) VALUES(?,?,?)', [
            ('A001', '林晓雨', '女'), ('A002', '周明远', '男')])
        conn.commit()
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def commit(self, request_id, rows):
        return scores.commit_exam_rows([
            {'row': index + 2, 'valid': True, **row}
            for index, row in enumerate(rows)
        ], filename='scores.xlsx', request_id=request_id)

    def test_preview_has_no_side_effect_then_commit_is_idempotent(self):
        preview = scores.preview_exam_rows([
            ['学号', '姓名', '考试名称', '考试日期', '科目', '分数', '状态'],
            ['A001', '林晓雨', '第一次月考', '2026-09-10', '语文', 90, '正常'],
            ['A999', '未知学生', '第一次月考', '2026-09-10', '语文', 80, '正常'],
        ])
        self.assertEqual(preview['summary']['valid'], 1)
        self.assertEqual(preview['summary']['error'], 1)
        conn = db.get_conn()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM exam_records').fetchone()[0], 0)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM score_exams').fetchone()[0], 0)

        valid = [row for row in preview['rows'] if row['valid']]
        result = scores.commit_exam_rows(
            valid, filename='scores.xlsx', request_id='preview-commit-1')
        repeated = scores.commit_exam_rows(
            valid, filename='scores.xlsx', request_id='preview-commit-1')
        self.assertEqual(result['imported'], 1)
        self.assertTrue(repeated['idempotent'])
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM exam_records').fetchone()[0], 1)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM score_exams').fetchone()[0], 1)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM score_subjects').fetchone()[0], 1)

        skipped = scores.preview_exam_rows([
            ['学号', '考试名称', '科目', '分数'],
            ['A001', '第一次月考', '语文', 95],
        ], duplicate_strategy='skip')
        self.assertEqual(skipped['rows'][0]['action'], '跳过')

    def test_commit_revalidates_all_rows_before_writing(self):
        with self.assertRaisesRegex(scores.ScoreError, '正常成绩的分数不能为空'):
            self.commit('atomic-invalid', [
                {'student_id': 1, 'exam_name': '第一次月考', 'exam_date': '2026-09-10',
                 'subject': '语文', 'score': 90, 'record_status': '正常'},
                {'student_id': 2, 'exam_name': '第一次月考', 'exam_date': '2026-09-10',
                 'subject': '语文', 'score': None, 'record_status': '正常'},
            ])
        conn = db.get_conn()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM exam_records').fetchone()[0], 0)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM score_import_runs').fetchone()[0], 0)

    def test_statistics_keep_absence_and_missing_out_of_averages(self):
        self.commit('exam-1', [
            {'student_id': 1, 'exam_name': '第一次月考', 'exam_date': '2026-09-10',
             'subject': '语文', 'score': 90, 'record_status': '正常'},
            {'student_id': 1, 'exam_name': '第一次月考', 'exam_date': '2026-09-10',
             'subject': '数学', 'score': 90, 'record_status': '正常'},
            {'student_id': 2, 'exam_name': '第一次月考', 'exam_date': '2026-09-10',
             'subject': '语文', 'score': 80, 'record_status': '正常'},
            {'student_id': 2, 'exam_name': '第一次月考', 'exam_date': '2026-09-10',
             'subject': '数学', 'score': 80, 'record_status': '正常'},
        ])
        self.commit('exam-2', [
            {'student_id': 1, 'exam_name': '期中考试', 'exam_date': '2026-10-20',
             'subject': '语文', 'score': 70, 'record_status': '正常'},
            {'student_id': 1, 'exam_name': '期中考试', 'exam_date': '2026-10-20',
             'subject': '数学', 'score': 80, 'record_status': '正常'},
            {'student_id': 2, 'exam_name': '期中考试', 'exam_date': '2026-10-20',
             'subject': '语文', 'score': None, 'record_status': '缺考'},
            {'student_id': 2, 'exam_name': '期中考试', 'exam_date': '2026-10-20',
             'subject': '数学', 'score': 85, 'record_status': '正常'},
        ])
        summary = scores.score_summary()
        latest = summary['exams'][-1]
        chinese = next(item for item in latest['subject_stats'] if item['subject'] == '语文')
        self.assertEqual(chinese['average'], 70)
        self.assertEqual(chinese['absent_count'], 1)
        self.assertEqual(latest['complete_count'], 1)
        self.assertEqual(latest['class_average_total'], 150)
        first_student_latest = summary['students'][0]['exams'][-1]
        self.assertEqual(first_student_latest['total'], 150)
        self.assertEqual(first_student_latest['total_change'], -30)
        self.assertEqual(first_student_latest['stratum'], 'B层')
        self.assertIsNone(summary['students'][1]['exams'][-1]['total'])

    def test_rule_is_idempotent_handled_resolved_and_reopened(self):
        for key, exam_name, exam_date, score in (
            ('rule-exam-1', '第一次月考', '2026-09-10', 90),
            ('rule-exam-2', '期中考试', '2026-10-20', 60),
        ):
            self.commit(key, [{
                'student_id': 1, 'exam_name': exam_name, 'exam_date': exam_date,
                'subject': '语文', 'score': score, 'record_status': '正常'}])
        created = scores.create_rule(
            name='总分下降二十分', metric='总分下降', threshold=20)
        repeated = scores.evaluate_rules()
        self.assertEqual(created['evaluation']['created_count'], 1)
        self.assertEqual(repeated['created_count'], 0)
        conn = db.get_conn()
        task = conn.execute(
            "SELECT * FROM student_tasks WHERE source_type='score_rule'"
        ).fetchone()
        self.assertIsNotNone(task)
        work_items.update_work_item(
            task['id'], status='已完成', result='已与学生分析失分原因')
        self.assertEqual(conn.execute(
            'SELECT status FROM score_rule_hits'
        ).fetchone()['status'], '已处理')
        self.assertTrue(any(item['kind'] == 'score_followup'
                            for item in student_detail(1)['timeline']))

        self.commit('rule-exam-3', [{
            'student_id': 1, 'exam_name': '第二次月考', 'exam_date': '2026-11-10',
            'subject': '语文', 'score': 95, 'record_status': '正常'}])
        self.assertEqual(conn.execute(
            'SELECT status FROM score_rule_hits'
        ).fetchone()['status'], '已解除')

        result = self.commit('rule-exam-4', [{
            'student_id': 1, 'exam_name': '期末考试', 'exam_date': '2027-01-10',
            'subject': '语文', 'score': 60, 'record_status': '正常'}])
        self.assertEqual(result['evaluation']['reopened_count'], 1)
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM student_tasks WHERE source_type='score_rule'"
        ).fetchone()[0], 1)
        self.assertEqual(conn.execute(
            'SELECT status FROM student_tasks WHERE id=?', (task['id'],)
        ).fetchone()['status'], '待处理')

    def test_config_rename_updates_existing_records(self):
        self.commit('rename-config', [{
            'student_id': 1, 'exam_name': '月考', 'exam_date': '2026-09-10',
            'subject': '语文', 'score': 88, 'record_status': '正常'}])
        config = scores.list_config()
        scores.update_subject(config['subjects'][0]['id'], name='语文学科', full_score=150)
        scores.update_exam(config['exams'][0]['id'], name='九月月考', exam_date='2026-09-11')
        row = db.get_conn().execute('SELECT * FROM exam_records').fetchone()
        self.assertEqual(row['subject'], '语文学科')
        self.assertEqual(row['exam_name'], '九月月考')
        self.assertEqual(row['exam_date'], '2026-09-11')


if __name__ == '__main__':
    unittest.main()
