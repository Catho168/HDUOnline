/**
 * 转写管线（主路径，运行在 ASR Worker 内）— §5.1 全流程：
 * ① 取新鲜直链（由调用方提供）→ ② MP4 音轨定位（只拉音频字节）→ ③ WebCodecs 解码 AAC
 * → ④ 重采样 16kHz 单声道 → ⑤ Whisper 分段推理 → ⑥ 术语纠错（在 SW 侧统一应用）
 * → ⑦ 分片增量落库（由 SW 侧执行）
 *
 * 兜底：探测/解码失败时抛出 `NEED_FALLBACK` 语义的错误，由 Offscreen 走整文件解码路径
 * （AudioContext.decodeAudioData 需要 DOM 环境），再通过 `W_FEED_*` 回灌 Worker 做推理。
 */

import { ASR_PARAMS, type AsrModelTier } from '../shared/constants';
import { AppError, toAppError } from '../shared/errors';
import { createLogger } from '../shared/logger';
import { buildSampleTimeline, extractSampleBytes, probeAudioTrack, type ProbeResult } from './mp4';
import { StreamingResampler, concatFloat32, downmixToMono, extractPlanarChannels } from './resample';
import { loadPipeline, transcribeChunkDetailed, type WhisperEnvConfig } from './whisper';
import { chunkInWindow, windowAudioSec, windowChunkRange } from './window';
import type { CloudAsrConfig } from './cloud';
import type { AsrQualityStats, TranscriptSegment } from '../shared/types';

const log = createLogger('asr-pipeline');

export interface PipelineProgress {
  phase: 'extracting' | 'decoding' | 'transcribing' | 'finalizing';
  /** 0–1 整体进度 */
  progress: number;
  doneChunks: number;
  totalChunks: number;
  rate?: number;
  etaSec?: number;
}

export interface ChunkResult {
  chunkIndex: number;
  startSec: number;
  endSec: number;
  segments: TranscriptSegment[];
}

export interface PipelineOptions {
  courId: number;
  viewNum: number;
  audioUrl: string;
  /** 已完成的分片（续跑时跳过） */
  doneChunks: number[];
  totalChunks: number;
  chunkSec: number;
  durationSec: number;
  modelTier: AsrModelTier;
  lang: 'zh' | 'en' | 'auto';
  remoteHost: string;
  /** 扩展内 wasm 资源目录（Offscreen 侧用 chrome.runtime.getURL 生成） */
  wasmBaseUrl?: string;
  glossaryPrompt?: string;
  /** 识别引擎：默认 local；cloud 时跳过本地模型加载，切片上传至云端 ASR */
  engine?: 'local' | 'cloud';
  cloudAsr?: CloudAsrConfig & { allowLocalEndpoints?: boolean };
  /** 只转写该时间窗（§5.2 B1：当前进度 ±x 分钟，省内存与流量） */
  window?: { start: number; end: number };
  onProgress: (p: PipelineProgress) => void;
  onChunk: (c: ChunkResult) => void;
  /** 供暂停/取消检查 */
  shouldStop: () => 'none' | 'pause' | 'cancel';
  /** 等待恢复（暂停时） */
  waitIfPaused: () => Promise<void>;
  /** 模型下载进度 */
  onModelProgress?: (data: { loaded: number; total: number; file?: string }) => void;
}

const envFor = (opts: PipelineOptions): WhisperEnvConfig => ({
  modelTier: opts.modelTier,
  lang: opts.lang,
  remoteHost: opts.remoteHost,
  wasmBaseUrl: opts.wasmBaseUrl,
  onProgress: opts.onModelProgress
    ? (data) => opts.onModelProgress?.({ loaded: data.loaded, total: data.total, file: data.file })
    : undefined,
});

