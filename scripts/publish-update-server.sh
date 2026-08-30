#!/usr/bin/env bash
# 将一个已生成 SHA256SUMS.txt 的发布目录原子发布到自建更新服务器。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="${1:-}"
SSH_TARGET="${WORKBENCH_UPDATE_SSH_TARGET:-jiao-server}"
REMOTE_ROOT="${WORKBENCH_UPDATE_REMOTE_ROOT:-/srv/workbench-updates}"
PUBLIC_BASE="${WORKBENCH_UPDATE_PUBLIC_BASE:-https://home.kaikaiyang.top/updates}"
REPOSITORY="${WORKBENCH_UPDATE_REPOSITORY:-aitia0718/workbench}"

if [[ -z "$SOURCE_DIR" || ! -d "$SOURCE_DIR" ]]; then
  echo "用法：bash scripts/publish-update-server.sh <发布目录>" >&2
  exit 1
fi

SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
SOURCE_MANIFEST="$SOURCE_DIR/update-manifest.json"
SOURCE_CHECKSUMS="$SOURCE_DIR/SHA256SUMS.txt"
if [[ ! -f "$SOURCE_MANIFEST" || ! -f "$SOURCE_CHECKSUMS" ]]; then
  echo "发布目录必须包含 update-manifest.json 和 SHA256SUMS.txt" >&2
  exit 1
fi

RELEASE_TAG="$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(p.tag_name||""))' "$SOURCE_MANIFEST")"
RELEASE_URL="$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(p.html_url||""))' "$SOURCE_MANIFEST")"
if [[ ! "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([._-][A-Za-z0-9.-]+)?$ ]]; then
  echo "发布标签不合法：$RELEASE_TAG" >&2
  exit 1
fi
if [[ ! "$SSH_TARGET" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  echo "SSH 目标不合法：$SSH_TARGET" >&2
  exit 1
fi
if [[ ! "$REMOTE_ROOT" =~ ^/[A-Za-z0-9._/-]+$ || "$REMOTE_ROOT" == *".."* ]]; then
  echo "远程目录不合法：$REMOTE_ROOT" >&2
  exit 1
fi

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/workbench-update.XXXXXX")"
cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

cp "$SOURCE_CHECKSUMS" "$STAGE_DIR/SHA256SUMS.txt"
while IFS= read -r asset_name; do
  if [[ ! "$asset_name" =~ ^[A-Za-z0-9._-]+$ || ! -f "$SOURCE_DIR/$asset_name" ]]; then
    echo "安装包文件不合法或不存在：$asset_name" >&2
    exit 1
  fi
  cp "$SOURCE_DIR/$asset_name" "$STAGE_DIR/$asset_name"
done < <(node -e '
  const fs=require("fs");
  const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  for(const asset of p.assets||[]) process.stdout.write(String(asset.name||"")+"\n");
' "$SOURCE_MANIFEST")

(cd "$STAGE_DIR" && shasum -a 256 -c SHA256SUMS.txt)
(cd "$STAGE_DIR" && \
  RELEASE_TAG="$RELEASE_TAG" \
  REPOSITORY="$REPOSITORY" \
  RELEASE_URL="$RELEASE_URL" \
  UPDATE_BASE_URL="${PUBLIC_BASE%/}/$RELEASE_TAG" \
  node "$PROJECT_ROOT/packaging/create-update-manifest.mjs")

INCOMING_DIR="$REMOTE_ROOT/.incoming-$RELEASE_TAG-$(date +%s)-$$"
RELEASE_DIR="$REMOTE_ROOT/$RELEASE_TAG"
ssh "$SSH_TARGET" "test -d '$REMOTE_ROOT' && test -w '$REMOTE_ROOT' && mkdir '$INCOMING_DIR'"
scp "$STAGE_DIR"/* "$SSH_TARGET:$INCOMING_DIR/"
ssh "$SSH_TARGET" "
  set -eu
  cd '$INCOMING_DIR'
  sha256sum -c SHA256SUMS.txt
  test ! -e '$RELEASE_DIR'
  mv '$INCOMING_DIR' '$RELEASE_DIR'
  cp '$RELEASE_DIR/SHA256SUMS.txt' '$REMOTE_ROOT/.SHA256SUMS.txt.new'
  cp '$RELEASE_DIR/update-manifest.json' '$REMOTE_ROOT/.update-manifest.json.new'
  mv '$REMOTE_ROOT/.SHA256SUMS.txt.new' '$REMOTE_ROOT/SHA256SUMS.txt'
  mv '$REMOTE_ROOT/.update-manifest.json.new' '$REMOTE_ROOT/update-manifest.json'
"

echo "更新已发布：${PUBLIC_BASE%/}/update-manifest.json"
