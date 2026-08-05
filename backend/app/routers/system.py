# -*- coding: utf-8 -*-
"""本地数据安全：SQLite 一键备份与恢复。"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import db
from ..config import DATA_DIR, DB_PATH

router = APIRouter(prefix='/api/system')
BACKUP_DIR = os.path.join(DATA_DIR, 'backups')


def _safe_backup(name: str) -> str:
    clean = os.path.basename(name)
    if not clean.endswith('.db') or clean != name:
        raise HTTPException(400, '备份文件名不合法')
    path = os.path.abspath(os.path.join(BACKUP_DIR, clean))
    if os.path.dirname(path) != os.path.abspath(BACKUP_DIR):
        raise HTTPException(400, '备份文件路径不合法')
    if not os.path.isfile(path):
        raise HTTPException(404, '备份文件不存在')
    return path


def _make_backup() -> str:
    os.makedirs(BACKUP_DIR, exist_ok=True)
    filename = f'workbench-{datetime.now().strftime("%Y%m%d-%H%M%S")}.db'
    path = os.path.join(BACKUP_DIR, filename)
    source = db.get_conn()
    target = sqlite3.connect(path)
    try:
        source.backup(target)
    finally:
        target.close()
    return filename


@router.post('/backup')
def create_backup():
    filename = _make_backup()
    return {'ok': True, 'filename': filename}


@router.get('/backups')
def list_backups():
    if not os.path.isdir(BACKUP_DIR):
        return {'backups': []}
    backups = []
    for filename in os.listdir(BACKUP_DIR):
        if not filename.endswith('.db'):
            continue
        path = os.path.join(BACKUP_DIR, filename)
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

    os.makedirs(BACKUP_DIR, exist_ok=True)
    pre_restore = _make_backup()
    temp_path = os.path.join(BACKUP_DIR, f'.restore-{datetime.now().strftime("%Y%m%d-%H%M%S")}.db')
    with open(temp_path, 'wb') as f:
        f.write(data)
    db.close()
    os.replace(temp_path, DB_PATH)
    db.get_conn()
    return {'ok': True, 'pre_restore_backup': pre_restore}
