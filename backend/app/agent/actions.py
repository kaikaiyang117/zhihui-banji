# -*- coding: utf-8 -*-
"""Agent 写入预览、确认、幂等和恢复边界。"""
from __future__ import annotations

from datetime import datetime, timedelta
import hashlib
import hmac
import json
import re
import secrets
import threading

from .. import db
from ..services import attendance, audit, class_context, communications, points, work_items


ACTION_TTL_MINUTES = 10
WRITE_TOOLS = {
    'create_task': '创建待办',
    'record_communication': '记录家校沟通',
    'save_attendance': '保存考勤',
    'record_points': '记录行为积分',
}
WRITE_FIELDS = {
    'create_task': ({'title'}, {'title', 'student_id', 'owner', 'scheduled_at', 'due_at', 'priority', 'notes'}),
    'record_communication': ({'student_id', 'communicated_at', 'method', 'reason', 'summary'},
                             {'student_id', 'communicated_at', 'method', 'reason', 'summary', 'feedback', 'agreement', 'followup_at', 'status', 'event_id'}),
    'save_attendance': ({'student_id', 'date', 'status'}, {'student_id', 'date', 'scene', 'status', 'reason', 'arrive', 'leave', 'note'}),
    'record_points': ({'student_id', 'amount', 'reason'}, {'student_id', 'amount', 'occurred_at', 'category', 'reason'}),
}
_lock = threading.RLock()


class ActionError(ValueError):
    pass


def is_write_tool(name: str) -> bool:
    return name in WRITE_TOOLS


def allowed(channel: str, tool_name: str) -> bool:
    # 四个首批操作都是单条低风险写入；微信不注册删除、批量和敏感档案写工具。
    return tool_name in WRITE_TOOLS and channel in {'web', 'wechat', 'local', 'lan'}


def _now():
    return datetime.now()


