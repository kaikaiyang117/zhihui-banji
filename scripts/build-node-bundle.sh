#!/usr/bin/env bash
# 构建 Node 后端资源包 build/server-bundle/（供 Electron extraResources 使用，MIG-10）
#
# 产物结构（打包后位于 <app>/resources/server/）：
#   dist/           TypeScript 编译产物（node dist/entry.js --desktop-child）
#   static/         前端构建产物 + app-version.json（应用版本唯一来源）
#   node_modules/   生产依赖（better-sqlite3 重建为打包 Electron 的 ABI）
#   package.json
#
# 用法：APP_VERSION=1.2.3 ./scripts/build-node-bundle.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

VERSION="${APP_VERSION:-0.0.0-dev}"
ELECTRON_VERSION="${ELECTRON_VERSION:-}"
if [ -z "$ELECTRON_VERSION" ] && [ -f "desktop/package.json" ]; then
  ELECTRON_VERSION="$(node -p "require('./desktop/package.json').devDependencies.electron" 2>/dev/null || true)"
fi

echo "==> 构建前端产物"
(cd frontend && npm run build)

echo "==> 编译 Node 后端"
(cd server && npm run build:server)

echo "==> 组装 server-bundle（version=${VERSION}）"
rm -rf build/server-bundle
mkdir -p build/server-bundle/dist build/server-bundle/static
cp server/package.json build/server-bundle/package.json
if [ -f "server/package-lock.json" ]; then
  cp server/package-lock.json build/server-bundle/package-lock.json
fi
(cd build/server-bundle && npm ci --omit=dev)
cp -R server/dist/. build/server-bundle/dist/
cp -R backend/static/. build/server-bundle/static/
printf '{"version":"%s"}\n' "$VERSION" > build/server-bundle/static/app-version.json

if [ -n "$ELECTRON_VERSION" ]; then
  echo "==> 重建 better-sqlite3 为 Electron ${ELECTRON_VERSION} ABI"
  (cd build/server-bundle && npx @electron/rebuild -f -w better-sqlite3 -v "$ELECTRON_VERSION" -t prod)
fi

echo "server-bundle 完成：$PROJECT_ROOT/build/server-bundle"