/** 主路径：从 MP4 直链提取音频并转写 */
export async function runTranscription(
  opts: PipelineOptions,
): Promise<{ segmentCount: number; coveredSec: number; model: string; stats: AsrQualityStats }> {
  const startedAt = Date.now();
  opts.onProgress({
    phase: 'extracting',
    progress: 0.01,
    doneChunks: opts.doneChunks.length,
    totalChunks: opts.totalChunks,
  });

  const probe = await probeAudioTrack(opts.audioUrl).catch((err) => {
    const appErr = toAppError(err, 'ASR_PARSE_FAILED');
    // 网络错误重试即可；把它包装成"解析失败"会错误触发整文件兜底下载
    if (appErr.code === 'ASR_NETWORK_FAILED') throw appErr;
    log.warn('音轨探测失败，交由 Offscreen 走整文件兜底路径', appErr.detail);
    throw new AppError('ASR_PARSE_FAILED', {
      userMessage: appErr.userMessage,
      detail: appErr.detail,
      retryable: true,
    });
  });

  log.info('音轨探测成功', {
    codec: probe.info.codec,
    sampleRate: probe.info.sampleRate,
    channels: probe.info.channels,
    fragmented: probe.fragmented,
    audioBytes: probe.audioBytes,
  });

  // 分片 MP4（moof）：样本表只覆盖已探测到的 moof，仍按样本区间顺序拉取；
  // 若 moof 分布在头部/尾部探测范围之外，样本表会明显短于音轨时长——此时不静默转写
  // 空白片段，而是交给整文件兜底（B1）重新解码。
  if (probe.fragmented) {
    const lastSample = probe.samples[probe.samples.length - 1];
    const sampleEndSec =
      lastSample && probe.info.timescale > 0
        ? (lastSample.dts + lastSample.duration) / probe.info.timescale
        : 0;
    if (probe.info.durationSec > 0 && sampleEndSec > 0 && sampleEndSec < probe.info.durationSec * 0.9) {
      throw new AppError('ASR_PARSE_FAILED', {
        userMessage: '分片 MP4 的音轨样本不完整，将改用整文件兜底解码',
        detail: `samples end ${Math.round(sampleEndSec)}s < duration ${Math.round(
          probe.info.durationSec,
        )}s`,
        retryable: true,
      });
    }
    log.info('检测到分片 MP4，使用顺序流式读取');
  }

  // 云端引擎不需要本地模型（不下载 GB 级权重）
  if (opts.engine !== 'cloud') await loadPipeline(envFor(opts));

  const timeline = buildSampleTimeline(probe.samples, probe.info.timescale);
  const effectiveDuration = Math.min(
    opts.durationSec > 0 ? opts.durationSec : probe.info.durationSec,
    probe.info.durationSec,
  );
  const chunkCount = Math.max(1, Math.ceil(effectiveDuration / opts.chunkSec));
  // 局部转写：分片总数与进度分母都按窗口内的量算，避免"只跑到 40% 就结束"的错觉
  const windowRange = opts.window
    ? windowChunkRange(opts.window, probe.info.durationSec, opts.chunkSec)
    : null;
  const plannedChunks = windowRange ? windowRange.last - windowRange.first + 1 : chunkCount;
  const plannedAudioSec = opts.window
    ? windowAudioSec(opts.window, probe.info.durationSec)
    : opts.durationSec > 0
      ? opts.durationSec
      : probe.info.durationSec;
  const skip = new Set(opts.doneChunks);
  let doneChunks = skip.size;
  let processedAudioSec = 0;
  let segmentCount = 0;
  const stats: AsrQualityStats = {
    audioSec: 0,
    speechSec: 0,
    silentSec: 0,
    droppedSegments: 0,
    textLength: 0,
    coarseSlices: 0,
    segmentCount: 0,
  };

  const emitProgress = (phase: PipelineProgress['phase'], progress: number) => {
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const rate = elapsedSec > 0 ? processedAudioSec / elapsedSec : undefined;
    const remainingAudio = Math.max(0, plannedAudioSec - processedAudioSec);
    opts.onProgress({
      phase,
      progress: Math.max(0, Math.min(1, progress)),
      doneChunks,
      totalChunks: plannedChunks,
      rate,
      etaSec: rate && rate > 0 ? Math.round(remainingAudio / rate) : undefined,
    });
  };

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const control = opts.shouldStop();
    if (control === 'cancel') throw new AppError('ASR_CANCELLED');
    if (control === 'pause') await opts.waitIfPaused();

    const startSec = chunkIndex * opts.chunkSec;
    const endSec = Math.min(startSec + opts.chunkSec, probe.info.durationSec);
    // 时间窗模式：只处理与窗口相交的分片，其余跳过（不拉流、不解码、不计进度）
    if (!chunkInWindow(chunkIndex, opts.chunkSec, probe.info.durationSec, opts.window)) {
      continue;
    }
    if (skip.has(chunkIndex)) {
      processedAudioSec += endSec - startSec;
      emitProgress('transcribing', processedAudioSec / Math.max(1, plannedAudioSec));
      continue;
    }

    emitProgress('decoding', processedAudioSec / Math.max(1, plannedAudioSec));
    const pcm = await decodeChunkToPcm(opts, probe, timeline, startSec, endSec, (decodedSec) => {
      emitProgress('decoding', (processedAudioSec + decodedSec) / Math.max(1, plannedAudioSec));
    });

    const controlAfter = opts.shouldStop();
    if (controlAfter === 'cancel') throw new AppError('ASR_CANCELLED');
    if (controlAfter === 'pause') await opts.waitIfPaused();

    emitProgress('transcribing', processedAudioSec / Math.max(1, plannedAudioSec));
    let segments: TranscriptSegment[] = [];
    if (pcm.length > 0) {
      const result = await transcribeChunkDetailed(pcm, {
        offsetSec: startSec,
        lang: opts.lang,
        glossaryPrompt: opts.glossaryPrompt,
        shouldStop: opts.shouldStop,
        waitIfPaused: opts.waitIfPaused,
        ...(opts.engine === 'cloud' && opts.cloudAsr ? { cloud: { cfg: opts.cloudAsr } } : {}),
      });
      segments = result.segments;
      stats.audioSec += result.stats.audioSec;
      stats.speechSec += result.stats.speechSec;
      stats.silentSec += result.stats.silentSec;
      stats.droppedSegments += result.stats.droppedSegments;
      stats.textLength += result.stats.textLength;
      stats.coarseSlices += result.stats.coarseSlices;
    } else {
      log.warn('分片解码结果为空，跳过推理', { chunkIndex });
    }

    opts.onChunk({ chunkIndex, startSec, endSec, segments });
    segmentCount += segments.length;
    doneChunks += 1;
    processedAudioSec += endSec - startSec;
    emitProgress('transcribing', processedAudioSec / Math.max(1, plannedAudioSec));
  }

  emitProgress('finalizing', 1);
  stats.segmentCount = segmentCount;
  return {
    segmentCount,
    coveredSec: Math.round(processedAudioSec),
    // 云端引擎按 cloud:{model} 标记模型来源（作业与转写记录同口径）
    model: opts.engine === 'cloud' ? `cloud:${opts.cloudAsr?.model ?? 'unknown'}` : opts.modelTier,
    stats,
  };
}

