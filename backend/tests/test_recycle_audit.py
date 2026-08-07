# -*- coding: utf-8 -*-
import json
import os
import sys
import tempfile
import unittest

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app, db
from app.routers.p0 import EventBody, create_event, list_events
from app.routers.students import StudentBody, create_student, list_students
from app.routers.recycle import _is_local_host
from app.services import audit, class_context, recycle, work_items


class RecycleAuditTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        db.get_conn()
        created = create_student(StudentBody(
            学号='R001', 姓名='恢复测试', 监护人电话='13800000000',
            家庭住址='测试地址'))
        self.student_id = created['id']

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_student_delete_restore_preserves_related_records(self):
        created = create_event(EventBody(
            student_id=self.student_id, occurred_at='2026-08-07 08:00',
            event_type='课堂表现', description='需要后续复查',
            needs_followup=True, followup_due='2026-08-10'))
        result = recycle.soft_delete('student', self.student_id)
        self.assertEqual(list_students()['students'], [])
        self.assertEqual(list_events(limit=100)['events'], [])
        conn = db.get_conn()
        self.assertIsNotNone(conn.execute(
            'SELECT id FROM student_events WHERE id=?', (created['event_id'],)).fetchone())
        self.assertIsNotNone(conn.execute(
            'SELECT id FROM student_tasks WHERE id=?', (created['task_id'],)).fetchone())

        recycle.restore(result['recycle_id'])
        self.assertEqual(list_students()['students'][0]['id'], self.student_id)
        self.assertEqual(list_events(limit=100)['events'][0]['id'], created['event_id'])
        self.assertEqual(
            work_items.list_work_items(student_id=self.student_id)[0]['id'],
            created['task_id'])

    def test_core_record_and_sheet_row_can_be_restored(self):
        created = create_event(EventBody(
            student_id=self.student_id, occurred_at='2026-08-07 09:00',
            event_type='迟到', description='早读迟到', needs_followup=True,
            followup_due='2026-08-09'))
        deleted = recycle.soft_delete('event', created['event_id'])
        self.assertEqual(list_events(limit=100)['events'], [])
        self.assertEqual(work_items.list_work_items(), [])
        recycle.restore(deleted['recycle_id'])
        self.assertEqual(list_events(limit=100)['events'][0]['id'], created['event_id'])
        self.assertEqual(work_items.list_work_items()[0]['id'], created['task_id'])

        row_no = db.insert_row('班主任日志', ['2026-08-07', '周五', '晴', '测试记录'])
        sheet_deleted = recycle.soft_delete_sheet_row('班主任日志', row_no)
        self.assertEqual(db.get_rows('班主任日志'), [])
        recycle.restore(sheet_deleted['recycle_id'])
        self.assertEqual(db.get_rows('班主任日志')[0]['row_no'], row_no)

    def test_audit_records_actor_channel_and_redacts_sensitive_fields(self):
        token = audit.bind_actor('web', 'teacher-device')
        try:
            audit.record(
                'student', self.student_id, 'update', summary='敏感字段测试',
                params={'api_key': 'sk-test-secret', '监护人电话': '13800000000',
                        '家庭住址': '不能进入日志', '姓名': '恢复测试'})
        finally:
            audit.reset_actor(token)
        row = db.get_conn().execute(
            "SELECT * FROM system_audit WHERE summary='敏感字段测试'"
        ).fetchone()
        self.assertEqual((row['channel'], row['actor_id']), ('web', 'teacher-device'))
        payload = row['params_summary']
        self.assertNotIn('sk-test-secret', payload)
        self.assertNotIn('13800000000', payload)
        self.assertNotIn('不能进入日志', payload)
        self.assertEqual(json.loads(payload)['api_key'], '***')

    def test_mutating_api_without_specific_service_audit_gets_fallback_record(self):
        with TestClient(app) as client:
            response = client.post('/api/attendance/rules', json={
                'name': '审计测试规则', 'metric': '迟到次数', 'threshold': 2,
                'period_days': 7, 'priority': '重要', 'enabled': True,
            })
        self.assertEqual(response.status_code, 200)
        row = db.get_conn().execute(
            "SELECT status, object_id, action FROM system_audit WHERE object_type='api_request' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        self.assertEqual((row['status'], row['object_id'], row['action']),
                         ('success', '/api/attendance/rules', 'post'))

    def test_permanent_delete_requires_confirmation(self):
        self.assertTrue(_is_local_host('127.0.0.1'))
        self.assertFalse(_is_local_host('192.168.1.20'))
        deleted = recycle.soft_delete('student', self.student_id)
        with self.assertRaises(recycle.RecycleError):
            recycle.purge(deleted['recycle_id'], '删除')
        self.assertIsNotNone(db.get_conn().execute(
            'SELECT id FROM students WHERE id=?', (self.student_id,)).fetchone())
        recycle.purge(deleted['recycle_id'], '永久删除')
        self.assertIsNone(db.get_conn().execute(
            'SELECT id FROM students WHERE id=?', (self.student_id,)).fetchone())

    def test_archived_term_blocks_delete_and_restore(self):
        class_id, term_id = class_context.scope_ids(conn=db.get_conn())
        deleted = recycle.soft_delete('student', self.student_id)
        class_context.update_term(term_id, status='已归档', conn=db.get_conn())
        with self.assertRaises(class_context.ArchivedScopeError):
            recycle.restore(deleted['recycle_id'])


if __name__ == '__main__':
    unittest.main()
