// 媒体处理：下载视频 -> ffmpeg 抽音频 -> 按固定时长切片
// 只依赖系统 ffmpeg / ffprobe

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { fetchWithTimeout, log, retry } from './util.js';

const execFileAsync = promisify(execFile);

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const DOWNLOAD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function assertFfmpeg() {
  try {
    await execFileAsync(FFMPEG, ['-version'], { timeout: 10000 });
  } catch {
    throw new Error('服务器上没有找到 ffmpeg，请先安装（macOS: brew install ffmpeg / Ubuntu: apt install -y ffmpeg）');
  }
}

/**
 * 下载媒体到本地。
 * - headers：各平台 CDN 要求的 Referer / UA
 * - maxBytes：边下边数，超限立刻中止，避免大文件把容器内存撑爆
 */
export async function downloadVideo(url, destFile, { timeoutMs = 120000, headers = {}, maxBytes = 0 } = {}) {
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        'User-Agent': DOWNLOAD_UA,
        Accept: '*/*',
        ...headers,
      },
    },
    timeoutMs
  );
  if (!res.ok) {
    throw new Error(`媒体下载失败：HTTP ${res.status}`);
  }

  const declared = Number(res.headers.get('content-length') || 0);
  if (maxBytes > 0 && declared > maxBytes) {
    throw new Error(`文件体积约 ${(declared / 1024 / 1024).toFixed(0)}MB，超过上限（${(maxBytes / 1024 / 1024).toFixed(0)}MB），已中止下载`);
  }

  const handle = await fs.open(destFile, 'w');
  let bytes = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      bytes += chunk.length;
      if (maxBytes > 0 && bytes > maxBytes) {
        res.body?.cancel?.().catch?.(() => {});
        throw new Error(`文件体积超过上限（${(maxBytes / 1024 / 1024).toFixed(0)}MB），已中止下载`);
      }
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }

  if (bytes < 10 * 1024) {
    throw new Error('下载到的文件体积异常（可能被风控拦截），请稍后重试');
  }
  log(`downloaded ${(bytes / 1024 / 1024).toFixed(2)} MB -> ${path.basename(destFile)}`);
  return bytes;
}

export async function probeDuration(file) {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { timeout: 30000 }
    );
    const n = parseFloat(String(stdout).trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * 视频 -> 单声道 16k mp3 -> 按时长切片
 * @returns {{ audioFile: string, segments: {file:string, start:number, end:number}[] }}
 */
export async function extractAudioSegments(videoFile, workDir, { segmentSeconds = 30 } = {}) {
  const audioFile = path.join(workDir, 'audio.mp3');

  await execFileAsync(
    FFMPEG,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoFile, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', audioFile],
    { timeout: 180000, maxBuffer: 1024 * 1024 * 8 }
  );

  const total = await probeDuration(audioFile);
  const pattern = path.join(workDir, 'seg_%04d.mp3');
  await execFileAsync(
    FFMPEG,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', audioFile,
      '-f', 'segment',
      '-segment_time', String(segmentSeconds),
      '-reset_timestamps', '1',
      '-c', 'copy',
      pattern,
    ],
    { timeout: 180000, maxBuffer: 1024 * 1024 * 8 }
  );

  const files = (await fs.readdir(workDir))
    .filter((f) => /^seg_\d+\.mp3$/.test(f))
    .sort();
  if (!files.length) {
    throw new Error('音频切片失败，可能是视频里没有音轨（纯音乐/无声作品无法转写）');
  }

  // 用真实时长校正每段边界，避免估算漂移
  const durs = await Promise.all(
    files.map((f) => retry(() => probeDuration(path.join(workDir, f)), { times: 2, baseDelay: 200 }))
  );

  const segments = [];
  let cursor = 0;
  files.forEach((f, idx) => {
    const dur = durs[idx] > 0 ? durs[idx] : segmentSeconds;
    segments.push({
      file: path.join(workDir, f),
      index: idx,
      start: Number(cursor.toFixed(3)),
      end: Number((cursor + dur).toFixed(3)),
    });
    cursor += dur;
  });

  log(`audio ready: ${total.toFixed(1)}s total, ${segments.length} segment(s) x ~${segmentSeconds}s`);
  return { audioFile, totalDuration: total, segments };
}

/**
 * 生成一小段静音音频，用于验证语音识别密钥是否可用。
 * 静音几乎不消耗额度，且能真实走通「鉴权 + 模型可用性」两个环节。
 */
export async function makeSilenceClip(destFile, seconds = 1) {
  await execFileAsync(
    FFMPEG,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
      '-t', String(seconds),
      '-c:a', 'libmp3lame', '-b:a', '32k',
      destFile,
    ],
    { timeout: 20000 }
  );
  return destFile;
}

export async function cleanupDir(dir) {  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    log('cleanup failed:', err.message);
  }
}
