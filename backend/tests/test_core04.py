# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest

from fastapi import HTTPException

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.routers.p1 import (
    ClassTaskBody,
    ClassTaskBulkItemUpdate,
    ClassTaskItemUpdate,
    ClassTaskUpdate,
    DutyBody,
    DutyUpdate,
    create_class_task,
    create_duty,
    list_class_tasks,
    list_duty,
    update_class_task,
    update_class_task_items_bulk,
    update_class_task_item,
    update_duty,
)
from app.services import class_tasks, duty, work_items
from backend.tests.helpers import enroll_all_students


class Core04WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        db.get_conn()
        conn = db.get_conn()
        conn.executemany('INSERT INTO students(学号, 姓名) VALUES(?,?)', [
            ('C001', '甲同学'), ('C002', '乙同学'), ('C003', '丙同学'),
        ])
        conn.commit()
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_task_close_requires_explicit_incomplete_confirmation(self):
        created = create_class_task(ClassTaskBody(
            title='收集回执', student_ids=[1, 2], due_at='2026-08-10'))
        with self.assertRaises(HTTPException) as error:
            update_class_task(created['task_id'], ClassTaskUpdate(
                status='已完成', completion_result='已处理'))
        self.assertEqual(error.exception.status_code, 409)

        update_class_task_item(created['task_id'], 1, ClassTaskItemUpdate(status='已提交'))
        completed = update_class_task(created['task_id'], ClassTaskUpdate(
            status='已完成', completion_result='乙同学未提交，已电话确认', confirm_incomplete=True))
        self.assertEqual(completed['task']['status'], '已完成')
        self.assertEqual(completed['task']['closed_with_missing_count'], 1)
        linked = db.get_conn().execute(
            "SELECT status, result FROM student_tasks WHERE source_key=?",
            (f"class_task:{created['task_id']}",)).fetchone()
        self.assertEqual((linked['status'], linked['result']), ('已完成', '乙同学未提交，已电话确认'))

    def test_attachment_and_reminder_are_recorded_after_file_write(self):
        created = create_class_task(ClassTaskBody(title='收材料', student_ids=[1, 2]))
        result = class_tasks.remind(created['task_id'])
        self.assertEqual(result['reminded'], 2)
        attachment = class_tasks.save_attachment(
            created['task_id'], 1, filename='../回执.txt', content_type='text/plain', content='已确认'.encode())
        self.assertEqual(attachment['size_bytes'], len('已确认'.encode()))
        row = db.get_conn().execute(
            'SELECT original_name, sha256 FROM class_task_attachments WHERE id=?',
            (attachment['id'],)).fetchone()
        self.assertEqual(row['original_name'], '回执.txt')
        self.assertTrue(row['sha256'])
        item = list_class_tasks()['tasks'][0]['items'][0]
        self.assertEqual(item['attachment_count'], 1)
        self.assertEqual(item['reminder_count'], 1)

    def test_bulk_updates_task_items(self):
        created = create_class_task(ClassTaskBody(title='批量收材料', student_ids=[1, 2, 3]))
        updated = update_class_task_items_bulk(
            created['task_id'], ClassTaskBulkItemUpdate(student_ids=[1, 2], status='已提交'))
        items = {item['student_id']: item['status'] for item in updated['task']['items']}
        self.assertEqual(items, {1: '已提交', 2: '已提交', 3: '未提交'})

    def test_duty_conflict_completion_and_rotation(self):
        first = create_duty(DutyBody(duty_date='2026-08-07', area='教室', student_id=1))
        with self.assertRaises(HTTPException) as error:
            create_duty(DutyBody(duty_date='2026-08-07', area='走廊', student_id=1))
        self.assertEqual(error.exception.status_code, 409)
        updated = update_duty(first['assignment_id'], DutyUpdate(
            status='已完成', completion_result='完成清扫'))
        self.assertEqual(updated['assignment']['status'], '已完成')
        linked = db.get_conn().execute(
            "SELECT status, result FROM student_tasks WHERE source_key=?",
            (f"duty_assignment:{first['assignment_id']}",)).fetchone()
        self.assertEqual((linked['status'], linked['result']), ('已完成', '完成清扫'))

        rule = duty.create_rotation_rule(
            name='工作日轮换', area='黑板', start_date='2026-08-10', end_date='2026-08-14',
            weekday_mask=31, student_ids=[1, 2])
        preview = duty.generate_rotation(rule['id'], date_from='2026-08-10', date_to='2026-08-14')
        self.assertEqual(len(preview['proposals']), 5)
        generated = duty.generate_rotation(
            rule['id'], date_from='2026-08-10', date_to='2026-08-14', confirm=True)
        self.assertEqual(generated['created'], 5)
        self.assertEqual(len(list_duty('2026-08-12')['assignments']), 1)

    def test_source_work_item_cannot_close_task_with_missing_students(self):
        created = create_class_task(ClassTaskBody(title='工作台关闭测试', student_ids=[1, 2]))
        work_item = db.get_conn().execute(
            "SELECT id FROM student_tasks WHERE source_key=?",
            (f"class_task:{created['task_id']}",)).fetchone()
        with self.assertRaises(class_tasks.ClassTaskError):
            work_items.update_work_item(int(work_item['id']), status='已完成', result='从工作台完成')
        task = list_class_tasks()['tasks'][0]
        self.assertEqual(task['status'], '进行中')


if __name__ == '__main__':
    unittest.main()
