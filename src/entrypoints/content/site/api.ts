/**
 * 站点读接口（技术文档 §3.2，只读清单）。
 *
 * 所有请求：同源 + `credentials: 'include'`（复用页面会话）。
 * 严禁调用写接口（addVodWatchRecord / recordPlayInfo / addPlayTimes / keepAlive /
 * vod/collection 写 / course/note 写 / statistics / aftertime / *download*），见 §3.2 禁止清单。
 * 本模块在低层请求入口用路径白名单 + 禁令正则做一次兜底，避免后续误接写接口。
 *
 * 解析一律**宽松容错**：字段缺失返回空值而非抛错（站点改版时静默降级）。
 */

import { API_PREFIX } from '@/core/shared/constants';
import { AppError, toAppError } from '@/core/shared/errors';
import { createLogger } from '@/core/shared/logger';
import { buildCourLabel } from '@/core/shared/utils';
import type {
  CourseListItem,
  CurriculumItem,
  SessionListItem,
  SessionMeta,
  SiteCollectionItem,
  SiteNote,
  SiteUser,
  VodView,
} from '@/core/shared/types';

const log = createLogger('site-api');

// ───────────────────────── 只读护栏 ─────────────────────────

/** 站点接口全部位于 `/jy-application-resourcemanage/v1/` 下 */
const READ_ONLY_PATH_PREFIX = '/v1/';

/**
 * 技术文档 §3.2 的禁止清单。这里只匹配路径片段——调用入口本身只发 GET，
 * 因此不会出现 POST 写请求；仍保留该检查，防止后续维护时把写端点接进来。
 */
const FORBIDDEN_ENDPOINT_PATTERNS: ReadonlyArray<RegExp> = [
  /addVodWatchRecord/i,
  /recordPlayInfo/i,
  /addPlayTimes/i,
  /keepAlive/i,
  /\/statistics(\/|$)/i,
  /\/aftertime(\/|$)/i,
  /\/download/i,
];

function assertReadOnlyPath(path: string): void {
  if (!path.startsWith(READ_ONLY_PATH_PREFIX)) {
    throw new AppError('INVALID_INPUT', { detail: `拒绝非 v1 站点请求：${path}` });
  }
  if (FORBIDDEN_ENDPOINT_PATTERNS.some((pattern) => pattern.test(path))) {
    throw new AppError('INVALID_INPUT', { detail: `站点写接口禁止调用：${path}` });
  }
}

// ───────────────────────── 站点鉴权（jwt-token） ─────────────────────────

/**
 * 站点新 Portal 的业务接口除了 cookie 还要求 `jwt-token` 请求头（2026-10 实测）：
 * 缺失或无效时服务端会 302 到 SSO，跨域重定向被 CORS 拦下，浏览器侧表现为
 * `TypeError: Failed to fetch`（少数接口返回 `{code:"401 UNAUTHORIZED"}`）。
 *
 * 访问令牌由站点写入 **sessionStorage**（`JY__STORAGE_KEY_JWT_TOKEN`）；
 * localStorage 里的 `JY__STORAGE_KEY_REFRESH_TOKEN` 是刷新令牌，不能当访问令牌用
 * （带上它同样会被重定向）。页面还没写入令牌时，再用登录态从 `/oauth2/token`
 * 换取（只需 `tenantid: RBAC`）。
 */
const SITE_TENANT = 'RBAC';
const TOKEN_STORAGE_KEY = 'hdu.siteJwt.v2';
const TOKEN_TTL_MS = 30 * 60_000;
/** 站点自己写入的访问令牌键名（按优先级） */
const PAGE_ACCESS_TOKEN_KEYS = [
  'JY__STORAGE_KEY_JWT_TOKEN',
  'jwt-token',
  'jwt_token',
  'jwtToken',
  'access_token',
  'accessToken',
] as const;
/** 刷新令牌不是访问令牌，扫描键名时要排除 */
const REFRESH_TOKEN_KEY = /refresh/i;

interface CachedSiteToken {
  value: string;
  expiresAt: number;
}

type SiteTokenSource = 'cache' | 'page' | 'oauth2';

interface SiteToken {
  value: string;
  source: SiteTokenSource;
}

/** 请求在拿到响应前失败（302 到 SSO / 断网）；可换 token 重放一次 */
class SiteNetworkError extends Error {
  readonly original: unknown;

  constructor(message: string, original: unknown) {
    super(message);
    this.name = 'SiteNetworkError';
    this.original = original;
  }
}

let cachedToken: CachedSiteToken | null = null;
let pendingToken: Promise<SiteToken | null> | null = null;

function jwtExpiresAt(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const json = JSON.parse(atob(padded)) as { exp?: unknown };
    const exp = typeof json.exp === 'number' ? json.exp : Number(json.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 - 60_000 : undefined;
  } catch {
    return undefined;
  }
}

function jwtLike(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  // JWT 使用 base64url；这里也容忍标准 base64 的 +/= 与少许噪声
  if (/^eyJ[\w\-+/=]{10,}\.[\w\-+/=]{10,}\.[\w\-+/=]{10,}$/.test(text)) return text;
  const matched = text.match(/eyJ[\w\-+/=]{10,}\.[\w\-+/=]{10,}\.[\w\-+/=]{10,}/);
  return matched?.[0] ?? null;
}

