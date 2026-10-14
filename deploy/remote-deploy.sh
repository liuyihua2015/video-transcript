#!/usr/bin/env bash
# 把视频文案提取服务发布到腾讯云轻量服务器（走 SSH，非 TAT）
#
# 用法：
#   ./deploy/remote-deploy.sh              # 打包 + 上传 + 重建镜像 + 启动 + 健康检查（改了依赖/Dockerfile 时用）
#   ./deploy/remote-deploy.sh hot          # 只上传代码 + 重启容器（日常改 JS/HTML，秒级）
#   ./deploy/remote-deploy.sh sync-env     # 只同步本地 .env 并让新变量生效（含密钥，慎用；会重建容器）
#   ./deploy/remote-deploy.sh update-ytdlp # 只更新通用引擎 yt-dlp 的二进制（不用重建镜像）
#   ./deploy/remote-deploy.sh logs         # 看容器日志
#
# 服务器上不落地源码仓库，/opt/douyin-transcript 即发布目录。
# bin/yt-dlp 只存在于服务器（约 40MB），不参与打包上传。

set -euo pipefail

HOST="${DY_HOST:-ubuntu@122.51.1.5}"
REMOTE="${DY_REMOTE:-/opt/douyin-transcript}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
LOCAL="$(cd "$(dirname "$0")/.." && pwd)"
# 国内直连 GitHub Release 只有 20KB/s 左右（40MB 要半小时），走加速镜像；
# 失败则回落到直连，再失败就保留现有二进制不动。
YTDLP_MIRRORS=(
  "https://ghfast.top/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_musllinux"
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_musllinux"
)

sync_env() {
  echo "==> 同步 .env（含密钥）"
  ssh "${SSH_OPTS[@]}" "$HOST" "sudo mkdir -p $REMOTE"
  ssh "${SSH_OPTS[@]}" "$HOST" "sudo tee $REMOTE/.env > /dev/null" < "$LOCAL/.env"
  ssh "${SSH_OPTS[@]}" "$HOST" "sudo chmod 600 $REMOTE/.env"
  # env_file 只在「创建容器」时读取：只 docker restart 是拿不到新变量的，
  # 必须让 compose 感知 .env 变化后重建容器（实测 up -d 会输出 Recreated）。
  echo "==> 让新变量生效（必要时重建容器）"
  ssh "${SSH_OPTS[@]}" "$HOST" "cd $REMOTE && sudo docker compose up -d 2>&1 | tail -3"
  health
}

ensure_ytdlp() {
  echo "==> 检查通用引擎 yt-dlp"
  ssh "${SSH_OPTS[@]}" "$HOST" "sudo mkdir -p $REMOTE/bin && sudo chown \$(id -u):\$(id -g) $REMOTE/bin"
  if ssh "${SSH_OPTS[@]}" "$HOST" "test -x $REMOTE/bin/yt-dlp"; then
    echo "    已存在：$(ssh "${SSH_OPTS[@]}" "$HOST" "$REMOTE/bin/yt-dlp --version 2>/dev/null || echo '(跑不起来)'")"
    return 0
  fi
  update_ytdlp
}

update_ytdlp() {
  echo "==> 更新 yt-dlp 二进制（不重建镜像）"
  ssh "${SSH_OPTS[@]}" "$HOST" "sudo mkdir -p $REMOTE/bin && sudo chown \$(id -u):\$(id -g) $REMOTE/bin"
  for url in "${YTDLP_MIRRORS[@]}"; do
    echo "    尝试：${url:0:60}…"
    if ssh "${SSH_OPTS[@]}" "$HOST" \
      "curl -sSL --max-time 300 --retry 2 -o $REMOTE/bin/yt-dlp.new '$url' && chmod 755 $REMOTE/bin/yt-dlp.new && $REMOTE/bin/yt-dlp.new --version"; then
      ssh "${SSH_OPTS[@]}" "$HOST" "mv $REMOTE/bin/yt-dlp.new $REMOTE/bin/yt-dlp"
      echo "    完成"
      ssh "${SSH_OPTS[@]}" "$HOST" "cd $REMOTE && sudo docker compose restart app >/dev/null && sleep 3"
      health
      return 0
    fi
    ssh "${SSH_OPTS[@]}" "$HOST" "rm -f $REMOTE/bin/yt-dlp.new"
  done
  echo "    !! 所有镜像都失败，保留现有二进制。原生解析（抖音/快手/B站）不受影响"
  return 0
}

upload() {
  echo "==> 打包并上传到 $HOST:$REMOTE"
  tar -czf - -C "$LOCAL" \
    --exclude='./node_modules' \
    --exclude='./.env' \
    --exclude='./.git' \
    --exclude='.DS_Store' \
    --exclude='._*' \
    --exclude='./deploy' \
    --exclude='./bin' \
    . | ssh "${SSH_OPTS[@]}" "$HOST" "sudo mkdir -p $REMOTE && sudo tar xzf - -C $REMOTE --no-same-owner"
}

health() {
  echo "==> 健康检查"
  ssh "${SSH_OPTS[@]}" "$HOST" "sleep 3; curl -s --noproxy '*' http://127.0.0.1:3300/api/health; echo"
}

case "${1:-deploy}" in
  sync-env) sync_env; exit 0 ;;
  logs) ssh "${SSH_OPTS[@]}" "$HOST" "sudo docker logs --tail 120 dytx-app"; exit 0 ;;
  update-ytdlp) update_ytdlp; exit 0 ;;
  hot)
    upload
    echo "==> 重启容器（不重建镜像）"
    # up -d 在配置无变化时不会重启容器，而 server/*.js 的改动需要重启进程才生效
    # （public/ 是静态文件，每次读盘，不重启也能看到）
    ssh "${SSH_OPTS[@]}" "$HOST" "cd $REMOTE && sudo docker compose up -d && sudo docker compose restart app"
    health
    echo "==> 完成（hot）"
    exit 0
    ;;
esac

upload
ensure_ytdlp

echo "==> 构建并启动容器"
ssh "${SSH_OPTS[@]}" "$HOST" "cd $REMOTE && sudo docker compose up -d --build"

health

echo "==> 完成"
