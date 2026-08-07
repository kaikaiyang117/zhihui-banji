# -*- coding: utf-8 -*-
import os
import tempfile
import unittest

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.services import funds
from backend.tests.helpers import enroll_all_students


class FundLedgerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        conn = db.get_conn()
        conn.executemany('INSERT INTO students(学号, 姓名) VALUES(?,?)', [
            ('F001', '账目甲'), ('F002', '账目乙'),
        ])
        conn.commit()
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_legacy_rows_migrate_once_and_keep_raw_sheet(self):
        db.set_sheet_meta('班费管理', ['日期', '收支类型', '金额', '用途说明', '经手人', '证明人', '备注'])
        db.insert_row('班费管理', ['2026-08-01', '收入', 100, '旧版收款', '甲', '乙', '历史'])
        db.insert_row('班费管理', ['2026-08-02', '支出', 25, '旧版材料', '甲', '', ''])
        summary = funds.class_summary(reference_date='2026-08-31')
        self.assertEqual(summary['totals']['balance'], 75)
        self.assertEqual(summary['migration']['imported_entries'], 2)
        self.assertTrue(summary['migration']['report']['legacy_sheet_retained'])
        self.assertEqual(len(db.get_rows('班费管理')), 2)
        funds.class_summary(reference_date='2026-08-31')
        self.assertEqual(db.get_conn().execute('SELECT COUNT(*) FROM fund_ledger').fetchone()[0], 2)

    def test_revoke_recalculates_without_deleting_a_ledger_row(self):
        entry = funds.create_entry(
            occurred_at='2026-08-07', direction='收入', amount=80,
            category='班费收取', description='收取班费')
        self.assertEqual(funds.class_summary(reference_date='2026-08-07')['totals']['balance'], 80)
        revoked = funds.revoke_entry(entry['id'], '重复录入')
        self.assertEqual(revoked['status'], '已撤销')
        self.assertEqual(funds.class_summary(reference_date='2026-08-07')['totals']['balance'], 0)
        row = db.get_conn().execute(
            'SELECT status, reversal_reason FROM fund_ledger WHERE id=?', (entry['id'],)).fetchone()
        self.assertEqual((row['status'], row['reversal_reason']), ('已撤销', '重复录入'))

    def test_settlement_locks_update_and_reversal_is_auditable(self):
        entry = funds.create_entry(
            occurred_at='2026-08-03', direction='支出', amount=30,
            category='活动费用', description='购买材料')
        settlement = funds.create_settlement(period_key='2026-08')
        self.assertEqual(settlement['status'], '已结算')
        with self.assertRaises(funds.FundError):
            funds.update_entry(entry['id'], description='不能改')
        reversal = funds.reverse_entry(entry['id'], '原凭证错误', occurred_at='2026-08-31')
        self.assertEqual(reversal['source_type'], 'reversal')
        self.assertEqual(reversal['reversal_of_id'], entry['id'])
        self.assertEqual(funds.class_summary(reference_date='2026-08-31')['totals']['balance'], 0)
        self.assertEqual(funds.list_settlements()[0]['status_display'], '需复核')
        audit_row = db.get_conn().execute(
            "SELECT action FROM system_audit WHERE object_type='fund_ledger' AND object_id=? ORDER BY id DESC LIMIT 1",
            (str(reversal['id']),)).fetchone()
        self.assertEqual(audit_row['action'], 'reverse')

    def test_attachment_and_export_use_structured_fund_rows(self):
        entry = funds.create_entry(
            occurred_at='2026-08-07', direction='支出', amount=12.5,
            description='购买文具')
        attachment = funds.save_attachment(
            entry['id'], filename='receipt.txt', content_type='text/plain', content=b'receipt')
        stored, path = funds.attachment_file(attachment['id'])
        self.assertEqual(stored['sha256'], __import__('hashlib').sha256(b'receipt').hexdigest())
        self.assertTrue(os.path.isfile(path))
        from app.export_service import export_sheet
        buffer, filename = export_sheet('班费管理')
        self.assertEqual(filename, '班费分类账.xlsx')
        self.assertGreater(len(buffer.getvalue()), 100)


if __name__ == '__main__':
    unittest.main()