function tokenExpired(token: string, now = Date.now()): boolean {
  const expiresAt = jwtExpiresAt(token);
  return expiresAt !== undefined && expiresAt <= now;
}

/** 显式访问令牌键下的值：优先 JWT；站点若存不透明令牌也直接采用（JSON 结构除外） */
function readAccessTokenValue(raw: string | null): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const jwt = jwtLike(text);
  if (jwt) return jwt;
  if (text.startsWith('{') || text.startsWith('[') || /\s/.test(text)) return null;
  const cleaned = text.replace(/^"(.*)"$/, '$1');
  if (!cleaned || /^(null|undefined|none|false)$/i.test(cleaned)) return null;
  return cleaned;
}

/** 从给定存储里找站点访问令牌；`scan` 时按键名兜底（刷新令牌除外） */
function readTokenFromStorage(storage: Storage | undefined, scan: boolean): string | null {
  if (!storage) return null;
  try {
    for (const key of PAGE_ACCESS_TOKEN_KEYS) {
      const found = readAccessTokenValue(storage.getItem(key));
      if (found) return found;
    }
    if (!scan) return null;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index) ?? '';
      // 自己的缓存可能早于站点刷新，不能压过站点当前写入的令牌
      if (key === TOKEN_STORAGE_KEY || REFRESH_TOKEN_KEY.test(key)) continue;
      if (!/jwt|token|auth/i.test(key)) continue;
      const found = jwtLike(storage.getItem(key) ?? '');
      if (found) return found;
    }
  } catch {
    /* 隐私模式 / 存储被禁用 */
  }
  return null;
}

/** 页面自己写入的 token（优先使用，避免额外请求） */
function readTokenFromPageStorage(): string | null {
  let session: Storage | undefined;
  let local: Storage | undefined;
  try {
    session = globalThis.sessionStorage as Storage | undefined;
    local = globalThis.localStorage as Storage | undefined;
  } catch {
    return null;
  }
  // 访问令牌在 sessionStorage；localStorage 里通常只有 refresh token（需要排除）
  return readTokenFromStorage(session, true) ?? readTokenFromStorage(local, true);
}

function readSessionToken(): CachedSiteToken | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedSiteToken>;
    if (typeof parsed.value !== 'string' || !parsed.value) return null;
    const expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0;
    if (expiresAt > Date.now()) return { value: parsed.value, expiresAt };
  } catch {
    /* 忽略损坏缓存 */
  }
  return null;
}

function writeSessionToken(token: CachedSiteToken): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
    }
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 用登录态换取 token；{code:"0", result:{jwt_token}} */
async function requestSiteToken(): Promise<string | null> {
  try {
    const res = await fetch(siteUrl('/oauth2/token'), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json', tenantid: SITE_TENANT },
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    const json = JSON.parse(text) as Record<string, unknown>;
    const data = ((json.result ?? json.data ?? json) ?? {}) as Record<string, unknown>;
    const token = str(data.jwt_token ?? data.jwtToken ?? data.access_token ?? json.jwt_token).trim();
    return token.length > 20 ? token : null;
  } catch {
    return null;
  }
}

function cacheToken(token: SiteToken): SiteToken {
  const cached = { value: token.value, expiresAt: jwtExpiresAt(token.value) ?? Date.now() + TOKEN_TTL_MS };
  cachedToken = cached;
  writeSessionToken(cached);
  return token;
}

/**
 * 依次尝试：页面访问令牌 → `/oauth2/token` 换取 → 页面令牌兜底。
 * `stale` 是刚被站点拒绝的令牌：即使它仍在页面存储里，也视为不可用。
 */
async function acquireSiteToken(stale?: string | null): Promise<SiteToken | null> {
  const pageToken = readTokenFromPageStorage();
  if (pageToken && pageToken !== stale && !tokenExpired(pageToken)) {
    return { value: pageToken, source: 'page' };
  }
  const exchanged = await requestSiteToken();
  if (exchanged && exchanged !== stale) {
    return { value: exchanged, source: 'oauth2' };
  }
  // 兜底：过期的页面令牌仍可能被服务端接受（或触发 401 走刷新链路）
  if (pageToken && pageToken !== stale) {
    return { value: pageToken, source: 'page' };
  }
  return null;
}

/** 取可用 token；拿不到时返回 null（请求仍会带上 cookie，由调用方处理失败） */
async function ensureSiteToken(force = false, stale?: string | null): Promise<SiteToken | null> {
  if (!force) {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      return { value: cachedToken.value, source: 'cache' };
    }
    const stored = readSessionToken();
    if (stored) {
      cachedToken = stored;
      return { value: stored.value, source: 'cache' };
    }
  }
  if (!pendingToken) {
    pendingToken = acquireSiteToken(force ? stale : undefined)
      .then((token) => {
        if (!token) {
          log.debug('未能获取站点 jwt-token（将只带 cookie 请求，可能被站点拒绝）');
          return null;
        }
        if (token.source === 'oauth2') log.debug('已用登录态换取站点 jwt-token');
        return cacheToken(token);
      })
      .finally(() => {
        pendingToken = null;
      });
  }
  return pendingToken;
}

