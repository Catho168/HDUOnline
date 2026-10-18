/**
 * 站点观测（课次识别的取证层）。
 *
 * 把三类“外部证据”收敛成一个可测试的依赖集合，交给 `sessionResolve` 做判定：
 *  1. 站点请求地址——SW 经 `chrome.webRequest` 观测到 `course_vod_urls_new?courseId=NNN`
 *     后推送给本标签页；页面资源时序（performance）作为兜底；
 *  2. DOM 线索——页面上“看起来被选中”的课次条目时间（站点切换课次只改页面内部状态，
 *     URL 不变，因此时间文本/显式 data 属性是唯一可用的页面内证据）；
 *  3. 核对能力——用 `/v1/course_vod_urls_new` 的机位地址与当前播放地址比对，确认推断无误。
 *
 * 另外提供两个**只读**观察器给内容脚本：
 *  - `observeMediaSrcChanges`：主/副画面 `currentSrc` 变化（轮询 + 媒体事件 + MutationObserver）；
 *  - `observeSessionSelection`：右栏课次列表选中项变化（class/aria 属性 + 点击/键盘事件）。
 * 两者都不写站点 DOM、不 preventDefault、不调用站点写接口、不接触凭据。
 */

import type { RouteInfo } from '@/core/shared/types';
import { createLogger } from '@/core/shared/logger';
import { fetchCourseVodUrls, fetchLastPlayInfo, fetchSessionList } from './api';
import type { PlayerHandle } from './player';
import { sameMediaFile } from './player';
import {
  parseDatetimeMs,
  parseLetiNumber,
  SessionResolver,
  type DomSessionCandidate,
  type ResolveDeps,
  type SessionResolverOptions,
  type SessionTimeRow,
} from './sessionResolve';

const log = createLogger('site-observations');

const MAX_URLS = 40;

// ───────────────────────── 站点请求观测 ─────────────────────────

let hintedUrls: string[] = [];

/** SW 推送的站点请求线索（同一地址只保留最近一次） */
export function noteObservedUrl(url: string): void {
  if (!url) return;
  hintedUrls = [...hintedUrls.filter((item) => item !== url), url].slice(-MAX_URLS);
}

/** 路由切换时清空线索，避免把上一个课次的请求当成当前的 */
export function resetObservations(): void {
  hintedUrls = [];
}

/** 页面资源时序兜底（内容脚本隔离环境不一定能读到页面的条目，读不到就返回空） */
function performanceUrls(): string[] {
  try {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return entries
      .filter(
        (entry) =>
          entry.name.includes('course_vod_urls_new') ||
          entry.name.includes('course_vod_videoinfos') ||
          /\.(mp4|m3u8)(\?|$)/i.test(entry.name),
      )
      .sort((a, b) => a.startTime - b.startTime)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function listObservedUrls(): string[] {
  if (hintedUrls.length > 0) return [...hintedUrls];
  return [...new Set(performanceUrls())].slice(-MAX_URLS);
}

// ───────────────────────── DOM 线索 ─────────────────────────

/** 兼容参考实现的导出名 */
export type DomCandidate = DomSessionCandidate;

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'HEAD', 'META', 'LINK', 'TEMPLATE', 'TITLE']);
const SELECTED_HINT = /(active|selected|current|playing|checked|focus)/i;
const SELECTED_FLAG_ATTRS = ['aria-selected', 'data-selected', 'data-active', 'data-current'] as const;
const SELECTED_STATE_ATTRS = ['data-status', 'data-state'] as const;
const EXPLICIT_COURSE_ATTRS = [
  'data-course-id',
  'data-courseid',
  'data-cour-id',
  'data-courid',
  'data-course',
  'data-cours',
  'data-lecture-id',
  'data-lectureid',
] as const;

function isTruthyFlag(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === 'true' ||
    normalized === '1' ||
    normalized === 'selected' ||
    normalized === 'active' ||
    normalized === 'current' ||
    normalized === 'playing'
  );
}

/**
 * 从条目元素或其近祖先读取显式课次 ID（`data-course="1227038"` 等）。
 * `climbAncestors=false` 时只看元素自身，避免时间文本缺失的子节点各自产出重复候选。
 */
