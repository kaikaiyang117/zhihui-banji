#!/bin/sh
set -eu

DMG_PATH="$1"
TARGET_APP="$2"
PORT="$3"
UPDATE_DIR="$4"
STAGED_APP="$TARGET_APP.new"
BACKUP_APP="$TARGET_APP.rollback"
READY_MARKER="$UPDATE_DIR/../.workbench-ready"

sleep 1
mkdir -p "$UPDATE_DIR"
rm -f "$READY_MARKER"
MOUNT_POINT="$(hdiutil attach "$DMG_PATH" -nobrowse -readonly | awk '/\/Volumes\// { for (i = 1; i <= NF; i++) if ($i ~ /^\/Volumes\//) { print $i; exit } }')"
if [ -z "$MOUNT_POINT" ] || [ ! -d "$MOUNT_POINT/智汇·班记.app" ]; then
  exit 1
fi

cleanup() {
  hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf "$STAGED_APP"
ditto "$MOUNT_POINT/智汇·班记.app" "$STAGED_APP"
rm -rf "$BACKUP_APP"
ditto "$TARGET_APP" "$BACKUP_APP"

rm -rf "$TARGET_APP"
mv "$STAGED_APP" "$TARGET_APP"
open "$TARGET_APP"

for _ in $(seq 1 30); do
  if [ -f "$READY_MARKER" ]; then
    rm -rf "$BACKUP_APP" "$DMG_PATH"
    exit 0
  fi
  sleep 1
done

rm -rf "$TARGET_APP"
mv "$BACKUP_APP" "$TARGET_APP"
open "$TARGET_APP"
exit 1
