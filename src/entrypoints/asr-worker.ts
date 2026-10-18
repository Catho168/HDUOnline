/**
 * ASR Dedicated Worker（由 Offscreen 文档创建）。
 *
 * 承担纯计算与网络拉流：音轨定位 → 区间拉取 → WebCodecs 解码 → 重采样 → Whisper 推理。
 * 不接触页面 DOM；结果只回传给 Offscreen，由 SW 统一落库（§2.1 分工）。
 *
 * 两种工作模式：
 *  - 主路径（W_START）：自己拉音频字节并解码；
 *  - 兜底模式（W_FEED_BEGIN）：由 Offscreen 整文件解码后，按本模块的请求逐片回灌 PCM
 *    （逐片握手 → 任一时刻只持有一片 PCM，内存可控）。
 *
 * WXT 命名说明：WXT 的入口名按「首个 `.` 或路径分隔符截断」推导，
 * 因此 `entrypoints/asr-worker.ts` → 产物 `asr-worker.js`；
 * Offscreen 侧用 `new Worker(runtime.getURL('asr-worker.js'), { type: 'module' })` 创建。
 *
 * 作业代际（generation）：取消后立刻开始新作业时，旧作业可能还在异步回退途中。
 * 每个 W_START/W_FEED_BEGIN 递增代际，旧代际的 shouldStop 返回 cancel 且其消息被丢弃，
 * 避免旧作业的进度/分片被记到新作业上。
 */

import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { AppError, toAppError } from '@/core/shared/errors';
import { createLogger } from '@/core/shared/logger';
import { runTranscription, type PipelineOptions } from '@/core/asr/pipeline';
import { chunkInWindow, windowAudioSec, windowChunkRange } from '@/core/asr/window';
import { disposePipeline, loadPipeline, transcribeChunkDetailed, warmup } from '@/core/asr/whisper';
import type { WorkerInbound, WorkerOutbound, WorkerStartPayload } from '@/core/asr/workerProtocol';
import type { AsrQualityStats, TranscriptSegment } from '@/core/shared/types';

const log = createLogger('asr-worker');

// ───────────────────────── 控制状态 ─────────────────────────

let generation = 0;
let paused = false;
let cancelled = false;
let resumeWaiters: Array<() => void> = [];

interface RunControls {
  shouldStop: () => 'none' | 'pause' | 'cancel';
  waitIfPaused: () => Promise<void>;
  /** 仅当代际仍有效时投递消息 */
  post: (message: WorkerOutbound) => void;
}

function releaseWaiters(): void {
  const waiters = resumeWaiters;
  resumeWaiters = [];
  for (const resolve of waiters) resolve();
}

function makeControls(gen: number): RunControls {
  return {
    shouldStop: () => {
      if (gen !== generation) return 'cancel';
      if (cancelled) return 'cancel';
      if (paused) return 'pause';
      return 'none';
    },
    waitIfPaused: async () => {
      if (!paused || gen !== generation) return;
      await new Promise<void>((resolve) => {
        resumeWaiters.push(resolve);
      });
    },
    post: (message) => {
      if (gen === generation) post(message);
    },
  };
}

function post(message: WorkerOutbound): void {
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.postMessage(message);
  }
}

/** 宣告就绪（仅在真实 Worker 环境） */
function announceReady(): void {
  post({ type: 'W_READY' });
}

function buildOptions(payload: WorkerStartPayload, controls: RunControls): PipelineOptions {
  return {
    courId: payload.courId,
    viewNum: payload.viewNum,
    audioUrl: payload.audioUrl,
    doneChunks: payload.doneChunks,
    totalChunks: payload.totalChunks,
    chunkSec: payload.chunkSec,
    durationSec: payload.durationSec,
    modelTier: payload.modelTier,
    lang: payload.lang,
    remoteHost: payload.remoteHost,
    wasmBaseUrl: payload.wasmBaseUrl,
    glossaryPrompt: payload.glossaryPrompt,
    window: payload.window,
    shouldStop: controls.shouldStop,
    waitIfPaused: controls.waitIfPaused,
    onProgress: (p) => controls.post({ type: 'W_PROGRESS', payload: p }),
    onChunk: (c) => controls.post({ type: 'W_CHUNK', payload: c }),
    onModelProgress: (data) => controls.post({ type: 'W_MODEL_PROGRESS', payload: data }),
  };
}

