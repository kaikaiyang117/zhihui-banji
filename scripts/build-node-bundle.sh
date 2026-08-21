#!/usr/bin/env bash
# 构建 Node 后端资源包 build/server-bundle/（供 Electron extraResources 使用，MIG-10）
#
# 产物结构（打包后位于 <app>/resources/server/）：
#   dist/           TypeScript 编译产物（node dist/entry.js --desktop-child）
#   static/         前端构建产物 + app-version.json（应用版本唯一来源）
#   node_modules/   生产依赖（better-sqlite3 v13+ 随包提供 N-API 二进制）
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
echo "==> 构建前端产物"
(cd frontend && npm ci)
(cd frontend && npm run build)

echo "==> 编译 Node 后端"
(cd server && npm ci --ignore-scripts)
(cd server && npm run build:server)

echo "==> 组装 server-bundle（version=${VERSION}）"
rm -rf build/server-bundle
mkdir -p build/server-bundle/dist build/server-bundle/static
cp server/package.json build/server-bundle/package.json
if [ -f "server/package-lock.json" ]; then
  cp server/package-lock.json build/server-bundle/package-lock.json
fi
(cd build/server-bundle && npm ci --omit=dev --ignore-scripts)
cp -R server/dist/. build/server-bundle/dist/
cp -R backend/static/. build/server-bundle/static/
printf '{"version":"%s"}\n' "$VERSION" > build/server-bundle/static/app-version.json

echo "server-bundle 完成：$PROJECT_ROOT/build/server-bundle"
