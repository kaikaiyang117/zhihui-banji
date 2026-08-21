#!/usr/bin/env bash
# 浏览器 UI 冒烟：启动 Node 后端（MIG-10+），用 Playwright 检查工作台页面。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${WORKBENCH_NODE:-node}"
PORT="${WORKBENCH_SMOKE_PORT:-5123}"
DATA_DIR="$(mktemp -d)"
SERVER_LOG="$DATA_DIR/server.log"
SEED_LOG="$DATA_DIR/seed.log"
SERVER_PID=''

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

command -v npx >/dev/null 2>&1 || { echo '需要 Node.js/npm 才能运行浏览器冒烟测试。' >&2; exit 1; }

if [ ! -f "$PROJECT_ROOT/server/dist/entry.js" ]; then
  echo '未找到 Node 后端构建产物，请先执行：cd server && npm run build:server' >&2
  exit 1
fi

cd "$PROJECT_ROOT"
# 使用隔离的最小场景数据，避免空数据库导致课程表/考试功能被误判为异常。
"$NODE_BIN" scripts/seed-demo-data.mjs \
  --profile=minimal \
  --data-dir="$DATA_DIR/data" \
  --no-backup >"$SEED_LOG"
"$NODE_BIN" scripts/verify-test-data.mjs \
  --profile=minimal \
  --data-dir="$DATA_DIR/data" >/dev/null

WORKBENCH_DATA_DIR="$DATA_DIR/data" \
WORKBENCH_KB_DIR="$DATA_DIR/kb" \
WORKBENCH_BUSINESS_DATE="${WORKBENCH_BUSINESS_DATE-2026-04-15}" \
WORKBENCH_LOG_LEVEL=warn \
"$NODE_BIN" server/dist/entry.js --lan --port "$PORT" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null

PWCLI=(npx --yes --package @playwright/cli playwright-cli)
URL="http://127.0.0.1:${PORT}/"
"${PWCLI[@]}" open "$URL" >/dev/null
SNAPSHOT="$("${PWCLI[@]}" snapshot 2>&1)"
printf '%s\n' "$SNAPSHOT"
grep -q '手机访问' <<< "$SNAPSHOT"
grep -q '更新' <<< "$SNAPSHOT"
grep -q '2026-04-15 · 从最需要处理的事情开始' <<< "$SNAPSHOT"
if grep -q '开发日期' <<< "$SNAPSHOT"; then
  echo '页面不应显示开发日期提示。' >&2
  exit 1
fi
grep -q '高二政治月考' <<< "$SNAPSHOT"
grep -q '语文早读' <<< "$SNAPSHOT"
"${PWCLI[@]}" close >/dev/null 2>&1 || true

echo 'UI smoke test passed.'
