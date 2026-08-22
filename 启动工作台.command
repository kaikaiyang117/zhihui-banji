#!/bin/bash
# 智汇·班记 - macOS 启动脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/desktop"

# 测试阶段默认使用春季学期内的业务日期；不改变系统时间、审计时间或数据库时间。
export WORKBENCH_BUSINESS_DATE="${WORKBENCH_BUSINESS_DATE-2026-04-15}"

# 源码启动使用本机 Node.js 运行后端。
# better-sqlite3 是原生模块；源码后端固定使用 Node 22，打包产物则单独重建为 Electron ABI。
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
NODE_MAJOR="$($NODE_BIN -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
if [ "$NODE_MAJOR" != "22" ]; then
  echo "源码启动必须使用 Node.js 22.x，当前为：$($NODE_BIN --version 2>/dev/null || echo 未知版本)"
  echo "请先切换到项目 .nvmrc 指定的版本，或设置 WORKBENCH_NODE。"
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
echo "  智汇·班记 v2.3"
echo ""
echo "  由 Electron 启动 Node.js 后端"
echo "  自动启动前端热更新，数据仅保存在本机"
echo "  按 Ctrl+C 停止"
echo "========================================"

export MEIMEI_WECHAT_ENABLED="${MEIMEI_WECHAT_ENABLED:-true}"

# ---------- 前端 Vite 热更新 ----------
# Electron 通过 --dev-frontend 探测 5173，并优先加载 Vite 页面。
# 如果依赖未安装或 Vite 启动失败，Electron 会自动回退到 backend/static。
VITE_PID=""
VITE_LOG="${TMPDIR:-/tmp}/meimei-workbench-vite.log"
VITE_DIR="$SCRIPT_DIR/frontend"

port_in_use() {
  /usr/sbin/lsof -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1
}

cleanup() {
  if [ -n "$VITE_PID" ] && kill -0 "$VITE_PID" >/dev/null 2>&1; then
    kill "$VITE_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if port_in_use; then
  echo "检测到 5173 端口已有服务，Electron 将尝试使用该前端服务。"
elif [ -x "$VITE_DIR/node_modules/.bin/vite" ]; then
  echo "正在启动前端 Vite 热更新服务…"
  (
    cd "$VITE_DIR"
    exec ./node_modules/.bin/vite --host 127.0.0.1
  ) >"$VITE_LOG" 2>&1 &
  VITE_PID=$!
  vite_ready=0
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:5173/@vite/client >/dev/null 2>&1; then
      vite_ready=1
      break
    fi
    sleep 0.5
  done
  if [ "$vite_ready" -ne 1 ]; then
    echo "警告：Vite 热更新服务启动超时，Electron 将回退到构建页面。"
    echo "Vite 日志：$VITE_LOG"
  fi
else
  echo "警告：未找到前端依赖，Vite 热更新不可用。"
  echo "请先执行：cd frontend && npm install"
fi

"$NPM_BIN" run dev -- "$@"
