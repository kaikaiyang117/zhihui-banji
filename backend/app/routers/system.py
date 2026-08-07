# -*- coding: utf-8 -*-
"""本地数据安全：SQLite 一键备份与恢复。"""
from __future__ import annotations

import hashlib
import json
import os
import platform
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import db
from ..config import APP_VERSION, IS_FROZEN, RESOURCE_ROOT, UPDATE_API_URL, UPDATE_MANIFEST_URL
from ..services import devices

router = APIRouter(prefix='/api/system')

_update_lock = threading.Lock()
_update_state = {
    'status': 'idle',
    'message': '',
    'error': '',
    'asset_name': '',
}


@router.get('/access-info')
def access_info(request: Request):
    """返回局域网配对状态；只有本机可以生成和管理授权。"""
    base_url = os.environ.get('WORKBENCH_LAN_URL_BASE', '')
    host = request.client.host if request.client else ''
    return {
        'enabled': bool(base_url),
        'can_manage': devices.is_local_host(host),
        'paired_device_count': sum(
            1 for item in devices.list_devices() if item['status'] == '已授权'),
        'message': '请在电脑端生成短时配对二维码。' if base_url else '',
    }


class PairingClaimBody(BaseModel):
    code: str
    name: str = '移动设备'


def _require_local(request: Request):
    host = request.client.host if request.client else ''
    if not devices.is_local_host(host):
        raise HTTPException(403, '设备授权只能在工作台本机管理')


@router.post('/pairing/start')
def start_pairing(request: Request):
    _require_local(request)
    try:
        return devices.create_pairing(os.environ.get('WORKBENCH_LAN_URL_BASE', ''))
    except devices.DeviceError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post('/pairing/claim')
def claim_pairing(body: PairingClaimBody, request: Request, response: Response):
    try:
        result = devices.claim_pairing(
            body.code, name=body.name,
            user_agent=request.headers.get('user-agent', ''),
            ip=request.client.host if request.client else '',
        )
    except devices.DeviceError as exc:
        raise HTTPException(400, str(exc)) from exc
    credential = result.pop('device_token')
    response.set_cookie(
        'workbench_device', credential, max_age=devices.DEVICE_TTL_DAYS * 86400,
        httponly=True, samesite='lax', secure=False,
    )
    return result


@router.get('/devices')
def paired_devices(request: Request):
    _require_local(request)
    return {'devices': devices.list_devices()}


@router.delete('/devices/{device_id}')
def revoke_device(device_id: int, request: Request):
    _require_local(request)
    try:
        return devices.revoke(device_id)
    except devices.DeviceError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post('/devices/revoke-all')
def revoke_all_devices(request: Request):
    _require_local(request)
    return devices.revoke_all()


@router.post('/devices/logout')
def logout_device(request: Request, response: Response):
    credential = (
        request.headers.get('x-workbench-device')
        or request.cookies.get('workbench_device')
        or request.query_params.get('device_token')
        or ''
    )
    devices.revoke_credential(credential)
    response.delete_cookie('workbench_device')
    return {'ok': True}


def _fetch_json(url: str):
    request = urllib.request.Request(url, headers={
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'MeimeiWorkbench-Updater',
    })
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.loads(response.read().decode('utf-8'))


def _version_key(version: str):
    numbers = [int(item) for item in re.findall(r'\d+', version or '')]
    return tuple((numbers + [0, 0, 0])[:3])


def _fetch_release():
    """优先使用 GitHub API，遇到限流或网络错误时回退到 Release manifest。"""
    try:
        return _fetch_json(UPDATE_API_URL)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as primary_error:
        try:
            return _fetch_json(UPDATE_MANIFEST_URL)
        except Exception:
            raise primary_error


def _platform_asset(assets):
    if sys.platform == 'win32':
        marker = 'Setup-Windows-x64.exe'
    elif sys.platform == 'darwin':
        arch = platform.machine().lower()
        marker = f'macOS-{"arm64" if arch in ("arm64", "aarch64") else "x86_64"}.dmg'
    else:
        return None
    return next((asset for asset in assets if asset.get('name', '').endswith(marker)), None)


