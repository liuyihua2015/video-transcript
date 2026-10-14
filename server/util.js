// 通用小工具：日志、延时、超时、文本处理

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

/** 给 fetch 套一层超时，超时抛 AbortError */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带指数退避的重试
 * shouldRetry(err)：返回 false 表示这个错误重试也没用（例如密钥错误），立刻抛出
 */
export async function retry(fn, { times = 3, baseDelay = 800, label = 'task', shouldRetry } = {}) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (shouldRetry && !shouldRetry(err)) throw err;
      if (i < times - 1) {
        const wait = baseDelay * Math.pow(2, i);
        log(`retry ${label} (${i + 1}/${times - 1}) in ${wait}ms: ${err.message}`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/** 秒 -> 00:00 或 00:00:00 */
export function formatTime(sec, withMs = false) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  const base = h > 0 ? `${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
  if (!withMs) return base;
  const ms = Math.floor(((sec || 0) % 1) * 1000);
  return `${base},${String(ms).padStart(3, '0')}`;
}

/** 秒 -> 00:00:00,000 （SRT 时间码） */
export function srtTime(sec) {
  const s = Math.max(0, sec || 0);
  const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)},${pad(Math.round((s % 1) * 1000), 3)}`;
}

/** 智能拼接两段中文文本：中文/标点直接接，ASCII 词之间补空格 */
export function smartJoin(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  const last = a.slice(-1);
  const first = b.slice(0, 1);
  const isWord = (ch) => /[A-Za-z0-9]/.test(ch);
  if (isWord(last) && isWord(first)) return `${a} ${b}`;
  return a + b;
}

/** 从任意分享文本里抓出第一个 http(s) 链接（去掉尾部中文标点） */
export function pickUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s"'<>()（）【】]+/);
  return m ? m[0].replace(/[，。、；：！？,.;:!?)\]】]+$/, '') : null;
}
