# PyInstaller onedir 配置
# 构建前请先在 frontend/ 执行 npm run build。
# MEIMEI_SIDECAR=1 时生成可嵌入 Electron 的后端目录（不含 .app），
# 输出目录固定为 build/backend-sidecar/，供 desktop/electron-builder 使用。
import sys
import json
import os
from pathlib import Path

from PyInstaller.building.build_main import Analysis, COLLECT, EXE, PYZ
from PyInstaller.building.osx import BUNDLE
from PyInstaller.utils.hooks import collect_submodules


PROJECT_ROOT = Path(SPECPATH).resolve().parent
APP_NAME = 'MeimeiWorkbench'
APP_VERSION = os.environ.get('APP_VERSION', '0.0.0-dev').lstrip('v')
SIDECAR_MODE = os.environ.get('MEIMEI_SIDECAR', '') == '1'
VERSION_FILE = Path(PROJECT_ROOT / 'build' / 'app-version.json')
ICON_FILE = Path(PROJECT_ROOT / 'packaging' / 'logo.ico')
VERSION_FILE.parent.mkdir(parents=True, exist_ok=True)
VERSION_FILE.write_text(json.dumps({'version': APP_VERSION}, ensure_ascii=False), encoding='utf-8')

a = Analysis(
    [str(PROJECT_ROOT / 'backend' / 'run.py')],
    pathex=[str(PROJECT_ROOT / 'backend')],
    binaries=[],
    datas=[
        (str(PROJECT_ROOT / 'backend' / 'static'), 'backend/static'),
        (str(VERSION_FILE), 'backend/static'),
        (str(ICON_FILE), 'assets'),
        (str(PROJECT_ROOT / 'packaging' / 'macos-updater.sh'), 'updater'),
    ],
    hiddenimports=collect_submodules('app'),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    name=APP_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    icon=str(ICON_FILE) if sys.platform == 'win32' and ICON_FILE.exists() else None,
    console=sys.platform not in ('darwin', 'win32'),
    exclude_binaries=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    name=APP_NAME,
)

if SIDECAR_MODE:
    # Electron 桌面壳模式：只产出普通目录，供 extraResources 使用。
    import shutil
    sidecar_root = Path(PROJECT_ROOT / 'build' / 'backend-sidecar')
    if sidecar_root.exists():
        shutil.rmtree(sidecar_root)
    shutil.copytree(Path(PROJECT_ROOT / 'dist' / APP_NAME), sidecar_root / APP_NAME)
elif sys.platform == 'darwin':
    app = BUNDLE(
        coll,
        name=f'{APP_NAME}.app',
        bundle_identifier='com.meimei.workbench',
    )