def _checksum_for(checksum_text: str, filename: str) -> str:
    for line in checksum_text.splitlines():
        fields = line.strip().split()
        if len(fields) >= 2 and os.path.basename(fields[-1].lstrip('*')) == filename:
            return fields[0].lower()
    return ''


def check_for_update():
    """读取最新 GitHub Release，并选择当前系统对应的安装包。"""
    release = _fetch_release()
    latest_version = str(release.get('tag_name', '')).lstrip('v')
    assets = release.get('assets') or []
    asset = _platform_asset(assets)
    checksum_asset = next(
        (item for item in assets if item.get('name', '').upper() == 'SHA256SUMS.TXT'),
        None,
    )
    checksum = str(asset.get('sha256', '')).lower() if asset else ''
    if asset and checksum_asset:
        request = urllib.request.Request(
            checksum_asset.get('browser_download_url', ''),
            headers={'User-Agent': 'MeimeiWorkbench-Updater'},
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            checksum = _checksum_for(response.read().decode('utf-8'), asset.get('name', ''))

    return {
        'current_version': APP_VERSION,
        'latest_version': latest_version,
        'update_available': _version_key(latest_version) > _version_key(APP_VERSION),
        'release_url': release.get('html_url', ''),
        'release_notes': release.get('body') or '',
        'asset': {
            'name': asset.get('name', '') if asset else '',
            'url': asset.get('browser_download_url', '') if asset else '',
            'size': asset.get('size', 0) if asset else 0,
            'sha256': checksum,
        },
        'downloadable': bool(asset and checksum),
    }


@router.get('/update/check')
def update_check():
    try:
        return check_for_update()
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as exc:
        return {
            'current_version': APP_VERSION,
            'latest_version': '',
            'update_available': False,
            'downloadable': False,
            'error': f'暂时无法检查更新：{exc}',
        }


def _set_update_state(status: str, message: str = '', error: str = '', asset_name: str = ''):
    with _update_lock:
        _update_state.update({
            'status': status,
            'message': message,
            'error': error,
            'asset_name': asset_name,
        })


@router.get('/update/status')
def update_status():
    with _update_lock:
        return dict(_update_state)


def _download_asset(url: str, destination: str):
    request = urllib.request.Request(url, headers={'User-Agent': 'MeimeiWorkbench-Updater'})
    temporary = f'{destination}.download'
    try:
        with urllib.request.urlopen(request, timeout=30) as response, open(temporary, 'wb') as output:
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                output.write(block)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def _launch_installer(path: str):
    if sys.platform == 'win32':
        subprocess.Popen([path], cwd=os.path.dirname(path), close_fds=True)
    elif sys.platform == 'darwin':
        executable = Path(os.path.realpath(sys.executable))
        app_path = ''
        for parent in [executable, *executable.parents]:
            if parent.name.endswith('.app'):
                app_path = str(parent)
                break
        if not app_path:
            raise RuntimeError('无法定位当前 macOS 应用目录')
        helper = os.path.join(RESOURCE_ROOT, 'updater', 'macos-updater.sh')
        if not os.path.isfile(helper):
            raise RuntimeError('缺少 macOS 更新助手')
        update_dir = os.path.join(db.DATA_DIR, 'updates')
        subprocess.Popen(
            ['/bin/sh', helper, path, app_path, str(os.environ.get('WORKBENCH_PORT', '5000')), update_dir],
            close_fds=True,
            start_new_session=True,
        )
    else:
        raise RuntimeError('当前系统暂不支持桌面安装包自动更新')


def _install_update_worker():
    try:
        _set_update_state('checking', '正在检查最新版本…')
        info = check_for_update()
        if not info['update_available']:
            _set_update_state('up_to_date', '当前已经是最新版本')
            return
        if not info['downloadable']:
            raise RuntimeError('找不到当前系统的安装包或 SHA-256 校验文件')

        asset = info['asset']
        update_dir = os.path.join(db.DATA_DIR, 'updates')
        os.makedirs(update_dir, exist_ok=True)
        installer_path = os.path.join(update_dir, os.path.basename(asset['name']))
        _set_update_state('backing_up', '正在创建升级前数据库备份…', asset_name=asset['name'])
        backup_name = db.create_backup('pre-update')
        _set_update_state(
            'downloading',
            f'备份已完成（{backup_name}），正在下载更新…',
            asset_name=asset['name'],
        )
        _download_asset(asset['url'], installer_path)

        _set_update_state('verifying', '正在校验安装包…', asset_name=asset['name'])
        digest = hashlib.sha256()
        with open(installer_path, 'rb') as package:
            for block in iter(lambda: package.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest().lower() != asset['sha256'].lower():
            os.remove(installer_path)
            raise RuntimeError('安装包 SHA-256 校验失败，已删除下载文件')

        _set_update_state('installing', '校验通过，正在启动安装程序…', asset_name=asset['name'])
        _launch_installer(installer_path)
        time.sleep(0.8)
        os._exit(0)
    except Exception as exc:
        _set_update_state('error', error=str(exc))


@router.post('/update/install')
def install_update():
    if not IS_FROZEN:
        raise HTTPException(400, '开发模式不执行安装，请使用打包后的桌面程序测试更新')
    with _update_lock:
        if _update_state['status'] in ('checking', 'downloading', 'verifying', 'installing'):
            return {'started': False, 'status': _update_state['status']}
        _update_state.update({'status': 'starting', 'message': '准备更新…', 'error': '', 'asset_name': ''})
    threading.Thread(target=_install_update_worker, name='workbench-updater', daemon=True).start()
    return {'started': True, 'status': 'starting'}


def _backup_dir() -> str:
    return db.backup_dir()


def _safe_backup(name: str) -> str:
    clean = os.path.basename(name)
    if not clean.endswith('.db') or clean != name:
        raise HTTPException(400, '备份文件名不合法')
    path = os.path.abspath(os.path.join(_backup_dir(), clean))
    if os.path.dirname(path) != os.path.abspath(_backup_dir()):
        raise HTTPException(400, '备份文件路径不合法')
    if not os.path.isfile(path):
        raise HTTPException(404, '备份文件不存在')
    return path


def _make_backup() -> str:
    return db.create_backup('manual')


@router.post('/backup')
def create_backup():
    filename = _make_backup()
    return {'ok': True, 'filename': filename}


@router.get('/backups')
def list_backups():
    if not os.path.isdir(_backup_dir()):
        return {'backups': []}
    backups = []
    for filename in os.listdir(_backup_dir()):
        if not filename.endswith('.db'):
            continue
        path = os.path.join(_backup_dir(), filename)
        backups.append({'filename': filename, 'size': os.path.getsize(path), 'modified': os.path.getmtime(path)})
    backups.sort(key=lambda x: x['modified'], reverse=True)
    return {'backups': backups}


@router.get('/backup/{filename}')
def download_backup(filename: str):
    return FileResponse(_safe_backup(filename), filename=filename, media_type='application/octet-stream')


@router.post('/restore')
async def restore_backup(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(400, '备份文件为空')
    check = sqlite3.connect(':memory:')
    try:
        check.deserialize(data)
        integrity = check.execute('PRAGMA integrity_check').fetchone()[0]
        if integrity != 'ok':
            raise HTTPException(400, '备份文件完整性检查失败')
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f'无法读取备份文件：{exc}')
    finally:
        check.close()

    os.makedirs(_backup_dir(), exist_ok=True)
    pre_restore = _make_backup()
    temp_path = os.path.join(_backup_dir(), '.restore-upload.db')
    with open(temp_path, 'wb') as f:
        f.write(data)
    db.close()
    os.replace(temp_path, db.DB_PATH)
    db.get_conn()
    return {'ok': True, 'pre_restore_backup': pre_restore}
