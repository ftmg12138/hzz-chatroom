#!/usr/bin/env bash
# 提交并推送到 GitHub 私有仓库 ftmg12138/hzz-chatroom（分支 main）
# 用法：CHATROOM_GITHUB_TOKEN=... scripts/push.sh "提交说明"
# 令牌只通过一次性 credential helper 从环境变量读取：不写入 .git/config、远程地址或提交，也不打印。
set -euo pipefail
: "${CHATROOM_GITHUB_TOKEN:?请先设置 CHATROOM_GITHUB_TOKEN}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
unset GIT_TRACE GIT_TRACE_CURL GIT_CURL_VERBOSE GIT_TRACE_PACKET
BRANCH="${BRANCH:-main}"
MSG="${1:-Update $(date +%Y-%m-%dT%H:%M%z)}"
EXPECTED="https://github.com/ftmg12138/hzz-chatroom.git"
git remote get-url origin >/dev/null 2>&1 || git remote add origin "$EXPECTED"
[ "$(git remote get-url origin)" = "$EXPECTED" ] || git remote set-url origin "$EXPECTED"

git add -A
leak=0
for v in CHATROOM_GITHUB_TOKEN GITHUB_BACKUP_TOKEN CLOUDFLARE_API_TOKEN; do
  val="${!v:-}"
  [ -n "$val" ] && git grep -q --cached -F -e "$val" && { echo "暂存区中发现 $v 的值，已中止" >&2; leak=1; }
done
SECRET_FILE=/workspace/.secrets/chatroom-admin-init
if [ -r "$SECRET_FILE" ]; then
  s="$(tr -d '\r\n' < "$SECRET_FILE")"
  [ -n "$s" ] && git grep -q --cached -F -e "$s" && { echo "暂存区中发现管理员初始密码，已中止" >&2; leak=1; }
fi
git grep -q --cached -E -e '(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})' && { echo "暂存区中发现疑似 GitHub 令牌，已中止" >&2; leak=1; }
[ "$leak" = 0 ] || { git reset -q; exit 1; }
if git diff --cached --quiet; then echo "没有需要提交的改动"; else git commit -q -m "$MSG" && echo "已提交：$(git log -1 --format='%h %s')"; fi
git -c credential.helper= \
    -c credential.helper='!f(){ test "$1" = get || exit 0; echo username=x-access-token; echo "password=$CHATROOM_GITHUB_TOKEN"; }; f' \
    push -u origin "HEAD:$BRANCH" 2>&1 | grep -v -i -e token -e password
exit "${PIPESTATUS[0]}"
