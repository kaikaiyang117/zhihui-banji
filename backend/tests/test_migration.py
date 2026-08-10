# -*- coding: utf-8 -*-
import json
import os
import tempfile
import unittest
import zipfile

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, db
from app.services import migration


class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.kb = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        self.old_kb = config.KB_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'workbench.db')
        config.KB_DIR = self.kb.name
        db.get_conn()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        config.KB_DIR = self.old_kb
        self.kb.cleanup()
        self.temp.cleanup()

    def test_package_contains_payload_and_restores_it(self):
        conn = db.get_conn()
        conn.execute('CREATE TABLE migration_fixture (value TEXT NOT NULL)')
        conn.execute('INSERT INTO migration_fixture(value) VALUES (?)', ('源电脑数据',))
        conn.commit()

        os.makedirs(os.path.join(self.temp.name, 'student_photos'), exist_ok=True)
        os.makedirs(os.path.join(self.temp.name, 'attachments', 'class-tasks'), exist_ok=True)
        with open(os.path.join(self.temp.name, 'student_photos', '1.jpg'), 'wb') as photo:
            photo.write(b'photo-data')
        with open(os.path.join(self.temp.name, 'attachments', 'class-tasks', '1.txt'), 'wb') as attachment:
            attachment.write(b'attachment-data')
        os.makedirs(os.path.join(self.kb.name, '班级复盘'), exist_ok=True)
        with open(os.path.join(self.kb.name, '班级复盘', '期末总结.md'), 'w', encoding='utf-8') as note:
            note.write('# 源电脑知识库')
        with open(os.path.join(self.temp.name, 'agent-model.json'), 'w', encoding='utf-8') as secret:
            json.dump({'api_key': '不应打包'}, secret)
        with open(os.path.join(self.temp.name, 'wechat-config.json'), 'w', encoding='utf-8') as secret:
            secret.write('不应打包')

        filename = migration.create_package()
        package_path = os.path.join(self.temp.name, 'backups', filename)
        with zipfile.ZipFile(package_path) as package:
            names = set(package.namelist())
        self.assertIn('database/workbench.db', names)
        self.assertIn('data/student_photos/1.jpg', names)
        self.assertIn('data/attachments/class-tasks/1.txt', names)
        self.assertIn('knowledge/班级复盘/期末总结.md', names)
        self.assertNotIn('data/agent-model.json', names)
        self.assertNotIn('data/wechat-config.json', names)

        conn.execute('UPDATE migration_fixture SET value=?', ('新电脑临时数据',))
        conn.commit()
        with open(os.path.join(self.temp.name, 'student_photos', '1.jpg'), 'wb') as photo:
            photo.write(b'changed-photo')
        with open(os.path.join(self.kb.name, '班级复盘', '期末总结.md'), 'w', encoding='utf-8') as note:
            note.write('# 新电脑临时知识库')

        with open(package_path, 'rb') as package:
            result = migration.restore_package(package.read())

        self.assertTrue(result['ok'])
        self.assertEqual(
            db.get_conn().execute('SELECT value FROM migration_fixture').fetchone()[0],
            '源电脑数据',
        )
        with open(os.path.join(self.temp.name, 'student_photos', '1.jpg'), 'rb') as photo:
            self.assertEqual(photo.read(), b'photo-data')
        with open(os.path.join(self.kb.name, '班级复盘', '期末总结.md'), encoding='utf-8') as note:
            self.assertEqual(note.read(), '# 源电脑知识库')
        self.assertTrue(os.path.isfile(os.path.join(self.temp.name, 'backups', result['pre_restore_backup'])))

    def test_rejects_zip_path_traversal(self):
        output = tempfile.NamedTemporaryFile(suffix='.zip', delete=False)
        try:
            with zipfile.ZipFile(output.name, 'w') as package:
                package.writestr('../outside.txt', b'not allowed')
            with open(output.name, 'rb') as package:
                with self.assertRaises(migration.MigrationError):
                    migration.restore_package(package.read())
        finally:
            output.close()
            os.unlink(output.name)


if __name__ == '__main__':
    unittest.main()
