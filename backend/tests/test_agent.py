# -*- coding: utf-8 -*-
import asyncio
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db
from app.agent import actions
from app.agent.agent_service import invoke_tool, list_audits, list_tools
from app.agent.model_client import ModelResponse, ModelStreamEvent, ToolCall
from app.agent.runner import AgentRunner
from app.agent.session_store import SessionStore
from app.agent.tool_registry import ToolError
from backend.tests.helpers import enroll_all_students


class AgentFoundationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_data_dir = db.DB_PATH, db.DATA_DIR
        db.close()
        db.DATA_DIR = self.temp.name
        db.DB_PATH = os.path.join(self.temp.name, 'test.db')
        conn = db.get_conn()
        conn.executemany(
            'INSERT INTO students(学号, 姓名, 性别, 班级任职) VALUES(?,?,?,?)',
            [('A001', '张三', '男', '班长'), ('A002', '李四', '女', '')],
        )
        conn.commit()
        enroll_all_students()

    def tearDown(self):
        db.close()
        db.DB_PATH, db.DATA_DIR = self.old_path, self.old_data_dir
        self.temp.cleanup()

    def test_registry_exposes_read_and_confirmation_gated_write_tools(self):
        tools = list_tools()
        self.assertEqual(
            [tool['name'] for tool in tools],
            [
                'attendance_summary',
                'class_student_count',
                'communications_list',
                'create_task',
                'record_communication',
                'record_points',
                'save_attendance',
                'school_calendar_query',
                'scores_summary',
                'student_get_profile',
                'student_get_timeline',
                'student_term_comment_context',
                'students_aggregate',
                'students_query',
                'students_search',
                'tasks_list',
            ],
        )
        self.assertTrue(all(tool['read_only'] for tool in tools if not tool['write_action']))
        self.assertEqual(
            {tool['name'] for tool in tools if tool['write_action']},
            {'create_task', 'record_communication', 'record_points', 'save_attendance'},
        )

    def test_class_student_count(self):
        result = invoke_tool('class_student_count')
        self.assertEqual(result, {'student_count': 2})
        self.assertEqual(list_audits(1)[0]['result_summary'], '班级共有 2 名学生')

    def test_common_read_tools_are_callable(self):
        self.assertIn('summary', invoke_tool('attendance_summary'))
        self.assertIn('exams', invoke_tool('scores_summary'))
        self.assertIn('tasks', invoke_tool('tasks_list'))
        self.assertIn('communications', invoke_tool('communications_list'))
        context = invoke_tool('student_term_comment_context', {'student_ids': [1]})
        self.assertEqual(context['students'][0]['姓名'], '张三')
        self.assertNotIn('家庭住址', context['students'][0])

    def test_write_requires_confirmation_backup_and_is_idempotent(self):
        pending = invoke_tool(
            'create_task', {'title': '回访学生', 'student_id': 1, 'due_at': '2026-08-12'},
            channel='web', actor_id='teacher', session_id='web:write-1',
        )
        self.assertTrue(pending['confirmation_required'])
        self.assertEqual(db.get_conn().execute('SELECT COUNT(*) FROM student_tasks').fetchone()[0], 0)
        handled, answer = actions.handle_confirmation(
            '确认', session_id='web:write-1', actor_id='teacher', channel='web')
        self.assertTrue(handled)
        self.assertIn('待办已创建', answer)
        row = db.get_conn().execute('SELECT * FROM student_tasks').fetchone()
        self.assertEqual(row['title'], '回访学生')
        action = db.get_conn().execute('SELECT * FROM agent_actions').fetchone()
        repeated = actions.confirm(action['id'], session_id='web:write-1', actor_id='teacher')
        self.assertTrue(repeated['duplicate'])
        self.assertTrue(action['backup_file'] or db.get_conn().execute(
            'SELECT backup_file FROM agent_actions WHERE id=?', (action['id'],)).fetchone()['backup_file'])

    def test_search_and_profile_are_audited(self):
        result = invoke_tool('students_search', {'keyword': '张'})
        self.assertEqual(result['students'][0]['姓名'], '张三')

        profile = invoke_tool('student_get_profile', {'student_id': 1}, actor_id='teacher')
        self.assertEqual(profile['student']['姓名'], '张三')

        audits = list_audits()
        self.assertEqual(len(audits), 2)
        self.assertEqual(audits[0]['actor_id'], 'teacher')
        self.assertEqual(audits[0]['status'], 'success')
        self.assertIsInstance(audits[0]['arguments'], dict)

    def test_students_query_returns_selected_safe_fields(self):
        db.get_conn().execute(
            'UPDATE students SET 监护人职业=?, 监护人电话=?, 家庭住址=? WHERE id=?',
            ('教师', '13800000000', '测试地址', 1),
        )
        db.get_conn().commit()
        result = invoke_tool('students_query', {
            'fields': ['student_no', 'student_name', 'guardian_occupation'],
            'limit': 100,
        })
        self.assertEqual(result['fields'], ['student_no', 'student_name', 'guardian_occupation'])
        self.assertEqual(result['students'][0]['监护人职业'], '教师')
        self.assertNotIn('监护人电话', result['students'][0])
        self.assertNotIn('家庭住址', result['students'][0])

    def test_students_aggregate_groups_guardian_occupations(self):
        db.get_conn().execute(
            'UPDATE students SET 监护人职业=? WHERE id=?',
            ('教师', 1),
        )
        db.get_conn().execute(
            'UPDATE students SET 监护人职业=? WHERE id=?',
            ('个体经营', 2),
        )
        db.get_conn().commit()
        result = invoke_tool('students_aggregate', {
            'group_by': 'guardian_occupation',
            'include_empty': True,
            'include_students': True,
        })
        self.assertEqual(result['student_count'], 2)
        self.assertEqual(
            [(item['value'], item['count']) for item in result['groups']],
            [('个体经营', 1), ('教师', 1)],
        )
        self.assertEqual(result['groups'][0]['students'][0]['姓名'], '李四')

    def test_student_query_rejects_unapproved_fields(self):
        with self.assertRaises(ToolError) as error:
            invoke_tool('students_query', {'fields': ['家庭住址']})
        self.assertEqual(error.exception.code, 'invalid_arguments')

    def test_planner_uses_batch_query_for_parent_occupation(self):
        class FakeModel:
            def __init__(self):
                self.messages = None

            async def complete(self, messages, _tools):
                self.messages = messages
                return ModelResponse('已整理全班学生家长职业。', [])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model).chat(
            'batch-parent-occupation-session', '查看所有学生家长的职业',
            channel='web', actor_id='web-user',
        ))
        self.assertEqual(answer, '已整理全班学生家长职业。')
        tool_calls = next(message['tool_calls'] for message in model.messages if message.get('tool_calls'))
        self.assertEqual(tool_calls[0]['function']['name'], 'students_query')
        arguments = json.loads(tool_calls[0]['function']['arguments'])
        self.assertEqual(arguments['fields'], ['student_no', 'student_name', 'guardian_occupation'])

    def test_planner_uses_batch_query_for_all_student_names(self):
        class FakeModel:
            def __init__(self):
                self.messages = None

            async def complete(self, messages, _tools):
                self.messages = messages
                return ModelResponse('共有 2 名学生。', [])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model).chat(
            'batch-student-names-session', '查看所有的学生姓名',
            channel='web', actor_id='web-user',
        ))
        self.assertEqual(answer, '共有 2 名学生。')
        tool_calls = next(message['tool_calls'] for message in model.messages if message.get('tool_calls'))
        self.assertEqual(tool_calls[0]['function']['name'], 'students_query')
        arguments = json.loads(tool_calls[0]['function']['arguments'])
        self.assertEqual(arguments['fields'], ['student_no', 'student_name'])

    def test_planner_filters_walk_in_students(self):
        db.get_conn().execute('UPDATE students SET 是否住校=? WHERE id=?', ('走读', 1))
        db.get_conn().execute('UPDATE students SET 是否住校=? WHERE id=?', ('住校', 2))
        db.get_conn().commit()

        class FakeModel:
            def __init__(self):
                self.messages = None

            async def complete(self, messages, _tools):
                self.messages = messages
                return ModelResponse('已查询走读学生。', [])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model).chat(
            'boarding-filter-session', '统计所有走读学生',
            channel='web', actor_id='web-user',
        ))
        self.assertEqual(answer, '已查询走读学生。')
        tool_calls = next(message['tool_calls'] for message in model.messages if message.get('tool_calls'))
        self.assertEqual(tool_calls[0]['function']['name'], 'students_query')
        arguments = json.loads(tool_calls[0]['function']['arguments'])
        self.assertEqual(arguments['boarding_status'], '走读')
        tool_result = next(message for message in model.messages if message.get('role') == 'tool')
        self.assertEqual(json.loads(tool_result['content'])['total_count'], 1)

    def test_planner_uses_aggregate_for_parent_occupation_distribution(self):
        class FakeModel:
            def __init__(self):
                self.messages = None

            async def complete(self, messages, _tools):
                self.messages = messages
                return ModelResponse('已统计全班家长职业分布。', [])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model).chat(
            'aggregate-parent-occupation-session', '统计全班家长职业分布',
            channel='web', actor_id='web-user',
        ))
        self.assertEqual(answer, '已统计全班家长职业分布。')
        tool_calls = next(message['tool_calls'] for message in model.messages if message.get('tool_calls'))
        self.assertEqual(tool_calls[0]['function']['name'], 'students_aggregate')
        arguments = json.loads(tool_calls[0]['function']['arguments'])
        self.assertEqual(arguments['group_by'], 'guardian_occupation')

    def test_unknown_tool_is_rejected_and_audited(self):
        with self.assertRaises(ToolError):
            invoke_tool('student_delete', {'student_id': 1}, channel='wechat', actor_id='wx-user')
        audit = list_audits(1)[0]
        self.assertEqual(audit['status'], 'error')
        self.assertEqual(audit['channel'], 'wechat')

    def test_sensitive_profile_is_denied_on_wechat(self):
        with self.assertRaises(ToolError):
            invoke_tool('student_get_profile', {'student_id': 1}, channel='wechat', actor_id='wx-user')
        audit = list_audits(1)[0]
        self.assertEqual(audit['status'], 'denied')

    def test_runner_uses_tool_then_saves_session(self):
        class FakeModel:
            def __init__(self):
                self.calls = 0

            async def complete(self, _messages, _tools):
                self.calls += 1
                if self.calls == 1:
                    return ModelResponse('', [ToolCall(
                        id='call-1', name='students_search', arguments='{"keyword":"张"}'
                    )])
                return ModelResponse('找到了张三。', [])

        runner = AgentRunner(model_client=FakeModel())
        answer = asyncio.run(runner.chat('test-session', '帮我找张三'))
        self.assertEqual(answer, '找到了张三。')
        self.assertEqual(len(db.load_agent_session('test-session')), 5)
        self.assertEqual(list_audits(1)[0]['tool_name'], 'students_search')

    def test_planner_resolves_student_number_before_profile(self):
        class FakeModel:
            def __init__(self):
                self.messages = None

            async def complete(self, messages, _tools):
                self.messages = messages
                return ModelResponse('已找到张三的详细信息。', [])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model).chat(
            'planned-profile-session', '查看学生 A001 的详细信息',
            channel='web', actor_id='web-user'
        ))
        self.assertEqual(answer, '已找到张三的详细信息。')
        tool_calls = next(message['tool_calls'] for message in model.messages if message.get('tool_calls'))
        self.assertEqual([call['function']['name'] for call in tool_calls], [
            'students_search', 'student_get_profile'
        ])
        profile_args = json.loads(tool_calls[1]['function']['arguments'])
        self.assertEqual(profile_args, {'student_id': 1})
        self.assertEqual([audit['tool_name'] for audit in list_audits(2)], [
            'student_get_profile', 'students_search'
        ])

    def test_planner_skips_dependent_step_when_student_is_ambiguous(self):
        class FakeModel:
            def __init__(self):
                self.messages = None

            async def complete(self, messages, _tools):
                self.messages = messages
                return ModelResponse('请提供更具体的学号或姓名。', [])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model).chat(
            'planned-ambiguous-session', '查看学生 A 的详细信息',
            channel='web', actor_id='web-user'
        ))
        self.assertEqual(answer, '请提供更具体的学号或姓名。')
        tool_calls = next(message['tool_calls'] for message in model.messages if message.get('tool_calls'))
        self.assertEqual(len(tool_calls), 1)
        self.assertEqual(tool_calls[0]['function']['name'], 'students_search')

    def test_model_can_propose_a_structured_plan(self):
        class FakeModel:
            def __init__(self):
                self.calls = 0
                self.final_messages = None

            async def complete(self, messages, _tools):
                self.calls += 1
                if self.calls == 1:
                    return ModelResponse(json.dumps({
                        'goal': '查询张三的学生信息',
                        'steps': [{
                            'id': 'search',
                            'tool': 'students_search',
                            'arguments': {'keyword': '张三'},
                        }],
                    }, ensure_ascii=False), [])
                self.final_messages = messages
                return ModelResponse('已完成学生查询。', [])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model).chat(
            'model-plan-session', '请分析一下学生数据',
            channel='web', actor_id='web-user'
        ))
        self.assertEqual(answer, '已完成学生查询。')
        self.assertEqual(model.calls, 2)
        self.assertEqual(model.final_messages[-2]['role'], 'assistant')
        self.assertEqual(model.final_messages[-2]['tool_calls'][0]['function']['name'], 'students_search')

    def test_planner_replans_once_after_invalid_arguments(self):
        class FakeModel:
            def __init__(self):
                self.calls = 0

            async def complete(self, _messages, _tools):
                self.calls += 1
                if self.calls == 1:
                    plan = {
                        'goal': '查询学生',
                        'steps': [{
                            'id': 'bad_search',
                            'tool': 'students_search',
                            'arguments': {'unsupported': True},
                        }],
                    }
                    return ModelResponse(json.dumps(plan), [])
                if self.calls == 2:
                    plan = {
                        'goal': '查询学生',
                        'steps': [{
                            'id': 'good_search',
                            'tool': 'students_search',
                            'arguments': {'keyword': '张三'},
                        }],
                    }
                    return ModelResponse(json.dumps(plan, ensure_ascii=False), [])
                return ModelResponse('已修正计划并完成查询。', [])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model).chat(
            'replan-session', '请分析一下学生数据',
            channel='web', actor_id='web-user'
        ))
        self.assertEqual(answer, '已修正计划并完成查询。')
        self.assertEqual(model.calls, 3)

    def test_runner_returns_structured_tool_error_and_can_recover(self):
        class FakeModel:
            def __init__(self):
                self.calls = 0
                self.snapshots = []

            async def complete(self, messages, _tools):
                self.calls += 1
                self.snapshots.append([dict(message) for message in messages])
                if self.calls == 1:
                    return ModelResponse('', [ToolCall(
                        id='bad-call-1', name='student_delete', arguments='{}'
                    )])
                return ModelResponse('这个工具不可用，我已经停止继续调用。', [])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model).chat(
            'error-recover-session', '帮我处理一个不存在的操作'
        ))
        self.assertEqual(answer, '这个工具不可用，我已经停止继续调用。')
        tool_message = next(
            message for message in model.snapshots[1] if message['role'] == 'tool'
        )
        error = json.loads(tool_message['content'])['error']
        self.assertEqual(error['code'], 'unknown_tool')
        self.assertTrue(error['retryable'])

    def test_runner_stops_repeated_failed_tool_calls(self):
        class FakeModel:
            def __init__(self):
                self.calls = 0

            async def complete(self, _messages, _tools):
                self.calls += 1
                return ModelResponse('', [ToolCall(
                    id=f'bad-call-{self.calls}', name='student_delete', arguments='{}'
                )])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model, max_turns=5).chat(
            'repeated-error-session', '帮我处理一个不存在的操作'
        ))
        self.assertIn('连续失败', answer)
        self.assertEqual(model.calls, 2)
        audits = list_audits(2)
        self.assertEqual(audits[0]['status'], 'retry_exhausted')
        self.assertEqual(audits[1]['status'], 'error')

    def test_invalid_tool_json_is_structured_and_audited(self):
        result = AgentRunner._call_tool(
            'students_search', '{not-json', 'web', 'web-user'
        )
        self.assertEqual(result['error']['code'], 'invalid_arguments')
        self.assertTrue(result['error']['retryable'])
        self.assertEqual(list_audits(1)[0]['status'], 'error')

    def test_execution_error_is_retried_once(self):
        calls = 0

        def flaky_invoke(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ToolError(
                    '临时失败', code='execution_error', retryable=True, auto_retry=True
                )
            return {'student_count': 2}

        with patch('app.agent.runner.invoke_tool', side_effect=flaky_invoke):
            result = AgentRunner._execute_tool_with_retry(
                'class_student_count', '{}', 'web', 'web-user', {}
            )
        self.assertEqual(result, {'student_count': 2})
        self.assertEqual(calls, 2)

    def test_runner_routes_class_count_without_model_guessing(self):
        class FakeModel:
            async def complete(self, messages, _tools):
                self.messages = messages
                return ModelResponse('当前班级共有 2 名学生。', [])

        model = FakeModel()
        answer = asyncio.run(AgentRunner(model_client=model).chat(
            'class-count-session', '我们班级有多少个学生？', channel='web', actor_id='web-user'
        ))
        self.assertEqual(answer, '当前班级共有 2 名学生。')
        self.assertEqual(list_audits(1)[0]['tool_name'], 'class_student_count')
        self.assertEqual(model.messages[-2]['role'], 'tool')

    def test_runner_streams_final_answer(self):
        class FakeStreamModel:
            async def iter_complete(self, _messages, _tools):
                yield ModelStreamEvent(content='班级共有 ')
                yield ModelStreamEvent(content='2 名学生。')
                yield ModelStreamEvent(response=ModelResponse('班级共有 2 名学生。', []))

        async def run():
            chunks = []
            runner = AgentRunner(model_client=FakeStreamModel())
            async for event in runner.chat_stream('stream-session', '请告诉我一个结果'):
                chunks.append(event['content'])
            return ''.join(chunks)

        self.assertEqual(asyncio.run(run()), '班级共有 2 名学生。')

    def test_planned_stream_emits_plan_progress_events(self):
        class FakeStreamModel:
            async def iter_complete(self, _messages, _tools):
                yield ModelStreamEvent(response=ModelResponse('已完成查询。', []))

        async def run():
            return [
                event async for event in AgentRunner(model_client=FakeStreamModel()).chat_stream(
                    'planned-stream-session', '查看学生 A001 的详细信息',
                    channel='web', actor_id='web-user'
                )
            ]

        events = asyncio.run(run())
        self.assertEqual(events[0]['type'], 'plan')
        self.assertEqual(events[1]['status'], 'running')
        self.assertEqual(events[2]['status'], 'completed')
        self.assertEqual(events[-1], {'type': 'delta', 'content': '已完成查询。'})
        history = SessionStore().load('planned-stream-session')
        self.assertEqual(history[-1], {'role': 'assistant', 'content': '已完成查询。'})

    def test_session_store_keeps_tool_messages_with_their_call(self):
        store = SessionStore(max_messages=8)
        db.save_agent_session('trim-session', [
            {'role': 'tool', 'tool_call_id': 'orphan', 'content': '{}'},
            {'role': 'system', 'content': 'system'},
            {'role': 'user', 'content': '旧问题'},
            {'role': 'assistant', 'content': None, 'tool_calls': [{
                'id': 'call-1', 'type': 'function',
                'function': {'name': 'students_search', 'arguments': '{}'},
            }]},
            {'role': 'tool', 'tool_call_id': 'call-1', 'content': '{}'},
            {'role': 'assistant', 'content': '旧回答'},
            {'role': 'user', 'content': '新问题'},
            {'role': 'assistant', 'content': '新回答'},
        ])
        messages = store.load('trim-session')
        self.assertEqual(messages[0]['role'], 'system')
        for index, message in enumerate(messages):
            if message['role'] == 'tool':
                self.assertTrue(index > 0 and messages[index - 1].get('tool_calls'))


if __name__ == '__main__':
    unittest.main()
