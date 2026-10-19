/**
 * 云端 ASR 转写适配层（OpenAI 兼容 `POST {base}/v1/audio/transcriptions`）。
 *
 * 与 core/llm 分层同思路但独立接口：输入 16kHz 单声道 Float32 PCM、输出与本地
 * Whisper 对齐的 `WhisperChunkLike[]`，由 `buildSegmentsFromWhisper` 统一做时间戳
 * 偏移/塌陷检测/幻觉过滤，下游落库与 UI 因此与引擎无关。
 *
 * 关键点：
 *  - 60 秒切片编码为 16-bit WAV（约 1.9MB）multipart 上传；
 *  - 首选 `response_format=verbose_json`（带逐段 timestamps）；端点不支持（400 且
 *    报错文提及 response_format）时自动降级 `json`（纯 text），按整片粗粒度处理；
 *  - 错误分类照 core/llm/http.ts 口径：401/403 → ASR_AUTH_FAILED（不重试），
 *    429/5xx/网络/超时 → 可重试（内部按 CLOUD_ASR_MAX_RETRIES 次指数退避）；
 *  - 请求前经 urlGuard.checkUrl 双卡口（保存/请求两处同口径）。
 *
 * 运行在 ASR Worker 内（Worker 本就承载长时推理，跨域 fetch 有 transformers.js
 * 下载模型的先例），密钥经 WorkerStartPayload 由 Offscreen 注入。
 */

import { CLOUD_ASR_MAX_RETRIES, CLOUD_ASR_TIMEOUTS } from '../shared/constants';
import { AppError, toAppError } from '../shared/errors';
import { createLogger } from '../shared/logger';
import { checkUrl } from '../shared/urlGuard';
import { truncate } from '../shared/utils';
import { startRequest } from '../llm/http';
import type { WhisperChunkLike } from './postprocess';

const log = createLogger('asr-cloud');

export interface CloudAsrConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface CloudTranscribeOptions {
  lang: 'zh' | 'en' | 'auto';
  /** 词表偏置，映射 OpenAI 的 prompt 字段 */
  prompt?: string;
  signal?: AbortSignal;
  /** 本地/私网端点放行（与 secrets.allowLocalEndpoints 同口径，默认拒绝） */
  allowLocalEndpoints?: boolean;
  /** 覆盖默认超时（测试注入点） */
  timeouts?: { connectMs: number; totalMs: number };
  /** 重试退避基数毫秒（测试可注入小值提速） */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

const SAMPLE_RATE = 16_000;

/** Float32 PCM（[-1,1]）→ 16-bit 单声道 WAV（RIFF 头 44 字节 + n×2 数据） */
export function encodeWavPcm16(pcm: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM 块大小
  view.setUint16(20, 1, true); // PCM 编码
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < pcm.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, pcm[i] ?? 0));
    // 负值 toward-zero 截断与常见编码器一致
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

interface CloudSegment {
  start?: unknown;
  end?: unknown;
  text?: unknown;
}

function toFiniteSec(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
}

/** verbose_json / json 响应 → chunks；无逐段时间戳时按整片粗粒度包装（交给 buildSegmentsFromWhisper 做塌陷检测） */
function parseTranscriptionBody(
  body: unknown,
  sliceSec: number,
): { chunks: WhisperChunkLike[] } {
  const record = (body ?? {}) as { text?: unknown; segments?: unknown };
  const rawSegments = Array.isArray(record.segments) ? (record.segments as CloudSegment[]) : [];
  const chunks: WhisperChunkLike[] = [];
  for (const segment of rawSegments) {
    if (typeof segment.text !== 'string' || !segment.text.trim()) continue;
    chunks.push({
      text: segment.text,
      timestamp: [toFiniteSec(segment.start) ?? 0, toFiniteSec(segment.end)],
    });
  }
  if (chunks.length > 0) return { chunks };
  // 端点只给了纯文本（json 降级 / verbose_json 无 segments）：整片一个粗粒度段落
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!text) return { chunks: [] };
  return { chunks: [{ text, timestamp: [0, sliceSec] }] };
}

