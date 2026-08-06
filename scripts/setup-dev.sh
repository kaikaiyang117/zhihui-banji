#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON_BIN="${WORKBENCH_PYTHON:-python3}"
VENV_DIR="$PROJECT_ROOT/.venv"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "未找到 $PYTHON_BIN，请先安装 Python 3.11+。"
  exit 1
fi

if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
  echo "项目需要 Python 3.11+，当前版本为：$($PYTHON_BIN --version)"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 20+。"
  exit 1
fi

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "项目需要 Node.js 20+，当前版本为：$(node --version)"
  exit 1
fi

cd "$PROJECT_ROOT"
"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install -r backend/requirements.txt

cd "$PROJECT_ROOT/frontend"
npm ci
if npm approve-scripts --help >/dev/null 2>&1; then
  npm approve-scripts esbuild
fi

echo "开发环境准备完成。"
echo "启动：$PROJECT_ROOT/启动工作台.command"
