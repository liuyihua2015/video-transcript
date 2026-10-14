// 视频文案提取 · 服务端
// 零第三方依赖，只用 Node 内置模块（Node >= 18，推荐 20+）
// 支持平台见 server/platforms.js：抖音 / 快手 / 哔哩哔哩为原生解析，其余交给 yt-dlp 兜底。

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { detectPlatform, platformList } from './platforms.js';
import { checkDuration, checkSize, limits, resolveSource } from './resolve.js';
import { assertFfmpeg, cleanupDir, downloadVideo, extractAudioSegments, makeSilenceClip } from './audio.js';
import { ytdlpDownload, ytdlpVersion } from './ytdlp.js';
import { pickUrl } from './util.js';
import {
  asrConfig,
  allowedHosts,
  mergeIntoParagraphs,
  toPlainText,
  toSrt,
  transcribeFile,
  transcribeSegments,
} from './asr.js';
import { log } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SEGMENT_SECONDS = Math.max(10, Math.min(60, Number(process.env.SEGMENT_SECONDS || 30)));
const JOB_TTL = 30 * 60 * 1000;

/** 内存任务表：单机工具站够用，重启即清空 */
const jobs = new Map();

function createJob() {
  const id = randomUUID();
  jobs.set(id, {
    id,
    status: 'queued',
    stage: 'queued',
    message: '排队中…',
    progress: 0,
    createdAt: Date.now(),
    result: null,
    error: null,
  });
  return jobs.get(id);
}

function updateJob(job, patch) {
  Object.assign(job, patch);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL) jobs.delete(id);
  }
  for (const [ip, hits] of siteIpHits) {
    const alive = hits.filter((t) => now - t < HOUR_MS);
    if (alive.length) siteIpHits.set(ip, alive);
    else siteIpHits.delete(ip);
  }
}, 5 * 60 * 1000).unref?.();

// ---------- 站点自带密钥的额度保护 ----------
// 站点一旦配上 ASR_API_KEY，任何拿到网址的人都能用它消耗额度（如果哪天换成收费模型就是真金白银）。
// 所以开两道闸，且只在「使用站点密钥」的请求上计数：
//   1) 单 IP 每小时的次数上限 —— 防单点刷；
//   2) 站点每日总次数上限 —— 防被当成免费转写服务长期薅。
// 使用者自带 Key 的请求完全不受此限制。
const HOUR_MS = 3600 * 1000;
const SITE_KEY_PER_IP_HOURLY = Math.max(1, Number(process.env.SITE_KEY_PER_IP_HOURLY || 10));
const SITE_KEY_DAILY_TOTAL = Math.max(1, Number(process.env.SITE_KEY_DAILY_TOTAL || 100));

/** 东八区日期，容器时区是 UTC 也按国内习惯翻页 */
function dayKey(offsetMs = 0) {
  return new Date(Date.now() + 8 * HOUR_MS + offsetMs).toISOString().slice(0, 10);
}

let siteDaily = { day: dayKey(), used: 0 };
/** ip -> 最近一小时的调用时间戳 */
const siteIpHits = new Map();

function rollDaily() {
  const today = dayKey();
  if (siteDaily.day !== today) siteDaily = { day: today, used: 0 };
}

function msUntilDailyReset() {
  const now = Date.now();
  const nextMidnight = (Math.floor((now + 8 * HOUR_MS) / 86400000) + 1) * 86400000 - 8 * HOUR_MS;
  return nextMidnight - now;
}

/** 经 nginx 反代时真实客户端 IP 在 X-Forwarded-For 的第一段 */
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'unknown';
}

/** 查看额度（不消耗）。顺带清掉过期的按 IP 计数 */
function siteQuota(ip) {
  rollDaily();
  const now = Date.now();
  const hits = (siteIpHits.get(ip) || []).filter((t) => now - t < HOUR_MS);
  if (hits.length) siteIpHits.set(ip, hits);
  else siteIpHits.delete(ip);
  return {
    perIpHourlyLimit: SITE_KEY_PER_IP_HOURLY,
    perIpUsed: hits.length,
    perIpRemaining: Math.max(0, SITE_KEY_PER_IP_HOURLY - hits.length),
    dailyLimit: SITE_KEY_DAILY_TOTAL,
    dailyUsed: siteDaily.used,
    dailyRemaining: Math.max(0, SITE_KEY_DAILY_TOTAL - siteDaily.used),
    resetInMinutes: Math.ceil(msUntilDailyReset() / 60000),
  };
}

