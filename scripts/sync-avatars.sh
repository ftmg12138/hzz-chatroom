#!/usr/bin/env bash
# 把 /workspace/chatroom-avatars/ 里生成好的预设头像（webp + manifest.json）同步到两个站点的静态资源目录
set -euo pipefail
SRC="${1:-/workspace/chatroom-avatars}"
[ -f "$SRC/manifest.json" ] || { echo "缺少 $SRC/manifest.json"; exit 1; }
for d in /workspace/chatroom/public/avatars /workspace/videochatroom/public/avatars; do
  mkdir -p "$d"; rm -f "$d"/av*.svg "$d"/av*.webp
  if ls "$SRC"/webp/av*.webp >/dev/null 2>&1; then cp "$SRC"/webp/av*.webp "$d"/; else cp "$SRC"/av*.webp "$d"/; fi
  cp "$SRC/manifest.json" "$d/manifest.json"
done
echo "已同步 $(ls /workspace/chatroom/public/avatars/av*.webp | wc -l) 个预设头像"
