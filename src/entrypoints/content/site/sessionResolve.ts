/**
 * 课次（courId）解析（技术文档 §3.1 修订版）。
 *
 * 背景：站点新播放页 `#/play-center` 的 URL **不含课次 ID**（只有 teclId / teclCode / subjId），
 * 课次由页面内右栏列表切换。旧实现要求 URL 同时提供 teclId + courId，导致该形态下整页不注入。
 *
 * 本模块用一组**互相独立**的证据链把 courId 求出来，任一命中即可（越靠前越可信）：
 *  1. `url`              —— hash 里直接带 courseId/courId（旧形态，或站点补写参数）；
 *  2. `media-name` / `media-query`
 *                        —— 正在播放的 `<video>` 地址：命名规则 `CloudIPC-{课次ID}-...`，
 *                           或地址里出现 `courseId=`；
 *  3. `network`          —— 站点自身对 `course_vod_urls_new?courseId=NNN` 等接口的请求
 *                           （SW 经 webRequest 观测后推送；页面资源时序条目兜底）；
 *  4. `last-play`        —— `/v1/source/vod/lastPlayInfoByTeclCode`，响应里含 courseId 与 vodUrls；
 *  5. `page-selection`   —— 页面上“被选中/高亮”的课次条目时间，与课次列表接口的 courBeginTime 对齐。
 *
 * 对 3、4、5 这类**推断**证据，只要有正在播放的媒体地址就**必须**用
 * `/v1/course_vod_urls_new` 的机位地址与当前播放地址核对（同源同路径）；
 * 核对不通过则继续尝试下一个候选，避免把用户切到的课次认成另一个课次
 * （认错课次会污染统计与笔记归属）。没有可核对的媒体地址时，结果标记为
 * `confidence: 'inferred'` / `verified: false`，由调用方决定是否等待或让用户手动选择。
 *
 * 纯逻辑部分（候选抽取 + 校验顺序）不依赖 DOM/网络，便于单测；DOM/网络访问统一由
 * `ResolveDeps` 注入。`SessionResolver` 是给内容脚本使用的有状态门面：可喂入观测到的
 * 请求地址、设置手动选择的课次，并复用最近一次结果。
 */

import type { CourEvidence, ResolvedSession } from '@/core/shared/types';
import { sameMediaFile } from './player';

const MAX_OBSERVED_URLS = 40;
/** 推断来源的候选上限，避免一次解析打出过多核对请求 */
const MAX_NETWORK_CANDIDATES = 6;
const MAX_PAGE_SELECTION_CANDIDATES = 8;

// ───────────────────────── 候选抽取（纯函数） ─────────────────────────

/** 视频文件命名里的课次 ID：`CloudIPC-{课次ID}-{设备通道}-{录像段}` */
const CLOUD_IPC_PATTERN = /CloudIPC-(\d+)-/i;
const MEDIA_COURSE_ID_PATTERN = /[?&](?:courseId|courId|course_id)=(\d+)/i;
const RESOURCE_COURSE_ID_PATTERN = /[?&]courseId=(\d+)/i;

function toPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function toPositiveIntFromNumber(value: number | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export interface MediaCourHint {
  courId: number;
  /** 文件名规则 or 媒体地址 query */
  evidence: Extract<CourEvidence, 'media-name' | 'media-query'>;
}

/**
 * 从一个媒体地址里推断课次 ID（不看签名参数）。
 * 命中顺序：文件名规则 → query 里的 courseId/courId。
 */
export function extractCourIdFromMediaUrlWithEvidence(url: string): MediaCourHint | undefined {
  if (!url) return undefined;
  const named = toPositiveInt(url.match(CLOUD_IPC_PATTERN)?.[1]);
  if (named !== undefined) return { courId: named, evidence: 'media-name' };
  const queried = toPositiveInt(url.match(MEDIA_COURSE_ID_PATTERN)?.[1]);
  if (queried !== undefined) return { courId: queried, evidence: 'media-query' };
  return undefined;
}

/** 从一个媒体地址里推断课次 ID（不看签名参数） */
export function extractCourIdFromMediaUrl(url: string): number | undefined {
  return extractCourIdFromMediaUrlWithEvidence(url)?.courId;
}

/** 兼容参考实现的旧命名 */
export function extractCourIdFromVideoUrl(url: string): number | undefined {
  return extractCourIdFromMediaUrl(url);
}

/** 地址是否像播放器媒体（用于从页面请求记录里筛媒体直链） */
export function isVideoLikeUrl(url: string): boolean {
  return /\.(mp4|m3u8)(\?|$)/i.test(url) || CLOUD_IPC_PATTERN.test(url);
}

/** 从资源时序条目地址里抽取课次 ID（站点自身的取流/元数据请求） */
export function extractCourIdFromResourceUrl(url: string): number | undefined {
  if (!url) return undefined;
  if (url.includes('course_vod_urls_new') || url.includes('course_vod_videoinfos')) {
    const parsed = toPositiveInt(url.match(RESOURCE_COURSE_ID_PATTERN)?.[1]);
    if (parsed !== undefined) return parsed;
  }
  // 播放器自身拉取的媒体地址同样可推断（仅限媒体地址，避免把任意带 courseId 的地址当证据）
  return isVideoLikeUrl(url) ? extractCourIdFromMediaUrl(url) : undefined;
}

// ───────────────────────── 课次标签解析（纯函数） ─────────────────────────

/**
 * 从文本里解析完整日期时间。
 * 兼容 `2026-10-14 10:25`、`2026-10-14T10:25`、`2026/10/14 10:25`、
 * `2026年10月14日 10:25`（站点不同版本/不同列表项的格式略有差异）。
 */
export function parseDatetimeMs(text: string): number | undefined {
  const matched = text.match(
    /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:T|\s+)\s*(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?/,
  );
  if (!matched) return undefined;
  const [, y, mo, d, h, mi, s] = matched;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi ?? 0);
  const second = Number(s ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  const ts = date.getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

/** 从文本里解析节次号：`第7节` / `第12节课` / `第 12 节` */
export function parseLetiNumber(text: string): number | undefined {
  const matched = text.match(/第\s*(\d{1,2})\s*节/);
  return toPositiveInt(matched?.[1]);
}

export interface SessionTimeRow {
  courId: number;
  beginTime: number;
  endTime?: number;
  letiNumber?: number;
}

/** 用开始时间（±90 秒）匹配课次；其次用节次号匹配 */
export function matchSessionByTime(
  rows: ReadonlyArray<SessionTimeRow>,
  beginMs: number,
  letiNumber?: number,
): number | undefined {
  if (Number.isFinite(beginMs)) {
    const tolerance = 90_000;
    const byTime = rows.find(
      (row) => row.courId > 0 && Number.isFinite(row.beginTime) && Math.abs(row.beginTime - beginMs) <= tolerance,
    );
    if (byTime) return byTime.courId;
  }
  if (letiNumber !== undefined) {
    const byLeti = rows.find((row) => row.courId > 0 && row.letiNumber === letiNumber);
    if (byLeti) return byLeti.courId;
  }
  return undefined;
}

/** 页面课次条目（DOM 读取） */
export interface DomSessionCandidate {
  /** 条目文本里的课次开始时间（毫秒）；部分新版条目只有显式 courId，此时为空 */
  beginMs?: number;
  letiNumber?: number;
  selected: boolean;
  /** 条目节点显式携带的课次 ID（如 `data-course="1227038"`），作为时间对齐之外的辅助证据 */
  courId?: number;
}

// ───────────────────────── 解析流程 ─────────────────────────

export type ResolveSource = 'url' | 'video-file' | 'network' | 'last-play' | 'dom-session-item' | 'manual';

export interface LastPlayHintLike {
  courId?: number;
  /** 兼容参考实现 deps 的字段名 */
  courseId?: number;
  playTime?: number;
  videoUrls: string[];
}

export interface ResolveDeps {
  /** hash 里已解析出的课次（若有） */
  fromUrl?: number;
  /** 当前主画面的媒体地址（`video.currentSrc`）；无播放器时返回 null */
  getVideoSrc(): string | null;
  /** 已观测到的站点请求地址（webRequest 推送 + 页面资源时序兜底，按时间升序） */
  listObservedUrls(): string[];
  /** 站点“上次播放”提示接口（读接口，失败返回 null） */
  fetchLastPlayHint(): Promise<LastPlayHintLike | null>;
  /** 该教学班的课次列表（读接口） */
  fetchSessions(): Promise<SessionTimeRow[]>;
  /** 页面上“已选中”的课次条目（DOM，可能为空数组） */
  collectDomCandidates(): DomSessionCandidate[];
  /** 核对：该课次的机位地址是否与当前播放的地址指向同一文件 */
  matchesPlayingVideo(courId: number, videoSrc: string): Promise<boolean>;
}

export interface ResolveOptions {
  /** 只要这些来源（用于“换个策略重试”/定位问题） */
  only?: ResolveSource[];
  /** 当前播放地址未知时是否接受推断来源（默认接受，但标记为 inferred/unverified） */
  allowUnverified?: boolean;
  /** 用户手动选择的课次（优先于所有自动证据） */
  manualCourId?: number;
  /** 额外观测地址（有状态 resolver 之外的调用方可直接传入） */
  observedUrls?: string[];
}

export interface ResolveResult extends ResolvedSession {
  /** 兼容参考实现的来源名（UI 诊断用） */
  source: ResolveSource;
  /** 推断证据是否已与当前播放地址核对通过；直证（URL/媒体/manual）为 undefined */
  verified?: boolean;
}

export function sourceForEvidence(evidence: CourEvidence): ResolveSource {
  switch (evidence) {
    case 'url':
      return 'url';
    case 'media-name':
    case 'media-query':
      return 'video-file';
    case 'site-request':
      return 'network';
    case 'site-last-play':
      return 'last-play';
    case 'page-selection':
      return 'dom-session-item';
    case 'manual':
      return 'manual';
  }
}

function isDirectEvidence(evidence: CourEvidence): boolean {
  return evidence === 'url' || evidence === 'media-name' || evidence === 'media-query' || evidence === 'manual';
}

function makeResult(courId: number, evidence: CourEvidence, verified?: boolean): ResolveResult {
  return {
    courId,
    evidence,
    confidence: isDirectEvidence(evidence) ? 'direct' : 'inferred',
    source: sourceForEvidence(evidence),
    verified: isDirectEvidence(evidence) ? undefined : verified,
  };
}

function mergeObservedUrls(...lists: ReadonlyArray<ReadonlyArray<string> | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const url of list) {
      if (!url) continue;
      // 重复地址代表“再次观测到”，移到队尾以保留最近一次的时间顺序
      const existing = out.indexOf(url);
      if (existing >= 0) out.splice(existing, 1);
      out.push(url);
    }
  }
  return out.slice(-MAX_OBSERVED_URLS);
}

