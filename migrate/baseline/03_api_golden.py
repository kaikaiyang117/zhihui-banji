# -*- coding: utf-8 -*-
"""MIG-00 基线 4：API 黄金用例。

覆盖全部 21 个路由模块的读取、写入、错误和权限/归档路径。
在同一临时数据库和固定夹具上顺序执行，结果写入 out/api/golden-cases.json。
每个用例记录原始响应与规范化响应（时间、自增 ID、大小等允许规范化）。

运行方式：python migrate/baseline/03_api_golden.py
"""
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import BACKEND_DIR, FIXTURES, OUT_API, write_json  # noqa: E402

sys.path.insert(0, BACKEND_DIR)
sys.path.insert(0, os.path.dirname(BACKEND_DIR))  # 让 backend.tests 可导入

TIMESTAMP_KEYS = {
    'created_at', 'updated_at', 'applied_at', 'occurred_at', 'archived_at',
    'joined_at', 'submitted_at', 'completed_at', 'communicated_at', 'modified',
    'revoked_at', 'reconciled_at', 'review_at', 'remind_at', 'started_at',
    'last_access_at', 'expires_at', 'audit_time', 'last_run_at', 'reversed_at',
    'settled_at', 'edited_at', 'reviewed_at', 'deleted_at', 'closed_at',
    'sent_at', 'next_action_at', 'due_at', 'scheduled_at', 'followup_due',
    'end_date', 'start_date', 'exam_date', 'diary_date', 'duty_date',
    'calendar_date', 'occurred_on', 'held_on', 'log_date', 'activity_date',
    'today', 'reference_date',
}
ID_KEYS = {'id', 'entry_id', 'rule_id', 'goal_id', 'reminder_id', 'template_id',
           'category_id', 'settlement_id', 'archive_id', 'attachment_id',
           'note_id', 'task_id', 'event_id', 'focus_id', 'communication_id',
           'comment_id', 'meeting_id', 'diary_id', 'activity_id', 'class_id',
           'term_id', 'enrollment_id', 'student_id', 'exam_id', 'subject_id',
           'rule_id', 'assignment_id', 'device_id', 'action_id', 'config_id',
           'version_id', 'source_id', 'rollover_id', 'plan_id', 'result_id'}

TS_PATTERN = re.compile(r'\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}')
DATE_ONLY_PATTERN = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def normalize(payload, key=''):
    """递归规范化 JSON：自增 ID、时间戳、动态文件名和大小。

    字符串内的完整时间戳子串（如审计 payload_json）也会被替换。
    """
    if isinstance(payload, dict):
        result = {}
        for inner_key, value in payload.items():
            if inner_key in ID_KEYS or inner_key == 'id':
                result[inner_key] = f'<{inner_key}>'
            elif inner_key in TIMESTAMP_KEYS:
                result[inner_key] = '<ts>'
            else:
                result[inner_key] = normalize(value, inner_key)
        return result
    if isinstance(payload, list):
        return [normalize(item, key) for item in payload]
    if isinstance(payload, str):
        value = payload
        if key == 'filename' and value.startswith('workbench-'):
            return '<backup-name>'
        if value.lstrip().startswith('{') or value.lstrip().startswith('['):
            try:
                parsed = json.loads(value)
                return json.dumps(normalize(parsed), ensure_ascii=False, sort_keys=True)
            except (ValueError, TypeError):
                pass
        if TS_PATTERN.search(value):
            return TS_PATTERN.sub('<ts>', value)
        if key == 'file_mtime' or (key == 'size' and value.isdigit()):
            return '<dynamic>'
        if DATE_ONLY_PATTERN.match(value) and key in TIMESTAMP_KEYS:
            return '<ts>'
        return value
    if isinstance(payload, (int, float)):
        if key == 'file_mtime':
            return '<mtime>'
        if key == 'size':
            return '<size>'
        return payload
    return payload


def binary_summary(content: bytes, content_type: str) -> dict:
    return {
        'content_type': content_type,
        'size': len(content),
        'sha256': hashlib.sha256(content).hexdigest(),
    }


