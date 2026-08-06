# -*- coding: utf-8 -*-
"""启动入口：python run.py [--lan] [--port 5000]"""
import argparse
import secrets
import sys
import os
import threading
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from app import app as application
from app.config import HOST, IS_FROZEN, PORT


def local_ip() -> str:
    """获取当前局域网地址；失败时回退到本机地址。"""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='美美大王工作台本地服务')
    parser.add_argument('--lan', action='store_true', help='开启局域网访问（监听 0.0.0.0）')
    parser.add_argument('--host', default=None, help='覆盖监听地址，默认读取 WORKBENCH_HOST')
    parser.add_argument('--port', type=int, default=None, help='覆盖端口，默认读取 WORKBENCH_PORT')
    parser.add_argument('--open-browser', action='store_true', help='启动后打开浏览器')
    parser.add_argument('--no-browser', action='store_true', help='不自动打开浏览器')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    host = '0.0.0.0' if args.lan else (args.host or HOST)
    port = args.port or PORT
    lan_mode = host in ('0.0.0.0', '::') or args.lan
    if lan_mode:
        os.environ.setdefault('WORKBENCH_ACCESS_TOKEN', secrets.token_urlsafe(24))
    print(f'美美大王工作台启动中 -> http://localhost:{port}')
    if lan_mode:
        access_token = os.environ['WORKBENCH_ACCESS_TOKEN']
        print(f'局域网访问地址 -> http://{local_ip()}:{port}/?access={access_token}')
        print('安全提示：仅在可信局域网使用，不要将此端口映射到公网。')
    open_browser = args.open_browser or (IS_FROZEN and not args.no_browser)
    if open_browser:
        browser_url = f'http://127.0.0.1:{port}/'
        if lan_mode:
            browser_url += f'?access={os.environ["WORKBENCH_ACCESS_TOKEN"]}'
        threading.Timer(0.8, lambda: webbrowser.open(browser_url)).start()
    uvicorn.run(application, host=host, port=port, reload=False)


if __name__ == '__main__':
    main()