/** 站点请求记录里能推断出的课次（去重后按“最近一次”在前） */
function observedUrlCandidates(urls: ReadonlyArray<string>): number[] {
  const ordered: number[] = [];
  for (const url of urls) {
    const courId = extractCourIdFromResourceUrl(url);
    if (courId === undefined) continue;
    // 同一课次再次出现时移到队尾，保证反序后“最近一次”在最前
    const existing = ordered.indexOf(courId);
    if (existing >= 0) ordered.splice(existing, 1);
    ordered.push(courId);
  }
  return ordered.reverse().slice(0, MAX_NETWORK_CANDIDATES);
}

/**
 * 页面选中项 → 课次列表。
 * 有显式 courId 的条目先校验是否属于当前教学班列表；
 * 没有显式 ID 的条目用时间（±90 秒）/节次号与列表对齐。
 */
function pageSelectionCourIds(candidates: ReadonlyArray<DomSessionCandidate>, rows: ReadonlyArray<SessionTimeRow>): number[] {
  // 选中项优先；选中标记缺失或过时时，剩余条目仍作为核对失败后的后备候选
  const ordered = [
    ...candidates.filter((candidate) => candidate.selected),
    ...candidates.filter((candidate) => !candidate.selected),
  ].slice(0, MAX_PAGE_SELECTION_CANDIDATES);
  const out: number[] = [];
  const push = (courId: number | undefined): void => {
    if (courId !== undefined && courId > 0 && !out.includes(courId)) out.push(courId);
  };

  for (const candidate of ordered) {
    const explicit = toPositiveIntFromNumber(candidate.courId);
    if (explicit !== undefined) {
      const belongs = rows.length === 0 || rows.some((row) => row.courId === explicit);
      if (belongs) {
        push(explicit);
        continue;
      }
    }
    if (candidate.beginMs !== undefined) {
      push(matchSessionByTime(rows, candidate.beginMs, candidate.letiNumber));
    }
  }
  return out;
}

