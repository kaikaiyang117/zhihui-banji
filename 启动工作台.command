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
echo "  自动启动前端 Vite dev server（HMR 热更新）"
echo "  按 Ctrl+C 停止"
echo "========================================"

export MEIMEI_WECHAT_ENABLED="${MEIMEI_WECHAT_ENABLED:-true}"
if [ -z "${WORKBENCH_BUSINESS_DATE+x}" ]; then
  export WORKBENCH_BUSINESS_DATE="2026-04-15"
fi

# ---------- 前端 Vite dev server（HMR）----------
# 未安装前端依赖时跳过（桌面仍可用静态页面），由 setup-dev.sh 完成安装。
VITE_PID=""
VITE_LOG="${TMPDIR:-/tmp}/workbench-vite-dev.log"
port_in_use() {
  /usr/sbin/lsof -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1
}
if port_in_use; then
  echo "检测到 Vite dev server 已在运行（127.0.0.1:5173），直接使用。"
else
  if [ -x "$SCRIPT_DIR/frontend/node_modules/.bin/vite" ]; then
    echo "启动前端 Vite dev server（日志：$VITE_LOG）…"
    (
      cd "$SCRIPT_DIR/frontend"
      exec ./node_modules/.bin/vite > "$VITE_LOG" 2>&1
    ) &
    VITE_PID=$!
    # 等待 dev server 就绪（最多 15 秒），确保 Electron 窗口能探测到 5173。
    ready=0
    for _ in $(seq 1 30); do
      if port_in_use; then
        ready=1
        break
      fi
      sleep 0.5
    done
    if [ "$ready" -ne 1 ]; then
      echo "警告：Vite dev server 启动超时，Electron 将加载静态页面。详见 $VITE_LOG"
    fi
  else
    echo "警告：未找到前端依赖（frontend/node_modules），Vite 热更新不可用。"
    echo "      请先执行 ./scripts/setup-dev.sh 安装依赖，桌面仍会正常启动。"
  fi
fi

cleanup() {
  if [ -n "$VITE_PID" ] && kill -0 "$VITE_PID" 2>/dev/null; then
    kill "$VITE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

"$NPM_BIN" run dev -- "$@"
