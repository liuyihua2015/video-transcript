#!/usr/bin/env bash
# 服务器端自动发布（标签触发制）
#
# **只有打了发布标签（默认 `deploy-*`）的提交才会上线 —— push 到 main 不会发布。**
# 上线因此永远是一次有意识的操作，而不是每次提交的副作用。
#
# 由 systemd timer 周期触发（见 deploy/systemd/）。也可以手动跑：
#   sudo systemctl start video-transcript-autodeploy.service
#   journalctl -u video-transcript-autodeploy -n 50
#
# 流程：
#   列出来源上的发布标签 → 从新到旧逐个校验（来源可信 / 内容未被替换 / 已并入主干 /
#   不会把线上退回去）→ 同步 server/ 与 public/ → 语法自检 → 重启容器 →
#   健康检查 → 失败自动回滚
#
# 设计约束（改动前先读）：
#   - 本脚本以 root 运行，且被执行的是「从公开仓库拉下来的代码」。
#     因此**仓库的可写权限等于本机的 root 权限** —— 不要给仓库加协作者，
#     也不要在 main 上放开其他人直推。
#   - **只同步 server/ 与 public/**：容器只挂载这两个目录，别的文件
#     （.env / bin/ / deploy/ / docker-compose.yml）一律不碰，从源头消除
#     「exclude 列表写错就会误删」这类隐患。
#   - 只做「同步代码 + 重启本容器」：不碰 nginx、不碰同机其他项目的目录。
#   - 只走「重启容器」这条路径，不重建镜像（Alpine 装 ffmpeg 要 5-6 分钟）。
#   - 整条链路不需要任何密钥：仓库是公开的，这里只做只读拉取。

set -euo pipefail

VT_REPO="${VT_REPO:-/opt/video-transcript-src}"
VT_TARGET="${VT_TARGET:-/opt/douyin-transcript}"
VT_REMOTE="${VT_REMOTE:-https://github.com/liuyihua2015/video-transcript.git}"
# 出处校验：远端地址必须包含它，否则直接拒绝执行
VT_EXPECT_REPO="${VT_EXPECT_REPO:-liuyihua2015/video-transcript}"
# 国内机房直连 github.com 实测基本连不上（多个官方 IP 全部超时），两个镜像可达且都支持
# git smart-http（ls-remote / fetch 均实测可用）。镜像之间必须互相印证才被采用，
# 详见下面「取源」段的注释。
# 注意用 ${VAR-default} 而不是 ${VAR:-default}：显式置空表示「不用镜像」（本地测试要用）。
VT_MIRRORS="${VT_MIRRORS-https://ghfast.top/$VT_REMOTE https://gh-proxy.com/$VT_REMOTE}"
# 单次 ls-remote 的超时（秒），防止网络抖动把定时任务挂住
VT_PROBE_TIMEOUT="${VT_PROBE_TIMEOUT:-20}"
VT_BRANCH="${VT_BRANCH:-main}"
# 发布标签的匹配式。只有命中它的标签才会被发布
VT_TAG_GLOB="${VT_TAG_GLOB:-refs/tags/deploy-*}"
# 是否允许发布「尚未并入主干」的标签（默认不允许）
VT_ALLOW_UNMERGED="${VT_ALLOW_UNMERGED:-0}"
# 是否允许把线上版本「往回退」（默认不允许：自动发布只前进，回退只由失败回滚触发）
VT_ALLOW_BACKWARD="${VT_ALLOW_BACKWARD:-0}"
VT_CONTAINER="${VT_CONTAINER:-dytx-app}"
VT_HEALTH_URL="${VT_HEALTH_URL:-http://127.0.0.1:3300/api/health}"
VT_STATE="${VT_STATE:-/var/lib/video-transcript-autodeploy/last-good}"
VT_FAILED="${VT_FAILED:-/var/lib/video-transcript-autodeploy/last-failed}"
VT_LOCK="${VT_LOCK:-/var/lock/video-transcript-autodeploy.lock}"

