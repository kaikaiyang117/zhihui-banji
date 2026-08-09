# -*- coding: utf-8 -*-
import os
import tempfile
import unittest

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.services import education, knowledge, recycle
from backend.tests.helpers import enroll_all_students


class EducationWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.kb = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        self.old_kb = __import__('app.config', fromlist=['KB_DIR']).KB_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        import app.config as config
        config.KB_DIR = self.kb.name
        conn = db.get_conn()
        conn.executemany('INSERT INTO students(学号, 姓名) VALUES(?,?)', [
            ('E001', '班会甲'), ('E002', '活动乙'),
        ])
        conn.commit()
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        import app.config as config
        config.KB_DIR = self.old_kb
        self.temp.cleanup()
        self.kb.cleanup()

    def test_meeting_and_activity_actions_use_unified_work_items(self):
        meeting = education.create_meeting(
            held_on='2026-08-10', topic='班级规则共建', student_ids=[1],
            action_items=[{'title': '整理班级公约', 'due_at': '2026-08-12'}],
        )
        self.assertEqual(meeting['participant_count'], 1)
        self.assertEqual(len(meeting['actions']), 1)
        work_item = db.get_conn().execute(
            'SELECT source_type, source_id, status FROM student_tasks WHERE id=?',
            (meeting['actions'][0]['work_item_id'],),
        ).fetchone()
        self.assertEqual((work_item['source_type'], work_item['status']), ('meeting_action', '待处理'))

        activity = education.create_activity(
            occurred_on='2026-08-11', name='校园志愿服务', activity_type='志愿服务',
            student_ids=[1, 2], followup_title='完成活动复盘', followup_due='2026-08-15',
        )
        self.assertEqual(activity['participant_count'], 2)
        self.assertEqual(activity['work_item_id'], 2)
        self.assertEqual(education.list_activities()[0]['participants'][1]['student_name'], '活动乙')

    def test_diary_links_source_and_legacy_rows_are_retained(self):
        meeting = education.create_meeting(held_on='2026-08-10', topic='历史关联')
        diary = education.create_diary(
            diary_date='2026-08-10', work='完成班会记录',
            links=[{'type': 'meeting', 'id': meeting['id']}],
        )
        self.assertEqual(diary['links'][0]['link_type'], 'meeting')

        db.set_sheet_meta('班会记录', ['日期', '周次', '主题', '形式', '主要内容', '学生参与情况', '效果评估', '备注'])
        db.set_sheet_meta('班级活动', ['日期', '活动名称', '类型', '参与人数', '活动总结', '获奖情况', '佐证材料', '备注'])
        db.set_sheet_meta('班主任日志', ['日期', '星期', '天气', '主要工作', '突发事件', '今日反思', '待办事项'])
        db.insert_row('班会记录', ['2026-08-01', '1', '旧班会', '主题班会', '旧内容', '', '旧效果', ''])
        db.insert_row('班级活动', ['2026-08-02', '旧活动', '社会实践', '2', '旧总结', '', '旧材料', ''])
        db.insert_row('班主任日志', ['2026-08-03', '周一', '晴', '旧工作', '', '旧反思', '旧待办'])
        report = education.migrate_legacy_rows()
        self.assertEqual(report['imported'], 3)
        self.assertEqual(len(education.list_meetings()), 2)
        self.assertEqual(len(education.list_activities()), 1)
        self.assertEqual(len(education.list_diary()), 2)
        self.assertEqual(len(db.get_rows('班会记录')), 1)
        education.migrate_legacy_rows()
        self.assertEqual(db.get_conn().execute('SELECT COUNT(*) FROM meeting_records').fetchone()[0], 2)

    def test_structured_record_can_be_restored_from_recycle_bin(self):
        activity = education.create_activity(occurred_on='2026-08-12', name='可恢复活动')
        result = education.delete_record('activity', activity['id'])
        self.assertTrue(result['recycle_id'])
        self.assertEqual(education.list_activities(), [])
        recycle.restore(result['recycle_id'])
        self.assertEqual(education.list_activities()[0]['name'], '可恢复活动')


class KnowledgeWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.kb = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        import app.config as config
        self.config = config
        self.old_kb = config.KB_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        config.KB_DIR = self.kb.name
        db.get_conn()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.config.KB_DIR = self.old_kb
        self.temp.cleanup()
        self.kb.cleanup()

    def test_search_edit_and_external_change_has_recoverable_conflict(self):
        note = knowledge.create_note(title='活动复盘', category='班级事务', content='# 活动复盘\n\n服务同学', tags=['活动', '复盘'])
        self.assertEqual(knowledge.list_notes(query='服务')['notes'][0]['title'], '活动复盘')
        updated = knowledge.update_note(
            note['id'], content='# 活动复盘\n\n完成归档', expected_hash=note['content_hash'],
            tags=['活动', '归档'],
        )
        self.assertEqual(updated['sync_status'], '同步')
        path = os.path.join(self.kb.name, note['relative_path'])
        with open(path, 'a', encoding='utf-8') as target:
            target.write('\n外部修改')
        external = knowledge.read_note(note['relative_path'])
        self.assertTrue(external['recoverable'])
        self.assertEqual(external['sync_status'], '文件已修改')
        with self.assertRaises(knowledge.KnowledgeConflict):
            knowledge.update_note(note['id'], content='# 覆盖', expected_hash=updated['content_hash'])
        adopted = knowledge.adopt_external_change(note['id'])
        self.assertEqual(adopted['sync_status'], '同步')

    def test_path_traversal_is_rejected(self):
        with self.assertRaises(knowledge.KnowledgeError):
            knowledge.read_note('../outside.md')


if __name__ == '__main__':
    unittest.main()
