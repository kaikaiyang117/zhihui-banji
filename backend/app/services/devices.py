# -*- coding: utf-8 -*-
"""局域网设备短时配对、凭证校验和即时撤权。"""
from __future__ import annotations

from datetime import datetime, timedelta
import hashlib
import secrets
import threading

from .. import db
from . import audit


PAIRING_TTL_SECONDS = 5 * 60
DEVICE_TTL_DAYS = 90
_lock = threading.RLock()


class DeviceError(ValueError):
    pass


def is_local_host(host: str) -> bool:
    return host in {'127.0.0.1', '::1', 'localhost', 'testclient'}


def _now() -> datetime:
    return datetime.now()


def _time(value: datetime) -> str:
    return value.strftime('%Y-%m-%d %H:%M:%S')


def _hash(value: str) -> str:
    return hashlib.sha256(str(value).encode('utf-8')).hexdigest()


def create_pairing(base_url: str, *, ttl_seconds: int = PAIRING_TTL_SECONDS,
                   conn=None) -> dict:
    base_url = str(base_url or '').strip().rstrip('/')
    if not base_url:
        raise DeviceError('当前未启用局域网访问')
    conn = conn or db.get_conn()
    code = secrets.token_urlsafe(18)
    expires = _now() + timedelta(seconds=max(30, int(ttl_seconds)))
    with _lock:
        conn.execute(
            "UPDATE pairing_sessions SET status='已过期' "
            "WHERE status='待使用' AND expires_at<=?", (_time(_now()),))
        conn.execute(
            'INSERT INTO pairing_sessions(code_hash, expires_at) VALUES(?,?)',
            (_hash(code), _time(expires)),
        )
        audit.record(
            'device_pairing', '', 'create', summary='创建短时设备配对码',
            params={'expires_at': _time(expires)}, conn=conn, commit=False,
        )
        conn.commit()
    return {
        'code': code,
        'url': f'{base_url}/?pair={code}',
        'expires_at': _time(expires),
        'expires_in': max(30, int(ttl_seconds)),
    }


def claim_pairing(code: str, *, name: str = '', user_agent: str = '', ip: str = '',
                  conn=None) -> dict:
    code = str(code or '').strip()
    if not code:
        raise DeviceError('缺少配对码')
    conn = conn or db.get_conn()
    now = _now()
    with _lock:
        row = conn.execute(
            'SELECT * FROM pairing_sessions WHERE code_hash=?', (_hash(code),)
        ).fetchone()
        if not row or row['status'] != '待使用':
            raise DeviceError('配对码无效或已经使用')
        try:
            expires = datetime.strptime(row['expires_at'], '%Y-%m-%d %H:%M:%S')
        except (TypeError, ValueError) as exc:
            raise DeviceError('配对码状态异常，请重新生成') from exc
        if expires <= now:
            conn.execute("UPDATE pairing_sessions SET status='已过期' WHERE id=?", (row['id'],))
            conn.commit()
            raise DeviceError('配对码已过期，请在电脑端重新生成')

        credential = secrets.token_urlsafe(32)
        device_id = secrets.token_urlsafe(12)
        device_name = str(name or '移动设备').strip()[:80] or '移动设备'
        device_expires = now + timedelta(days=DEVICE_TTL_DAYS)
        try:
            conn.execute(
                "UPDATE pairing_sessions SET status='已使用', used_at=? WHERE id=? AND status='待使用'",
                (_time(now), row['id']),
            )
            device_row_id = conn.execute(
                '''INSERT INTO paired_devices(
                       device_id, name, credential_hash, last_seen_at, expires_at,
                       user_agent, last_ip
                   ) VALUES(?,?,?,?,?,?,?)''',
                (device_id, device_name, _hash(credential), _time(now),
                 _time(device_expires), str(user_agent or '')[:300], str(ip or '')[:80]),
            ).lastrowid
            audit.record(
                'paired_device', device_row_id, 'pair', summary=f'授权设备：{device_name}',
                params={'device_id': device_id, 'ip': ip, 'expires_at': _time(device_expires)},
                class_id=None, term_id=None, conn=conn, commit=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {
        'device_id': device_id,
        'device_token': credential,
        'name': device_name,
        'expires_at': _time(device_expires),
    }


def authenticate(credential: str, *, ip: str = '', user_agent: str = '', conn=None) -> dict | None:
    credential = str(credential or '').strip()
    if not credential:
        return None
    conn = conn or db.get_conn()
    now = _time(_now())
    with _lock:
        row = conn.execute(
            "SELECT * FROM paired_devices WHERE credential_hash=? AND status='已授权'",
            (_hash(credential),),
        ).fetchone()
        if not row:
            return None
        if str(row['expires_at']) <= now:
            conn.execute(
                "UPDATE paired_devices SET status='已过期' WHERE id=?", (row['id'],))
            conn.commit()
            return None
        conn.execute(
            'UPDATE paired_devices SET last_seen_at=?, last_ip=?, user_agent=? WHERE id=?',
            (now, str(ip or '')[:80], str(user_agent or row['user_agent'])[:300], row['id']),
        )
        conn.commit()
    return dict(row)


def list_devices(conn=None) -> list[dict]:
    conn = conn or db.get_conn()
    rows = conn.execute(
        '''SELECT id, device_id, name, status, paired_at, last_seen_at,
                  expires_at, revoked_at, user_agent, last_ip
           FROM paired_devices ORDER BY
             CASE WHEN status='已授权' THEN 0 ELSE 1 END,
             COALESCE(NULLIF(last_seen_at,''), paired_at) DESC, id DESC'''
    ).fetchall()
    return [dict(row) for row in rows]


def revoke(device_id: int, *, conn=None) -> dict:
    conn = conn or db.get_conn()
    with _lock:
        row = conn.execute('SELECT * FROM paired_devices WHERE id=?', (device_id,)).fetchone()
        if not row:
            raise DeviceError('设备不存在')
        if row['status'] != '已授权':
            return {'ok': True, 'changed': False}
        conn.execute(
            "UPDATE paired_devices SET status='已撤权', revoked_at=? WHERE id=?",
            (_time(_now()), device_id),
        )
        audit.record(
            'paired_device', device_id, 'revoke', summary=f"撤销设备：{row['name']}",
            params={'device_id': row['device_id']}, class_id=None, term_id=None,
            conn=conn, commit=False,
        )
        conn.commit()
    return {'ok': True, 'changed': True}


def revoke_all(*, conn=None) -> dict:
    conn = conn or db.get_conn()
    with _lock:
        now = _time(_now())
        cur = conn.execute(
            "UPDATE paired_devices SET status='已撤权', revoked_at=? WHERE status='已授权'",
            (now,),
        )
        audit.record(
            'paired_device', '*', 'revoke_all', summary=f'撤销全部设备：{cur.rowcount} 台',
            class_id=None, term_id=None, conn=conn, commit=False,
        )
        conn.commit()
    return {'ok': True, 'count': int(cur.rowcount)}


def revoke_credential(credential: str, *, conn=None) -> bool:
    conn = conn or db.get_conn()
    row = conn.execute(
        "SELECT id FROM paired_devices WHERE credential_hash=? AND status='已授权'",
        (_hash(credential),),
    ).fetchone()
    if not row:
        return False
    revoke(int(row['id']), conn=conn)
    return True
