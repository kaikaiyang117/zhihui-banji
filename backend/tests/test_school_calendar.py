# -*- coding: utf-8 -*-
import io
import os
import sys
import tempfile
import unittest

from openpyxl import Workbook

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.services import class_context, school_calendar


class SchoolCalendarTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        db.get_conn()
        scope = class_context.get_current_scope()
        class_context.update_term(
            scope['term_id'], start_date='2026-03-01', end_date='2026-07-19')

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    @staticmethod
    def matrix_file():
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(['月份', '周次', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日', '行课天数'])
        sheet.append(['三月', '一', None, 3, '报名4', 5, 6, '7（休）', 8, 3])
        sheet.append([None, '二', '3月开学典礼', 10, 11, 12, 13, 14, 15, 5])
        output = io.BytesIO()
        workbook.save(output)
        return output.getvalue()

    def test_matrix_preview_expands_dates_and_infers_day_types(self):
        preview = school_calendar.preview_import(
            self.matrix_file(), '2026春季行事历.xlsx')
        self.assertEqual(preview['format'], 'matrix')
        rows = {row['date']: row for row in preview['rows']}
        self.assertEqual(rows['2026-03-03']['day_type'], '上课日')
        self.assertEqual(rows['2026-03-04']['title'], '报名')
        self.assertEqual(rows['2026-03-07']['day_type'], '放假日')
        self.assertFalse(rows['2026-03-07']['is_school_day'])
        self.assertEqual(rows['2026-03-09']['title'], '开学典礼')
        self.assertEqual(preview['summary']['valid'], len(preview['rows']))

    def test_import_is_idempotent_and_manual_update_is_scoped(self):
        preview = school_calendar.preview_import(self.matrix_file(), 'calendar.xlsx')
        rows = [row for row in preview['rows'] if row['valid'] and row['action'] != '跳过']
        first = school_calendar.commit_import(rows, 'calendar.xlsx', 'calendar-test-1')
        repeated = school_calendar.commit_import(rows, 'calendar.xlsx', 'calendar-test-1')
        self.assertGreater(first['imported'], 0)
        self.assertTrue(repeated['idempotent'])
        listed = school_calendar.list_calendar()
        self.assertEqual(listed['summary']['total'], first['imported'])
        target = next(item for item in listed['entries'] if item['calendar_date'] == '2026-03-07')
        school_calendar.update_entry(
            target['id'], '2026-03-07', '调休上课', '临时补课', True, '人工修正')
        updated = next(item for item in school_calendar.list_calendar()['entries'] if item['id'] == target['id'])
        self.assertEqual(updated['day_type'], '调休上课')
        self.assertEqual(updated['source'], 'manual')


if __name__ == '__main__':
    unittest.main()
