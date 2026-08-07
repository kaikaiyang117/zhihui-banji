# -*- coding: utf-8 -*-
import asyncio
import os
import sys
import tempfile
import unittest

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app as application
from app import db
from app.routers.p0 import EventBody, create_event, list_events
from app.routers.p1 import AttendanceRuleBody, ExamRecord, create_attendance_rule, list_attendance_rules, upsert_exam_record
from app.routers.students import StudentBody, create_student, list_students
from app.services import class_context, duty, class_tasks, funds, points, scores


class ClassContextTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        db.get_conn()
        self.default_scope = class_context.get_current_scope()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def _bind(self, class_id, term_id):
        return class_context.bind_request_scope(class_id, term_id)

    def test_class_and_term_scope_isolates_students_and_business_records(self):
        first_student = create_student(StudentBody(学号='C1001', 姓名='一班学生'))['id']
        create_event(EventBody(
            student_id=first_student, occurred_at='2026-08-07 08:00',
            event_type='课堂表现', description='一班记录'))
        db.insert_row('班主任日志', ['2026-08-07', '', '', '一班日志'])
        upsert_exam_record(ExamRecord(
            student_id=first_student, exam_name='月考', subject='语文', score=90))

        second = class_context.create_class('二班', '七年级', '2026 秋季')
        token = self._bind(second['class_id'], second['term_id'])
        try:
            second_student = create_student(StudentBody(学号='C2001', 姓名='二班学生'))['id']
            create_event(EventBody(
                student_id=second_student, occurred_at='2026-08-07 09:00',
                event_type='课堂表现', description='二班记录'))
            db.insert_row('班主任日志', ['2026-08-07', '', '', '二班日志'])
            self.assertEqual([row['姓名'] for row in list_students()['students']], ['二班学生'])
            self.assertEqual([row['description'] for row in list_events(limit=100)['events']], ['二班记录'])
            self.assertEqual(db.get_rows('班主任日志')[0]['data'][3], '二班日志')
        finally:
            class_context.reset_request_scope(token)

        self.assertEqual([row['姓名'] for row in list_students()['students']], ['一班学生'])
        self.assertEqual([row['description'] for row in list_events(limit=100)['events']], ['一班记录'])
        self.assertEqual(db.get_rows('班主任日志')[0]['data'][3], '一班日志')

    def test_personal_sheet_is_not_split_by_class_context(self):
        db.insert_row('体重体脂追踪', ['2026-08-07', 60])
        second = class_context.create_class('二班', '七年级', '2026 秋季')
        token = self._bind(second['class_id'], second['term_id'])
        try:
            self.assertEqual(db.get_rows('体重体脂追踪')[0]['data'][1], 60)
        finally:
            class_context.reset_request_scope(token)

    def test_rollover_copies_enrollments_and_rules_but_not_history(self):
        student_id = create_student(StudentBody(学号='R1001', 姓名='结转学生'))['id']
        create_event(EventBody(
            student_id=student_id, occurred_at='2026-08-07 08:00',
            event_type='历史事件', description='不应复制'))
        create_attendance_rule(AttendanceRuleBody(name='迟到提醒'))
        subject_id = scores.create_subject(name='语文', full_score=100)['subject_id']
        scores.create_exam(
            name='历史月考', exam_date='2026-08-01', subject_ids=[subject_id])
        upsert_exam_record(ExamRecord(
            student_id=student_id, exam_name='历史月考', exam_date='2026-08-01',
            subject='语文', score=88))
        scores.create_rule(
            name='语文退步提醒', metric='单科下降', subject_id=subject_id,
            threshold=5)
        class_tasks.create_template(
            name='家长回执', material_name='回执', default_due_days=5)
        duty.create_rotation_rule(
            name='卫生轮换', area='教室', start_date='2026-08-10',
            end_date='2026-08-14', student_ids=[student_id])
        points.create_rule(name='周期扣分提醒', threshold=3, period_days=7)
        funds.create_category(name='班费收取', direction='收入')
        result = class_context.rollover_term(
            self.default_scope['term_id'], '下一学期', '2027-02-01', '2027-07-01')

        token = self._bind(result['class_id'], result['term_id'])
        try:
            self.assertEqual([row['姓名'] for row in list_students()['students']], ['结转学生'])
            self.assertEqual(list_events(limit=100)['events'], [])
            self.assertEqual([rule['name'] for rule in list_attendance_rules()['rules']], ['迟到提醒'])
            config = scores.list_config()
            self.assertEqual([item['name'] for item in config['subjects']], ['语文'])
            self.assertEqual(config['exams'], [])
            score_rules = scores.list_rules()['rules']
            self.assertEqual(len(score_rules), 1)
            self.assertEqual(score_rules[0]['name'], '语文退步提醒')
            self.assertEqual(score_rules[0]['subject_name'], '语文')
            self.assertEqual(scores.list_records(), [])
            self.assertEqual([item['name'] for item in class_tasks.list_templates()], ['家长回执'])
            self.assertEqual([item['name'] for item in duty.list_rotation_rules()], ['卫生轮换'])
            self.assertEqual([item['name'] for item in points.list_rules()], ['周期扣分提醒'])
            self.assertIn('班费收取', [item['name'] for item in funds.list_categories()])
        finally:
            class_context.reset_request_scope(token)

        source = db.get_conn().execute(
            'SELECT status FROM terms WHERE id=?', (self.default_scope['term_id'],)
        ).fetchone()
        self.assertEqual(source['status'], '已归档')

    def test_archived_term_is_read_only(self):
        student_id = create_student(StudentBody(学号='A1001', 姓名='归档学生'))['id']
        class_context.update_term(self.default_scope['term_id'], status='已归档')
        self.assertEqual(list_students()['students'][0]['姓名'], '归档学生')
        with self.assertRaises(class_context.ArchivedScopeError):
            create_event(EventBody(
                student_id=student_id, occurred_at='2026-08-07 08:00',
                event_type='归档后写入', description='应被拒绝'))

    def test_api_headers_select_explicit_scope(self):
        create_student(StudentBody(学号='H1001', 姓名='默认班学生'))
        second = class_context.create_class('请求头班级', '八年级', '2026 秋季')
        token = self._bind(second['class_id'], second['term_id'])
        try:
            create_student(StudentBody(学号='H2001', 姓名='请求头学生'))
        finally:
            class_context.reset_request_scope(token)

        async def request_students():
            transport = httpx.ASGITransport(app=application)
            async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
                return await client.get('/api/students', headers={
                    'X-Workbench-Class': str(second['class_id']),
                    'X-Workbench-Term': str(second['term_id']),
                })

        response = asyncio.run(request_students())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['students'][0]['姓名'], '请求头学生')

    def test_transfer_marks_source_and_enrolls_target(self):
        student_id = create_student(StudentBody(学号='T1001', 姓名='转班学生'))['id']
        source_enrollment = class_context.list_enrollments()[0]
        target = class_context.create_class('目标班级', '八年级', '2026 秋季')
        target_enrollment_id = class_context.transfer_enrollment(
            source_enrollment['id'], target['class_id'], target['term_id'])

        source = db.get_conn().execute(
            'SELECT status, left_at FROM student_enrollments WHERE id=?',
            (source_enrollment['id'],)).fetchone()
        self.assertEqual(source['status'], '转出')
        self.assertTrue(source['left_at'])
        self.assertEqual(list_students()['students'], [])

        token = self._bind(target['class_id'], target['term_id'])
        try:
            self.assertEqual(class_context.list_enrollments()[0]['id'], target_enrollment_id)
            self.assertEqual(list_students()['students'][0]['id'], student_id)
        finally:
            class_context.reset_request_scope(token)


if __name__ == '__main__':
    unittest.main()
