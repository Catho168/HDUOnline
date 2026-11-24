/**
 * 内容脚本入口：站点识别 → 会话解析 → 数据加载 → Shadow DOM UI → 统计/转写/AI 编排。
 *
 * 设计原则：
 *  - 只读站点：不调用写接口、不修改站点 DOM、不劫持站点快捷键；
 *  - 多证据识别课次（play-center 的 URL 不含课次 ID）；
 *  - 站点播放器仍是主角，扩展 UI 全部在 Shadow DOM 内；
 *  - 任何单点失败静默降级，不阻塞播放。
 *
 * 第 41–45 轮按 docs/content-index-拆分方案.md 完成四批纯搬移拆分：本文件保留入口
 * 装配、ContentController 核心状态与生命周期（start/dispose/applySettings、全局监听、
 * 路由编排）及各 controller/ 子模块的一行转发桥接；播放页初始化/会话识别在
 * controller/playPage，会话数据装载在 controller/sessionData，uiStore 动作在
 * controller/actions/（panel/session/av/notes 四文件，createActions 组装）。
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import { SITE_ORIGINS, RESERVED_KEYS } from '@/core/shared/constants';
import { installUnhandledRejectionSafetyNet } from '@/core/shared/client';
import { applyDebugLogEnabled, createLogger } from '@/core/shared/logger';
import { loadSettings, onSettingsChanged } from '@/core/shared/settings';
import { bootSeekSecondsOf, eventTargetOf } from '@/core/shared/utils';
import type { AppSettings, RouteInfo, SessionListItem, SessionMeta } from '@/core/shared/types';
import { detectSite, isPlayRoute, parseRoute } from './site/routes';
import type { PlayerHandle } from './site/player';
import { resetObservations } from './site/observations';
import type { SessionResolver } from './site/sessionResolve';
import { mountUi } from './ui/mount';
import {
  uiStore,
  type UiActions,
} from './ui/store';
import { LIST_ROUTES, type CourseSyncResult, type ScheduleSyncResult } from './controller/dom';
import { listenPageMessages, persistPanelPreference, sendPageContext, sendPanelState, sendSessionMeta } from './controller/messaging';
import { syncSchedule, syncSiteCache } from './controller/siteSync';
import { destroyAnchorProbe, destroyPlayHeaderAnchor, ensureAnchorProbe, ensurePlayHeaderAnchor } from './controller/anchors';
import { freshAudio, followTick, resetFollowBusy } from './controller/asrFollow';
import { currentCourId, installBackgroundEvents } from './controller/backgroundEvents';
import { flushStats, syncFromPlayer, stepOutline, updateRects } from './controller/playerSync';
import { createActions } from './controller/actions';
import {
  initPlayPage as initPlayPageImpl,
  loadCandidates as loadCandidatesImpl,
  resolveAndLoad as resolveAndLoadImpl,
} from './controller/playPage';
import {
  currentLoadToken as currentLoadTokenImpl,
  isLoadTokenCurrent as isLoadTokenCurrentImpl,
  loadRelated as loadRelatedImpl,
  loadSession as loadSessionImpl,
  nextLoadToken as nextLoadTokenImpl,
} from './controller/sessionData';
import type { ControllerContext } from './controller/context';

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
    // 全局 unhandledrejection 安全网（第 253 轮 callOp 审计）：只静默记录不弹 UI，
    // 防「静默失败」无从反查；与 B 站侧内容脚本同型（bilibili.content.tsx）
    const offRejectionNet = installUnhandledRejectionSafetyNet(createLogger('content').warn);
    ctx.onInvalidated(() => offRejectionNet());
    let settings = await loadSettings();
    // 诊断日志开关初始应用（第 299 轮，工程域）：内容脚本是日志主产出口（asr-*/ui），
    // 「记录诊断日志」关闭时本上下文也必须静默
    applyDebugLogEnabled(settings.debug.logEnabled);
    const controller = new ContentController(settings);
    uiStore.bindActions(controller.actions);
    uiStore.patch({ settings, site: detectSite(), route: parseRoute() });
    const unmount = mountUi();
    controller.start();
    // 启动信息日志（第 301 轮，可观测性域）：info 级、受「记录诊断日志」开关约束
    //（关闭即静默），为排障提供启动锚点，也为 e2e 提供确定性日志探针
    //（关→新开站点页日志环不增长 / 开→恢复并出现本条）
    createLogger('content').info('内容脚本已启动', `${detectSite()} ${JSON.stringify(parseRoute())}`);

    // 统一搜索秒级直达（第 104 轮巡检）：B 站侧课次跳转以新标签打开 HDU 播放页并携带
    // ?t=<命中秒>（真实 query，见 BiliHubPanel.openHduSession）。内容脚本启动时读取一次，
    // 播放器就绪（duration>0）后 seek 落点；15s 兜底退订，不常驻监听。非播放页/无参不动。
    const bootSeekSec = bootSeekSecondsOf(location.search);
    if (bootSeekSec !== null && isPlayRoute(parseRoute())) {
      let offBootSeek: () => void = () => undefined;
      const bootSeekTimer = window.setTimeout(() => offBootSeek(), 15_000);
      ctx.onInvalidated(() => {
        window.clearTimeout(bootSeekTimer);
        offBootSeek();
      });
      offBootSeek = uiStore.subscribe(() => {
        if (uiStore.getState().duration > 0) {
          offBootSeek();
          controller.actions.seek(bootSeekSec);
        }
      });
      // duration 已就绪（如 bfcache 恢复）时订阅不会再触发，立即补一次判定
      if (uiStore.getState().duration > 0) {
        offBootSeek();
        controller.actions.seek(bootSeekSec);
      }
    }

    const offSettings = onSettingsChanged((next) => {
      settings = next;
      // 诊断日志开关热更（第 299 轮，工程域）
      applyDebugLogEnabled(next.debug.logEnabled);
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
  private lastHash = location.hash;
  private lastInteractionAt = Date.now();
  private rectCache = { video: '', timeline: '', rail: '' };
  private offBackgroundEvent: (() => void) | null = null;
  private offPageMessage: (() => void) | null = null;
  /** 注入给 controller/ 子模块的窄上下文（见 controller/context.ts） */
  private readonly context: ControllerContext;
  /** uiStore 动作集（第 45 轮起由 controller/actions/createActions 组装） */
  readonly actions: UiActions;

  constructor(settings: AppSettings) {
    this.settings = settings;
    const controller = this;
    this.context = {
      get settings() {
        return controller.settings;
      },
      set settings(next) {
        controller.settings = next;
      },
      get route() {
        return controller.route;
      },
      get disposed() {
        return controller.disposed;
      },
      get player() {
        return controller.player;
      },
      get meta() {
        return controller.meta;
      },
      get resolver() {
        return controller.resolver;
      },
      get actions() {
        return controller.actions;
      },
      get lastInteractionAt() {
        return controller.lastInteractionAt;
      },
      get rectCache() {
        return controller.rectCache;
      },
      markInteraction() {
        controller.markInteraction();
      },
      registerPageCleanup(cleanup) {
        controller.registerPageCleanup(cleanup);
      },
      registerGlobalCleanup(cleanup) {
        controller.registerGlobalCleanup(cleanup);
      },
      getCourId() {
        return currentCourId();
      },
      resolveAndLoad(reason) {
        return controller.resolveAndLoad(reason);
      },
      flushStats(reason) {
        return controller.flushStats(reason);
      },
      followTick() {
        return controller.followTick();
      },
      // ───── 第 4 批生长（playPage / sessionData / actions 接线）─────
      getCandidates() {
        return controller.candidates;
      },
      setCandidates(list) {
        controller.candidates = list;
      },
      setPlayer(player) {
        controller.player = player;
      },
      setResolver(resolver) {
        controller.resolver = resolver;
      },
      setMeta(meta) {
        controller.meta = meta;
      },
      setRoute(next) {
        controller.route = next;
      },
      registerPageInterval(id) {
        controller.pageIntervals.push(id);
      },
      registerPageTimeout(id) {
        controller.pageTimeouts.push(id);
      },
      syncFromPlayer() {
        controller.syncFromPlayer();
      },
      updateRects() {
        controller.updateRects();
      },
      ensurePlayHeaderAnchor() {
        controller.ensurePlayHeaderAnchor();
      },
      ensureAnchorProbe() {
        controller.ensureAnchorProbe();
      },
      nextLoadToken() {
        return nextLoadTokenImpl();
      },
      isLoadTokenCurrent(token) {
        return isLoadTokenCurrentImpl(token);
      },
      currentLoadToken() {
        return currentLoadTokenImpl();
      },
      loadCandidates() {
        return controller.loadCandidates();
      },
      loadSession(courId) {
        return controller.loadSession(courId);
      },
      loadRelated(courId, token) {
        return controller.loadRelated(courId, token);
      },
      sendPageContext() {
        return controller.sendPageContext();
      },
      sendSessionMeta(meta) {
        return controller.sendSessionMeta(meta);
      },
      sendPanelState(open) {
        return controller.sendPanelState(open);
      },
      persistPanelPreference(open) {
        controller.persistPanelPreference(open);
      },
      syncSiteCache(force) {
        return controller.syncSiteCache(force);
      },
      syncSchedule(force) {
        return controller.syncSchedule(force);
      },
      freshAudio(viewNum) {
        return controller.freshAudio(viewNum);
      },
    };
    // actions 依赖 context（面板上报/站点同步/会话装载等经 ctx 转发），在装配后创建
    this.actions = createActions(this.context);
  }

  private markInteraction(): void {
    this.lastInteractionAt = Date.now();
  }

  private registerPageCleanup(cleanup: () => void): void {
    this.pageCleanups.push(cleanup);
  }

  private registerGlobalCleanup(cleanup: () => void): void {
    this.globalCleanups.push(cleanup);
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
    // 注入开关联动：关闭→立即摘除 chip 与探针入口（浮窗胶囊/Dock 回归）；开启且在播放页→补建
    if (isPlayRoute(uiStore.getState().route)) {
      this.ensurePlayHeaderAnchor();
      this.ensureAnchorProbe();
    } else {
      this.destroyPlayHeaderAnchor();
      this.destroyAnchorProbe();
    }
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
      this.markInteraction();
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
      // shadow DOM 内键盘事件冒泡到 document 时 target 被重定向为宿主（第 51 轮审计
      // P2-1，与 B 站侧同修）：取 composedPath()[0] 才是真实焦点目标
      const target = eventTargetOf(event) as HTMLElement | null;
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

    this.offBackgroundEvent = installBackgroundEvents(this.context);
    this.offPageMessage = listenPageMessages(this.context);

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
    this.rectCache = { video: '', timeline: '', rail: '' };

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
      rightRailRect: null,
      anchorChipActive: false,
      injectedEntryActive: false,
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
    resetFollowBusy();
    resetObservations();
  }

  // ───────────────────────── 非播放页（桥接 controller/siteSync） ─────────────────────────

  private async syncSiteCache(force = false): Promise<CourseSyncResult> {
    return syncSiteCache(this.context, force);
  }

  private async syncSchedule(force = false): Promise<ScheduleSyncResult> {
    return syncSchedule(force);
  }

  // ───────────────────────── 播放页（桥接 controller/playPage） ─────────────────────────

  private async initPlayPage(): Promise<void> {
    return initPlayPageImpl(this.context);
  }

  private async loadCandidates(): Promise<void> {
    return loadCandidatesImpl(this.context);
  }

  private async resolveAndLoad(reason: string): Promise<void> {
    return resolveAndLoadImpl(this.context, reason);
  }

  // ───────────────────────── 会话数据（桥接 controller/sessionData） ─────────────────────────

  private async loadSession(courId: number): Promise<void> {
    return loadSessionImpl(this.context, courId);
  }

  private async loadRelated(courId: number, token: number): Promise<void> {
    return loadRelatedImpl(this.context, courId, token);
  }

  // ───────────────────────── 注入式 UI 锚点（桥接 controller/anchors） ─────────────────────────

  private ensurePlayHeaderAnchor(): void {
    ensurePlayHeaderAnchor(this.context);
  }

  private destroyPlayHeaderAnchor(): void {
    destroyPlayHeaderAnchor();
  }

  private ensureAnchorProbe(): void {
    ensureAnchorProbe(this.context);
  }

  private destroyAnchorProbe(): void {
    destroyAnchorProbe();
  }

  // ───────────────────────── 播放器同步/统计（桥接 controller/playerSync） ─────────────────────────

  private syncFromPlayer(): void {
    syncFromPlayer(this.context);
  }

  private stepOutline(direction: -1 | 1): void {
    stepOutline(this.context, direction);
  }

  private updateRects(): void {
    updateRects(this.context);
  }

  private async flushStats(reason: 'pause' | 'hidden' | 'switch' | 'flush'): Promise<void> {
    return flushStats(reason);
  }

  // ───────────────────────── 新鲜直链 / 转写（桥接 controller/asrFollow） ─────────────────────────

  private async freshAudio(viewNum: number): Promise<{ url: string; viewNum: number; durationSec: number } | null> {
    return freshAudio(this.context, viewNum);
  }

  private async followTick(): Promise<void> {
    return followTick(this.context);
  }

  // ───────────────────────── 消息（桥接 controller/messaging） ─────────────────────────

  private async sendPageContext(): Promise<void> {
    return sendPageContext(this.context);
  }

  private async sendSessionMeta(meta: SessionMeta): Promise<void> {
    return sendSessionMeta(meta);
  }

  private async sendPanelState(open: boolean): Promise<void> {
    return sendPanelState(this.context, open);
  }

  private persistPanelPreference(open: boolean): void {
    persistPanelPreference(this.context, open);
  }
}
