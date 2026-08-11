#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 20+。"
  exit 1
fi

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "项目需要 Node.js 20+，当前版本为：$(node --version)"
  exit 1
fi

cd "$PROJECT_ROOT"
cd "$PROJECT_ROOT/frontend" && npm ci
if npm approve-scripts --help >/dev/null 2>&1; then
  npm approve-scripts esbuild
fi
npm run build

cd "$PROJECT_ROOT/server" && npm ci && npm run build:server
cd "$PROJECT_ROOT/desktop" && npm ci

echo "开发环境准备完成。"
echo "启动：$PROJECT_ROOT/启动工作台.command"
