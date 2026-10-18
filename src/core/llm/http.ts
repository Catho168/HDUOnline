/**
 * 带超时与错误分类的 HTTP 层（技术文档 §6.2 通用实现要求）。
 *
 * 超时口径：连接 15s、首字节 60s、整体 300s（均可在设置调整）。
 *  - 连接超时只覆盖“建立连接 + 收到响应头”，响应头到达后即解除；
 *  - 首字节超时覆盖响应体的第一次读取；
 *  - 整体超时覆盖到响应体读取结束，由调用方在结束时 `dispose()`。
 *
 * 错误分类：401/403 → 鉴权失败；429 → 限流（可重试）；5xx → 服务端错误（可重试）；
 * 其他 4xx → 不重试并透出服务端 message；网络错误 → LLM_NETWORK_ERROR（可重试）。
 */

import { AppError } from '../shared/errors';
import { redactUrl } from '../shared/urlGuard';
import { truncate } from '../shared/utils';
import type { LlmTimeouts } from './types';

export type AbortReason = 'external' | 'connect-timeout' | 'total-timeout' | null;

export interface FetchOptions {
  timeouts: LlmTimeouts;
  signal?: AbortSignal;
}

export interface AttemptAbort {
  controller: AbortController;
  /** 触发原因，用于错误分类 */
  readonly reason: AbortReason;
  /** 响应头已到达：连接阶段结束，清除连接超时计时器 */
  clearConnectTimer(): void;
  dispose(): void;
}

function makeAbort(external: AbortSignal | undefined, timeouts: LlmTimeouts, labels: { connect: boolean; total: boolean }): AttemptAbort {
  const controller = new AbortController();
  let reason: AbortReason = null;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;

  const abortWith = (next: Exclude<AbortReason, null>) => {
    if (reason) return;
    reason = next;
    controller.abort(new DOMException(next, 'AbortError'));
  };
  function onExternal() {
    abortWith('external');
  }
  if (external) {
    if (external.aborted) onExternal();
    else external.addEventListener('abort', onExternal, { once: true });
  }
  if (labels.connect && Number.isFinite(timeouts.connectMs) && timeouts.connectMs > 0) {
    connectTimer = setTimeout(() => abortWith('connect-timeout'), timeouts.connectMs);
  }
  if (labels.total && Number.isFinite(timeouts.totalMs) && timeouts.totalMs > 0) {
    totalTimer = setTimeout(() => abortWith('total-timeout'), timeouts.totalMs);
  }

  return {
    controller,
    get reason() {
      return reason;
    },
    clearConnectTimer() {
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    },
    dispose() {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      connectTimer = undefined;
      totalTimer = undefined;
      external?.removeEventListener('abort', onExternal);
    },
  };
}

