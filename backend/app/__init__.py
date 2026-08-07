# -*- coding: utf-8 -*-
"""美美大王工作台 - FastAPI 入口"""
import os as _os

import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from . import db
from .config import APP_VERSION, STATIC_DIR
from .routers import sheets, students, seating, stats, knowledge, export, points as points_router, funds as funds_router, p0, p1, system, agent, wechat, context, workflow, recycle
from .services.class_context import bind_request_scope, reset_request_scope, ScopeError, ArchivedScopeError
from .services import attendance, audit, funds as funds_service, points as points_service, scores
from .services.audit import bind_actor, reset_actor
from .services import devices
from .wechat.service import wechat_service

app = FastAPI(title='美美大王工作台', version=APP_VERSION)


@app.middleware('http')
async def local_access_guard(request: Request, call_next):
    """本机免配对；局域网设备使用可撤权凭证访问数据接口。"""
    protected = request.url.path.startswith('/api/') or request.url.path in ('/api', '/docs', '/redoc', '/openapi.json')
    host = request.client.host if request.client else ''
    local_request = devices.is_local_host(host)
    lan_enabled = bool(os.environ.get('WORKBENCH_LAN_URL_BASE', ''))
    pairing_claim = request.url.path == '/api/system/pairing/claim'
    authenticated_device = None
    if lan_enabled and protected and not local_request and not pairing_claim:
        credential = (
            request.headers.get('x-workbench-device')
            or request.query_params.get('device_token')
            or request.cookies.get('workbench_device')
        )
        authenticated_device = devices.authenticate(
            credential or '', ip=host, user_agent=request.headers.get('user-agent', ''))
        if not authenticated_device:
            return JSONResponse(
                {'detail': '此设备尚未配对、授权已过期或已被撤销，请在电脑端重新生成二维码'},
                status_code=401,
            )
        request.state.workbench_device = authenticated_device
    try:
        scope_token = bind_request_scope(
            request.headers.get('x-workbench-class') or request.query_params.get('class_id'),
            request.headers.get('x-workbench-term') or request.query_params.get('term_id'),
        )
    except ScopeError as exc:
        return JSONResponse({'detail': str(exc)}, status_code=400)
    if authenticated_device:
        actor_channel = 'lan'
        actor_id = f"{authenticated_device['name']}:{authenticated_device['device_id']}"
    elif pairing_claim and not local_request:
        actor_channel, actor_id = 'pairing', host or 'unknown-device'
    else:
        actor_channel = request.headers.get('x-workbench-channel') or 'web'
        actor_id = request.headers.get('x-workbench-actor') or 'local-user'
    actor_token = bind_actor(actor_channel, actor_id)
    audit_token = audit.begin_request()
    try:
        response = await call_next(request)
        mutating = request.method in {'POST', 'PUT', 'PATCH', 'DELETE'}
        separate_channel = request.url.path.startswith(('/api/agent', '/api/wechat'))
        if mutating and request.url.path.startswith('/api/') and not separate_channel and not audit.has_recorded():
            audit.record(
                'api_request', request.url.path, request.method.lower(),
                status='success' if response.status_code < 400 else 'failed',
                summary=f'{request.method} {request.url.path}',
                params={'query': dict(request.query_params), 'status_code': response.status_code},
            )
        return response
    finally:
        audit.reset_request(audit_token)
        reset_actor(actor_token)
        reset_request_scope(scope_token)


@app.exception_handler(ScopeError)
async def scope_error_handler(_request: Request, exc: ScopeError):
    status = 409 if isinstance(exc, ArchivedScopeError) else 400
    return JSONResponse({'detail': str(exc)}, status_code=status)

for r in (sheets.router, students.router, seating.router,
          stats.router, knowledge.router, export.router, points_router.router, funds_router.router, p0.router, p1.router, system.router,
          agent.router, wechat.router, context.router, workflow.router, recycle.router):
    app.include_router(r)


@app.on_event('startup')
async def startup():
    db.get_conn()
    p0.migrate_legacy_core_rows()
    try:
        attendance.evaluate_startup()
    except Exception:
        # 失败会写入规则执行历史；不能阻止用户进入工作台修复规则或数据。
        pass
    try:
        scores.evaluate_startup()
    except Exception:
        # 与考勤规则一致：失败保留执行记录，但不阻塞工作台启动。
        pass
    try:
        points_service.evaluate_startup()
    except Exception:
        # 积分规则失败不能阻塞工作台启动，教师可在行为积分页手动重试。
        pass
    try:
        funds_service.evaluate_startup()
    except Exception:
        # 班费旧数据迁移失败不能阻塞工作台启动，页面会展示可修复的迁移错误。
        pass
    os.makedirs(db.DATA_DIR, exist_ok=True)
    with open(os.path.join(db.DATA_DIR, '.workbench-ready'), 'w', encoding='utf-8') as marker:
        marker.write(str(os.getpid()))
    if os.environ.get('MEIMEI_WECHAT_ENABLED', '').lower() in {'1', 'true', 'yes'}:
        try:
            await wechat_service.start_loop()
        except Exception:
            # 未配置凭证时仍允许工作台正常启动，用户可从接口完成扫码。
            pass


@app.on_event('shutdown')
async def shutdown():
    await wechat_service.stop()
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


@app.get('/favicon.svg', include_in_schema=False)
def favicon():
    icon = _os.path.join(_STATIC, 'favicon.svg')
    if _os.path.isfile(icon):
        return FileResponse(icon, media_type='image/svg+xml')
    return JSONResponse({'detail': 'favicon not found'}, status_code=404)
