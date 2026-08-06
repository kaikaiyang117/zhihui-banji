#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:?请提供 .app 路径}"
REQUIRE_SIGNING="${REQUIRE_SIGNING:-0}"
CERTIFICATE_BASE64="${APPLE_CERTIFICATE_P12_BASE64:-}"
CERTIFICATE_PASSWORD="${APPLE_CERTIFICATE_PASSWORD:-}"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"

if [ -z "$CERTIFICATE_BASE64" ]; then
  if [ "$REQUIRE_SIGNING" = "1" ]; then
    echo '发布版本必须配置 APPLE_CERTIFICATE_P12_BASE64。' >&2
    exit 1
  fi
  echo '未配置 macOS 代码签名证书，跳过签名（非正式发布模式）。'
  exit 0
fi
if [ -z "$CERTIFICATE_PASSWORD" ] || [ -z "$SIGNING_IDENTITY" ]; then
  echo 'macOS 签名需要 APPLE_CERTIFICATE_PASSWORD 和 APPLE_SIGNING_IDENTITY。' >&2
  exit 1
fi

SIGNING_TEMP_DIR="${RUNNER_TEMP:-$(mktemp -d)}"
KEYCHAIN_PATH="$SIGNING_TEMP_DIR/meimei-workbench-signing.keychain-db"
CERTIFICATE_PATH="$SIGNING_TEMP_DIR/meimei-workbench-signing.p12"
KEYCHAIN_PASSWORD="${KEYCHAIN_PASSWORD:-$(openssl rand -hex 16)}"

echo "$CERTIFICATE_BASE64" | base64 --decode > "$CERTIFICATE_PATH"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security import "$CERTIFICATE_PATH" -P "$CERTIFICATE_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN_PATH"
security list-keychains -d user -s "$KEYCHAIN_PATH"
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

codesign --deep --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
