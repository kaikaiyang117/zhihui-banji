# -*- coding: utf-8 -*-
import os
import sys
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.routers import system
from app.routers.system import access_info


class AccessInfoTest(unittest.TestCase):
    def setUp(self):
        self.old_url = os.environ.get('WORKBENCH_ACCESS_URL')

    def tearDown(self):
        if self.old_url is None:
            os.environ.pop('WORKBENCH_ACCESS_URL', None)
        else:
            os.environ['WORKBENCH_ACCESS_URL'] = self.old_url

    def test_access_info_returns_qr_source_url_for_lan_mode(self):
        os.environ['WORKBENCH_ACCESS_URL'] = (
            'http://192.168.31.210:5100/?access=test-token'
        )
        self.assertEqual(access_info(), {
            'enabled': True,
            'url': 'http://192.168.31.210:5100/?access=test-token',
            'message': '请让手机或平板连接同一 Wi-Fi 后扫描二维码。',
        })

    def test_access_info_is_disabled_without_runtime_url(self):
        os.environ.pop('WORKBENCH_ACCESS_URL', None)
        self.assertEqual(access_info(), {'enabled': False, 'url': '', 'message': ''})

    def test_update_check_selects_platform_asset_and_checksum(self):
        release = {
            'tag_name': 'v1.0.2',
            'html_url': 'https://github.com/aitia0718/workbench/releases/tag/v1.0.2',
            'body': '二维码访问与更新优化',
            'assets': [
                {
                    'name': 'MeimeiWorkbench-macOS-arm64.dmg',
                    'browser_download_url': 'https://example.test/workbench.dmg',
                    'size': 123,
                },
                {
                    'name': 'SHA256SUMS.txt',
                    'browser_download_url': 'https://example.test/SHA256SUMS.txt',
                    'size': 80,
                },
            ],
        }

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'abc123  MeimeiWorkbench-macOS-arm64.dmg\n'

        old_version = system.APP_VERSION
        system.APP_VERSION = '1.0.1'
        try:
            with patch.object(system, '_fetch_json', return_value=release), \
                    patch.object(system, '_platform_asset', return_value=release['assets'][0]), \
                    patch.object(system.urllib.request, 'urlopen', return_value=Response()):
                result = system.check_for_update()
        finally:
            system.APP_VERSION = old_version

        self.assertTrue(result['update_available'])
        self.assertTrue(result['downloadable'])
        self.assertEqual(result['asset']['sha256'], 'abc123')

    def test_update_check_falls_back_to_manifest_after_api_limit(self):
        manifest = {
            'tag_name': 'v1.0.2',
            'html_url': 'https://github.com/aitia0718/workbench/releases/tag/v1.0.2',
            'assets': [{
                'name': 'MeimeiWorkbench-macOS-arm64.dmg',
                'browser_download_url': 'https://example.test/workbench.dmg',
                'size': 123,
                'sha256': 'abc123',
            }],
        }
        api_limited = HTTPError('https://api.github.com', 403, 'rate limited', {}, None)
        old_version = system.APP_VERSION
        system.APP_VERSION = '1.0.1'
        try:
            with patch.object(system, '_fetch_json', side_effect=[api_limited, manifest]), \
                    patch.object(system, '_platform_asset', return_value=manifest['assets'][0]):
                result = system.check_for_update()
        finally:
            system.APP_VERSION = old_version

        self.assertTrue(result['update_available'])
        self.assertTrue(result['downloadable'])
        self.assertEqual(result['asset']['sha256'], 'abc123')


if __name__ == '__main__':
    unittest.main()
