// 抖音作品解析：分享文本 -> 作品元信息 + 可下载的视频直链
//
// 思路（不依赖签名算法，跟踪页面内嵌数据）：
//   1) 从分享文本里抓出 URL；
//   2) 短链跟随重定向，拿到 aweme_id；
//   3) 请求移动端分享页 https://www.iesdouyin.com/share/video/{id}/
//   4) 解析页面内 window._ROUTER_DATA，取 loaderData["video_(id)/page"].videoInfoRes.item_list[0]

import { fetchWithTimeout, pickUrl } from './util.js';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/**
 * 抖音从 2025 年起对无 Cookie 的分享页请求不再返回 SSR 数据。
 * 这里先向 ByteDance 的 ttwid 注册接口要一个匿名设备标识，随请求带上，页面就会正常输出作品 JSON。
 * ttwid 有效期较长，进程内缓存即可。
 */
let ttwidCache = { value: '', at: 0 };
const TTWID_TTL = 6 * 60 * 60 * 1000;

async function getTtwid() {
  const now = Date.now();
  if (ttwidCache.value && now - ttwidCache.at < TTWID_TTL) return ttwidCache.value;
  try {
    const res = await fetchWithTimeout(
      'https://ttwid.bytedance.com/ttwid/union/register/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': MOBILE_UA },
        body: JSON.stringify({
          region: 'cn',
          aid: 1768,
          needFid: false,
          service: 'www.ixigua.com',
          migrate_info: { ticket: '', source: 'node' },
          cbUrlProtocol: 'https',
          union: true,
        }),
      },
      12000
    );
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const hit = cookies.find((c) => c.startsWith('ttwid='));
    if (hit) {
      ttwidCache = { value: hit.split(';')[0], at: now };
      return ttwidCache.value;
    }
  } catch {
    /* 拿不到就裸请求，部分链接仍可成功 */
  }
  return '';
}

export { pickUrl };

