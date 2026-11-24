/**
 * 内容脚本 / 扩展页面 → Service Worker 的 RPC 客户端与事件订阅。
 * 统一处理 requestId、超时与错误反序列化。
 */

import { deserializeError, AppError } from './errors';
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
      // 超时文案对齐 errorTextOf 口径（第 253 轮 callOp 审计）：userMessage 直出可读文案
      // （此前落 UNKNOWN 兜底「发生未知错误」，超时语境丢失）；技术细节进 detail 进环形日志。
      // SW 被杀 / handler 挂起场景下 30s 兜底必然触发，标 retryable 供 UI 重试语义判断。
      reject(new AppError('UNKNOWN', { userMessage: '操作超时，请重试', detail: `RPC timeout: ${op}`, retryable: true }));
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
    // 已中止的信号传入时 abort 事件已错过（监听永不触发，调用挂到 30s 超时——
    // 第 253 轮单测实证的缺口）：注册后补一次当前态判定
    if (options.signal?.aborted) onAbort();
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

/**
 * 全局 unhandledrejection 安全网（第 253 轮 callOp 可靠性审计，防御视角落地）。
 *
 * 审计结论：全仓 `void callOp(...)` 约 27 处 fire-and-forget 调用点中 26 处已带
 * `.catch()`，仅 1 处缺口（shared.tsx MissedList「已到课」，本轮补齐）；但散落
 * `.then()` 链与第三方异步仍可能漏网——未处理拒绝在控制台只留一行告警、用户侧
 * 完全静默。本监听做最后一道网：**只记录、不弹 UI**（不打扰），message/detail
 * 经 createLogger 脱敏入环形日志，便于事后从「静默失败」用户反馈反查。
 *
 * 放在 globalThis（内容脚本下等同 window）；返回退订函数供 onInvalidated 清理。
 * 依赖 EventTarget 语义（Chrome 内容脚本 / jsdom 均满足），不满足时返回空退订。
 */
export function installUnhandledRejectionSafetyNet(
  report?: (message: string, detail?: string) => void,
): () => void {
  const target = globalThis as unknown as {
    addEventListener?: (type: string, cb: (event: { reason?: unknown }) => void) => void;
    removeEventListener?: (type: string, cb: (event: { reason?: unknown }) => void) => void;
  };
  if (!target.addEventListener || !target.removeEventListener) return () => undefined;
  const handler = (event: { reason?: unknown }): void => {
    const reason = event?.reason;
    const detail = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    if (report) {
      report('捕获未处理的 Promise 拒绝', detail);
    } else {
      // 缺省兜底通道：接 createLogger 的调用方应传入 logger.warn，落环形日志
      console.warn(`[unhandledrejection] 捕获未处理的 Promise 拒绝 — ${detail}`);
    }
  };
  target.addEventListener('unhandledrejection', handler);
  return () => target.removeEventListener!('unhandledrejection', handler);
}
