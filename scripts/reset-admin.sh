#!/usr/bin/env bash
# 把管理员 xyzhzzmaster 重置为初始密码（secret ADMIN_INIT_PASSWORD），下次登录强制改密。
# 原理：更新 secret ADMIN_SEED_VERSION，Directory 在下次登录/注册时发现版本变化即重置。
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?请先设置 CLOUDFLARE_API_TOKEN}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-f57ee3b3ec6a868c05a73c1b2b54d531}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$ROOT/.cache}"
mkdir -p node_modules/.cache/wrangler
printf '%s' "$(date +%s)" | node_modules/.bin/wrangler secret put ADMIN_SEED_VERSION >/dev/null 2>&1
echo "已更新 ADMIN_SEED_VERSION；约 1 分钟内生效（Durable Object 重启后），之后管理员用初始密码登录并被要求改密。"
