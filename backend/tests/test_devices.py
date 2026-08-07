# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app, db
from app.services import devices


class DevicePairingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        self.old_lan_url = os.environ.get('WORKBENCH_LAN_URL_BASE')
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        os.environ['WORKBENCH_LAN_URL_BASE'] = 'http://192.168.1.8:5000'
        db.get_conn()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        if self.old_lan_url is None:
            os.environ.pop('WORKBENCH_LAN_URL_BASE', None)
        else:
            os.environ['WORKBENCH_LAN_URL_BASE'] = self.old_lan_url
        self.temp.cleanup()

    def test_pairing_is_single_use_and_only_hashes_are_stored(self):
        pairing = devices.create_pairing(os.environ['WORKBENCH_LAN_URL_BASE'])
        claimed = devices.claim_pairing(
            pairing['code'], name='测试手机', user_agent='Safari', ip='192.168.1.20')

        self.assertIsNotNone(devices.authenticate(claimed['device_token']))
        with self.assertRaises(devices.DeviceError):
            devices.claim_pairing(pairing['code'])

        conn = db.get_conn()
        session = conn.execute('SELECT code_hash, status FROM pairing_sessions').fetchone()
        device = conn.execute(
            'SELECT credential_hash, status FROM paired_devices').fetchone()
        self.assertEqual(session['status'], '已使用')
        self.assertEqual(device['status'], '已授权')
        self.assertNotEqual(session['code_hash'], pairing['code'])
        self.assertNotEqual(device['credential_hash'], claimed['device_token'])
        self.assertNotIn(pairing['code'], session['code_hash'])
        self.assertNotIn(claimed['device_token'], device['credential_hash'])

    def test_expired_pairing_is_rejected(self):
        pairing = devices.create_pairing(os.environ['WORKBENCH_LAN_URL_BASE'])
        conn = db.get_conn()
        conn.execute(
            "UPDATE pairing_sessions SET expires_at='2000-01-01 00:00:00' WHERE status='待使用'")
        conn.commit()

        with self.assertRaisesRegex(devices.DeviceError, '已过期'):
            devices.claim_pairing(pairing['code'])
        status = conn.execute('SELECT status FROM pairing_sessions').fetchone()['status']
        self.assertEqual(status, '已过期')

    def test_device_credential_survives_restart_and_revoke_is_immediate(self):
        pairing = devices.create_pairing(os.environ['WORKBENCH_LAN_URL_BASE'])
        claimed = devices.claim_pairing(pairing['code'], name='持久设备')
        db.close()

        self.assertIsNotNone(devices.authenticate(claimed['device_token']))
        row = db.get_conn().execute(
            'SELECT id FROM paired_devices WHERE device_id=?',
            (claimed['device_id'],),
        ).fetchone()
        devices.revoke(row['id'])
        self.assertIsNone(devices.authenticate(claimed['device_token']))

    def test_revoke_all_invalidates_every_active_device(self):
        credentials = []
        for name in ('手机', '平板'):
            pairing = devices.create_pairing(os.environ['WORKBENCH_LAN_URL_BASE'])
            credentials.append(devices.claim_pairing(pairing['code'], name=name)['device_token'])

        result = devices.revoke_all()
        self.assertEqual(result['count'], 2)
        self.assertTrue(all(devices.authenticate(item) is None for item in credentials))

    def test_remote_api_requires_pairing_and_revoked_device_is_blocked(self):
        with TestClient(app) as local_client:
            pairing_response = local_client.post('/api/system/pairing/start', json={})
        self.assertEqual(pairing_response.status_code, 200)
        code = pairing_response.json()['code']

        with TestClient(app, client=('192.168.1.20', 50000)) as remote_client:
            self.assertEqual(remote_client.get('/api/students').status_code, 401)
            claim = remote_client.post('/api/system/pairing/claim', json={
                'code': code,
                'name': '局域网测试设备',
            })
            self.assertEqual(claim.status_code, 200)
            self.assertNotIn('device_token', claim.json())
            self.assertIn('workbench_device', remote_client.cookies)
            self.assertEqual(remote_client.get('/api/students').status_code, 200)
            self.assertEqual(
                remote_client.post('/api/system/pairing/start', json={}).status_code,
                403,
            )

            device_row = db.get_conn().execute(
                'SELECT id FROM paired_devices WHERE device_id=?',
                (claim.json()['device_id'],),
            ).fetchone()
            devices.revoke(device_row['id'])
            denied = remote_client.get('/api/students')
            self.assertEqual(denied.status_code, 401)


if __name__ == '__main__':
    unittest.main()
