# -*- coding: utf-8 -*-
"""完整迁移包：数据库、业务附件和知识库的导出与恢复。"""
from __future__ import annotations

from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import stat
import tempfile
import zipfile

from .. import config, db


PACKAGE_FORMAT = 'meimei-workbench-migration'
PACKAGE_VERSION = 1
MAX_PACKAGE_BYTES = 1024 * 1024 * 1024
MAX_MEMBER_BYTES = 200 * 1024 * 1024
MAX_MEMBER_COUNT = 100_000
EXCLUDED_DATA_FILES = {
    'workbench.db', 'workbench.db-wal', 'workbench.db-shm',
    'agent-model.json', 'wechat-config.json', '.workbench-ready',
}
EXCLUDED_DATA_DIRS = {'backups'}


class MigrationError(ValueError):
    pass


def _sha256(path: str | os.PathLike[str]) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_archive_path(name: str) -> str:
    if not name or '\\' in name or name.startswith('/'):
        raise MigrationError('迁移包包含不安全的文件路径')
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '.' in path.parts:
        raise MigrationError('迁移包包含不安全的文件路径')
    return path.as_posix()


def _iter_files(root: str, prefix: str, *, excluded_files=None, excluded_dirs=None):
    root_path = Path(root)
    if not root_path.is_dir():
        return
    excluded_files = set(excluded_files or ())
    excluded_dirs = set(excluded_dirs or ())
    for path in sorted(root_path.rglob('*')):
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(root_path)
        if any(part in excluded_dirs for part in relative.parts[:-1]):
            continue
        if relative.name in excluded_files:
            continue
        yield f'{prefix}/{relative.as_posix()}', str(path)


def _file_entry(archive_path: str, source_path: str, kind: str) -> dict:
    return {
        'path': archive_path,
        'kind': kind,
        'size': os.path.getsize(source_path),
        'sha256': _sha256(source_path),
    }


