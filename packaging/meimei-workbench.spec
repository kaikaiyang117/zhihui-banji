# PyInstaller onedir 配置
# 构建前请先在 frontend/ 执行 npm run build。
import sys
from pathlib import Path

from PyInstaller.building.build_main import Analysis, COLLECT, EXE, PYZ
from PyInstaller.building.osx import BUNDLE
from PyInstaller.utils.hooks import collect_submodules


PROJECT_ROOT = Path(SPECPATH).resolve().parent
APP_NAME = 'MeimeiWorkbench'

a = Analysis(
    [str(PROJECT_ROOT / 'backend' / 'run.py')],
    pathex=[str(PROJECT_ROOT / 'backend')],
    binaries=[],
    datas=[(str(PROJECT_ROOT / 'backend' / 'static'), 'backend/static')],
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
    console=sys.platform != 'darwin',
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

if sys.platform == 'darwin':
    app = BUNDLE(
        coll,
        name=f'{APP_NAME}.app',
        bundle_identifier='com.meimei.workbench',
    )