function invalidateSiteToken(): void {
  cachedToken = null;
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

function isAuthExpired(err: unknown): boolean {
  const appErr = toAppError(err);
  return appErr.code === 'AUTH_EXPIRED' || /401|403|unauthori[sz]ed/i.test(appErr.detail ?? '');
}

// ───────────────────────── 低层请求 ─────────────────────────

interface RequestOptions {
  /** 静默失败（用于可选接口） */
  silent?: boolean;
  /** 失败时抛出（课表同步需要区分“接口失败”和“本周无课”） */
  throwOnError?: boolean;
  signal?: AbortSignal;
}

/**
 * 站点接口地址固定绑定当前页面 origin。
 * 不用相对 URL：页面里的 `<base>` 会改变相对 URL 的解析目标，可能把带 jwt-token
 * 的请求发到别的源；站点只读接口永远只应打到当前站点。
 */
function siteUrl(path: string): string {
  const relative = `${API_PREFIX}${path}`;
  if (typeof location === 'undefined' || !location.origin || location.origin === 'null') {
    return relative;
  }
  return `${location.origin}${relative}`;
}

async function requestJsonOnce<T>(
  path: string,
  token: string | null,
  opts: RequestOptions,
): Promise<T | null> {
  const url = siteUrl(path);
  const headers: Record<string, string> = { accept: 'application/json', tenantid: SITE_TENANT };
  if (token) headers['jwt-token'] = token;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    const message = err instanceof Error ? err.message : String(err);
    const hint = token
      ? '请求未拿到响应（可能被 302 到 SSO / 登录过期，或网络不可达）'
      : '未取得 jwt-token，请求可能被 302 到 SSO';
    throw new SiteNetworkError(`${hint} @ ${path}: ${message}`, err);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AppError('AUTH_EXPIRED', { detail: `HTTP ${res.status} @ ${path}` });
  }
  if (!res.ok) {
    throw new AppError('SITE_API_FAILED', { detail: `HTTP ${res.status} @ ${path}` });
  }
  const text = await res.text();
  if (!text) return null;
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new AppError('SITE_API_FAILED', { detail: `响应不是合法 JSON @ ${path}` });
  }
  assertApiSuccess(json, path);
  return json as T;
}

async function getJson<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T | null> {
  assertReadOnlyPath(path);
  let token: SiteToken | null = null;
  let lastToken: SiteToken | null = null;
  try {
    token = await ensureSiteToken();
    lastToken = token;
    try {
      return await requestJsonOnce<T>(path, token?.value ?? null, opts);
    } catch (err) {
      // token 过期 / 站点刚刷新登录态 / 302 到 SSO 被 CORS 拦成 Failed to fetch：
      // 换一次 token 后重放一次
      if (opts.signal?.aborted) throw err;
      if (!isAuthExpired(err) && !(err instanceof SiteNetworkError)) throw err;
      invalidateSiteToken();
      const refreshed = await ensureSiteToken(true, token?.value ?? null);
      if (!refreshed || refreshed.value === token?.value) throw err;
      lastToken = refreshed;
      return await requestJsonOnce<T>(path, refreshed.value, opts);
    }
  } catch (err) {
    const appErr = toAppError(err, 'SITE_API_FAILED');
    if (!opts.silent) {
      log.warn(`接口失败：${path}`, {
        detail: appErr.detail ?? appErr.code,
        token: lastToken?.source ?? 'none',
        origin: typeof location === 'undefined' ? undefined : location.origin,
      });
    }
    if (opts.throwOnError) throw appErr;
    if (opts.silent) return null;
    throw appErr;
  }
}

/** 站点常见的业务错误码（HTTP 200 但 code != 0）；不识别就会把“未登录”当成空列表。 */
function assertApiSuccess(payload: unknown, path: string): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const obj = payload as Record<string, unknown>;
  if (obj.success === false) {
    throw new AppError('SITE_API_FAILED', {
      detail: str(obj.message ?? obj.msg) || `站点返回 success=false @ ${path}`,
    });
  }
  if (obj.code === undefined || obj.code === null || obj.code === '') return;
  const code = String(obj.code).trim().toLowerCase();
  if (['0', '200', '000000', 'success', 'true'].includes(code)) return;
  const message = str(obj.message ?? obj.msg) || `code=${String(obj.code)}`;
  const statusText = String(obj.status ?? '') + ' ' + String(obj.code);
  if (/(?:^|\D)(401|403)(?:\D|$)/.test(statusText) || /unauthori[sz]ed/i.test(message)) {
    throw new AppError('AUTH_EXPIRED', { detail: `站点返回 ${message} @ ${path}` });
  }
  throw new AppError('SITE_API_FAILED', { detail: `站点返回 ${message} @ ${path}` });
}

/** 站点接口常见的包装：{ code, data } / { result } / 裸对象 */
function unwrap(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    if (obj.data !== undefined && obj.data !== null) return obj.data;
    if (obj.result !== undefined && obj.result !== null) return obj.result;
  }
  return payload;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of [
      'records',
      'list',
      'rows',
      'items',
      'content',
      'curriculumList',
      'courseList',
      'courses',
      'termYears',
      'termYearList',
      'weekList',
    ] as const) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 毫秒时间戳容错：数值 / 数字字符串 / ISO 日期字符串 */
function timestamp(value: unknown): number | undefined {
  const parsed = num(value);
  if (parsed !== undefined) return parsed;
  if (typeof value === 'string' && value.trim() !== '') {
    const fromDate = Date.parse(value);
    if (Number.isFinite(fromDate)) return fromDate;
  }
  return undefined;
}

function boolLike(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  }
  return undefined;
}

