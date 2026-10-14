// 通用引擎：把「本仓库没写原生解析」的站点交给 yt-dlp
//
// yt-dlp 的二进制由部署脚本下载到宿主机 <发布目录>/bin/yt-dlp，再以只读方式挂进容器，
// 这样升级 yt-dlp 只需换一个文件，不用重建镜像（见 deploy/remote-deploy.sh update-ytdlp）。
//
// 现实提醒：yt-dlp 对国内平台并不总是灵。实测 B 站 wbi 接口返回 412、
// 西瓜视频要求登录 Cookie——所以国内主流平台一律走本仓库的原生解析器，
// yt-dlp 只做长尾兜底。失败时会给出「是站点限制还是网络不通」的判断。

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from './util.js';

const execFileAsync = promisify(execFile);

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const COOKIES = process.env.YTDLP_COOKIES || '';
/** 只要人声，优先纯音频；其次取不超过 480p 的合并流 */
const FORMAT = process.env.YTDLP_FORMAT || 'ba/b[height<=480]/b';

export function ytdlpPath() {
  return YTDLP;
}

export function ytdlpCookies() {
  return COOKIES;
}

/** 字节 -> 人话 */
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)}MB`;
  return `${Math.max(1, Math.round(n / 1024))}KB`;
}

let versionCache = null;

export async function ytdlpVersion() {
  if (versionCache) return versionCache;
  try {
    const { stdout } = await execFileAsync(YTDLP, ['--version'], { timeout: 10000 });
    versionCache = String(stdout).trim();
  } catch {
    versionCache = '';
  }
  return versionCache;
}

export async function ytdlpAvailable() {
  return Boolean(await ytdlpVersion());
}

function baseArgs({ quick = false } = {}) {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--socket-timeout',
    quick ? '15' : '20',
    '--retries',
    quick ? '1' : '2',
  ];
  if (COOKIES) args.push('--cookies', COOKIES);
  return args;
}

/** yt-dlp 的英文报错 -> 使用者能看懂的中文 */
export function friendlyYtdlpError(errOrMessage) {
  const err = typeof errOrMessage === 'object' && errOrMessage ? errOrMessage : null;
  const stderr = String(err?.stderr || '').trim();
  const raw = stderr || String(err?.message || errOrMessage || '');
  // execFile 超时会杀掉进程，此时没有 stderr，只能靠 killed/signal 判断
  if (err?.killed || err?.signal === 'SIGTERM') {
    return '访问该站点超时。若它是境外站点，多半是服务器网络到不了，换国内平台试试';
  }

  const msg = raw;
  if (/Unsupported URL|No suitable extractor/i.test(msg)) return 'yt-dlp 不认识这个站点，暂时解析不了';
  if (/Cookies|login|Sign in|Private video|This video is only available|not necessarily logged in/i.test(msg)) {
    return '该站点要求登录后才能取到音轨，本工具不保存账号凭据，暂时解析不了';
  }
  if (/larger than max-filesize/i.test(msg)) return '文件体积超过上限，已中止下载';
  if (/timed out|Temporary failure in name resolution|Connection refused|unable to resolve|Network is unreachable|EOF occurred/i.test(msg)) {
    return '服务器访问该站点失败。若它是境外站点，多半是服务器网络到不了，换国内平台试试';
  }
  if (/Video unavailable|not available|HTTP Error 40[0-9]|HTTP Error 41[0-9]/.test(msg)) {
    return '作品不存在、已删除，或需要登录才能查看';
  }
  // 兜底：去掉 execFile 的 Command failed 前缀，只留 yt-dlp 自己那行
  const line = msg
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !/^Command failed:/.test(s))
    .pop() || '';
  return line.replace(/^ERROR:\s*/i, '').slice(0, 200) || '解析失败';
}

/** 读取作品元信息（不下载） */
export async function ytdlpProbe(url, { timeoutMs = 60000 } = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(YTDLP, [...baseArgs({ quick: true }), '-J', url], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (err) {
    throw new Error(friendlyYtdlpError(err));
  }
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error('yt-dlp 返回的数据无法解析');
  }
  // 播放列表/合集：只取第一条
  if (info?._type === 'playlist' || Array.isArray(info?.entries)) {
    info = (info.entries || []).find(Boolean) || null;
    if (!info) throw new Error('这是一个空合集，没有可处理的视频');
  }

  return {
    title: info.title || info.fulltitle || '',
    author: info.uploader || info.channel || info.creator || '',
    thumbnail: info.thumbnail || '',
    duration: Number(info.duration || 0),
    extractor: info.extractor_key || info.extractor || '',
    webpageUrl: info.webpage_url || url,
    isLive: Boolean(info.is_live),
  };
}

/** 下载媒体到指定目录，返回实际落地的文件 */
export async function ytdlpDownload(url, workDir, { timeoutMs = 300000, maxBytes = 0 } = {}) {
  const outTemplate = path.join(workDir, 'media.%(ext)s');
  const args = [...baseArgs(), '-f', FORMAT, '-o', outTemplate];
  if (maxBytes > 0) args.push('--max-filesize', String(Math.floor(maxBytes)));
  args.push(url);

  let output = '';
  try {
    const r = await execFileAsync(YTDLP, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    // max-filesize 命中时 yt-dlp 把提示打到 stdout 且退出码仍是 0，所以两个流都要看
    output = `${r.stdout || ''}\n${r.stderr || ''}`;
  } catch (err) {
    throw new Error(friendlyYtdlpError(err));
  }

  const files = (await fs.readdir(workDir)).filter((f) => f.startsWith('media.'));
  if (!files.length) {
    if (/max-filesize/i.test(output)) {
      throw new Error(`文件体积超过上限（${humanSize(maxBytes)}），已中止下载`);
    }
    throw new Error(friendlyYtdlpError(output) || 'yt-dlp 没有产出媒体文件，可能是直播流或加密内容');
  }
  const file = path.join(workDir, files[0]);
  const bytes = (await fs.stat(file)).size;
  if (bytes < 10 * 1024) throw new Error('下载到的文件体积异常，可能触发了站点风控');
  log(`yt-dlp downloaded ${(bytes / 1024 / 1024).toFixed(2)} MB -> ${path.basename(file)}`);
  return { file, bytes };
}
