/**
 * 站点课表接口的回归测试（纯函数 + 请求头）。
 *
 * 真实站点 2026-10 起要求业务接口携带 `jwt-token`：缺失时课程墙直接
 * `TypeError: Failed to fetch`，课表接口返回 401/302 后被静默吞成空数组。
 * 访问令牌由站点写在 sessionStorage（JY__STORAGE_KEY_JWT_TOKEN），
 * localStorage 里只有刷新令牌（不能当访问令牌用）。
 * 这里验证：token 来源/换取/复用、401 与网络层失败的重放、学期 currentTerm 优先、
 * 课表日期格式与响应解析。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FetchCall = { url: string; init?: RequestInit };

const TOKEN = 'site-jwt-token-for-tests-123456';

/** 生成站点同形态的 JWT（exp 为秒级时间戳） */
function jwtWithExp(expSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ exp: expSeconds })}.signature-padding-1234567890`;
}

const ACCESS_TOKEN = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
const FRESH_TOKEN = jwtWithExp(Math.floor(Date.now() / 1000) + 7200);
const REFRESH_TOKEN = jwtWithExp(Math.floor(Date.now() / 1000) + 86_400);

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
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? record[key] : undefined;
}

describe('site api：课表与鉴权', () => {
  let calls: FetchCall[];

  beforeEach(() => {
    vi.resetModules();
    calls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function setupFetch(handlers: {
    termYears?: () => Response;
    curriculum?: (call: FetchCall) => Response;
    courses?: (call: FetchCall) => Response;
    token?: () => Response;
  } = {}) {
    let tokenRequests = 0;
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/oauth2/token')) {
        tokenRequests += 1;
        return handlers.token ? handlers.token() : jsonResponse({ code: '0', result: { jwt_token: TOKEN } });
      }
      if (url.includes('/v1/group_subject_vod_list/')) {
        return handlers.courses
          ? handlers.courses({ url, init })
          : jsonResponse({ code: '0', data: [] });
      }
      if (url.includes('/v1/list/termYear')) {
        return handlers.termYears ? handlers.termYears() : jsonResponse([]);
      }
      if (url.includes('/v1/myself/curriculum')) {
        if (!handlers.curriculum) return jsonResponse({ code: '0', data: { records: [] } });
        return handlers.curriculum({ url, init });
      }
      return jsonResponse({ code: '0', data: null });
    });
    vi.stubGlobal('fetch', fn);
    const api = await import('@/entrypoints/content/site/api');
    return { api, fn, tokenRequests: () => tokenRequests };
  }

  it('termYear 裸数组：读取 currentTerm / acyeCode，并把当前学期排在最前', async () => {
    const { api } = await setupFetch({
      termYears: () =>
        jsonResponse([
          { id: 8, acyeCode: '2025-2026', acteTerm: 2, currentTerm: false },
          { id: 9, acyeCode: '2026-2027', acteTerm: 1, currentTerm: true },
          { id: 7, acyeCode: '2025-2026', acteTerm: 1, currentTerm: false },
        ]),
    });

    const years = await api.fetchTermYears({ strict: true });
    expect(years).toHaveLength(3);
    expect(years.find((item) => item.acteId === 9)).toMatchObject({
      currentTerm: true,
      name: '2026-2027-1',
    });

    const ordered = api.orderTermYearsForSchedule(years, new Date('2026-10-17T12:00:00+08:00').getTime());
    expect(ordered[0]?.acteId).toBe(9);
    // 请求 termYear 时也应带 jwt-token
    const termCall = calls.find((item) => item.url.includes('/v1/list/termYear'));
    expect(headerOf(termCall?.init, 'jwt-token')).toBe(TOKEN);
  });

  it('课表请求使用 YYYY-MM-DD HH:mm:ss 并解析 records', async () => {
    const weekStart = new Date(2026, 9, 12, 0, 0, 0, 0).getTime();
    const weekEnd = weekStart + 7 * 86_400_000 - 1;
    const { api } = await setupFetch({
      curriculum: () =>
        jsonResponse({
          code: '0',
          data: {
            pageCount: 1,
            records: [
              {
                id: 1227038,
                teclId: 9001,
                subjName: '高等数学A1',
                courBeginTime: '2026-10-14 10:25:00',
                courEndTime: '2026-10-14 11:10:00',
                clroName: '正心楼512',
                letiNumber: 3,
                courseViewType: '已结束',
              },
            ],
          },
        }),
    });

    const items = await api.fetchCurriculum(9, weekStart, weekEnd, 'datetime', { strict: true });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      courId: 1227038,
      teclId: 9001,
      subjName: '高等数学A1',
      clroName: '正心楼512',
      letiNumber: 3,
      beginTime: new Date(2026, 9, 14, 10, 25, 0, 0).getTime(),
    });

    const call = calls.find((item) => item.url.includes('/v1/myself/curriculum'));
    expect(call).toBeDefined();
    expect(call?.url).toContain('acteId=9');
    expect(call?.url).toContain('courBeginTime=2026-10-12%2000%3A00%3A00');
    expect(call?.url).toContain('courEndTime=2026-10-18%2023%3A59%3A59');
    expect(headerOf(call?.init, 'jwt-token')).toBe(TOKEN);
    expect(headerOf(call?.init, 'tenantid')).toBe('RBAC');
  });

  it('业务码 401 UNAUTHORIZED 会刷新 token 并重放一次', async () => {
    let curriculumHits = 0;
    let tokenSeq = 0;
    const { api, tokenRequests } = await setupFetch({
      token: () => {
        tokenSeq += 1;
        return jsonResponse({ code: '0', result: { jwt_token: `${TOKEN}-${tokenSeq}` } });
      },
      curriculum: () => {
        curriculumHits += 1;
        if (curriculumHits === 1) return jsonResponse({ code: '401 UNAUTHORIZED', message: 'UNAUTHORIZED' });
        return jsonResponse({
          code: '0',
          data: {
            records: [
              {
                id: 1,
                teclId: 2,
                subjName: '线性代数',
                courBeginTime: '2026-10-13 08:00:00',
                courEndTime: '2026-10-13 08:45:00',
              },
            ],
          },
        });
      },
    });

    const items = await api.fetchCurriculum(9, Date.now() - 86_400_000, Date.now(), 'datetime', {
      strict: true,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.subjName).toBe('线性代数');
    expect(curriculumHits).toBe(2);
    // 首次取 token + 401 后刷新一次
    expect(tokenRequests()).toBe(2);
  });

  it('优先使用站点写在 sessionStorage 的访问令牌，不发刷新令牌、也不额外换取', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage({ JY__STORAGE_KEY_JWT_TOKEN: ACCESS_TOKEN }));
    vi.stubGlobal('localStorage', memoryStorage({ JY__STORAGE_KEY_REFRESH_TOKEN: REFRESH_TOKEN }));
    const { api, tokenRequests } = await setupFetch({
      courses: () =>
        jsonResponse({ code: '0', data: [{ teclId: 9001, subjName: '线性代数', subjCode: 'MATH1001' }] }),
    });

    const items = await api.fetchCourseWall(15, 1);
    expect(items).toHaveLength(1);
    expect(items[0]?.teclId).toBe(9001);

    const call = calls.find((item) => item.url.includes('/v1/group_subject_vod_list/'));
    expect(headerOf(call?.init, 'jwt-token')).toBe(ACCESS_TOKEN);
    expect(headerOf(call?.init, 'jwt-token')).not.toBe(REFRESH_TOKEN);
    expect(tokenRequests()).toBe(0);
  });

  it('站点把访问令牌存成不透明字符串时也直接使用', async () => {
    const opaque = 'opaque-access-token-1234567890';
    vi.stubGlobal('sessionStorage', memoryStorage({ JY__STORAGE_KEY_JWT_TOKEN: opaque }));
    vi.stubGlobal('localStorage', memoryStorage());
    const { api, tokenRequests } = await setupFetch();

    await api.fetchCourseWall(15, 1);

    const call = calls.find((item) => item.url.includes('/v1/group_subject_vod_list/'));
    expect(headerOf(call?.init, 'jwt-token')).toBe(opaque);
    expect(tokenRequests()).toBe(0);
  });

  it('只有刷新令牌时不把它当 jwt-token 发出去', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage({ JY__STORAGE_KEY_REFRESH_TOKEN: REFRESH_TOKEN }));
    const { api, tokenRequests } = await setupFetch({
      token: () => jsonResponse({ code: '0', data: null }),
    });

    await api.fetchCourseWall(15, 1);

    const call = calls.find((item) => item.url.includes('/v1/group_subject_vod_list/'));
    expect(call).toBeDefined();
    expect(headerOf(call?.init, 'jwt-token')).toBeUndefined();
    // 访问令牌缺失时仍会尝试用登录态换取一次
    expect(tokenRequests()).toBe(1);
  });

  it('请求在响应前失败（302 到 SSO / Failed to fetch）时换 token 重放一次', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage({ JY__STORAGE_KEY_JWT_TOKEN: ACCESS_TOKEN }));
    vi.stubGlobal('localStorage', memoryStorage());
    let courseHits = 0;
    const { api, tokenRequests } = await setupFetch({
      token: () => jsonResponse({ code: '0', result: { jwt_token: FRESH_TOKEN } }),
      courses: () => {
        courseHits += 1;
        if (courseHits === 1) throw new TypeError('Failed to fetch');
        return jsonResponse({ code: '0', data: [{ teclId: 9001, subjName: '线性代数' }] });
      },
    });

    const items = await api.fetchCourseWall(15, 1);
    expect(items).toHaveLength(1);
    expect(courseHits).toBe(2);

    const courseCalls = calls.filter((item) => item.url.includes('/v1/group_subject_vod_list/'));
    expect(headerOf(courseCalls[0]?.init, 'jwt-token')).toBe(ACCESS_TOKEN);
    expect(headerOf(courseCalls[1]?.init, 'jwt-token')).toBe(FRESH_TOKEN);
    expect(tokenRequests()).toBe(1);
  });
});