/** 教师姓名的常见字段名（不同接口的命名并不统一） */
const NAME_KEYS = [
  'teacherName',
  'teacName',
  'teachName',
  'name',
  'userName',
  'realName',
  'userRealName',
  'nickName',
  'xm',
  'jsxm',
] as const;

function isLikelyName(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 40) return false;
  if (/^\d+$/.test(text)) return false;
  return !/https?:|^[{[<]/.test(text);
}

function pickName(item: unknown): string {
  if (typeof item === 'string') return isLikelyName(item) ? item.trim() : '';
  if (!item || typeof item !== 'object') return '';
  const obj = item as Record<string, unknown>;
  for (const key of NAME_KEYS) {
    const value = str(obj[key]).trim();
    if (isLikelyName(value)) return value;
  }
  return '';
}

function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of names) {
    const text = candidate.trim();
    if (!text || !isLikelyName(text) || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= 10) break;
  }
  return out;
}

function teacherNames(raw: unknown): string[] {
  if (Array.isArray(raw)) return dedupeNames(raw.map(pickName).filter(Boolean));
  if (raw && typeof raw === 'object') {
    const one = pickName(raw);
    if (one) return [one];
    // 有些接口把教师包在 {teacherList:[...]} / {userList:[...]} 里
    for (const value of Object.values(raw as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        const parsed = teacherNames(value);
        if (parsed.length > 0) return parsed;
      }
    }
    return [];
  }
  if (typeof raw === 'string') {
    return dedupeNames(raw.split(/[,，、;；/|]+|\s+/).map((item) => item.trim()).filter(Boolean));
  }
  return [];
}

function isTeacherField(key: string): boolean {
  const lower = key.toLowerCase();
  if (!/(teacher|teach|teac)/.test(lower)) return false;
  // 排除备注、数量、时间、状态等“看起来像教师字段”的非姓名字段
  return !/(note|count|num|caption|time|status|id|url|img|desc|avatar|flag)/.test(lower);
}

/** 站点字段名不稳定时，按“键名像教师”做一次浅层深搜（深度 ≤2） */
function deepTeacherNames(value: unknown, depth = 2, out: string[] = []): string[] {
  if (depth < 0 || !value || out.length >= 10) return out;
  if (Array.isArray(value)) {
    for (const item of value) deepTeacherNames(item, depth - 1, out);
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isTeacherField(key)) {
      out.push(...teacherNames(item));
      continue;
    }
    if (item && typeof item === 'object') deepTeacherNames(item, depth - 1, out);
  }
  return out;
}

/** 从一行响应中提取教师：先看常见字段，再做浅层深搜兜底 */
function resolveTeacherNames(row: Record<string, unknown>): string[] {
  const direct = teacherNames(
    row.teacherNames ??
      row.teacherName ??
      row.teachers ??
      row.teclTeachers ??
      row.teacherList ??
      row.teacNames ??
      row.teacName ??
      row.teacherInfos ??
      row.teclTeacherList,
  );
  return direct.length > 0 ? direct : dedupeNames(deepTeacherNames(row));
}

// ───────────────────────── 接口 #1：课次媒体与元数据（核心） ─────────────────────────

export interface CourseVodInfo {
  meta: SessionMeta;
  /** 站点原生断点（秒） */
  lastPlayTime?: number;
}

export async function fetchCourseVodUrls(courId: number, fallback?: Partial<SessionMeta>): Promise<CourseVodInfo | null> {
  const payload = await getJson<unknown>(`/v1/course_vod_urls_new?courseId=${courId}`, { silent: true });
  if (!payload) return null;
  const data = unwrap(payload) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;

  const rawViews = Array.isArray(data)
    ? data
    : asArray(data.courseVodViewList ?? data.vodViewList ?? data.courseVodViews ?? data.views);
  const views: VodView[] = rawViews.map((item, index) => {
    if (typeof item === 'string') {
      return { vodId: index, url: item, vodTime: 0, viewNum: index + 1 };
    }
    const view = (item ?? {}) as Record<string, unknown>;
    return {
      vodId: num(view.vodId ?? view.id) ?? index,
      url: str(view.url ?? view.vodUrl ?? view.playUrl ?? view.videoUrl),
      vodTime: num(view.vodTime ?? view.duration ?? view.vodDuration) ?? 0,
      viewNum: num(view.viewNum ?? view.viewNo) ?? index + 1,
    };
  });
  const validViews = views.filter((view) => view.url.length > 0);

  const beginTime = timestamp(data.courBeginTime ?? data.beginTime ?? data.startTime);
  const endTime = timestamp(data.courEndTime ?? data.endTime ?? data.finishTime);
  const viewDuration = validViews.find((view) => view.vodTime > 0)?.vodTime;
  const durationSec =
    viewDuration ?? num(data.vodTime ?? data.duration ?? data.courDuration) ?? fallback?.durationSec ?? 0;

  const letiNumber = num(data.letiNumber ?? data.letiNo ?? data.sectionNo);
  const clroName = str(data.classRoomName ?? data.clroName ?? data.classroomName);
  const weekNumber = num(data.weekNumber ?? data.weekNo ?? data.teachingWeek);
  const courLabel =
    (fallback?.courLabel && fallback.courLabel.length > 0
      ? fallback.courLabel
      : buildCourLabel({ weekNumber, beginTime, letiNumber, clroName })) || '';

  const parsedTeachers = resolveTeacherNames(data);
  const lastPlayTime = num(data.lastPlayTime ?? data.lastPlayPosition);

  const meta: SessionMeta = {
    courId,
    teclId: num(data.teclId ?? data.teachingClassId) ?? fallback?.teclId ?? 0,
    courseName: str(data.courName ?? data.courseName ?? data.subjName, fallback?.courseName ?? ''),
    subjCode: str(data.subjCode ?? data.courCode ?? data.courseCode) || undefined,
    teacherNames: parsedTeachers.length > 0 ? parsedTeachers : (fallback?.teacherNames ?? []),
    clroName: clroName || undefined,
    letiNumber,
    letyName: str(data.letiName ?? data.letyName) || undefined,
    beginTime: beginTime ?? fallback?.beginTime,
    endTime: endTime ?? fallback?.endTime,
    durationSec,
    lastPlayTime,
    views: validViews,
    courLabel,
    openType: str(data.openType) || undefined,
    message: str(data.message ?? data.tip ?? data.msg) || undefined,
  };

  return { meta, lastPlayTime };
}

