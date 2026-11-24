/**
 * 站点接口 15s 超时收口的回归测试（第 18 轮 P3-1/P3-2/P3-3）。
 *
 * 超时由 fetchSiteRaw 统一套在 fetch + 读体整个生命周期上（AbortController 手动组合
 * 外部 signal，不用 AbortSignal.any——Chrome 110 兼容）。这里验证：
 *  - fetch 阶段挂起：15s 超时失败，detail 含「站点接口超时（15s 无响应）」；
 *  - 响应头已到但读体挂起：同样 15s 超时（clearTimeout 已移到读体完成之后）；
 *  - /oauth2/token 换 token 挂起：15s 被切断，业务请求降级（不带 jwt-token）照常发出；
 *  - 超时直接失败，不触发 invalidateSiteToken + 换 token 重放（P3-3）；
 *  - HTTP 401 的既有「换 token 重放一次」语义不受影响（反证）；
 *  - 超时路径含 “401” 数字（如 acteId=4013）时不误判为鉴权过期、不换 token 重放（第 20 轮 P3）；
 *  - 外部 signal 携带 TimeoutError reason 中止时按中止透传，不被误判为站点超时（第 20 轮 P3）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FetchCall = { url: string; init?: RequestInit };
type Responder = (call: FetchCall) => Response | Promise<Response>;

/** 生成站点同形态的 JWT（exp 为秒级时间戳） */
function jwtWithExp(expSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ exp: expSeconds })}.signature-padding-1234567890`;
}

const ACCESS_TOKEN = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
const FRESH_TOKEN = jwtWithExp(Math.floor(Date.now() / 1000) + 7200);

/** Node 环境没有 Web Storage：用最小实现模拟站点的 sessionStorage/localStorage */
function memoryStorage(init: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(init));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  } as Storage;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? record[key] : undefined;
}

/** fetch 永不返回；signal 中止时按真实 fetch 的语义以中止原因 reject */
function hangUntilAborted(): Responder {
  return ({ init }) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** 立即返回响应头，但响应体永不结束；signal 中止时让读体以中止原因失败 */
function hangBody(): Responder {
  return ({ init }) => {
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"code":"0","data":'));
        const onAbort = () =>
          controller.error(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('site api：15s 超时收口', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubFetch(respond: (url: string) => Responder | undefined): FetchCall[] {
    const calls: FetchCall[] = [];
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });
      const responder = respond(url);
      if (responder) return responder({ url, init });
      return jsonResponse({ code: '0', data: null });
    });
    vi.stubGlobal('fetch', fn);
    return calls;
  }

  it('fetch 阶段挂起：15s 超时失败，detail 含中文超时提示', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage({ JY__STORAGE_KEY_JWT_TOKEN: ACCESS_TOKEN }));
    const calls = stubFetch((url) => (url.includes('/v1/group_subject_vod_list/') ? hangUntilAborted() : undefined));
    const api = await import('@/entrypoints/content/site/api');

    const pending = api.fetchCourseWall(15, 1);
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'SITE_API_FAILED',
      detail: expect.stringContaining('站点接口超时（15s 无响应）'),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    // 超时直接失败：只发了一次业务请求，没有重放
    expect(calls.filter((item) => item.url.includes('/v1/group_subject_vod_list/'))).toHaveLength(1);
  });

  it('响应头已到但读体挂起：同样 15s 超时（超时覆盖读体阶段）', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage({ JY__STORAGE_KEY_JWT_TOKEN: ACCESS_TOKEN }));
    const calls = stubFetch((url) => (url.includes('/v1/group_subject_vod_list/') ? hangBody() : undefined));
    const api = await import('@/entrypoints/content/site/api');

    let settled = false;
    const pending = api.fetchCourseWall(15, 1);
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // 14s 时响应头早已返回、读体仍挂起：不应超时
    //（旧实现拿到响应头就 clearTimeout，读体挂起会永久等待——本用例即回归该项）
    await vi.advanceTimersByTimeAsync(14_000);
    expect(settled).toBe(false);

    // 第 15s：读体阶段超时触发
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    await expect(pending).rejects.toMatchObject({
      detail: expect.stringContaining('站点接口超时（15s 无响应）'),
    });
    expect(calls.filter((item) => item.url.includes('/v1/group_subject_vod_list/'))).toHaveLength(1);
  });

  it('oauth2 换 token 挂起：15s 被切断，业务请求降级（不带 jwt-token）照常发出', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('/oauth2/token')) return hangUntilAborted();
      if (url.includes('/v1/group_subject_vod_list/')) {
        return () => jsonResponse({ code: '0', data: [{ teclId: 9001, subjName: '线性代数' }] });
      }
      return undefined;
    });
    const api = await import('@/entrypoints/content/site/api');

    const pending = api.fetchCourseWall(15, 1);
    await vi.advanceTimersByTimeAsync(15_000);
    const items = await pending;

    // 换 token 挂起只拖 15s，业务请求随后照常降级发出并解析成功
    expect(items).toHaveLength(1);
    expect(items[0]?.teclId).toBe(9001);

    // 换 token 恰好尝试一次即被超时切断（不会无限等待、不会反复重试）
    expect(calls.filter((item) => item.url.includes('/oauth2/token'))).toHaveLength(1);
    const courseCall = calls.find((item) => item.url.includes('/v1/group_subject_vod_list/'));
    expect(headerOf(courseCall?.init, 'jwt-token')).toBeUndefined();
  });

  it('业务接口超时：直接失败，不失效 token、不换 token 重放（P3-3）', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage({ JY__STORAGE_KEY_JWT_TOKEN: ACCESS_TOKEN }));
    const calls = stubFetch((url) => (url.includes('/v1/group_subject_vod_list/') ? hangUntilAborted() : undefined));
    const api = await import('@/entrypoints/content/site/api');

    const pending = api.fetchCourseWall(15, 1);
    const assertion = expect(pending).rejects.toMatchObject({
      detail: expect.stringContaining('站点接口超时（15s 无响应）'),
    });
    // 只推进 15s 即失败——若走「失效 + 换 token + 重放」最坏要 30s+
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    // 只发了一次业务请求：没有 invalidateSiteToken + 换 token 后的重放
    expect(calls.filter((item) => item.url.includes('/v1/group_subject_vod_list/'))).toHaveLength(1);
    // 全程未换取 token：页面令牌可用，也未被超时路径失效
    expect(calls.filter((item) => item.url.includes('/oauth2/token'))).toHaveLength(0);
  });

  it('HTTP 401 仍走既有换 token 重放（超时收口不影响鉴权重放）', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage({ JY__STORAGE_KEY_JWT_TOKEN: ACCESS_TOKEN }));
    let courseHits = 0;
    const calls = stubFetch((url) => {
      if (url.includes('/oauth2/token')) {
        return () => jsonResponse({ code: '0', result: { jwt_token: FRESH_TOKEN } });
      }
      if (url.includes('/v1/group_subject_vod_list/')) {
        return () => {
          courseHits += 1;
          if (courseHits === 1) return jsonResponse({ code: '0' }, 401);
          return jsonResponse({ code: '0', data: [{ teclId: 9001, subjName: '线性代数' }] });
        };
      }
      return undefined;
    });
    const api = await import('@/entrypoints/content/site/api');

    const items = await api.fetchCourseWall(15, 1);
    expect(items).toHaveLength(1);
    expect(courseHits).toBe(2);

    // 首次带页面令牌，401 后换新令牌重放
    const courseCalls = calls.filter((item) => item.url.includes('/v1/group_subject_vod_list/'));
    expect(headerOf(courseCalls[0]?.init, 'jwt-token')).toBe(ACCESS_TOKEN);
    expect(headerOf(courseCalls[1]?.init, 'jwt-token')).toBe(FRESH_TOKEN);
    expect(calls.filter((item) => item.url.includes('/oauth2/token'))).toHaveLength(1);
  });

  it('超时路径含 401 数字（acteId=4013）：不误判为鉴权过期，不换 token 重放', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage({ JY__STORAGE_KEY_JWT_TOKEN: ACCESS_TOKEN }));
    const calls = stubFetch((url) => {
      // 换 token 通道保持可用：若超时被误判成鉴权过期，就会多出 oauth2 调用与重放请求
      if (url.includes('/oauth2/token')) {
        return () => jsonResponse({ code: '0', result: { jwt_token: FRESH_TOKEN } });
      }
      if (url.includes('/v1/myself/curriculum')) return hangUntilAborted();
      return undefined;
    });
    const api = await import('@/entrypoints/content/site/api');

    const settled = api
      .fetchCurriculum(4013, Date.now() - 86_400_000, Date.now(), 'ms', { strict: true })
      .then(
        () => null,
        (err: unknown) => err,
      );
    await vi.advanceTimersByTimeAsync(15_000);
    const err = (await settled) as { code?: string; detail?: string };

    // 超时按原分类失败：SITE_API_FAILED + 超时文案；detail 携带含 “4013” 数字的路径
    expect(err.code).toBe('SITE_API_FAILED');
    expect(err.detail ?? '').toContain('站点接口超时（15s 无响应）');
    expect(err.detail ?? '').toContain('acteId=4013');
    // 只发一次业务请求：没有失效 token、没有换 token、没有重放
    expect(calls.filter((item) => item.url.includes('/v1/myself/curriculum'))).toHaveLength(1);
    expect(calls.filter((item) => item.url.includes('/oauth2/token'))).toHaveLength(0);
  });

  it('外部 signal 携带 TimeoutError reason 中止：按中止透传，不误判为站点超时', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage({ JY__STORAGE_KEY_JWT_TOKEN: ACCESS_TOKEN }));
    const calls = stubFetch((url) => (url.includes('/v1/group_subject_vod_list/') ? hangUntilAborted() : undefined));
    const api = await import('@/entrypoints/content/site/api');

    const controller = new AbortController();
    const reason = new DOMException('调用方自己的超时', 'TimeoutError');
    const settled = api
      .getJson('/v1/group_subject_vod_list/t-1?page.pageIndex=1&page.pageSize=15', {
        signal: controller.signal,
        throwOnError: true,
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    controller.abort(reason);
    const err = (await settled) as { code?: string; detail?: string };

    // 不误判为站点超时：detail 没有“站点接口超时”字样
    expect(err.detail ?? '').not.toContain('站点接口超时');
    // 中止按“调用方取消”透传：保留原始原因，不被包装成网络错误（SiteNetworkError）
    expect(err.detail ?? '').toContain('调用方自己的超时');
    expect(err.detail ?? '').not.toContain('SiteNetworkError');
    // 外部中止不触发失效 token + 换 token 重放：业务请求只发一次
    expect(calls.filter((item) => item.url.includes('/v1/group_subject_vod_list/'))).toHaveLength(1);
    expect(calls.filter((item) => item.url.includes('/oauth2/token'))).toHaveLength(0);
  });
});