class GoldenRunner:
    def __init__(self):
        self.ctx = {}
        self.cases = []

    @staticmethod
    def _find(raw, key):
        """在原始 JSON 中递归查找第一个匹配键的值。"""
        if isinstance(raw, dict):
            if key in raw:
                return raw[key]
            for value in raw.values():
                found = GoldenRunner._find(value, key)
                if found is not None:
                    return found
        elif isinstance(raw, list):
            for item in raw:
                found = GoldenRunner._find(item, key)
                if found is not None:
                    return found
        return None

    def capture(self, raw, keys):
        """keys 支持 ('目标键', '响应字段名', 'string') 或 ('目标键', '响应字段名') 元组，
        或直接使用响应字段名。'string' 模式用于文件名等非数字值。"""
        for key in keys:
            source = key if isinstance(key, str) else key[1]
            target = key if isinstance(key, str) else key[0]
            mode = key[2] if isinstance(key, tuple) and len(key) > 2 else 'digit'
            value = self._find(raw, source)
            if isinstance(value, (int, str)):
                if mode == 'string' or (mode == 'digit' and str(value).isdigit()):
                    self.ctx[target] = str(value)

    def record(self, case_id, module, note, method, path, query, status,
               body=None, content_type='', raw=None, files=None):
        response_norm = None
        if content_type and 'application/json' in content_type:
            try:
                response_norm = normalize(json.loads(raw or '{}'))
            except json.JSONDecodeError:
                response_norm = None
        if files is not None:
            response_norm = normalize(files)
        self.cases.append({
            'id': case_id,
            'module': module,
            'note': note,
            'method': method,
            'path': path,
            'query': query or {},
            'body': body,
            'expected_status': status,
            'actual_status': status,
            'content_type': content_type,
            'response_norm': response_norm,
            'raw_sha256': hashlib.sha256(raw or b'').hexdigest() if isinstance(raw, (bytes, str)) else None,
        })


