"""Desktop tray integration for frozen builds."""
from __future__ import annotations

import threading
import webbrowser
from pathlib import Path

import pystray
from PIL import Image, ImageDraw

from .config import APP_NAME, RESOURCE_ROOT, ROOT_DIR


def _icon_path() -> Path:
    bundled = Path(RESOURCE_ROOT) / 'assets' / 'logo.ico'
    if bundled.exists():
        return bundled
    return Path(ROOT_DIR) / 'packaging' / 'logo.ico'


def _load_icon() -> Image.Image:
    path = _icon_path()
    if path.exists():
        return Image.open(path).convert('RGBA')
    image = Image.new('RGBA', (64, 64), '#5b6abf')
    draw = ImageDraw.Draw(image)
    draw.polygon([(16, 22), (24, 28), (32, 18), (40, 28), (48, 22), (45, 39), (19, 39)], fill='white')
    draw.line((24, 47, 39, 47), fill='#34c759', width=4)
    return image


class DesktopTray:
    def __init__(self, url: str, server, server_thread: threading.Thread):
        self.url = url
        self.server = server
        self.server_thread = server_thread
        self.icon = pystray.Icon(
            APP_NAME,
            _load_icon(),
            APP_NAME,
            menu=pystray.Menu(
                pystray.MenuItem('打开工作台', self._open),
                pystray.MenuItem('退出工作台', self._quit),
            ),
        )

    def _open(self, _icon, _item):
        webbrowser.open(self.url)

    def _quit(self, icon, _item):
        self.server.should_exit = True
        icon.stop()

    def run(self):
        self.icon.run()
        self.server.should_exit = True
        self.server_thread.join(timeout=10)
