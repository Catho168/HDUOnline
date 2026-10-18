/**
 * Whisper 推理封装（§5.3，运行在 ASR Worker 内）。
 *
 * - 依赖 `@huggingface/transformers` v3（ONNX Runtime Web 后端）；
 * - 设备选择：WebGPU 可用 → device:'webgpu' + fp16；否则 wasm + q8；
 * - 模型来源：自定义 OPFS 缓存（下载/手动导入统一），默认 hf-mirror；
 * - 术语偏置：词表前 200 项拼成 initial_prompt；
 * - 时间戳：分片推理时把片起点作为偏移累加；缺时间戳的段落截断到音频末尾。
 */

import { ASR_MODELS, ASR_PARAMS, type AsrModelTier } from '../shared/constants';
import { AppError, toAppError } from '../shared/errors';
import { createLogger } from '../shared/logger';
import { runtime } from '../shared/runtime';
import { createOpfsCache, opfsAvailable } from './modelCache';
import { analyzeAudioLevel, buildSegmentsFromWhisper } from './postprocess';
import type { AsrQualityStats, TranscriptSegment } from '../shared/types';

const log = createLogger('asr-whisper');

// transformers.js 的模块与类型较复杂，这里用最小结构描述我们实际使用的 API，
// 避免把上游类型泄漏到整个代码库。
interface WhisperPipelineOptions {
  device: 'webgpu' | 'wasm' | 'auto';
  dtype: string;
  progress_callback?: (data: {
    status: string;
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
  }) => void;
}

type WhisperPipeline = (
  audio: Float32Array,
  options: {
    language?: string;
    task?: 'transcribe';
    return_timestamps?: boolean;
    chunk_length_s?: number;
    stride_length_s?: number;
    initial_prompt?: string;
  },
) => Promise<{
  text?: string;
  chunks?: Array<{ text?: string; timestamp?: [number | null, number | null] }>;
}>;

export interface WhisperEnvConfig {
  modelTier: AsrModelTier;
  lang: 'zh' | 'en' | 'auto';
  remoteHost: string;
  /** 扩展内 wasm 资源目录（由 Offscreen 用 chrome.runtime.getURL 传入，避免 Worker 内无 chrome.*） */
  wasmBaseUrl?: string;
  /** 模型下载/加载进度回调（转给 UI） */
  onProgress?: (data: { tier: AsrModelTier; loaded: number; total: number; file?: string }) => void;
}

interface OrtWasmConfig {
  wasmPaths?: string | Record<string, string>;
  numThreads?: number;
  proxy?: boolean;
}

interface LoadedPipeline {
  pipe: WhisperPipeline;
  device: 'webgpu' | 'wasm';
  modelId: string;
}

let cached: LoadedPipeline | null = null;
let loading: { modelId: string; promise: Promise<LoadedPipeline> } | null = null;

/** 探测 WebGPU 可用性（Worker 内同样可用） */
export function hasWebGPU(): boolean {
  if (typeof navigator === 'undefined') return false;
  return Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
}

function isAbsoluteUrl(value: string): boolean {
  return /^(?:chrome-extension|moz-extension|https?):\/\//.test(value);
}

function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

