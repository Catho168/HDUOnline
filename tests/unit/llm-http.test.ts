/**
 * LLM HTTP 层测试（技术文档 §6.2 通用实现要求）：
 *  - 连接 / 首字节 / 整体三级超时（AbortController + fake timers）；
 *  - 外部中止、网络错误、HTTP 状态码错误分类与重试判定；
 *  - 流式首字节护栏（guardFirstByte）的边界：跨 chunk 字节连续、首字节之后不限时。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classify, classifyHttp, guardFirstByte, isRetryable, readWithTimeout, startRequest } from '@/core/llm/http';
import { AppError } from '@/core/shared/errors';
import { redactUrl } from '@/core/shared/urlGuard';

const TIMEOUTS = { connectMs: 5_000, firstByteMs: 1_000, totalMs: 300_000 };
const URL_ = 'https://api.example.com/v1/chat/completions';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 收到 abort 信号才失败的 fetch 桩（模拟真实 fetch 的中止行为） */
function fetchHangingUntilAbort(): typeof fetch {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
    });
  }) as unknown as typeof fetch;
}

function fetchCalls(fetchImpl: typeof fetch): Array<[string, RequestInit]> {
  return (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
}

// ───────────────────────── startRequest：连接与整体超时 ─────────────────────────

describe('startRequest', () => {
  it('成功：透传 init 并注入中止 signal；响应头到达后仅剩整体超时计时器', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;

    const { response, abort } = await startRequest(
      URL_,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      { timeouts: TIMEOUTS },
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const [calledUrl, calledInit] = fetchCalls(fetchImpl)[0] ?? [];
    expect(calledUrl).toBe(URL_);
    expect(calledInit?.method).toBe('POST');
    expect(calledInit?.signal).toBe(abort.controller.signal);
    expect(calledInit?.signal?.aborted).toBe(false);
    // 连接计时器已清除，整体超时计时器仍在计时
    expect(vi.getTimerCount()).toBe(1);
    abort.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('连接超时：connectMs 内未收到响应头 → LLM_TIMEOUT（可重试）', async () => {
    const promise = startRequest(URL_, {}, { timeouts: TIMEOUTS }, fetchHangingUntilAbort()).catch((err) => err);

    await vi.advanceTimersByTimeAsync(TIMEOUTS.connectMs - 1);
    // 超时前仍在等待
    expect(await Promise.race([promise, Promise.resolve('pending')])).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    const err = (await promise) as AppError;
    expect(err.code).toBe('LLM_TIMEOUT');
    expect(err.retryable).toBe(true);
    expect(err.userMessage).toBe('无法在 5 秒内连接到 AI 服务，请检查网络或端点地址');
  });

  it.each([
    [1500, '2 秒内连接'],
    [100, '1 秒内连接'],
  ])('连接超时秒数按 round(ms/1000) 计算且至少 1 秒（connectMs=%i）', async (connectMs, expected) => {
    const promise = startRequest(URL_, {}, { timeouts: { ...TIMEOUTS, connectMs } }, fetchHangingUntilAbort()).catch(
      (err) => err,
    );
    await vi.advanceTimersByTimeAsync(connectMs);
    const err = (await promise) as AppError;
    expect(err.userMessage).toContain(expected);
  });

  it('整体超时：响应头到达后计时继续，到点中止（reason=total-timeout）', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    const { abort } = await startRequest(URL_, {}, { timeouts: TIMEOUTS }, fetchImpl);

    // 已过连接超时点（连接计时器已清除），不应触发连接超时
    await vi.advanceTimersByTimeAsync(TIMEOUTS.connectMs + 1);
    expect(abort.reason).toBeNull();
    expect(abort.controller.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(TIMEOUTS.totalMs - TIMEOUTS.connectMs - 1);
    expect(abort.reason).toBe('total-timeout');
    expect(abort.controller.signal.aborted).toBe(true);

    const err = classify(new DOMException('aborted', 'AbortError'), abort.reason, URL_, TIMEOUTS);
    expect(err.code).toBe('LLM_TIMEOUT');
    expect(err.retryable).toBe(true);
    expect(err.userMessage).toContain('整体超时（300 秒');
  });

  it('dispose() 之后整体超时不再触发', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    const { abort } = await startRequest(URL_, {}, { timeouts: TIMEOUTS }, fetchImpl);
    abort.dispose();

    await vi.advanceTimersByTimeAsync(TIMEOUTS.totalMs + 1);
    expect(abort.reason).toBeNull();
    expect(abort.controller.signal.aborted).toBe(false);
  });

  it('外部 signal 中止 → LLM_ABORTED', async () => {
    const controller = new AbortController();
    const promise = startRequest(URL_, {}, { timeouts: TIMEOUTS, signal: controller.signal }, fetchHangingUntilAbort()).catch(
      (err) => err,
    );
    controller.abort();
    const err = (await promise) as AppError;
    expect(err.code).toBe('LLM_ABORTED');
  });

  it('外部 signal 已处于 aborted 状态 → 直接 LLM_ABORTED', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = (await startRequest(URL_, {}, { timeouts: TIMEOUTS, signal: controller.signal }, fetchHangingUntilAbort()).catch(
      (err) => err,
    )) as AppError;
    expect(err.code).toBe('LLM_ABORTED');
  });

  it('fetch 网络错误 → LLM_NETWORK_ERROR（可重试，detail 带脱敏 URL）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const err = (await startRequest('https://api.example.com/v1/chat/completions?token=secret', {}, { timeouts: TIMEOUTS }, fetchImpl).catch(
      (err) => err,
    )) as AppError;

    expect(err.code).toBe('LLM_NETWORK_ERROR');
    expect(err.retryable).toBe(true);
    expect(err.detail).toBe(`Failed to fetch @ ${redactUrl('https://api.example.com/v1/chat/completions?token=secret')}`);
    // URL 已脱敏：不包含 query（token）
    expect(err.detail).not.toContain('secret');
  });

  it('其他 fetch 异常兜底为 LLM_NETWORK_ERROR', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;

    const err = (await startRequest(URL_, {}, { timeouts: TIMEOUTS }, fetchImpl).catch((err) => err)) as AppError;
    expect(err.code).toBe('LLM_NETWORK_ERROR');
    expect(err.retryable).toBe(true);
    expect(err.detail).toBe('boom');
  });

  it('connectMs 非正数时不设连接超时，整体超时仍生效', async () => {
    const timeouts = { connectMs: 0, firstByteMs: 1_000, totalMs: 5_000 };
    const promise = startRequest(URL_, {}, { timeouts }, fetchHangingUntilAbort()).then(
      () => 'resolved' as const,
      (err: AppError) => err,
    );

    await vi.advanceTimersByTimeAsync(timeouts.totalMs - 1);
    expect(await Promise.race([promise, Promise.resolve('pending' as const)])).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    const outcome = await promise;
    expect(outcome).not.toBe('resolved');
    expect((outcome as AppError).code).toBe('LLM_TIMEOUT');
    expect((outcome as AppError).userMessage).toContain('整体超时（5 秒');
  });
});

