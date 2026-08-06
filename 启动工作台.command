#!/bin/bash
# 美美大王工作台 - macOS 启动脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/backend"

PORT="${WORKBENCH_PORT:-5000}"
HOST="${WORKBENCH_HOST:-127.0.0.1}"

echo "========================================"
echo "  美美大王工作台 v2.3"
echo ""
echo "  本机访问: http://localhost:${PORT}"
if [ "$HOST" != "127.0.0.1" ]; then
  echo "  当前监听地址: ${HOST}"
fi
echo ""
echo "  按 Ctrl+C 停止"
echo "========================================"

WORKBENCH_HOST="$HOST" WORKBENCH_PORT="$PORT" python3 run.py "$@"
