# -*- coding: utf-8 -*-
"""启动入口：python run.py [--lan] [--port 5000]"""
import argparse
import sys
import os
import threading
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from app import app as application
from app.config import APP_VERSION, HOST, IS_FROZEN, PORT


def local_ip() -> str:
    """获取当前局域网地址；失败时回退到本机地址。"""
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))
            return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'


def find_available_port(host: str, requested: int, attempts: int = 100) -> int:
    """从请求端口开始寻找可绑定端口，避免桌面服务因端口冲突退出。"""
    import socket
    for port in range(requested, requested + attempts):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind((host, port))
            return port
        except OSError:
            continue
    raise RuntimeError(f'无法在 {requested}-{requested + attempts - 1} 找到可用端口')


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='美美大王工作台本地服务')
    parser.add_argument('--lan', action='store_true', help='开启局域网访问（监听 0.0.0.0）')
    parser.add_argument('--host', default=None, help='覆盖监听地址，默认读取 WORKBENCH_HOST')
    parser.add_argument('--port', type=int, default=None, help='覆盖端口，默认读取 WORKBENCH_PORT')
    parser.add_argument('--open-browser', action='store_true', help='启动后打开浏览器')
    parser.add_argument('--no-browser', action='store_true', help='不自动打开浏览器')
    parser.add_argument('--version', action='version', version=f'%(prog)s {APP_VERSION}')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    host = '0.0.0.0' if args.lan else (args.host or HOST)
    requested_port = args.port or PORT
    port = find_available_port(host, requested_port)
    lan_mode = host in ('0.0.0.0', '::') or args.lan
    if port != requested_port:
        print(f'端口 {requested_port} 已被占用，已自动切换到 {port}')
    if lan_mode:
        os.environ['WORKBENCH_PORT'] = str(port)
        os.environ['WORKBENCH_LAN_URL_BASE'] = f'http://{local_ip()}:{port}'
    print(f'美美大王工作台启动中 -> http://localhost:{port}')
    if lan_mode:
        print(f'局域网配对入口 -> {os.environ["WORKBENCH_LAN_URL_BASE"]}')
        print('请在工作台点击“手机访问”生成 5 分钟有效的单次配对二维码。')
        print('安全提示：仅在可信局域网使用，不要将此端口映射到公网。')
    open_browser = not args.no_browser and (args.open_browser or IS_FROZEN)
    if open_browser:
        browser_url = f'http://127.0.0.1:{port}/'
        threading.Timer(0.8, lambda: webbrowser.open(browser_url)).start()
    uvicorn.run(application, host=host, port=port, reload=False)


if __name__ == '__main__':
    main()
