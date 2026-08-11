#!/usr/bin/env bash
# macOS Electron 构建：前端 build → Node 后端编译 → server-bundle → Electron Builder → 签名/公证 → DMG
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ ! -f "backend/static/index.html" ]; then
  echo "未找到前端构建产物，请先执行：cd frontend && npm run build"
  exit 1
fi

VERSION="${APP_VERSION#v}"
VERSION="${VERSION:-0.0.0-dev}"
ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  arm64|x86_64) ;;
  *) echo "不支持的 macOS 架构：$ARCH"; exit 1 ;;
esac

echo "==> 清理旧产物"
rm -rf dist/MeimeiWorkbench build/server-bundle desktop/dist desktop/release artifacts
mkdir -p artifacts

echo "==> 构建 Node 后端资源包（${ARCH}，version=${VERSION}）"
APP_VERSION="$VERSION" bash scripts/build-node-bundle.sh
if [ ! -d "build/server-bundle/dist" ]; then
  echo "未生成 server-bundle 目录"
  exit 1
fi

echo "==> 安装桌面依赖"
cd desktop
npm ci || npm install

echo "==> 同步桌面应用版本（${VERSION}）"
node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='${VERSION}';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"

echo "==> Electron Builder 打包（${ARCH}）"
if [ -n "${APPLE_CERTIFICATE_P12_BASE64:-}" ] && [ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ] && [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  CERT_FILE="$RUNNER_TEMP/meimei-workbench-macos.p12"
  echo "$APPLE_CERTIFICATE_P12_BASE64" | base64 --decode > "$CERT_FILE"
  export CSC_LINK="$CERT_FILE"
  export CSC_KEY_PASSWORD="$APPLE_CERTIFICATE_PASSWORD"
  export CSC_NAME="$APPLE_SIGNING_IDENTITY"
  echo "macOS 代码签名已启用。"
else
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  echo "::warning::未配置完整 macOS 签名证书，将生成未签名安装包。"
fi
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
  export APPLE_ID
  export APPLE_TEAM_ID
  export APPLE_APP_PASSWORD
  echo "macOS 公证已启用。"
else
  echo "::warning::未配置完整 macOS 公证凭证，将跳过公证。"
fi
npx electron-builder --config electron-builder.yml --mac --"${ARCH//x86_64/x64}" --publish never
cd ..

if [ ! -f "desktop/dist/MeimeiWorkbench-macOS-${ARCH}.dmg" ]; then
  echo "未生成 DMG 安装包"
  exit 1
fi
cp "desktop/dist/MeimeiWorkbench-macOS-${ARCH}.dmg" "artifacts/"

echo "macOS 安装包已生成：$PROJECT_ROOT/artifacts/MeimeiWorkbench-macOS-${ARCH}.dmg"