/** 扣一次额度；扣不动就返回中文原因，交给调用方回 429 */
function consumeSiteQuota(ip) {
  const q = siteQuota(ip);
  if (q.dailyRemaining <= 0) {
    return {
      ok: false,
      error: `本站今日的公共识别额度已用完（每天 ${q.dailyLimit} 次，约 ${Math.ceil(q.resetInMinutes / 60)} 小时后恢复），可以先换成你自己的 API Key 继续用`,
      quota: q,
    };
  }
  if (q.perIpRemaining <= 0) {
    return {
      ok: false,
      error: `同一台设备一小时内已使用站点服务 ${q.perIpHourlyLimit} 次，为避免挤占公共额度请稍后再试，或换成你自己的 API Key`,
      quota: q,
    };
  }
  const hits = siteIpHits.get(ip) || [];
  hits.push(Date.now());
  siteIpHits.set(ip, hits);
  siteDaily.used++;
  return { ok: true, quota: siteQuota(ip) };
}

/**
 * 退还一次额度。只用在「还没打到上游 ASR 就失败」的场景（解析/下载/抽音频）。
 * 这些失败对站点没有任何上游开销，扣了额度就是白扣；
 * 一旦进入 asr 阶段就不再退——那时请求已经真的发出去了。
 */
function refundSiteQuota(ip) {
  const now = Date.now();
  const hits = (siteIpHits.get(ip) || []).filter((t) => now - t < HOUR_MS);
  if (hits.length) {
    hits.pop(); // 撤掉最近一次
    if (hits.length) siteIpHits.set(ip, hits);
    else siteIpHits.delete(ip);
  }
  rollDaily();
  if (siteDaily.used > 0) siteDaily.used--;
}

const STAGES = [
  { key: 'parse', label: '解析链接', progress: 12 },
  { key: 'download', label: '获取媒体', progress: 35 },
  { key: 'audio', label: '提取音频', progress: 52 },
  { key: 'asr', label: '语音识别', progress: 70 },
  { key: 'merge', label: '整理文案', progress: 96 },
];

/** 按平台把媒体文件取到工作目录 */
async function fetchMedia(meta, workDir) {
  const maxBytes = limits().maxMb * 1024 * 1024;
  if (meta.direct?.url) {
    const dest = path.join(workDir, `media${meta.direct.ext || '.mp4'}`);
    const bytes = await downloadVideo(meta.direct.url, dest, {
      headers: meta.direct.headers || {},
      maxBytes,
    });
    checkSize(bytes);
    return dest;
  }
  const { file, bytes } = await ytdlpDownload(meta.webUrl, workDir, { maxBytes });
  checkSize(bytes);
  return file;
}

function downloadMessage(meta) {
  if (meta.direct?.ext === '.m4s') return '正在下载音轨…';
  if (meta.direct) return '正在下载视频…';
  return '正在用通用引擎获取媒体…';
}

