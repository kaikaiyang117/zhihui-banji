#!/bin/bash
# 美美大王工作台 - macOS 启动脚本
# 双击 .command 文件即可运行，也可在终端中执行

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/backend"

PORT="${WORKBENCH_PORT:-8080}"
HOST="${WORKBENCH_HOST:-127.0.0.1}"

echo "========================================"
echo "  美美大王工作台 v2.2"
echo "  http://${HOST}:${PORT}"
echo "  按 Ctrl+C 停止"
echo "========================================"

python3 -c "
import sys, os
sys.path.insert(0, '.')
import uvicorn
uvicorn.run('app.__init__:app', host='${HOST}', port=${PORT}, reload=False)
"
