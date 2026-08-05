# -*- coding: utf-8 -*-
"""美美大王工作台 - FastAPI 入口"""
import os as _os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from . import db
from .config import STATIC_DIR
from .routers import sheets, students, seating, stats, knowledge, export

app = FastAPI(title='美美大王工作台', version='2.2')

for r in (sheets.router, students.router, seating.router,
          stats.router, knowledge.router, export.router):
    app.include_router(r)


@app.on_event('startup')
def startup():
    db.get_conn()


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