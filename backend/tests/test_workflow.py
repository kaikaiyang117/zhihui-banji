# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.routers.p0 import (
    CommunicationBody, EventBody, FocusBody,
    create_communication, create_event, create_focus, student_detail,
)
from app.services import workflow, work_items
from backend.tests.helpers import enroll_all_students


class WorkflowLinkageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        conn = db.get_conn()
        conn.execute("INSERT INTO students(学号, 姓名) VALUES('WF001','闭环测试学生')")
        conn.commit()
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_event_progress_close_and_idempotency(self):
        created = create_event(EventBody(
            student_id=1, occurred_at='2026-08-07 08:00', event_type='作业异常',
            description='连续未交作业', needs_followup=True,
            followup_due='2026-08-10'))
        event_id, task_id = created['event_id'], created['task_id']
        result = workflow.update_source(
            'event', event_id, status='处理中', progress='已与学生面谈',
            next_action_at='2026-08-11', request_id='event-progress-1')
        self.assertFalse(result['duplicate'])
        linked = db.get_conn().execute(
            'SELECT status, due_at FROM student_tasks WHERE id=?', (task_id,)
        ).fetchone()
        self.assertEqual((linked['status'], linked['due_at']), ('处理中', '2026-08-11'))
        duplicate = workflow.update_source(
            'event', event_id, status='处理中', progress='重复提交',
            request_id='event-progress-1')
        self.assertTrue(duplicate['duplicate'])
        with self.assertRaises(workflow.WorkflowError):
            workflow.update_source(
                'event', event_id, status='已完成', result='情况已改善')
        closed = workflow.update_source(
            'event', event_id, status='已完成', result='情况已改善',
            task_action='complete', request_id='event-close-1')
        self.assertEqual(closed['source']['status'], '已完成')
        self.assertEqual(closed['source']['result'], '情况已改善')
        task = db.get_conn().execute(
            'SELECT status, result FROM student_tasks WHERE id=?', (task_id,)
        ).fetchone()
        self.assertEqual((task['status'], task['result']), ('已完成', '情况已改善'))
        self.assertEqual(len(closed['updates']), 2)

    def test_work_item_completion_closes_and_reopen_restores_source(self):
        created = create_event(EventBody(
            student_id=1, occurred_at='2026-08-07 09:00', event_type='迟到',
            description='早读迟到', needs_followup=True, followup_due='2026-08-08'))
        work_items.update_work_item(
            created['task_id'], status='已完成', result='复查后已恢复正常')
        event = db.get_conn().execute(
            'SELECT status, result FROM student_events WHERE id=?', (created['event_id'],)
        ).fetchone()
        self.assertEqual((event['status'], event['result']), ('已完成', '复查后已恢复正常'))
        work_items.update_work_item(created['task_id'], status='处理中')
        event = db.get_conn().execute(
            'SELECT status FROM student_events WHERE id=?', (created['event_id'],)
        ).fetchone()
        self.assertEqual(event['status'], '待复查')
        timeline = student_detail(1)['timeline']
        self.assertTrue(any(item['kind'] == 'workflow' for item in timeline))

    def test_work_item_progress_status_updates_source_status(self):
        created = create_event(EventBody(
            student_id=1, occurred_at='2026-08-07 10:00', event_type='课堂表现',
            description='需要持续观察', needs_followup=True, followup_due='2026-08-09'))
        work_items.update_work_item(created['task_id'], status='处理中')
        row = db.get_conn().execute(
            'SELECT status FROM student_events WHERE id=?', (created['event_id'],)
        ).fetchone()
        self.assertEqual(row['status'], '处理中')

    def test_communication_and_focus_follow_same_linkage_rules(self):
        communication = create_communication(CommunicationBody(
            student_id=1, communicated_at='2026-08-07 18:00', method='电话',
            reason='学习状态', summary='与家长沟通', followup_at='2026-08-10'))
        closed = workflow.update_source(
            'communication', communication['communication_id'], status='已完成',
            result='家长已反馈执行情况', task_action='cancel')
        self.assertEqual(closed['linked_work_item']['status'], '已取消')

        focus = create_focus(FocusBody(
            student_id=1, topic='情绪状态', reason='近期情绪低落',
            action_plan='持续观察', next_review_at='2026-08-12'))
        work_items.update_work_item(
            focus['task_id'], status='已完成', result='状态已经稳定')
        row = db.get_conn().execute(
            'SELECT status, conclusion FROM focus_items WHERE id=?', (focus['focus_id'],)
        ).fetchone()
        self.assertEqual((row['status'], row['conclusion']), ('已结束', '状态已经稳定'))


if __name__ == '__main__':
    unittest.main()