function classifyErrorKind(err: unknown): 'network' | 'decode' | 'model' | 'memory' | 'unknown' {
  const appErr = toAppError(err);
  switch (appErr.code) {
    case 'ASR_NETWORK_FAILED':
      return 'network';
    case 'ASR_DECODE_FAILED':
    case 'ASR_PARSE_FAILED':
    case 'ASR_UNSUPPORTED_FORMAT':
      return 'decode';
    case 'ASR_MODEL_MISSING':
    case 'ASR_MODEL_DOWNLOAD_FAILED':
      return 'model';
    case 'ASR_INFER_FAILED':
      return 'model';
    case 'ASR_MEMORY_PRESSURE':
      return 'memory';
    default:
      return appErr.detail && /memory|allocation|out of/i.test(appErr.detail) ? 'memory' : 'unknown';
  }
}

/** 主路径失败后是否可以走兜底（整文件解码） */
function needsFallback(err: unknown): boolean {
  const appErr = toAppError(err);
  return (
    appErr.code === 'ASR_PARSE_FAILED' ||
    appErr.code === 'ASR_DECODE_FAILED' ||
    appErr.code === 'ASR_UNSUPPORTED_FORMAT' ||
    appErr.code === 'ASR_NO_AUDIO_TRACK'
  );
}

// ───────────────────────── 主路径 ─────────────────────────

async function handleStart(payload: WorkerStartPayload, gen: number): Promise<void> {
  const controls = makeControls(gen);
  try {
    const result = await runTranscription(buildOptions(payload, controls));
    controls.post({ type: 'W_DONE', payload: result });
  } catch (err) {
    const appErr = toAppError(err);
    if (appErr.code === 'ASR_CANCELLED') {
      controls.post({ type: 'W_FAILED', error: appErr.toJSON(), needFallback: false, errorKind: 'unknown' });
      return;
    }
    log.warn('主路径失败', { code: appErr.code, detail: appErr.detail });
    controls.post({
      type: 'W_FAILED',
      error: appErr.toJSON(),
      needFallback: needsFallback(err),
      errorKind: classifyErrorKind(err),
    });
  }
}

// ───────────────────────── 兜底模式（Offscreen 回灌 PCM） ─────────────────────────

interface FedState {
  payload: WorkerStartPayload;
  /** 已收到但未处理的片 */
  buffer: { chunkIndex: number; startSec: number; endSec: number; pcm: Float32Array } | null;
  waiter: ((value: 'chunk' | 'end') => void) | null;
  ended: boolean;
}

let fed: FedState | null = null;

async function handleFedMode(payload: WorkerStartPayload, gen: number): Promise<void> {
  const controls = makeControls(gen);
  fed = { payload, buffer: null, waiter: null, ended: false };
  const opts = buildOptions(payload, controls);
  // 局部转写：分片总数与进度分母按窗口内的量算（与主路径同口径）
  const windowRange = payload.window
    ? windowChunkRange(payload.window, payload.durationSec, payload.chunkSec)
    : null;
  const plannedChunks = windowRange ? windowRange.last - windowRange.first + 1 : payload.totalChunks;
  const plannedAudioSec = payload.window
    ? windowAudioSec(payload.window, payload.durationSec)
    : payload.durationSec;
  let doneChunks = payload.doneChunks.length;
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

  try {
    // 主路径可能死在音轨探测、尚未加载模型；兜底回灌前必须先把管线准备好
    await loadPipeline({
      modelTier: payload.modelTier,
      lang: payload.lang,
      remoteHost: payload.remoteHost,
      wasmBaseUrl: payload.wasmBaseUrl,
      onProgress: (data) => controls.post({ type: 'W_MODEL_PROGRESS', payload: data }),
    });

    for (let index = 0; index < payload.totalChunks; index += 1) {
      if (controls.shouldStop() === 'cancel') throw new AppError('ASR_CANCELLED');
      if (controls.shouldStop() === 'pause') await controls.waitIfPaused();
      // 时间窗模式：窗口外的分片不请求、不推理
      if (!chunkInWindow(index, payload.chunkSec, payload.durationSec, payload.window)) {
        continue;
      }
      if (payload.doneChunks.includes(index)) {
        coveredSec += Math.min(payload.chunkSec, Math.max(0, payload.durationSec - index * payload.chunkSec));
        continue;
      }
      controls.post({ type: 'W_FEED_WANT', chunkIndex: index });
      const kind = await waitForChunk();
      if (controls.shouldStop() === 'cancel') throw new AppError('ASR_CANCELLED');
      if (kind === 'end' || !fed?.buffer) {
        log.info('回灌提前结束', { index });
        break;
      }
      const chunk = fed.buffer;
      fed.buffer = null;
      let segments: TranscriptSegment[] = [];
      if (chunk.pcm.length > 0) {
        const result = await transcribeChunkDetailed(chunk.pcm, {
          offsetSec: chunk.startSec,
          lang: opts.lang,
          glossaryPrompt: opts.glossaryPrompt,
          shouldStop: controls.shouldStop,
          waitIfPaused: controls.waitIfPaused,
        });
        segments = result.segments;
        stats.audioSec += result.stats.audioSec;
        stats.speechSec += result.stats.speechSec;
        stats.silentSec += result.stats.silentSec;
        stats.droppedSegments += result.stats.droppedSegments;
        stats.textLength += result.stats.textLength;
        stats.coarseSlices += result.stats.coarseSlices;
      }
      if (controls.shouldStop() === 'cancel') throw new AppError('ASR_CANCELLED');
      controls.post({
        type: 'W_CHUNK',
        payload: { chunkIndex: chunk.chunkIndex, startSec: chunk.startSec, endSec: chunk.endSec, segments },
      });
      segmentCount += segments.length;
      doneChunks += 1;
      coveredSec += chunk.endSec - chunk.startSec;
      controls.post({
        type: 'W_PROGRESS',
        payload: {
          phase: 'transcribing',
          progress: Math.min(1, coveredSec / Math.max(1, plannedAudioSec)),
          doneChunks,
          totalChunks: plannedChunks,
        },
      });
    }
    if (controls.shouldStop() === 'cancel') throw new AppError('ASR_CANCELLED');
    controls.post({
      type: 'W_DONE',
      payload: {
        segmentCount,
        coveredSec: Math.round(coveredSec),
        model: 'fallback',
        stats: { ...stats, segmentCount },
      },
    });
  } catch (err) {
    const appErr = toAppError(err, 'ASR_DECODE_FAILED');
    controls.post({
      type: 'W_FAILED',
      error: appErr.toJSON(),
      needFallback: false,
      errorKind: classifyErrorKind(err),
    });
  } finally {
    if (generation === gen) fed = null;
  }
}