// ───────────────────────── 接口 #2：教学班课次列表 ─────────────────────────

export async function fetchSessionList(teclId: number): Promise<SessionListItem[]> {
  const path =
    `/v1/subject_vod_list_new?page.pageIndex=1&page.pageSize=1000&teclIds=${teclId}` +
    `&page.orders[0].asc=false&page.orders[0].field=courBeginTime`;
  const payload = await getJson<unknown>(path, { silent: true });
  if (!payload) return [];
  return asArray(unwrap(payload)).map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    return {
      courId: num(row.id ?? row.courId ?? row.courseId) ?? 0,
      beginTime: timestamp(row.courBeginTime ?? row.beginTime) ?? 0,
      endTime: timestamp(row.courEndTime ?? row.endTime) ?? 0,
      letiNumber: num(row.letiNumber ?? row.sectionNo),
      letyName: str(row.letyName ?? row.letiName) || undefined,
      clroName: str(row.clroName ?? row.classRoomName) || undefined,
      teacherNames: resolveTeacherNames(row),
      vodStatus: (row.vodStatus as number | string | null) ?? null,
      vodDisplayStatus: (row.vodDisplayStatus as number | string | null) ?? null,
      noteFlag: boolLike(row.noteFlag) ?? false,
    };
  });
}

// ───────────────────────── 接口 #3：课次附加信息 ─────────────────────────

export interface CourseVodExtra {
  openType?: string;
  message?: string;
  liveStatus?: unknown;
  vodStatus?: unknown;
}

export async function fetchCourseVodVideoInfos(courId: number): Promise<CourseVodExtra | null> {
  const payload = await getJson<unknown>(`/v1/course_vod_videoinfos?courseId=${courId}`, { silent: true });
  if (!payload) return null;
  const data = unwrap(payload) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;
  return {
    openType: str(data.openType) || undefined,
    message: str(data.message ?? data.tip ?? data.msg) || undefined,
    liveStatus: data.lvcrLiveStatus ?? data.liveStatus,
    vodStatus: data.lvcrVodStatus ?? data.vodStatus,
  };
}

// ───────────────────────── 接口 #4：教学班信息（不采集成员名单） ─────────────────────────

export interface TeachingClassInfo {
  subjName?: string;
  clroName?: string;
  memberCount?: number;
  orgName?: string;
  teacherNames: string[];
}

export async function fetchTeachingClass(teclId: number): Promise<TeachingClassInfo | null> {
  const payload = await getJson<unknown>(`/v1/teachingClass/${teclId}/t-1`, { silent: true });
  if (!payload) return null;
  const data = unwrap(payload) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;
  return {
    subjName: str(data.subjName ?? data.courseName) || undefined,
    clroName: str(data.clroName ?? data.classRoomName) || undefined,
    memberCount: num(data.memberCount ?? data.studentCount),
    orgName: str(data.orgName) || undefined,
    teacherNames: resolveTeacherNames(data),
  };
}

// ───────────────────────── 接口 #5：点播课程墙 ─────────────────────────

export async function fetchCourseWall(
  pageSize = 15,
  pageIndex = 1,
  opts: { silent?: boolean } = {},
): Promise<CourseListItem[]> {
  const size = Math.max(1, Math.min(100, Math.floor(pageSize)));
  const index = Math.max(1, Math.floor(pageIndex));
  const path =
    `/v1/group_subject_vod_list/t-1?page.pageIndex=${index}&page.pageSize=${size}` +
    `&page.orders[0].asc=false&page.orders[0].field=updateTime`;
  const payload = await getJson<unknown>(path, opts);
  if (!payload) return [];
  return asArray(unwrap(payload)).map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    return {
      teclId: num(row.teclId ?? row.teclid ?? row.teachingClassId) ?? 0,
      subjName: str(row.subjName ?? row.courseName ?? row.subjTitle),
      subjCode: str(row.subjCode ?? row.courCode ?? row.courseCode) || undefined,
      teclCode: str(row.teclCode) || undefined,
      clroName: str(row.clroName ?? row.classRoomName) || undefined,
      teacherNames: resolveTeacherNames(row),
      courTimes: num(row.courTimes ?? row.courseTimes),
      coverUrl: str(row.teclImgUrl ?? row.coverUrl ?? row.subjImgUrl) || undefined,
    };
  });
}

