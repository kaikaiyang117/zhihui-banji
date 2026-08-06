#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ ! -f "backend/static/index.html" ]; then
  echo "未找到前端构建产物，请先执行：cd frontend && npm run build"
  exit 1
fi

python3 -m PyInstaller packaging/meimei-workbench.spec --noconfirm --clean
echo "打包完成：$PROJECT_ROOT/dist/MeimeiWorkbench"