def create_package() -> str:
    """创建完整迁移包，返回位于当前备份目录中的文件名。"""
    os.makedirs(db.backup_dir(), exist_ok=True)
    database_backup = db.create_backup('migration')
    database_path = os.path.join(db.backup_dir(), database_backup)
    entries = [_file_entry('database/workbench.db', database_path, 'database')]

    for archive_path, source_path in _iter_files(
        db.DATA_DIR, 'data', excluded_files=EXCLUDED_DATA_FILES,
        excluded_dirs=EXCLUDED_DATA_DIRS,
    ):
        entries.append(_file_entry(archive_path, source_path, 'data'))
    for archive_path, source_path in _iter_files(config.KB_DIR, 'knowledge'):
        entries.append(_file_entry(archive_path, source_path, 'knowledge'))

    filename = f'workbench-migration-{datetime.now().strftime("%Y%m%d-%H%M%S-%f")}.zip'
    output_path = os.path.join(db.backup_dir(), filename)
    manifest = {
        'format': PACKAGE_FORMAT,
        'format_version': PACKAGE_VERSION,
        'created_at': datetime.now().isoformat(timespec='seconds'),
        'app_version': config.APP_VERSION,
        'schema_version': db.schema_version(),
        'entries': entries,
    }
    try:
        with zipfile.ZipFile(output_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for entry in entries:
                source_path = database_path if entry['kind'] == 'database' else (
                    os.path.join(db.DATA_DIR, entry['path'][len('data/'):])
                    if entry['kind'] == 'data'
                    else os.path.join(config.KB_DIR, entry['path'][len('knowledge/'):])
                )
                archive.write(source_path, entry['path'])
            archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    except Exception:
        try:
            os.remove(output_path)
        except OSError:
            pass
        raise
    return filename


def _read_manifest(archive: zipfile.ZipFile) -> tuple[dict, list[zipfile.ZipInfo]]:
    infos = archive.infolist()
    if len(infos) > MAX_MEMBER_COUNT:
        raise MigrationError('迁移包文件数量过多')
    names = []
    for info in infos:
        name = _safe_archive_path(info.filename)
        if name in names:
            raise MigrationError('迁移包包含重复文件')
        names.append(name)
        mode = (info.external_attr >> 16) & 0o170000
        if mode == stat.S_IFLNK:
            raise MigrationError('迁移包不支持符号链接')
        if not info.is_dir() and info.file_size > MAX_MEMBER_BYTES:
            raise MigrationError('迁移包中的单个文件过大')
    try:
        manifest = json.loads(archive.read('manifest.json').decode('utf-8'))
    except KeyError as exc:
        raise MigrationError('迁移包缺少清单文件') from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MigrationError('迁移包清单无法读取') from exc
    if manifest.get('format') != PACKAGE_FORMAT or manifest.get('format_version') != PACKAGE_VERSION:
        raise MigrationError('迁移包版本不受当前工作台支持')
    entries = manifest.get('entries')
    if not isinstance(entries, list) or not entries:
        raise MigrationError('迁移包清单为空')
    manifest_paths = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise MigrationError('迁移包清单格式不正确')
        path = _safe_archive_path(str(entry.get('path', '')))
        if path in manifest_paths or path == 'manifest.json':
            raise MigrationError('迁移包清单包含重复文件')
        kind = entry.get('kind')
        if kind not in {'database', 'data', 'knowledge'}:
            raise MigrationError('迁移包清单包含未知文件类型')
        if kind == 'database' and path != 'database/workbench.db':
            raise MigrationError('迁移包数据库路径不正确')
        if kind == 'data' and not path.startswith('data/'):
            raise MigrationError('迁移包业务文件路径不正确')
        if kind == 'knowledge' and not path.startswith('knowledge/'):
            raise MigrationError('迁移包知识库文件路径不正确')
        if not isinstance(entry.get('size'), int) or entry['size'] < 0:
            raise MigrationError('迁移包清单中的文件大小不正确')
        if not isinstance(entry.get('sha256'), str) or len(entry['sha256']) != 64:
            raise MigrationError('迁移包清单中的校验值不正确')
        manifest_paths.add(path)
    archive_paths = {
        _safe_archive_path(info.filename)
        for info in infos
        if not info.is_dir() and info.filename != 'manifest.json'
    }
    if archive_paths != manifest_paths or 'database/workbench.db' not in manifest_paths:
        raise MigrationError('迁移包清单与文件内容不一致')
    if sum(info.file_size for info in infos) > MAX_PACKAGE_BYTES:
        raise MigrationError('迁移包解压后过大')
    if any(entry['kind'] == 'database' and entry['path'] != 'database/workbench.db' for entry in entries):
        raise MigrationError('迁移包只能包含一个数据库文件')
    return manifest, infos


def _validate_database(path: str):
    check = sqlite3.connect(path)
    try:
        integrity = check.execute('PRAGMA integrity_check').fetchone()[0]
        if integrity != 'ok':
            raise MigrationError('迁移包中的数据库完整性检查失败')
        row = check.execute(
            "SELECT MAX(version) FROM schema_migrations"
        ).fetchone()
        source_version = int(row[0] or 0)
        if source_version > db.CURRENT_SCHEMA_VERSION:
            raise MigrationError('迁移包来自更新版本，请先升级当前工作台')
    except MigrationError:
        raise
    except Exception as exc:
        raise MigrationError(f'迁移包中的数据库无法读取：{exc}') from exc
    finally:
        check.close()


def _extract(archive: zipfile.ZipFile, infos: list[zipfile.ZipInfo], stage: str, entries: list[dict]):
    entry_map = {entry['path']: entry for entry in entries}
    for info in infos:
        name = _safe_archive_path(info.filename)
        if info.is_dir() or name == 'manifest.json':
            continue
        target = os.path.abspath(os.path.join(stage, name.replace('/', os.sep)))
        if not target.startswith(os.path.abspath(stage) + os.sep):
            raise MigrationError('迁移包包含不安全的目标路径')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with archive.open(info) as source, open(target, 'wb') as destination:
            shutil.copyfileobj(source, destination, length=1024 * 1024)
        entry = entry_map[name]
        if os.path.getsize(target) != entry['size'] or _sha256(target) != entry['sha256'].lower():
            raise MigrationError(f'迁移包文件校验失败：{name}')


def _install_tree(stage: str, archive_root: str, target_root: str):
    source_root = os.path.join(stage, archive_root)
    if not os.path.isdir(source_root):
        return 0
    count = 0
    for source in sorted(Path(source_root).rglob('*')):
        if not source.is_file():
            continue
        relative = source.relative_to(source_root)
        target = os.path.abspath(os.path.join(target_root, relative))
        if not target.startswith(os.path.abspath(target_root) + os.sep):
            raise MigrationError('迁移包包含不安全的目标路径')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        temporary = f'{target}.migration-tmp'
        shutil.copyfile(source, temporary)
        os.replace(temporary, target)
        count += 1
    return count


def restore_package(data: bytes) -> dict:
    """校验并恢复迁移包，返回恢复前数据库备份名。"""
    if not data:
        raise MigrationError('迁移包为空')
    if len(data) > MAX_PACKAGE_BYTES:
        raise MigrationError('迁移包过大')
    parent = os.path.dirname(os.path.abspath(db.DATA_DIR))
    stage = tempfile.mkdtemp(prefix='.migration-import-', dir=parent)
    archive_path = os.path.join(stage, 'package.zip')
    try:
        with open(archive_path, 'wb') as output:
            output.write(data)
        try:
            archive = zipfile.ZipFile(archive_path)
            corrupt = archive.testzip()
            if corrupt:
                archive.close()
                raise MigrationError(f'迁移包校验失败：{corrupt}')
        except zipfile.BadZipFile as exc:
            raise MigrationError('文件不是有效的迁移包') from exc
        with archive:
            manifest, infos = _read_manifest(archive)
            _extract(archive, infos, stage, manifest['entries'])

        staged_db = os.path.join(stage, 'database', 'workbench.db')
        _validate_database(staged_db)
        pre_restore = db.create_backup('pre-migration')
        db.close()
        os.makedirs(os.path.dirname(os.path.abspath(db.DB_PATH)), exist_ok=True)
        os.replace(staged_db, db.DB_PATH)
        data_count = _install_tree(stage, 'data', db.DATA_DIR)
        knowledge_count = _install_tree(stage, 'knowledge', config.KB_DIR)
        db.get_conn()
        return {
            'ok': True,
            'pre_restore_backup': pre_restore,
            'app_version': manifest.get('app_version', ''),
            'schema_version': db.schema_version(),
            'data_file_count': data_count,
            'knowledge_file_count': knowledge_count,
        }
    finally:
        shutil.rmtree(stage, ignore_errors=True)
