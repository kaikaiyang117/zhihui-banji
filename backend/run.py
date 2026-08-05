# -*- coding: utf-8 -*-
"""启动入口：python run.py"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from app.config import HOST, PORT

if __name__ == '__main__':
    print(f'美美大王工作台启动中 -> http://localhost:{PORT}')
    uvicorn.run('app.__init__:app', host=HOST, port=PORT, reload=False)