// ───────────────────────── readWithTimeout：首字节超时 ─────────────────────────

describe('readWithTimeout', () => {
  it('及时读到数据 → 返回该 chunk', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('hello'));
      },
    });
    const read = readWithTimeout(stream.getReader(), TIMEOUTS.firstByteMs);
    const result = await read();
    expect(result.done).toBe(false);
    expect(decoder.decode(result.value)).toBe('hello');
  });

  it('超时未读到数据 → FirstByteTimeout；classify 归为可重试的 LLM_TIMEOUT', async () => {
    const stream = new ReadableStream<Uint8Array>({ start() {} }); // 永不出数据
    const read = readWithTimeout(stream.getReader(), TIMEOUTS.firstByteMs);
    const promise = read();
    promise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(TIMEOUTS.firstByteMs + 1);
    await expect(promise).rejects.toMatchObject({ name: 'FirstByteTimeout' });

    const firstByteError = new Error('first-byte-timeout');
    firstByteError.name = 'FirstByteTimeout';
    const err = classify(firstByteError, null, URL_, { connectMs: 15_000, firstByteMs: 60_000, totalMs: 300_000 });
    expect(err.code).toBe('LLM_TIMEOUT');
    expect(err.retryable).toBe(true);
    expect(err.userMessage).toBe('AI 服务 60 秒内未返回内容，请稍后重试');
  });

  it('外部 signal 中止 → AbortError；classify 归为 LLM_ABORTED', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    const read = readWithTimeout(stream.getReader(), 60_000, controller.signal);
    const promise = read();
    promise.catch(() => undefined);

    setTimeout(() => controller.abort(), 10);
    await vi.advanceTimersByTimeAsync(11);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    const err = classify(new DOMException('aborted', 'AbortError'), null);
    expect(err.code).toBe('LLM_ABORTED');
  });

  it('firstByteMs 非正数时直接透传 reader.read()（不设计时器）', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('x'));
      },
    });
    const read = readWithTimeout(stream.getReader(), 0);
    const result = await read();
    expect(decoder.decode(result.value)).toBe('x');
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ───────────────────────── guardFirstByte：流式首字节护栏 ─────────────────────────