# 日志一律写 stderr：本脚本多处用 $(...) 取返回值，混进 stdout 会污染结果
# （踩过一次：日志文本被当成 URL 传给 git fetch）
#
# ⚠️ 变量插值后面若紧跟中文，必须写成 ${VAR} 带花括号：bash 在缺少 UTF-8 locale
#    的环境里会把中文字节当成变量名的一部分，比如「$LATEST」紧跟一个全角括号会被
#    解析成变量「LATEST（」，直接报 unbound variable（本地实测踩到；systemd 里
#    LANG 为空时同样会中招）。
log() { echo "[$(date '+%F %T')] $*" >&2; }
die() { log "$*"; exit 1; }

# ---- 0. 出处校验 ----
case "$VT_REMOTE" in
  *"$VT_EXPECT_REPO"*) : ;;
  *) die "远端地址与预期不符（期望包含 ${VT_EXPECT_REPO}）：${VT_REMOTE} —— 拒绝执行" ;;
esac

# ---- 单实例：上一轮没跑完就跳过这一轮 ----
mkdir -p "$(dirname "$VT_LOCK")" "$(dirname "$VT_STATE")"
exec 9>"$VT_LOCK"
flock -n 9 || { log "上一轮尚未结束，跳过本次"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- 1. 列出来源上的发布标签 ----
# 探测一个来源，每行输出 "标签名<TAB>提交SHA"。stdout 只允许出现结果行
# （git 的报错与日志都走 stderr）；annotated tag 取 peeled 后的提交 SHA。
probe_tags() {
  local url="$1" out
  if ! out="$(timeout "$VT_PROBE_TIMEOUT" git ls-remote --tags "$url" "$VT_TAG_GLOB" 2>/dev/null)"; then
    log "取标签失败：${url:0:70}"
    return 0
  fi
  printf '%s\n' "${out:-}" | awk '
    NF < 2 { next }
    $2 ~ /\^\{\}$/ {
      t = $2; sub(/\^\{\}$/, "", t); sub(/^refs\/tags\//, "", t)
      peeled[t] = $1; next
    }
    $2 ~ /^refs\/tags\// {
      t = $2; sub(/^refs\/tags\//, "", t)
      if (!(t in base)) base[t] = $1
    }
    END { for (t in base) printf "%s\t%s\n", t, ((t in peeled) ? peeled[t] : base[t]) }'
}

URLS=("$VT_REMOTE")
for _m in $VT_MIRRORS; do URLS+=("$_m"); done

idx=0
for _u in "${URLS[@]}"; do
  probe_tags "$_u" > "$TMP/tags.$idx"
  idx=$((idx + 1))
done

# 查某个来源上某个标签对应的提交 SHA（$1=来源序号 $2=标签名）。
# 用文件查询而不是关联数组：脚本要靠 #!/usr/bin/env bash 跑在各种机器上，
# 而 bash 3.2（macOS 自带）不支持 declare -A。
sha_of_tag() {
  awk -F'\t' -v t="$2" '$1 == t { print $2; exit }' "$TMP/tags.$1" 2>/dev/null
}

# 所有来源出现过的标签名，按版本号从新到旧
CANDIDATES=()
while IFS= read -r _t; do
  if [ -n "$_t" ]; then CANDIDATES+=("$_t"); fi
done < <(cat "$TMP"/tags.* 2>/dev/null | cut -f1 | sort -u -V -r || true)

# 一个发布标签都没有 = 正常状态（没人要求发布），静默退出，不刷日志
if [ "${#CANDIDATES[@]}" -eq 0 ]; then exit 0; fi

# ---- 2. 挑一个可发布的标签 ----
# 直连是权威来源；直连拿不到该标签时，要求两个镜像给出同一个 SHA。
# 本脚本以 root 运行、执行的又是拉下来的代码，让「单一来源说了算」等于把 root 交给对方。
# 命中即设置 SRC_SHA / SRC_URL / SOURCE_NOTE；完全取不到时返回 1。
resolve_candidate() {
  local tag="$1" s i=1 hit _u

  s="$(sha_of_tag 0 "$tag")"
  if [ -n "$s" ]; then
    SRC_SHA="$s"; SRC_URL="$VT_REMOTE"; SOURCE_NOTE="直连"
    return 0
  fi

  local hits=()
  for _u in "${URLS[@]:1}"; do
    s="$(sha_of_tag "$i" "$tag")"
    i=$((i + 1))
    if [ -n "$s" ]; then hits+=("$s|$_u"); fi
  done
  if [ "${#hits[@]}" -eq 0 ]; then return 1; fi

  local agree
  agree="$(printf '%s\n' "${hits[@]}" | cut -d'|' -f1 | sort | uniq -c | awk '$1 >= 2 { print $2; exit }')"
  if [ -n "$agree" ]; then
    SRC_SHA="$agree"
    SRC_URL="$(printf '%s\n' "${hits[@]}" | awk -F'|' -v s="$agree" '$1 == s { print $2; exit }')"
    SOURCE_NOTE="镜像（两源 SHA 一致，已交叉校验）"
  else
    hit="${hits[0]}"
    SRC_SHA="${hit%%|*}"
    SRC_URL="${hit#*|}"
    SOURCE_NOTE="!! 降级：镜像之间未取得一致（另一个来源可能被篡改，也可能只是抖动）"
  fi
  return 0
}

# 取指定标签到检出目录并逐条校验；全通过才把工作区切过去
fetch_and_checkout() {
  local tag="$1" url="$2" want="$3" sha

  timeout 180 git -C "$VT_REPO" fetch -q --force "$url" \
    "+refs/tags/$tag:refs/tags/$tag" \
    "+refs/heads/$VT_BRANCH:refs/remotes/origin/$VT_BRANCH" || return 1

  sha="$(git -C "$VT_REPO" rev-parse --verify --quiet "refs/tags/$tag^{commit}")" || return 1
  # 远端声明的 SHA 与本地解析出来的必须一致，防止标签在传输途中被替换
  if [ "$sha" != "$want" ]; then
    log "!! 标签 ${tag}：本地解析出的提交 $sha 与远端声明的 $want 不一致，跳过"
    return 1
  fi

  # 必须已并入主干：避免误发未合并分支上的提交
  if [ "$VT_ALLOW_UNMERGED" != "1" ] &&
    git -C "$VT_REPO" rev-parse --verify --quiet "refs/remotes/origin/$VT_BRANCH" >/dev/null; then
    if ! git -C "$VT_REPO" merge-base --is-ancestor "$sha" "refs/remotes/origin/$VT_BRANCH"; then
      log "!! 标签 ${tag} 指向的提交尚未并入 ${VT_BRANCH}，跳过（确需发布请设 VT_ALLOW_UNMERGED=1）"
      return 1
    fi
  fi

  # 只前进不回退：自动发布不会把线上版本退回去，回退只由「失败回滚」触发
  if [ "$VT_ALLOW_BACKWARD" != "1" ] && [ -n "$OLD_SHA" ] &&
    git -C "$VT_REPO" cat-file -e "$OLD_SHA^{commit}" 2>/dev/null; then
    if ! git -C "$VT_REPO" merge-base --is-ancestor "$OLD_SHA" "$sha"; then
      log "!! 标签 ${tag}（${sha:0:8}）不是线上版本（${OLD_SHA:0:8}）的后代，跳过（确需回退请设 VT_ALLOW_BACKWARD=1）"
      return 1
    fi
  fi

  git -C "$VT_REPO" reset -q --hard "$sha"
}

OLD_SHA="$(sed -n 1p "$VT_STATE" 2>/dev/null || true)"
OLD_TAG="$(sed -n 2p "$VT_STATE" 2>/dev/null || true)"
FAILED_SHA="$(cat "$VT_FAILED" 2>/dev/null || true)"

SRC_SHA=""
SRC_URL=""
SOURCE_NOTE=""
TAG=""
PICKED=0

for CAND in "${CANDIDATES[@]}"; do
  if ! resolve_candidate "$CAND"; then
    log "标签 ${CAND} 在所有来源都取不到，跳过"
    continue
  fi

  # 上一次发布失败且已回滚的版本不再自动重试，等新标签
  if [ "$SRC_SHA" = "$FAILED_SHA" ]; then
    log "跳过已知失败的版本 ${CAND}（${SRC_SHA:0:8}）：修复后请打一个新标签"
    continue
  fi

  # 这个提交已经在线上跑了：什么都不用做，静默退出
  if [ "$SRC_SHA" = "$OLD_SHA" ]; then
    exit 0
  fi

  # 首次运行要先把仓库检出来
  if [ ! -d "$VT_REPO/.git" ]; then
    log "首次运行：clone 到 $VT_REPO"
    mkdir -p "$(dirname "$VT_REPO")"
    timeout 240 git clone -q --branch "$VT_BRANCH" "$SRC_URL" "$VT_REPO" || die "clone 失败，本轮跳过"
  fi

  if ! fetch_and_checkout "$CAND" "$SRC_URL" "$SRC_SHA"; then
    log "标签 ${CAND} 未通过校验，看下一个"
    continue
  fi

  if [ -n "$OLD_SHA" ]; then
    log "选用发布标签 ${CAND} → ${SRC_SHA:0:8}（线上 ${OLD_SHA:0:8}${OLD_TAG:+ · ${OLD_TAG}}），来源：${SOURCE_NOTE}"
  else
    log "选用发布标签 ${CAND} → ${SRC_SHA:0:8}（线上版本未记录），来源：${SOURCE_NOTE}"
  fi
  TAG="$CAND"
  PICKED=1
  break
done

# 没有可发布的标签（例如都还没并入主干）→ 正常状态，静默退出
if [ "$PICKED" != "1" ]; then exit 0; fi

# ---- 3. 同步代码到发布目录 ----
# 只同步容器真正挂载的两个目录，且 --delete 只作用在这两个目录内部：
# 顶层的 .env / bin/ / deploy/ / docker-compose.yml 根本不在同步范围内，不会被删。
sync_code() {
  local d
  for d in server public; do
    if [ ! -d "$VT_REPO/$d" ]; then
      log "仓库里缺少 ${d}/，拒绝同步"
      return 1
    fi
    rsync -a --delete --exclude='*.bak-*' --exclude='._*' \
      "$VT_REPO/$d/" "$VT_TARGET/$d/" || return 1
  done
}

# ---- 4. 语法自检：在「还没重启的旧容器」里检查刚同步进去的新代码 ----
# 只检查当前仓库里真实存在的文件，避免历史遗留文件把自检永久卡死
syntax_ok() {
  docker ps --format '{{.Names}}' | grep -qx "$VT_CONTAINER" || return 0
  local files
  files="$(git -C "$VT_REPO" ls-tree -r --name-only HEAD -- server | grep '\.js$' | sed 's|^server/|/app/server/|' || true)"
  if [ -z "$files" ]; then return 0; fi
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
  printf '%s\n%s\n' "$SRC_SHA" "$TAG" > "$VT_STATE"
  rm -f "$VT_FAILED"
  log "发布成功 → ${TAG} ${SRC_SHA:0:8}"
  exit 0
fi

# ---- 6. 失败回滚 ----
log "!! 发布失败，准备回滚"
if [ -z "$OLD_SHA" ]; then
  die "!! 没有可回滚的历史版本，需要人工介入（发布目录里的代码可能已损坏）"
fi
if ! git -C "$VT_REPO" cat-file -e "$OLD_SHA^{commit}" 2>/dev/null; then
  die "!! 找不到回滚目标 ${OLD_SHA}，需要人工介入"
fi

git -C "$VT_REPO" reset -q --hard "$OLD_SHA"
if deploy; then
  printf '%s\n' "$SRC_SHA" > "$VT_FAILED"
  log "已回滚到 ${OLD_SHA:0:8}，服务已恢复。有问题的版本是 ${TAG}（${SRC_SHA:0:8}），已记入 last-failed 不再自动重试；修复后打新标签即可"
  exit 1
fi

die "!! 回滚后依然不健康，需要人工介入"