def main():
    os.environ['WORKBENCH_BUSINESS_DATE'] = '2026-04-15'
    kb_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'kb-golden')
    os.environ['WORKBENCH_KB_DIR'] = kb_dir
    import shutil
    shutil.rmtree(kb_dir, ignore_errors=True)
    os.makedirs(kb_dir, exist_ok=True)

    from app import db
    from backend.tests.helpers import enroll_all_students
    from common import FIXTURES

    old_path, old_data_dir = db.DB_PATH, db.DATA_DIR
    db.close()
    tmpdir = os.path.join(OUT_API, '.tmp-golden')
    import shutil
    shutil.rmtree(tmpdir, ignore_errors=True)
    os.makedirs(tmpdir, exist_ok=True)
    db.DATA_DIR = tmpdir
    db.DB_PATH = os.path.join(tmpdir, 'workbench.db')
    conn = db.get_conn()
    students_seen = {}
    for fixture_name in ('p0_demo', 'p1_demo'):
        fixture = json.load(open(os.path.join(FIXTURES, f'{fixture_name}.json'), encoding='utf-8'))
        for student in fixture.get('students', []):
            no = student.get('学号', '')
            if no in students_seen:
                continue
            students_seen[no] = True
            columns = ['学号', '姓名', '性别', '班级任职']
            conn.execute(
                'INSERT INTO students(学号, 姓名, 性别, 班级任职) VALUES(?,?,?,?)',
                tuple(student.get(c, '') for c in columns))
    conn.commit()
    enroll_all_students()
    runner.ctx = {'student_id': '1'}

    from fastapi.testclient import TestClient
    from app import app as application
    from app.routers import agent as agent_router

    class FakeChatRunner:
        async def chat(self, session_id, text, *, channel='local', actor_id=''):
            return f'（黄金基线模拟回答）{text[:20]}'

        async def chat_stream(self, session_id, text, *, channel='local', actor_id=''):
            yield {'type': 'delta', 'content': f'（黄金基线模拟流式回答）{text[:20]}'}

    original_runner = agent_router.AgentRunner
    agent_router.AgentRunner = lambda session_store=None, **kwargs: FakeChatRunner()

    client = TestClient(application, raise_server_exceptions=False)
    scope_headers = {'x-workbench-class': '1', 'x-workbench-term': '1'}

    cases = []
    try:
        def run(case_id, module, method, path, note, query=None, body=None,
                expect=200, headers=None, capture_keys=None, raw_body=False):
            url = path
            for key, value in list(runner.ctx.items()):
                url = url.replace(f'{{{key}}}', str(value))
            headers = {**scope_headers, **(headers or {})}
            response = client.request(method, url, params=query, json=body, headers=headers)
            content = response.content
            content_type = response.headers.get('content-type', '')
            binary = None
            if content_type and 'application/json' not in content_type:
                binary = binary_summary(content, content_type)
            runner.record(case_id, module, note, method, path, query, expect,
                          content_type=content_type, raw=content, files=binary)
            runner.cases[-1]['actual_status'] = response.status_code
            runner.cases[-1]['ok'] = response.status_code == expect
            if capture_keys:
                try:
                    runner.capture(response.json(), capture_keys)
                except (ValueError, json.JSONDecodeError):
                    pass
            return response

        # ---------- app（根页面与 favicon） ----------
        run('app-01', 'app', 'GET', '/', '根页面', expect=200)
        run('app-02', 'app', 'GET', '/favicon.svg', 'favicon', expect=200)

        # ---------- context（班级学期与在班） ----------
        run('context-01', 'context', 'GET', '/api/context', '上下文读取', expect=200)
        run('context-02', 'context', 'POST', '/api/classes', '创建班级（写入）',
            body={'name': '黄金测试班', 'grade': '高一'}, expect=200,
            capture_keys=['class_id', 'term_id'])
        run('context-03', 'context', 'POST', '/api/classes/{class_id}/terms', '创建学期（写入）',
            body={'name': '黄金学期', 'start_date': '2026-02-10', 'end_date': '2026-07-10'}, expect=200)
        run('context-04', 'context', 'POST', '/api/classes', '空班级名错误',
            body={'name': '', 'grade': ''}, expect=422)
        run('context-05', 'context', 'GET', '/api/enrollments', '在班关系读取', expect=200)
        run('context-06', 'context', 'POST', '/api/enrollments', '在班关系写入',
            body={'student_id': 1, 'status': '在读'}, expect=200)
        run('context-07', 'context', 'POST', '/api/classes', '归档班级（供权限用例）',
            body={'name': '归档班', 'grade': ''}, expect=200,
            capture_keys=[('archived_class_id', 'class_id'),
                          ('archived_term_default', 'term_id')])
        run('context-08', 'context', 'PUT', '/api/terms/{term_id}', '归档黄金测试班学期（写入）',
            body={'status': '已归档'}, expect=200)
        run('context-08a0', 'context', 'PUT', '/api/terms/{archived_term_default}', '归档班默认学期归档（写入）',
            body={'status': '已归档'}, expect=200)
        run('context-08a', 'context', 'POST', '/api/classes/{archived_class_id}/terms', '归档班再建学期',
            body={'name': '归档班学期'}, expect=200, capture_keys=[('archived_term_id', 'term_id')])
        run('context-08b', 'context', 'PUT', '/api/terms/{archived_term_id}', '归档班学期归档（写入）',
            body={'status': '已归档'}, expect=200)
        run('context-08c', 'context', 'PUT', '/api/classes/{archived_class_id}', '归档班级（写入）',
            body={'status': '已归档'}, expect=200)
        run('context-09', 'context', 'GET', '/api/students', '归档班级读取放行（只读语义）',
            headers={'x-workbench-class': runner.ctx['archived_class_id'],
                     'x-workbench-term': runner.ctx['archived_term_id']}, expect=200)
        run('context-10', 'context', 'POST', '/api/events', '归档班级写入拒绝（409）',
            headers={'x-workbench-class': runner.ctx['archived_class_id'],
                     'x-workbench-term': runner.ctx['archived_term_id']},
            body={'student_id': 1, 'occurred_at': '2026-04-15 08:10', 'event_type': '迟到',
                  'description': '归档写入测试'}, expect=409)

        # ---------- students ----------
        run('students-01', 'students', 'GET', '/api/students', '学生列表读取', expect=200)
        run('students-02', 'students', 'POST', '/api/students', '新增学生（写入）',
            body={'学号': 'G001', '姓名': '黄金学生', '性别': '男'}, expect=200, capture_keys=['student_id'])
        run('students-03', 'students', 'PUT', '/api/students/{student_id}', '更新学生（写入）',
            body={'姓名': '黄金学生二号'}, expect=200)
        run('students-04', 'students', 'POST', '/api/students', '重复学号错误',
            body={'学号': 'G001', '姓名': '重复学生'}, expect=409)
        run('students-05', 'students', 'GET', '/api/students/{student_id}/photo', '头像不存在（错误）',
            expect=404)
        run('students-06', 'students', 'GET', '/api/students/template', '导入模板（二进制）', expect=200)
        run('students-07', 'students', 'GET', '/api/students/export', '导出学生（二进制）', expect=200)

        # ---------- sheets（通用工作表） ----------
        run('sheets-01', 'sheets', 'GET', '/api/sheets', '工作表元数据列表', expect=200)
        run('sheets-02', 'sheets', 'POST', '/api/sheet/班主任日志/append', '追加行（写入）',
            body={'data': [{'日期': '2026-04-15', '内容': '黄金基线记录'}]}, expect=200, capture_keys=['row_no'])
        run('sheets-03', 'sheets', 'PUT', '/api/sheet/班主任日志/update', '更新行（写入）',
            body={'row_no': int(runner.ctx.get('row_no', '1')), 'col': 1, 'value': '黄金基线记录已更新'}, expect=200)
        run('sheets-04', 'sheets', 'PUT', '/api/sheet/班主任日志/update', '更新不存在行（错误）',
            body={'row_no': 9999, 'col': 0, 'value': 'x'}, expect=404)
        run('sheets-05', 'sheets', 'GET', '/api/sheet/班主任日志', '行数据读取', expect=200)

        # ---------- seating ----------
        run('seating-01', 'seating', 'GET', '/api/seating', '座位表读取', expect=200)
        run('seating-02', 'seating', 'POST', '/api/seating/update', '座位更新（写入）',
            body={'row': 1, 'col': 1, 'value': '张同学'}, expect=200)

        # ---------- stats ----------
        run('stats-01', 'stats', 'GET', '/api/stats/dashboard', '首页统计读取', expect=200)
        run('stats-02', 'stats', 'GET', '/api/stats/calendar', '本月日历读取', expect=200)
        run('stats-03', 'stats', 'GET', '/api/stats/attendance', '考勤统计读取', expect=200)
        run('stats-04', 'stats', 'GET', '/api/stats/scores', '成绩统计读取', expect=200)
        run('stats-05', 'stats', 'GET', '/api/stats/points', '积分统计读取', expect=200)
        run('stats-06', 'stats', 'GET', '/api/stats/fund', '班费统计读取', expect=200)

        # ---------- p0（行动闭环） ----------
        run('p0-01', 'p0', 'GET', '/api/tasks', '工作项列表读取', expect=200)
        run('p0-02', 'p0', 'POST', '/api/events', '创建事件（写入）',
            body={'student_id': 1, 'occurred_at': '2026-04-15 08:10', 'event_type': '迟到',
                  'description': '黄金基线事件', 'needs_followup': True, 'followup_due': '2026-04-18'},
            expect=200, capture_keys=['event_id'])
        run('p0-03', 'p0', 'GET', '/api/students/{student_id}/detail', '学生详情读取', expect=200)
        run('p0-04', 'p0', 'POST', '/api/communications', '家校沟通写入',
            body={'student_id': 1, 'communicated_at': '2026-04-15 09:00', 'method': '电话',
                  'reason': '迟到沟通', 'summary': '已提醒按时到校'}, expect=200)
        run('p0-05', 'p0', 'POST', '/api/tasks', '创建任务（写入）',
            body={'title': '黄金基线任务', 'student_id': 1, 'due_at': '2026-04-18'}, expect=200,
            capture_keys=['task_id'])
        run('p0-06', 'p0', 'PUT', '/api/tasks/{task_id}', '完成任务（写入）',
            body={'status': '已完成', 'result': '黄金基线完成'}, expect=200)
        run('p0-07', 'p0', 'POST', '/api/events', '不存在学生的事件（错误）',
            body={'student_id': 9999, 'occurred_at': '2026-04-15 08:10', 'event_type': '迟到',
                  'description': 'x'}, expect=404)
        run('p0-08', 'p0', 'POST', '/api/attendance/daily', '批量考勤写入',
            body={'date': '2026-04-15', 'scene': '常规到校',
                  'records': [{'student_id': 1, 'status': '出勤'}]}, expect=200)
        run('p0-09', 'p0', 'GET', '/api/tasks/summary', '工作项汇总读取', expect=200)
        run('p0-10', 'p0', 'GET', '/api/attendance/records', '考勤记录读取', expect=200)

        # ---------- p1（高频教师业务） ----------
        run('p1-01', 'p1', 'GET', '/api/search', '搜索读取', query={'q': '张三'}, expect=200)
        run('p1-02', 'p1', 'POST', '/api/score-config/subjects', '科目配置写入',
            body={'name': '物理', 'full_score': 100, 'type': '选考'}, expect=200, capture_keys=['subject_id'])
        run('p1-03', 'p1', 'POST', '/api/score-config/exams', '考试配置写入',
            body={'name': '黄金月考', 'exam_date': '2026-04-20'}, expect=200,
            capture_keys=[('exam_id', 'id'), ('exam_id', 'exam_id')])
        run('p1-04', 'p1', 'PUT', '/api/score-config/exams/{exam_id}', '考试配置更新',
            body={'name': '黄金月考（更新）'}, expect=200)
        run('p1-05', 'p1', 'POST', '/api/exams/import/commit', '成绩导入提交（写入）',
            body={'filename': 'golden.xlsx', 'request_id': 'golden-exam-commit',
                  'rows': [{'row': 1, 'valid': True, 'student_id': 1, 'exam_name': '黄金月考',
                            'exam_date': '2026-04-20', 'subject': '物理', 'score': 92.0, 'rank': 1,
                            'record_status': '正常', 'note': ''}]}, expect=200)
        run('p1-06', 'p1', 'GET', '/api/exams', '成绩记录读取', expect=200)
        run('p1-07', 'p1', 'GET', '/api/exams/summary', '成绩汇总读取', expect=200)
        run('p1-08', 'p1', 'POST', '/api/attendance/rules', '考勤规则写入',
            body={'name': '黄金考勤规则', 'metric': '迟到次数', 'threshold': 3,
                  'period_days': 7, 'scene': '早自习', 'enabled': True}, expect=200,
            capture_keys=[('attendance_rule_id', 'rule_id'), ('attendance_rule_id', 'id')])
        run('p1-09', 'p1', 'PUT', '/api/attendance/rules/{attendance_rule_id}', '考勤规则更新',
            body={'enabled': False}, expect=200)
        run('p1-10', 'p1', 'POST', '/api/attendance/rules/evaluate', '考勤规则评估（写入）',
            body={'reference_date': '2026-04-15'}, expect=200)
        run('p1-11', 'p1', 'GET', '/api/attendance/rules', '考勤规则读取', expect=200)
        run('p1-12', 'p1', 'POST', '/api/class-task-templates', '任务模板写入',
            body={'name': '黄金任务模板', 'material_name': '作业本', 'description': '收集材料'},
            expect=200, capture_keys=[('template_id', 'id'), ('template_id', 'template_id')])
        run('p1-13', 'p1', 'PUT', '/api/class-task-templates/{template_id}', '任务模板更新',
            body={'content': '收集材料（更新）'}, expect=200)
        run('p1-14', 'p1', 'POST', '/api/class-tasks', '班级任务写入',
            body={'title': '黄金班级任务', 'description': '收集材料', 'material_name': '作业本',
                  'student_ids': [1]}, expect=200, capture_keys=[('class_task_id', 'task_id')])
        run('p1-15', 'p1', 'PUT', '/api/class-tasks/{class_task_id}/items/1', '任务提交（写入）',
            body={'status': '已提交', 'note': '黄金基线'}, expect=200)
        run('p1-16', 'p1', 'GET', '/api/class-tasks', '班级任务读取', expect=200)
        run('p1-17', 'p1', 'GET', '/api/duty', '值日读取', expect=200)
        run('p1-18', 'p1', 'POST', '/api/duty', '值日写入',
            body={'duty_date': '2026-04-15', 'area': '教室', 'student_id': 1}, expect=200)
        run('p1-19', 'p1', 'POST', '/api/duty/rotation-rules', '值日轮换规则写入',
            body={'name': '黄金轮换', 'area': '教室', 'start_date': '2026-03-01', 'period_days': 7,
                  'student_ids': [1]}, expect=200,
            capture_keys=[('rotation_rule_id', 'rule_id'), ('rotation_rule_id', 'id')])
        run('p1-20', 'p1', 'POST', '/api/duty/rotation-rules/{rotation_rule_id}/generate', '轮换生成（写入）',
            body={}, expect=200)
        run('p1-21', 'p1', 'GET', '/api/score-config', '成绩配置读取', expect=200)
        run('p1-22', 'p1', 'POST', '/api/exams/import/commit', '成绩导入缺字段（错误）',
            body={'filename': 'bad.xlsx', 'request_id': 'golden-bad', 'rows': [
                {'row': 1, 'valid': False, 'student_id': 1, 'exam_name': '', 'subject': '',
                 'score': None, 'rank': None, 'record_status': '错误', 'note': '缺科目'}]},
            expect=400)

        # ---------- points（积分） ----------
        run('points-01', 'points', 'GET', '/api/points', '积分流水读取', expect=200)
        run('points-02', 'points', 'POST', '/api/points/entries', '积分流水写入',
            body={'student_id': 1, 'amount': 5, 'reason': '黄金基线加分'}, expect=200,
            capture_keys=[('point_entry_id', 'id')])
        run('points-03', 'points', 'POST', '/api/points/entries/{point_entry_id}/revoke', '积分撤销（写入）',
            body={'reason': '黄金基线撤销'}, expect=200)
        run('points-04', 'points', 'POST', '/api/points/rules', '积分规则写入',
            body={'name': '黄金积分规则', 'category': '日常行为', 'metric': '周期扣分',
                  'threshold': 3, 'period_days': 7}, expect=200, capture_keys=['point_rule_id'])
        run('points-05', 'points', 'POST', '/api/points/rules/evaluate', '积分规则评估（写入）',
            body={'reference_date': '2026-04-15'}, expect=200)
        run('points-06', 'points', 'POST', '/api/points/entries', '不存在学生积分（错误）',
            body={'student_id': 9999, 'amount': 1, 'reason': 'x'}, expect=404)
        run('points-07', 'points', 'GET', '/api/points/rule-hits', '规则命中读取', expect=200)

        # ---------- funds（班费） ----------
        run('funds-01', 'funds', 'GET', '/api/fund', '班费流水读取', expect=200)
        run('funds-02', 'funds', 'POST', '/api/fund/entries', '班费流水写入',
            body={'direction': '支出', 'amount': 50.0, 'description': '黄金基线支出'}, expect=200,
            capture_keys=[('fund_entry_id', 'id')])
        run('funds-03', 'funds', 'PUT', '/api/fund/entries/{fund_entry_id}', '班费流水更新',
            body={'description': '黄金基线支出（更新）'}, expect=200)
        run('funds-04', 'funds', 'POST', '/api/fund/entries/{fund_entry_id}/reverse',
            '未结算流水不可冲正（业务规则，400）',
            body={'reason': '黄金基线冲正', 'occurred_at': '2026-04-15'}, expect=400)
        run('funds-05', 'funds', 'POST', '/api/fund/entries/{fund_entry_id}/revoke', '班费流水撤销（写入）',
            body={'reason': '黄金基线撤销'}, expect=200)
        run('funds-06', 'funds', 'POST', '/api/fund/categories', '班费分类写入',
            body={'name': '图书费', 'direction': '支出'}, expect=200)
        run('funds-07', 'funds', 'GET', '/api/fund/categories', '班费分类读取', expect=200)
        run('funds-08', 'funds', 'POST', '/api/fund/settlements', '班费结算写入',
            body={'period_start': '2026-03-01', 'period_end': '2026-03-31'}, expect=200)
        run('funds-09', 'funds', 'POST', '/api/fund/entries', '班费缺金额（错误）',
            body={'direction': '支出', 'description': 'x'}, expect=422)

        # ---------- comments（评语） ----------
        run('comments-01', 'comments', 'GET', '/api/comments', '评语读取', expect=200)
        run('comments-02', 'comments', 'POST', '/api/comments/templates', '评语模板写入',
            body={'name': '黄金模板', 'comment_type': '学期评语', 'content': '表现良好'}, expect=200,
            capture_keys=[('comment_template_id', 'id')])
        run('comments-03', 'comments', 'PUT', '/api/comments/templates/{comment_template_id}', '评语模板更新',
            body={'content': '表现优秀'}, expect=200)
        run('comments-04', 'comments', 'POST', '/api/comments/entries', '评语条目写入',
            body={'student_id': 1, 'comment_type': '学期评语', 'content': '黄金基线评语'}, expect=200,
            capture_keys=[('comment_entry_id', 'id')])
        run('comments-05', 'comments', 'PUT', '/api/comments/entries/{comment_entry_id}', '评语条目更新',
            body={'content': '黄金基线评语（更新）'}, expect=200)
        run('comments-06', 'comments', 'POST', '/api/comments/entries/{comment_entry_id}/transition', '评语流转到待审核（写入）',
            body={'target_status': '待审核', 'note': '提交审核'}, expect=200)
        run('comments-07', 'comments', 'POST', '/api/comments/entries/{comment_entry_id}/transition', '评语流转到完成（写入）',
            body={'target_status': '完成', 'note': '审核通过'}, expect=200)
        run('comments-08', 'comments', 'POST', '/api/comments/entries', '评语空内容（错误）',
            body={'student_id': 1, 'content': ''}, expect=422)

        # ---------- education（班会/活动/日志） ----------
        run('education-01', 'education', 'GET', '/api/education/meetings', '班会列表读取', expect=200)
        run('education-02', 'education', 'POST', '/api/education/meetings', '班会写入',
            body={'topic': '黄金基线班会', 'held_on': '2026-04-15', 'content': '纪律要求'}, expect=200,
            capture_keys=[('meeting_id', 'id'), ('meeting_id', 'meeting_id')])
        run('education-03', 'education', 'PUT', '/api/education/meetings/{meeting_id}', '班会更新',
            body={'content': '纪律要求（更新）'}, expect=200)
        run('education-04', 'education', 'POST', '/api/education/diary', '日志写入',
            body={'diary_date': '2026-04-15', 'work': '黄金基线日志'}, expect=200,
            capture_keys=[('diary_id', 'id'), ('diary_id', 'diary_id')])
        run('education-05', 'education', 'PUT', '/api/education/diary/{diary_id}', '日志更新',
            body={'content': '黄金基线日志（更新）'}, expect=200)
        run('education-06', 'education', 'POST', '/api/education/activities', '活动写入',
            body={'name': '黄金基线活动', 'occurred_on': '2026-04-15', 'summary': '春游'}, expect=200,
            capture_keys=[('activity_id', 'id'), ('activity_id', 'activity_id')])
        run('education-07', 'education', 'GET', '/api/education/activities/{activity_id}', '活动读取', expect=200)
        run('education-08', 'education', 'DELETE', '/api/education/diary/9999',
            '删除不存在日志（旧行为缺陷：RecycleError 未映射为 HTTP 错误，实际返回 500）',
            expect=500)
        run('education-09', 'education', 'POST', '/api/education/templates', '班会模板写入',
            body={'kind': 'meeting', 'name': '黄金班会模板', 'content': '流程模板'}, expect=200)

        # ---------- reports（报告） ----------
        run('reports-01', 'reports', 'GET', '/api/reports/archives', '报告档案读取', expect=200)
        run('reports-02', 'reports', 'POST', '/api/reports/preview', '报告预览（写入）',
            body={'report_type': 'weekly', 'period_start': '2026-04-06', 'period_end': '2026-04-12'},
            expect=200)
        run('reports-03', 'reports', 'POST', '/api/reports/archives', '报告归档（写入）',
            body={'report_type': 'weekly', 'period_start': '2026-04-06', 'period_end': '2026-04-12',
                  'class_summary': '本周整体稳定'}, expect=200,
            capture_keys=[('archive_id', 'id'), ('archive_id', 'archive_id')])
        run('reports-04', 'reports', 'GET', '/api/reports/archives/{archive_id}', '报告档案读取', expect=200)
        run('reports-05', 'reports', 'GET', '/api/reports/archives/{archive_id}/export', '报告导出（二进制）',
            expect=200)

        # ---------- health（健康） ----------
        run('health-01', 'health', 'GET', '/api/health/summary', '健康汇总读取', expect=200)
        run('health-02', 'health', 'POST', '/api/health/goals', '健康目标写入',
            body={'metric': '体重', 'target_value': 60.0, 'unit': 'kg'}, expect=200,
            capture_keys=[('goal_id', 'id'), ('goal_id', 'goal_id')])
        run('health-03', 'health', 'PUT', '/api/health/goals/{goal_id}', '健康目标更新',
            body={'target_value': 58.0}, expect=200)
        run('health-04', 'health', 'POST', '/api/health/reminders', '健康提醒写入',
            body={'reminder_type': 'sleep', 'enabled': True, 'remind_time': '22:30'}, expect=200)
        run('health-05', 'health', 'GET', '/api/health/reminders', '健康提醒读取', expect=200)
        run('health-06', 'health', 'POST', '/api/health/reviews', '健康复盘写入',
            body={'period_type': 'month', 'summary': '本月保持'}, expect=200)
        run('health-07', 'health', 'GET', '/api/health/goals', '健康目标读取', expect=200)

        # ---------- knowledge（知识库） ----------
        run('knowledge-01', 'knowledge', 'GET', '/api/knowledge/notes', '笔记列表读取', expect=200)
        run('knowledge-02', 'knowledge', 'POST', '/api/knowledge/create', '创建笔记（写入）',
            body={'title': '黄金基线笔记', 'category': '个人成长', 'content': '## 标题\n正文内容',
                  'tags': ['黄金']}, expect=200, capture_keys=[('note_id', 'id')])
        run('knowledge-03', 'knowledge', 'GET', '/api/knowledge/notes/read', '笔记内容读取',
            query={'path': '个人成长/黄金基线笔记.md'}, expect=200)
        run('knowledge-04', 'knowledge', 'PUT', '/api/knowledge/notes/{note_id}', '更新笔记（写入）',
            body={'title': '黄金基线笔记（更新）', 'content': '更新后的内容'}, expect=200)
        run('knowledge-05', 'knowledge', 'PUT', '/api/knowledge/notes/9999', '更新不存在笔记（错误）',
            body={'title': 'x', 'content': 'y'}, expect=400)
        run('knowledge-06', 'knowledge', 'GET', '/api/knowledge/notes', '外部冲突读取', query={'q': '黄金'},
            expect=200)

        # ---------- export（导出） ----------
        run('export-01', 'export', 'GET', '/api/export/sheet/学生信息总表', '工作表导出（二进制）', expect=200)
        run('export-02', 'export', 'GET', '/api/export/report/attendance', '考勤汇总导出（二进制）',
            query={'date_from': '2026-04-01', 'date_to': '2026-04-30'}, expect=200)

        # ---------- recycle（回收站与审计） ----------
        run('recycle-01', 'recycle', 'GET', '/api/recycle-bin', '回收站读取', expect=200)
        run('recycle-02', 'recycle', 'DELETE', '/api/records/event/{event_id}', '事件移入回收站（写入）',
            expect=200)
        run('recycle-03', 'recycle', 'GET', '/api/recycle-bin', '回收站含软删记录', expect=200)
        run('recycle-04', 'recycle', 'GET', '/api/system/audit', '系统审计读取', expect=200)
        run('recycle-05', 'recycle', 'POST', '/api/recycle-bin/9999/restore', '恢复不存在记录（错误）',
            expect=400)
        run('recycle-06', 'recycle', 'DELETE', '/api/recycle-bin/9999/purge', '永久删除不存在记录（错误）',
            body={'confirmation': '永久删除'}, expect=400)

        # ---------- workflow（统一流程） ----------
        run('workflow-00', 'p0', 'POST', '/api/events', '为工作流用例新建事件',
            body={'student_id': 1, 'occurred_at': '2026-04-16 08:10', 'event_type': '迟到',
                  'description': '黄金基线事件二号'}, expect=200, capture_keys=[('workflow_event_id', 'event_id')])
        run('workflow-01', 'workflow', 'GET', '/api/workflows/event/{workflow_event_id}', '工作流来源读取', expect=200)
        run('workflow-02', 'workflow', 'PUT', '/api/workflows/event/{workflow_event_id}', '工作流更新（写入）',
            body={'status': '已完成', 'result': '黄金基线处理完毕', 'request_id': 'golden-workflow'},
            expect=200)
        run('workflow-03', 'workflow', 'PUT', '/api/workflows/event/9999', '工作流不存在来源（错误）',
            body={'status': '已完成'}, expect=404)

        # ---------- system（系统运维） ----------
        run('system-01', 'system', 'GET', '/api/system/health', '健康检查', expect=200)
        run('system-02', 'system', 'GET', '/api/system/runtime', '运行时信息', expect=200)
        run('system-03', 'system', 'GET', '/api/system/access-info', '局域网访问信息', expect=200)
        run('system-04', 'system', 'GET', '/api/system/backups', '备份列表读取', expect=200)
        run('system-05', 'system', 'POST', '/api/system/backup', '创建备份（写入）', expect=200,
            capture_keys=[('backup_filename', 'filename', 'string')])
        run('system-06', 'system', 'GET', '/api/system/backup/{backup_filename}', '下载备份（二进制）', expect=200)
        run('system-07', 'system', 'GET', '/api/system/update/github-token', '更新 Token 状态读取', expect=200)
        run('system-08', 'system', 'PUT', '/api/system/update/github-token', '保存 Token（写入）',
            body={'token': 'ghp_goldenbaselinetoken123456789'}, expect=200)
        run('system-09', 'system', 'PUT', '/api/system/update/github-token', '非法 Token（错误）',
            body={'token': 'not-a-token'}, expect=400)
        run('system-10', 'system', 'GET', '/api/system/update/status', '更新状态读取', expect=200)

        # ---------- agent（工具与基础接口） ----------
        run('agent-01', 'agent', 'GET', '/api/agent/status', 'Agent 状态读取', expect=200)
        run('agent-02', 'agent', 'GET', '/api/agent/tools', '工具列表读取', expect=200)
        run('agent-03', 'agent', 'POST', '/api/agent/tools/students_query', '只读工具调用',
            body={'arguments': {'fields': ['student_no', 'student_name']}, 'channel': 'web',
                  'actor_id': 'golden'}, expect=200)
        run('agent-04', 'agent', 'POST', '/api/agent/tools/nonexistent_tool', '不存在工具（错误）',
            body={'arguments': {}, 'channel': 'web', 'actor_id': 'golden'}, expect=400)
        run('agent-05', 'agent', 'POST', '/api/agent/chat', '网页对话（写入，模拟模型）',
            body={'session_id': 'golden-web-session', 'message': '查看所有学生的姓名',
                  'channel': 'web', 'actor_id': 'golden-user'}, expect=200)
        run('agent-06', 'agent', 'GET', '/api/agent/sessions', '会话列表读取', expect=200)
        run('agent-07', 'agent', 'POST', '/api/agent/chat', '空消息（错误）',
            body={'session_id': 'golden-web-session', 'message': ''}, expect=422)
        run('agent-08', 'agent', 'POST', '/api/agent/chat/stream', '流式对话（模拟模型）',
            body={'session_id': 'golden-web-session', 'message': '查看所有学生的姓名',
                  'channel': 'web', 'actor_id': 'golden-user'}, expect=200)

        # ---------- wechat（微信渠道） ----------
        run('wechat-01', 'wechat', 'GET', '/api/wechat/config', '微信配置读取', expect=200)
        run('wechat-02', 'wechat', 'GET', '/api/wechat/status', '微信状态读取', expect=200)
        run('wechat-03', 'wechat', 'PUT', '/api/wechat/config', '空配置保存（旧行为接受）',
            body={'base_url': '', 'client_id': '', 'client_secret': ''}, expect=200)

    finally:
        agent_router.AgentRunner = original_runner
        db.close()
        db.DB_PATH, db.DATA_DIR = old_path, old_data_dir

    summary = {
        'total': len(runner.cases),
        'passed': sum(1 for case in runner.cases if case['ok']),
        'failed': [case['id'] for case in runner.cases if not case['ok']],
        'modules': sorted({case['module'] for case in runner.cases}),
    }
    write_json(os.path.join(OUT_API, 'golden-cases.json'),
               {'summary': summary, 'cases': runner.cases})
    print(f'API 黄金用例：{summary["passed"]}/{summary["total"]} 通过')
    print('覆盖模块：' + '、'.join(summary['modules']))
    if summary['failed']:
        print('失败用例：' + '、'.join(summary['failed']))
        return 1
    return 0


if __name__ == '__main__':
    runner = GoldenRunner()
    sys.exit(main())
