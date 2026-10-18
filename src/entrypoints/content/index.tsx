/**
 * 内容脚本入口：站点识别 → 会话解析 → 数据加载 → Shadow DOM UI → 统计/转写/AI 编排。
 *
 * 设计原则：
 *  - 只读站点：不调用写接口、不修改站点 DOM、不劫持站点快捷键；
 *  - 多证据识别课次（play-center 的 URL 不含课次 ID）；
 *  - 站点播放器仍是主角，扩展 UI 全部在 Shadow DOM 内；
 *  - 任何单点失败静默降级，不阻塞播放。
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import { callOp, onBackgroundEvent } from '@/core/shared/client';
import { SITE_ORIGINS, SELECTORS, RESERVED_KEYS } from '@/core/shared/constants';
import { toAppError } from '@/core/shared/errors';
import { createLogger } from '@/core/shared/logger';
import { loadSettings, onSettingsChanged, saveSettings } from '@/core/shared/settings';
import type {
  AppSettings,
  ChatMessageEntity,
  CourseEntity,
  CourseListItem,
  FavoriteEntity,
  NoteEntity,
  RouteInfo,
  SessionListItem,
  SessionMeta,
  SiteNote,
  VodView,
} from '@/core/shared/types';
import type { EventPayload } from '@/core/shared/messages';
import { buildCourLabel, formatClock, startOfLocalWeek, summarize, uuid } from '@/core/shared/utils';
import {
  fetchCourseVodUrls,
  fetchCourseWall,
  fetchCurriculum,
  fetchPlayPageData,
  fetchSessionList,
  fetchSiteCollectionStatus,
  fetchSiteNotes,
  fetchTeachingClass,
  fetchTermYears,
  orderTermYearsForSchedule,
  type TermYear,
} from './site/api';
import { lessonHash } from './site/navigation';
import { createPlayerHandle, type PlayerHandle } from './site/player';
import { detectSite, isPlayRoute, parseRoute } from './site/routes';
import {
  createSessionResolver,
  noteObservedUrl,
  observeMediaSrcChanges,
  observeSessionSelection,
  resetObservations,
} from './site/observations';
import type { SessionResolver } from './site/sessionResolve';
import { extractCourIdFromMediaUrlWithEvidence } from './site/sessionResolve';
import { mountUi } from './ui/mount';
import { pushToast } from './ui/components';
import {
  uiStore,
  type PanelTab,
  type UiActions,
} from './ui/store';

const log = createLogger('content');

const LIST_ROUTES = new Set(['home', 'list-video', 'list-live']);

interface CourseSyncResult {
  ok: boolean;
  skipped?: boolean;
  courses: number;
  sessions: number;
  error?: string;
}

interface ScheduleSyncResult {
  ok: boolean;
  count: number;
  skipped?: boolean;
  error?: string;
}

function readSessionNumber(key: string): number {
  try {
    const value = Number(sessionStorage.getItem(key) ?? 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** 从播放页顶栏读取教师名（站点接口偶尔不返回教师字段，但顶栏仍会展示） */
function parseTeacherNamesFromDom(): string[] {
  const root = document.querySelector(SELECTORS.playHeader);
  const text = root?.textContent ?? '';
  const matched = text.match(/(?:教\s*师|老\s*师)[：:]\s*([^·|｜/]+)/);
  if (!matched?.[1]) return [];
  const names = matched[1]
    .split(/[、，,；;/|]+/)
    .map((item) => item.trim())
    // 顶栏可能写成“教师：张三 第5周”，把后面的周次/节次片段剔除
    .filter((item) => item.length > 0 && item.length <= 30 && !/^第?\d+(?:[-–~至]\d+)?\s*[周节]/.test(item));
  return [...new Set(names)];
}

export default defineContentScript({
  // 生产只匹配两个主站源；开发模式额外匹配本地 fixture（e2e）。
  matches: [
    `${SITE_ORIGINS.campus}/*`,
    `${SITE_ORIGINS.webvpn}/*`,
    ...(import.meta.env.DEV ? ['http://127.0.0.1/*', 'http://localhost/*'] : []),
  ],
  runAt: 'document_idle',
  allFrames: false,
  async main(ctx) {
    let settings = await loadSettings();
    const controller = new ContentController(settings);
    uiStore.bindActions(controller.actions);
    uiStore.patch({ settings, site: detectSite(), route: parseRoute() });
    const unmount = mountUi();
    controller.start();

    const offSettings = onSettingsChanged((next) => {
      settings = next;
      controller.applySettings(next);
    });

    ctx.onInvalidated(() => {
      offSettings();
      controller.dispose();
      unmount();
    });
  },
});

class ContentController {
  private settings: AppSettings;
  private route: RouteInfo = parseRoute();
  private player: PlayerHandle | null = null;
  private resolver: SessionResolver | null = null;
  private meta: SessionMeta | null = null;
  private candidates: SessionListItem[] = [];
  private globalCleanups: Array<() => void> = [];
  private pageCleanups: Array<() => void> = [];
  private globalIntervals: number[] = [];
  private pageIntervals: number[] = [];
  private pageTimeouts: number[] = [];
  private disposed = false;
  private resolving = false;
  private pendingResolve = false;
  private loadToken = 0;
  private lastHash = location.hash;
  private lastTickAt = 0;
  private lastInteractionAt = Date.now();
  private lastSummaryAt = 0;
  private followBusy = false;
  private rectCache = { video: '', timeline: '' };
  private offBackgroundEvent: (() => void) | null = null;
  private offPageMessage: (() => void) | null = null;
  private courseSyncAt = 0;
  private courseSyncAttemptAt = 0;
  private courseSyncPromise: Promise<CourseSyncResult> | null = null;
  private scheduleSyncAt = 0;
  private scheduleSyncAttemptAt = 0;
  private scheduleSyncPromise: Promise<ScheduleSyncResult> | null = null;

  constructor(settings: AppSettings) {
    this.settings = settings;
  }

