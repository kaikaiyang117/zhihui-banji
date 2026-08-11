# -*- coding: utf-8 -*-
import json
import os
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from run import find_available_port, parse_args, should_open_browser

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN_SCRIPT = os.path.join(BACKEND_DIR, 'run.py')


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_for_url_line(proc, timeout=30):
    """读取子进程 stdout，直到出现 WORKBENCH_URL= 行或进程退出。"""
    lines = queue.Queue()

    def reader():
        for line in proc.stdout:
            lines.put(line)
        lines.put(None)

    threading.Thread(target=reader, daemon=True).start()
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            line = lines.get(timeout=0.5)
        except queue.Empty:
            if proc.poll() is not None:
                raise RuntimeError(f'后端进程提前退出：{proc.stdout.read()}')
            continue
        if line is None:
            raise RuntimeError('后端进程提前退出（stdout 已结束）')
        line = line.rstrip()
        if line.startswith('WORKBENCH_URL='):
            return line
    raise TimeoutError('等待 WORKBENCH_URL 输出超时')


def wait_health(base_url, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f'{base_url}/api/system/health', timeout=2) as response:
                return json.loads(response.read().decode('utf-8'))
        except Exception:
            time.sleep(0.3)
    raise TimeoutError('健康检查超时')


def port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex(('127.0.0.1', port)) == 0


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

    def test_desktop_child_flag_disables_browser(self):
        args = parse_args(['--desktop-child', '--port', '5001'])
        self.assertTrue(args.desktop_child)
        self.assertEqual(args.port, 5001)
        self.assertFalse(should_open_browser(args))
        args = parse_args(['--open-browser'])
        self.assertFalse(args.desktop_child)
        self.assertTrue(should_open_browser(args))
        self.assertFalse(should_open_browser(parse_args(['--desktop-child', '--open-browser'])))

    def test_health_endpoint_reports_ready_and_version(self):
        from app import db
        from app.routers import system
        try:
            result = system.health()
            self.assertEqual(result['app'], 'MeimeiWorkbench')
            self.assertTrue(result['ready'])
            self.assertEqual(result['version'], system.APP_VERSION)
        finally:
            db.close()

    def _spawn_desktop_child(self, data_dir, requested_port):
        env = dict(os.environ)
        env['WORKBENCH_DATA_DIR'] = data_dir
        env['WORKBENCH_KB_DIR'] = os.path.join(data_dir, '知识库')
        env['WORKBENCH_VERSION'] = '9.8.7'
        env['PYTHONUNBUFFERED'] = '1'
        return subprocess.Popen(
            [sys.executable, RUN_SCRIPT, '--desktop-child', '--port', str(requested_port),
             '--host', '127.0.0.1'],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8',
        )

    def _stop_child(self, proc):
        proc.terminate()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        if proc.stdout:
            proc.stdout.close()

    def test_desktop_child_reports_url_and_health(self):
        with tempfile.TemporaryDirectory() as data_dir:
            requested = free_port()
            proc = self._spawn_desktop_child(data_dir, requested)
            try:
                line = wait_for_url_line(proc)
                self.assertEqual(line, f'WORKBENCH_URL=http://127.0.0.1:{requested}')
                info = wait_health(f'http://127.0.0.1:{requested}')
                self.assertTrue(info['ready'])
                self.assertEqual(info['version'], '9.8.7')
            finally:
                self._stop_child(proc)
            self.assertFalse(port_open(requested))
            self.assertFalse(os.path.exists(os.path.join(data_dir, '.workbench-ready')))

    def test_desktop_child_uses_next_available_port(self):
        blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        blocker.bind(('127.0.0.1', 0))
        blocker.listen(1)
        requested = blocker.getsockname()[1]
        try:
            with tempfile.TemporaryDirectory() as data_dir:
                proc = self._spawn_desktop_child(data_dir, requested)
                try:
                    line = wait_for_url_line(proc)
                    self.assertNotIn(str(requested), line.split('=')[-1])
                    port = int(line.split('=')[-1].rsplit(':', 1)[1])
                    info = wait_health(f'http://127.0.0.1:{port}')
                    self.assertTrue(info['ready'])
                finally:
                    self._stop_child(proc)
                self.assertFalse(port_open(port))
        finally:
            blocker.close()


if __name__ == '__main__':
    unittest.main()