function readExplicitCourId(el: HTMLElement, climbAncestors: boolean): number | undefined {
  let node: HTMLElement | null = el;
  const maxDepth = climbAncestors ? 4 : 1;
  for (let depth = 0; depth < maxDepth && node; depth += 1) {
    for (const attr of EXPLICIT_COURSE_ATTRS) {
      const raw = node.getAttribute(attr);
      if (!raw) continue;
      const matched = raw.trim().match(/^(?:course|cour|lecture)?[-_:]?(\d+)$/i);
      if (!matched?.[1]) continue;
      const parsed = Number(matched[1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    node = node.parentElement;
  }
  return undefined;
}

function isSelectedLike(el: HTMLElement): boolean {
  let node: HTMLElement | null = el;
  for (let depth = 0; depth < 5 && node; depth += 1) {
    const cls = typeof node.className === 'string' ? node.className : '';
    if (SELECTED_HINT.test(cls)) return true;
    if (SELECTED_FLAG_ATTRS.some((attr) => isTruthyFlag(node?.getAttribute(attr) ?? null))) return true;
    const ariaCurrent = node.getAttribute('aria-current');
    if (ariaCurrent && ariaCurrent !== 'false') return true;
    if (SELECTED_STATE_ATTRS.some((attr) => SELECTED_HINT.test(node?.getAttribute(attr) ?? ''))) return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * 扫描页面上带“日期 + 时间”的课次条目，并标记“看起来被选中”的条目。
 * 只取近叶子节点并去重，避免父子元素重复命中。
 *
 * 相比参考实现放宽了两处，以适配新版播放页：
 *  - 近叶子阈值 3 → 4，文本长度 160 → 200（条目内多了状态角标）；
 *  - 被选中条目即使暂时不可见（如折叠列表）也保留；未选中条目仍要求可见。
 */
export function collectDomCandidates(root: ParentNode = document): DomSessionCandidate[] {
  const scope: ParentNode = root instanceof Document ? (root.body ?? root.documentElement) : root;
  let nodes: Element[];
  try {
    nodes = [...scope.querySelectorAll('*')];
  } catch {
    return [];
  }

  const byKey = new Map<string, DomSessionCandidate>();
  for (const el of nodes) {
    if (!(el instanceof HTMLElement) || SKIP_TAGS.has(el.tagName)) continue;
    if (el.children.length > 4) continue; // 近叶子节点
    const text = (el.textContent ?? '').trim();
    if (!text || text.length > 200) continue;

    const beginMs = parseDatetimeMs(text);
    // 有时间文本的条目允许从近祖先取显式课次 ID；只有 ID 的条目必须自身带属性
    const explicitCourId = readExplicitCourId(el, beginMs !== undefined);
    if (beginMs === undefined && explicitCourId === undefined) continue;

    const selected = isSelectedLike(el);
    if (!selected) {
      // 非选中条目不可见时多半是模板/隐藏菜单；选中条目保留，便于折叠列表也能识别
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
    }

    const letiNumber = parseLetiNumber(text);
    const key = beginMs !== undefined ? `t:${beginMs}` : `c:${explicitCourId}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { beginMs, letiNumber, selected, courId: explicitCourId });
      continue;
    }
    if (
      (selected && !prev.selected) ||
      (explicitCourId !== undefined && prev.courId === undefined) ||
      (letiNumber !== undefined && prev.letiNumber === undefined)
    ) {
      byKey.set(key, {
        beginMs: prev.beginMs ?? beginMs,
        letiNumber: prev.letiNumber ?? letiNumber,
        selected: prev.selected || selected,
        courId: prev.courId ?? explicitCourId,
      });
    }
  }
  return [...byKey.values()];
}

// ───────────────────────── 核对 ─────────────────────────

/** 该课次的机位地址是否与正在播放的地址指向同一文件（认错课次会污染统计与笔记归属） */
export async function matchesPlayingVideo(courId: number, videoSrc: string): Promise<boolean> {
  if (!videoSrc) return false;
  const data = await fetchCourseVodUrls(courId);
  if (!data) return false;
  return data.meta.views.some((view) => view.url.length > 0 && sameMediaFile(view.url, videoSrc));
}

// ───────────────────────── 装配 ─────────────────────────

export function createResolveDeps(route: RouteInfo, player: PlayerHandle): ResolveDeps {
  return {
    fromUrl: route.courId,
    getVideoSrc: () => {
      const primary = player.getPrimary();
      if (!primary) return null;
      return primary.currentSrc || primary.getAttribute('src') || null;
    },
    listObservedUrls,
    fetchLastPlayHint: async () => {
      if (!route.teclCode) return null;
      const hint = await fetchLastPlayInfo(route.teclCode);
      if (!hint) return null;
      return {
        courId: hint.courId,
        courseId: hint.courId,
        playTime: hint.playTime,
        videoUrls: hint.videoUrls,
      };
    },
    fetchSessions: async (): Promise<SessionTimeRow[]> => {
      if (route.teclId === undefined) return [];
      const list = await fetchSessionList(route.teclId);
      return list
        .filter((item) => item.courId > 0)
        .map((item) => ({
          courId: item.courId,
          beginTime: item.beginTime,
          endTime: item.endTime,
          letiNumber: item.letiNumber,
        }));
    },
    collectDomCandidates: () => collectDomCandidates(),
    matchesPlayingVideo,
  };
}

/** 内容脚本可直接使用的有状态解析器（可喂入站点请求观测/手动课次） */
export function createSessionResolver(
  route: RouteInfo,
  player: PlayerHandle,
  options?: SessionResolverOptions,
): SessionResolver {
  return new SessionResolver(createResolveDeps(route, player), options);
}

// ───────────────────────── 媒体地址观察（只读） ─────────────────────────

export interface ObservationHandle {
  disconnect(): void;
}

export interface MediaSrcChange {
  /** 当前地址；video 被移除时为 null */
  src: string | null;
  previous: string | null;
  video: HTMLVideoElement | null;
  isPrimary: boolean;
  /** 1-based 机位序号；未知/已移除为 0 */
  viewIndex: number;
}

export interface ObserveMediaSrcOptions {
  /** 传入播放器句柄可复用其主/副画面识别与重扫描 */
  player?: PlayerHandle;
  /** 不传 player 时从该 root 下查找 video */
  root?: ParentNode;
  /** 轮询周期（`video.src = ...` 不会触发属性 Mutation），默认 1500ms；<=0 关闭轮询 */
  intervalMs?: number;
}

function isVideoElement(el: Element): el is HTMLVideoElement {
  return el instanceof HTMLVideoElement || el.tagName === 'VIDEO';
}

function videoSrcOf(video: HTMLVideoElement | null): string | null {
  if (!video) return null;
  const src = video.currentSrc || video.getAttribute('src') || '';
  return src || null;
}

function observationVideos(player: PlayerHandle | undefined, root: ParentNode | undefined): HTMLVideoElement[] {
  if (player) {
    const views = player.getViews();
    if (views.length > 0) return views;
  }
  const scope = root ?? document;
  try {
    return [...scope.querySelectorAll('video')].filter(isVideoElement);
  } catch {
    return [];
  }
}

/** 媒体观察默认只盯播放器区域，避免整页 DOM 变化触发无谓扫描 */
function findMediaObserveRoot(): Element {
  for (const selector of ['.play-video', '.play-center', '.play-video-main-container', '.player-wrapper', 'body']) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch {
      /* 忽略非法选择器 */
    }
  }
  return document.documentElement;
}

/**
 * 观察媒体地址变化（主画面优先，副画面也上报）。
 * 首次观察到一个地址时会以 `previous: null` 回调一次，便于调用方初始化。
 */
export function observeMediaSrcChanges(
  cb: (change: MediaSrcChange) => void,
  options: ObserveMediaSrcOptions = {},
): ObservationHandle {
  const { player, root, intervalMs = 1500 } = options;
  let disconnected = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let lastPrimary: HTMLVideoElement | null = null;
  let lastPrimarySrc: string | null = null;
  const lastByVideo = new Map<HTMLVideoElement, string | null>();
  const eventCleanups = new Map<HTMLVideoElement, () => void>();

  const emit = (change: MediaSrcChange): void => {
    try {
      cb(change);
    } catch (err) {
      log.debug('媒体地址回调失败', err);
    }
  };

  function ensureMediaListeners(video: HTMLVideoElement): void {
    if (eventCleanups.has(video)) return;
    const events = ['loadstart', 'loadedmetadata', 'loadeddata', 'emptied', 'playing', 'error'];
    const handler = (): void => scheduleCheck();
    for (const evt of events) video.addEventListener(evt, handler);
    eventCleanups.set(video, () => {
      for (const evt of events) video.removeEventListener(evt, handler);
    });
  }

  function check(): void {
    if (disconnected) return;
    const videos = observationVideos(player, root);
    const live = new Set(videos);
    const primary = player?.getPrimary() ?? videos[0] ?? null;
    const primarySrc = videoSrcOf(primary);
    const primaryIndex = primary ? videos.indexOf(primary) : -1;

    for (const video of videos) {
      ensureMediaListeners(video);
      const src = videoSrcOf(video);
      const had = lastByVideo.has(video);
      const previous = lastByVideo.get(video) ?? null;
      lastByVideo.set(video, src);
      if (!had) {
        if (video === primary) continue; // 主画面统一在下方上报，避免重复
        if (src) {
          emit({ src, previous: null, video, isPrimary: false, viewIndex: videos.indexOf(video) + 1 });
        }
        continue;
      }
      if (video !== primary && src !== previous) {
        emit({ src, previous, video, isPrimary: false, viewIndex: videos.indexOf(video) + 1 });
      }
    }

    for (const [video, src] of [...lastByVideo.entries()]) {
      if (live.has(video)) continue;
      lastByVideo.delete(video);
      eventCleanups.get(video)?.();
      eventCleanups.delete(video);
      if (src && video !== lastPrimary) {
        emit({ src: null, previous: src, video, isPrimary: false, viewIndex: 0 });
      }
    }

    if (primarySrc !== lastPrimarySrc || primary !== lastPrimary) {
      const previous = lastPrimarySrc;
      lastPrimarySrc = primarySrc;
      lastPrimary = primary;
      if (primarySrc || previous) {
        emit({
          src: primarySrc,
          previous,
          video: primary,
          isPrimary: true,
          viewIndex: primaryIndex >= 0 ? primaryIndex + 1 : 1,
        });
      }
    }
  }

  function scheduleCheck(): void {
    if (disconnected || debounce !== null) return;
    debounce = setTimeout(() => {
      debounce = null;
      check();
    }, 100);
  }

  const observeTarget: Node = (root as Node | undefined) ?? findMediaObserveRoot();
  const observer = new MutationObserver(() => scheduleCheck());
  try {
    observer.observe(observeTarget, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  } catch (err) {
    log.warn('媒体地址观察器启动失败（仍会轮询）', err);
  }

  const offViews = player?.onViewsChanged(() => check());
  const poll = intervalMs > 0 ? setInterval(check, intervalMs) : null;

  check();

  return {
    disconnect(): void {
      disconnected = true;
      observer.disconnect();
      if (debounce !== null) {
        clearTimeout(debounce);
        debounce = null;
      }
      if (poll !== null) clearInterval(poll);
      offViews?.();
      for (const cleanup of eventCleanups.values()) cleanup();
      eventCleanups.clear();
      lastByVideo.clear();
      lastPrimary = null;
      lastPrimarySrc = null;
    },
  };
}

// ───────────────────────── 课次列表选中项观察（只读） ─────────────────────────

export interface SessionSelectionChange {
  selected: DomSessionCandidate | null;
  previous: DomSessionCandidate | null;
  /** 当前页面能看到的全部课次条目（未选中的也在内，供诊断/手动选择参考） */
  candidates: DomSessionCandidate[];
}

export interface ObserveSessionSelectionOptions {
  /** 默认自动定位右栏课次列表；定位失败时扫描整页 */
  root?: ParentNode;
  debounceMs?: number;
}

const SESSION_LIST_ROOT_SELECTORS: ReadonlyArray<string> = [
  '.right-body .body-content',
  '.right-body',
  '.session-list',
  '.catalog-list',
  '.course-session-list',
  '.play-center .body-content',
  '.body-content',
];

function findSessionListRoot(): ParentNode {
  for (const selector of SESSION_LIST_ROOT_SELECTORS) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch {
      /* 忽略非法选择器 */
    }
  }
  return document;
}

function selectionKey(candidate: DomSessionCandidate | null): string {
  if (!candidate) return '';
  return `${candidate.courId ?? ''}:${candidate.beginMs ?? ''}:${candidate.letiNumber ?? ''}`;
}

/**
 * 观察右栏课次列表的选中项变化（站点切换课次只改页面内部状态，URL 不变）。
 * 选中项变化时回调；首次发现选中项时也会回调一次（previous 为 null）。
 */
export function observeSessionSelection(
  cb: (change: SessionSelectionChange) => void,
  options: ObserveSessionSelectionOptions = {},
): ObservationHandle {
  const { root, debounceMs = 180 } = options;
  let disconnected = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let initialized = false;
  let lastKey = '';
  let lastSelected: DomSessionCandidate | null = null;

  const emit = (change: SessionSelectionChange): void => {
    try {
      cb(change);
    } catch (err) {
      log.debug('课次选中项回调失败', err);
    }
  };

  function check(): void {
    if (disconnected) return;
    const scope = root ?? findSessionListRoot();
    const candidates = collectDomCandidates(scope);
    const selected = [...candidates].reverse().find((candidate) => candidate.selected) ?? null;
    const key = selectionKey(selected);

    if (!initialized) {
      initialized = true;
      lastKey = key;
      if (selected) {
        lastSelected = selected;
        emit({ selected, previous: null, candidates });
      }
      return;
    }
    if (key === lastKey) return;

    const previous = lastSelected;
    lastKey = key;
    lastSelected = selected;
    emit({ selected, previous, candidates });
  }

  function scheduleCheck(delay = debounceMs): void {
    if (disconnected) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (delay <= 0) {
      check();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      check();
    }, delay);
  }

  const initialScope = root ?? findSessionListRoot();
  const observeTarget: Node =
    (root as Node | undefined) ?? (initialScope instanceof Element ? initialScope : document.body);
  const observer = new MutationObserver(() => scheduleCheck());
  try {
    observer.observe(observeTarget, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'class',
        'aria-selected',
        'aria-current',
        'data-selected',
        'data-active',
        'data-status',
        'data-state',
      ],
    });
  } catch (err) {
    log.warn('课次选中项观察器启动失败', err);
  }

  // 只读监听：不 preventDefault / stopPropagation，站点自身的点击逻辑照常执行
  const onClick = (): void => {
    scheduleCheck(0);
    scheduleCheck(Math.max(250, debounceMs));
  };
  const onKeyDown = (evt: Event): void => {
    const key = (evt as KeyboardEvent).key;
    if (key === 'Enter' || key === ' ' || key === 'ArrowUp' || key === 'ArrowDown') onClick();
  };
  const onFocusIn = (): void => scheduleCheck();

  const eventTarget = observeTarget as EventTarget;
  eventTarget.addEventListener('click', onClick, { passive: true, capture: true });
  eventTarget.addEventListener('keydown', onKeyDown, { passive: true, capture: true });
  eventTarget.addEventListener('focusin', onFocusIn, { passive: true, capture: true });

  check();

  return {
    disconnect(): void {
      disconnected = true;
      observer.disconnect();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      eventTarget.removeEventListener('click', onClick, { capture: true });
      eventTarget.removeEventListener('keydown', onKeyDown, { capture: true });
      eventTarget.removeEventListener('focusin', onFocusIn, { capture: true });
      lastSelected = null;
    },
  };
}

/** 语义更明确的别名 */
export const observeSessionListSelection = observeSessionSelection;
