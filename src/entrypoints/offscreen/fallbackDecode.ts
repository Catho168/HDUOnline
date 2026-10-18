/**
 * 兜底整文件解码（§5.2 兜底路径 B1/B2）。
 *
 * 只在主路径（音轨样本区间 + WebCodecs）失败时使用：
 *  整文件 fetch（流式积累）→ 写入 Blob → `decodeAudioData` → OfflineAudioContext 重采样到 16k
 *  → 按 10 分钟切片交给 Worker 推理。
 *
 * 内置护栏（§5.2 B1）：
 *  - 文件大于 400MB：直接拒绝兜底并给出"改用片段流式（只转写当前进度前后 x 分钟）"的提示；
 *  - 解码后 PCM 内存按 16k 单声道计算（每 10 分钟 ≈ 38.4MB），逐片回灌后即释放。
 */

import { ASR_PARAMS } from '@/core/shared/constants';
import { AppError } from '@/core/shared/errors';

export const FILE_SIZE_GUARD_BYTES = ASR_PARAMS.fullDownloadGuardBytes;

export interface FallbackChunk {
  chunkIndex: number;
  startSec: number;
  endSec: number;
  pcm: Float32Array;
}

export interface FallbackResult {
  chunks: FallbackChunk[];
  durationSec: number;
  sampleRate: number;
}

export interface FallbackOptions {
  chunkSec: number;
  durationSec: number;
  guardBytes: number;
  onProgress?: (progress: number) => void;
}

/** 取远端文件大小（优先 HEAD，其次 Range） */
async function probeSize(url: string): Promise<number | undefined> {
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'omit', mode: 'cors' });
    const length = res.headers.get('content-length');
    if (length) {
      const size = Number(length);
      if (Number.isFinite(size)) return size;
    }
  } catch {
    /* 某些服务器不支持 HEAD，退回 GET Range */
  }
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'omit', mode: 'cors' });
    const range = res.headers.get('content-range');
    const match = range?.match(/\/(\d+)\s*$/);
    if (match?.[1]) return Number(match[1]);
  } catch {
    /* 忽略 */
  }
  return undefined;
}

/** 整文件解码为 16k 单声道 PCM，并按 chunkSec 切片 */
export async function decodeWholeFileToPcm(
  url: string,
  opts: FallbackOptions,
): Promise<FallbackResult> {
  const size = await probeSize(url);
  if (size !== undefined && size > opts.guardBytes) {
    throw new AppError('ASR_MEMORY_PRESSURE', {
      userMessage: `该视频文件较大（约 ${Math.round(
        size / 1024 / 1024,
      )}MB），整文件下载解码可能占用过多内存。建议改用"片段流式"（默认：只转写当前进度前后几分钟，半径可在设置里调整）：它走音轨流式路径，只拉取所需片段。`,
      detail: `文件 ${size} 字节超过兜底护栏 ${opts.guardBytes}`,
      retryable: false,
    });
  }

  opts.onProgress?.(0.02);
  const response = await fetch(url, { credentials: 'omit', mode: 'cors' });
  if (!response.ok && response.status !== 206) {
    throw new AppError('ASR_NETWORK_FAILED', {
      userMessage: `音频下载失败（HTTP ${response.status}）`,
      retryable: true,
    });
  }

  // 流式读取以支持进度与内存可控
  const reader = response.body?.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        received += value.byteLength;
        // 服务端未给出 Content-Length / HEAD 被拒时，仍按实际接收量执行同一护栏
        if (received > opts.guardBytes) {
          throw new AppError('ASR_MEMORY_PRESSURE', {
            userMessage:
              '音频文件过大，整文件下载解码可能占用过多内存。建议改用"片段流式"（只转写当前进度前后几分钟）。',
            detail: `已接收 ${received} 字节，超过兜底护栏 ${opts.guardBytes}`,
            retryable: false,
          });
        }
        if (size && size > 0) opts.onProgress?.(0.05 + 0.55 * Math.min(1, received / size));
      }
    }
  } else {
    const buffer = await response.arrayBuffer();
    parts.push(new Uint8Array(buffer));
  }
  const blob = new Blob(parts as unknown as BlobPart[], { type: 'video/mp4' });
  opts.onProgress?.(0.6);

  const g = globalThis as {
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const AudioCtx = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!AudioCtx) {
    throw new AppError('ASR_DECODE_FAILED', { userMessage: '当前环境不支持离线音频解码' });
  }

  const arrayBuffer = await blob.arrayBuffer();
  // ① 先用一个 1 帧的 OfflineAudioContext 做解码（decodeAudioData 属于 BaseAudioContext）
  const probeCtx = new AudioCtx(1, 1, ASR_PARAMS.sampleRate);
  let decoded: AudioBuffer;
  try {
    decoded = await probeCtx.decodeAudioData(arrayBuffer);
  } catch (err) {
    throw new AppError('ASR_DECODE_FAILED', {
      userMessage: '音频解码失败，该节次音频格式可能不受支持',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  opts.onProgress?.(0.75);

  // ② 重采样到 16k 单声道：用 OfflineAudioContext 渲染（内部为高质量重采样）
  const targetRate = ASR_PARAMS.sampleRate;
  const rawDuration = decoded.duration;
  const durationSec = opts.durationSec > 0 ? opts.durationSec : rawDuration;
  const frames = Math.max(1, Math.ceil(durationSec * targetRate));
  const offline = new AudioCtx(1, frames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  opts.onProgress?.(0.9);

  const mono = rendered.getChannelData(0);
  const chunkFrames = Math.max(1, Math.round(opts.chunkSec * targetRate));
  const chunks: FallbackChunk[] = [];
  for (let index = 0; index * chunkFrames < mono.length; index += 1) {
    const start = index * chunkFrames;
    const end = Math.min(mono.length, start + chunkFrames);
    chunks.push({
      chunkIndex: index,
      startSec: start / targetRate,
      endSec: end / targetRate,
      // 复制一份，避免持有整个渲染缓冲的视图
      pcm: new Float32Array(mono.subarray(start, end)),
    });
  }
  opts.onProgress?.(1);
  return { chunks, durationSec, sampleRate: targetRate };
}
