#!/usr/bin/env bash
# 服务器端自动发布：取远端版本 → 有变化才发布 → 语法自检 → 重启容器 → 健康检查 → 失败自动回滚
#
# 由 systemd timer 周期触发（见 deploy/systemd/）。也可以手动跑：
#   sudo systemctl start video-transcript-autodeploy.service
#   journalctl -u video-transcript-autodeploy -n 50
#
# 设计约束（改动前先读）：
#   - 本脚本以 root 运行，且被执行的是「从公开仓库拉下来的代码」。
#     因此**仓库的可写权限等于本机的 root 权限** —— 不要给仓库加协作者，
#     也不要在 main 上放开其他人直推。
#   - 只做「同步代码 + 重启本容器」：不碰 nginx、不碰同机其他项目的目录。
#   - .env 与 bin/（yt-dlp 二进制）只存在于服务器，不在仓库里，**永远不覆盖、不删除**。
#   - 只走「重启容器」这条路径，不重建镜像（Alpine 装 ffmpeg 要 5-6 分钟）。
#   - 整条链路不需要任何密钥：仓库是公开的，这里只做只读拉取。

set -euo pipefail

VT_REPO="${VT_REPO:-/opt/video-transcript-src}"
VT_TARGET="${VT_TARGET:-/opt/douyin-transcript}"
VT_REMOTE="${VT_REMOTE:-https://github.com/liuyihua2015/video-transcript.git}"
# 国内机房直连 github.com 时通时断（实测多个官方 IP 全部超时），镜像作为兜底。
# 两个镜像都支持 git smart-http（ls-remote / fetch 均实测可用），返回的 SHA 与主仓一致。
VT_MIRRORS="${VT_MIRRORS:-https://ghfast.top/$VT_REMOTE https://gh-proxy.com/$VT_REMOTE}"
VT_BRANCH="${VT_BRANCH:-main}"
VT_CONTAINER="${VT_CONTAINER:-dytx-app}"
VT_HEALTH_URL="${VT_HEALTH_URL:-http://127.0.0.1:3300/api/health}"
VT_STATE="${VT_STATE:-/var/lib/video-transcript-autodeploy/last-good}"
VT_LOCK="${VT_LOCK:-/var/lock/video-transcript-autodeploy.lock}"

log() { echo "[$(date '+%F %T')] $*"; }
die() { log "$*"; exit 1; }

# ---- 单实例：上一轮没跑完就跳过这一轮 ----
mkdir -p "$(dirname "$VT_LOCK")" "$(dirname "$VT_STATE")"
exec 9>"$VT_LOCK"
flock -n 9 || { log "上一轮尚未结束，跳过本次"; exit 0; }

# ---- 1. 取远端版本：直连优先，失败逐个换镜像 ----
resolve_ref() {
  local url sha
  for url in "$VT_REMOTE" $VT_MIRRORS; do
    sha="$(timeout 40 git ls-remote "$url" "refs/heads/$VT_BRANCH" 2>/dev/null | awk 'NR==1{print $1}')"
    if [ -n "${sha:-}" ]; then printf '%s|%s\n' "$url" "$sha"; return 0; fi
    log "取远端失败，换下一个来源：${url:0:70}"
  done
  return 1
}

REF="$(resolve_ref)" || die "所有来源都拿不到远端版本（网络问题？），本轮跳过"
SRC_URL="${REF%%|*}"
NEW="${REF##*|}"
OLD="$(cat "$VT_STATE" 2>/dev/null || true)"

if [ "$NEW" = "$OLD" ]; then
  exit 0   # 无变化：静默退出，不刷日志
fi
log "检测到新版本 ${NEW:0:8}（线上 ${OLD:0:8}），来源 ${SRC_URL:0:70}"

# ---- 2. 同步检出 ----
fetch_into_repo() {
  timeout 180 git -C "$VT_REPO" fetch -q "$SRC_URL" \
    "+refs/heads/$VT_BRANCH:refs/remotes/origin/$VT_BRANCH" || return 1
  git -C "$VT_REPO" reset -q --hard "$NEW"
}

if [ ! -d "$VT_REPO/.git" ]; then
  log "首次运行：clone 到 $VT_REPO"
  mkdir -p "$(dirname "$VT_REPO")"
  timeout 240 git clone -q --branch "$VT_BRANCH" "$SRC_URL" "$VT_REPO" || die "clone 失败，本轮跳过"
  git -C "$VT_REPO" reset -q --hard "$NEW" || true
fi
fetch_into_repo || die "fetch 失败，本轮跳过"

# ---- 3. 同步代码到发布目录 ----
# --delete：删掉仓库里已移除的文件；被 --exclude 的项同时受保护，不会误删 .env / bin / 备份
sync_code() {
  rsync -a --delete \
    --exclude='/.git/' \
    --exclude='/deploy/' \
    --exclude='/bin/' \
    --exclude='/.env' \
    --exclude='/.env.*' \
    --exclude='/.workbuddy/' \
    --exclude='/node_modules/' \
    --exclude='/._*' \
    --exclude='*.bak-*' \
    "$VT_REPO/" "$VT_TARGET/"
}

# ---- 4. 语法自检：在「还没重启的旧容器」里检查刚同步进去的新代码 ----
# 只检查当前仓库里真实存在的文件，避免历史遗留文件把自检永久卡死
syntax_ok() {
  docker ps --format '{{.Names}}' | grep -qx "$VT_CONTAINER" || return 0
  local files
  files="$(git -C "$VT_REPO" ls-tree -r --name-only HEAD -- server | grep '\.js$' | sed 's|^server/|/app/server/|')"
  [ -n "$files" ] || return 0
  printf '%s\n' "$files" | docker exec -i "$VT_CONTAINER" sh -c \
    'while read -r f; do node --check "$f" || { echo "语法错误: $f"; exit 1; }; done'
}

restart_container() {
  ( cd "$VT_TARGET" && docker compose up -d >/dev/null && docker compose restart app >/dev/null )
}

healthy() {
  sleep 5
  local code
  code="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 15 "$VT_HEALTH_URL" 2>/dev/null || true)"
  [ "$code" = "200" ]
}

deploy() { sync_code && syntax_ok && restart_container && healthy; }

# ---- 5. 发布 ----
if deploy; then
  printf '%s\n' "$NEW" > "$VT_STATE"
  log "发布成功 → ${NEW:0:8}"
  exit 0
fi

# ---- 6. 失败回滚 ----
log "!! 发布失败，准备回滚"
[ -n "$OLD" ] || die "!! 没有可回滚的历史版本，需要人工介入（发布目录里的代码可能已损坏）"

git -C "$VT_REPO" reset -q --hard "$OLD"
if deploy; then
  log "已回滚到 ${OLD:0:8}，服务已恢复。有问题的版本是 ${NEW:0:8}，排查后再推"
  exit 1
fi

die "!! 回滚后依然不健康，需要人工介入"