describe('guardFirstByte', () => {
  function responseFrom(chunks: string[], status = 200): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { status, headers: { 'content-type': 'text/event-stream' } },
    );
  }

  it('保持整条流连续：SSE 行跨 chunk 断行时字节不丢', async () => {
    const chunks = ['data: {"delta":"你"', '好"}\n\n', 'data: [DONE]\n\n'];
    const guarded = guardFirstByte(responseFrom(chunks), TIMEOUTS.firstByteMs);
    expect(guarded.status).toBe(200);
    expect(guarded.headers.get('content-type')).toBe('text/event-stream');
    expect(await guarded.text()).toBe(chunks.join(''));
  });

  it('首字节超时 → 流以 FirstByteTimeout 报错（不吞错）', async () => {
    const guarded = guardFirstByte(
      new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
      TIMEOUTS.firstByteMs,
    );
    const reader = guarded.body?.getReader();
    expect(reader).toBeDefined();
    const promise = reader!.read();
    promise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(TIMEOUTS.firstByteMs + 1);
    await expect(promise).rejects.toMatchObject({ name: 'FirstByteTimeout' });
  });

  it('首字节之后不再受首字节超时约束：慢到的后续 chunk 仍完整送达', async () => {
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
        controller.enqueue(encoder.encode('first'));
      },
    });
    const guarded = guardFirstByte(new Response(stream), TIMEOUTS.firstByteMs);
    const reader = guarded.body!.getReader();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('first');

    // 3 倍首字节超时之后才到的第二块：首字节护栏只管第一次读取
    setTimeout(() => {
      upstream?.enqueue(encoder.encode('second'));
      upstream?.close();
    }, TIMEOUTS.firstByteMs * 3);
    const secondPromise = reader.read();
    secondPromise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(TIMEOUTS.firstByteMs * 3 + 1);

    const second = await secondPromise;
    expect(second.done).toBe(false);
    expect(decoder.decode(second.value)).toBe('second');
    expect((await reader.read()).done).toBe(true);
  });

  it('无 body 或 firstByteMs 非法时原样返回同一 Response', () => {
    const noBody = new Response(null, { status: 204 });
    expect(guardFirstByte(noBody, TIMEOUTS.firstByteMs)).toBe(noBody);
    expect(guardFirstByte(noBody, 0)).toBe(noBody);
    expect(guardFirstByte(noBody, -5)).toBe(noBody);
    expect(guardFirstByte(noBody, Number.POSITIVE_INFINITY)).toBe(noBody);
  });
});

// ───────────────────────── classify：错误分类 ─────────────────────────

describe('classify', () => {
  it('AppError 原样透传（同一实例）', () => {
    const original = new AppError('LLM_BAD_OUTPUT', { retryable: false });
    expect(classify(original, null)).toBe(original);
  });

  it('reason=external → LLM_ABORTED（即使底层是普通错误）', () => {
    expect(classify(new Error('x'), 'external').code).toBe('LLM_ABORTED');
  });

  it('无 reason 的 AbortError → LLM_ABORTED', () => {
    expect(classify(new DOMException('aborted', 'AbortError'), null).code).toBe('LLM_ABORTED');
  });

  it('connect-timeout：文案带秒数，可重试', () => {
    const err = classify(new DOMException('x', 'AbortError'), 'connect-timeout', URL_, {
      connectMs: 15_000,
      firstByteMs: 60_000,
      totalMs: 300_000,
    });
    expect(err.code).toBe('LLM_TIMEOUT');
    expect(err.retryable).toBe(true);
    expect(err.userMessage).toBe('无法在 15 秒内连接到 AI 服务，请检查网络或端点地址');
  });

  it('connect-timeout 未传 timeouts 时按 15 秒兜底', () => {
    expect(classify(new Error('x'), 'connect-timeout').userMessage).toContain('15 秒');
  });

  it('total-timeout：文案带秒数（默认 300 秒），可重试', () => {
    const err = classify(new Error('x'), 'total-timeout');
    expect(err.code).toBe('LLM_TIMEOUT');
    expect(err.retryable).toBe(true);
    expect(err.userMessage).toContain('整体超时（300 秒');
  });

  it('FirstByteTimeout → LLM_TIMEOUT；未传 timeouts 时按 60 秒兜底', () => {
    const err = new Error('first-byte-timeout');
    err.name = 'FirstByteTimeout';
    const classified = classify(err, null);
    expect(classified.code).toBe('LLM_TIMEOUT');
    expect(classified.retryable).toBe(true);
    expect(classified.userMessage).toContain('60 秒内未返回内容');
  });

  it.each([
    ['Failed to fetch'],
    ['NetworkError when attempting to fetch resource.'],
    ['net::ERR_NAME_NOT_RESOLVED'],
    ['net::ERR_CONNECTION_REFUSED'],
  ])('网络错误「%s」→ LLM_NETWORK_ERROR（可重试）', (message) => {
    const err = classify(new TypeError(message), null, URL_);
    expect(err.code).toBe('LLM_NETWORK_ERROR');
    expect(err.retryable).toBe(true);
    expect(err.detail).toContain(message);
  });

  it('普通错误也归入 LLM_NETWORK_ERROR（detail 保留原始 message）', () => {
    const err = classify(new Error('boom'), null);
    expect(err.code).toBe('LLM_NETWORK_ERROR');
    expect(err.retryable).toBe(true);
    expect(err.detail).toBe('boom');
  });

  it('非 Error 抛出物按字符串归入 LLM_NETWORK_ERROR', () => {
    const err = classify('boom-string', null);
    expect(err.code).toBe('LLM_NETWORK_ERROR');
    expect(err.detail).toBe('boom-string');
  });
});

