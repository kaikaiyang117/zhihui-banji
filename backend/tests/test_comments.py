# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.services import comments
from backend.tests.helpers import enroll_all_students


class CommentWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        conn = db.get_conn()
        conn.executemany(
            'INSERT INTO students(学号, 姓名, 性别, 特长, 班级任职) VALUES(?,?,?,?,?)', [
                ('C001', '评语甲', '女', '绘画', '班长'),
                ('C002', '评语乙', '男', '', ''),
            ])
        conn.commit()
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_preview_reports_missing_variables_and_requires_confirmation(self):
        template = comments.create_template(
            name='综合表现', comment_type='学期评语',
            content='{{姓名}}同学在{{学期}}表现认真，特长是{{特长}}。')
        preview = comments.preview_generation(template_id=template['id'])
        self.assertEqual(preview['summary']['requested'], 2)
        missing = next(row for row in preview['rows'] if row['学号'] == 'C002')
        self.assertEqual(missing['missing_variables'], ['特长'])
        self.assertIn('〔特长未填写〕', missing['content'])
        with self.assertRaises(comments.CommentError):
            comments.generate_batch(template_id=template['id'])
        result = comments.generate_batch(template_id=template['id'], confirm_missing=True)
        self.assertEqual(result['created'], 2)
        self.assertEqual(result['missing'], 1)

    def test_regeneration_never_overwrites_manually_edited_draft(self):
        template = comments.create_template(
            name='学习表现', content='{{姓名}}同学本学期表现良好。')
        comments.generate_batch(template_id=template['id'])
        first = comments.list_comments(student_id=1)[0]
        comments.update_comment(first['id'], content='这是教师人工修改后的评语。')
        comments.update_template(template['id'], content='{{姓名}}同学本学期进步明显。')
        result = comments.generate_batch(template_id=template['id'])
        self.assertEqual(result['protected'], 1)
        self.assertEqual(result['updated'], 1)
        protected = comments.get_comment(first['id'])
        self.assertEqual(protected['content'], '这是教师人工修改后的评语。')
        self.assertTrue(protected['is_manually_edited'])

    def test_review_delivery_and_versions_follow_state_machine(self):
        item = comments.create_comment(
            student_id=1, comment_type='毕业评语', content='愿你保持热爱。')
        with self.assertRaises(comments.CommentError):
            comments.transition_comment(item['id'], '已发送', delivery_method='纸质')
        item = comments.transition_comment(item['id'], '待审核')
        item = comments.transition_comment(item['id'], '完成', note='审核通过')
        self.assertTrue(item['reviewed_at'])
        with self.assertRaises(comments.CommentError):
            comments.transition_comment(item['id'], '已发送')
        item = comments.transition_comment(item['id'], '已发送', delivery_method='纸质评语册')
        self.assertEqual(item['delivery_method'], '纸质评语册')
        versions = comments.comment_versions(item['id'])
        self.assertEqual([row['status'] for row in versions[:4]], ['已发送', '完成', '待审核', '草稿'])

    def test_legacy_migration_and_export_use_stable_student_id(self):
        db.set_sheet_meta('评语管理', ['学号', '姓名', '评语类型', '评语内容', '完成状态', '备注'])
        db.insert_row('评语管理', ['C001', '错误姓名不影响关联', '学期评语', '历史评语', '已完成', '旧数据'])
        summary = comments.summary()
        self.assertEqual(summary['migration']['imported_entries'], 1)
        item = comments.list_comments()[0]
        self.assertEqual(item['student_id'], 1)
        self.assertEqual(item['status'], '完成')
        self.assertEqual(len(db.get_rows('评语管理')), 1)
        from app.export_service import export_sheet
        buffer, filename = export_sheet('评语管理')
        self.assertEqual(filename, '学生评语.xlsx')
        self.assertGreater(len(buffer.getvalue()), 100)


if __name__ == '__main__':
    unittest.main()