function extractServerMessage(bodyText: string): string | undefined {
  if (!bodyText) return undefined;
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const errObj = parsed.error as Record<string, unknown> | string | undefined;
    if (typeof errObj === 'string') return errObj;
    if (errObj && typeof errObj === 'object' && typeof errObj.message === 'string') return errObj.message;
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    /* 非 JSON：截取原文 */
  }
  return truncate(bodyText.replace(/\s+/g, ' ').trim(), 200);
}

/** HTTP 状态码 → AppError（照 http.ts classifyHttp 的 ASR 版口径） */
function classifyCloudHttp(status: number, bodyText: string): AppError {
  const serverMessage = extractServerMessage(bodyText);
  const detail = `HTTP ${status}${serverMessage ? `: ${serverMessage}` : ''}`;
  if (status === 401 || status === 403) {
    return new AppError('ASR_AUTH_FAILED', {
      userMessage:
        status === 401
          ? '云端转写服务鉴权失败（API Key 无效或已过期）'
          : '云端转写服务拒绝了该请求（权限或地域限制）',
      detail,
      retryable: false,
    });
  }
  if (status === 429) {
    return new AppError('ASR_NETWORK_FAILED', {
      userMessage: '云端转写服务限流，请稍后重试',
      detail,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new AppError('ASR_NETWORK_FAILED', {
      userMessage: `云端转写服务暂时不可用（HTTP ${status}）`,
      detail,
      retryable: true,
    });
  }
  return new AppError('ASR_INFER_FAILED', {
    userMessage: serverMessage
      ? `云端转写返回错误：${truncate(serverMessage, 120)}`
      : `云端转写返回错误（HTTP ${status}）`,
    detail,
    retryable: false,
  });
}

function buildFormData(cfg: CloudAsrConfig, wav: Uint8Array, format: 'verbose_json' | 'json', opts: CloudTranscribeOptions): FormData {
  const form = new FormData();
  // WAV Blob 必须带文件名，否则部分端点（硅基流动）按无文件处理
  form.append('file', new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', cfg.model);
  if (opts.lang !== 'auto') form.append('language', opts.lang);
  if (opts.prompt?.trim()) form.append('prompt', opts.prompt.trim());
  form.append('response_format', format);
  return form;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError('ASR_CANCELLED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 转写一段 16kHz 单声道 PCM（通常为 60 秒推理切片）。
 * 可重试错误（429/5xx/网络/超时）内部按 CLOUD_ASR_MAX_RETRIES 次退避重试；
 * 鉴权失败与 4xx 立即抛出，不做无谓重试。
 */
export async function transcribePcmCloud(
  pcm: Float32Array,
  cfg: CloudAsrConfig,
  opts: CloudTranscribeOptions,
): Promise<{ chunks: WhisperChunkLike[] }> {
  const verdict = checkUrl(cfg.baseUrl, { allowLocal: opts.allowLocalEndpoints === true });
  if (!verdict.ok) {
    throw new AppError('ASR_INFER_FAILED', {
      userMessage: verdict.message ?? '云端转写端点被安全策略拒绝',
      detail: `url-guard:${verdict.reason ?? 'rejected'}`,
      retryable: false,
    });
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`;
  const wav = encodeWavPcm16(pcm);
  const sliceSec = pcm.length / SAMPLE_RATE;
  const timeouts = {
    connectMs: opts.timeouts?.connectMs ?? CLOUD_ASR_TIMEOUTS.connectMs,
    firstByteMs: opts.timeouts?.totalMs ?? CLOUD_ASR_TIMEOUTS.totalMs,
    totalMs: opts.timeouts?.totalMs ?? CLOUD_ASR_TIMEOUTS.totalMs,
  };
  const retryDelayMs = opts.retryDelayMs ?? 1000;

  // verbose_json 优先；端点不支持（400 且报错文提及 response_format）降级 json 一次
  let downgradeToJson = false;
  let lastError: AppError | null = null;

  for (let attempt = 0; attempt <= CLOUD_ASR_MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      log.info('云端转写重试', { attempt, code: lastError?.code });
      await delay(retryDelayMs * attempt, opts.signal);
    }
    const format: 'verbose_json' | 'json' = downgradeToJson ? 'json' : 'verbose_json';
    let response: Response;
    let abort: { dispose(): void; reason: string | null };
    try {
      const started = await startRequest(
        url,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.apiKey}` },
          body: buildFormData(cfg, wav, format, opts),
        },
        { timeouts, signal: opts.signal },
        fetchImpl,
      );
      response = started.response;
      abort = started.abort;
    } catch (err) {
      const appErr = toAppError(err);
      // startRequest 内部已分类：LLM_TIMEOUT/LLM_NETWORK_ERROR/LLM_ABORTED → ASR 对应码
      lastError = remapLlmError(appErr);
      if (!lastError.retryable) throw lastError;
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      abort.dispose();
      // 端点不认 verbose_json：降级 json 重试一次（400 + 报错文提及 response_format）
      if (!downgradeToJson && response.status === 400 && /response_format/i.test(text)) {
        log.warn('端点不支持 verbose_json，降级 json', { status: response.status });
        downgradeToJson = true;
        attempt = -1; // 重置重试计数：降级视为新的首次尝试
        continue;
      }
      lastError = classifyCloudHttp(response.status, text);
      if (!lastError.retryable) throw lastError;
      continue;
    }

    try {
      const parsed: unknown = await response.json().catch(() => null);
      if (parsed === null) {
        throw new AppError('ASR_INFER_FAILED', {
          userMessage: '云端转写返回了无法解析的内容',
          detail: `HTTP ${response.status}，非 JSON 响应体`,
          retryable: true,
        });
      }
      abort.dispose();
      const { chunks } = parseTranscriptionBody(parsed, sliceSec);
      log.debug('云端切片转写完成', { sliceSec: Math.round(sliceSec), segments: chunks.length, format });
      return { chunks };
    } catch (err) {
      abort.dispose();
      // body 读取阶段的错误：区分外部取消、整体超时与网络中断
      if (abort.reason === 'external') throw new AppError('ASR_CANCELLED', { cause: err });
      if (abort.reason === 'total-timeout') {
        lastError = new AppError('ASR_NETWORK_FAILED', {
          userMessage: '云端转写请求超时，请稍后重试',
          detail: toAppError(err).detail,
          retryable: true,
        });
        continue;
      }
      lastError = toAppError(err, 'ASR_INFER_FAILED');
      if (!lastError.retryable) throw lastError;
      // 网络中断：按可重试错误继续
      if (lastError.code === 'ASR_INFER_FAILED') lastError = new AppError('ASR_NETWORK_FAILED', {
        detail: lastError.detail,
        retryable: true,
      });
    }
  }

  throw (
    lastError ??
    new AppError('ASR_NETWORK_FAILED', { userMessage: '云端转写失败，请稍后重试', retryable: true })
  );
}

/** startRequest 抛出的是 LLM_* 分类错误：映射为 ASR 语义（保留 retryable 口径） */
function remapLlmError(err: AppError): AppError {
  switch (err.code) {
    case 'LLM_ABORTED':
      return new AppError('ASR_CANCELLED', { detail: err.detail });
    case 'LLM_TIMEOUT':
      return new AppError('ASR_NETWORK_FAILED', {
        userMessage: err.userMessage.replace(/AI 服务/g, '云端转写服务'),
        detail: err.detail,
        retryable: true,
      });
    case 'LLM_NETWORK_ERROR':
      return new AppError('ASR_NETWORK_FAILED', { detail: err.detail, retryable: true });
    default:
      return err.retryable
        ? new AppError('ASR_NETWORK_FAILED', { detail: err.detail, retryable: true })
        : new AppError('ASR_INFER_FAILED', { detail: err.detail, retryable: false });
  }
}

/**
 * “测试连接”：上传 0.5 秒静音 WAV，验证端点可达、鉴权有效且返回文本字段。
 * 不经过重试（设置页需要即时反馈）。
 */
export async function testCloudAsr(
  cfg: CloudAsrConfig,
  opts: { fetchImpl?: typeof fetch; allowLocalEndpoints?: boolean } = {},
): Promise<{ ok: true; model: string }> {
  const result = await transcribePcmCloud(new Float32Array(Math.floor(SAMPLE_RATE / 2)), cfg, {
    lang: 'auto',
    allowLocalEndpoints: opts.allowLocalEndpoints,
    fetchImpl: opts.fetchImpl,
  });
  if (result.chunks.length === 0) {
    throw new AppError('ASR_INFER_FAILED', {
      userMessage: '云端转写服务返回了空结果',
      detail: 'test transcribe returned no text',
    });
  }
  return { ok: true, model: cfg.model };
}
