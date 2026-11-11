#!/usr/bin/env bash
# 部署 Worker「chatroom」→ https://chatroom.xyzhzz.com（Workers + Durable Objects，自定义域名）
# 需要 CLOUDFLARE_API_TOKEN。管理员初始密码从 /workspace/.secrets/chatroom-admin-init 读取，
# 仅在 Worker 尚无 ADMIN_INIT_PASSWORD secret 时写入（或设置 SET_ADMIN_SECRET=1 强制覆盖）。不打印任何密钥。
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?请先设置 CLOUDFLARE_API_TOKEN}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-f57ee3b3ec6a868c05a73c1b2b54d531}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$ROOT/.cache}"
mkdir -p "$XDG_CACHE_HOME" node_modules/.cache/wrangler
SECRET_FILE="${ADMIN_SECRET_FILE:-/workspace/.secrets/chatroom-admin-init}"
[ -x node_modules/.bin/wrangler ] || npm install --no-audit --no-fund >/dev/null
W=node_modules/.bin/wrangler

for f in src/*.js public/*.js; do node --check "$f"; done
echo "部署 chatroom Worker …"
"$W" deploy 2>&1 | grep -v -i -e token -e password

if [[ "${SET_ADMIN_SECRET:-0}" == "1" ]] || ! "$W" secret list 2>/dev/null | grep -q '"ADMIN_INIT_PASSWORD"'; then
  [ -r "$SECRET_FILE" ] || { echo "找不到 $SECRET_FILE，跳过管理员初始密码" >&2; exit 1; }
  echo "写入 secret ADMIN_INIT_PASSWORD …"
  tr -d '\r\n' < "$SECRET_FILE" | "$W" secret put ADMIN_INIT_PASSWORD >/dev/null 2>&1
fi
echo "检查线上…"
sleep 3
curl -s -o /dev/null -w "chatroom.xyzhzz.com -> HTTP %{http_code}\n" https://chatroom.xyzhzz.com/ || true
curl -s -o /dev/null -w "chatroom.xyzhzz.com/api/me -> HTTP %{http_code}（未登录应为 401）\n" https://chatroom.xyzhzz.com/api/me || true