// ───────────────────────── classifyHttp：HTTP 状态分类 ─────────────────────────

describe('classifyHttp', () => {
  it.each([
    [401, 'LLM_AUTH_FAILED', false],
    [403, 'LLM_AUTH_FAILED', false],
    [429, 'LLM_RATE_LIMITED', true],
    [500, 'LLM_SERVER_ERROR', true],
    [502, 'LLM_SERVER_ERROR', true],
    [503, 'LLM_SERVER_ERROR', true],
    [404, 'LLM_SERVER_ERROR', false],
    [400, 'LLM_SERVER_ERROR', false],
    [422, 'LLM_SERVER_ERROR', false],
  ])('HTTP %i → %s（retryable=%s）', (status, code, retryable) => {
    const err = classifyHttp(status, JSON.stringify({ error: { message: 'server says no' } }));
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.detail).toBe(`HTTP ${status}: server says no`);
  });

  it('401/403/404/5xx 的用户文案', () => {
    expect(classifyHttp(401, '').userMessage).toContain('鉴权失败');
    expect(classifyHttp(403, '').userMessage).toContain('拒绝了该请求');
    expect(classifyHttp(404, '').userMessage).toContain('端点或模型不存在');
    expect(classifyHttp(503, '').userMessage).toBe('AI 服务暂时不可用（HTTP 503）');
  });

  it('服务端 message 抽取：error 字符串 / message / detail 字段', () => {
    expect(classifyHttp(400, JSON.stringify({ error: 'plain' })).userMessage).toBe('AI 服务返回错误：plain');
    expect(classifyHttp(409, JSON.stringify({ message: 'conflict' })).userMessage).toBe('AI 服务返回错误：conflict');
    expect(classifyHttp(422, JSON.stringify({ detail: 'bad input' })).userMessage).toBe('AI 服务返回错误：bad input');
  });

  it('非 JSON 响应体折叠空白后透出', () => {
    // 4xx：服务端原文进 userMessage；5xx：固定文案，原文只进 detail
    expect(classifyHttp(400, '<html>  bad\n gateway </html>').userMessage).toBe(
      'AI 服务返回错误：<html> bad gateway </html>',
    );
    const serverError = classifyHttp(502, '<html>  bad\n gateway </html>');
    expect(serverError.userMessage).toBe('AI 服务暂时不可用（HTTP 502）');
    expect(serverError.detail).toBe('HTTP 502: <html> bad gateway </html>');
  });

  it('超长响应体截断（detail 200 字符、userMessage 120 字符）', () => {
    const err = classifyHttp(400, 'x'.repeat(500));
    expect(err.detail).toBe(`HTTP 400: ${'x'.repeat(199)}…`);
    expect(err.userMessage).toBe(`AI 服务返回错误：${'x'.repeat(119)}…`);
  });

  it('空响应体不附加服务端消息', () => {
    const err = classifyHttp(400, '');
    expect(err.detail).toBe('HTTP 400');
    expect(err.userMessage).toBe('AI 服务返回错误（HTTP 400）');
  });
});

// ───────────────────────── isRetryable ─────────────────────────

describe('isRetryable', () => {
  it('以 AppError.retryable 为准；非 AppError 一律不重试', () => {
    expect(isRetryable(new AppError('LLM_RATE_LIMITED', { retryable: true }))).toBe(true);
    expect(isRetryable(new AppError('LLM_AUTH_FAILED'))).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
    expect(isRetryable('boom')).toBe(false);
  });
});
