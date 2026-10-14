FROM node:22-alpine

# ffmpeg：抽音轨 + 切片；tini：正确处理信号，避免 compose 停止时留下僵尸进程
# 注意：必须放在同一个 RUN 里，否则 apk 源替换不会保留到后续层
# 国内服务器直连 dl-cdn.alpinelinux.org 实测数分钟无进展，换阿里云镜像源
RUN sed -i 's#dl-cdn.alpinelinux.org#mirrors.aliyun.com#g' /etc/apk/repositories \
 && apk add --no-cache ffmpeg tini

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    YTDLP_PATH=/app/bin/yt-dlp

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--env-file-if-exists=/app/.env", "server/index.js"]