function playingMediaUrl(raw: string | null): string | null {
  if (!raw) return null;
  // blob:/data: 地址不含课次信息且无法与接口机位地址核对，视为“没有可核对地址”
  if (raw.startsWith('blob:') || raw.startsWith('data:')) return null;
  return raw;
}

/**
 * 依次尝试各证据链，返回第一个可用的课次。
 * 全部失败返回 null（调用方进入“待识别”状态，由用户在课次列表里手动选择）。
 */
export async function resolveCourId(deps: ResolveDeps, options: ResolveOptions = {}): Promise<ResolveResult | null> {
  const accept = (source: ResolveSource): boolean => !options.only || options.only.includes(source);
  const allowUnverified = options.allowUnverified ?? true;

  // 0. 用户手动选择（最高优先级；内容脚本在用户点选后应停止自动改写）
  if (accept('manual')) {
    const manual = toPositiveIntFromNumber(options.manualCourId);
    if (manual !== undefined) return makeResult(manual, 'manual');
  }

  // 1. URL
  if (accept('url')) {
    const fromUrl = toPositiveIntFromNumber(deps.fromUrl);
    if (fromUrl !== undefined) return makeResult(fromUrl, 'url');
  }

  // 2. 正在播放的媒体地址
  let rawVideoSrc: string | null = null;
  try {
    rawVideoSrc = deps.getVideoSrc();
  } catch {
    rawVideoSrc = null;
  }
  const videoSrc = playingMediaUrl(rawVideoSrc);

  if (accept('video-file') && videoSrc) {
    const media = extractCourIdFromMediaUrlWithEvidence(videoSrc);
    if (media) return makeResult(media.courId, media.evidence);
  }

  // 3/4/5. 推断来源：收集候选，逐个与播放地址核对
  const inferred: Array<{ courId: number; evidence: CourEvidence }> = [];
  const pushInferred = (courId: number | undefined, evidence: CourEvidence): void => {
    if (courId === undefined || courId <= 0) return;
    if (inferred.some((item) => item.courId === courId)) return;
    inferred.push({ courId, evidence });
  };

  // 3. 站点请求记录（最近一次在前；旧候选保留，核对失败可继续尝试）
  if (accept('network')) {
    let observed: string[] = [];
    try {
      observed = deps.listObservedUrls() ?? [];
    } catch {
      observed = [];
    }
    const urls = mergeObservedUrls(observed, options.observedUrls);
    for (const courId of observedUrlCandidates(urls)) {
      pushInferred(courId, 'site-request');
    }
  }

  // 4. 站点“上次播放”记录
  if (accept('last-play')) {
    let hint: LastPlayHintLike | null = null;
    try {
      hint = await deps.fetchLastPlayHint();
    } catch {
      hint = null;
    }
    if (hint) {
      const hintCourId = toPositiveIntFromNumber(hint.courId) ?? toPositiveIntFromNumber(hint.courseId);
      // 提示接口若同时给了机位地址且与当前播放地址同文件，可直接采信该课次
      if (videoSrc && hint.videoUrls.length > 0) {
        const matchedUrl = hint.videoUrls.find((url) => sameMediaFile(url, videoSrc));
        const fromMatchedMedia = matchedUrl ? extractCourIdFromMediaUrl(matchedUrl) : undefined;
        const resolved = fromMatchedMedia ?? (matchedUrl ? hintCourId : undefined);
        if (resolved !== undefined) return makeResult(resolved, 'site-last-play', true);
      }
      pushInferred(hintCourId, 'site-last-play');
    }
  }

  // 5. 页面课次列表选中项：时间与课次列表对齐
  if (accept('dom-session-item')) {
    let domCandidates: DomSessionCandidate[] = [];
    try {
      domCandidates = deps.collectDomCandidates() ?? [];
    } catch {
      domCandidates = [];
    }
    if (domCandidates.length > 0) {
      let rows: SessionTimeRow[] = [];
      try {
        rows = (await deps.fetchSessions()) ?? [];
      } catch {
        rows = [];
      }
      for (const courId of pageSelectionCourIds(domCandidates, rows)) {
        pushInferred(courId, 'page-selection');
      }
    }
  }

  const verificationCache = new Map<number, boolean>();
  for (const candidate of inferred) {
    if (videoSrc) {
      // 有可核对的播放地址时：所有推断证据都必须与当前媒体文件一致
      let ok = verificationCache.get(candidate.courId);
      if (ok === undefined) {
        try {
          ok = await deps.matchesPlayingVideo(candidate.courId, videoSrc);
        } catch {
          ok = false;
        }
        verificationCache.set(candidate.courId, ok);
      }
      if (!ok) continue;
      return makeResult(candidate.courId, candidate.evidence, true);
    }
    if (allowUnverified) return makeResult(candidate.courId, candidate.evidence, false);
  }

  return null;
}

