// 哔哩哔哩解析：链接 -> 作品信息 + 纯音频直链
//
// 为什么不用 yt-dlp：yt-dlp 的 BiliBili 提取器走 x/player/wbi/playurl（wbi 签名版），
// 实测在本机与国内服务器上均返回 HTTP 412；而公开的 x/web-interface/view +
// x/player/playurl（非 wbi）两个接口，未登录也能正常拿到 DASH 数据。
//
// 只要音频，所以直接取 dash.audio 里码率最低的那条（约 44kbps），
// 一段 30 分钟的视频音频只有 10MB 左右，比下整段视频快一个数量级。

import { fetchWithTimeout, pickUrl } from './util.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const API = 'https://api.bilibili.com';
const REFERER = 'https://www.bilibili.com/';

const SHORT_HOSTS = ['b23.tv', 'bili2233.cn', 'acg.tv'];

function headers(extra = {}) {
  return { 'User-Agent': UA, Referer: REFERER, 'Accept-Language': 'zh-CN,zh;q=0.9', ...extra };
}

async function getJson(url, timeoutMs = 20000) {
  const res = await fetchWithTimeout(url, { headers: headers() }, timeoutMs);
  if (!res.ok) throw new Error(`哔哩哔哩接口返回 ${res.status}`);
  const json = await res.json().catch(() => null);
  if (!json) throw new Error('哔哩哔哩接口返回的不是 JSON，可能触发了风控');
  return json;
}

/** 从任意形态的链接里取 bvid / aid / 分 P 号 */
export function pickBiliId(url) {
  const text = String(url || '');
  const bv = text.match(/(BV[0-9A-Za-z]{10})/);
  const av = text.match(/\/av(\d+)/i) || text.match(/[?&]aid=(\d+)/);
  const p = Number((text.match(/[?&]p=(\d+)/) || [])[1] || 1);
  return { bvid: bv ? bv[1] : '', aid: av ? av[1] : '', page: Number.isFinite(p) && p > 0 ? p : 1 };
}

/** 短链展开（b23.tv 会 302 到 www.bilibili.com/video/BV…） */
async function expandShort(url) {
  const res = await fetchWithTimeout(
    url,
    { redirect: 'follow', headers: headers({ Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }) },
    15000
  );
  return res.url || url;
}

/** 主入口：链接/分享文本 -> 归一化作品信息 */
export async function parseBilibili(input) {
  const raw = pickUrl(input);
  if (!raw) throw new Error('没找到链接。请粘贴哔哩哔哩视频地址（形如 https://www.bilibili.com/video/BV…）');

  if (/\/bangumi\//.test(raw) || /\/cheese\//.test(raw)) {
    throw new Error('番剧与付费课程需要登录态才能取到音轨，本工具不支持这类内容');
  }

  let target = raw;
  const host = (() => {
    try {
      return new URL(raw).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (SHORT_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    target = await expandShort(raw);
  }

  const { bvid, aid, page } = pickBiliId(target);
  if (!bvid && !aid) {
    throw new Error('没识别出视频 ID，请确认链接指向的是单个视频（BV… 或 av…），而不是 UP 主主页、合集或播放列表');
  }

  const viewQuery = bvid ? `bvid=${bvid}` : `aid=${aid}`;
  const view = await getJson(`${API}/x/web-interface/view?${viewQuery}`);
  if (view.code !== 0 || !view.data) {
    const msg = view.code === -404 ? '视频不存在或已被删除' : `哔哩哔哩返回错误（code=${view.code}${view.message ? '：' + view.message : ''}）`;
    throw new Error(msg);
  }
  const d = view.data;

  // 分 P：pages[] 里每一项是一个可独立播放的分段
  const pages = Array.isArray(d.pages) && d.pages.length ? d.pages : [];
  const pIndex = Math.min(Math.max(1, page), pages.length || 1);
  const current = pages.length ? pages[pIndex - 1] : null;
  const cid = current?.cid || d.cid;
  if (!cid) throw new Error('没能取到这个视频的分段 ID');

  // 注意：view 接口用 aid，playurl 接口用 avid，参数名不同
  const playQuery = bvid ? `bvid=${bvid}` : `avid=${aid}`;
  const play = await getJson(
    `${API}/x/player/playurl?${playQuery}&cid=${cid}&fnval=16&fnver=0&qn=32&fourk=1`
  );
  if (play.code !== 0 || !play.data) {
    throw new Error(`取播放地址失败（code=${play.code}${play.message ? '：' + play.message : ''}），该视频可能需要登录或已下架`);
  }

  // 优先纯音频（最快）；拿不到 DASH 时退回整段视频
  const audio = (play.data.dash?.audio || []).slice().sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0];
  let direct = null;
  if (audio?.baseUrl) {
    direct = { url: audio.baseUrl, ext: '.m4s' };
  } else if (play.data.durl?.[0]?.url) {
    direct = { url: play.data.durl[0].url, ext: '.mp4' };
  }
  if (!direct) throw new Error('没能取到音轨地址，可能被风控拦截，稍后再试或换一个链接');

  const multi = pages.length > 1;
  const webUrl = `https://www.bilibili.com/video/${d.bvid}${multi ? `?p=${pIndex}` : ''}`;

  return {
    sourceKey: 'bilibili',
    sourceLabel: '哔哩哔哩',
    desc: multi ? `${d.title} · P${pIndex} ${current?.part || ''}`.trim() : d.title || '',
    author: d.owner?.name || '',
    cover: d.pic || '',
    duration: current?.duration || d.duration || 0,
    webUrl,
    direct: { ...direct, headers: headers() },
  };
}
