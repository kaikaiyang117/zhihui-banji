# -*- coding: utf-8 -*-
"""MIG-00 基线 5：Agent 黄金轨迹。

产出 out/agent/agent-baseline.json，包含：
- 固定回归 JSON 的全部工具用例（tool / denied / invalid_arguments）的结构化结果
- 确定性模型下的对话轨迹（最终回答 + 会话可见消息 + 工具调用配对）
- 流式事件序列（chat_stream 的事件类型顺序）
- 敏感/权限拒绝轨迹（微信渠道过滤）

全部使用临时数据库和模拟模型，不访问真实模型与网络。
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import BACKEND_DIR, FIXTURES, OUT_AGENT, write_json  # noqa: E402

sys.path.insert(0, BACKEND_DIR)
sys.path.insert(0, os.path.dirname(BACKEND_DIR))


def run_regression_cases(results):
    from app import db
    from backend.tests.helpers import enroll_all_students
    from app.agent.agent_service import invoke_tool
    from app.agent.runner import AgentRunner
    from app.agent.tool_registry import ToolError

    with open(os.path.join(FIXTURES, 'agent_regression.json'), encoding='utf-8') as stream:
        cases = json.load(stream)
    for case in cases:
        record = {'name': case['name'], 'kind': case['kind'], 'tool': case['tool']}
        try:
            if case['kind'] == 'tool':
                result = invoke_tool(case['tool'], case['arguments'])
                record['ok'] = True
                record['required_keys_present'] = all(key in result for key in case.get('required_keys', []))
                if 'expected_first_name' in case:
                    record['first_name'] = result['students'][0]['姓名']
                    record['first_name_ok'] = record['first_name'] == case['expected_first_name']
                record['result_summary'] = {
                    key: result[key] for key in case.get('required_keys', []) if key in result
                }
            elif case['kind'] == 'denied':
                try:
                    invoke_tool(case['tool'], case['arguments'], channel=case['channel'], actor_id='regression')
                    record['ok'] = False
                    record['error'] = '未按预期拒绝'
                except ToolError as exc:
                    record['ok'] = exc.code == case['expected_code']
                    record['error_code'] = exc.code
            elif case['kind'] == 'invalid_arguments':
                result = AgentRunner._call_tool(case['tool'], case['raw_arguments'], 'web', 'regression')
                record['ok'] = result['error']['code'] == case['expected_code']
                record['error_code'] = result['error']['code']
        except Exception as exc:  # noqa: BLE001
            record['ok'] = False
            record['error'] = f'{type(exc).__name__}: {exc}'
        results['regression_cases'].append(record)


def run_chat_trajectories(results):
    from app import db
    from backend.tests.helpers import enroll_all_students
    from app.agent.runner import AgentRunner
    from app.agent.model_client import ModelResponse
    from app.agent.session_store import SessionStore

    class FakeModel:
        """确定性模拟模型：第一轮返回工具调用，第二轮返回最终回答。"""
        def __init__(self, first_answer, tool_call=None):
            self.first_answer = first_answer
            self.tool_call = tool_call
            self.round = 0
            self.calls = []

        async def complete(self, messages, tools):
            self.calls.append([{'role': m['role'], 'content': str(m.get('content', ''))[:120]}
                               for m in messages])
            self.round += 1
            if self.round == 1 and self.tool_call:
                return ModelResponse('', [{'id': 'call-1', 'type': 'function',
                                           'function': {'name': self.tool_call[0],
                                                        'arguments': json.dumps(self.tool_call[1], ensure_ascii=False)}}])
            return ModelResponse(self.first_answer, [])

    scenarios = [
        {
            'name': '批量学生查询（确定性工具调用）',
            'session': 'golden-trajectory-batch',
            'text': '查看所有学生的姓名和学号',
            'channel': 'web',
            'model': FakeModel('已查询全部学生。', ('students_query', {'fields': ['student_no', 'student_name']})),
        },
        {
            'name': '直接回答（无工具调用）',
            'session': 'golden-trajectory-direct',
            'text': '你好',
            'channel': 'web',
            'model': FakeModel('你好！我是凯凯小兵。'),
        },
    ]
    for scenario in scenarios:
        record = {'name': scenario['name'], 'session': scenario['session'], 'channel': scenario['channel']}
        try:
            runner = AgentRunner(model_client=scenario['model'], session_store=SessionStore())
            answer = asyncio.run(runner.chat(
                scenario['session'], scenario['text'],
                channel=scenario['channel'], actor_id='golden-user'))
            record['answer'] = answer
            record['model_rounds'] = scenario['model'].round
            record['model_calls'] = scenario['model'].calls
            stored = SessionStore().load(scenario['session'])
            visible = [{'role': m['role'], 'content': str(m.get('content', ''))[:200]}
                       for m in stored if m['role'] != 'system']
            record['session_messages'] = visible
            tool_calls = [m for m in stored if m.get('tool_calls')]
            record['tool_call_count'] = len(tool_calls)
            record['ok'] = bool(answer)
        except Exception as exc:  # noqa: BLE001
            record['ok'] = False
            record['error'] = f'{type(exc).__name__}: {exc}'
        results['chat_trajectories'].append(record)


def run_stream_events(results):
    from app import db
    from backend.tests.helpers import enroll_all_students
    from app.agent.runner import AgentRunner
    from app.agent.model_client import ModelResponse
    from app.agent.session_store import SessionStore

    class StreamModel:
        async def complete(self, messages, tools):
            return ModelResponse('流式回答完成。', [])

        async def iter_complete(self, messages, tools=None):
            from app.agent.model_client import ModelStreamEvent
            yield ModelStreamEvent(content='流式回答完成。',
                                   response=ModelResponse('流式回答完成。', []))

    async def collect():
        events = []
        runner = AgentRunner(model_client=StreamModel(), session_store=SessionStore())
        async for event in runner.chat_stream(
                'golden-stream-session', '查看所有学生姓名',
                channel='web', actor_id='golden-user'):
            events.append(event)
        return events

    record = {'name': '流式事件序列'}
    try:
        record['events'] = asyncio.run(collect())
        record['ok'] = True
    except Exception as exc:  # noqa: BLE001
        record['ok'] = False
        record['error'] = f'{type(exc).__name__}: {exc}'
    results['stream_events'].append(record)


def run_wechat_denial(results):
    from app import db
    from backend.tests.helpers import enroll_all_students
    from app.agent.agent_service import invoke_tool
    from app.agent.tool_registry import ToolError

    attempts = [
        ('student_get_profile', {'student_id': 1}, 'wechat', 'denied', 'permission_denied'),
        ('student_get_profile', {'student_id': 1}, 'web', 'allowed', ''),
        ('create_task', {'title': '微信渠道测试任务', 'student_id': 1}, 'wechat', 'denied', 'confirmation_required'),
    ]
    for tool, args, channel, expected, expected_code in attempts:
        record = {'tool': tool, 'channel': channel, 'expected': expected}
        try:
            result = invoke_tool(tool, args, channel=channel, actor_id='golden')
            record['outcome'] = 'allowed'
            record['summary'] = {k: v for k, v in result.items() if k not in ('content',)}
        except ToolError as exc:
            record['outcome'] = 'denied'
            record['error_code'] = exc.code
        except Exception as exc:  # noqa: BLE001
            record['outcome'] = 'unexpected_error'
            record['error'] = f'{type(exc).__name__}: {exc}'
        if expected == 'allowed':
            record['ok'] = record['outcome'] == 'allowed'
        else:
            record['ok'] = record['outcome'] == 'denied' and record.get('error_code') == expected_code
        results['channel_denials'].append(record)


def main():
    from common import temp_data_dir
    results = {
        'regression_cases': [],
        'chat_trajectories': [],
        'stream_events': [],
        'channel_denials': [],
    }
    with temp_data_dir('p0_demo') as db:
        from app import db as database
        conn = database.get_conn()
        for no, name, gender, role in (('A001', '张三', '男', '班长'), ('A002', '李四', '女', '')):
            conn.execute('INSERT OR IGNORE INTO students(学号, 姓名, 性别, 班级任职) VALUES(?,?,?,?)',
                         (no, name, gender, role))
        conn.commit()
        from backend.tests.helpers import enroll_all_students
        enroll_all_students()
        run_regression_cases(results)
        run_chat_trajectories(results)
        run_stream_events(results)
        run_wechat_denial(results)

    total = len(results['regression_cases']) + len(results['chat_trajectories']) + \
        len(results['stream_events']) + len(results['channel_denials'])
    passed = sum(1 for group in (
        results['regression_cases'], results['chat_trajectories'],
        results['stream_events'], results['channel_denials']) for item in group if item.get('ok'))
    write_json(os.path.join(OUT_AGENT, 'agent-baseline.json'), results)
    print(f'Agent 黄金轨迹：{passed}/{total} 通过')
    for group, name in (
            (results['regression_cases'], '固定回归'),
            (results['chat_trajectories'], '对话轨迹'),
            (results['stream_events'], '流式事件'),
            (results['channel_denials'], '渠道拒绝')):
        ok = sum(1 for item in group if item.get('ok'))
        print(f'  {name}: {ok}/{len(group)}')
    return 0 if passed == total else 1


if __name__ == '__main__':
    sys.exit(main())
