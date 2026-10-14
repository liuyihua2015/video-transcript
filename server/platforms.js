// 平台注册表：把一个链接归到某个解析器
//
// engine 含义：
//   native —— 本仓库自己实现的解析（抖音 / 快手 / 哔哩哔哩），不依赖外部程序，实测可用
//   ytdlp  —— 交给通用引擎 yt-dlp 兜底（可覆盖上千个站点，但能否成功取决于站点策略与服务器网络）
//
// 加新平台的两种做法：
//   1) 自己写解析器 → 新建 server/<平台>.js，在 PLATFORMS 里加一条 engine:'native'
//   2) 交给 yt-dlp   → 通常不用改代码，yt-dlp 自己认识；若它的识别有偏差，加一条 engine:'ytdlp' 的显式记录

/** 用户可见的平台清单（顺序即页面展示顺序） */
export const PLATFORMS = [
  {
    key: 'douyin',
    label: '抖音',
    engine: 'native',
    hosts: ['douyin.com', 'iesdouyin.com', 'amemv.com'],
    example: 'https://v.douyin.com/xxxxxxx/',
    note: 'App 里「分享 → 复制链接」的整段口令都能直接粘',
  },
  {
    key: 'kuaishou',
    label: '快手',
    engine: 'native',
    hosts: ['kuaishou.com', 'chenzhongtech.com', 'gifshow.com', 'kwai.com'],
    example: 'https://v.kuaishou.com/xxxxxxx',
    note: '认 App 分享出来的短链；网页版 www.kuaishou.com/short-video/… 这种短 ID 解析不了，请改用 App 分享',
  },
  {
    key: 'bilibili',
    label: '哔哩哔哩',
    engine: 'native',
    hosts: ['bilibili.com', 'b23.tv', 'bili2233.cn', 'acg.tv'],
    example: 'https://www.bilibili.com/video/BV1xx411c7mD',
    note: '只取第一个分 P；番剧、付费课程等需要登录的内容不支持',
  },
];

/** 非上述三家的链接统一走 yt-dlp 兜底 */
export const GENERIC = { key: 'generic', label: '其他平台', engine: 'ytdlp' };

/** 明确不支持、且要给出解释的域名 */
const UNSUPPORTED = [
  { hosts: ['xiaohongshu.com', 'xhslink.com'], reason: '小红书笔记需要登录态才能拿到视频地址，本工具不保存任何账号凭据，暂时不支持' },
  { hosts: ['weibo.com', 'weibo.cn'], reason: '微博从 2024 年起对未登录请求统一返回风控页，暂时不支持' },
  { hosts: ['channels.weixin.qq.com', 'finder.video.qq.com'], reason: '微信视频号没有公开的分享链接格式，暂时不支持' },
];

export function hostOf(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matches(host, roots) {
  return roots.some((root) => host === root || host.endsWith('.' + root));
}

/**
 * 识别链接属于哪个平台
 * @returns {{key:string,label:string,engine:string,reason?:string}|null} 无法识别返回 null
 */
export function detectPlatform(url) {
  const host = hostOf(url);
  if (!host) return null;
  for (const p of PLATFORMS) {
    if (matches(host, p.hosts)) return p;
  }
  for (const u of UNSUPPORTED) {
    if (matches(host, u.hosts)) return { ...GENERIC, label: host, unsupported: true, reason: u.reason };
  }
  return { ...GENERIC };
}

/** 页面「支持平台」区块用 */
export function platformList() {
  return PLATFORMS.map(({ key, label, engine, example, note }) => ({ key, label, engine, example, note }));
}
