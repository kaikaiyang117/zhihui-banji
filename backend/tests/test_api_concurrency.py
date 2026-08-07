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
from app.routers.students import StudentBody, create_student
from app.services import class_context, scores


class ApiConcurrencyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        db.get_conn()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_parallel_score_reads_use_independent_thread_connections(self):
        student_id = create_student(StudentBody(学号='Q1001', 姓名='并发样本'))['id']
        scores.commit_exam_rows([{
            'row': 2, 'student_id': student_id, 'exam_name': '并发月考',
            'exam_date': '2026-09-10', 'subject': '语文', 'score': 90,
            'record_status': '正常', 'note': '',
        }], filename='并发样本.xlsx', request_id='concurrency-seed')
        scope = class_context.get_current_scope()
        headers = {
            'X-Workbench-Class': str(scope['class_id']),
            'X-Workbench-Term': str(scope['term_id']),
        }

        async def request_all():
            transport = httpx.ASGITransport(app=application)
            async with httpx.AsyncClient(
                transport=transport, base_url='http://test', timeout=10,
            ) as client:
                return await asyncio.gather(*[
                    client.get(path, headers=headers)
                    for _ in range(100)
                    for path in (
                        '/api/exams/summary', '/api/score-config', '/api/score-rules',
                    )
                ])

        responses = asyncio.run(request_all())
        failures = [
            (response.request.url.path, response.status_code, response.text)
            for response in responses if response.status_code != 200
        ]
        self.assertEqual(failures, [])
        summaries = [
            response.json() for response in responses
            if response.request.url.path == '/api/exams/summary'
        ]
        self.assertTrue(all(item['records'][0]['score'] == 90 for item in summaries))


if __name__ == '__main__':
    unittest.main()
