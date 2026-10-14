// 语音识别：OpenAI 兼容的 /audio/transcriptions 接口
// 默认对接硅基流动 FunAudioLLM/SenseVoiceSmall（中文效果好、常驻免费）

import fs from 'node:fs/promises';
import path from 'node:path';
import { retry, smartJoin } from './util.js';

const DEFAULT_BASE = process.env.ASR_BASE_URL || 'https://api.siliconflow.cn/v1';
const DEFAULT_MODEL = process.env.ASR_MODEL || 'FunAudioLLM/SenseVoiceSmall';

/**
 * 允许的接口地址白名单。
 * 因为接口地址可以由前端传入，若不加限制，任何人都能把本服务当成
 * 访问内网/任意主机的转发跳板（SSRF）。默认只放行常见的公开 ASR 服务，
 * 需要自建/其他厂商时用 ASR_EXTRA_HOSTS 追加（逗号分隔，支持 *.example.com）。
 */
const ALLOWED_HOSTS = [
  'api.siliconflow.cn',
  'api.openai.com',
  'dashscope.aliyuncs.com',
  'api.groq.com',
  'api.moonshot.cn',
  'api.deepseek.com',
];

export function allowedHosts() {
  const extra = String(process.env.ASR_EXTRA_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...ALLOWED_HOSTS, ...extra];
}

function hostAllowed(host) {
  const h = host.toLowerCase();
  return allowedHosts().some((pat) =>
    pat.startsWith('*.') ? h.endsWith(pat.slice(1)) && h.length > pat.length - 1 : h === pat
  );
}

/** 校验并规整接口地址（仅 https、非 IP、域名需在白名单内） */
export function normalizeBaseUrl(input, fallback = DEFAULT_BASE) {
  const raw = String(input || fallback || DEFAULT_BASE).trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('接口地址格式不正确，应形如 https://api.siliconflow.cn/v1');
  }
  if (u.protocol !== 'https:') throw new Error('接口地址必须是 https:// 开头');
  if (/^[\d.]+$/.test(u.hostname) || u.hostname.includes(':')) {
    throw new Error('接口地址不能直接使用 IP，请填写域名');
  }
  if (!hostAllowed(u.hostname)) {
    throw new Error(`接口地址 ${u.hostname} 不在允许列表内，如需使用请让管理员在 ASR_EXTRA_HOSTS 中添加`);
  }
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

/**
 * 解析语音识别配置。
 * 优先级：请求携带的客户端凭据 > 服务端 .env。
 * 这样使用者可以自带 Key，服务端不必长期保管任何密钥。
 */
export function asrConfig(override = {}) {
  const clientKey = String(override.apiKey || '').trim();
  const envKey = process.env.ASR_API_KEY || process.env.SILICONFLOW_API_KEY || '';
  const apiKey = clientKey || envKey;
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(override.baseUrl, process.env.ASR_BASE_URL || DEFAULT_BASE),
    model: String(override.model || '').trim() || process.env.ASR_MODEL || DEFAULT_MODEL,
    enabled: Boolean(apiKey),
    source: clientKey ? 'client' : envKey ? 'server' : 'none',
  };
}

/** 单个音频文件转文字 */
export async function transcribeFile(file, cfg = asrConfig(), { timeoutMs = 120000 } = {}) {
  if (!cfg.apiKey) {
    throw new Error('还没有填写语音识别密钥，请在页面上的「语音识别设置」里填入你自己的 API Key');
  }
  const buf = await fs.readFile(file);
  const form = new FormData();
  form.append('model', cfg.model);
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(file));
  if (process.env.ASR_LANGUAGE) form.append('language', process.env.ASR_LANGUAGE);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      // 不跟随跳转：否则第三方地址可以用 302 把我们引到内网地址，绕过白名单
      redirect: 'error',
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    // 回显上游错误时抹掉密钥，避免密钥出现在前端或日志里
    const safe = cfg.apiKey ? detail.split(cfg.apiKey).join('***') : detail;
    const err = new Error(`语音识别接口返回 ${res.status}${safe ? `：${safe}` : ''}`);
    err.status = res.status;
    // 4xx 基本都是「密钥不对 / 参数不对」，重试纯属浪费用户时间；429 和 5xx 才值得退避重试
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  const json = await res.json().catch(() => null);
  const text = json?.text ?? json?.data?.[0]?.text ?? '';
  return String(text).trim();
}

/**
 * 清掉语音模型混进正文里的「音频事件 / 情绪」标记。
 * SenseVoice 会在识别结果里插入 🎼（背景音乐）、😊😡😭（情绪）以及 <|BGM|> 这类标记，
 * 它们不是说话内容，直接进文案会污染可编辑文本，所以在合并段落之前统一去掉。
 * 代价：说话人真的读出的表情符号也会被一并去掉——对「提取文案」这个场景，这个取舍是划算的。
 */
const ASR_MARKUP = /<\|[^|]*\|>|[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

export function cleanAsrText(text) {
  return String(text || '')
    .replace(ASR_MARKUP, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 限并发转写所有切片 */
export async function transcribeSegments(segments, cfg, onProgress) {
  const concurrency = Math.max(1, Number(process.env.ASR_CONCURRENCY || 3));
  const results = new Array(segments.length);
  let done = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < segments.length) {
      const i = cursor++;
      const seg = segments[i];
      const raw = await retry(() => transcribeFile(seg.file, cfg), {
        times: 3,
        baseDelay: 1200,
        label: `asr#${i}`,
        // 只有标记了 retryable=false 的错误（如 401/403/404）才放弃重试
        shouldRetry: (err) => err?.retryable !== false,
      });
      results[i] = { start: seg.start, end: seg.end, text: cleanAsrText(raw) };
      done++;
      onProgress?.(done, segments.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, worker));
  return results.filter(Boolean);
}

const SENTENCE_END = /[。！？!?…；;]["'”’】）)]?$/;

/**
 * 把固定切片的结果合并成语义段落：
 * 切片边界会切断句子，这里按句末标点归并，同时保留起止时间。
 */
export function mergeIntoParagraphs(segments, { maxChars = 160 } = {}) {
  const paragraphs = [];
  let cur = null;

  for (const seg of segments) {
    const text = (seg.text || '').trim();
    if (!text) continue;
    if (!cur) cur = { start: seg.start, end: seg.end, text };
    else {
      cur.text = smartJoin(cur.text, text);
      cur.end = seg.end;
    }
    if (SENTENCE_END.test(text) || cur.text.length >= maxChars) {
      paragraphs.push(cur);
      cur = null;
    }
  }
  if (cur) paragraphs.push(cur);
  return paragraphs;
}

/** 段落 -> SRT 字幕 */
export function toSrt(paragraphs) {
  const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
  const tc = (sec) => {
    const s = Math.max(0, sec);
    return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)},${pad(Math.round((s % 1) * 1000), 3)}`;
  };
  return paragraphs
    .map((p, i) => `${i + 1}\n${tc(p.start)} --> ${tc(p.end)}\n${p.text}\n`)
    .join('\n');
}

export function toPlainText(paragraphs) {
  return paragraphs.map((p) => p.text).join('\n\n');
}