/** 解码一个分片（10 分钟）为 16k 单声道 PCM */
async function decodeChunkToPcm(
  opts: PipelineOptions,
  probe: ProbeResult,
  timeline: Array<{ startSec: number; durationSec: number }>,
  startSec: number,
  endSec: number,
  onDecodedSec: (sec: number) => void,
): Promise<Float32Array> {
  const indices: number[] = [];
  for (let i = 0; i < probe.samples.length; i += 1) {
    const t = timeline[i];
    if (!t) continue;
    if (t.startSec >= startSec && t.startSec < endSec) indices.push(i);
  }
  if (indices.length === 0) {
    log.warn('分片内没有音频样本', { startSec, endSec });
    return new Float32Array(0);
  }

  const samples = indices.map((i) => probe.samples[i] as (typeof probe.samples)[number]);
  const scope = {
    start: samples[0]?.offset ?? 0,
    end: (samples[samples.length - 1]?.offset ?? 0) + (samples[samples.length - 1]?.size ?? 0),
  };
  const byteBuffers = await fetchBytesForScope(opts.audioUrl, probe.ranges, scope, opts.shouldStop);
  const sampleBytes = extractSampleBytes(samples, byteBuffers);
  const uncovered = sampleBytes.reduce((acc, item) => acc + (item.data.byteLength === 0 ? 1 : 0), 0);
  if (uncovered > 0) {
    log.warn('部分样本未被拉取区间覆盖，解码结果可能不完整', {
      uncovered,
      total: sampleBytes.length,
      startSec,
      endSec,
    });
  }

  const resampler = new StreamingResampler(probe.info.sampleRate, ASR_PARAMS.sampleRate);
  const pcmParts: Float32Array[] = [];
  let decodedSec = 0;

  const description = probe.info.asc ? toArrayBuffer(probe.info.asc) : undefined;
  let decodeError: Error | null = null;
  let pendingOutputs = 0;
  const outputs: AudioData[] = [];

  if (typeof AudioDecoder === 'undefined') {
    throw new AppError('ASR_DECODE_FAILED', {
      userMessage: '当前浏览器不支持 WebCodecs 音频解码，将改用兼容模式',
      detail: 'AudioDecoder is undefined',
      retryable: true,
    });
  }

  const decoder = new AudioDecoder({
    output: (data) => {
      pendingOutputs -= 1;
      outputs.push(data);
    },
    error: (err) => {
      decodeError = err instanceof Error ? err : new Error(String(err));
    },
  });

  try {
    decoder.configure({
      codec: probe.info.codec,
      sampleRate: probe.info.sampleRate,
      numberOfChannels: probe.info.channels,
      description,
    });
  } catch (err) {
    decoder.close();
    throw new AppError('ASR_DECODE_FAILED', {
      userMessage: `音频解码器初始化失败（${probe.info.codec}），将改用兼容模式`,
      detail: toAppError(err).detail,
      retryable: true,
    });
  }

  try {
    for (const { index, data } of sampleBytes) {
      if (decoder.state === 'closed') break;
      if (data.byteLength === 0) continue;
      const t = timeline[index];
      const timestampUs = Math.round((t?.startSec ?? 0) * 1_000_000);
      const durationUs = Math.round((t?.durationSec ?? 0.023) * 1_000_000);
      while (decoder.decodeQueueSize > 40) {
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: timestampUs,
          duration: durationUs,
          data: data as unknown as BufferSource,
        }),
      );
      pendingOutputs += 1;
      // 累积输出到达阈值就消费，避免一次性持有全部 AudioData
      if (pendingOutputs > 80 || outputs.length > 80) await drainOutputs();
      const control = opts.shouldStop();
      if (control === 'cancel') throw new AppError('ASR_CANCELLED');
    }
    await decoder.flush();
    await drainOutputs();
  } catch (err) {
    const appErr = toAppError(err, 'ASR_DECODE_FAILED');
    if (appErr.code === 'ASR_CANCELLED') throw appErr;
    throw new AppError('ASR_DECODE_FAILED', {
      userMessage: '音频解码失败，将改用兼容模式',
      detail: decodeError ? `${decodeError.message}；${appErr.detail ?? ''}` : appErr.detail,
      retryable: true,
    });
  } finally {
    try {
      if (decoder.state !== 'closed') decoder.close();
    } catch {
      /* 忽略 */
    }
  }
  if (decodeError) {
    const err = decodeError as Error;
    throw new AppError('ASR_DECODE_FAILED', {
      userMessage: '音频解码失败，将改用兼容模式',
      detail: err.message,
      retryable: true,
    });
  }
  onDecodedSec(endSec - startSec);
  return concatFloat32(pcmParts);

  async function drainOutputs(): Promise<void> {
    while (outputs.length > 0) {
      const data = outputs.shift();
      if (!data) break;
      try {
        const channels = extractPlanarChannels(
          (dest, options) => data.copyTo(dest, { planeIndex: options.planeIndex, format: 'f32-planar' }),
          data.numberOfFrames,
          data.numberOfChannels,
        );
        if (channels.length > 0) {
          const mono = downmixToMono(channels);
          decodedSec += mono.length / probe.info.sampleRate;
          pcmParts.push(resampler.push(mono));
        }
      } finally {
        data.close();
      }
    }
  }
}

