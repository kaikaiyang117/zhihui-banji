# -*- coding: utf-8 -*-
import os
import socket
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from run import find_available_port


class StartupTest(unittest.TestCase):
    def test_port_conflict_moves_to_next_available_port(self):
        occupied = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        occupied.bind(('127.0.0.1', 0))
        occupied.listen(1)
        try:
            requested = occupied.getsockname()[1]
            selected = find_available_port('127.0.0.1', requested, attempts=3)
            self.assertNotEqual(selected, requested)
        finally:
            occupied.close()


if __name__ == '__main__':
    unittest.main()
