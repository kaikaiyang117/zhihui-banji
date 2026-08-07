# -*- coding: utf-8 -*-
import os
import json
import tempfile
import unittest
from datetime import date, timedelta

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.services import attendance
from app.routers.p0 import student_detail
from app.routers.p1 import (
    AttendanceRuleBody,
    ClassTaskBody,
    ClassTaskItemUpdate,
    DutyBody,
    ExamRecord,
    create_attendance_rule,
    create_class_task,
    create_duty,
    evaluate_attendance_rules,
    import_exam_rows,
    list_class_tasks,
    list_duty,
    search,
    update_class_task_item,
    upsert_exam_record,
)
from backend.tests.helpers import enroll_all_students


class P1WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        db.get_conn()
        conn = db.get_conn()
        with open(os.path.join(os.path.dirname(__file__), 'fixtures', 'p1_demo.json'), encoding='utf-8') as f:
            fixture = json.load(f)
        conn.executemany('INSERT INTO students(学号, 姓名, 性别) VALUES(?,?,?)', [
            (row['学号'], row['姓名'], row['性别']) for row in fixture['students']])
        conn.commit()
        enroll_all_students()
        self.fixture = fixture

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_import_scores_and_student_detail_summary(self):
        result = import_exam_rows(self.fixture['exam_rows'])
        self.assertEqual(result['imported'], 4)
        self.assertEqual(student_detail(1)['score_summary']['exams'][0]['total'], 180)
        self.assertEqual(search('第一次月考')['results'][0]['kind'], '成绩')
        upsert_exam_record(ExamRecord(student_id=1, exam_name='第二次月考', subject='语文', score=95))
        self.assertEqual(len(student_detail(1)['score_summary']['exams']), 2)

    def test_attendance_rule_creates_one_followup_task(self):
        today = date.today().isoformat()
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        for day in (yesterday, today):
            attendance.save_daily(day, '常规到校', [
                {'student_id': 1, 'status': '迟到'},
            ], evaluate=False)
        created = create_attendance_rule(AttendanceRuleBody(
            name='一周迟到提醒', metric='迟到次数', threshold=2, period_days=7))
        self.assertEqual(created['evaluation']['created_count'], 1)
        result = evaluate_attendance_rules()
        self.assertEqual(result['count'], 0)
        row = db.get_conn().execute('SELECT source_key FROM student_tasks').fetchone()
        self.assertEqual(row['source_key'], 'attendance_rule:1:student:1')

    def test_class_task_material_collection_and_duty(self):
        task = create_class_task(ClassTaskBody(title='收齐家长回执', material_name='家长回执', student_ids=[1, 2]))
        self.assertEqual(list_class_tasks()['tasks'][0]['total'], 2)
        self.assertIsNotNone(db.get_conn().execute(
            "SELECT 1 FROM student_tasks WHERE source_key=?", (f"class_task:{task['task_id']}",)
        ).fetchone())
        update_class_task_item(task['task_id'], 1, ClassTaskItemUpdate(status='已提交', note='纸质版'))
        task_data = list_class_tasks()['tasks'][0]
        self.assertEqual(task_data['submitted'], 1)
        duty = create_duty(DutyBody(duty_date='2026-08-07', area='教室前排', student_id=2))
        self.assertTrue(duty['assignment_id'])
        self.assertIsNotNone(db.get_conn().execute(
            "SELECT 1 FROM student_tasks WHERE source_key=?", (f"duty_assignment:{duty['assignment_id']}",)
        ).fetchone())
        self.assertEqual(list_duty('2026-08-07')['assignments'][0]['姓名'], '测试同学乙')


if __name__ == '__main__':
    unittest.main()
