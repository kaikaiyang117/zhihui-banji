# -*- coding: utf-8 -*-
"""本地模型配置文件读写。

配置位于 DATA_DIR，不进入 Git；API Key 不会通过接口返回。
"""
from __future__ import annotations

import json
import os
import tempfile
from typing import Any

from ..config import DATA_DIR


MODEL_CONFIG_PATH = os.path.join(DATA_DIR, 'agent-model.json')


def load_local_config() -> dict[str, Any]:
    try:
        with open(MODEL_CONFIG_PATH, encoding='utf-8') as handle:
            value = json.load(handle)
    except (OSError, ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def save_local_config(values: dict[str, Any]):
    os.makedirs(DATA_DIR, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix='.agent-model-', suffix='.tmp', dir=DATA_DIR)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(values, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
        try:
            os.chmod(temp_path, 0o600)
        except OSError:
            pass
        os.replace(temp_path, MODEL_CONFIG_PATH)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def public_config(values: dict[str, Any]) -> dict[str, Any]:
    api_key = str(values.get('api_key') or '')
    return {
        'api_key_set': bool(api_key),
        'api_key_masked': _mask(api_key),
        'base_url': str(values.get('base_url') or ''),
        'model': str(values.get('model') or ''),
        'thinking': str(values.get('thinking') or 'disabled'),
    }


def _mask(value: str) -> str:
    if not value:
        return ''
    if len(value) <= 8:
        return '••••••••'
    return f'{value[:3]}…{value[-4:]}'
