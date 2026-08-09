# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.routers.stats import dashboard
from app.services import class_context, dashboard as dashboard_service
from app.services import work_items
from backend.tests.helpers import enroll_all_students


class WorkItemsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        conn = db.get_conn()
        conn.executemany(
            'INSERT INTO students(学号, 姓名) VALUES(?,?)',
            [('W001', '工作项甲'), ('W002', '工作项乙')],
        )
        conn.commit()
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_source_work_item_is_idempotent_and_links_back(self):
        first = work_items.ensure_source_work_item(
            title='复查学生事件', student_id=1, source_type='event', source_id=91,
            due_at='2026-08-08', notes='来源说明')
        second = work_items.ensure_source_work_item(
            title='复查学生事件', student_id=1, source_type='event', source_id=91,
            due_at='2026-08-09')
        self.assertTrue(first['created'])
        self.assertFalse(second['created'])
        self.assertEqual(first['id'], second['id'])
        rows = work_items.list_work_items(reference_date=date(2026, 8, 7))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['source_path'], '/events?source_id=91')

    def test_time_buckets_and_summary_match(self):
        for title, scheduled_at, due_at in (
            ('逾期事项', '', '2026-08-06'),
            ('今天事项', '2026-08-07', '2026-08-10'),
            ('未来事项', '', '2026-08-12'),
            ('未排期事项', '', ''),
        ):
            work_items.create_work_item(
                title=title, scheduled_at=scheduled_at, due_at=due_at)
        today = date(2026, 8, 7)
        self.assertEqual(len(work_items.list_work_items(bucket='overdue', reference_date=today)), 1)
        self.assertEqual(len(work_items.list_work_items(bucket='today', reference_date=today)), 1)
        self.assertEqual(len(work_items.list_work_items(bucket='next7', reference_date=today)), 1)
        summary = work_items.work_item_summary(reference_date=today)
        self.assertEqual(summary['all'], 4)
        self.assertEqual(summary['open'], 4)
        self.assertEqual(summary['overdue'], 1)
        self.assertEqual(summary['today'], 1)
        self.assertEqual(summary['next7'], 1)

    def test_complete_postpone_cancel_and_reopen(self):
        item_id = work_items.create_work_item(
            title='待处理事项', due_at='2026-08-07')['id']
        with self.assertRaises(work_items.WorkItemError):
            work_items.update_work_item(item_id, status='已完成')
        completed = work_items.update_work_item(
            item_id, status='已完成', result='已经电话确认')
        self.assertEqual(completed['result'], '已经电话确认')
        self.assertTrue(completed['completed_at'])
        reopened = work_items.update_work_item(
            item_id, status='处理中', due_at='2026-08-10')
        self.assertEqual(reopened['due_at'], '2026-08-10')
        self.assertEqual(reopened['result'], '')
        cancelled = work_items.update_work_item(
            item_id, status='已取消', result='不再需要处理')
        self.assertTrue(cancelled['cancelled_at'])

    def test_legacy_open_item_can_be_adopted_by_source(self):
        manual = work_items.create_work_item(
            title='考勤提醒 · 工作项甲 · 迟到规则', student_id=1)['id']
        adopted = work_items.ensure_source_work_item(
            title='考勤提醒 · 工作项甲 · 迟到规则',
            legacy_title='考勤提醒 · 工作项甲 · 迟到规则',
            student_id=1, source_type='attendance_rule', source_id=7,
            due_at='2026-08-07')
        self.assertEqual(adopted['id'], manual)
        self.assertFalse(adopted['created'])
        row = db.get_conn().execute(
            'SELECT source_key FROM student_tasks WHERE id=?', (manual,)
        ).fetchone()
        self.assertEqual(row['source_key'], 'attendance_rule:7:student:1')

    def test_concurrent_creates_return_distinct_ids(self):
        with ThreadPoolExecutor(max_workers=3) as pool:
            ids = list(pool.map(
                lambda index: work_items.create_work_item(title=f'并发事项 {index}')['id'],
                range(3),
            ))
        self.assertEqual(len(set(ids)), 3)
        self.assertEqual(db.get_conn().execute(
            "SELECT COUNT(*) FROM student_tasks WHERE title LIKE '并发事项 %'"
        ).fetchone()[0], 3)

    def test_dashboard_action_counts_match_work_item_service(self):
        today = date(2026, 8, 7)
        work_items.create_work_item(title='逾期行动', due_at='2026-08-06')
        work_items.create_work_item(title='今日行动', scheduled_at='2026-08-07')
        work_items.create_work_item(title='即将行动', due_at='2026-08-11')
        work_items.create_work_item(
            title='考勤规则命中', student_id=1, source_type='attendance_rule',
            source_id=9, due_at='2026-08-07')

        conn = db.get_conn()
        class_id, term_id = class_context.scope_ids(conn=conn)
        class_task_id = conn.execute(
            '''INSERT INTO class_tasks(
                   title, task_type, due_at, status, class_id, term_id
               ) VALUES(?,?,?,?,?,?)''',
            ('收集回执', '材料收集', '2026-08-09', '进行中', class_id, term_id),
        ).lastrowid
        conn.executemany(
            'INSERT INTO class_task_items(task_id, student_id, status) VALUES(?,?,?)',
            [(class_task_id, 1, '已提交'), (class_task_id, 2, '待提交')],
        )
        conn.execute(
            '''INSERT INTO focus_items(
                   student_id, topic, reason, status, next_review_at, class_id, term_id
               ) VALUES(?,?,?,?,?,?,?)''',
            (1, '学习状态', '需要复查', '跟进中', '2026-08-07', class_id, term_id),
        )
        conn.commit()

        result = dashboard(date='2026-08-07')
        self.assertEqual(
            result['work_summary'],
            work_items.work_item_summary(reference_date=today),
        )
        self.assertEqual(result['work_summary']['overdue'], 1)
        self.assertEqual(result['work_summary']['today'], 2)
        self.assertEqual(result['work_summary']['next7'], 1)
        self.assertEqual(len(result['rule_hits']), 1)
        self.assertEqual(result['material_tasks'][0]['progress'], 50)
        self.assertEqual(result['review_students'][0]['student_name'], '工作项甲')

    def test_dashboard_calendar_groups_month_and_upcoming_work(self):
        today = date(2026, 8, 7)
        work_items.create_work_item(title='今天的日历事项', due_at='2026-08-07')
        work_items.create_work_item(title='下周的日历事项', due_at='2026-08-11')

        result = dashboard_service.calendar(reference_date=today)

        self.assertEqual(result['month'], '2026-08')
        self.assertEqual(len(result['days']), 31)
        today_row = next(day for day in result['days'] if day['date'] == '2026-08-07')
        self.assertEqual(today_row['task_count'], 1)
        self.assertTrue(today_row['is_today'])
        upcoming = next(item for item in result['upcoming'] if item['date'] == '2026-08-11')
        self.assertEqual(upcoming['item_count'], 1)
        self.assertEqual(upcoming['items'][0]['title'], '下周的日历事项')


if __name__ == '__main__':
    unittest.main()
