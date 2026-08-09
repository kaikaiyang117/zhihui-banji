# -*- coding: utf-8 -*-
"""业务日期：开发/测试可覆盖，审计和系统时间仍使用真实时钟。"""
from __future__ import annotations

import os
from datetime import date


ENV_NAME = 'WORKBENCH_BUSINESS_DATE'


def today() -> date:
    configured = os.environ.get(ENV_NAME, '').strip()
    if not configured:
        return date.today()
    try:
        return date.fromisoformat(configured)
    except ValueError as exc:
        raise RuntimeError(f'{ENV_NAME} 必须是 YYYY-MM-DD') from exc


def runtime() -> dict:
    value = today().isoformat()
    return {
        'business_date': value,
        'business_date_overridden': bool(os.environ.get(ENV_NAME, '').strip()),
        'business_date_env': ENV_NAME,
    }
