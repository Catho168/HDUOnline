/**
 * 路由识别（技术文档 §3.1）。
 *
 * 站点为 hash 路由 SPA；本模块只解析 `location.hash`，不做任何 DOM 依赖，
 * 因此刷新/改版都不会影响会话识别（§11 风险 1 的缓解措施）。
 *
 * 站点共有三种播放页形态：
 *   - `#/play-center?teclId=&teclCode=&subjId=&target=video`（2026-10-16 新形态，
 *     URL **不含课次 ID**，课次在页面内通过右栏列表切换，见 `sessionResolve.ts`）；
 *   - `#/video-detail?teclId=&courseId=`（旧主播放页，`courseId` 就是课次 ID）；
 *   - `#/play-video?signture=&type=&teclId=&courseId=&courId=`（旧独立播放页，
 *     同时带两个参数时 `courId` 才是课次 ID；分享参数透传不改写）。
 */

import type { RouteInfo, RouteKind } from '@/core/shared/types';

const PLAY_ROUTES = new Set<RouteKind>(['play-center', 'video-detail', 'play-video']);

/** 列表/个人中心等“非播放页”的路径映射（学习中心导航据此高亮） */
const KIND_BY_PATH: Readonly<Record<string, RouteKind>> = {
  'play-center': 'play-center',
  'video-detail': 'video-detail',
  'play-video': 'play-video',
  'list-video': 'list-video',
  'list-live': 'list-live',
  home: 'home',
  'personal-center/my-schedule': 'my-schedule',
  'personal-center/my-record': 'my-record',
  'personal-center/my-collection': 'my-collection',
  'personal-center/my-note': 'my-note',
};

/** 当前站点的访问形态 */
export function detectSite(hostname = location.hostname): RouteInfo['site'] {
  const host = (hostname || '').toLowerCase();
  return host.endsWith('webvpn.hdu.edu.cn') || host.includes('.webvpn.hdu.edu.cn') ? 'webvpn' : 'campus';
}

/**
 * URL 参数读取：优先精确键名，其次大小写不敏感匹配。
 * （站点改版时偶有 `teclid` / `courseid` 之类的键名变化，不值得因此整页失效。）
 */
function readParam(params: URLSearchParams, name: string): string | null {
  const direct = params.get(name);
  if (direct !== null) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of params.entries()) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

function parseNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // 站点 ID 为整数；兼容 `1,573` 千分位与 URL 里混入的装饰字符
  const direct = Number(trimmed);
  if (Number.isFinite(direct)) return direct > 0 ? Math.floor(direct) : undefined;
  const cleaned = trimmed.replace(/[^\d]/g, '');
  if (!cleaned) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 解析 hash → 路由信息 */
export function parseRoute(hash = location.hash, hostname = location.hostname): RouteInfo {
  const site = detectSite(hostname);
  const raw = hash || '';
  const withoutHash = raw.startsWith('#') ? raw.slice(1) : raw;
  const queryIndex = withoutHash.indexOf('?');
  const pathPart = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const queryPart = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '';
  const path = pathPart
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  const params = new URLSearchParams(queryPart);

  const kind: RouteKind = KIND_BY_PATH[path] ?? (path === '' ? 'home' : 'other');

  const teclId = parseNumber(readParam(params, 'teclId'));
  const courseIdParam = parseNumber(readParam(params, 'courseId'));
  const courIdParam = parseNumber(readParam(params, 'courId'));
  // 课次主键（§1.2 裁决）：
  //  - video-detail 的 URL 中 `courseId` 就是课次 ID；
  //  - play-video 同时带 courseId 与 courId，此时 `courId` 才是课次 ID；
  //  - play-center 通常两者都没有（课次由页面内切换），此处仅在站点补写参数时取用。
  const courId =
    kind === 'play-video' || kind === 'play-center'
      ? (courIdParam ?? courseIdParam)
      : (courseIdParam ?? courIdParam);

  return {
    kind,
    site,
    teclId,
    courId,
    teclCode: readParam(params, 'teclCode') ?? undefined,
    subjId: parseNumber(readParam(params, 'subjId')),
    target: readParam(params, 'target') ?? undefined,
    raw,
  };
}

export function isPlayRoute(route: RouteInfo): boolean {
  return PLAY_ROUTES.has(route.kind);
}

/**
 * 播放页是否具备会话键（缺任一则静默降级）。
 *
 * `play-center` 形态下 URL 没有课次，若沿用“teclId + courId 必须同时存在”的旧口径会整页不注入。
 * 现在只要 `teclId` 存在即可进入播放页流程，`courId` 由 `sessionResolve` 事后补齐。
 */
export function hasSessionKey(route: RouteInfo): boolean {
  return typeof route.teclId === 'number' && route.teclId > 0;
}

/** 是否已知课次（用于 UI 区分“识别中”与“已识别”） */
export function hasCourId(route: RouteInfo): boolean {
  return typeof route.courId === 'number' && route.courId > 0;
}

/** 同一课次的比较（用于避免 hash 参数顺序变化导致重复重注入） */
export function sameSession(a: RouteInfo | null, b: RouteInfo): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  // 课次未知时退化为“教学班 + 课程”比较，避免课次补齐前后被判定为不同会话而反复重挂
  if (a.courId === undefined || b.courId === undefined) {
    return a.teclId === b.teclId && a.subjId === b.subjId && a.teclCode === b.teclCode;
  }
  return a.teclId === b.teclId && a.courId === b.courId;
}
