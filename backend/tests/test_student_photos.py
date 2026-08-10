# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app, db
from app.routers.p0 import student_detail
from app.routers.students import StudentBody, create_student


class StudentPhotoTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        db.get_conn()
        self.student_id = create_student(StudentBody(学号='P001', 姓名='照片测试学生'))['id']
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_upload_detail_read_and_remove_photo(self):
        jpeg = b'\xff\xd8\xff\xe0student-photo'
        response = self.client.post(
            f'/api/students/{self.student_id}/photo',
            files={'file': ('student.jpg', jpeg, 'image/jpeg')},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['photo_url'])

        row = db.get_conn().execute(
            'SELECT photo_path FROM students WHERE id=?', (self.student_id,)
        ).fetchone()
        stored_path = os.path.join(db.DATA_DIR, row['photo_path'])
        self.assertTrue(os.path.isfile(stored_path))
        self.assertEqual(student_detail(self.student_id)['student']['photo_url'], response.json()['photo_url'])
        self.assertEqual(self.client.get(response.json()['photo_url']).content, jpeg)

        deleted = self.client.delete(f'/api/students/{self.student_id}/photo')
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(os.path.exists(stored_path))
        self.assertEqual(student_detail(self.student_id)['student']['photo_url'], '')


if __name__ == '__main__':
    unittest.main()
