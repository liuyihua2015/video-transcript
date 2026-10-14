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
