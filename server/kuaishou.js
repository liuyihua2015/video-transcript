// 快手解析：分享链接 -> 作品信息 + 视频直链
//
// 快手网页版（www.kuaishou.com）的详情页是纯前端渲染，SSR 里只有 UI 配置，
// 而它的 GraphQL 接口对未登录请求直接弹滑块验证码。但**移动端分享页**例外：
//   https://v.m.chenzhongtech.com/fw/photo/{photoId}
// 这个页面会把作品数据整段内联进 HTML，含 caption / userName / duration / mainMvUrls。
//
// 注意 photoId 有两套 ID 空间：
//   - App 分享短链（v.kuaishou.com/xxx）302 后带的是「移动端 photoId」→ 可用
//   - 网页版 www.kuaishou.com/short-video/xxx 里的短 ID → 换到移动页取不到数据
// 所以后者会给出明确提示，让用户改用 App 分享。

import { fetchWithTimeout, pickUrl } from './util.js';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const SHORT_HOSTS = ['v.kuaishou.com', 'k.kwai.com', 'short.kwai.com', 'g.e.kuaishou.com'];

function headers(extra = {}) {
  return { 'User-Agent': MOBILE_UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...extra };
}

/**
 * 找出包含 anchor 位置的最内层 JSON 对象（带字符串感知的括号配平）。
 * 页面里内层嵌套 JSON 用的是 \" 转义，外层是普通引号，所以直接扫原文即可，
 * 不要做全局去转义——那会把内层字符串里的引号也拆掉，JSON.parse 会崩。
 */
export function enclosingObject(text, anchor) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push(i);
    else if (c === '}') {
      const start = stack.pop();
      if (i > anchor && start < anchor) return text.slice(start, i + 1);
    }
  }
  return '';
}

function fromPhotoObject(o) {
  const firstUrl = (list) => (Array.isArray(list) ? list.map((x) => x?.url).filter(Boolean)[0] : '');
  const videoUrl = firstUrl(o?.mainMvUrls);
  if (!videoUrl) return null;
  return {
    videoUrl,
    cover: firstUrl(o.coverUrls),
    caption: String(o.caption || o.title || ''),
    userName: String(o.userName || o.user?.name || ''),
    photoId: String(o.photoId || ''),
    durationMs: Number(o.duration || 0),
  };
}

/** 从内联数据里取 photoId */
export function pickKuaishouPhotoId(url) {
  const text = String(url || '');
  const m = text.match(/\/fw\/photo\/([A-Za-z0-9_-]+)/) || text.match(/[?&]photoId=([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

/** 短链展开，返回最终地址 */
async function expandShort(url) {
  const res = await fetchWithTimeout(
    url,
    { redirect: 'follow', headers: headers({ Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }) },
    15000
  );
  return res.url || url;
}

/**
 * 从移动端分享页 HTML 里抽出作品数据。
 * 首选：把内联的作品 JSON 对象整段配平后 JSON.parse（字段最全、最准）。
 * 兜底：页面结构若被改坏，退回按字段正则抓取。
 */
export function extractKuaishouData(html) {
  const raw = String(html);
  const anchor = raw.indexOf('"mainMvUrls"');
  if (anchor < 0) return null;

  const obj = enclosingObject(raw, anchor);
  if (obj) {
    try {
      const hit = fromPhotoObject(JSON.parse(obj));
      if (hit) return hit;
    } catch {
      /* 落到正则兜底 */
    }
  }

  const videoUrl = (raw.slice(anchor, anchor + 1500).match(/"url"\s*:\s*"(https?:[^"]+)"/) || [])[1] || '';
  if (!videoUrl) return null;
  const field = (name) => (raw.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)) || [])[1] || '';
  const unescape = (s) => {
    try {
      return JSON.parse(`"${s}"`);
    } catch {
      return s;
    }
  };
  return {
    videoUrl,
    cover: '',
    caption: unescape(field('caption')),
    userName: unescape(field('userName')),
    photoId: '',
    durationMs: 0,
  };
}

/** 主入口：链接/分享文本 -> 归一化作品信息 */
export async function parseKuaishou(input) {
  const raw = pickUrl(input);
  if (!raw) throw new Error('没找到链接。请粘贴快手分享内容或视频地址（形如 https://v.kuaishou.com/xxxxxx）');

  let host = '';
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    /* 交给下面的 photoId 提取报错 */
  }

  let target = raw;
  let photoId = pickKuaishouPhotoId(raw);

  if (!photoId && SHORT_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    target = await expandShort(raw);
    photoId = pickKuaishouPhotoId(target);
  }

  if (!photoId) {
    if (/\/short-video\//.test(target) || /\/short-video\//.test(raw)) {
      throw new Error(
        '这个链接是快手网页版的短 ID，解析不了。请在快手 App 里点「分享 → 复制链接」再粘贴（形如 https://v.kuaishou.com/xxxxxx）'
      );
    }
    throw new Error('没识别出快手作品 ID，请粘贴 App 分享出来的链接');
  }

  const pageUrl = `https://v.m.chenzhongtech.com/fw/photo/${photoId}`;
  const res = await fetchWithTimeout(
    pageUrl,
    { redirect: 'follow', headers: headers({ Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }) },
    20000
  );
  if (!res.ok) throw new Error(`快手分享页返回 ${res.status}，可能触发风控，稍后再试`);
  const html = await res.text();

  const data = extractKuaishouData(html);
  if (!data) {
    if (/atlas|imageUrls|"images"/.test(html)) {
      throw new Error('这是一个快手图文作品，没有语音可以转写。请换一个视频链接');
    }
    throw new Error('快手页面里没找到作品数据，作品可能已删除或设为私密');
  }

  return {
    sourceKey: 'kuaishou',
    sourceLabel: '快手',
    desc: data.caption || '',
    author: data.userName || '',
    cover: data.cover || '',
    duration: data.durationMs > 1000 ? Math.round(data.durationMs / 1000) : Math.round(data.durationMs || 0),
    webUrl: `https://www.kuaishou.com/short-video/${data.photoId || photoId}`,
    direct: { url: data.videoUrl, ext: '.mp4', headers: headers({ Referer: 'https://www.kuaishou.com/' }) },
  };
}
