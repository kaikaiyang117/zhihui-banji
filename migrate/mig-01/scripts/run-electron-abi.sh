#!/usr/bin/env bash
# MIG-01 试验 A-Electron：把 better-sqlite3 重建为 Electron ABI，在 Electron 中运行试验，
# 完成后重建回 Node ABI（开发环境继续可用）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MIG01="$HERE/.."
DESKTOP="$MIG01/../../desktop"
ELECTRON_BIN="$DESKTOP/node_modules/.bin/electron"
ELECTRON_VERSION="$(node -p "require('$DESKTOP/node_modules/electron/package.json').version")"

if [ ! -x "$ELECTRON_BIN" ]; then
  echo "未找到 Electron：$ELECTRON_BIN（请先在 desktop/ 执行 npm install）"
  exit 1
fi

cd "$MIG01"

echo "==> rebuild better-sqlite3 for Electron ABI ($ELECTRON_VERSION)"
npx @electron/rebuild -f -w better-sqlite3 --version "$ELECTRON_VERSION" --arch "$(uname -m | sed 's/x86_64/x64/')"

echo "==> 在 Electron 中运行 SQLite 试验"
"$ELECTRON_BIN" src/exp-sqlite-electron.mjs
RESULT=$?

echo "==> 重建 better-sqlite3 回 Node ABI"
npm rebuild better-sqlite3 >/dev/null 2>&1

if [ "$RESULT" -ne 0 ]; then
  echo "Electron ABI 试验失败"
  exit "$RESULT"
fi
echo "Electron ABI 试验通过"
