/**
 * Offscreen 文档（长任务宿主，§2.1）。
 *
 * 职责：
 *  - 持有 ASR Worker（创建/转发/生命周期）；
 *  - 兜底音频解码（整文件 fetch + decodeAudioData，需要 DOM 环境的 AudioContext）；
 *  - 长时 LLM 流式请求（避免 SW 因空闲被回收而中断）；
 *  - 截图帧复现（隐藏 crossOrigin 视频 + canvas + 水印），并直接写入 IndexedDB。
 *
 * 不负责业务编排与缓存决策（那是 SW 的职责）。
 */

import { ASR_PARAMS } from '@/core/shared/constants';
import { AppError, serializeError, toAppError, type SerializedAppError } from '@/core/shared/errors';
import { createLogger } from '@/core/shared/logger';
import { runtime } from '@/core/shared/runtime';
import { loadSecrets, loadSettings } from '@/core/shared/settings';
import { runLlm } from '@/core/llm/runner';
import { putScreenshot } from '@/core/db/repo/library';
import type {
  OffscreenLlmAbort,
  OffscreenLlmRun,
  OffscreenOutbound,
  OffscreenShotCapture,
} from '@/core/shared/messages';
import type { ScreenshotEntity } from '@/core/shared/types';
import type { WorkerInbound, WorkerOutbound } from '@/core/asr/workerProtocol';
import { chunkInWindow } from '@/core/asr/window';
import { FILE_SIZE_GUARD_BYTES, decodeWholeFileToPcm, type FallbackChunk } from './fallbackDecode';

const log = createLogger('offscreen');

type ModelTier = 'fast' | 'standard' | 'high';

interface JobPayload {
  courId: number;
  viewNum: number;
  audioUrl: string;
  doneChunks: number[];
  totalChunks: number;
  chunkSec: number;
  durationSec: number;
  modelTier: ModelTier;
  lang: 'zh' | 'en' | 'auto';
  glossaryPrompt?: string;
  /** 只转写该时间窗（§5.2 B1：片段流式，只转当前进度前后 x 分钟） */
  window?: { start: number; end: number };
}

interface ActiveJob {
  /** 作业代际：同一 courId 取消后立刻重启时，用于拒绝旧兜底流程的回灌 */
  token: number;
  courId: number;
  payload: JobPayload;
  /** 兜底模式下已解码但尚未回灌的 PCM 分片 */
  decodedChunks: FallbackChunk[] | null;
}

let worker: Worker | null = null;
let activeJob: ActiveJob | null = null;
let jobToken = 0;
/** 最近一次预热/推理使用的设备（PING 对账时附带） */
let lastDevice: string | undefined;
/** 预热中的档位：模型进度事件不带 tier，用它在无作业时归位 */
let warmupTier: ModelTier | null = null;

function toSw(message: OffscreenOutbound): void {
  if (!runtime.available()) return;
  void runtime
    .sendMessage({ type: 'OFFSCREEN_EVENT', payload: message })
    .catch((err: unknown) => {
      log.warn('回传 SW 失败', err);
    });
}

