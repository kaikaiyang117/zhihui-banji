#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ ! -f "backend/static/index.html" ]; then
  echo "未找到前端构建产物，请先执行：cd frontend && npm run build"
  exit 1
fi

VERSION="${APP_VERSION:-0.0.0-dev}"
ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  arm64|x86_64) ;;
  *) echo "不支持的 macOS 架构：$ARCH"; exit 1 ;;
esac

rm -rf dist/MeimeiWorkbench.app build artifacts
python -m PyInstaller packaging/meimei-workbench.spec --noconfirm --clean

if [ ! -d "dist/MeimeiWorkbench.app" ]; then
  echo "未生成 MeimeiWorkbench.app"
  exit 1
fi

mkdir -p artifacts
hdiutil create \
  -volname "美美大王工作台" \
  -srcfolder "dist/MeimeiWorkbench.app" \
  -ov \
  -format UDZO \
  "artifacts/MeimeiWorkbench-macOS-${ARCH}.dmg"

echo "macOS 安装包已生成：$PROJECT_ROOT/artifacts/MeimeiWorkbench-macOS-${ARCH}.dmg"
