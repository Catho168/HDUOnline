/**
 * callOp RPC 客户端可靠性测试（第 253 轮，可靠性域 / 防御视角）。
 *
 * 覆盖 callOp 链路各环节（发送 → handler 响应 → 错误反序列化）与全局
 * unhandledrejection 安全网：
 *  1. 正常路径：RESPONSE.ok=true → 结果透传；
 *  2. 业务错误：ok=false → deserializeError 复原 AppError（code / userMessage /
 *     retryable 原样带回，errorTextOf 直出 userMessage）；
 *  3. 响应结构异常 / chrome.runtime 缺失 → AppError UNKNOWN；
 *  4. sendMessage 直接拒绝（SW 未就绪等）→ 原始错误透传；
 *  5. 默认 30s 超时（fake timers）：SW 被杀 / handler 挂起场景兜底 reject，
 *     userMessage「操作超时，请重试」+ retryable（errorTextOf 口径对齐，第 253 轮）；
 *  6. timeoutMs 可覆写、AbortSignal 中止 → LLM_ABORTED；
 *  7. installUnhandledRejectionSafetyNet：注册 / 上报（Error 与原始值 reason）/
 *     缺省 console 通道 / 退订。
 */

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { AppError } from '@/core/shared/errors';
import { callOp, installUnhandledRejectionSafetyNet } from '@/core/shared/client';

function stubSendMessage(impl: (message: unknown) => Promise<unknown>): Mock {
  const sendMessage = vi.fn(impl);
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  return sendMessage;
}

function okResponse(result: unknown): unknown {
  return { type: 'RESPONSE', requestId: 'req-1', ok: true, result };
}