/** 发起请求并完成“连接 + 响应头”阶段；随后由调用方消费 body（首字节超时由 `guardFirstByte` 处理）。 */
export async function startRequest(
  url: string,
  init: RequestInit,
  opts: FetchOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<{ response: Response; abort: AttemptAbort }> {
  const abort = makeAbort(opts.signal, opts.timeouts, { connect: true, total: true });
  try {
    const response = await fetchImpl(url, { ...init, signal: abort.controller.signal });
    // 响应头已收到：连接阶段结束。整体超时计时器继续生效。
    abort.clearConnectTimer();
    return { response, abort };
  } catch (err) {
    const reason = abort.reason;
    abort.dispose();
    throw classify(err, reason, url, opts.timeouts);
  }
}

/** 读取 body 时施加“首字节超时”（仅第一次读取使用）。 */
export function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  firstByteMs: number,
  signal?: AbortSignal,
): () => Promise<ReadableStreamReadResult<Uint8Array>> {
  return async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (!Number.isFinite(firstByteMs) || firstByteMs <= 0) return reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('first-byte-timeout');
        err.name = 'FirstByteTimeout';
        reject(err);
      }, firstByteMs);
    });
    const aborted = signal
      ? new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          onAbort = () => reject(new DOMException('aborted', 'AbortError'));
          signal.addEventListener('abort', onAbort, { once: true });
        })
      : undefined;
    try {
      const result = await Promise.race(aborted ? [reader.read(), timeout, aborted] : [reader.read(), timeout]);
      return result as ReadableStreamReadResult<Uint8Array>;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * 给响应体加“首字节超时”护栏，同时**保持整条流不被切断**——
 * SSE 解析必须看到连续的字节流（`data:` 行可能跨 chunk 断行）。
 */
export function guardFirstByte(response: Response, firstByteMs: number, signal?: AbortSignal): Response {
  const body = response.body;
  if (!body || !Number.isFinite(firstByteMs) || firstByteMs <= 0) return response;
  const reader = body.getReader();
  let first = true;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = first ? await readWithTimeout(reader, firstByteMs, signal)() : await reader.read();
        first = false;
        if (result.done) controller.close();
        else if (result.value) controller.enqueue(result.value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function seconds(ms: number): string {
  return String(Math.max(1, Math.round(ms / 1000)));
}

/** 错误分类 → AppError。 */
export function classify(err: unknown, reason: AbortReason, url?: string, timeouts?: LlmTimeouts): AppError {
  if (err instanceof AppError) return err;
  if (reason === 'external') return new AppError('LLM_ABORTED');
  if (reason === 'connect-timeout') {
    return new AppError('LLM_TIMEOUT', {
      userMessage: `无法在 ${timeouts ? seconds(timeouts.connectMs) : '15'} 秒内连接到 AI 服务，请检查网络或端点地址`,
      retryable: true,
    });
  }
  if (reason === 'total-timeout') {
    return new AppError('LLM_TIMEOUT', {
      userMessage: `AI 请求整体超时（${timeouts ? seconds(timeouts.totalMs) : '300'} 秒，可停止后重试）`,
      retryable: true,
    });
  }
  if (err instanceof Error && err.name === 'FirstByteTimeout') {
    return new AppError('LLM_TIMEOUT', {
      userMessage: `AI 服务 ${timeouts ? seconds(timeouts.firstByteMs) : '60'} 秒内未返回内容，请稍后重试`,
      retryable: true,
    });
  }
  if (err instanceof DOMException && err.name === 'AbortError') return new AppError('LLM_ABORTED');
  const message = err instanceof Error ? err.message : String(err);
  if (/Failed to fetch|NetworkError|net::ERR/i.test(message)) {
    return new AppError('LLM_NETWORK_ERROR', {
      detail: `${message}${url ? ` @ ${redactUrl(url)}` : ''}`,
      retryable: true,
    });
  }
  return new AppError('LLM_NETWORK_ERROR', { detail: message, retryable: true });
}

/** HTTP 状态码 → AppError（含服务端 message 抽取）。 */
export function classifyHttp(status: number, bodyText: string): AppError {
  const serverMessage = extractMessage(bodyText);
  const detail = `HTTP ${status}${serverMessage ? `: ${serverMessage}` : ''}`;
  if (status === 401 || status === 403) {
    return new AppError('LLM_AUTH_FAILED', {
      userMessage: status === 401 ? 'AI 服务鉴权失败（API Key 无效或已过期）' : 'AI 服务拒绝了该请求（权限或地域限制）',
      detail,
      retryable: false,
    });
  }
  if (status === 429) {
    return new AppError('LLM_RATE_LIMITED', { detail, retryable: true });
  }
  if (status >= 500) {
    return new AppError('LLM_SERVER_ERROR', { userMessage: `AI 服务暂时不可用（HTTP ${status}）`, detail, retryable: true });
  }
  if (status === 404) {
    return new AppError('LLM_SERVER_ERROR', {
      userMessage: 'AI 端点或模型不存在，请检查设置中的服务地址与模型名',
      detail,
      retryable: false,
    });
  }
  return new AppError('LLM_SERVER_ERROR', {
    userMessage: serverMessage ? `AI 服务返回错误：${truncate(serverMessage, 120)}` : `AI 服务返回错误（HTTP ${status}）`,
    detail,
    retryable: false,
  });
}

function extractMessage(bodyText: string): string | undefined {
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

/** 判断是否值得重试（网络错误 / 429 / 5xx；4xx 除 429 外不重试）。 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof AppError) return err.retryable;
  return false;
}
