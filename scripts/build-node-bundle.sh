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

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" != "22" ]; then
  echo "打包必须使用 Node.js 22.x，当前版本为：$(node --version)" >&2
  exit 1
fi

VERSION="${APP_VERSION:-0.0.0-dev}"
ELECTRON_VERSION="${ELECTRON_VERSION:-}"
if [ -z "$ELECTRON_VERSION" ] && [ -f "desktop/package.json" ]; then
  ELECTRON_VERSION="$(node -p "require('./desktop/package.json').devDependencies.electron" 2>/dev/null || true)"
fi

ELECTRON_REBUILD_BIN="$PROJECT_ROOT/desktop/node_modules/.bin/electron-rebuild"
ELECTRON_BIN="$PROJECT_ROOT/desktop/node_modules/.bin/electron"
if [ -n "$ELECTRON_VERSION" ] && { [ ! -x "$ELECTRON_REBUILD_BIN" ] || [ ! -x "$ELECTRON_BIN" ]; }; then
  echo "==> 安装锁定的 Electron 打包工具"
  (cd desktop && npm ci)
fi

echo "==> 构建前端产物"
if [ ! -x "frontend/node_modules/.bin/vite" ]; then
  (cd frontend && npm ci)
fi
(cd frontend && npm run build)

echo "==> 编译 Node 后端"
if [ ! -x "server/node_modules/.bin/tsc" ]; then
  (cd server && npm ci)
fi
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
  "$ELECTRON_REBUILD_BIN" -f -w better-sqlite3 -v "$ELECTRON_VERSION" -t prod --module-dir "$PROJECT_ROOT/build/server-bundle"
  echo "==> 校验 Electron 原生模块"
  ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" -e "const Database=require('./build/server-bundle/node_modules/better-sqlite3'); const db=new Database(':memory:'); db.close();"
fi

echo "server-bundle 完成：$PROJECT_ROOT/build/server-bundle"
