# -*- coding: utf-8 -*-
"""启动入口：python run.py"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from app.config import HOST, PORT

if __name__ == '__main__':
    print(f'美美大王工作台启动中 -> http://localhost:{PORT}')
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
        s.close()
        if HOST in ('0.0.0.0', '::'):
            print(f'局域网访问地址 -> http://{ip}:{PORT}')
    except Exception:
        pass
    uvicorn.run('app.__init__:app', host=HOST, port=PORT, reload=False)