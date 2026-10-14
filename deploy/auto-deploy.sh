#!/usr/bin/env bash
# 服务器端自动发布：拉取公开仓库 → 有变化才发布 → 语法自检 → 重启容器 → 健康检查 → 失败自动回滚
#
# 由 systemd timer 周期触发（见 deploy/systemd/）。也可以手动跑：
#   sudo /opt/video-transcript-src/deploy/auto-deploy.sh
#
# 设计约束（改动前先读）：
#   - 本脚本以 root 运行，且被执行的是「从公开仓库拉下来的代码」。
#     因此**仓库的可写权限等于本机的 root 权限** —— 不要给仓库加协作者，
#     也不要在 main 上放开其他人直推。
#   - 只做「同步代码 + 重启本容器」：不碰 nginx、不碰同机其他项目的目录。
#   - .env 与 bin/（yt-dlp 二进制）只存在于服务器，不在仓库里，**永远不覆盖、不删除**。
#   - 只走「重启容器」这条路径，不重建镜像（Alpine 装 ffmpeg 要 5-6 分钟）。

set -euo pipefail

VT_REPO="${VT_REPO:-/opt/video-transcript-src}"
VT_TARGET="${VT_TARGET:-/opt/douyin-transcript}"
VT_REMOTE="${VT_REMOTE:-https://github.com/liuyihua2015/video-transcript.git}"
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

# ---- 1. 准备 / 更新检出 ----
if [ ! -d "$VT_REPO/.git" ]; then
  log "首次运行：clone $VT_REMOTE 到 $VT_REPO"
  git clone -q --branch "$VT_BRANCH" "$VT_REMOTE" "$VT_REPO" || die "clone 失败，退出"
else
  git -C "$VT_REPO" fetch -q origin "$VT_BRANCH" || die "git fetch 失败，退出（网络问题？下轮再试）"
fi

NEW="$(git -C "$VT_REPO" rev-parse "origin/$VT_BRANCH")"
OLD="$(cat "$VT_STATE" 2>/dev/null || true)"

if [ "$NEW" = "$OLD" ]; then
  exit 0   # 无变化：静默退出，不刷日志
fi
log "检测到新版本 ${NEW:0:8}（线上 ${OLD:0:8}）"

git -C "$VT_REPO" reset -q --hard "$NEW"

# ---- 2. 同步代码到发布目录 ----
# --delete：删掉仓库里已移除的文件；被 --exclude 的项受保护，不会误删 .env / bin / 备份文件
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

# ---- 3. 语法自检：在「还没重启的旧容器」里检查已同步的新代码 ----
# 只检查当前仓库里真实存在的文件，避免历史遗留文件把自检卡死
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

# ---- 4. 发布 ----
if deploy; then
  mkdir -p "$(dirname "$VT_STATE")"
  printf '%s\n' "$NEW" > "$VT_STATE"
  log "发布成功 → ${NEW:0:8}"
  exit 0
fi

# ---- 5. 失败回滚 ----
log "!! 发布失败，准备回滚"
if [ -z "$OLD" ]; then
  die "!! 没有可回滚的历史版本，需要人工介入（发布目录里的代码可能已损坏）"
fi

git -C "$VT_REPO" reset -q --hard "$OLD"
if deploy; then
  log "已回滚到 ${OLD:0:8}，服务恢复。有问题的版本是 ${NEW:0:8}，请排查后再推"
  exit 1
fi

die "!! 回滚后依然不健康，需要人工介入"
