/**
 * 播放器控制封装（技术文档 §3.3）。
 *
 * 全部基于原生 `<video>`，不依赖站点 KMedia SDK，不模拟点击站点控件：
 *  - 主/副画面识别（选择器优先，兜底取面积最大者）；
 *  - 状态读取、seek、事件订阅、当前机位地址；
 *  - `videoCount` 变化时通过 MutationObserver 重扫描（站点切换机位/重建播放器）。
 *
 * 新版播放页 `#/play-center` 沿用同一套 `player-wrapper` / `second-player-container`
 * 结构，但容器类名可能不再带 `.play-video`。因此主画面选择器做了逐级放宽，
 * 仍以技术文档选择器为首选，失败时退回 `.player-wrapper video` 与“面积最大 video”。
 */

import { SELECTORS } from '@/core/shared/constants';
import { createLogger } from '@/core/shared/logger';
import type { PlayerState, VodView } from '@/core/shared/types';

const log = createLogger('site-player');

export type PlayerEvent =
  | 'timeupdate'
  | 'play'
  | 'pause'
  | 'seeking'
  | 'seeked'
  | 'ratechange'
  | 'loadedmetadata'
  | 'loadeddata'
  | 'canplay'
  | 'ended'
  | 'waiting'
  | 'progress'
  | 'emptied'
  | 'loadstart'
  | 'durationchange'
  | 'error';

export interface PlayerHandle {
  getPrimary(): HTMLVideoElement | null;
  /** 非主画面的视频（副画面/多机位） */
  getSecondary(): HTMLVideoElement[];
  /** 主画面在首位，其余按 DOM 顺序（多机位） */
  getViews(): HTMLVideoElement[];
  getState(): PlayerState;
  /** 时长真值：优先 video.duration，不一致时回退接口 vodTime（§3.3） */
  getDuration(fallbackSec?: number): number;
  seek(seconds: number, view?: number): void;
  on(evt: PlayerEvent, cb: () => void): () => void;
  /** 当前主画面地址（`video.currentSrc`） */
  currentViewUrl(): string;
  /** 用 currentSrc 与接口视图列表比对，识别当前机位 */
  currentViewIndex(views?: VodView[]): number;
  /** 监听 video 数量/元素变化（站点切换机位/重建播放器） */
  onViewsChanged(cb: (count: number) => void): () => void;
  destroy(): void;
}

// ───────────────────────── 选择器（新版播放页逐级放宽） ─────────────────────────

const PRIMARY_VIDEO_SELECTORS: ReadonlyArray<string> = [
  // 技术文档 §3.4 的首选
  SELECTORS.primaryVideo,
  // play-center 容器（新播放页）
  '.play-center .left-module-wrapper .player-wrapper video',
  '.play-center .player-wrapper video',
  // 旧主播放页容器
  '.play-video-main-container .left-module-wrapper .player-wrapper video',
  '.play-video-main-container .player-wrapper video',
  // 结构变化时仍可识别的宽选择器
  '.left-module-wrapper .player-wrapper video',
  '.player-wrapper video',
];

const SECONDARY_VIDEO_SELECTORS: ReadonlyArray<string> = [
  SELECTORS.secondaryVideo,
  '.second-player-container video',
  '.secondary-player-container video',
  '.sub-player-container video',
];

const PLAYER_ROOT_SELECTORS: ReadonlyArray<string> = [
  '.play-center',
  SELECTORS.playRoot,
  SELECTORS.playMainContainer,
  SELECTORS.primaryWrapper,
  SELECTORS.secondaryContainer,
  '.player-wrapper',
];

function isVideoElement(el: Element): el is HTMLVideoElement {
  return el instanceof HTMLVideoElement || el.tagName === 'VIDEO';
}

function queryVideos(selectors: ReadonlyArray<string>): HTMLVideoElement[] {
  const out: HTMLVideoElement[] = [];
  const seen = new Set<HTMLVideoElement>();
  for (const selector of selectors) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (!isVideoElement(node) || seen.has(node)) continue;
      seen.add(node);
      out.push(node);
    }
  }
  return out;
}

function allVideos(): HTMLVideoElement[] {
  return [...document.querySelectorAll('video')].filter(isVideoElement);
}

