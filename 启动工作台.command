#!/bin/bash
# 美美大王工作台 - macOS 启动脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/desktop"

echo "========================================"
echo "  美美大王工作台 v2.3"
echo ""
echo "  由 Electron 启动 Node.js 后端"
echo "  按 Ctrl+C 停止"
echo "========================================"

export MEIMEI_WECHAT_ENABLED="${MEIMEI_WECHAT_ENABLED:-true}"
if [ -z "${WORKBENCH_BUSINESS_DATE+x}" ]; then
  export WORKBENCH_BUSINESS_DATE="2026-04-15"
fi

npm run dev -- "$@"
