/**
 * 内容脚本 / 扩展页面 → Service Worker 的 RPC 客户端与事件订阅。
 * 统一处理 requestId、超时与错误反序列化。
 */

import { deserializeError, AppError, type SerializedAppError } from './errors';
import type { BackgroundToContent, EventPayload, ResponseMessage } from './messages';
import type { OpArgs, OpName, OpResult } from './ops';
import { uuid } from './utils';

interface RuntimeLike {
  sendMessage?: (message: unknown) => Promise<unknown>;
  onMessage?: {
    addListener: (cb: (message: unknown) => void) => void;
    removeListener: (cb: (message: unknown) => void) => void;
  };
  lastError?: { message?: string };
}

function chromeRuntime(): RuntimeLike | undefined {
  return (globalThis as unknown as { chrome?: { runtime?: RuntimeLike } }).chrome?.runtime;
}

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function callOp<N extends OpName>(op: N, args: OpArgs<N>, options: CallOptions = {}): Promise<OpResult<N>> {
  const rt = chromeRuntime();
  if (!rt?.sendMessage) throw new AppError('UNKNOWN', { detail: 'chrome.runtime unavailable' });
  const requestId = uuid();
  const request = { type: 'REQUEST', requestId, op, args };
  const timeoutMs = options.timeoutMs ?? 30_000;

  const result = await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AppError('UNKNOWN', { detail: `RPC timeout: ${op}` }));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new AppError('LLM_ABORTED', { detail: `RPC aborted: ${op}` }));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    rt.sendMessage!(request).then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });

  const response = result as ResponseMessage | undefined;
  if (!response || response.type !== 'RESPONSE') {
    throw new AppError('UNKNOWN', { detail: `RPC 响应格式异常：${op}` });
  }
  if (!response.ok) {
    throw deserializeError(response.error ?? { code: 'UNKNOWN', userMessage: '操作失败', retryable: false });
  }
  return response.result as OpResult<N>;
}

/** 订阅 SW 推送事件（内容脚本） */
export function onBackgroundEvent(cb: (event: EventPayload) => void): () => void {
  const rt = chromeRuntime();
  if (!rt?.onMessage) return () => undefined;
  const listener = (raw: unknown) => {
    const msg = raw as BackgroundToContent | undefined;
    if (msg?.type === 'EVENT') cb(msg.payload);
  };
  rt.onMessage.addListener(listener);
  return () => rt.onMessage!.removeListener(listener);
}

/** 把 SW 的原始错误统一转成 AppError */
export function normalizeRpcError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const maybe = err as { error?: SerializedAppError; message?: string };
  if (maybe?.error) return deserializeError(maybe.error);
  return new AppError('UNKNOWN', { detail: maybe?.message ?? String(err) });
}