// ───────────────────────── 有状态解析器（内容脚本门面） ─────────────────────────

export interface SessionResolverOptions {
  /** 无播放地址时是否接受推断证据（默认 true，结果标记为 inferred/unverified） */
  allowUnverified?: boolean;
}

/**
 * 课次解析器：内容脚本把 webRequest / performance 观测到的站点请求喂进来，
 * 也可以传入用户手动选择的课次。每次 `resolve()` 都会复用最新的观测集合。
 */
export class SessionResolver {
  private readonly deps: ResolveDeps;
  private readonly allowUnverified: boolean;
  private observedUrls: string[] = [];
  private manualCourId: number | null = null;
  private lastResult: ResolveResult | null = null;

  constructor(deps: ResolveDeps, options: SessionResolverOptions = {}) {
    this.deps = deps;
    this.allowUnverified = options.allowUnverified ?? true;
  }

  /** 喂入一条站点请求/媒体地址（同一地址只保留最近一次） */
  noteObservedUrl(url: string): void {
    if (!url) return;
    this.observedUrls = [...this.observedUrls.filter((item) => item !== url), url].slice(-MAX_OBSERVED_URLS);
  }

  /** 路由切换/换课次时清空观测（避免把上一节的请求当成当前的） */
  resetObservations(): void {
    this.observedUrls = [];
  }

  /** 当前已收集的站点观测地址（副本） */
  getObservedUrls(): string[] {
    return [...this.observedUrls];
  }

  /** 用户手动选择课次；传 null 清除手动选择 */
  setManual(courId: number | null): void {
    this.manualCourId = toPositiveIntFromNumber(courId) ?? null;
    this.lastResult = null;
  }

  getManual(): number | null {
    return this.manualCourId;
  }

  clearManual(): void {
    this.manualCourId = null;
    this.lastResult = null;
  }

  getLastResult(): ResolveResult | null {
    return this.lastResult;
  }

  async resolve(options: ResolveOptions = {}): Promise<ResolveResult | null> {
    const deps: ResolveDeps = {
      ...this.deps,
      listObservedUrls: () => {
        let base: string[] = [];
        try {
          base = this.deps.listObservedUrls() ?? [];
        } catch {
          base = [];
        }
        return mergeObservedUrls(base, this.observedUrls);
      },
    };
    const result = await resolveCourId(deps, {
      ...options,
      allowUnverified: options.allowUnverified ?? this.allowUnverified,
      manualCourId: options.manualCourId ?? this.manualCourId ?? undefined,
    });
    this.lastResult = result;
    return result;
  }
}

/** 单条证据链的展示名（UI 诊断用，不暴露内部结构） */
export function resolveSourceLabel(source: ResolveSource): string {
  switch (source) {
    case 'url':
      return '地址参数';
    case 'video-file':
      return '播放地址';
    case 'network':
      return '页面请求记录';
    case 'last-play':
      return '站点播放记录';
    case 'dom-session-item':
      return '课次列表选中项';
    case 'manual':
      return '手动选择';
    default:
      return '未知来源';
  }
}
