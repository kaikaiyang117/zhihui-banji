#!/bin/bash
# 美美大王工作台 - macOS 启动脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/backend"

PORT="${WORKBENCH_PORT:-5000}"
HOST="${WORKBENCH_HOST:-0.0.0.0}"

echo "========================================"
echo "  美美大王工作台 v2.3"
echo ""
echo "  默认开启局域网访问"
echo "  端口冲突时会自动切换端口"
echo ""
echo "  按 Ctrl+C 停止"
echo "========================================"

PYTHON_BIN="${WORKBENCH_PYTHON:-$SCRIPT_DIR/.venv/bin/python}"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN="${WORKBENCH_PYTHON:-python3}"
fi

WORKBENCH_HOST="$HOST" WORKBENCH_PORT="$PORT" "$PYTHON_BIN" run.py --open-browser "$@"