/** 拉取覆盖给定字节区间的数据（多段 Range 请求） */
async function fetchBytesForScope(
  url: string,
  ranges: Array<{ start: number; end: number }>,
  scope: { start: number; end: number },
  shouldStop: () => string,
): Promise<Array<{ start: number; bytes: Uint8Array }>> {
  const wanted = ranges.filter((r) => r.end >= scope.start && r.start <= scope.end);
  const out: Array<{ start: number; bytes: Uint8Array }> = [];
  for (const range of wanted) {
    if (shouldStop() === 'cancel') throw new AppError('ASR_CANCELLED');
    const start = Math.max(range.start, scope.start);
    const end = Math.min(range.end, scope.end);
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      credentials: 'omit',
      mode: 'cors',
    });
    if (!res.ok && res.status !== 206) {
      throw new AppError('ASR_NETWORK_FAILED', {
        userMessage: `音频拉取失败（HTTP ${res.status}）`,
        detail: `Range bytes=${start}-${end} → ${res.status}`,
        retryable: true,
      });
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    out.push({ start, bytes });
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // 复制一份以保证是独立的 ArrayBuffer（避免 SharedArrayBuffer 类型问题）
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * 兜底路径：推理由 Offscreen 解码好的 PCM（整文件 decodeAudioData 之后）。
 * 与主路径保持一致的分片粒度与进度语义。
 */
export async function transcribeFedPcm(
  opts: PipelineOptions,
  chunks: Array<{ chunkIndex: number; startSec: number; endSec: number; pcm: Float32Array }>,
): Promise<{ segmentCount: number; coveredSec: number; model: string; stats: AsrQualityStats }> {
  if (opts.engine !== 'cloud') await loadPipeline(envFor(opts));
  const skip = new Set(opts.doneChunks);
  const plannedAudioSec = opts.window ? windowAudioSec(opts.window, opts.durationSec) : opts.durationSec;
  let doneChunks = skip.size;
  let segmentCount = 0;
  let coveredSec = 0;
  const stats: AsrQualityStats = {
    audioSec: 0,
    speechSec: 0,
    silentSec: 0,
    droppedSegments: 0,
    textLength: 0,
    coarseSlices: 0,
    segmentCount: 0,
  };
  for (const chunk of chunks) {
    const control = opts.shouldStop();
    if (control === 'cancel') throw new AppError('ASR_CANCELLED');
    if (control === 'pause') await opts.waitIfPaused();
    // 时间窗模式：窗口外的分片不推理（与主路径同口径）
    if (!chunkInWindow(chunk.chunkIndex, opts.chunkSec, opts.durationSec, opts.window)) continue;
    if (skip.has(chunk.chunkIndex)) {
      coveredSec += chunk.endSec - chunk.startSec;
      continue;
    }
    opts.onProgress({
      phase: 'transcribing',
      progress: Math.min(1, coveredSec / Math.max(1, plannedAudioSec)),
      doneChunks,
      totalChunks: opts.totalChunks,
    });
    let segments: TranscriptSegment[] = [];
    if (chunk.pcm.length > 0) {
      const result = await transcribeChunkDetailed(chunk.pcm, {
        offsetSec: chunk.startSec,
        lang: opts.lang,
        glossaryPrompt: opts.glossaryPrompt,
        shouldStop: opts.shouldStop,
        waitIfPaused: opts.waitIfPaused,
        ...(opts.engine === 'cloud' && opts.cloudAsr ? { cloud: { cfg: opts.cloudAsr } } : {}),
      });
      segments = result.segments;
      stats.audioSec += result.stats.audioSec;
      stats.speechSec += result.stats.speechSec;
      stats.silentSec += result.stats.silentSec;
      stats.droppedSegments += result.stats.droppedSegments;
      stats.textLength += result.stats.textLength;
      stats.coarseSlices += result.stats.coarseSlices;
    }
    opts.onChunk({ chunkIndex: chunk.chunkIndex, startSec: chunk.startSec, endSec: chunk.endSec, segments });
    segmentCount += segments.length;
    doneChunks += 1;
    coveredSec += chunk.endSec - chunk.startSec;
  }
  opts.onProgress({ phase: 'finalizing', progress: 1, doneChunks, totalChunks: opts.totalChunks });
  stats.segmentCount = segmentCount;
  return {
    segmentCount,
    coveredSec: Math.round(coveredSec),
    model: opts.engine === 'cloud' ? `cloud:${opts.cloudAsr?.model ?? 'unknown'}` : opts.modelTier,
    stats,
  };
}
