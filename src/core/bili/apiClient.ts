/**
 * B 站 Web API 请求底座（fetch 在 Service Worker 内执行，依赖浏览器 Cookie 鉴权）。
 *
 * 原 entrypoints/background/bili.ts 的请求管线（第 14 轮字幕专项下沉到 core/bili），
 * 供收藏夹导入（background/bili.ts）与官方字幕获取（core/bili/subtitle.ts）共用同一套
 * 超时 / SSRF / 风控语义，避免两处实现漂移。约定：
 *  - 请求统一带 credentials: 'include'，URL 先过 assertUrlAllowed（与 LLM 请求一致防御口径）；
 *  - B 站业务错误为 HTTP 200 + body.code != 0（如 -101 未登录、-412 风控），
 *    统一抛出 BILI_API_FAILED 的 AppError，userMessage 带常见 code 的中文语义提示；
 *  - wbi key 全站统一、每日更替，模块内缓存 1 小时（SW 存活期内复用）；
 *  - 不做任何分页爬取循环——分页由前端逐页调用 op 完成。
 */

import { extractWbiKeys } from './wbi';
import { AppError } from '../shared/errors';
import type { BiliNavInfo } from '../shared/ops';
import { assertUrlAllowed } from '../shared/urlGuard';
// asRecord 全仓收敛（第 16 轮）：单份实现下沉到 shared/utils，不再从本模块导出
import { asRecord } from '../shared/utils';

const NAV_API = 'https://api.bilibili.com/x/web-interface/nav';
const REQUEST_TIMEOUT_MS = 15_000;

/** 常见 B 站业务错误码（body.code）的中文语义提示 */
export const BILI_CODE_HINTS: Record<number, string> = {
  [-101]: 'B 站账号未登录，请先在浏览器登录 bilibili.com',
  [-403]: 'B 站账号无权访问该内容',
  [-404]: '内容不存在（收藏夹可能已删除）',
  [-352]: '请求被 B 站风控拦截，请稍后再试',
  [-412]: '请求被 B 站风控拦截，请稍后再试',
  [-799]: 'B 站请求过于频繁，请稍后再试',
};

/** 可重试的业务错误码（风控/限流类） */
export const BILI_RETRYABLE_CODES = new Set([-352, -412, -799]);

/** wbi key 模块级缓存（SW 生命周期内复用） */
let wbiKeyCache: { imgKey: string; subKey: string; expiresAt: number } | null = null;
const WBI_KEY_TTL_MS = 60 * 60 * 1000;

/** 带超时的 B 站 GET：assertUrlAllowed → fetch(credentials include) → JSON 解析。
 *  fetchImpl 供字幕适配器等调用方注入（单测替换网络层），缺省走全局 fetch。 */
export async function fetchBiliBody(url: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  assertUrlAllowed(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, { credentials: 'include', signal: controller.signal });
  } catch (err) {
    throw new AppError('BILI_API_FAILED', {
      userMessage: '无法连接 B 站接口，请检查网络后重试',
      detail: err instanceof Error ? err.message : String(err),
      retryable: true,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new AppError('BILI_API_FAILED', {
      userMessage: `B 站接口请求失败（HTTP ${res.status}）`,
      detail: `HTTP ${res.status}`,
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new AppError('BILI_API_FAILED', {
      userMessage: 'B 站接口返回了无法解析的数据',
      detail: err instanceof Error ? err.message : String(err),
      retryable: true,
      cause: err,
    });
  }
  const rec = asRecord(body);
  if (!rec) {
    throw new AppError('BILI_API_FAILED', { userMessage: 'B 站接口返回了无法解析的数据', retryable: true });
  }
  return rec;
}

/** 校验业务 code（!= 0 抛 BILI_API_FAILED，语义与可重试口径见 BILI_CODE_HINTS） */
export function requireBiliCode(rec: Record<string, unknown>, api: string): void {
  const code = rec.code;
  if (typeof code === 'number' && code !== 0) {
    const message = typeof rec.message === 'string' ? rec.message : '';
    throw new AppError('BILI_API_FAILED', {
      userMessage: BILI_CODE_HINTS[code] ?? `B 站接口返回错误（code ${code}${message ? `：${message}` : ''}）`,
      detail: `${api} code=${code}${message ? ` message=${message}` : ''}`,
      retryable: BILI_RETRYABLE_CODES.has(code),
    });
  }
}

/** 校验业务 code 并取出 data 对象（data 必须是记录；数组 data 走 requireBiliCode 自行断言） */
export function requireBiliData(rec: Record<string, unknown>, api: string): Record<string, unknown> {
  requireBiliCode(rec, api);
  const data = asRecord(rec.data);
  if (!data) {
    throw new AppError('BILI_API_FAILED', {
      userMessage: 'B 站接口返回数据缺失，请稍后重试',
      detail: `${api} 缺少 data 字段`,
      retryable: true,
    });
  }
  return data;
}

/** nav：登录态 + wbi key。未登录（code=-101）不是错误，按 isLogin:false 返回。 */
export async function fetchBiliNav(): Promise<BiliNavInfo> {
  const rec = await fetchBiliBody(NAV_API);
  const data = asRecord(rec.data);
  if (!data) {
    throw new AppError('BILI_API_FAILED', { userMessage: '无法读取 B 站登录状态，请稍后重试', retryable: true });
  }
  const wbiImg = asRecord(data.wbi_img);
  const imgUrl = wbiImg && typeof wbiImg.img_url === 'string' ? wbiImg.img_url : '';
  const subUrl = wbiImg && typeof wbiImg.sub_url === 'string' ? wbiImg.sub_url : '';
  const keys = extractWbiKeys(imgUrl, subUrl);
  return {
    isLogin: data.isLogin === true,
    mid: typeof data.mid === 'number' && Number.isFinite(data.mid) ? data.mid : null,
    imgKey: keys.imgKey || null,
    subKey: keys.subKey || null,
  };
}

/** 取 wbi 签名 key：优先读缓存，否则拉一次 nav */
export async function getWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
  if (wbiKeyCache && wbiKeyCache.expiresAt > Date.now()) {
    return { imgKey: wbiKeyCache.imgKey, subKey: wbiKeyCache.subKey };
  }
  const nav = await fetchBiliNav();
  if (!nav.imgKey || !nav.subKey) {
    throw new AppError('BILI_API_FAILED', { userMessage: '无法获取 B 站签名参数，请稍后重试', retryable: true });
  }
  wbiKeyCache = { imgKey: nav.imgKey, subKey: nav.subKey, expiresAt: Date.now() + WBI_KEY_TTL_MS };
  return { imgKey: nav.imgKey, subKey: nav.subKey };
}

/** 签名后的参数编码为 query（wbi 参数值均为 string | number） */
export function toQuery(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}
