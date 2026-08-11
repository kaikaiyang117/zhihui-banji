#!/bin/bash
# 美美大王工作台 - macOS 启动脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/desktop"

# Electron 的开发模式会用 WORKBENCH_NODE 启动 Node 后端。
# better-sqlite3 是原生模块，必须确保 npm、Electron 后端使用同一套 Node ABI。
NODE_BIN="${WORKBENCH_NODE:-}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for candidate in "$HOME"/.nvm/versions/node/v22.*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "未找到可用的 Node.js，请安装 Node.js 22 LTS。"
  exit 1
fi
NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"
export PATH="$NODE_DIR:$PATH"
export WORKBENCH_NODE="$NODE_BIN"
NPM_BIN="$NODE_DIR/npm"
if [ ! -x "$NPM_BIN" ]; then
  NPM_BIN="$(command -v npm || true)"
fi
if [ -z "$NPM_BIN" ] || [ ! -x "$NPM_BIN" ]; then
  echo "未找到与 Node.js 匹配的 npm。"
  exit 1
fi

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

"$NPM_BIN" run dev -- "$@"
