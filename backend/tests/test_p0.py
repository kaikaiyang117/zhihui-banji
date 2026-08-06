# -*- coding: utf-8 -*-
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.routers.p0 import (
    CommunicationBody,
    DailyAttendanceBody,
    EventBody,
    FocusBody,
    TaskUpdate,
    create_communication,
    create_event,
    create_focus,
    list_tasks,
    migrate_legacy_core_rows,
    save_daily_attendance,
    student_detail,
    update_task,
)


class P0WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        db.get_conn()
        fixture_path = os.path.join(os.path.dirname(__file__), 'fixtures', 'p0_demo.json')
        with open(fixture_path, encoding='utf-8') as f:
            fixture = json.load(f)
        for student in fixture['students']:
            columns = ['学号', '姓名', '性别', '班级任职']
            db.get_conn().execute(
                'INSERT INTO students(学号, 姓名, 性别, 班级任职) VALUES(?,?,?,?)',
                tuple(student.get(c, '') for c in columns))
        db.get_conn().commit()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_event_creates_followup_task_and_timeline(self):
        result = create_event(EventBody(
            student_id=1, occurred_at='2026-08-06 08:10', event_type='迟到',
            description='早读迟到十分钟', handling='已提醒', needs_followup=True,
            followup_due='2026-08-09', status='待复查'))
        self.assertTrue(result['event_id'])
        self.assertTrue(result['task_id'])
        detail = student_detail(1)
        self.assertEqual(len(detail['events']), 1)
        self.assertEqual(detail['tasks'][0]['status'], '待复查')
        self.assertEqual(detail['timeline'][0]['kind'], 'event')

    def test_communication_followup_and_task_completion(self):
        result = create_communication(CommunicationBody(
            student_id=2, communicated_at='2026-08-06 09:00', method='电话',
            reason='学习状态', summary='与家长沟通近期学习安排',
            agreement='周末完成错题整理', followup_at='2026-08-10'))
        self.assertTrue(result['communication_id'])
        self.assertTrue(result['task_id'])
        tasks = list_tasks(limit=100)
        self.assertEqual(len(tasks['tasks']), 1)
        update_task(result['task_id'], TaskUpdate(status='已完成'))
        self.assertEqual(list_tasks(limit=100)['tasks'][0]['status'], '已完成')

    def test_daily_attendance_upserts_without_duplicates(self):
        body = DailyAttendanceBody(date='2026-08-06', records=[
            {'student_id': 1, 'status': '迟到', 'arrive': '08:10', 'reason': '交通'},
            {'student_id': 2, 'status': '出勤'}
        ])
        self.assertEqual(save_daily_attendance(body)['saved'], 2)
        body.records[0].status = '出勤'
        self.assertEqual(save_daily_attendance(body)['saved'], 2)
        rows = [r for r in db.get_rows('考勤管理') if r['data'][0] == '2026-08-06']
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['data'][4], '出勤')

    def test_focus_lifecycle(self):
        result = create_focus(FocusBody(
            student_id=1, topic='学习状态', reason='连续两次作业未完成',
            action_plan='一周后复查', next_review_at='2026-08-13'))
        self.assertTrue(result['focus_id'])
        detail = student_detail(1)
        self.assertEqual(detail['focus'][0]['status'], '待确认')

    def test_legacy_communication_is_migrated(self):
        db.insert_row('家校沟通记录', ['2026-08-06', '测试同学甲', '电话', '学习状态', '已沟通', '家长反馈', '一周后回访', '待跟进'])
        migrate_legacy_core_rows()
        detail = student_detail(1)
        self.assertEqual(detail['communications'][0]['summary'], '已沟通')


if __name__ == '__main__':
    unittest.main()
