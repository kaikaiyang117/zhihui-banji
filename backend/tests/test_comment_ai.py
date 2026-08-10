# -*- coding: utf-8 -*-
import asyncio
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.agent.comment_drafter import preview_generation
from app.agent.model_client import ModelResponse
from app.services import comment_ai, comments
from backend.tests.helpers import enroll_all_students


class FakeCommentModel:
    config = SimpleNamespace(model='test-comment-model')

    async def complete(self, messages):
        return ModelResponse(
            '{"items":[{"student_id":1,"content":"本学期学习态度认真，继续保持对目标的坚持。",'
            '"evidence":["本学期事实摘要"],"warnings":[]}]}' , [],
        )


class CommentAITest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        conn = db.get_conn()
        conn.execute(
            'INSERT INTO students(学号, 姓名, 性别, 监护人电话, 家庭住址) VALUES(?,?,?,?,?)',
            ('AI001', 'AI测试生', '女', '13800000000', '测试地址'),
        )
        conn.commit()
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_context_is_safe_and_summarizes_the_term(self):
        context = comment_ai.build_student_term_context(1)
        self.assertEqual(context['姓名'], 'AI测试生')
        self.assertNotIn('监护人电话', context)
        self.assertNotIn('家庭住址', context)
        self.assertIn('考勤', context['facts'])
        self.assertIn('行为记录', context['facts'])

    def test_preview_and_save_ai_draft_preserve_manual_content(self):
        preview = asyncio.run(preview_generation(student_ids=[1], model_client=FakeCommentModel()))
        self.assertEqual(preview['summary']['generated'], 1)
        self.assertEqual(preview['model'], 'test-comment-model')

        result = comments.save_ai_drafts(
            rows=preview['rows'], comment_type=preview['comment_type'],
            model=preview['model'], period=preview['period'])
        self.assertEqual(result['created'], 1)
        item = comments.list_comments(student_id=1)[0]
        comments.update_comment(item['id'], content='教师人工修改后的评语。')

        second = comments.save_ai_drafts(
            rows=preview['rows'], comment_type=preview['comment_type'],
            model=preview['model'], period=preview['period'])
        self.assertEqual(second['protected'], 1)
        self.assertEqual(comments.get_comment(item['id'])['content'], '教师人工修改后的评语。')
        coverage = comments.summary()['coverage']
        self.assertEqual(coverage['generated_student_ids'], [1])


if __name__ == '__main__':
    unittest.main()
