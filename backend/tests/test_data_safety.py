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
    MIGRATION_TABLES = (
        'students',
        'student_events',
        'student_tasks',
        'focus_items',
        'communications',
        'exam_records',
        'attendance_rules',
        'class_tasks',
        'class_task_items',
        'duty_assignments',
        'sheet_rows',
    )
    SCORE_TABLES = (
        'score_exams',
        'score_subjects',
        'score_exam_subjects',
        'score_import_runs',
        'score_rules',
        'score_rule_runs',
        'score_rule_hits',
    )
    POINT_TABLES = (
        'point_rules', 'point_ledger', 'point_rule_runs',
        'point_rule_hits', 'point_migration_runs',
    )

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
        self.assertIsNotNone(conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='recycle_bin'"
        ).fetchone())
        self.assertIsNotNone(conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='system_audit'"
        ).fetchone())
        self.assertIsNotNone(conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='pairing_sessions'"
        ).fetchone())
        self.assertIsNotNone(conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='paired_devices'"
        ).fetchone())
        for table in (
            'attendance_records', 'attendance_rule_runs', 'attendance_rule_hits',
            *self.SCORE_TABLES,
            *self.POINT_TABLES,
        ):
            self.assertIsNotNone(conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
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

    def test_v4_business_fixture_survives_upgrade_and_repeated_startup(self):
        fixture_path = os.path.join(
            os.path.dirname(__file__), 'fixtures', 'migration_v4.sql')
        legacy_path = os.path.join(self.temp.name, 'business-v4.db')
        legacy = sqlite3.connect(legacy_path)
        with open(fixture_path, encoding='utf-8') as fixture:
            legacy.executescript(fixture.read())
        before = {
            table: legacy.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
            for table in self.MIGRATION_TABLES
        }
        legacy.close()

        db.close()
        db.DB_PATH = legacy_path
        conn = db.get_conn()
        after_upgrade = {
            table: conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
            for table in self.MIGRATION_TABLES
        }
        for table in self.MIGRATION_TABLES:
            if table != 'student_tasks':
                self.assertEqual(after_upgrade[table], before[table], table)
        self.assertEqual(after_upgrade['student_tasks'], before['student_tasks'] + 4)
        self.assertEqual(db.schema_version(conn), db.CURRENT_SCHEMA_VERSION)
        scope = conn.execute(
            'SELECT c.id AS class_id, t.id AS term_id FROM classes c JOIN terms t ON t.class_id=c.id'
        ).fetchone()
        self.assertIsNotNone(scope)
        self.assertEqual(conn.execute(
            'SELECT COUNT(*) FROM student_enrollments WHERE class_id=? AND term_id=?',
            (scope['class_id'], scope['term_id'])).fetchone()[0], before['students'])
        for table in (
            'student_events', 'student_tasks', 'focus_items', 'communications',
            'exam_records', 'attendance_rules', 'class_tasks', 'duty_assignments', 'sheet_rows',
        ):
            missing = conn.execute(
                f'SELECT COUNT(*) FROM {table} WHERE class_id IS NULL OR term_id IS NULL'
            ).fetchone()[0]
            self.assertEqual(missing, 0, table)

        task_link = conn.execute(
            'SELECT student_id, event_id FROM student_tasks WHERE id=1'
        ).fetchone()
        self.assertEqual((task_link['student_id'], task_link['event_id']), (1, 1))
        sources = conn.execute(
            "SELECT source_type, COUNT(*) AS count FROM student_tasks GROUP BY source_type"
        ).fetchall()
        self.assertEqual(
            {row['source_type']: row['count'] for row in sources},
            {'event': 1, 'communication': 1, 'focus': 1, 'class_task': 1, 'duty_assignment': 1},
        )
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM student_tasks WHERE source_key<>''"
        ).fetchone()[0], 5)
        material_link = conn.execute(
            'SELECT task_id, student_id FROM class_task_items WHERE id=1'
        ).fetchone()
        self.assertEqual((material_link['task_id'], material_link['student_id']), (1, 1))
        attendance = conn.execute(
            "SELECT data FROM sheet_rows WHERE sheet='考勤管理' AND row_no=1"
        ).fetchone()
        self.assertIn('M4001', attendance['data'])
        structured_attendance = conn.execute(
            '''SELECT a.attendance_date, a.scene, a.status, a.arrive_at, a.reason, s.学号
               FROM attendance_records a JOIN students s ON s.id=a.student_id'''
        ).fetchone()
        self.assertEqual(
            tuple(structured_attendance),
            ('2026-08-06', '常规到校', '迟到', '08:10', '交通', 'M4001'),
        )
        structured_score = conn.execute(
            '''SELECT r.exam_id, r.subject_id, r.record_status,
                      e.name AS exam_name, e.exam_date, s.name AS subject_name
               FROM exam_records r
               JOIN score_exams e ON e.id=r.exam_id
               JOIN score_subjects s ON s.id=r.subject_id
               WHERE r.id=1'''
        ).fetchone()
        self.assertEqual(
            tuple(structured_score),
            (1, 1, '正常', '第一次月考', '2026-08-01', '语文'),
        )
        self.assertEqual(conn.execute(
            'SELECT COUNT(*) FROM score_exam_subjects WHERE exam_id=? AND subject_id=?',
            (structured_score['exam_id'], structured_score['subject_id']),
        ).fetchone()[0], 1)
        score_counts = {
            table: conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
            for table in self.SCORE_TABLES
        }

        db.close()
        reopened = db.get_conn()
        after_restart = {
            table: reopened.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
            for table in self.MIGRATION_TABLES
        }
        self.assertEqual(after_restart, after_upgrade)
        self.assertEqual({
            table: reopened.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
            for table in self.SCORE_TABLES
        }, score_counts)
        self.assertEqual(db.schema_version(reopened), db.CURRENT_SCHEMA_VERSION)
        backups = os.listdir(os.path.join(self.temp.name, 'backups'))
        self.assertTrue(any('pre-migrate-v5' in name for name in backups))

    def test_v5_database_upgrades_work_items_once_and_creates_v6_backup(self):
        fixture_path = os.path.join(
            os.path.dirname(__file__), 'fixtures', 'migration_v4.sql')
        legacy_path = os.path.join(self.temp.name, 'business-v5.db')
        legacy = sqlite3.connect(legacy_path)
        legacy.row_factory = sqlite3.Row
        with open(fixture_path, encoding='utf-8') as fixture:
            legacy.executescript(fixture.read())
        db._migration_5(legacy)
        legacy.execute('INSERT INTO schema_migrations(version) VALUES(5)')
        legacy.commit()
        legacy.close()

        db.close()
        db.DB_PATH = legacy_path
        conn = db.get_conn()
        self.assertEqual(db.schema_version(conn), db.CURRENT_SCHEMA_VERSION)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM student_tasks').fetchone()[0], 5)
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM student_tasks WHERE source_key<>''"
        ).fetchone()[0], 5)
        backups = os.listdir(os.path.join(self.temp.name, 'backups'))
        self.assertTrue(any('pre-migrate-v6' in name for name in backups))

        db.close()
        reopened = db.get_conn()
        self.assertEqual(reopened.execute('SELECT COUNT(*) FROM student_tasks').fetchone()[0], 5)

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
