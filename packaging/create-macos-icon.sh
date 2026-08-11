#!/usr/bin/env bash
# 从项目 PNG 图标生成 Electron Builder 所需的 macOS .icns 文件。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ICON_SOURCE="$SCRIPT_DIR/../desktop/assets/icon.png"
ICONSET="$SCRIPT_DIR/../desktop/assets/icon.iconset"
ICON_OUTPUT="$SCRIPT_DIR/../desktop/assets/icon.icns"

rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ICON_SOURCE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$ICON_SOURCE" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$ICON_OUTPUT"
rm -rf "$ICONSET"