// ───────────────────────── 接口 #6：站点原生笔记（只读展示） ─────────────────────────

export async function fetchSiteNotes(courId: number, roleType: 1 | 2 = 1): Promise<SiteNote[]> {
  const payload = await getJson<unknown>(`/v1/course/note/${courId}?courseId=${courId}&roleType=${roleType}`, {
    silent: true,
  });
  if (!payload) return [];
  return asArray(unwrap(payload)).map((item, index) => {
    const row = (item ?? {}) as Record<string, unknown>;
    return {
      id: (num(row.id ?? row.noteId) ?? str(row.noteId ?? row.id, String(index))) as string | number,
      anchorTime: num(row.playTime ?? row.noteTime ?? row.timePoint ?? row.vodTime),
      text: str(row.content ?? row.noteContent ?? row.text ?? row.note),
      createdAt: (row.createTime ?? row.createdAt) as string | number | undefined,
    };
  });
}

// ───────────────────────── 接口 #7：站点收藏状态（只读） ─────────────────────────

/**
 * 站点是否已收藏该课次。
 * 返回 `null` 表示无法判断（接口失败或返回结构不认识），调用方应降级为“未收藏/未知”。
 */
export async function fetchSiteCollectionStatus(courId: number): Promise<boolean | null> {
  const payload = await getJson<unknown>(`/v1/vod/${courId}/getCollection`, { silent: true });
  if (payload === null) return null;
  const data = unwrap(payload);
  const direct = boolLike(data);
  if (direct !== undefined) return direct;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    return (
      boolLike(obj.collection) ??
      boolLike(obj.collected) ??
      boolLike(obj.isCollection) ??
      boolLike(obj.status) ??
      null
    );
  }
  return null;
}

/** 兼容参考实现的旧命名（UI 侧可能已按该名字导入） */
export const fetchCollectionState = fetchSiteCollectionStatus;

// ───────────────────────── 接口 #8：站点收藏列表（只读） ─────────────────────────

export async function fetchSiteCollections(pageSize = 50): Promise<SiteCollectionItem[]> {
  const path = `/v1/list/vod/collection?page.pageIndex=1&page.pageSize=${pageSize}`;
  const payload = await getJson<unknown>(path, { silent: true });
  if (!payload) return [];
  return asArray(unwrap(payload))
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const courId = num(row.courId ?? row.courseId ?? row.id) ?? 0;
      return {
        courId,
        teclId: num(row.teclId ?? row.teachingClassId),
        title:
          str(row.courTitle ?? row.title ?? row.subjName ?? row.courName ?? row.courseName) ||
          (courId > 0 ? `课次 ${courId}` : ''),
        courseName: str(row.subjName ?? row.courseName ?? row.courName) || undefined,
        createdAt: timestamp(row.createTime ?? row.createdAt ?? row.collectionTime),
      };
    })
    .filter((item) => item.courId > 0);
}

// ───────────────────────── 接口 #9：上次播放信息（课次识别证据链之一） ─────────────────────────

export interface LastPlayHint {
  /** 站点记录的上次播放课次（若响应里带） */
  courId?: number;
  /** 上次播放位置（秒） */
  playTime?: number;
  /** 响应里出现的媒体地址（用于与正在播放的地址核对） */
  videoUrls: string[];
}

/** 递归收集字符串（响应结构可能随站点改版变化，深搜比逐字段解析更耐改） */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 5 || out.length >= 40) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out, depth + 1);
  }
}

