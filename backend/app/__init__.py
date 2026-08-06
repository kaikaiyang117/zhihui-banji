# -*- coding: utf-8 -*-
"""美美大王工作台 - FastAPI 入口"""
import os as _os

import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from . import db
from .config import STATIC_DIR
from .routers import sheets, students, seating, stats, knowledge, export, p0, p1, system

app = FastAPI(title='美美大王工作台', version='2.2')


@app.middleware('http')
async def local_access_guard(request: Request, call_next):
    """局域网模式保护数据接口；本机模式默认不需要令牌。"""
    token = os.environ.get('WORKBENCH_ACCESS_TOKEN', '')
    protected = request.url.path.startswith('/api/') or request.url.path in ('/api', '/docs', '/redoc', '/openapi.json')
    if token and protected and request.headers.get('x-workbench-token') != token:
        return JSONResponse({'detail': '局域网访问需要使用启动时生成的访问地址'}, status_code=401)
    return await call_next(request)

for r in (sheets.router, students.router, seating.router,
          stats.router, knowledge.router, export.router, p0.router, p1.router, system.router):
    app.include_router(r)


@app.on_event('startup')
def startup():
    db.get_conn()
    p0.migrate_legacy_core_rows()


@app.on_event('shutdown')
def shutdown():
    db.close()


# 前端静态资源
_STATIC = STATIC_DIR
_ASSETS = _os.path.join(_STATIC, 'assets')
if _os.path.isdir(_ASSETS):
    app.mount('/assets', StaticFiles(directory=_ASSETS), name='assets')


@app.get('/')
def index():
    idx = _os.path.join(_STATIC, 'index.html')
    if _os.path.isfile(idx):
        return FileResponse(idx)
    return {'msg': '后端已就绪，请先构建前端 (frontend → npm run build)'}
