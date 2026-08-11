# -*- coding: utf-8 -*-
"""MIG-00 基线 2：OpenAPI 快照与路由清单。

从 FastAPI 导出 openapi.json，并生成路由清单：
方法、路径、请求 schema、状态码、响应 schema、所属路由模块。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import BACKEND_DIR, OUT_API, write_json  # noqa: E402


def _flatten_routes(route_list):
    """新版 FastAPI/Starlette 用 _IncludedRouter 惰性包装路由，需要展开。"""
    flat = []
    for route in route_list:
        if type(route).__name__ == '_IncludedRouter':
            original = getattr(route, 'original_router', None)
            if original is not None:
                flat.extend(_flatten_routes(original.routes))
        else:
            flat.append(route)
    return flat


def main():
    sys.path.insert(0, BACKEND_DIR)
    from app import app as application

    spec = application.openapi()
    write_json(os.path.join(OUT_API, 'openapi.json'), spec)

    inventory = []
    for route in _flatten_routes(application.routes):
        module = getattr(getattr(route, 'endpoint', None), '__module__', '')
        module = module.replace('app.routers.', '').replace('app.', '')
        methods = sorted(getattr(route, 'methods', []) or [])
        path = getattr(route, 'path', '')
        if not methods or not path:
            continue
        status_codes = sorted(str(status) for status in getattr(route, 'status_codes', []) or [])
        inventory.append({
            'method': methods,
            'path': path,
            'module': module,
            'name': getattr(route, 'name', ''),
            'status_codes': status_codes,
        })
    inventory.sort(key=lambda item: (item['module'], item['path'], item['method']))
    write_json(os.path.join(OUT_API, 'routes-inventory.json'), inventory)

    summary = {}
    for item in inventory:
        summary.setdefault(item['module'], 0)
        summary[item['module']] += 1
    print('OpenAPI 快照：out/api/openapi.json')
    print(f'路由总数：{len(inventory)}')
    print('各路由模块数量：')
    for module, count in sorted(summary.items()):
        print(f'  {module}: {count}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
