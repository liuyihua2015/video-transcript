#!/usr/bin/env bash
# 本地打「发布标签」—— 服务器上的自动发布只认这种标签。
#
#   ./deploy/release.sh                 # 自动生成标签名 deploy-YYYYMMDD-HHMM
#   ./deploy/release.sh deploy-1.2.3    # 指定标签名
#
# 打标签 ≠ 提交：普通 push 到 main 不会上线，只有推送 deploy-* 标签才会。
# 打之前会先确认「本地 = origin/main」，因为服务器只拉得到远端已有的提交。

set -euo pipefail

LOCAL="$(cd "$(dirname "$0")/.." && pwd)"
cd "$LOCAL"

BRANCH="${RELEASE_BRANCH:-main}"
TAG="${1:-deploy-$(date +%Y%m%d-%H%M)}"

case "$TAG" in
  deploy-*) : ;;
  *) echo "标签名必须以 deploy- 开头（服务器只认这个前缀）：$TAG" >&2; exit 1 ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交的改动，先提交（或 git stash）再发布：" >&2
  git status --short >&2
  exit 1
fi

if git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
  echo "标签 $TAG 已存在，换一个名字" >&2
  exit 1
fi

git fetch -q origin "$BRANCH" 2>/dev/null || true
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$BRANCH" 2>/dev/null || true)"
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  echo "本地 ${BRANCH}（${LOCAL_SHA:0:8}）与 origin/${BRANCH}（${REMOTE_SHA:0:8}）不一致" >&2
  echo "先 git push origin ${BRANCH}，再发布" >&2
  exit 1
fi

git tag -a "$TAG" -m "发布 ${TAG} · $(git rev-parse --short HEAD)"
GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15" git push origin "refs/tags/$TAG"

echo
echo "已推送标签 ${TAG}（提交 ${LOCAL_SHA:0:8}）"
echo "服务器每 5 分钟检查一次，正常几分钟内自动上线。看进度："
echo "  systemctl status video-transcript-autodeploy.service"
echo "  journalctl -u video-transcript-autodeploy -n 30"
echo
echo "要撤销这次发布（回到上一个正常版本）："
echo "  从服务器上把标签删掉不会自动回滚；"
echo "  最快的办法是回退 main 后打一个新标签发布回去。"