/** 深搜课次 ID 字段（courseId / courId） */
function findCourId(value: unknown, depth = 0): number | undefined {
  if (depth > 4 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCourId(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (/^(course_?id|cour_?id)$/i.test(key)) {
      const parsed = num(item);
      if (parsed !== undefined && parsed > 0) return parsed;
    }
  }
  for (const item of Object.values(record)) {
    const found = findCourId(item, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findPlayTime(value: unknown, depth = 0): number | undefined {
  if (depth > 4 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPlayTime(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (/^(last)?play_?time$|^play_?position$/i.test(key)) {
      const parsed = num(item);
      if (parsed !== undefined) return parsed;
    }
  }
  for (const item of Object.values(record)) {
    const found = findPlayTime(item, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 按教学班取“上次播放信息”（站点原生断点数据源）。
 * 该接口与本标签页正在播放的课次通常一致，但**不能直接采信**——用户可能刚切到别的课次，
 * 因此调用方必须用媒体地址核对（见 `observations.matchesPlayingVideo`）。
 */
export async function fetchLastPlayInfo(teclCode: string): Promise<LastPlayHint | null> {
  if (!teclCode) return null;
  const payload = await getJson<unknown>(
    `/v1/source/vod/lastPlayInfoByTeclCode?teclCode=${encodeURIComponent(teclCode)}`,
    { silent: true },
  );
  if (!payload) return null;
  const data = unwrap(payload);
  const strings: string[] = [];
  collectStrings(data, strings);
  return {
    courId: findCourId(data),
    playTime: findPlayTime(data),
    videoUrls: strings.filter(
      (item) => /\.(mp4|m3u8)(\?|$)/i.test(item) || item.includes('CloudIPC-') || item.includes('/vod/'),
    ),
  };
}

// ───────────────────────── 接口 #10：当前用户 ─────────────────────────

export async function fetchCurrentUser(): Promise<SiteUser | null> {
  const payload = await getJson<unknown>('/v1/currentuser', { silent: true });
  if (!payload) return null;
  const data = unwrap(payload) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;
  return {
    // 仅取显示名用于问候；不落库任何个人身份字段（§3.2 接口 #9）
    name: str(data.realName ?? data.userName ?? data.name),
    role: (data.roleType ?? data.role) as string | number | undefined,
  };
}

// ───────────────────────── 接口 #11：我的课表（D4） ─────────────────────────

/** 课表接口的时间参数格式：毫秒时间戳（站点主格式）/ "YYYY-MM-DD HH:mm:ss" / "YYYY-MM-DD" */
export type CurriculumTimeFormat = 'ms' | 'datetime' | 'date';

function formatLocalDateTime(ms: number, withTime = true): string {
  const d = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : date;
}

function looksLikeCurriculumRow(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  const hasId = keys.some((key) => /^(id|courId|courseId|teclId|teachingClassId)$/i.test(key));
  const hasTime = keys.some((key) => /^(cour)?(begin|start|end|finish).*time$/i.test(key));
  return hasId && hasTime;
}

/**
 * 课表响应结构容错：可能是裸数组、{records/list/...}、按星期分组（组内再放数组）、
 * 或 {课次ID: {...}} 这类对象映射。统一收集“像课次行”的对象。
 */
function collectCurriculumRows(value: unknown, depth = 3, out: unknown[] = []): unknown[] {
  if (depth < 0 || !value || out.length >= 500) return out;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const row = item as Record<string, unknown>;
        if (looksLikeCurriculumRow(row)) out.push(row);
        else collectCurriculumRows(row, depth - 1, out);
      }
    }
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectCurriculumRows(item, depth - 1, out);
    }
  }
  return out;
}

function normalizeCurriculumRow(item: unknown): CurriculumItem {
  const row = (item ?? {}) as Record<string, unknown>;
  const nested = (row.course ?? row.curriculum ?? row.lesson ?? {}) as Record<string, unknown>;
  return {
    courId: num(row.id ?? row.courId ?? row.courseId ?? nested.id ?? nested.courId) ?? 0,
    teclId: num(row.teclId ?? row.teachingClassId ?? nested.teclId) ?? 0,
    subjName: str(
      row.subjName ?? row.courName ?? row.courseName ?? row.subjTitle ?? nested.subjName ?? nested.courseName,
    ),
    beginTime:
      timestamp(
        row.courBeginTime ?? row.beginTime ?? row.startTime ?? row.teachBeginTime ?? nested.courBeginTime,
      ) ?? 0,
    endTime:
      timestamp(row.courEndTime ?? row.endTime ?? row.finishTime ?? row.teachEndTime ?? nested.courEndTime) ?? 0,
    clroName:
      str(row.clroName ?? row.classRoomName ?? row.classroomName ?? nested.clroName) || undefined,
    letiNumber: num(row.letiNumber ?? row.sectionNo ?? nested.letiNumber),
    status: str(row.courseStatus ?? row.status ?? nested.status) || undefined,
  };
}

/** 取某周（本地周一 00:00 起）的课表 */
export async function fetchCurriculum(
  acteId: number | string,
  weekStartMs: number,
  weekEndMs: number,
  format: CurriculumTimeFormat = 'datetime',
  opts: { strict?: boolean } = {},
): Promise<CurriculumItem[]> {
  const start =
    format === 'ms'
      ? String(weekStartMs)
      : formatLocalDateTime(weekStartMs, format === 'datetime');
  const end =
    format === 'ms' ? String(weekEndMs) : formatLocalDateTime(weekEndMs, format === 'datetime');
  const path =
    `/v1/myself/curriculum?acteId=${encodeURIComponent(String(acteId))}&courBeginTime=${encodeURIComponent(start)}` +
    `&courEndTime=${encodeURIComponent(end)}&page.pageIndex=1&page.pageSize=1000`;
  const payload = await getJson<unknown>(path, { silent: true, throwOnError: opts.strict });
  if (!payload) return [];
  const rows = collectCurriculumRows(unwrap(payload));
  if (rows.length === 0) {
    // 有响应但一行都识别不出来：多半是字段改版，留下可诊断的线索而不是静默空课表
    const raw = asArray(unwrap(payload));
    if (raw.length > 0 && typeof raw[0] === 'object') {
      log.warn('课表响应无法识别', {
        acteId,
        sampleKeys: Object.keys((raw[0] ?? {}) as Record<string, unknown>).slice(0, 12),
      });
    }
    return [];
  }
  return rows
    .map(normalizeCurriculumRow)
    .filter((item) => item.courId > 0 && item.beginTime > 0);
}

export interface TermYear {
  acteId: number | string;
  name: string;
  /** 站点标记的当前学期（最可靠的“该用哪个 acteId”依据） */
  currentTerm?: boolean;
  beginTime?: number;
  endTime?: number;
}

/**
 * 学期候选排序：currentTerm 最优先；否则优先“当前时间落在区间内”的学期，
 * 再按最近开学时间/最大 acteId 排序。旧实现按名称猜学年，遇到站点返回
 * `currentTerm` 或只返回 id/acyeCode 时会选错学期，导致课表永远为空。
 */
export function orderTermYearsForSchedule(years: TermYear[], now = Date.now()): TermYear[] {
  const ranked = years.map((term) => {
    const begin = term.beginTime ?? 0;
    const end = term.endTime ?? 0;
    let rank = 3;
    if (begin > 0 && end > 0 && now >= begin && now <= end) rank = 0;
    else if (begin > 0 && begin <= now) rank = 1;
    else if (begin > 0) rank = 2;
    return { term, rank };
  });
  ranked.sort((a, b) => {
    if (Boolean(a.term.currentTerm) !== Boolean(b.term.currentTerm)) {
      return a.term.currentTerm ? -1 : 1;
    }
    if (a.rank !== b.rank) return a.rank - b.rank;
    const aBegin = a.term.beginTime ?? 0;
    const bBegin = b.term.beginTime ?? 0;
    if (aBegin !== bBegin) return bBegin - aBegin;
    const aId = Number(a.term.acteId);
    const bId = Number(b.term.acteId);
    if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) return bId - aId;
    return 0;
  });
  return ranked.map((item) => item.term);
}

/** 学期字典（acteId 的来源）。站点返回裸数组，字段为 id/acyeCode/acteTerm/currentTerm。 */
export async function fetchTermYears(opts: { strict?: boolean } = {}): Promise<TermYear[]> {
  const payload = await getJson<unknown>('/v1/list/termYear', {
    silent: true,
    throwOnError: opts.strict,
  });
  if (!payload) return [];
  return asArray(unwrap(payload))
    .map((item): TermYear => {
      // 少数版本直接返回字符串/数字数组（元素就是 acteId）
      if (typeof item === 'number' || typeof item === 'string') {
        return { acteId: num(item) ?? str(item), name: '' };
      }
      const row = (item ?? {}) as Record<string, unknown>;
      const acteId = num(
        row.acteId ?? row.id ?? row.termId ?? row.teachYearId ?? row.yearId ?? row.acteid,
      );
      const acye = str(
        row.acyeCode ?? row.academicYear ?? row.schoolYear ?? row.yearName ?? row.year,
      );
      const termNo = num(row.acteTerm ?? row.termNo ?? row.term);
      const name =
        str(row.name ?? row.termName ?? row.termYear ?? row.title ?? row.label) ||
        (acye ? `${acye}${termNo ? `-${termNo}` : ''}` : '');
      return {
        acteId: (acteId ??
          str(row.acteId ?? row.termId ?? row.yearId ?? row.acteid)) as number | string,
        name,
        currentTerm: boolLike(
          row.currentTerm ??
            row.currentTermFlag ??
            row.isCurrent ??
            row.current ??
            row.acteCurrent ??
            row.curTerm,
        ),
        beginTime: timestamp(row.acteBeginDate ?? row.beginTime ?? row.startTime),
        endTime: timestamp(row.acteEndDate ?? row.endTime ?? row.finishTime),
      };
    })
    // 旧实现会把缺失 acteId 的行解析成 ''，再被当成“当前学期”传给接口，导致课表永远为空
    .filter((item) => String(item.acteId).trim() !== '');
}

/** 兼容参考实现的旧命名（单数形式） */
export const fetchTermYear = fetchTermYears;

export interface TermWeek {
  weekNumber?: number;
  name: string;
  beginTime?: number;
  endTime?: number;
}

/** 周次字典（与 termYear 同属 §3.2 接口 #11） */
export async function fetchTermWeeks(acteId: number | string): Promise<TermWeek[]> {
  const payload = await getJson<unknown>(`/v1/term/weeks?acteId=${encodeURIComponent(String(acteId))}`, {
    silent: true,
  });
  if (!payload) return [];
  return asArray(unwrap(payload)).map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    return {
      weekNumber: num(row.weekNumber ?? row.weekNo ?? row.week ?? row.id),
      name: str(row.name ?? row.weekName ?? row.termWeek),
      beginTime: timestamp(row.beginTime ?? row.startTime),
      endTime: timestamp(row.endTime ?? row.finishTime),
    };
  });
}

// ───────────────────────── 聚合：播放页所需的一次性元数据 ─────────────────────────

export interface PlayPageData {
  meta: SessionMeta;
  extra: CourseVodExtra | null;
  siteCollected: boolean | null;
}

/**
 * 播放页元数据聚合（§2.2 SESSION_META 的来源）。
 * 接口 #1 是核心；#3/#7 为可选增强（失败不影响主流程）。
 */
export async function fetchPlayPageData(courId: number, teclId?: number): Promise<PlayPageData | null> {
  const primary = await fetchCourseVodUrls(courId, teclId ? { teclId } : undefined);
  if (!primary) {
    // 主接口失败时以 DOM 兜底（时长/标题从页面读取由调用方补充）
    return null;
  }
  // 核心接口没给教师时，用教学班详情补一次（只多一个只读请求，且仅在缺失时发生）
  if (primary.meta.teacherNames.length === 0 && primary.meta.teclId > 0) {
    const info = await fetchTeachingClass(primary.meta.teclId).catch(() => null);
    if (info?.teacherNames.length) primary.meta.teacherNames = info.teacherNames;
  }
  const [extra, siteCollected] = await Promise.all([
    fetchCourseVodVideoInfos(courId),
    fetchSiteCollectionStatus(courId),
  ]);
  if (extra?.openType && !primary.meta.openType) primary.meta.openType = extra.openType;
  if (extra?.message && !primary.meta.message) primary.meta.message = extra.message;
  return { meta: primary.meta, extra, siteCollected };
}
