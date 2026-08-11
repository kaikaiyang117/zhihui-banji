# -*- coding: utf-8 -*-
"""MIG-00 基线 1：仓库状态与全量回归记录。

记录当前分支、未提交文件、工具版本、数据库迁移版本，并运行
后端全量测试、前端构建、Electron 冒烟和 UI 冒烟，结果写入 out/regression.json。
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import BACKEND_DIR, OUT_DIR, ROOT_DIR, temp_data_dir, write_json  # noqa: E402
sys.path.insert(0, BACKEND_DIR)
sys.path.insert(0, os.path.dirname(BACKEND_DIR))  # 让 backend.tests 可导入


def git_info() -> dict:
    def run(*args):
        try:
            return subprocess.run(
                ['git', *args], cwd=ROOT_DIR, capture_output=True, text=True, timeout=20
            ).stdout.strip()
        except Exception as exc:
            return f'<error: {exc}>'
    return {
        'branch': run('branch', '--show-current'),
        'head': run('log', '-1', '--format=%h %s'),
        'modified_count': len(run('status', '--porcelain').splitlines()),
    }


def tool_versions() -> dict:
    def run(cmd):
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout.strip()
        except Exception as exc:
            return f'<error: {exc}>'
    return {
        'python': run([sys.executable, '--version']),
        'node': run(['node', '--version']),
        'npm': run(['npm', '--version']),
        'electron': run(['node', '-e',
                         'console.log(require("./desktop/node_modules/electron/package.json").version)']),
    }


def schema_version() -> int:
    """在临时目录创建全新数据库读取迁移版本；不触碰真实数据库。"""
    with temp_data_dir(None) as db:
        from app import db as database
        conn = database.get_conn()
        return int(conn.execute('SELECT MAX(version) AS v FROM schema_migrations').fetchone()['v'])


def run_suite(name: str, cmd: list, cwd: str, timeout: int = 900) -> dict:
    os.makedirs(os.path.join(OUT_DIR, 'logs'), exist_ok=True)
    log_path = os.path.join(OUT_DIR, 'logs', f'{name}.log')
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        summary = (proc.stdout + proc.stderr)[-4000:]
        with open(log_path, 'w', encoding='utf-8') as stream:
            stream.write(proc.stdout + proc.stderr)
        result = {'command': ' '.join(cmd), 'exit_code': proc.returncode,
                  'log': log_path, 'passed': proc.returncode == 0}
    except subprocess.TimeoutExpired as exc:
        summary = f'超时（{timeout}s）'
        result = {'command': ' '.join(cmd), 'exit_code': None,
                  'log': log_path, 'passed': False, 'timeout': True}
    except FileNotFoundError as exc:
        summary = f'命令不存在：{exc}'
        result = {'command': ' '.join(cmd), 'exit_code': None,
                  'log': log_path, 'passed': False, 'missing': True}
    result['summary_tail'] = summary
    return result


def main():
    suites = {}
    suites['backend_tests'] = run_suite(
        'backend-tests',
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'backend/tests', '-p', 'test_*.py'],
        ROOT_DIR)
    suites['frontend_build'] = run_suite(
        'frontend-build',
        ['npm', 'run', 'build'],
        os.path.join(ROOT_DIR, 'frontend'))
    suites['electron_smoke'] = run_suite(
        'electron-smoke',
        ['npm', 'test'],
        os.path.join(ROOT_DIR, 'desktop'), timeout=600)
    suites['ui_smoke'] = run_suite(
        'ui-smoke',
        ['bash', 'scripts/smoke-ui.sh'],
        ROOT_DIR, timeout=900)

    report = {
        'generated_at': __import__('datetime').datetime.now().isoformat(timespec='seconds'),
        'git': git_info(),
        'tools': tool_versions(),
        'database_schema_version': schema_version(),
        'suites': suites,
    }
    write_json(os.path.join(OUT_DIR, 'regression.json'), report)
    ok = all(suite.get('passed') for suite in suites.values())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f'\n==> 回归基线：{"全部通过" if ok else "存在失败项"} → out/regression.json')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
