// 解析调度：链接 -> 统一的作品信息 + 一个「怎么把媒体文件拿下来」的约定
//
// 统一返回形状：
// {
//   sourceKey, sourceLabel,      // 平台标识与展示名
//   desc, author, cover,         // 作品信息
//   duration,                    // 秒（0 表示未知）
//   webUrl,                      // 网页地址，通用引擎也用它去下载
//   direct: { url, ext, headers } | null   // 直链；为 null 时交给 yt-dlp
// }
//
// 时长与体积上限集中在这里，三个原生解析器与 yt-dlp 走同一套规则。

import { detectPlatform } from './platforms.js';
import { parseDouyinShare } from './douyin.js';
import { parseBilibili } from './bilibili.js';
import { parseKuaishou } from './kuaishou.js';
import { ytdlpProbe } from './ytdlp.js';

const MAX_SECONDS = Math.max(10, Number(process.env.MAX_VIDEO_SECONDS || 1800)); // 30 分钟
const MAX_MB = Math.max(1, Number(process.env.MAX_VIDEO_MB || 300));

export function limits() {
  return { maxSeconds: MAX_SECONDS, maxMb: MAX_MB, maxMinutes: Math.round(MAX_SECONDS / 60) };
}

function humanDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`;
}

/** 时长超限就抛错；返回 null 表示放行 */
export function checkDuration(meta) {
  if (meta?.isLive) {
    throw new Error('这是一场直播，没有固定结束时间，无法转写。请等直播结束、有回放后再试');
  }
  const d = Number(meta?.duration || 0);
  if (d > MAX_SECONDS) {
    throw new Error(
      `视频时长 ${humanDuration(d)}，超过上限 ${humanDuration(MAX_SECONDS)}。` +
        `本工具只处理口播与知识类视频，电影、剧集、长直播这类内容请自行剪辑后再来`
    );
  }
  return null;
}

/** 下载完成后核对体积 */
export function checkSize(bytes) {
  const limit = MAX_MB * 1024 * 1024;
  if (bytes > limit) {
    throw new Error(`文件体积 ${(bytes / 1024 / 1024).toFixed(0)}MB，超过上限 ${MAX_MB}MB`);
  }
}

function fromDouyin(v) {
  return {
    sourceKey: 'douyin',
    sourceLabel: '抖音',
    desc: v.desc,
    author: v.author,
    cover: v.cover,
    duration: v.duration,
    webUrl: v.shareUrl,
    direct: { url: v.videoUrl, ext: '.mp4', headers: { Referer: 'https://www.douyin.com/' } },
  };
}

async function fromGeneric(url, platform) {
  const info = await ytdlpProbe(url);
  return {
    sourceKey: 'generic',
    sourceLabel: info.extractor || platform.label,
    desc: info.title,
    author: info.author,
    cover: info.thumbnail,
    duration: info.duration,
    webUrl: info.webpageUrl || url,
    isLive: info.isLive,
    direct: null,
  };
}

/**
 * 解析链接
 * @param {string} url 归一化后的 http(s) 链接
 */
export async function resolveSource(url, platform = detectPlatform(url)) {
  if (!platform) throw new Error('没识别到链接，请粘贴完整的分享内容');
  if (platform.unsupported) throw new Error(platform.reason);

  switch (platform.key) {
    case 'douyin':
      return fromDouyin(await parseDouyinShare(url));
    case 'kuaishou':
      return parseKuaishou(url);
    case 'bilibili':
      return parseBilibili(url);
    default:
      return fromGeneric(url, platform);
  }
}

export { detectPlatform };
