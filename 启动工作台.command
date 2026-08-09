#!/bin/bash
# 美美大王工作台 - macOS 启动脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/backend"

PORT="${WORKBENCH_PORT:-5000}"
HOST="${WORKBENCH_HOST:-0.0.0.0}"

echo "========================================"
echo "  美美大王工作台 v2.3"
echo ""
echo "  默认开启局域网访问"
echo "  端口冲突时会自动切换端口"
echo ""
echo "  按 Ctrl+C 停止"
echo "========================================"

python_is_supported() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1
}

if [ -n "${WORKBENCH_PYTHON:-}" ]; then
  PYTHON_BIN="$WORKBENCH_PYTHON"
elif [ -x "$SCRIPT_DIR/.venv/bin/python" ] && python_is_supported "$SCRIPT_DIR/.venv/bin/python"; then
  PYTHON_BIN="$SCRIPT_DIR/.venv/bin/python"
else
  PYTHON_BIN=""
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && python_is_supported "$candidate"; then
      PYTHON_BIN="$(command -v "$candidate")"
      break
    fi
  done
fi

if [ -z "$PYTHON_BIN" ] || ! python_is_supported "$PYTHON_BIN"; then
  echo "错误：需要 Python 3.11 或更高版本。"
  echo "请安装 Python 3.11+，或设置 WORKBENCH_PYTHON 指向对应解释器。"
  exit 1
fi

# 已完成微信扫码授权时，启动工作台后自动恢复 iLink 消息循环。
# 首次运行没有凭证，不会发起登录，也不会阻止工作台启动。
export MEIMEI_WECHAT_ENABLED="${MEIMEI_WECHAT_ENABLED:-true}"

# 开发/测试默认使用学期内的正常上课日；显式设置为空可恢复真实系统日期。
if [ -z "${WORKBENCH_BUSINESS_DATE+x}" ]; then
  export WORKBENCH_BUSINESS_DATE="2026-04-15"
fi
if [ -n "$WORKBENCH_BUSINESS_DATE" ]; then
  echo "  开发业务日期：$WORKBENCH_BUSINESS_DATE"
else
  echo "  开发业务日期：使用系统日期"
fi

if [ "$MEIMEI_WECHAT_ENABLED" = "true" ]; then
  echo "  已开启微信消息循环自动恢复"
else
  echo "  微信消息循环自动恢复：已关闭"
fi

WORKBENCH_HOST="$HOST" WORKBENCH_PORT="$PORT" "$PYTHON_BIN" run.py --open-browser "$@"