/** 把错误归类为 UI 可展示的 errorKind */
function errorKindOf(err: unknown): 'network' | 'decode' | 'model' | 'memory' | 'unknown' {
  const appErr = toAppError(err, 'ASR_DECODE_FAILED');
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

// ───────────────────────── Worker 管理 ─────────────────────────

function ensureWorker(): Worker {
  if (worker) return worker;
  // WXT 把 `entrypoints/asr-worker.ts` 构建为 `asr-worker.js`（按首个 `.` 截断命名）
  const url = runtime.getURL('asr-worker.js');
  const instance = new Worker(url, { type: 'module' });
  instance.onmessage = (event: MessageEvent<WorkerOutbound>) => {
    void handleWorkerMessage(event.data).catch((err: unknown) => {
      log.error('处理 Worker 消息失败', err);
    });
  };
  instance.onerror = (event) => {
    log.error('ASR Worker 出错', event.message);
    // 未捕获异常后 Worker 可能已不可用：终止并允许下一次作业重建
    try {
      instance.terminate();
    } catch {
      /* 忽略 */
    }
    if (worker === instance) worker = null;
    const courId = activeJob?.courId;
    if (courId !== undefined) {
      activeJob = null;
      toSw({
        type: 'OFFSCREEN_ASR_FAILED',
        courId,
        error: serializeError(new AppError('ASR_DECODE_FAILED', { detail: event.message })),
        errorKind: 'unknown',
      });
    }
  };
  worker = instance;
  return instance;
}

async function handleWorkerMessage(message: WorkerOutbound): Promise<void> {
  const job = activeJob;
  switch (message.type) {
    case 'W_READY':
      log.info('ASR Worker 就绪');
      return;

    case 'W_MODEL_PROGRESS': {
      const tier = job?.payload.modelTier ?? warmupTier;
      if (!tier) return;
      toSw({
        type: 'OFFSCREEN_MODEL_PROGRESS',
        tier,
        loaded: message.payload.loaded,
        total: message.payload.total,
        file: message.payload.file,
      });
      return;
    }

    case 'W_PROGRESS':
      if (!job) return;
      toSw({
        type: 'OFFSCREEN_ASR_PROGRESS',
        courId: job.courId,
        phase: message.payload.phase,
        progress: message.payload.progress,
        doneChunks: message.payload.doneChunks,
        totalChunks: message.payload.totalChunks,
        rate: message.payload.rate,
        etaSec: message.payload.etaSec,
      });
      return;

    case 'W_CHUNK':
      if (!job) return;
      toSw({
        type: 'OFFSCREEN_ASR_CHUNK_DONE',
        courId: job.courId,
        viewNum: job.payload.viewNum,
        chunkIndex: message.payload.chunkIndex,
        startSec: message.payload.startSec,
        endSec: message.payload.endSec,
        segments: message.payload.segments,
      });
      return;

    case 'W_DONE': {
      if (!job) return;
      const { courId, payload } = job;
      activeJob = null;
      toSw({
        type: 'OFFSCREEN_ASR_DONE',
        courId,
        segmentCount: message.payload.segmentCount,
        coveredSec: message.payload.coveredSec,
        model: message.payload.model || payload.modelTier,
        durationSec: payload.durationSec,
        stats: message.payload.stats,
      });
      return;
    }

    case 'W_FAILED': {
      if (!job) return;
      if (message.needFallback) {
        log.info('主路径不可用，切换到整文件兜底解码');
        try {
          await runFallback(job, message.error);
          return;
        } catch (err) {
          const appErr = toAppError(err, 'ASR_DECODE_FAILED');
          // 取消/换作业后不要再发失败事件
          if (!activeJob || activeJob.token !== job.token) return;
          log.warn('兜底转写失败', { code: appErr.code, detail: appErr.detail });
          activeJob = null;
          toSw({
            type: 'OFFSCREEN_ASR_FAILED',
            courId: job.courId,
            error: appErr.toJSON(),
            errorKind: errorKindOf(appErr),
          });
          return;
        }
      }
      activeJob = null;
      // Worker 只把 code 写进自己的控制台；detail 必须在 Offscreen 落一次日志，
      // 否则“发生未知错误”之后没有任何可排查的线索。
      log.warn('ASR 作业失败', {
        code: message.error.code,
        detail: message.error.detail,
        kind: message.errorKind,
        needFallback: message.needFallback,
      });
      toSw({
        type: 'OFFSCREEN_ASR_FAILED',
        courId: job.courId,
        error: message.error,
        errorKind: message.errorKind,
      });
      return;
    }

    case 'W_WARMUP_DONE':
      if (message.device) lastDevice = message.device;
      warmupTier = null;
      toSw({
        type: 'OFFSCREEN_WARMUP_DONE',
        ok: message.ok,
        device: message.device,
        error: message.error,
      });
      return;

    case 'W_FEED_WANT': {
      // 兜底模式：按请求逐片回灌，回灌后立即释放（内存可控）
      if (!job || activeJob?.token !== job.token || !job.decodedChunks) {
        worker?.postMessage({ type: 'W_FEED_END' } satisfies WorkerInbound);
        return;
      }
      const index = job.decodedChunks.findIndex((c) => c.chunkIndex === message.chunkIndex);
      if (index < 0) {
        job.decodedChunks = null;
        worker?.postMessage({ type: 'W_FEED_END' } satisfies WorkerInbound);
        return;
      }
      const chunk = job.decodedChunks[index] as FallbackChunk;
      job.decodedChunks.splice(index, 1);
      worker?.postMessage({ type: 'W_FEED_PCM', chunk } satisfies WorkerInbound);
      return;
    }

    default:
      return;
  }
}

// ───────────────────────── ASR 作业 ─────────────────────────

async function startJob(payload: JobPayload): Promise<void> {
  // Worker 一次只能承载一个作业：并发启动会让两个课次的进度/分片互相污染
  if (activeJob) {
    log.warn('已有转写作业在运行，拒绝新的作业启动', {
      running: activeJob.courId,
      incoming: payload.courId,
    });
    toSw({
      type: 'OFFSCREEN_ASR_FAILED',
      courId: payload.courId,
      error: serializeError(
        new AppError('ASR_MEMORY_PRESSURE', {
          userMessage: '同一时间只支持一个转写作业，请等待当前作业完成或取消后再试',
          detail: `active=${activeJob.courId}, incoming=${payload.courId}`,
        }),
      ),
      errorKind: 'memory',
    });
    return;
  }
  // 先占位再 await，避免两个 ASR_START 同时通过上面的空闲检查
  activeJob = { token: ++jobToken, courId: payload.courId, payload, decodedChunks: null };
  try {
    const secrets = await loadSecrets();
    ensureWorker().postMessage({
      type: 'W_START',
      payload: { ...payload, remoteHost: secrets.modelSource.remoteHost, wasmBaseUrl: runtime.getURL('wasm/') },
    } satisfies WorkerInbound);
  } catch (err) {
    if (activeJob?.courId === payload.courId) activeJob = null;
    throw err;
  }
}

/** 兜底：整文件解码后回灌 Worker 推理 */
async function runFallback(job: ActiveJob, primaryError?: SerializedAppError): Promise<void> {
  const { payload } = job;
  let decoded: Awaited<ReturnType<typeof decodeWholeFileToPcm>>;
  try {
    decoded = await decodeWholeFileToPcm(payload.audioUrl, {
      chunkSec: payload.chunkSec,
      durationSec: payload.durationSec,
      guardBytes: FILE_SIZE_GUARD_BYTES,
      onProgress: (progress) => {
        // 兜底解码无法中途中断：取消/换作业后继续解码，但不再上报旧作业进度
        if (!activeJob || activeJob.token !== job.token) return;
        toSw({
          type: 'OFFSCREEN_ASR_PROGRESS',
          courId: payload.courId,
          phase: 'decoding',
          progress,
          doneChunks: payload.doneChunks.length,
          totalChunks: payload.totalChunks,
        });
      },
    });
  } catch (err) {
    const appErr = toAppError(err);
    // 已经是片段模式却连音轨都定位不到：再提示“改用片段流式”只会误导用户，
    // 这里把主路径的真实原因和文件过大这一事实一起说清楚。
    if (appErr.code === 'ASR_MEMORY_PRESSURE' && payload.window && primaryError) {
      throw new AppError(primaryError.code, {
        userMessage: `无法解析该视频的音轨结构（${primaryError.userMessage}），整文件兜底又因文件过大被取消。请稍后重试；若反复出现，请把转写日志反馈给开发者。`,
        detail: `${primaryError.detail ?? ''}；${appErr.detail ?? ''}`,
        retryable: true,
      });
    }
    throw err;
  }
  if (!activeJob || activeJob.token !== job.token) return;
  // 局部转写：只保留窗口内的分片，尽早释放其余 PCM（Worker 也只会请求窗口内的分片）
  activeJob.decodedChunks = payload.window
    ? decoded.chunks.filter((c) =>
        chunkInWindow(c.chunkIndex, payload.chunkSec, payload.durationSec, payload.window),
      )
    : decoded.chunks;
  const secrets = await loadSecrets();
  if (!activeJob || activeJob.token !== job.token) return;
  ensureWorker().postMessage({
    type: 'W_FEED_BEGIN',
    payload: { ...payload, remoteHost: secrets.modelSource.remoteHost, wasmBaseUrl: runtime.getURL('wasm/') },
  } satisfies WorkerInbound);
}

// ───────────────────────── 截图 ─────────────────────────

interface GrabResult {
  blob: Blob;
  thumbDataUrl?: string;
  width: number;
  height: number;
}

async function captureShot(request: OffscreenShotCapture): Promise<void> {
  try {
    const result = await grabFrame(request.url, request.atSec, request.watermark, request.meta);
    const id = `shot-${request.courId}-${Date.now()}`;
    const entity: ScreenshotEntity = {
      id,
      courId: request.courId,
      view: request.view,
      blob: result.blob,
      thumbDataUrl: result.thumbDataUrl,
      meta: {
        courseName: request.meta.courseName,
        courLabel: request.meta.courLabel,
        anchorTime: request.atSec,
        watermark: request.watermark,
      },
      createdAt: Date.now(),
    };
    // 与参考实现保持同一仓储函数名（Agent A 的 DB 移植）
    await putScreenshot(entity);
    toSw({
      type: 'OFFSCREEN_SHOT_RESULT',
      requestId: request.requestId,
      ok: true,
      screenshotId: id,
      width: result.width,
      height: result.height,
    });
  } catch (err) {
    toSw({
      type: 'OFFSCREEN_SHOT_RESULT',
      requestId: request.requestId,
      ok: false,
      error: serializeError(err),
    });
  }
}

/** 隐藏 crossOrigin 视频复现当前帧（§7 A6 / 附录 D-3 思路 + 水印） */
async function grabFrame(
  url: string,
  atSec: number,
  watermark: boolean,
  meta: { courseName: string; courLabel: string; anchorTime: number },
): Promise<GrabResult> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  video.style.position = 'fixed';
  video.style.left = '-10000px';
  video.style.top = '0';
  video.style.width = '640px';
  document.body.appendChild(video);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('加载视频超时')), 20_000);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('视频加载失败（可能被跨域策略拦截）'));
      };
    });
    const target = Math.max(0, Math.min(atSec, Math.max(0, video.duration - 0.05)));
    video.currentTime = target;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('定位帧超时')), 15_000);
      video.onseeked = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('定位帧失败'));
      };
    });
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布上下文');
    ctx.drawImage(video, 0, 0, width, height);
    if (watermark) drawWatermark(ctx, width, height, meta);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出 PNG 失败'))), 'image/png');
    });
    return { blob, thumbDataUrl: makeThumb(canvas, width, height), width, height };
  } finally {
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

function drawWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  meta: { courseName: string; courLabel: string; anchorTime: number },
): void {
  const pad = Math.round(width * 0.02);
  const fontSize = Math.max(14, Math.round(width * 0.022));
  const lines = [meta.courseName || '课程', meta.courLabel || '', formatClock(meta.anchorTime)].filter(
    Boolean,
  );
  ctx.save();
  ctx.font = `${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  const lineHeight = Math.round(fontSize * 1.4);
  const boxHeight = lineHeight * lines.length + pad;
  const boxWidth = Math.max(...lines.map((line) => ctx.measureText(line).width)) + pad * 2;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, height - boxHeight, boxWidth, boxHeight);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  lines.forEach((line, index) => {
    ctx.fillText(line, pad, height - boxHeight + pad / 2 + lineHeight * (index + 0.5));
  });
  ctx.restore();
}

function makeThumb(source: HTMLCanvasElement, width: number, height: number): string | undefined {
  try {
    const targetWidth = 240;
    const scale = targetWidth / width;
    const thumb = document.createElement('canvas');
    thumb.width = targetWidth;
    thumb.height = Math.max(1, Math.round(height * scale));
    const ctx = thumb.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(source, 0, 0, thumb.width, thumb.height);
    return thumb.toDataURL('image/jpeg', 0.7);
  } catch {
    return undefined;
  }
}

function formatClock(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ───────────────────────── LLM 执行 ─────────────────────────

const llmAborts = new Map<string, AbortController>();

async function runLlmRequest(request: OffscreenLlmRun): Promise<void> {
  const controller = new AbortController();
  llmAborts.set(request.runId, controller);
  try {
    const result = await runLlm(
      {
        provider: request.provider,
        timeouts: request.timeouts,
        allowLocalEndpoints: request.allowLocalEndpoints,
        maxRetries: 2,
      },
      {
        system: request.request.system,
        messages: request.request.messages,
        maxTokens: request.request.maxTokens,
        temperature: request.request.temperature,
        jsonMode: request.request.jsonMode,
        signal: controller.signal,
        onDelta: request.request.stream
          ? (text) => {
              toSw({ type: 'OFFSCREEN_LLM_DELTA', runId: request.runId, text });
            }
          : undefined,
      },
    );
    toSw({ type: 'OFFSCREEN_LLM_DONE', runId: request.runId, text: result.text, usage: result.usage });
  } catch (err) {
    toSw({ type: 'OFFSCREEN_LLM_FAILED', runId: request.runId, error: serializeError(err) });
  } finally {
    llmAborts.delete(request.runId);
  }
}

// ───────────────────────── 消息入口 ─────────────────────────

runtime.onMessage((raw) => {
  if (!raw || typeof raw !== 'object') return undefined;
  const envelope = raw as { type?: string; op?: string; payload?: unknown };
  if (envelope.type !== 'OFFSCREEN_REQUEST') return undefined;

  switch (envelope.op) {
    case 'ASR_START': {
      const payload = envelope.payload as Partial<JobPayload>;
      void handleAsrStart(payload).catch((err: unknown) => {
        log.error('ASR 启动失败', err);
        if (payload.courId) {
          toSw({
            type: 'OFFSCREEN_ASR_FAILED',
            courId: payload.courId,
            error: serializeError(toAppError(err, 'ASR_NETWORK_FAILED')),
            errorKind: errorKindOf(err),
          });
        }
      });
      return { ok: true };
    }

    case 'ASR_CONTROL': {
      const control = envelope.payload as { courId: number; action: 'pause' | 'resume' | 'cancel' };
      // Worker 单作业：只接受当前作业的控制指令，避免旧页面的取消/暂停误伤新作业
      if (activeJob && control.courId !== activeJob.courId) {
        log.warn('忽略非当前作业的控制指令', {
          running: activeJob.courId,
          incoming: control.courId,
          action: control.action,
        });
        return { ok: true };
      }
      if (control.action === 'cancel') {
        activeJob = null;
        worker?.postMessage({ type: 'W_CONTROL', action: 'cancel' } satisfies WorkerInbound);
      } else {
        worker?.postMessage({ type: 'W_CONTROL', action: control.action } satisfies WorkerInbound);
      }
      return { ok: true };
    }

    case 'WARMUP': {
      const payload = envelope.payload as { modelTier?: ModelTier };
      void (async () => {
        const [secrets, settings] = await Promise.all([loadSecrets(), loadSettings()]);
        const tier = payload.modelTier ?? settings.asr.modelTier;
        warmupTier = tier;
        ensureWorker().postMessage({
          type: 'W_WARMUP',
          modelTier: tier,
          lang: settings.asr.lang,
          remoteHost: secrets.modelSource.remoteHost,
          wasmBaseUrl: runtime.getURL('wasm/'),
        } satisfies WorkerInbound);
      })().catch((err: unknown) => {
        warmupTier = null;
        toSw({
          type: 'OFFSCREEN_WARMUP_DONE',
          ok: false,
          error: serializeError(toAppError(err, 'ASR_MODEL_DOWNLOAD_FAILED')),
        });
      });
      return { ok: true };
    }

    case 'SHOT':
      void captureShot(envelope.payload as OffscreenShotCapture);
      return { ok: true };

    case 'LLM_RUN':
      void runLlmRequest(envelope.payload as OffscreenLlmRun);
      return { ok: true };

    case 'LLM_ABORT': {
      const abort = envelope.payload as OffscreenLlmAbort;
      llmAborts.get(abort.runId)?.abort();
      llmAborts.delete(abort.runId);
      return { ok: true };
    }

    case 'PING':
      toSw({
        type: 'OFFSCREEN_PING_REPLY',
        activeCourIds: activeJob ? [activeJob.courId] : [],
        device: lastDevice,
      });
      return { ok: true };

    default:
      return undefined;
  }
});

async function handleAsrStart(payload: Partial<JobPayload>): Promise<void> {
  if (!payload.courId || !payload.audioUrl) {
    log.warn('ASR_START 缺少必要参数');
    return;
  }
  const settings = await loadSettings();
  await startJob({
    courId: payload.courId,
    viewNum: payload.viewNum ?? 1,
    audioUrl: payload.audioUrl,
    doneChunks: payload.doneChunks ?? [],
    totalChunks: Math.max(1, payload.totalChunks ?? 1),
    chunkSec: payload.chunkSec ?? ASR_PARAMS.chunkSec,
    durationSec: payload.durationSec ?? 0,
    modelTier: payload.modelTier ?? settings.asr.modelTier,
    lang: payload.lang ?? settings.asr.lang,
    glossaryPrompt: payload.glossaryPrompt,
    window: payload.window,
  });
}

// 通知 SW：Offscreen 就绪（用于 SW 重启后的对账）
if (runtime.available()) {
  toSw({ type: 'OFFSCREEN_READY' });
  log.info('Offscreen 文档已启动', { workerUrl: runtime.getURL('asr-worker.js') });
}