def _stamp(value: datetime):
    return value.strftime('%Y-%m-%d %H:%M:%S')


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _canonical(arguments: dict) -> tuple[str, str]:
    raw = json.dumps(arguments, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return raw, _hash(raw)


def _token_hash(token: str, arguments_hash: str) -> str:
    return _hash(f'{token}:{arguments_hash}')


def _expire(conn):
    now = _stamp(_now())
    conn.execute(
        "UPDATE agent_actions SET status='expired' WHERE status='pending' AND expires_at<?",
        (now,),
    )


def _preview_text(tool_name: str, arguments: dict) -> str:
    label = WRITE_TOOLS[tool_name]
    if tool_name == 'create_task':
        target = f"学生 {arguments.get('student_id')}" if arguments.get('student_id') else '班级'
        detail = f"{target}创建待办“{arguments.get('title', '')}”"
    elif tool_name == 'record_communication':
        detail = f"为学生 {arguments.get('student_id')} 记录{arguments.get('method', '沟通')}沟通"
    elif tool_name == 'save_attendance':
        detail = f"记录 {arguments.get('date', '')} {arguments.get('scene', '常规到校')} 的学生 {arguments.get('student_id')} 为“{arguments.get('status', '')}”"
    else:
        detail = f"为学生 {arguments.get('student_id')} 记录 {arguments.get('amount')} 分行为积分"
    return f'将要{detail}。这是一次{label}，回复“确认”执行，回复“取消”放弃。确认有效期 {ACTION_TTL_MINUTES} 分钟。'


def _validate_arguments(tool_name: str, arguments: dict):
    required, allowed_fields = WRITE_FIELDS[tool_name]
    unknown = sorted(set(arguments) - allowed_fields)
    if unknown:
        raise ActionError(f'工具参数不支持：{", ".join(unknown)}')
    missing = sorted(required - set(arguments))
    if missing:
        raise ActionError(f'缺少工具参数：{", ".join(missing)}')
    for key in ('student_id', 'event_id'):
        if key in arguments and arguments[key] is not None:
            try:
                if int(arguments[key]) < 1:
                    raise ValueError
            except (TypeError, ValueError) as exc:
                raise ActionError(f'{key}必须是正整数') from exc
    if tool_name == 'record_points':
        try:
            if float(arguments['amount']) == 0:
                raise ValueError
        except (TypeError, ValueError) as exc:
            raise ActionError('积分分值必须是非零数字') from exc


def create_pending(*, tool_name: str, arguments: dict, session_id: str,
                   channel: str, actor_id: str, conn=None) -> dict:
    if not is_write_tool(tool_name):
        raise ActionError('不是可确认的写入工具')
    if not allowed(channel, tool_name):
        raise ActionError('当前渠道没有该操作权限')
    if not session_id:
        raise ActionError('写入操作缺少会话身份')
    if not isinstance(arguments, dict):
        raise ActionError('写入参数必须是对象')
    _validate_arguments(tool_name, arguments)
    conn = conn or db.get_conn()
    class_id, term_id = class_context.scope_ids(write=True, conn=conn)
    raw, args_hash = _canonical(arguments)
    with _lock:
        _expire(conn)
        existing = conn.execute(
            '''SELECT * FROM agent_actions
               WHERE session_id=? AND actor_id=? AND arguments_hash=? AND status='pending'
               ORDER BY id DESC LIMIT 1''', (session_id, actor_id, args_hash)
        ).fetchone()
        if existing:
            item = dict(existing)
            item['confirmation_required'] = True
            item['action_id'] = item['id']
            return item
        token = secrets.token_hex(3).upper()
        expires_at = _stamp(_now() + timedelta(minutes=ACTION_TTL_MINUTES))
        preview = _preview_text(tool_name, arguments)
        row = conn.execute(
            '''INSERT INTO agent_actions(
                   class_id, term_id, session_id, channel, actor_id, tool_name,
                   arguments_json, arguments_hash, confirmation_hash, preview, expires_at
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING *''',
            (class_id, term_id, session_id, channel, actor_id, tool_name, raw,
             args_hash, _token_hash(token, args_hash), preview, expires_at),
        ).fetchone()
        conn.commit()
    item = dict(row)
    item['confirmation_required'] = True
    item['action_id'] = item['id']
    # token 只作为接口调试/网页显式确认选项返回，不进入持久化明文。
    item['confirmation_token'] = token
    audit.record(
        'agent_action', item['id'], 'preview', status='success', summary=preview,
        params={'tool_name': tool_name, 'arguments': arguments},
        class_id=class_id, term_id=term_id, conn=conn,
    )
    return item


def _get_pending(action_id: int, *, session_id: str, actor_id: str, conn):
    class_id, term_id = class_context.scope_ids(conn=conn)
    row = conn.execute(
        '''SELECT * FROM agent_actions
           WHERE id=? AND class_id=? AND term_id=? AND session_id=? AND actor_id=?''',
        (int(action_id), class_id, term_id, session_id, actor_id),
    ).fetchone()
    if not row:
        raise ActionError('待确认操作不存在或不属于当前会话')
    return dict(row), class_id, term_id


def _mark_expired(item, conn):
    if item['status'] == 'pending' and item['expires_at'] < _stamp(_now()):
        conn.execute("UPDATE agent_actions SET status='expired' WHERE id=?", (item['id'],))
        conn.commit()
        item['status'] = 'expired'
    return item


def pending_for_session(session_id: str, actor_id: str, conn=None) -> dict | None:
    conn = conn or db.get_conn()
    _expire(conn)
    row = conn.execute(
        '''SELECT * FROM agent_actions
           WHERE session_id=? AND actor_id=? AND status='pending'
           ORDER BY id DESC LIMIT 1''', (session_id, actor_id)
    ).fetchone()
    return dict(row) if row else None


def confirm(action_id: int, *, session_id: str, actor_id: str, token: str = '', conn=None) -> dict:
    conn = conn or db.get_conn()
    with _lock:
        item, class_id, term_id = _get_pending(action_id, session_id=session_id, actor_id=actor_id, conn=conn)
        item = _mark_expired(item, conn)
        if item['status'] != 'pending':
            if item['status'] == 'executed':
                item['result'] = json.loads(item.get('result_json') or '{}')
                item['duplicate'] = True
                return item
            raise ActionError('该操作已失效，请重新发起')
        if token and not hmac.compare_digest(_token_hash(token.strip().upper(), item['arguments_hash']), item['confirmation_hash']):
            raise ActionError('确认码不正确，实际参数未被执行')
        conn.execute(
            "UPDATE agent_actions SET status='confirmed', confirmed_at=? WHERE id=? AND status='pending'",
            (_stamp(_now()), item['id']),
        )
        conn.commit()
    return execute_confirmed(item['id'], session_id=session_id, actor_id=actor_id, conn=conn)


def cancel(action_id: int, *, session_id: str, actor_id: str, conn=None) -> dict:
    conn = conn or db.get_conn()
    item, class_id, term_id = _get_pending(action_id, session_id=session_id, actor_id=actor_id, conn=conn)
    if item['status'] == 'pending':
        conn.execute("UPDATE agent_actions SET status='cancelled' WHERE id=?", (item['id'],))
        conn.commit()
    return {'id': item['id'], 'status': 'cancelled'}


def _args(item):
    try:
        return json.loads(item['arguments_json'] or '{}')
    except (TypeError, ValueError) as exc:
        raise ActionError('待确认参数损坏，未执行写入') from exc


def _execute_operation(tool_name: str, args: dict, action_id: int, conn):
    _validate_arguments(tool_name, args)
    source_key = f'agent_action:{action_id}'
    if tool_name == 'create_task':
        result = work_items.create_work_item(
            title=args['title'], student_id=args.get('student_id'),
            source_type='agent_action', source_id=action_id,
            source_label='Agent 创建待办', owner=args.get('owner', '班主任'),
            priority=args.get('priority', '普通'), scheduled_at=args.get('scheduled_at', ''),
            due_at=args.get('due_at', ''), notes=args.get('notes', ''), conn=conn)
        return {'task_id': result['id'], 'created': result.get('created', True)}
    if tool_name == 'record_communication':
        return communications.create_record(**args, source_type='agent_action', source_id=str(action_id), source_key=source_key, conn=conn)
    if tool_name == 'save_attendance':
        result = attendance.save_daily(
            args['date'], args.get('scene', '常规到校'),
            [{'student_id': args['student_id'], 'status': args['status'], 'reason': args.get('reason', ''),
              'arrive': args.get('arrive', ''), 'leave': args.get('leave', ''), 'note': args.get('note', '')}],
            conn=conn)
        return result
    if tool_name == 'record_points':
        return points.create_entry(
            student_id=args['student_id'], amount=args['amount'], occurred_at=args.get('occurred_at', ''),
            category=args.get('category', '日常行为'), reason=args['reason'],
            source_type='agent_action', source_id=str(action_id), source_key=source_key, conn=conn)
    raise ActionError('写入工具不存在')


def execute_confirmed(action_id: int, *, session_id: str, actor_id: str, conn=None) -> dict:
    conn = conn or db.get_conn()
    with _lock:
        item, class_id, term_id = _get_pending(action_id, session_id=session_id, actor_id=actor_id, conn=conn)
        if item['status'] == 'executed':
            result = json.loads(item.get('result_json') or '{}')
            return {'id': item['id'], 'status': 'executed', 'result': result, 'duplicate': True}
        if item['status'] != 'confirmed':
            raise ActionError('操作尚未确认或已失效')
        backup_file = db.create_backup(f'agent-action-{item["id"]}')
        args = _args(item)
        try:
            result = _execute_operation(item['tool_name'], args, item['id'], conn)
            conn.execute(
                "UPDATE agent_actions SET status='executed', backup_file=?, result_json=?, executed_at=? WHERE id=?",
                (backup_file, json.dumps(result, ensure_ascii=False), _stamp(_now()), item['id']),
            )
            conn.commit()
        except Exception as exc:
            conn.rollback()
            conn.execute(
                "UPDATE agent_actions SET status='failed', backup_file=?, result_json=?, executed_at=? WHERE id=?",
                (backup_file, json.dumps({'error': str(exc)}, ensure_ascii=False), _stamp(_now()), item['id']),
            )
            conn.commit()
            raise ActionError(f'写入失败，已保留备份：{exc}') from exc
    return {'id': item['id'], 'status': 'executed', 'result': result, 'backup_file': backup_file, 'duplicate': False}


def handle_confirmation(text: str, *, session_id: str, actor_id: str, channel: str, conn=None):
    """处理聊天中的确认/取消；返回 (是否拦截, 用户可见回答)。"""
    conn = conn or db.get_conn()
    pending = pending_for_session(session_id, actor_id, conn=conn)
    if not pending:
        return False, ''
    normalized = re.sub(r'\s+', '', str(text or '').strip().lower())
    if normalized in {'确认', '确认执行', '执行', 'yes', 'y'} or normalized.startswith('确认'):
        try:
            result = confirm(pending['id'], session_id=session_id, actor_id=actor_id, conn=conn)
            return True, _success_message(pending['tool_name'], result)
        except ActionError as exc:
            return True, f'凯凯小兵没有执行这次操作：{exc}'
    if normalized in {'取消', '取消执行', '不要', 'no', 'n'} or normalized.startswith('取消'):
        cancel(pending['id'], session_id=session_id, actor_id=actor_id, conn=conn)
        return True, '已取消这次待确认操作，没有修改业务数据。'
    return True, f'{pending["preview"]} 请先回复“确认”或“取消”。'


def _success_message(tool_name: str, result: dict) -> str:
    labels = {
        'create_task': '待办已创建',
        'record_communication': '家校沟通已记录',
        'save_attendance': '考勤已保存',
        'record_points': '行为积分已记录',
    }
    return f'{labels.get(tool_name, "操作已完成")}。操作编号：{result.get("id", "")}'