function errResponse(serialized: unknown): unknown {
  return { type: 'RESPONSE', requestId: 'req-1', ok: false, error: serialized };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('callOp 链路（发送 → 响应 → 错误反序列化）', () => {
  it('RESPONSE.ok=true → 结果透传', async () => {
    stubSendMessage(async () => okResponse([{ id: 'job-1' }]));
    await expect(callOp('review.due', {})).resolves.toEqual([{ id: 'job-1' }]);
  });

  it('ok=false → deserializeError 复原 AppError（userMessage 直出）', async () => {
    stubSendMessage(async () =>
      errResponse({ code: 'DB_FAILED', userMessage: '本地数据读写失败', detail: 'boom', retryable: false }),
    );
    const err = (await callOp('review.due', {}).catch((e) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('DB_FAILED');
    expect(err.userMessage).toBe('本地数据读写失败');
    expect(err.retryable).toBe(false);
  });

  it('非 RESPONSE 结构 → AppError UNKNOWN（RPC 响应格式异常）', async () => {
    stubSendMessage(async () => ({ type: 'OTHER' }));
    const err = (await callOp('review.due', {}).catch((e) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.userMessage).toBe('发生未知错误');
    expect(err.detail).toContain('RPC 响应格式异常');
  });

  it('sendMessage 直接拒绝 → 原始错误透传（UI 侧 errorTextOf 兜底文案）', async () => {
    stubSendMessage(async () => {
      throw new Error('Could not establish connection');
    });
    const err = (await callOp('review.due', {}).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Could not establish connection');
  });

  it('chrome.runtime 缺失 → AppError UNKNOWN', async () => {
    vi.stubGlobal('chrome', {});
    const err = (await callOp('review.due', {}).catch((e) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.detail).toContain('chrome.runtime unavailable');
  });

  it('请求消息携带 requestId / op / args（REQUEST 信封）', async () => {
    const sendMessage = stubSendMessage(async () => okResponse([]));
    await callOp('schedule.exclude', { courId: 7, excluded: true });
    const sent = sendMessage.mock.calls[0]?.[0] as { type: string; requestId: string; op: string; args: unknown };
    expect(sent.type).toBe('REQUEST');
    expect(sent.op).toBe('schedule.exclude');
    expect(sent.args).toEqual({ courId: 7, excluded: true });
    expect(sent.requestId).toBeTypeOf('string');
  });
});

describe('callOp 超时兜底（第 253 轮文案对齐 errorTextOf）', () => {
  it('默认 30s 超时：挂起请求被拒，「操作超时，请重试」+ retryable，detail 带操作名', async () => {
    vi.useFakeTimers();
    stubSendMessage(() => new Promise(() => undefined));
    let captured: AppError | undefined;
    const settled = callOp('review.due', {}).catch((e) => {
      captured = e as AppError;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(captured).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(captured).toBeInstanceOf(AppError);
    expect(captured?.userMessage).toBe('操作超时，请重试');
    expect(captured?.retryable).toBe(true);
    expect(captured?.detail).toContain('review.due');
    await settled;
  });

  it('timeoutMs 可覆写（关键写操作走更短超时的口子保留）', async () => {
    vi.useFakeTimers();
    stubSendMessage(() => new Promise(() => undefined));
    let captured: AppError | undefined;
    const settled = callOp('review.due', {}, { timeoutMs: 500 }).catch((e) => {
      captured = e as AppError;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(captured).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(captured).toBeInstanceOf(AppError);
    expect(captured?.userMessage).toBe('操作超时，请重试');
    await settled;
  });

  it('AbortSignal 中止 → LLM_ABORTED（已中止信号传入也立即拒绝，第 253 轮修复）', async () => {
    stubSendMessage(() => new Promise(() => undefined));
    const controller = new AbortController();
    controller.abort();
    const err = (await callOp('review.due', {}, { signal: controller.signal }).catch((e) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('LLM_ABORTED');
  });

  it('AbortSignal 调用中途中止 → LLM_ABORTED', async () => {
    stubSendMessage(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = callOp('review.due', {}, { signal: controller.signal }).catch((e) => e as AppError);
    controller.abort();
    const err = (await pending) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('LLM_ABORTED');
  });
});

describe('installUnhandledRejectionSafetyNet（全局未处理拒绝安全网，第 253 轮）', () => {
  /** 打桩 globalThis 的 EventTarget 接口，捕获注册的 unhandledrejection 回调 */
  function stubEventTarget(): Map<string, (event: { reason?: unknown }) => void> {
    const registered = new Map<string, (event: { reason?: unknown }) => void>();
    vi.stubGlobal(
      'addEventListener',
      (type: string, cb: (event: { reason?: unknown }) => void) => {
        registered.set(type, cb);
      },
    );
    vi.stubGlobal('removeEventListener', (type: string) => {
      registered.delete(type);
    });
    return registered;
  }

  it('注册监听并上报 Error / 原始值 reason；退订后不再上报', () => {
    const registered = stubEventTarget();
    const report = vi.fn();
    const off = installUnhandledRejectionSafetyNet(report);
    expect(registered.get('unhandledrejection')).toBeTypeOf('function');
    registered.get('unhandledrejection')!({ reason: new TypeError('x is not a function') });
    expect(report).toHaveBeenCalledWith('捕获未处理的 Promise 拒绝', 'TypeError: x is not a function');
    registered.get('unhandledrejection')!({ reason: 'boom-string' });
    expect(report).toHaveBeenLastCalledWith('捕获未处理的 Promise 拒绝', 'boom-string');
    off();
    expect(registered.has('unhandledrejection')).toBe(false);
  });

  it('缺省通道走 console.warn（静默记录，不弹 UI）', () => {
    const registered = stubEventTarget();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const off = installUnhandledRejectionSafetyNet();
      registered.get('unhandledrejection')!({ reason: new AppError('DB_FAILED', { detail: 'disk' }) });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('捕获未处理的 Promise 拒绝');
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('AppError: 本地数据读写失败');
      off();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('EventTarget 接口缺失（极端环境）→ 返回空退订不抛错', () => {
    vi.stubGlobal('addEventListener', undefined);
    vi.stubGlobal('removeEventListener', undefined);
    const off = installUnhandledRejectionSafetyNet(vi.fn());
    expect(() => off()).not.toThrow();
  });
});