function waitForChunk(): Promise<'chunk' | 'end'> {
  if (!fed) return Promise.resolve('end');
  if (fed.buffer) return Promise.resolve('chunk');
  if (fed.ended) return Promise.resolve('end');
  return new Promise((resolve) => {
    fed!.waiter = resolve;
  });
}

// ───────────────────────── 消息入口 ─────────────────────────

function beginRun(): number {
  // 唤醒旧兜底回灌的等待者，避免它悬挂在已被替换的 fed 上
  fed?.waiter?.('end');
  fed = null;
  generation += 1;
  paused = false;
  cancelled = false;
  releaseWaiters();
  return generation;
}

function setup(): void {
  if (typeof self === 'undefined' || typeof self.postMessage !== 'function') return;
  self.onmessage = (event: MessageEvent<WorkerInbound>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'W_START': {
        const gen = beginRun();
        void handleStart(message.payload, gen);
        break;
      }

      case 'W_FEED_BEGIN': {
        const gen = beginRun();
        void handleFedMode(message.payload, gen);
        break;
      }

      case 'W_FEED_PCM':
        if (fed) {
          fed.buffer = message.chunk;
          fed.waiter?.('chunk');
          fed.waiter = null;
        }
        break;

      case 'W_FEED_END':
        if (fed) {
          fed.ended = true;
          fed.waiter?.('end');
          fed.waiter = null;
        }
        break;

      case 'W_CONTROL':
        if (message.action === 'pause') {
          paused = true;
        } else if (message.action === 'resume') {
          paused = false;
          releaseWaiters();
        } else {
          cancelled = true;
          paused = false;
          releaseWaiters();
          fed?.waiter?.('end');
          void disposePipeline();
        }
        break;

      case 'W_WARMUP':
        void warmup({
          modelTier: message.modelTier,
          lang: message.lang,
          remoteHost: message.remoteHost,
          wasmBaseUrl: message.wasmBaseUrl,
          onProgress: (data) => post({ type: 'W_MODEL_PROGRESS', payload: data }),
        }).then(
          ({ device }) => post({ type: 'W_WARMUP_DONE', ok: true, device }),
          (err) =>
            post({
              type: 'W_WARMUP_DONE',
              ok: false,
              error: toAppError(err, 'ASR_MODEL_DOWNLOAD_FAILED').toJSON(),
            }),
        );
        break;

      default:
        break;
    }
  };
  announceReady();
}

export default defineUnlistedScript(() => {
  setup();
});