async function runPipeline(job, platform, inputUrl, cfg) {
  const workDir = path.join(os.tmpdir(), 'video-transcript', job.id);
  const startedAt = Date.now();
  await fs.mkdir(workDir, { recursive: true });

  try {
    // 1. 解析链接
    updateJob(job, { status: 'running', stage: 'parse', message: '正在解析链接…', progress: STAGES[0].progress });
    const meta = await resolveSource(inputUrl, platform);
    checkDuration(meta);

    // 2. 获取媒体
    updateJob(job, {
      stage: 'download',
      message: downloadMessage(meta),
      progress: STAGES[1].progress,
      preview: {
        desc: meta.desc,
        author: meta.author,
        cover: meta.cover,
        duration: meta.duration,
        source: meta.sourceLabel,
        webUrl: meta.webUrl,
      },
    });
    const mediaFile = await fetchMedia(meta, workDir);

    // 3. 抽音频 + 切片
    updateJob(job, { stage: 'audio', message: '正在提取音频…', progress: STAGES[2].progress });
    const { segments, totalDuration } = await extractAudioSegments(mediaFile, workDir, {
      segmentSeconds: SEGMENT_SECONDS,
    });
    if (meta.duration) {
      // 解析出的时长与实际音轨差太多，说明前面拿到的是预览片而不是完整作品
      if (totalDuration < meta.duration * 0.5 && meta.duration - totalDuration > 20) {
        log(`warn: 音轨 ${totalDuration.toFixed(1)}s 远短于声明时长 ${meta.duration}s`);
      }
    } else {
      meta.duration = Math.round(totalDuration);
    }
    const video = {
      desc: meta.desc,
      author: meta.author,
      cover: meta.cover,
      duration: meta.duration,
      source: meta.sourceKey,
      sourceLabel: meta.sourceLabel,
      webUrl: meta.webUrl,
      platform: meta.sourceKey,
    };

    // 4. 语音识别
    updateJob(job, {
      stage: 'asr',
      message: `语音识别中（${segments.length} 段）…`,
      progress: STAGES[3].progress,
      asr: { model: cfg.model, total: segments.length, done: 0, keySource: cfg.source },
    });
    const rawSegments = await transcribeSegments(segments, cfg, (done, total) => {
      updateJob(job, {
        progress: Math.round(STAGES[3].progress + (STAGES[4].progress - STAGES[3].progress) * (done / total)),
        message: `语音识别中 ${done}/${total}…`,
        asr: { model: cfg.model, total, done, keySource: cfg.source },
      });
    });

    // 5. 合并成段
    updateJob(job, { stage: 'merge', message: '正在整理文案…', progress: STAGES[4].progress });
    const paragraphs = mergeIntoParagraphs(rawSegments);
    const plain = toPlainText(paragraphs);
    if (!plain.trim()) {
      throw new Error('识别结果为空，视频里可能没有说话声（纯音乐或纯画面）');
    }

    updateJob(job, {
      status: 'done',
      stage: 'done',
      message: '完成',
      progress: 100,
      result: {
        video,
        paragraphs,
        text: plain,
        srt: toSrt(paragraphs),
        stats: {
          charCount: plain.replace(/\s/g, '').length,
          paragraphCount: paragraphs.length,
          elapsedMs: Date.now() - startedAt,
          asrModel: cfg.model,
          keySource: cfg.source,
        },
      },
    });
  } catch (err) {
    log('job failed:', err?.message || err);
    const raw = err?.message || '处理失败';
    // 只有语音识别阶段的报错才做「401 -> 密钥无效」这类翻译，
    // 否则会误伤「视频下载失败：HTTP 403」这种同样带状态码的错误
    const friendly = job.stage === 'asr' ? friendlyAsrError(raw) : raw;

    // 解析 / 下载 / 抽音频阶段失败 = 从没请求过上游 ASR，退掉这次额度
    let refunded = false;
    if (job.quotaIp && job.stage !== 'asr' && job.stage !== 'merge') {
      refundSiteQuota(job.quotaIp);
      refunded = true;
    }

    updateJob(job, {
      status: 'error',
      stage: 'error',
      message: refunded ? `${friendly}（本次未消耗站点额度）` : friendly,
      error: friendly,
      refunded,
      siteQuota: job.quotaIp ? siteQuota(job.quotaIp) : null,
    });
  } finally {
    cleanupDir(workDir);
  }
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** 从请求体里取出使用者自带的语音识别配置（做长度与类型收敛，避免脏数据） */
function readAsrInput(body) {
  const raw = body && typeof body.asr === 'object' && body.asr ? body.asr : {};
  return {
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim().slice(0, 512) : '',
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().slice(0, 300) : '',
    model: typeof raw.model === 'string' ? raw.model.trim().slice(0, 200) : '',
  };
}

/** 把上游报错翻译成使用者看得懂的话 */
function friendlyAsrError(message) {
  const msg = String(message || '');
  if (/\b(401|403)\b/.test(msg)) return '密钥无效，或这个账号没有该模型的权限，请检查 Key 是否填写正确';
  if (/\b429\b/.test(msg)) return '请求太频繁或额度已用完，稍等一会儿再试';
  if (/\b404\b/.test(msg)) return '接口地址或模型名不对，请检查「接口地址」与「模型」两项';
  if (/abort|timeout/i.test(msg)) return '连接语音识别接口超时，请检查网络或稍后重试';
  return msg || '语音识别失败';
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    // SPA 兜底
    try {
      const html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(html);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      const cfg = asrConfig();
      return sendJson(res, 200, {
        ok: true,
        // 站点是否自带密钥：有的话前端默认走「站点服务」，访客不用填任何东西
        asrServerConfigured: cfg.enabled,
        asrModel: cfg.model,
        asrBaseUrl: cfg.baseUrl,
        asrAllowedHosts: allowedHosts(),
        // 站点密钥的剩余额度（按请求方 IP 计算；未配密钥时为 null）
        siteQuota: cfg.enabled ? siteQuota(clientIp(req)) : null,
        segmentSeconds: SEGMENT_SECONDS,
        // 支持平台与限制：前端直接渲染，不再硬编码一份
        platforms: platformList(),
        limits: limits(),
        ytdlpVersion: await ytdlpVersion(),
        runningJobs: [...jobs.values()].filter((j) => j.status === 'running').length,
        uptime: Math.round(process.uptime()),
      });
    }

    if (req.method === 'POST' && pathname === '/api/extract') {
      const body = await readBody(req);
      const input = String(body.url || '').trim();
      if (!input) return sendJson(res, 400, { error: '请粘贴视频链接或分享口令' });
      const target = pickUrl(input);
      if (!target) return sendJson(res, 400, { error: '没识别到链接，请粘贴完整的分享内容' });

      // 平台先判掉：不支持的域名在解析阶段必然失败，
      // 放它进流水线既会白跑一遍，还会占掉一次站点额度
      const platform = detectPlatform(target);
      if (!platform) {
        return sendJson(res, 400, { error: '只认 http/https 链接，请粘贴视频地址或 App 分享出来的内容' });
      }
      if (platform.unsupported) {
        return sendJson(res, 400, { error: platform.reason });
      }

      // 语音识别凭据：优先用请求里带的（使用者自带 Key），否则回落到服务端 .env
      let cfg;
      try {
        cfg = asrConfig(readAsrInput(body));
      } catch (err) {
        return sendJson(res, 400, { error: err?.message || '语音识别配置不正确' });
      }
      if (!cfg.enabled) {
        return sendJson(res, 400, {
          error: '站点没有配置公共识别密钥。请在页面「语音识别设置」里填入你自己的 API Key（只保存在你的浏览器里）',
          needAsrKey: true,
        });
      }

      // 用的是站点自己的密钥 —— 先过额度闸，避免公共额度被单人刷空
      const ip = clientIp(req);
      let quotaAfter = null;
      if (cfg.source === 'server') {
        const gate = consumeSiteQuota(ip);
        if (!gate.ok) {
          return sendJson(res, 429, {
            error: gate.error,
            quotaExceeded: true,
            needAsrKey: true,
            siteQuota: gate.quota,
          });
        }
        quotaAfter = gate.quota;
      }

      const active = [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length;
      if (active >= Number(process.env.MAX_CONCURRENT_JOBS || 4)) {
        return sendJson(res, 429, { error: '当前排队任务过多，请稍后再试' });
      }

      const job = createJob();
      job.keySource = cfg.source;
      // 记下扣额度的是谁：任务在 ASR 之前失败时按此退还
      if (cfg.source === 'server') job.quotaIp = ip;
      runPipeline(job, platform, target, cfg).catch((err) => log('pipeline crashed:', err));
      return sendJson(res, 202, {
        jobId: job.id,
        keySource: cfg.source,
        // 站点服务模式下把扣完的额度一并带回，前端不用再打一次 health
        siteQuota: quotaAfter,
        stages: STAGES.map((s) => ({ key: s.key, label: s.label })),
      });
    }

    if (req.method === 'POST' && pathname === '/api/asr/test') {
      const body = await readBody(req);
      let cfg;
      try {
        cfg = asrConfig(readAsrInput(body));
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err?.message || '语音识别配置不正确' });
      }
      if (!cfg.enabled) {
        return sendJson(res, 400, { ok: false, error: '请先填写 API Key', needAsrKey: true });
      }

      // 测试站点服务同样会打一次上游，占用的是同一个额度
      if (cfg.source === 'server') {
        const gate = consumeSiteQuota(clientIp(req));
        if (!gate.ok) {
          return sendJson(res, 429, {
            ok: false,
            error: gate.error,
            quotaExceeded: true,
            needAsrKey: true,
            siteQuota: gate.quota,
          });
        }
      }

      const dir = path.join(os.tmpdir(), 'douyin-transcript', `asr-test-${randomUUID()}`);
      await fs.mkdir(dir, { recursive: true });
      try {
        const clip = path.join(dir, 'silence.mp3');
        await makeSilenceClip(clip);
        await transcribeFile(clip, cfg, { timeoutMs: 30000 });
        return sendJson(res, 200, {
          ok: true,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          keySource: cfg.source,
          siteQuota: cfg.source === 'server' ? siteQuota(clientIp(req)) : null,
        });
      } catch (err) {
        log('asr test failed:', err?.message || err);
        return sendJson(res, 400, { ok: false, error: friendlyAsrError(err?.message) });
      } finally {
        cleanupDir(dir);
      }
    }

    if (req.method === 'GET' && pathname.startsWith('/api/job/')) {
      const id = pathname.split('/').pop();
      const job = jobs.get(id);
      if (!job) return sendJson(res, 404, { error: '任务不存在或已过期，请重新提交' });
      return sendJson(res, 200, {
        id: job.id,
        status: job.status,
        stage: job.stage,
        message: job.message,
        progress: job.progress,
        asr: job.asr || null,
        // 本次用的谁的密钥：server=站点自带，client=使用者自带。前端据此显示来源
        keySource: job.keySource || null,
        preview: job.preview || null,
        result: job.result,
        error: job.error,
        // 失败且没打到上游 ASR 时已退还额度，前端可据此刷新剩余额度
        refunded: job.refunded === true,
        siteQuota: job.quotaIp ? siteQuota(job.quotaIp) : null,
      });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }

    sendJson(res, 405, { error: 'Method Not Allowed' });
  } catch (err) {
    log('server error:', err);
    sendJson(res, 500, { error: err?.message || '服务器错误' });
  }
});

await assertFfmpeg().catch((err) => log('WARN:', err.message));

server.listen(PORT, HOST, () => {
  const cfg = asrConfig();
  const lim = limits();
  log(`视频文案提取服务已启动 → http://localhost:${PORT}`);
  log(`原生解析：${platformList().map((p) => p.label).join(' / ')}；其余站点交给 yt-dlp 兜底`);
  log(
    cfg.enabled
      ? `语音识别：${cfg.model}｜站点自带密钥，访客免填（限额 ${SITE_KEY_PER_IP_HOURLY} 次/小时/IP，全天 ${SITE_KEY_DAILY_TOTAL} 次）`
      : `语音识别：${cfg.model}｜站点未配密钥，由使用者在页面上自带 Key`
  );
  log(`接口地址白名单：${allowedHosts().join(', ')}`);
  log(`音频切片：每段 ${SEGMENT_SECONDS}s｜上限：${lim.maxMinutes} 分钟 / ${lim.maxMb}MB`);
  ytdlpVersion().then((v) => log(v ? `yt-dlp：${v}` : 'yt-dlp：不可用（只有原生解析的三个平台可解析）'));
});

// tag-gate-check-170306
