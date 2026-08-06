# -*- coding: utf-8 -*-
"""微信 Agent 的本地连接策略配置。"""
from __future__ import annotations

import json
import os
import tempfile
from typing import Any

from .. import db


CONFIG_FILENAME = 'wechat-config.json'


def config_path() -> str:
    return os.path.join(db.DATA_DIR, CONFIG_FILENAME)


def load_config() -> dict[str, Any]:
    value: dict[str, Any] = {}
    try:
        with open(config_path(), encoding='utf-8') as handle:
            loaded = json.load(handle)
        if isinstance(loaded, dict):
            value = loaded
    except (OSError, ValueError, TypeError):
        pass

    raw_env = os.environ.get('MEIMEI_WECHAT_ALLOW_USERS', '')
    if raw_env.strip():
        value['allow_users'] = _parse_users(raw_env)
        value['allow_all'] = False
        value['source'] = 'environment'
    else:
        value['allow_users'] = _parse_users(value.get('allow_users'))
        value['allow_all'] = bool(value.get('allow_all', False))
        value['source'] = 'local'
    return value


def save_config(allow_users: list[str], allow_all: bool) -> dict[str, Any]:
    values = {
        'allow_users': _parse_users(allow_users),
        'allow_all': bool(allow_all),
    }
    os.makedirs(db.DATA_DIR, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix='.wechat-config-', suffix='.tmp', dir=db.DATA_DIR)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(values, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
        try:
            os.chmod(temp_path, 0o600)
        except OSError:
            pass
        os.replace(temp_path, config_path())
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
    return load_config()


def public_config() -> dict[str, Any]:
    values = load_config()
    return {
        'allow_all': values['allow_all'],
        'allow_users': values['allow_users'],
        'source': values['source'],
    }


def _parse_users(value: Any) -> list[str]:
    if isinstance(value, str):
        items = value.split(',')
    elif isinstance(value, (list, tuple, set)):
        items = value
    else:
        items = []
    result = []
    for item in items:
        user_id = str(item).strip()
        if user_id and user_id not in result:
            result.append(user_id)
    return result[:200]