  start(): void {
    if (this.disposed) return;
    this.installGlobalListeners();
    void this.applyRoute();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardownPage();
    for (const timer of this.globalIntervals) window.clearInterval(timer);
    this.globalIntervals = [];
    for (const cleanup of this.globalCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* 忽略 */
      }
    }
    this.offBackgroundEvent?.();
    this.offPageMessage?.();
  }

  applySettings(next: AppSettings): void {
    this.settings = next;
    uiStore.patch({ settings: next });
    const play = isPlayRoute(uiStore.getState().route);
    if (!play) {
      const list = LIST_ROUTES.has(uiStore.getState().route.kind);
      if (list) {
        const open = next.ui.learningCenter && !uiStore.getState().centerSuppressed;
        uiStore.patch({ centerOpen: open });
        if (next.ui.learningCenter) void this.syncSiteCache();
      } else {
        uiStore.patch({ centerOpen: false });
      }
    } else if (next.ui.centerOnPlayPage && !uiStore.getState().centerOpen) {
      // 用户刚在设置里开启播放页侧栏：不强行弹出，仅记录偏好；面板顶部仍有入口
    }
  }

  // ───────────────────────── 全局监听 ─────────────────────────

  private installGlobalListeners(): void {
    const markInteraction = () => {
      this.lastInteractionAt = Date.now();
    };
    document.addEventListener('pointerdown', markInteraction, { capture: true, passive: true });
    document.addEventListener('keydown', markInteraction, { capture: true, passive: true });
    this.globalCleanups.push(() => {
      document.removeEventListener('pointerdown', markInteraction, { capture: true });
      document.removeEventListener('keydown', markInteraction, { capture: true });
    });

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void this.flushStats('hidden');
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.globalCleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

    // 快捷键（站点优先）：只在非输入态、无修饰键、且站点未 preventDefault 时响应。
    const onShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/i.test(target.tagName)) return;
      if (!isPlayRoute(uiStore.getState().route)) return;
      const key = event.key.toLowerCase();
      if (RESERVED_KEYS.has(key)) return;
      const shortcuts = this.settings.shortcuts;
      if (key === shortcuts.ask.toLowerCase()) {
        this.actions.setPanelOpen(true);
        this.actions.setPanelTab('qa');
      } else if (key === shortcuts.favorite.toLowerCase()) {
        void this.actions.addTimeFavorite();
      } else if (key === shortcuts.note.toLowerCase()) {
        this.actions.setPanelOpen(true);
        this.actions.setPanelTab('notes');
      } else if (key === shortcuts.prevTopic.toLowerCase()) {
        this.stepOutline(-1);
      } else if (key === shortcuts.nextTopic.toLowerCase()) {
        this.stepOutline(1);
      }
    };
    document.addEventListener('keydown', onShortcut);
    this.globalCleanups.push(() => document.removeEventListener('keydown', onShortcut));

    const onHash = () => {
      const hash = location.hash;
      if (hash === this.lastHash) return;
      this.lastHash = hash;
      void this.applyRoute();
    };
    window.addEventListener('hashchange', onHash);
    this.globalCleanups.push(() => window.removeEventListener('hashchange', onHash));

    const onResize = () => this.updateRects();
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('scroll', onResize, { passive: true, capture: true });
    this.globalCleanups.push(() => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, { capture: true });
    });

    const onPageHide = () => {
      void this.flushStats('hidden');
    };
    window.addEventListener('pagehide', onPageHide);
    this.globalCleanups.push(() => window.removeEventListener('pagehide', onPageHide));

    this.offBackgroundEvent = onBackgroundEvent((payload) => this.handleEvent(payload));
    this.offPageMessage = this.listenPageMessages();

    // 路由兜底检测（部分站点操作不触发 hashchange）
    const routeTimer = window.setInterval(() => {
      if (location.hash !== this.lastHash) {
        this.lastHash = location.hash;
        void this.applyRoute();
      }
      this.updateRects();
      this.syncFromPlayer();
    }, 1000);
    this.globalIntervals.push(routeTimer);
  }

  private listenPageMessages(): () => void {
    const chromeApi = (globalThis as unknown as { chrome?: typeof chrome }).chrome;
    if (!chromeApi?.runtime?.onMessage) return () => undefined;
    const listener = (raw: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (value?: unknown) => void) => {
      const message = raw as { type?: string; command?: string } | undefined;
      if (!message) return undefined;
      if (message.type === 'POPUP_OVERVIEW') {
        sendResponse({ type: 'POPUP_OVERVIEW_RESULT', overview: this.buildOverview() });
        return true;
      }
      if (message.type === 'UI_COMMAND') {
        if (message.command === 'openPanel') this.actions.setPanelOpen(true);
        else if (message.command === 'closePanel') this.actions.setPanelOpen(false);
        else if (message.command === 'togglePanel') this.actions.togglePanel();
        else if (message.command === 'openCenter') this.actions.openCenter();
        sendResponse({ ok: true });
        return true;
      }
      return undefined;
    };
    chromeApi.runtime.onMessage.addListener(listener);
    return () => chromeApi.runtime.onMessage.removeListener(listener);
  }

  // ───────────────────────── 路由 ─────────────────────────

  private async applyRoute(): Promise<void> {
    const next = parseRoute();
    this.lastHash = location.hash;
    this.teardownPage();
    this.route = next;
    this.meta = null;
    this.candidates = [];
    this.resolver = null;
    this.player = null;
    this.rectCache = { video: '', timeline: '' };

    const play = isPlayRoute(next);
    const list = LIST_ROUTES.has(next.kind);
    const centerOpen = list && this.settings.ui.learningCenter && !uiStore.getState().centerSuppressed;
    uiStore.patch({
      ready: true,
      route: next,
      site: detectSite(),
      session: null,
      resolution: { phase: play ? 'resolving' : 'idle' },
      currentTime: 0,
      duration: 0,
      paused: true,
      watchedSec: 0,
      watchRatio: 0,
      transcript: null,
      job: null,
      ai: null,
      aiStale: false,
      chats: [],
      notes: [],
      favorites: [],
      siteNotes: [],
      siteCollected: false,
      activeGroupId: undefined,
      streamingChatId: undefined,
      videoRect: null,
      timelineRect: null,
      panelOpen: false,
      centerOpen,
      centerView: uiStore.getState().centerView,
      busy: { session: false, transcript: false, ai: false, ask: false, capture: false },
      transcriptSearch: { query: '', results: [], loading: false },
    });

    void this.sendPageContext();

    if (play) {
      await this.initPlayPage();
    } else {
      if (list) void this.syncSiteCache();
      if (next.kind === 'my-schedule') void this.syncSchedule();
    }
  }

  private teardownPage(): void {
    const courId = uiStore.getState().session?.courId;
    if (courId) void this.flushStats('switch');
    for (const timer of this.pageIntervals) window.clearInterval(timer);
    for (const timer of this.pageTimeouts) window.clearTimeout(timer);
    this.pageIntervals = [];
    this.pageTimeouts = [];
    for (const cleanup of this.pageCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* 忽略 */
      }
    }
    this.player?.destroy();
    this.player = null;
    this.resolver = null;
    this.followBusy = false;
    resetObservations();
  }

  // ───────────────────────── 非播放页 ─────────────────────────

  /**
   * 从站点只读同步课程墙与课次。
   *
   * 节流规则：只在**成功**后记录时间戳（15 分钟内不重复同步）。
   * 旧实现先把时间戳写进 sessionStorage 再请求，首次请求失败（例如刚登录、
   * 站点接口尚未就绪）会把后续 15 分钟的自动重试全部挡掉，表现为“我的课程一直为空”。
   */
  private async syncSiteCache(force = false): Promise<CourseSyncResult> {
    const empty = { courses: 0, sessions: 0 };
    if (this.disposed) return { ok: false, skipped: true, ...empty };
    if (this.courseSyncPromise) return this.courseSyncPromise;

    const now = Date.now();
    // v2 键：旧实现会在**请求前**写入时间戳（失败也被计入节流），换键避免继承那次失败的节流。
    const lastSuccessAt = Math.max(this.courseSyncAt, readSessionNumber('hdu.courseSyncAt.v2'));
    if (!force && now - lastSuccessAt < 15 * 60_000) {
      return { ok: true, skipped: true, ...empty };
    }
    // 失败后的短冷却：避免用户在列表页频繁切换筛选时连续打站点接口
    if (!force && now - this.courseSyncAttemptAt < 30_000) {
      return { ok: false, skipped: true, ...empty };
    }
    this.courseSyncAttemptAt = now;

    const run = (async (): Promise<CourseSyncResult> => {
      try {
        const courses = await this.fetchAllCourseWall();
        const picked = courses.filter((c) => c.teclId > 0);
        let courseCount = 0;
        let sessionCount = 0;
        for (const item of picked) {
          // 课程墙接口经常不返回教师字段：先看课次行，最后用教学班详情补一次（只在缺失时请求）
          const sessions = await fetchSessionList(item.teclId).catch(() => []);
          let teacherNames =
            item.teacherNames.length > 0
              ? item.teacherNames
              : (sessions.find((s) => (s.teacherNames?.length ?? 0) > 0)?.teacherNames ?? []);
          if (teacherNames.length === 0) {
            const info = await fetchTeachingClass(item.teclId).catch(() => null);
            if (info?.teacherNames.length) teacherNames = info.teacherNames;
          }
          const course: CourseEntity = {
            teclId: item.teclId,
            subjName: item.subjName || `教学班 ${item.teclId}`,
            subjCode: item.subjCode,
            teacherNames,
            clroName: item.clroName,
            teclCode: item.teclCode,
            coverUrl: item.coverUrl,
            updatedAt: Date.now(),
          };
          try {
            await callOp('course.upsert', { course });
            courseCount += 1;
          } catch (err) {
            log.warn('课程写入失败', { teclId: item.teclId, detail: toAppError(err).detail });
            continue;
          }
          for (const s of sessions.slice(0, 80)) {
            if (!s.courId || !s.beginTime) continue;
            try {
              await callOp('session.patch', {
                courId: s.courId,
                patch: {
                  teclId: item.teclId,
                  beginTime: new Date(s.beginTime).toISOString(),
                  endTime: new Date(s.endTime).toISOString(),
                  letiNumber: s.letiNumber,
                  letyName: s.letyName,
                  courseName: item.subjName,
                  courLabel: buildCourLabel({ beginTime: s.beginTime, letiNumber: s.letiNumber, clroName: s.clroName }),
                },
              });
              sessionCount += 1;
            } catch (err) {
              log.debug('课次写入失败', { courId: s.courId, detail: toAppError(err).detail });
            }
          }
        }
        await this.syncSchedule();
        uiStore.patch({ centerDataVersion: uiStore.getState().centerDataVersion + 1 });
        if (picked.length > 0 && courseCount === 0) {
          return { ok: false, courses: 0, sessions: sessionCount, error: '课程数据写入本地失败' };
        }
        this.courseSyncAt = Date.now();
        try {
          sessionStorage.setItem('hdu.courseSyncAt.v2', String(this.courseSyncAt));
        } catch {
          /* 隐私模式忽略 */
        }
        return { ok: true, courses: courseCount, sessions: sessionCount };
      } catch (err) {
        const appErr = toAppError(err, 'SITE_API_FAILED');
        log.warn('课程同步失败', { code: appErr.code, detail: appErr.detail });
        return { ok: false, courses: 0, sessions: 0, error: appErr.userMessage };
      }
    })();

    this.courseSyncPromise = run;
    try {
      return await run;
    } finally {
      if (this.courseSyncPromise === run) this.courseSyncPromise = null;
    }
  }

  /** 拉取课程墙全部分页（站点忽略分页时自动停止）。 */
  private async fetchAllCourseWall(): Promise<CourseListItem[]> {
    // 站点页面自身使用 pageSize=15，沿用该值以避免服务端对页大小设限
    const pageSize = 15;
    const maxPages = 10;
    const collected = new Map<number, CourseListItem>();
    for (let page = 1; page <= maxPages; page += 1) {
      let batch: CourseListItem[];
      try {
        batch = await fetchCourseWall(pageSize, page);
      } catch (err) {
        // 首页失败视为同步失败（用于提示用户）；后续分页失败则保留已取到的课程
        if (page === 1) throw err;
        log.warn('课程墙后续分页拉取失败', { page, detail: toAppError(err).detail });
        break;
      }
      if (batch.length === 0) break;
      let added = 0;
      for (const item of batch) {
        if (item.teclId > 0 && !collected.has(item.teclId)) {
          collected.set(item.teclId, item);
          added += 1;
        }
      }
      // 站点忽略 pageIndex 时会重复返回第一页：没有新增就停止
      if (added === 0) break;
    }
    return [...collected.values()];
  }

  private async syncSchedule(force = false): Promise<ScheduleSyncResult> {
    if (this.scheduleSyncPromise) return this.scheduleSyncPromise;

    const nowMs = Date.now();
    const lastSuccessAt = Math.max(this.scheduleSyncAt, readSessionNumber('hdu.scheduleSyncAt.v1'));
    if (!force && lastSuccessAt > 0 && nowMs - lastSuccessAt < 5 * 60_000) {
      return { ok: true, count: 0, skipped: true };
    }
    if (!force && this.scheduleSyncAttemptAt > 0 && nowMs - this.scheduleSyncAttemptAt < 30_000) {
      return { ok: true, count: 0, skipped: true };
    }
    this.scheduleSyncAttemptAt = nowMs;

    const promise = (async (): Promise<ScheduleSyncResult> => {
      const weekStart = startOfLocalWeek();
      const weekEnd = weekStart + 7 * 86_400_000 - 1;
      const now = new Date();
      let years: TermYear[] = [];
      let termYearsError: unknown = null;
      try {
        years = await fetchTermYears({ strict: true });
      } catch (err) {
        termYearsError = err;
        log.warn('学期字典读取失败，回退 acteId=9', toAppError(err).detail);
      }
      // 站点 termYear 自带 currentTerm；没有时按“当前时间落在区间内 → 最近开学 → 最大 id”排序
      const ordered = orderTermYearsForSchedule(years, now.getTime());
      const candidates: TermYear[] = [];
      for (const year of ordered) {
        if (String(year.acteId).trim() === '') continue;
        if (candidates.some((item) => String(item.acteId) === String(year.acteId))) continue;
        candidates.push(year);
        if (candidates.length >= 6) break;
      }
      if (candidates.length === 0) candidates.push({ acteId: 9, name: '' });
      log.info('课表学期候选', {
        candidates: candidates.map((item) => ({
          acteId: item.acteId,
          name: item.name,
          current: item.currentTerm === true,
          begin: item.beginTime ? new Date(item.beginTime).toISOString() : undefined,
          end: item.endTime ? new Date(item.endTime).toISOString() : undefined,
        })),
        termYearsError: termYearsError ? toAppError(termYearsError).detail : undefined,
      });

      // 站点实测使用 "YYYY-MM-DD HH:mm:ss"；毫秒时间戳与纯日期作为兼容兜底
      const attempted: string[] = [];
      let lastError: unknown = termYearsError;
      let emptyResponse = false;
      for (const format of ['datetime', 'date', 'ms'] as const) {
        for (const candidate of candidates) {
          const label = `${candidate.acteId}/${format}`;
          attempted.push(label);
          try {
            const items = await fetchCurriculum(candidate.acteId, weekStart, weekEnd, format, {
              strict: true,
            });
            if (items.length === 0) {
              // 接口成功但本周确实没课：这是有效结果，不再拿旧快照臆断
              emptyResponse = true;
              continue;
            }
            await callOp('schedule.put', { items, termYear: candidate.name || undefined });
            uiStore.patch({ centerDataVersion: uiStore.getState().centerDataVersion + 1 });
            this.scheduleSyncAt = Date.now();
            try {
              sessionStorage.setItem('hdu.scheduleSyncAt.v1', String(this.scheduleSyncAt));
            } catch {
              /* 隐私模式忽略 */
            }
            log.info('课表同步完成', {
              acteId: candidate.acteId,
              termYear: candidate.name,
              format,
              count: items.length,
            });
            return { ok: true, count: items.length };
          } catch (err) {
            lastError = err;
            log.warn('课表请求失败', {
              acteId: candidate.acteId,
              termYear: candidate.name,
              format,
              detail: toAppError(err).detail,
            });
          }
        }
      }
      if (lastError && !emptyResponse) {
        const appErr = toAppError(lastError, 'SITE_API_FAILED');
        log.warn('课表同步失败', { code: appErr.code, detail: appErr.detail, attempted });
        return { ok: false, count: 0, error: appErr.userMessage };
      }
      // 接口正常但本周确实没课时也会返回空：保留旧快照，只记录诊断信息
      log.warn('本周课表未取得数据', {
        weekStart: new Date(weekStart).toISOString(),
        attempted,
      });
      return { ok: true, count: 0 };
    })().catch((err) => {
      const appErr = toAppError(err, 'SITE_API_FAILED');
      log.warn('课表同步失败', { code: appErr.code, detail: appErr.detail });
      return { ok: false, count: 0, error: appErr.userMessage };
    });

    this.scheduleSyncPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.scheduleSyncPromise === promise) this.scheduleSyncPromise = null;
    }
  }

  // ───────────────────────── 播放页 ─────────────────────────

  private async initPlayPage(): Promise<void> {
    const player = createPlayerHandle();
    this.player = player;
    this.resolver = createSessionResolver(this.route, player, { allowUnverified: true });

    uiStore.patch({ panelOpen: !this.settings.ui.panelCollapsed, centerOpen: this.settings.ui.centerOnPlayPage, centerSuppressed: false });

    const playerEvents = ['timeupdate', 'play', 'pause', 'seeking', 'seeked', 'ratechange', 'loadedmetadata', 'durationchange', 'ended', 'canplay'] as const;
    for (const event of playerEvents) {
      this.pageCleanups.push(
        player.on(event, () => {
          this.syncFromPlayer();
          if (event === 'pause' || event === 'ended') void this.flushStats(event === 'ended' ? 'pause' : 'pause');
          if (event === 'seeking' || event === 'play') this.lastInteractionAt = Date.now();
          if ((event === 'loadedmetadata' || event === 'canplay') && !this.meta) {
            void this.resolveAndLoad('player-ready');
          }
          if (event === 'loadedmetadata' || event === 'durationchange') this.updateRects();
        }),
      );
    }

    this.pageCleanups.push(
      observeMediaSrcChanges(
        (change) => {
          if (!change.isPrimary) return;
          if (change.src) {
            noteObservedUrl(change.src);
            this.resolver?.noteObservedUrl(change.src);
            // 站点内切换机位/课次后，手动选择不应继续压过实时证据
            this.resolver?.clearManual();
            void this.resolveAndLoad('media-change');
          }
        },
        { player, intervalMs: 1200 },
      ).disconnect,
    );

    this.pageCleanups.push(
      observeSessionSelection((change) => {
        if (change.selected) {
          this.resolver?.clearManual();
          void this.resolveAndLoad('selection');
        }
      }).disconnect,
    );

    this.pageCleanups.push(
      player.onViewsChanged(() => {
        this.updateRects();
        this.syncFromPlayer();
        if (!this.meta) void this.resolveAndLoad('views-changed');
      }),
    );

    void this.loadCandidates();
    this.updateRects();

    const tickTimer = window.setInterval(() => {
      this.syncFromPlayer();
      this.updateRects();
    }, 1000);
    this.pageIntervals.push(tickTimer);

    const followTimer = window.setInterval(() => void this.followTick(), 7000);
    this.pageIntervals.push(followTimer);

    if (this.settings.asr.autoWarmup) {
      void callOp('asr.warmup', {}).catch(() => undefined);
    }

    this.pageTimeouts.push(
      window.setTimeout(() => {
        void this.resolveAndLoad('initial');
      }, 700),
    );

    if (this.settings.asr.autoTranscribeOnOpen) {
      this.pageTimeouts.push(
        window.setTimeout(() => {
          const state = uiStore.getState();
          if (state.session) void this.actions.startTranscribe();
        }, 6000),
      );
    }
  }

  private async loadCandidates(): Promise<void> {
    const teclId = this.route.teclId;
    if (!teclId) return;
    const list = await fetchSessionList(teclId).catch(() => []);
    this.candidates = list;
    if (list.length > 0) {
      uiStore.patch({
        resolution: { ...uiStore.getState().resolution, candidates: list },
      });
    }
  }

  private async resolveAndLoad(reason: string): Promise<void> {
    if (!this.resolver || this.disposed) return;
    if (!isPlayRoute(parseRoute())) return;
    if (this.resolving) {
      this.pendingResolve = true;
      return;
    }
    this.resolving = true;
    const before = uiStore.getState().resolution;
    try {
      if (before.phase !== 'resolved') {
        uiStore.patch({ resolution: { ...before, phase: 'resolving' } });
      }
      const result = await this.resolver.resolve();
      if (!result) {
        await this.loadCandidates();
        uiStore.patch({
          resolution: { phase: 'unresolved', candidates: this.candidates },
        });
        return;
      }
      // 保护：站点若忽略了 URL 中的 courseId（play-center 深链契约未定），
      // 以正在播放的媒体文件为准，避免把统计/问答记到另一个课次。
      const mediaHint = extractCourIdFromMediaUrlWithEvidence(this.player?.currentViewUrl() ?? '');
      const effective =
        result.evidence === 'url' && mediaHint && mediaHint.courId !== result.courId
          ? {
              ...result,
              courId: mediaHint.courId,
              evidence: mediaHint.evidence,
              confidence: 'direct' as const,
            }
          : result;
      if (this.meta?.courId === effective.courId) {
        uiStore.patch({
          resolution: {
            phase: 'resolved',
            courId: effective.courId,
            evidence: effective.evidence,
            confidence: effective.confidence,
            candidates: this.candidates,
          },
        });
        return;
      }
      this.route = { ...this.route, courId: effective.courId };
      uiStore.patch({
        resolution: {
          phase: 'resolved',
          courId: effective.courId,
          evidence: effective.evidence,
          confidence: effective.confidence,
          candidates: this.candidates,
        },
      });
      log.info('课次已识别', { courId: effective.courId, evidence: effective.evidence, reason });
      await this.loadSession(effective.courId);
    } catch (err) {
      log.warn('课次识别失败', err);
      uiStore.patch({ resolution: { phase: 'unresolved', candidates: this.candidates } });
    } finally {
      this.resolving = false;
      if (this.pendingResolve) {
        this.pendingResolve = false;
        void this.resolveAndLoad('queued');
      }
    }
  }

  private async loadSession(courId: number): Promise<void> {
    const token = ++this.loadToken;
    uiStore.patch({ busy: { ...uiStore.getState().busy, session: true } });
    try {
      const data = await fetchPlayPageData(courId, this.route.teclId);
      if (token !== this.loadToken) return;
      const meta = data?.meta ?? this.fallbackMeta(courId);
      if (!meta) {
        uiStore.patch({ busy: { ...uiStore.getState().busy, session: false } });
        return;
      }
      // 接口未返回教师时，用播放页顶栏兜底，并在落库时补全课程教师
      if (meta.teacherNames.length === 0) {
        const fromDom = parseTeacherNamesFromDom();
        if (fromDom.length > 0) meta.teacherNames = fromDom;
      }
      const duration = this.player?.getDuration(meta.durationSec) || meta.durationSec;
      if (duration > 0) meta.durationSec = Math.round(duration);
      this.meta = meta;
      uiStore.patch({
        session: meta,
        siteCollected: data?.siteCollected ?? false,
        duration,
        busy: { ...uiStore.getState().busy, session: false },
      });
      void this.sendPageContext();
      void this.sendSessionMeta(meta);
      if (meta.teclId > 0) {
        await callOp('session.saveMeta', { meta }).catch((err) => log.debug('会话落库失败', err));
      }
      void this.loadRelated(courId, token);
      this.updateRects();
    } catch (err) {
      log.warn('课次元数据加载失败', err);
      uiStore.patch({ busy: { ...uiStore.getState().busy, session: false } });
    }
  }

  private fallbackMeta(courId: number): SessionMeta | null {
    const teclId = this.route.teclId ?? this.meta?.teclId ?? 0;
    if (!teclId) return null;
    const heading = document.querySelector('.play-header .course-title, .play-header .title, .play-header h1, .course-title');
    const courseName = heading?.textContent?.trim() || document.title.split(/[-–|]/)[0]?.trim() || `教学班 ${teclId}`;
    const durationSec = this.player?.getDuration() ?? 0;
    return {
      courId,
      teclId,
      courseName,
      teacherNames: parseTeacherNamesFromDom(),
      durationSec,
      views: [],
      courLabel: `课次 ${courId}`,
      lastPlayTime: undefined,
    };
  }

  private async loadRelated(courId: number, token: number): Promise<void> {
    const [transcript, ai, groups, favorites, notes, siteNotes, collected, summary, job] = await Promise.all([
      callOp('transcript.get', { courId }).catch(() => null),
      callOp('ai.get', { courId }).catch(() => ({ result: null, stale: false })),
      callOp('qa.groups', { courId }).catch(() => []),
      callOp('fav.list', { filter: { courId, limit: 200 } }).catch(() => []),
      callOp('note.list', { courId }).catch(() => []),
      fetchSiteNotes(courId).catch(() => [] as SiteNote[]),
      fetchSiteCollectionStatus(courId).catch(() => null),
      callOp('stats.sessionSummary', { courId }).catch(() => null),
      // 页面刷新后 SW 可能仍在转写：恢复作业状态，问答/速览才知道"字幕正在生成"
      callOp('asr.status', { courId }).catch(() => null),
    ]);
    if (token !== this.loadToken) return;
    const groupId = groups[0]?.groupId;
    const chats = groupId ? await callOp('qa.list', { courId, groupId }).catch(() => []) : [];
    if (token !== this.loadToken) return;
    uiStore.patch({
      transcript,
      ai: ai.result,
      aiStale: ai.stale,
      chats,
      activeGroupId: groupId,
      job,
      favorites,
      notes,
      siteNotes,
      siteCollected: collected ?? false,
      watchedSec: summary?.watchedSec ?? 0,
      watchRatio: summary?.watchRatio ?? 0,
    });
  }

  private syncFromPlayer(): void {
    const player = this.player;
    if (!player) return;
    const state = player.getState();
    const now = performance.now();
    const current = uiStore.getState();
    const duration = state.duration || current.duration;
    if (
      Math.abs(current.currentTime - state.currentTime) > 0.35 ||
      Math.abs(current.duration - duration) > 0.5 ||
      current.paused !== state.paused
    ) {
      uiStore.patch({
        currentTime: Number.isFinite(state.currentTime) ? state.currentTime : 0,
        duration: Number.isFinite(duration) ? duration : 0,
        paused: state.paused,
      });
    }
    if (now - this.lastTickAt < 500) return;
    this.lastTickAt = now;
    if (!current.session || state.paused || !Number.isFinite(state.duration) || state.duration <= 0) return;
    if (document.visibilityState !== 'visible') return;
    void callOp('stats.tick', {
      courId: current.session.courId,
      teclId: current.session.teclId,
      state: {
        currentTime: state.currentTime,
        duration: state.duration,
        paused: state.paused,
        rate: state.rate,
      },
      visible: true,
      focused: document.hasFocus(),
      interacted: Date.now() - this.lastInteractionAt < 2 * 60_000,
    }).catch(() => undefined);

    if (Date.now() - this.lastSummaryAt > 30_000) {
      this.lastSummaryAt = Date.now();
      void callOp('stats.sessionSummary', { courId: current.session.courId })
        .then((summary) => uiStore.patch({ watchedSec: summary.watchedSec, watchRatio: summary.watchRatio }))
        .catch(() => undefined);
    }
  }

  private stepOutline(direction: -1 | 1): void {
    const outline = uiStore.getState().ai?.outline;
    if (!outline || outline.length === 0) return;
    const time = uiStore.getState().currentTime;
    const ordered = [...outline].sort((a, b) => a.start - b.start);
    let current = -1;
    for (let i = 0; i < ordered.length; i += 1) {
      if ((ordered[i]?.start ?? 0) <= time) current = i;
    }
    const next = ordered[Math.max(0, Math.min(ordered.length - 1, current + direction))];
    if (next) this.actions.seek(next.start);
  }

  private updateRects(): void {    const player = this.player;
    if (!player) return;
    const video = player.getPrimary();
    if (video) {
      const r = video.getBoundingClientRect();
      const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
      if (key !== this.rectCache.video && r.width > 0 && r.height > 0) {
        this.rectCache.video = key;
        uiStore.patch({ videoRect: { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom } });
      }
    }
    const bar = document.querySelector(SELECTORS.progressBar);
    if (bar) {
      const r = bar.getBoundingClientRect();
      const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
      if (key !== this.rectCache.timeline && r.width > 0) {
        this.rectCache.timeline = key;
        uiStore.patch({ timelineRect: { left: r.left, top: r.top, width: r.width, height: r.height } });
      }
    }
  }

  // ───────────────────────── 新鲜直链 / 转写 ─────────────────────────

  private async freshAudio(viewNum: number): Promise<{ url: string; viewNum: number; durationSec: number } | null> {
    const courId = uiStore.getState().session?.courId;
    if (!courId) return null;
    const info = await fetchCourseVodUrls(courId).catch(() => null);
    if (!info) return null;
    const views: VodView[] = info.meta.views;
    const currentSrc = this.player?.currentViewUrl() ?? '';
    const chosen =
      views.find((view) => view.viewNum === viewNum) ??
      views.find((view) => view.url && currentSrc && view.url.split('?')[0] === currentSrc.split('?')[0]) ??
      views[0];
    if (!chosen?.url) return null;
    return {
      url: chosen.url,
      viewNum: chosen.viewNum ?? viewNum,
      durationSec: this.player?.getDuration(info.meta.durationSec) || info.meta.durationSec,
    };
  }

  private async followTick(): Promise<void> {
    const state = uiStore.getState();
    if (!state.session || !this.player) return;
    if (this.settings.asr.windowMode !== 'around' || !this.settings.asr.streamFollow) return;
    if (this.followBusy) return;
    this.followBusy = true;
    try {
      const viewNum = this.player.currentViewIndex(this.meta?.views);
      const decision = await callOp('asr.follow', {
        courId: state.session.courId,
        viewNum,
        aroundSec: state.currentTime,
        durationSec: state.duration,
        teclId: state.session.teclId,
        paused: state.paused,
        visible: document.visibilityState === 'visible',
        sessionId: `${state.session.courId}:${viewNum}`,
      });
      if (!decision.start) return;
      const fresh = await this.freshAudio(viewNum);
      if (!fresh) return;
      const { job } = await callOp('asr.start', {
        courId: state.session.courId,
        viewNum: fresh.viewNum,
        teclId: state.session.teclId,
        audioUrl: fresh.url,
        durationSec: fresh.durationSec,
        aroundSec: state.currentTime,
        windowMode: 'around',
        auto: true,
      });
      uiStore.patch({ job });
    } catch (err) {
      log.debug('自动跟进失败（静默退避）', err);
    } finally {
      this.followBusy = false;
    }
  }

  private async flushStats(reason: 'pause' | 'hidden' | 'switch' | 'flush'): Promise<void> {
    const courId = uiStore.getState().session?.courId;
    if (!courId) return;
    await callOp('stats.flush', { courId }).catch(() => undefined);
    log.debug('统计已结算', { reason, courId });
  }

  // ───────────────────────── 事件 ─────────────────────────

  private currentCourId(): number | undefined {
    return uiStore.getState().session?.courId ?? uiStore.getState().resolution.courId;
  }

  private handleEvent(payload: EventPayload): void {
    const state = uiStore.getState();
    switch (payload.name) {
      case 'ASR_PROGRESS': {
        if (payload.data.courId !== this.currentCourId()) return;
        uiStore.patch({ job: payload.data.job });
        return;
      }
      case 'ASR_SEGMENTS': {
        if (payload.data.courId !== this.currentCourId()) return;
        void callOp('transcript.get', { courId: payload.data.courId })
          .then((transcript) => uiStore.patch({ transcript }))
          .catch(() => undefined);
        return;
      }
      case 'ASR_DONE': {
        if (payload.data.courId !== this.currentCourId()) return;
        void callOp('asr.status', { courId: payload.data.courId })
          .then((job) => uiStore.patch({ job }))
          .catch(() => undefined);
        void callOp('transcript.get', { courId: payload.data.courId })
          .then((transcript) => uiStore.patch({ transcript }))
          .catch(() => undefined);
        if (!payload.data.auto) pushToast('本节字幕已更新', 'success');
        return;
      }
      case 'ASR_FAILED': {
        if (payload.data.courId !== this.currentCourId()) return;
        if (!payload.data.auto) pushToast(payload.data.error.userMessage, 'error');
        void callOp('asr.status', { courId: payload.data.courId })
          .then((job) => uiStore.patch({ job }))
          .catch(() => undefined);
        return;
      }
      case 'AI_PROGRESS': {
        if (payload.data.courId !== this.currentCourId()) return;
        uiStore.patch({ busy: { ...state.busy, ai: true } });
        return;
      }
      case 'AI_DONE': {
        if (payload.data.courId !== this.currentCourId()) return;
        void callOp('ai.get', { courId: payload.data.courId })
          .then((ai) => uiStore.patch({ ai: ai.result, aiStale: ai.stale, busy: { ...uiStore.getState().busy, ai: false } }))
          .catch(() => undefined);
        pushToast(payload.data.result.cached ? '已载入缓存的标注' : '知识标注已生成', 'success');
        return;
      }
      case 'AI_FAILED': {
        if (payload.data.courId !== this.currentCourId()) return;
        uiStore.patch({ busy: { ...uiStore.getState().busy, ai: false } });
        pushToast(payload.data.error.userMessage, 'error');
        return;
      }
      case 'QA_DELTA': {
        if (payload.data.groupId !== state.activeGroupId && state.activeGroupId) return;
        const existing = state.chats.find((chat) => chat.id === payload.data.chatId);
        const next: ChatMessageEntity = existing
          ? { ...existing, content: `${existing.content}${payload.data.text}`, status: 'streaming' }
          : {
              id: payload.data.chatId,
              courId: state.session?.courId ?? 0,
              groupId: payload.data.groupId,
              role: 'ai',
              content: payload.data.text,
              status: 'streaming',
              createdAt: Date.now(),
            };
        uiStore.patch({
          chats: [...state.chats.filter((chat) => chat.id !== next.id), next],
          streamingChatId: payload.data.chatId,
          activeGroupId: payload.data.groupId,
          busy: { ...state.busy, ask: true },
        });
        return;
      }
      case 'QA_DONE': {
        const message = payload.data.message as ChatMessageEntity | undefined;
        if (message) {
          const chats = state.chats.filter((chat) => chat.id !== message.id && !(chat.role === 'ai' && chat.content === '' && chat.groupId === message.groupId));
          uiStore.patch({
            chats: [...chats, message],
            streamingChatId: undefined,
            busy: { ...state.busy, ask: false },
          });
        }
        return;
      }
      case 'QA_FAILED': {
        const chats = state.chats.map((chat) =>
          chat.id === payload.data.chatId ? { ...chat, status: 'failed' as const, error: payload.data.error.userMessage } : chat,
        );
        uiStore.patch({ chats, streamingChatId: undefined, busy: { ...state.busy, ask: false } });
        pushToast(payload.data.error.userMessage, 'error');
        return;
      }
      case 'MODEL_DONE': {
        pushToast('转写模型已就绪', 'success');
        return;
      }
      case 'MODEL_FAILED': {
        pushToast(payload.data.error.userMessage, 'error');
        return;
      }
      case 'SITE_SESSION_HINT': {
        if (!isPlayRoute(parseRoute())) return;
        noteObservedUrl(payload.data.url);
        this.resolver?.noteObservedUrl(payload.data.url);
        if (!uiStore.getState().session && uiStore.getState().resolution.phase !== 'resolving') {
          void this.resolveAndLoad('site-request');
        }
        return;
      }
      case 'UI_COMMAND': {
        if (payload.data.command === 'openPanel') this.actions.setPanelOpen(true);
        else if (payload.data.command === 'closePanel') this.actions.setPanelOpen(false);
        else if (payload.data.command === 'togglePanel') this.actions.togglePanel();
        else if (payload.data.command === 'openCenter') this.actions.openCenter();
        else if (payload.data.command === 'toast' && payload.data.message) pushToast(payload.data.message, payload.data.level ?? 'info');
        return;
      }
      default:
        return;
    }
  }

  // ───────────────────────── 消息 ─────────────────────────

  private async sendPageContext(): Promise<void> {
    try {
      await chrome.runtime.sendMessage({
        type: 'PAGE_CONTEXT',
        requestId: uuid(),
        context: { site: detectSite(), route: this.route, url: location.href },
      });
    } catch {
      /* 扩展重载时忽略 */
    }
  }

  private async sendSessionMeta(meta: SessionMeta): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: 'SESSION_META', requestId: uuid(), meta });
    } catch {
      /* 忽略 */
    }
  }

  private buildOverview(): unknown {
    const state = uiStore.getState();
    return {
      session: state.session,
      transcript: state.transcript
        ? {
            exists: state.transcript.segments.length > 0,
            partial: state.transcript.partial ?? false,
            coveredSec: state.transcript.coveredSec ?? 0,
          }
        : null,
      ai: state.ai
        ? { exists: true, stale: state.aiStale, topicCount: state.ai.topics.length }
        : { exists: false, stale: false, topicCount: 0 },
      job: state.job,
      watchedSec: state.watchedSec,
      watchRatio: state.watchRatio,
      pageKind: state.route.kind,
    };
  }

  // ───────────────────────── 动作实现 ─────────────────────────

  readonly actions: UiActions = {
    seek: (seconds) => {
      this.lastInteractionAt = Date.now();
      this.player?.seek(seconds);
      uiStore.patch({ currentTime: seconds });
    },
    togglePlay: () => {
      const video = this.player?.getPrimary();
      if (!video) return;
      this.lastInteractionAt = Date.now();
      if (video.paused) void video.play().catch(() => undefined);
      else video.pause();
    },
    setPanelOpen: (open) => {
      uiStore.patch({ panelOpen: open });
      this.persistPanelPreference(open);
      void this.sendPanelState(open);
    },
    togglePanel: () => {
      const open = !uiStore.getState().panelOpen;
      uiStore.patch({ panelOpen: open });
      this.persistPanelPreference(open);
      void this.sendPanelState(open);
    },
    setPanelTab: (tab: PanelTab) => uiStore.patch({ panelTab: tab }),
    openCourPicker: () => uiStore.patch({ courPickerOpen: true }),
    closeCourPicker: () => uiStore.patch({ courPickerOpen: false }),
    openCenter: (view) =>
      uiStore.patch({
        centerOpen: true,
        centerSuppressed: false,
        ...(view ? { centerView: view } : {}),
      }),
    closeCenter: () => uiStore.patch({ centerOpen: false }),
    setCenterView: (centerView) => uiStore.patch({ centerView }),
    suppressCenter: () => uiStore.patch({ centerSuppressed: true, centerOpen: false }),
    restoreCenter: () => uiStore.patch({ centerSuppressed: false, centerOpen: true }),
    refresh: async () => {
      const state = uiStore.getState();
      if (state.session) await this.loadRelated(state.session.courId, this.loadToken);
      const job = state.session ? await callOp('asr.status', { courId: state.session.courId }).catch(() => null) : null;
      uiStore.patch({ job });
    },
    syncCourses: async (opts) => {
      const result = await this.syncSiteCache(opts?.force ?? true);
      if (result.skipped) return;
      if (result.ok) {
        if (!opts?.quiet) {
          pushToast(
            result.courses > 0
              ? `已同步 ${result.courses} 门课程、${result.sessions} 节课`
              : '同步完成：站点暂无可同步的课程',
            'success',
          );
        }
        return;
      }
      pushToast(`课程同步失败：${result.error ?? '请在站点登录后重试'}`, 'error');
    },
    syncSchedule: async (opts) => {
      const result = await this.syncSchedule(opts?.force ?? true);
      if (result.skipped) return;
      if (result.ok) {
        if (!opts?.quiet) {
          pushToast(
            result.count > 0 ? `已同步本周 ${result.count} 节课` : '本周暂无课程安排（或站点尚未开放课表）',
            result.count > 0 ? 'success' : 'info',
          );
        }
        return;
      }
      pushToast(`课表同步失败：${result.error ?? '请稍后重试'}`, 'error');
    },
    reloadSession: async () => {
      const courId = uiStore.getState().session?.courId;
      if (courId) await this.loadSession(courId);
    },
    selectCour: async (courId) => {
      this.resolver?.setManual(courId);
      this.route = { ...this.route, courId };
      uiStore.patch({
        resolution: {
          phase: 'resolved',
          courId,
          evidence: 'manual',
          confidence: 'direct',
          candidates: this.candidates,
        },
      });
      await this.loadSession(courId);
    },
    startTranscribe: async (opts) => {
      const state = uiStore.getState();
      if (!state.session) {
        pushToast('请先识别当前课次', 'error');
        return;
      }
      uiStore.patch({ busy: { ...state.busy, transcript: true } });
      try {
        const viewNum = this.player?.currentViewIndex(this.meta?.views) ?? 1;
        const fresh = await this.freshAudio(viewNum);
        if (!fresh) throw new Error('未能获取视频直链，请稍后重试');
        const { job } = await callOp('asr.start', {
          courId: state.session.courId,
          viewNum: fresh.viewNum,
          teclId: state.session.teclId,
          audioUrl: fresh.url,
          durationSec: fresh.durationSec || state.duration,
          aroundSec: state.currentTime,
          windowMode: opts?.windowMode,
          force: opts?.force,
          auto: false,
        });
        uiStore.patch({ job });
        pushToast('已开始转写，进度会显示在面板中', 'info');
      } catch (err) {
        pushToast(err instanceof Error ? err.message : '转写启动失败', 'error');
      } finally {
        uiStore.patch({ busy: { ...uiStore.getState().busy, transcript: false } });
      }
    },
    cancelTranscribe: async () => {
      const courId = uiStore.getState().session?.courId;
      if (!courId) return;
      const { job } = await callOp('asr.control', { courId, action: 'cancel' });
      // 取消整段作业会清掉未完成的转写：同步刷新，避免面板还显示已删除的字幕
      const transcript = await callOp('transcript.get', { courId }).catch(() => null);
      uiStore.patch({ job, transcript });
      pushToast('已停止本轮转写', 'info');
    },
    generateAi: async (force) => {
      const state = uiStore.getState();
      if (!state.session) return;
      if (!state.transcript || state.transcript.segments.length === 0) {
        pushToast('需要先生成字幕', 'warn');
        return;
      }
      uiStore.patch({ busy: { ...state.busy, ai: true } });
      try {
        const result = await callOp('ai.generate', { courId: state.session.courId, force });
        if (!result.started) {
          uiStore.patch({ busy: { ...uiStore.getState().busy, ai: false } });
          pushToast(result.reason === 'busy' ? '已有生成任务在进行' : '暂时无法生成', 'warn');
        }
      } catch (err) {
        uiStore.patch({ busy: { ...uiStore.getState().busy, ai: false } });
        pushToast(err instanceof Error ? err.message : '生成失败', 'error');
      }
    },
    ask: async (question) => {
      const state = uiStore.getState();
      if (!state.session) return;
      if (!question.trim()) return;
      const anchorTime = Math.floor(state.currentTime);
      uiStore.patch({ busy: { ...state.busy, ask: true } });
      try {
        const result = await callOp('qa.ask', {
          courId: state.session.courId,
          question: question.trim(),
          anchorTime,
          groupId: state.activeGroupId,
          windowPreset: this.settings.contextWindow,
        });
        const chats = await callOp('qa.list', { courId: state.session.courId, groupId: result.groupId }).catch(() => []);
        // 与事件推送合并：qa.list 可能读到"流式占位"，而 QA_DONE 已经把它改成终态
        const merged = new Map<string, ChatMessageEntity>();
        if (result.groupId === state.activeGroupId) {
          for (const chat of uiStore.getState().chats) merged.set(chat.id, chat);
        }
        for (const chat of chats) {
          const existing = merged.get(chat.id);
          if (existing && existing.status !== 'streaming' && chat.status === 'streaming') continue;
          merged.set(chat.id, chat);
        }
        const nextChats = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
        const streaming = nextChats.some((chat) => chat.id === result.chatId && chat.status === 'streaming');
        uiStore.patch({
          activeGroupId: result.groupId,
          chats: nextChats,
          streamingChatId: streaming ? result.chatId : undefined,
          ...(result.immediate ? { busy: { ...uiStore.getState().busy, ask: false } } : {}),
        });
      } catch (err) {
        uiStore.patch({ busy: { ...state.busy, ask: false } });
        pushToast(err instanceof Error ? err.message : '提问失败', 'error');
      }
    },
    abortAsk: async (chatId) => {
      await callOp('qa.abort', { chatId }).catch(() => undefined);
      uiStore.patch({ streamingChatId: undefined, busy: { ...uiStore.getState().busy, ask: false } });
    },
    newChatGroup: () => uiStore.patch({ activeGroupId: undefined, chats: [], streamingChatId: undefined }),
    addNote: async (text, atSec) => {
      const state = uiStore.getState();
      if (!state.session) return;
      const now = Date.now();
      const note: NoteEntity = {
        id: uuid(),
        courId: state.session.courId,
        teclId: state.session.teclId,
        anchorTime: Math.floor(atSec),
        text: text.trim(),
        createdAt: now,
        updatedAt: now,
      };
      await callOp('note.put', { note });
      const notes = await callOp('note.list', { courId: state.session.courId }).catch(() => state.notes);
      uiStore.patch({ notes });
      this.lastInteractionAt = Date.now();
    },
    deleteNote: async (id) => {
      await callOp('note.softDelete', { id });
      const courId = uiStore.getState().session?.courId;
      if (courId) uiStore.patch({ notes: await callOp('note.list', { courId }).catch(() => []) });
    },
    convertNote: async (id) => {
      await callOp('note.toFavorite', { id });
      const courId = uiStore.getState().session?.courId;
      if (courId) uiStore.patch({ favorites: await callOp('fav.list', { filter: { courId, limit: 200 } }).catch(() => []) });
      pushToast('已转为收藏', 'success');
    },
    addTimeFavorite: async () => {
      const state = uiStore.getState();
      if (!state.session) return;
      const now = Date.now();
      const favorite: FavoriteEntity = {
        id: uuid(),
        type: 'time',
        snapshot: {
          title: `${state.session.courseName} · ${formatClock(state.currentTime)}`,
          content: `${state.session.courLabel} 的时间点 ${formatClock(state.currentTime)}`,
        },
        teclId: state.session.teclId,
        courId: state.session.courId,
        anchorTime: Math.floor(state.currentTime),
        folderId: null,
        tags: [],
        pinned: false,
        favoritedAt: now,
        updatedAt: now,
      };
      await callOp('fav.put', { favorite });
      const favorites = await callOp('fav.list', { filter: { courId: state.session.courId, limit: 200 } }).catch(() => state.favorites);
      uiStore.patch({ favorites });
      pushToast('已收藏当前时间点', 'success');
      this.lastInteractionAt = Date.now();
    },
    favoriteChat: async (chatId) => {
      const state = uiStore.getState();
      const chat = state.chats.find((item) => item.id === chatId);
      if (!chat || !state.session) return;
      const now = Date.now();
      const favorite: FavoriteEntity = {
        id: uuid(),
        type: 'ai',
        refId: chat.id,
        snapshot: { title: summarize(chat.content, 36), content: chat.content },
        teclId: state.session.teclId,
        courId: state.session.courId,
        anchorTime: chat.anchorTime,
        folderId: null,
        tags: [],
        pinned: false,
        favoritedAt: now,
        updatedAt: now,
      };
      await callOp('fav.put', { favorite });
      const favorites = await callOp('fav.list', { filter: { courId: state.session.courId, limit: 200 } }).catch(() => state.favorites);
      uiStore.patch({ favorites });
      pushToast('回答已收藏到知识库', 'success');
    },
    favoriteOutline: async (index) => {
      const state = uiStore.getState();
      const node = state.ai?.outline[index];
      if (!node || !state.session) return;
      const now = Date.now();
      const favorite: FavoriteEntity = {
        id: uuid(),
        type: 'outline',
        snapshot: { title: node.title, content: `${formatClock(node.start)}–${formatClock(node.end)}` },
        teclId: state.session.teclId,
        courId: state.session.courId,
        anchorTime: node.start,
        folderId: null,
        tags: [],
        pinned: false,
        favoritedAt: now,
        updatedAt: now,
      };
      await callOp('fav.put', { favorite });
      pushToast('大纲节点已收藏', 'success');
    },
    capture: async () => {
      const state = uiStore.getState();
      if (!state.session) return;
      const viewNum = this.player?.currentViewIndex(this.meta?.views) ?? 1;
      uiStore.patch({ busy: { ...state.busy, capture: true } });
      try {
        const fresh = await this.freshAudio(viewNum);
        if (!fresh) throw new Error('未能获取视频直链');
        const result = await callOp(
          'shot.capture',
          {
            courId: state.session.courId,
            teclId: state.session.teclId,
            view: fresh.viewNum,
            atSec: Math.floor(state.currentTime),
            url: fresh.url,
            meta: {
              courseName: state.session.courseName,
              courLabel: state.session.courLabel,
              anchorTime: Math.floor(state.currentTime),
              watermark: this.settings.screenshotWatermark,
            },
            watermark: this.settings.screenshotWatermark,
          },
          { timeoutMs: 90_000 },
        );
        pushToast(`截图已保存（${result.width}×${result.height}）`, 'success');
      } catch (err) {
        pushToast(err instanceof Error ? err.message : '截图失败', 'error');
      } finally {
        uiStore.patch({ busy: { ...uiStore.getState().busy, capture: false } });
      }
    },
    searchTranscript: async (query) => {
      const state = uiStore.getState();
      const trimmed = query.trim();
      if (!trimmed || !state.session) return;
      uiStore.patch({ transcriptSearch: { query: trimmed, results: [], loading: true } });
      try {
        const hits = await callOp('transcript.search', {
          query: trimmed,
          courIds: [state.session.courId],
          limit: 60,
        });
        uiStore.patch({ transcriptSearch: { query: trimmed, results: hits, loading: false } });
      } catch {
        uiStore.patch({ transcriptSearch: { query: trimmed, results: [], loading: false } });
      }
    },
    saveSetting: async (key, value) => {
      const next = await saveSettings({ [key]: value } as Partial<AppSettings>);
      this.settings = next;
      uiStore.patch({ settings: next });
    },
    openSessionInSite: (courId, teclId, extra) => {
      const state = uiStore.getState();
      if (state.session?.courId === courId && isPlayRoute(state.route)) {
        this.actions.seek(0);
        return;
      }
      const input = {
        teclId: teclId ?? this.route.teclId ?? state.session?.teclId,
        teclCode: extra?.teclCode ?? this.route.teclCode,
        subjId: extra?.subjId ?? this.route.subjId,
        courId,
        prefer: 'play-center' as const,
      };
      const hash = lessonHash(input);
      uiStore.patch({ centerOpen: false });
      if (location.hash === hash) {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } else {
        location.hash = hash;
      }
    },
    copyText: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        pushToast('已复制', 'success');
      } catch {
        pushToast('复制失败，请手动选择文本', 'warn');
      }
    },
    showToast: (message, level) => pushToast(message, level ?? 'info'),
  };

  private async sendPanelState(open: boolean): Promise<void> {
    const courId = uiStore.getState().session?.courId;
    try {
      await chrome.runtime.sendMessage({ type: 'PANEL_STATE', requestId: uuid(), open, courId });
    } catch {
      /* 忽略 */
    }
    if (open) this.lastInteractionAt = Date.now();
  }

  private persistPanelPreference(open: boolean): void {
    if (this.settings.ui.panelCollapsed === !open) return;
    const ui = { ...this.settings.ui, panelCollapsed: !open };
    this.settings = { ...this.settings, ui };
    void saveSettings({ ui });
  }
}
