# -*- coding: utf-8 -*-
"""学生头像文件存储。数据库只保存相对路径，图片文件保存在应用数据目录。"""
from __future__ import annotations

import os
from uuid import uuid4

from .. import db

MAX_PHOTO_BYTES = 5 * 1024 * 1024
PHOTO_ROOT = 'student_photos'
class StudentPhotoError(ValueError):
    pass


def _detect_type(content: bytes) -> tuple[str, str]:
    if content.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg', '.jpg'
    if content.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png', '.png'
    if content.startswith(b'RIFF') and content[8:12] == b'WEBP':
        return 'image/webp', '.webp'
    raise StudentPhotoError('只支持 JPG、PNG 或 WebP 图片')


def _resolve(relative_path: str) -> str:
    root = os.path.abspath(db.DATA_DIR)
    target = os.path.abspath(os.path.join(root, relative_path))
    if not target.startswith(root + os.sep):
        raise StudentPhotoError('头像路径不合法')
    return target


def save(student_id: int, content: bytes) -> dict:
    data = bytes(content or b'')
    if not data:
        raise StudentPhotoError('头像不能为空')
    if len(data) > MAX_PHOTO_BYTES:
        raise StudentPhotoError('头像不能超过 5MB')
    content_type, suffix = _detect_type(data)
    relative_path = os.path.join(PHOTO_ROOT, str(student_id), f'{uuid4().hex}{suffix}')
    target = _resolve(relative_path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    temp_path = f'{target}.tmp-{uuid4().hex}'
    try:
        with open(temp_path, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
    except Exception:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
        raise
    return {
        'relative_path': relative_path,
        'content_type': content_type,
        'size_bytes': len(data),
    }


def remove(relative_path: str | None):
    if not relative_path:
        return
    try:
        os.unlink(_resolve(relative_path))
    except FileNotFoundError:
        pass


def path(relative_path: str | None) -> str | None:
    if not relative_path:
        return None
    target = _resolve(relative_path)
    return target if os.path.isfile(target) else None
