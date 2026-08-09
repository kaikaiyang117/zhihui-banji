# -*- coding: utf-8 -*-
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import clock


class ClockTest(unittest.TestCase):
    def setUp(self):
        self.previous = os.environ.get(clock.ENV_NAME)
        os.environ.pop(clock.ENV_NAME, None)

    def tearDown(self):
        if self.previous is None:
            os.environ.pop(clock.ENV_NAME, None)
        else:
            os.environ[clock.ENV_NAME] = self.previous

    def test_override_changes_business_date_only(self):
        os.environ[clock.ENV_NAME] = '2026-04-15'
        self.assertEqual(clock.today(), date(2026, 4, 15))
        self.assertTrue(clock.runtime()['business_date_overridden'])

    def test_invalid_override_is_rejected(self):
        os.environ[clock.ENV_NAME] = '2026/04/15'
        with self.assertRaises(RuntimeError):
            clock.today()


if __name__ == '__main__':
    unittest.main()