/** 模型源候选：先用手动配置，再依次尝试国内镜像与官方源 */
function modelHostCandidates(remoteHost: string): string[] {
  const configured = withTrailingSlash(remoteHost.trim() || 'https://hf-mirror.com');
  const out: string[] = [];
  for (const host of [configured, 'https://hf-mirror.com/', 'https://huggingface.co/']) {
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

/** 网络类失败（CORS / DNS / 连接中断）换模型源重试才有意义；解码/显存类失败不应换源 */
function isNetworkFailure(err: unknown): boolean {
  const appErr = toAppError(err);
  const text = `${appErr.detail ?? ''} ${appErr.userMessage ?? ''}`;
  return /network|fetch|load failed|cors|failed to fetch|net::|econn|timed? ?out|abort/i.test(text);
}

/**
 * 解析扩展内 wasm 目录。
 * 优先用 Offscreen 传入的绝对地址；Worker 自身 URL 只能作为兜底
 * （扩展页创建的 Dedicated Worker 中 `chrome` 可能为 undefined）。
 * 只有扩展自身/明确的 http(s) 地址才可用，相对路径会让 ORT 退回默认 CDN。
 */
function resolveWasmPaths(cfg: WhisperEnvConfig): string | null {
  const candidates = [cfg.wasmBaseUrl?.trim(), runtime.getURL('wasm/')];
  for (const candidate of candidates) {
    if (candidate && isAbsoluteUrl(candidate)) return withTrailingSlash(candidate);
  }
  return null;
}

function applyWasmLimits(wasm: OrtWasmConfig): void {
  // 多线程需要 crossOriginIsolated；未开启隔离时强制单线程（§8.1 说明）
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true;
  const hardware = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4;
  wasm.numThreads = isolated ? Math.min(4, hardware) : 1;
  // 代理关闭以避免 wasm 线程校验失败
  wasm.proxy = false;
}

async function configureEnv(cfg: WhisperEnvConfig): Promise<void> {
  const wasmPaths = resolveWasmPaths(cfg);

  // 必须在 transformers 之前直接配置 onnxruntime-web：
  // transformers 的 `env.backends.onnx` 在首次 pipeline() 之前是空对象（ORT 按需加载），
  // 此时写 wasmPaths 不会落到真正的 ORT 环境上；而 ORT 模块初始化时若 wasmPaths 为空，
  // 会默认指向 jsdelivr CDN，MV3 的 script-src 'self' 会拦截其动态 import，
  // 表现为“模型加载失败 / no available backend found”。
  if (wasmPaths) {
    try {
      const ort = (await import('onnxruntime-web')) as unknown as { env?: { wasm?: OrtWasmConfig } };
      const wasm = ort.env?.wasm;
      if (wasm) {
        wasm.wasmPaths = wasmPaths;
        applyWasmLimits(wasm);
        log.info('ONNX WASM 资源目录', { wasmPaths });
      } else {
        log.warn('onnxruntime-web 未暴露 wasm 环境，无法指定内置资源目录');
      }
    } catch (err) {
      log.warn('预配置 onnxruntime-web 失败', toAppError(err).detail);
    }
  } else {
    log.warn('无法确定扩展内 wasm 资源目录，ASR 可能回退外链');
  }

  const mod = (await import('@huggingface/transformers')) as unknown as {
    env: Record<string, unknown>;
  };
  const env = mod.env;
  // 模型来源（国内默认 hf-mirror，可在设置中改；空值回退默认，避免把 remoteHost 设成 "/"）
  const remoteHost = cfg.remoteHost?.trim() || 'https://hf-mirror.com';
  env.remoteHost = remoteHost.endsWith('/') ? remoteHost : `${remoteHost}/`;
  env.allowRemoteModels = true;
  // 不使用 transformers 自带的 Cache API / 本地目录逻辑，统一走 OPFS 自定义缓存（§5.4）
  env.useBrowserCache = false;
  env.allowLocalModels = false;
  if (opfsAvailable()) {
    env.useCustomCache = true;
    env.customCache = createOpfsCache();
  }
  // 双保险：若 ORT 已被其他模块提前初始化（env.backends.onnx 已填充），同步覆盖一次；
  // 正常情况下上面的直接配置已生效，这里最多是重复赋值。
  const backends = env.backends as { onnx?: { wasm?: OrtWasmConfig } } | undefined;
  if (wasmPaths && backends?.onnx?.wasm) {
    backends.onnx.wasm.wasmPaths = wasmPaths;
    applyWasmLimits(backends.onnx.wasm);
  }
}

/** 加载（或复用）Whisper 管线 */
export async function loadPipeline(cfg: WhisperEnvConfig): Promise<LoadedPipeline> {
  const spec = ASR_MODELS[cfg.modelTier];

  if (cached && cached.modelId === spec.modelId) return cached;
  if (loading && loading.modelId === spec.modelId) return loading.promise;

  // 正在加载另一个档位：先等它结束，再释放旧管线，避免同时占用两份权重
  if (loading) {
    try {
      await loading.promise;
    } catch {
      /* 旧加载失败与本次无关 */
    }
    if (cached && cached.modelId === spec.modelId) return cached;
  }
  if (cached && cached.modelId !== spec.modelId) await disposePipeline();

  const promise = (async (): Promise<LoadedPipeline> => {
    const mod = (await import('@huggingface/transformers')) as unknown as {
      pipeline: (task: string, model: string, options: WhisperPipelineOptions) => Promise<unknown>;
    };

    const devices: Array<'webgpu' | 'wasm'> = hasWebGPU() ? ['webgpu', 'wasm'] : ['wasm'];
    const hosts = modelHostCandidates(cfg.remoteHost);
    let lastError: unknown;
    let lastHost = hosts[0] ?? 'https://hf-mirror.com/';
    let lastDevice = devices[0] ?? 'wasm';
    let lastFile: string | undefined;

    for (const host of hosts) {
      let retryAnotherHost = false;
      for (const device of devices) {
        const dtype = device === 'webgpu' ? spec.webgpuDtype : spec.wasmDtype;
        lastHost = host;
        lastDevice = device;
        lastFile = undefined;
        try {
          await configureEnv({ ...cfg, remoteHost: host });
          log.info('加载 Whisper 模型', { model: spec.modelId, device, dtype, host });
          const pipe = (await mod.pipeline('automatic-speech-recognition', spec.modelId, {
            device,
            dtype,
            progress_callback: (data) => {
              if (data.file) lastFile = data.file;
              if (data.status === 'progress' && cfg.onProgress) {
                cfg.onProgress({
                  tier: cfg.modelTier,
                  loaded: data.loaded ?? 0,
                  total: data.total ?? 0,
                  file: data.file,
                });
              }
              if (data.status === 'ready') log.info('模型文件就绪', { file: data.file });
            },
          })) as WhisperPipeline;
          cached = { pipe, device, modelId: spec.modelId };
          log.info('模型加载完成', { device, host });
          return cached;
        } catch (err) {
          lastError = err;
          const appErr = toAppError(err, 'ASR_MODEL_DOWNLOAD_FAILED');
          log.warn('模型加载尝试失败', {
            host,
            device,
            file: lastFile,
            detail: appErr.detail ?? appErr.code,
          });
          // 网络失败换模型源；非网络失败（WebGPU 驱动/精度问题）换设备
          if (isNetworkFailure(err)) {
            retryAnotherHost = true;
            break;
          }
          if (device === 'webgpu') log.warn('WebGPU 初始化失败，回退 WASM 重试');
        }
      }
      if (!retryAnotherHost) break;
    }

    const appErr = toAppError(lastError, 'ASR_MODEL_DOWNLOAD_FAILED');
    throw new AppError('ASR_MODEL_DOWNLOAD_FAILED', {
      detail: `${appErr.detail ?? appErr.code}（host=${lastHost}, device=${lastDevice}${
        lastFile ? `, file=${lastFile}` : ''
      }）`,
      retryable: true,
    });
  })();

  loading = { modelId: spec.modelId, promise };
  try {
    return await promise;
  } finally {
    if (loading?.promise === promise) loading = null;
  }
}

/** 预热（只加载模型，不做推理） */
export async function warmup(cfg: WhisperEnvConfig): Promise<{ device: string }> {
  const loaded = await loadPipeline(cfg);
  return { device: loaded.device };
}

export interface TranscribeOptions {
  /** 该段音频在整节课中的起点（秒），用于时间戳偏移 */
  offsetSec: number;
  lang: 'zh' | 'en' | 'auto';
  glossaryPrompt?: string;
  /** 每 60 秒推理切片之间检查一次暂停/取消 */
  shouldStop?: () => 'none' | 'pause' | 'cancel';
  waitIfPaused?: () => Promise<void>;
}

export interface TranscribeResult {
  segments: TranscriptSegment[];
  stats: AsrQualityStats;
}

function emptyStats(): AsrQualityStats {
  return {
    audioSec: 0,
    speechSec: 0,
    silentSec: 0,
    droppedSegments: 0,
    textLength: 0,
    coarseSlices: 0,
    segmentCount: 0,
  };
}

/**
 * Whisper 在纯音乐/噪声/停顿上可能只输出特殊 token 和时间戳；transformers.js
 * 合并分块时会拿空数组调用 tokenizer.decode，抛出
 * "token_ids must be a non-empty array of integers."。
 * 该错误意味着这个切片没有可转写文本，按空结果跳过，而不是让整个分片作业失败。
 */
function isEmptyTokenOutput(err: unknown): boolean {
  return /token_ids must be a non-empty array of integers/i.test(toAppError(err).detail ?? '');
}

/**
 * 转写一段 16k 单声道 PCM。
 *
 * 600 秒的分片会再切成 60 秒的推理切片，原因：
 *  - transformers.js 在长音频末尾缺时间戳时会把整段文本挂到最后一个时间点，切片后
 *    塌陷范围最多 60 秒；
 *  - 静音切片直接跳过，既避免 Whisper 幻觉，也节省计算；
 *  - 暂停/取消最多等一个切片（60 秒）即可生效，而不是等完整 10 分钟。
 *
 * 注意：`offsetSec` 仍按调用方传入的分片起点计算，返回的段落时间戳是整节课的绝对时间。
 */
export async function transcribeChunkDetailed(
  pcm: Float32Array,
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
  if (!cached) throw new AppError('ASR_MODEL_MISSING');
  const pipeline = cached.pipe;
  const sampleRate = ASR_PARAMS.sampleRate;
  const totalSec = pcm.length / sampleRate;
  const stats = emptyStats();
  stats.audioSec = totalSec;
  if (pcm.length === 0) return { segments: [], stats };

  const sliceFrames = Math.max(1, Math.round(ASR_PARAMS.inferSliceSec * sampleRate));
  const segments: TranscriptSegment[] = [];
  let sliceIndex = 0;

  for (let startFrame = 0; startFrame < pcm.length; startFrame += sliceFrames, sliceIndex += 1) {
    const control = opts.shouldStop?.() ?? 'none';
    if (control === 'cancel') throw new AppError('ASR_CANCELLED');
    if (control === 'pause') {
      await opts.waitIfPaused?.();
      if (opts.shouldStop?.() === 'cancel') throw new AppError('ASR_CANCELLED');
    }

    const endFrame = Math.min(pcm.length, startFrame + sliceFrames);
    const slice = pcm.subarray(startFrame, endFrame);
    const sliceSec = slice.length / sampleRate;
    const offsetSec = opts.offsetSec + startFrame / sampleRate;

    // 数字静音上 Whisper 会输出重复标点/“谢谢观看”等幻觉，直接跳过推理
    const level = analyzeAudioLevel(slice);
    if (level.silent) {
      stats.silentSec += sliceSec;
      log.debug('推理切片为静音，跳过', {
        offsetSec: Math.round(offsetSec),
        sliceSec: Math.round(sliceSec),
        rms: Math.round(level.rms * 1000) / 1000,
      });
      continue;
    }

    const startedAt = Date.now();
    let output: Awaited<ReturnType<WhisperPipeline>>;
    try {
      output = await pipeline(slice, {
        language: opts.lang === 'auto' ? undefined : opts.lang,
        task: 'transcribe',
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
        initial_prompt: opts.glossaryPrompt,
      });
    } catch (err) {
      if (isEmptyTokenOutput(err)) {
        stats.silentSec += sliceSec;
        log.info('推理切片没有文本 token，按静音跳过', {
          offsetSec: Math.round(offsetSec),
          sliceSec: Math.round(sliceSec),
          detail: toAppError(err).detail,
        });
        continue;
      }
      throw new AppError('ASR_INFER_FAILED', {
        detail: toAppError(err).detail,
        retryable: true,
        cause: err,
      });
    }
    const elapsed = (Date.now() - startedAt) / 1000;
    stats.speechSec += sliceSec;

    let built = buildSegmentsFromWhisper(output.chunks ?? [], {
      offsetSec,
      audioDurationSec: sliceSec,
      maxSegmentSec: ASR_PARAMS.inferSliceSec,
    });
    // 极少数模型/输入只返回 text 而没有 chunks：按整片一个粗粒度段落兜底
    if (built.textLength === 0 && built.dropped === 0 && output.text?.trim()) {
      built = buildSegmentsFromWhisper([{ text: output.text, timestamp: [0, sliceSec] }], {
        offsetSec,
        audioDurationSec: sliceSec,
        maxSegmentSec: ASR_PARAMS.inferSliceSec,
      });
    }

    segments.push(...built.segments);
    stats.droppedSegments += built.dropped;
    stats.textLength += built.textLength;
    if (built.timestampQuality === 'coarse') stats.coarseSlices += 1;

    log.debug('推理切片完成', {
      slice: sliceIndex,
      offsetSec: Math.round(offsetSec),
      sliceSec: Math.round(sliceSec),
      elapsedSec: Math.round(elapsed),
      rate: elapsed > 0 ? Math.round((sliceSec / elapsed) * 10) / 10 : 0,
      segments: built.segments.length,
      dropped: built.dropped,
      quality: built.timestampQuality,
      rms: Math.round(level.rms * 1000) / 1000,
      textLength: built.textLength,
    });
  }

  stats.segmentCount = segments.length;
  log.info('分片转写完成', {
    offsetSec: Math.round(opts.offsetSec),
    audioSec: Math.round(totalSec),
    speechSec: Math.round(stats.speechSec),
    silentSec: Math.round(stats.silentSec),
    segments: stats.segmentCount,
    dropped: stats.droppedSegments,
    coarseSlices: stats.coarseSlices,
    textLength: stats.textLength,
  });
  return { segments, stats };
}

/** 兼容旧调用方：只返回段落 */
export async function transcribeChunk(
  pcm: Float32Array,
  opts: TranscribeOptions,
): Promise<TranscriptSegment[]> {
  return (await transcribeChunkDetailed(pcm, opts)).segments;
}

/** 释放管线（取消作业时调用，释放显存/内存） */
export async function disposePipeline(): Promise<void> {
  const old = cached;
  cached = null;
  if (!old) return;
  try {
    const disposable = old.pipe as unknown as { dispose?: () => Promise<void> };
    await disposable.dispose?.();
  } catch {
    /* 忽略 */
  }
  log.info('推理管线已释放');
}

export function currentDevice(): string | null {
  return cached?.device ?? null;
}
