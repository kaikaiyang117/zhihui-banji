# -*- coding: utf-8 -*-
import io
import os
import sqlite3
import sys
import tempfile
import unittest

from openpyxl import Workbook

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.config import STUDENT_COLUMNS
from app.import_service import commit_student_import, preview_students


class DataSafetyTest(unittest.TestCase):
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

    def test_new_database_has_schema_version_and_import_log(self):
        conn = db.get_conn()
        self.assertEqual(db.schema_version(conn), db.CURRENT_SCHEMA_VERSION)
        self.assertIsNotNone(conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='student_import_runs'"
        ).fetchone())
        self.assertIsNotNone(conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_settings'"
        ).fetchone())
        self.assertIsNotNone(conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_audit'"
        ).fetchone())
        self.assertIsNotNone(conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_sessions'"
        ).fetchone())
        self.assertIsNotNone(conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='wechat_message_receipts'"
        ).fetchone())

    def test_legacy_database_migrates_and_creates_pre_migration_backup(self):
        legacy_path = os.path.join(self.temp.name, 'legacy.db')
        legacy = sqlite3.connect(legacy_path)
        legacy.execute('CREATE TABLE students (id INTEGER PRIMARY KEY, "学号" TEXT UNIQUE, "姓名" TEXT)')
        legacy.execute('INSERT INTO students("学号", "姓名") VALUES(?, ?)', ('L001', '旧数据学生'))
        legacy.commit()
        legacy.close()

        db.close()
        db.DB_PATH = legacy_path
        conn = db.get_conn()

        self.assertEqual(conn.execute('SELECT "姓名" FROM students WHERE "学号"=?', ('L001',)).fetchone()[0], '旧数据学生')
        self.assertEqual(db.schema_version(conn), db.CURRENT_SCHEMA_VERSION)
        backups = os.listdir(os.path.join(self.temp.name, 'backups'))
        self.assertTrue(any('pre-migrate-v2' in name for name in backups))

    def test_backup_is_integrity_checked(self):
        filename = db.create_backup('test')
        backup_path = os.path.join(self.temp.name, 'backups', filename)
        self.assertTrue(os.path.isfile(backup_path))
        backup = sqlite3.connect(backup_path)
        try:
            self.assertEqual(backup.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        finally:
            backup.close()

    def test_import_preview_has_no_side_effect_and_commit_is_confirmed(self):
        conn = db.get_conn()
        conn.execute('INSERT INTO students("学号", "姓名", "性别") VALUES(?,?,?)', ('P1001', '原姓名', '男'))
        conn.commit()

        workbook = Workbook()
        sheet = workbook.active
        sheet.append(STUDENT_COLUMNS)
        sheet.append(['P1001', '更新姓名', '男'] + [''] * (len(STUDENT_COLUMNS) - 3))
        sheet.append(['P1002', '新增学生', '女'] + [''] * (len(STUDENT_COLUMNS) - 3))
        sheet.append(['P1003', '', '男'] + [''] * (len(STUDENT_COLUMNS) - 3))
        sheet.append(['P1002', '重复学生', '女'] + [''] * (len(STUDENT_COLUMNS) - 3))
        payload = io.BytesIO()
        workbook.save(payload)

        preview = preview_students(payload.getvalue(), 'students.xlsx')
        self.assertEqual(preview['summary'], {'imported': 1, 'updated': 1, 'skipped': 2, 'valid': 2})
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM students').fetchone()[0], 1)

        result = commit_student_import(preview['rows'], 'students.xlsx')
        self.assertEqual(result['imported'], 1)
        self.assertEqual(result['updated'], 1)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM students').fetchone()[0], 2)
        self.assertEqual(conn.execute('SELECT "姓名" FROM students WHERE "学号"=?', ('P1001',)).fetchone()[0], '更新姓名')
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM student_import_runs').fetchone()[0], 1)


if __name__ == '__main__':
    unittest.main()