function videoArea(video: HTMLVideoElement): number {
  const rect = video.getBoundingClientRect();
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function largestByArea(videos: HTMLVideoElement[]): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = -1;
  for (const video of videos) {
    const area = videoArea(video);
    if (area > bestArea) {
      best = video;
      bestArea = area;
    }
  }
  return best;
}

function findObserveTarget(): Element | null {
  for (const selector of PLAYER_ROOT_SELECTORS) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch {
      /* 选择器不合法时忽略 */
    }
  }
  return document.body;
}

// ───────────────────────── 句柄 ─────────────────────────

export function createPlayerHandle(): PlayerHandle {
  let primary: HTMLVideoElement | null = null;
  let lastViews: HTMLVideoElement[] = [];
  let lastPrimary: HTMLVideoElement | null = null;
  let destroyed = false;

  const changeListeners = new Set<(count: number) => void>();
  const eventHandlers = new Map<PlayerEvent, Set<() => void>>();
  const boundListeners = new Map<PlayerEvent, () => void>();
  let boundVideo: HTMLVideoElement | null = null;

  let observer: MutationObserver | null = null;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;

  const makeHandler = (evt: PlayerEvent): (() => void) => {
    return () => {
      const handlers = eventHandlers.get(evt);
      if (!handlers) return;
      for (const cb of [...handlers]) {
        try {
          cb();
        } catch (err) {
          log.debug(`播放器事件处理失败：${evt}`, err);
        }
      }
    };
  };

  const detachVideo = (): void => {
    if (!boundVideo) return;
    for (const [evt, handler] of boundListeners) {
      boundVideo.removeEventListener(evt, handler);
    }
    boundListeners.clear();
    boundVideo = null;
  };

  /** 主画面被替换时把已订阅的事件迁到新元素上 */
  const bindVideo = (video: HTMLVideoElement | null): void => {
    if (boundVideo === video) return;
    detachVideo();
    boundVideo = video;
    if (!video) return;
    for (const [evt, handlers] of eventHandlers) {
      if (handlers.size === 0) continue;
      const handler = makeHandler(evt);
      video.addEventListener(evt, handler);
      boundListeners.set(evt, handler);
    }
  };

  const scan = (): void => {
    if (destroyed) return;
    const preferred = queryVideos(PRIMARY_VIDEO_SELECTORS);
    const secondaryPreferred = queryVideos(SECONDARY_VIDEO_SELECTORS).filter((video) => !preferred.includes(video));
    const remaining = allVideos().filter(
      (video) => !preferred.includes(video) && !secondaryPreferred.includes(video),
    );
    const all = [...preferred, ...secondaryPreferred, ...remaining];
    const nextPrimary = preferred.length > 0 ? largestByArea(preferred) : largestByArea(all);
    const ordered = nextPrimary ? [nextPrimary, ...all.filter((video) => video !== nextPrimary)] : all;

    const changed =
      nextPrimary !== lastPrimary ||
      ordered.length !== lastViews.length ||
      ordered.some((video, index) => video !== lastViews[index]);

    primary = nextPrimary;
    lastPrimary = nextPrimary;
    lastViews = ordered;
    bindVideo(nextPrimary);

    if (changed) {
      for (const cb of [...changeListeners]) {
        try {
          cb(ordered.length);
        } catch (err) {
          log.debug('onViewsChanged 回调失败', err);
        }
      }
    }
  };

  const scheduleScan = (): void => {
    if (destroyed || scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 120);
  };

  const ensureScanned = (): void => {
    if (destroyed) return;
    if (!primary || !primary.isConnected) {
      scan();
      return;
    }
    if (lastViews.some((video) => !video.isConnected)) scan();
  };

  // 首次扫描（此时页面可能尚未渲染播放器，靠 observer 后续补扫）
  scan();

  try {
    observer = new MutationObserver(() => scheduleScan());
    const target = findObserveTarget();
    if (target) {
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'class', 'style'],
      });
    }
  } catch (err) {
    log.warn('MutationObserver 启动失败（机位切换需手动刷新）', err);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', scheduleScan, { passive: true });
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('fullscreenchange', scheduleScan);
  }

  const handle: PlayerHandle = {
    getPrimary(): HTMLVideoElement | null {
      ensureScanned();
      return primary;
    },

    getSecondary(): HTMLVideoElement[] {
      const views = handle.getViews();
      return views.length > 1 ? views.slice(1) : [];
    },

    getViews(): HTMLVideoElement[] {
      ensureScanned();
      return lastViews.filter((video) => video.isConnected);
    },

    getState(): PlayerState {
      const video = handle.getPrimary();
      if (!video) return { currentTime: 0, duration: 0, paused: true, rate: 1 };
      return {
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        paused: video.paused,
        rate: video.playbackRate > 0 ? video.playbackRate : 1,
      };
    },

    getDuration(fallbackSec?: number): number {
      const video = handle.getPrimary();
      const fromVideo = video && Number.isFinite(video.duration) ? video.duration : 0;
      if (fromVideo > 0) return fromVideo;
      return fallbackSec && fallbackSec > 0 ? fallbackSec : 0;
    },

    seek(seconds: number, view?: number): void {
      if (!Number.isFinite(seconds)) return;
      const views = handle.getViews();
      let target: HTMLVideoElement | null = null;
      if (typeof view === 'number' && view > 0) target = views[view - 1] ?? null;
      const video = target ?? handle.getPrimary();
      if (!video) {
        log.debug('seek 失败：未找到 video 元素');
        return;
      }
      // 元数据未加载时 duration 为 NaN/0，此时直接赋值由浏览器收敛，避免一律跳回 0
      const max =
        Number.isFinite(video.duration) && video.duration > 0 ? Math.max(0, video.duration - 0.2) : seconds;
      video.currentTime = Math.max(0, Math.min(seconds, max));
      log.debug('seek', { seconds, view });
    },

    on(evt: PlayerEvent, cb: () => void): () => void {
      let handlers = eventHandlers.get(evt);
      if (!handlers) {
        handlers = new Set();
        eventHandlers.set(evt, handlers);
      }
      handlers.add(cb);

      const video = handle.getPrimary();
      if (video && boundVideo !== video) bindVideo(video);
      if (boundVideo && !boundListeners.has(evt)) {
        const handler = makeHandler(evt);
        boundVideo.addEventListener(evt, handler);
        boundListeners.set(evt, handler);
      }

      return () => {
        const current = eventHandlers.get(evt);
        if (!current) return;
        current.delete(cb);
        if (current.size === 0) {
          eventHandlers.delete(evt);
          const handler = boundListeners.get(evt);
          if (handler && boundVideo) {
            boundVideo.removeEventListener(evt, handler);
            boundListeners.delete(evt);
          }
        }
      };
    },

    currentViewUrl(): string {
      const video = handle.getPrimary();
      return video?.currentSrc || video?.getAttribute('src') || '';
    },

    currentViewIndex(views?: VodView[]): number {
      const video = handle.getPrimary();
      // 元数据尚未加载时 currentSrc 为空，退回 src 属性（否则会误报为第 1 机位）
      const src = video?.currentSrc || video?.getAttribute('src') || '';
      if (!src) return 1;
      if (views && views.length > 0) {
        const index = views.findIndex((view) => view.url.length > 0 && sameMediaFile(view.url, src));
        if (index >= 0) return views[index]?.viewNum ?? index + 1;
      }
      // 兜底：按 DOM 顺序
      const all = handle.getViews();
      const domIndex = all.findIndex((el) => sameMediaFile(el.currentSrc || el.getAttribute('src') || '', src));
      return domIndex >= 0 ? domIndex + 1 : 1;
    },

    onViewsChanged(cb: (count: number) => void): () => void {
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },

    destroy(): void {
      destroyed = true;
      observer?.disconnect();
      observer = null;
      if (scanTimer !== null) {
        clearTimeout(scanTimer);
        scanTimer = null;
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', scheduleScan);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('fullscreenchange', scheduleScan);
      }
      detachVideo();
      changeListeners.clear();
      eventHandlers.clear();
      primary = null;
      lastPrimary = null;
      lastViews = [];
    },
  };

  return handle;
}

/** 判断两个媒体地址是否指向同一个视频文件（忽略签名 query） */
export function sameMediaFile(a: string, b: string): boolean {
  if (!a || !b) return false;
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    const ua = new URL(a, base);
    const ub = new URL(b, base);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}