/** 从各种抖音链接形态里取 aweme_id */
export function pickAwemeId(url) {
  if (!url) return null;
  const patterns = [
    /\/video\/(\d{6,})/,
    /\/share\/video\/(\d{6,})/,
    /[?&]modal_id=(\d{6,})/,
    /[?&]aweme_id=(\d{6,})/,
    /\/note\/(\d{6,})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

/** 短链展开：跟到最终地址（抖音短链会 302 到 iesdouyin 分享页或 douyin 视频页） */
async function expandShortUrl(url) {
  const res = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': MOBILE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    },
    15000
  );
  const body = await res.text().catch(() => '');
  return { finalUrl: res.url || url, body };
}

/** 括号配平截取从 `window._ROUTER_DATA =` 开始的 JSON 对象 */
function sliceJsonObject(html, anchor) {
  const at = html.indexOf(anchor);
  if (at < 0) return null;
  let i = html.indexOf('{', at);
  if (i < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let quote = '';
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(i, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 在任意层级的对象里兜底找 item_list */
function deepFindItemList(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node.item_list) && node.item_list.length) return node.item_list;
  for (const v of Object.values(node)) {
    const hit = deepFindItemList(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function firstUrl(list) {
  if (!Array.isArray(list)) return '';
  return list.find((u) => typeof u === 'string' && u.startsWith('http')) || '';
}

/** 从作品对象里挑出直链（优先 play_addr，清晰度取最低可用档以节省带宽） */
function pickPlayUrl(item) {
  // 只要音频，清晰度越低下载越快；360p 会被回落成 1080p，480p 是实测最小档
  const ratio = process.env.DOUYIN_RATIO || '480p';
  const uri = item?.video?.play_addr?.uri || item?.video?.play_addr?.url_key || '';
  const fromUrl = (firstUrl(item?.video?.play_addr?.url_list).match(/video_id=([^&]+)/) || [])[1];
  const videoId = uri || fromUrl;
  if (videoId) {
    return {
      url: `https://www.douyin.com/aweme/v1/play/?video_id=${videoId}&ratio=${ratio}&line=0`,
      videoId,
    };
  }
  for (const br of item?.video?.bit_rate || []) {
    const u = firstUrl(br?.play_addr?.url_list);
    if (u) return { url: u, videoId: '' };
  }
  return { url: firstUrl(item?.video?.play_addr?.url_list), videoId: '' };
}

/** 主入口：分享文本/链接 -> 归一化作品信息 */
export async function parseDouyinShare(input) {
  const raw = pickUrl(input);
  if (!raw) {
    throw new Error('没找到链接。请粘贴抖音分享内容或视频地址（形如 https://v.douyin.com/xxxx/）');
  }

  let awemeId = pickAwemeId(raw);
  let landingUrl = raw;

  if (!awemeId) {
    if (!/douyin\.com/i.test(raw)) {
      // 正常情况下平台上识别阶段就会把非抖音链接分流走，走到这里说明链接形态比较特殊
      throw new Error('这不是抖音链接。请粘贴抖音 App 分享出来的内容，或 https://www.douyin.com/video/xxx 形式的地址');
    }
    const { finalUrl, body } = await expandShortUrl(raw);
    landingUrl = finalUrl;
    awemeId = pickAwemeId(finalUrl) || pickAwemeId(body);
    if (!awemeId) {
      // 有些短链最终落到 www.douyin.com/video/xxx 之外的形态，再从正文里捞一次
      const fromBody = body.match(/"aweme_id"\s*:\s*"(\d{6,})"/);
      if (fromBody) awemeId = fromBody[1];
    }
  }

  if (!awemeId) {
    throw new Error('无法从该链接解析出视频 ID，请确认链接指向的是一个抖音视频（而非主页或直播）');
  }

  const shareUrl = `https://www.iesdouyin.com/share/video/${awemeId}/`;
  const ttwid = await getTtwid();
  const res = await fetchWithTimeout(
    shareUrl,
    {
      headers: {
        'User-Agent': MOBILE_UA,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://www.douyin.com/',
        ...(ttwid ? { Cookie: ttwid } : {}),
      },
    },
    20000
  );
  if (!res.ok) {
    throw new Error(`抖音分享页返回 ${res.status}，可能是链接失效或触发风控，稍后再试`);
  }
  const html = await res.text();

  const routerData =
    sliceJsonObject(html, 'window._ROUTER_DATA') ||
    sliceJsonObject(html, 'window.RENDER_DATA');

  const loaderData = routerData?.loaderData || {};
  let item = null;
  for (const [, val] of Object.entries(loaderData)) {
    const list = val?.videoInfoRes?.item_list;
    if (Array.isArray(list) && list.length) {
      item = list[0];
      break;
    }
  }
  if (!item) {
    const list = deepFindItemList(loaderData);
    if (list) item = list[0];
  }

  if (!item) {
    throw new Error('页面里没找到作品数据。作品可能已删除、设为私密，或需要登录才可见');
  }

  const play = pickPlayUrl(item);
  const isImages = Array.isArray(item.images) && item.images.length > 0;
  if (isImages) {
    throw new Error('这是一个图文作品，没有语音可以转写。请换一个视频链接');
  }
  if (!play.url) {
    throw new Error('没能取到视频播放地址，可能被风控拦截，稍后再试或换一个链接');
  }

  const durationMs = Number(item?.video?.duration || item?.duration || 0);

  return {
    awemeId,
    desc: (item.desc || '').trim(),
    author: item?.author?.nickname || '',
    authorId: item?.author?.sec_uid || item?.author?.uid || '',
    avatar: firstUrl(item?.author?.avatar_thumb?.url_list) || firstUrl(item?.author?.avatar_medium?.url_list),
    cover: firstUrl(item?.video?.cover?.url_list) || firstUrl(item?.video?.origin_cover?.url_list),
    duration: durationMs > 1000 ? Math.round(durationMs / 1000) : Math.round(durationMs),
    createTime: Number(item.create_time || 0),
    stats: {
      digg: Number(item?.statistics?.digg_count || 0),
      comment: Number(item?.statistics?.comment_count || 0),
      share: Number(item?.statistics?.share_count || 0),
      collect: Number(item?.statistics?.collect_count || 0),
    },
    music: item?.music?.title || '',
    videoUrl: play.url,
    videoId: play.videoId,
    shareUrl: `https://www.douyin.com/video/${awemeId}`,
    resolvedFrom: landingUrl,
  };
}
