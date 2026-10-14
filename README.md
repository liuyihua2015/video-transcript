# 视频文案提取器 · video-transcript

粘贴一条视频分享链接，服务端把里面的**口播内容**转成带时间码的可编辑文案与 SRT 字幕。

**在线体验：<https://www.zehvo.com/douyin/>**

> 适合口播、访谈、讲知识类的视频；纯音乐或没人说话的内容提不出东西。

## 支持的平台

| 平台 | 解析方式 | 说明 |
|---|---|---|
| 抖音 | 原生接口 | App 里「分享 → 复制链接」的整段口令都能直接粘 |
| 快手 | 原生接口 | 认 App 分享出来的短链；网页版 `www.kuaishou.com/short-video/…` 这种短 ID 解析不了 |
| 哔哩哔哩 | 原生接口 | 只取第一个分 P；番剧、付费课程等需要登录的内容不支持 |
| 其他站点 | 通用引擎 [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 西瓜视频、AcFun、网易云、百度视频等由它识别；境外站点在国内机房基本连不上 |
| 小红书 / 微博 / 视频号 | 不支持 | 前两者需要登录态，视频号接口不对外开放 —— 已被显式拦下并说明原因，不会白扣额度 |

**为什么前三个平台自己写解析**：B 站的通用引擎 extractor 在机房 IP 下会返回 `HTTP Error 412` 风控，原生接口更稳；抖音的直链也需要特定的 Cookie 流程。能自己调接口就自己调，剩下的交给 yt-dlp。

## 特性

- **运行时零第三方依赖**：Node 原生 `http` / `fetch`，除系统自带的 `ffmpeg` / `ffprobe` 外不需要装任何包
- **前端单文件自包含**：CSS/JS 全内联、无外链资源，天然支持挂在任意子路径（`/任意前缀/`）
- **两种语音识别模式**：站点自带密钥（访客免填，带双额度闸）或使用者自带 Key（服务端不持有任何密钥）
- **先校验再下载**：时长与体积超限在解析阶段就拒绝，不浪费带宽和识别额度
- **失败退额度**：任务在语音识别之前失败，已扣的站点额度会退回
- **防 SSRF**：接口地址由前端传入，因此强制 https、拒 IP 字面量、走域名白名单

## 工作原理

```
分享链接
   │
   ├─ 1. 识别平台（原生 / 通用引擎 / 明确不支持）
   ├─ 2. 解析取直链
   ├─ 3. 校验时长与体积  ── 超限直接拒绝，不下载
   ├─ 4. 下载 + ffmpeg 抽 16kHz 单声道音轨，按 30s 切片
   ├─ 5. 并发提交语音识别（失败可重试）
   └─ 6. 合并断句 → 段落 + 时间码 + SRT 字幕
```

前端提交后拿到 `jobId`，轮询进度直到 `done`，因此长视频也不会把连接吊死。

## 快速开始

**依赖**：Node.js ≥ 20（需要内置 `fetch`）、`ffmpeg` 与 `ffprobe`。要让通用引擎生效再装一个 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 可执行文件。

```bash
git clone https://github.com/liuyihua2015/video-transcript.git
cd video-transcript

cp .env.example .env          # 至少填 ASR_API_KEY，或留空改用「自带 Key」模式
npm start                     # 等价于 node --env-file-if-exists=.env server/index.js
```

打开 <http://localhost:3000> 即可。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 监听地址 |
| `ASR_API_KEY` | 空 | **留空**则进入「使用者自带 Key」模式，服务端不持有任何密钥；**填了**则访客免填，但受下面两道额度闸限制 |
| `ASR_BASE_URL` | `https://api.siliconflow.cn/v1` | 语音识别接口地址，需在域名白名单内 |
| `ASR_MODEL` | `FunAudioLLM/SenseVoiceSmall` | 识别模型 |
| `ASR_LANGUAGE` | 空 | 留空自动识别语种，固定中文可填 `zh` |
| `ASR_CONCURRENCY` | `3` | 并发提交的切片数，免费额度受限时建议降到 2–3 |
| `ASR_EXTRA_HOSTS` | 空 | 追加接口地址白名单，逗号分隔，支持 `*.example.com` |
| `SITE_KEY_PER_IP_HOURLY` | `10` | 单 IP 每小时可用站点密钥的次数 |
| `SITE_KEY_DAILY_TOTAL` | `100` | 全站每天的总次数 |
| `SEGMENT_SECONDS` | `30` | 音频切片长度（秒），越短越准但请求数越多 |
| `MAX_VIDEO_SECONDS` | `1800` | 单视频时长上限 |
| `MAX_VIDEO_MB` | `300` | 单视频体积上限 |
| `MAX_CONCURRENT_JOBS` | `4` | 同时处理的任务数 |
| `YTDLP_PATH` | — | yt-dlp 可执行文件路径 |
| `YTDLP_COOKIES` | 空 | 需要登录态站点的 cookies.txt。**这会让服务端以你的账号身份请求，请只在自己的服务器上用** |

## HTTP 接口

| 方法与路径 | 说明 |
|---|---|
| `POST /api/extract` | 提交任务。请求体 `{ "url": "分享链接或口令", "asr": {…} }`，`asr` 可省略（表示用站点密钥）。返回 `{ jobId }` |
| `GET /api/job/:id` | 查询进度或结果。字段：`status`、`stage`、`progress`、`result`（`paragraphs` / `srt` / `text` / `video` / `stats`）、`error`、`refunded`、`siteQuota` |
| `POST /api/asr/test` | 测试语音识别凭据是否可用 |
| `GET /api/health` | 健康检查：平台清单、限额、额度余量、yt-dlp 版本 |

## 部署

仓库自带 `Dockerfile` 与 `docker-compose.yml`。容器只提供 HTTP 服务，反向代理与 TLS 由外层 nginx 负责。

```bash
cp deploy/.env.local.example deploy/.env.local   # 填 DY_HOST / DY_REMOTE（该文件已被 gitignore）
./deploy/remote-deploy.sh          # 打包上传 + 重建镜像 + 启动 + 健康检查
./deploy/remote-deploy.sh hot      # 日常发布：只传代码 + 重启容器（秒级）
./deploy/remote-deploy.sh sync-env # 只同步 .env
./deploy/remote-deploy.sh logs     # 看容器日志
```

`deploy/nginx-*.conf` 是接入既有站点的 nginx 片段（子路径方式，不需要改 DNS）。

两个容易踩的点，脚本里已经处理：

- **改代码必须重启容器**：`server/`、`public/` 是只读挂载，只传文件不重启不会生效
- **`env_file` 只在创建容器时读取**：改完 `.env` 单独 `docker restart` 拿不到新变量，必须让 compose 重建容器

### 自动发布（可选，标签触发）

服务器上挂一个 systemd timer，每 5 分钟检查一次本仓库。**只有打了发布标签（`deploy-*`）的提交才会上线 —— 普通 `git push` 到 `main` 不会发布**，上线因此是一次有意识的动作，而不是每次提交的副作用。

**整条链路不需要任何密钥** —— 仓库是公开的，服务器只做只读拉取，不落私钥、也不用 GitHub Secrets。

```bash
# 一次性安装（在服务器上执行）
sudo git clone https://github.com/liuyihua2015/video-transcript.git /opt/video-transcript-src
sudo cp /opt/video-transcript-src/deploy/systemd/*.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now video-transcript-autodeploy.timer

# 手动触发一次 / 看日志 / 看当前线上版本
sudo systemctl start video-transcript-autodeploy.service
journalctl -u video-transcript-autodeploy -n 50
cat /var/lib/video-transcript-autodeploy/last-good   # 第一行 = 提交 SHA，第二行 = 标签名
```

要发布一个新版本，在本地跑：

```bash
./deploy/release.sh                 # 自动命名 deploy-YYYYMMDD-HHMM
./deploy/release.sh deploy-1.2.0    # 或自己起名（必须以 deploy- 开头）
```

脚本会先确认「本地 = `origin/main`」（服务器只拉得到远端已有的提交），再打 annotated tag 推上去。标签推上去后服务器几分钟内自动上线。

`deploy/auto-deploy.sh` 的流程：列出远端发布标签 → **从新到旧逐个校验** → `rsync` 同步代码 → 在旧容器里对新代码做**语法自检** → 重启容器 → 健康检查 → **失败自动回滚到上一个正常版本**。

几条刻意守住的安全边界：

- **发布必须显式打标签**：没打标签的提交永远不上线，`main` 上可以放心攒改动
- **只同步 `server/` 与 `public/`**：容器只挂载这两个目录，别的文件（`.env` / `bin/` / `deploy/` / `docker-compose.yml`）根本不在同步范围内，也就不存在「exclude 写错误删」这类问题
- **只前进不回退**：候选版本必须是当前线上版本的后代，自动发布不会把线上退回旧提交（回退只由「失败回滚」触发）
- **未并入主干的标签不发**：标签指向的提交必须是 `main` 的祖先
- **失败过的版本不再重试**：回滚后记进 `last-failed`，等新标签，否则每 5 分钟撞一次同样的墙
- 只重启本容器，**不碰 nginx、不碰同机其他项目的目录**
- 不重建镜像，因此不会触发 apk 安装那 5–6 分钟
- ⚠️ 脚本以 root 运行、执行的又是仓库里的代码 —— **仓库的可写权限等于本机的 root 权限**。不要给仓库加协作者，也不要在 `main` 上放开让他人直推

### 取源与自更新

国内机房直连 `github.com` 实测基本连不上（多个官方 IP 全部超时），所以脚本按下面的顺序拿代码：

1. **先问两个加速镜像**（`ghfast.top` / `gh-proxy.com`）。两者都支持 git smart-http，正常情况下几秒就够，不需要去等直连超时。
2. **要求两个镜像给出的 SHA 一致**才采用 —— 脚本以 root 运行、执行的又是拉下来的代码，让「单一来源说了算」等于把 root 交给对方。两个独立镜像互相印证是这里唯一有效的兜底。
3. 镜像没能取得一致时，**回头问直连要权威答案**；直连也不可用才降级用单一镜像，并在日志里明确告警。

另外脚本运行中会 `git reset --hard` 更新自己所在的检出目录，而 bash 是边读边执行的 —— 直接执行源文件会出现「执行到一半内容被换掉」。所以 systemd 单元先把脚本 `install` 到 `/usr/local/lib/` 再执行，**本轮跑的是上一轮已校验过的版本**。

排查：

```bash
systemctl status video-transcript-autodeploy.service    # 上次结果
journalctl -u video-transcript-autodeploy -n 50         # 日志
sudo systemctl start video-transcript-autodeploy.service # 手动触发
cat /var/lib/video-transcript-autodeploy/last-good       # 当前线上版本（提交 SHA + 标签名）
cat /var/lib/video-transcript-autodeploy/last-failed     # 上次发布失败、已自动回滚的版本
```

## 限制与已知问题

- 单视频 **≤ 30 分钟 / 300 MB**，超限在解析阶段就拒绝
- **额度计数在内存里**，容器重启即清零；要做严格每日限额需要落盘或接 Redis
- 只处理**口播与知识类**内容，纯音乐 / 无口播视频没有提取意义
- 平台接口随时可能调整（尤其抖音依赖一套 Cookie 流程），失效时优先查解析模块
- 境外站点（YouTube 等）在国内机房基本访问不了，会报「访问该站点超时」，属于预期

## 免责声明

本项目仅供**个人学习与内容整理**使用。请遵守目标平台的服务条款与著作权法律法规，不要用于批量抓取、二次分发或任何商业性复制他人内容的行为；使用者需自行承担合规责任。

## License

[MIT](LICENSE)
