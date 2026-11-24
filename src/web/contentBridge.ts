import { RESERVED_KEYS } from '@/core/shared/constants';
import { applyDebugLogEnabled } from '@/core/shared/logger';
import { loadSettings, onSettingsChanged } from '@/core/shared/settings';
import { eventTargetOf } from '@/core/shared/utils';
import type { AppSettings, RouteInfo, SessionListItem, SessionMeta } from '@/core/shared/types';
import { detectSite, isPlayRoute, parseRoute } from '@/entrypoints/content/site/routes';
import type { PlayerHandle } from '@/entrypoints/content/site/player';
import { resetObservations } from '@/entrypoints/content/site/observations';
import type { SessionResolver } from '@/entrypoints/content/site/sessionResolve';
import { uiStore, type UiActions } from '@/entrypoints/content/ui/store';
import { LIST_ROUTES, type CourseSyncResult, type ScheduleSyncResult } from '@/entrypoints/content/controller/dom';
import {
  listenPageMessages,
  persistPanelPreference,
  sendPageContext,
  sendPanelState,
  sendSessionMeta,
} from '@/entrypoints/content/controller/messaging';
import { syncSchedule, syncSiteCache } from '@/entrypoints/content/controller/siteSync';
import { destroyAnchorProbe, destroyPlayHeaderAnchor, ensureAnchorProbe, ensurePlayHeaderAnchor } from '@/entrypoints/content/controller/anchors';
import { freshAudio, followTick, resetFollowBusy } from '@/entrypoints/content/controller/asrFollow';
import { currentCourId, installBackgroundEvents } from '@/entrypoints/content/controller/backgroundEvents';
import { flushStats, syncFromPlayer, stepOutline, updateRects } from '@/entrypoints/content/controller/playerSync';
import { createActions } from '@/entrypoints/content/controller/actions';
import {
  initPlayPage as initPlayPageImpl,
  loadCandidates as loadCandidatesImpl,
  resolveAndLoad as resolveAndLoadImpl,
} from '@/entrypoints/content/controller/playPage';
import {
  currentLoadToken as currentLoadTokenImpl,
  isLoadTokenCurrent as isLoadTokenCurrentImpl,
  loadRelated as loadRelatedImpl,
  loadSession as loadSessionImpl,
  nextLoadToken as nextLoadTokenImpl,
} from '@/entrypoints/content/controller/sessionData';
import type { ControllerContext } from '@/entrypoints/content/controller/context';

export class WebContentController {
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
  private offSettings: (() => void) | null = null;
  private readonly context: ControllerContext;
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
        controller.pageCleanups.push(cleanup);
      },
      registerGlobalCleanup(cleanup) {
        controller.globalCleanups.push(cleanup);
      },
      getCourId() {
        return currentCourId();
      },
      resolveAndLoad(reason) {
        return resolveAndLoadImpl(controller.context, reason);
      },
      flushStats(reason) {
        return flushStats(reason);
      },
      followTick() {
        return followTick(controller.context);
      },
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
        syncFromPlayer(controller.context);
      },
      updateRects() {
        updateRects(controller.context);
      },
      ensurePlayHeaderAnchor() {
        ensurePlayHeaderAnchor(controller.context);
      },
      ensureAnchorProbe() {
        ensureAnchorProbe(controller.context);
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
        return loadCandidatesImpl(controller.context);
      },
      loadSession(courId) {
        return loadSessionImpl(controller.context, courId);
      },
      loadRelated(courId, token) {
        return loadRelatedImpl(controller.context, courId, token);
      },
      sendPageContext() {
        return sendPageContext(controller.context);
      },
      sendSessionMeta(meta) {
        return sendSessionMeta(meta);
      },
      sendPanelState(open) {
        return sendPanelState(controller.context, open);
      },
      persistPanelPreference(open) {
        persistPanelPreference(controller.context, open);
      },
      syncSiteCache(force = false): Promise<CourseSyncResult> {
        return syncSiteCache(controller.context, force);
      },
      syncSchedule(force = false): Promise<ScheduleSyncResult> {
        return syncSchedule(force);
      },
      freshAudio(viewNum) {
        return freshAudio(controller.context, viewNum);
      },
    };
    this.actions = createActions(this.context);
  }

  private markInteraction(): void {
    this.lastInteractionAt = Date.now();
  }

  start(): void {
    if (this.disposed) return;
    uiStore.bindActions(this.actions);
    uiStore.patch({ settings: this.settings, site: detectSite(), route: parseRoute() });
    this.installGlobalListeners();
    this.offSettings = onSettingsChanged((next) => {
      this.settings = next;
      applyDebugLogEnabled(next.debug.logEnabled);
      this.applySettings(next);
    });
    void this.applyRoute();
  }

  reapplyRoute(): void {
    void this.applyRoute();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardownPage();
    destroyPlayHeaderAnchor();
    destroyAnchorProbe();
    for (const timer of this.globalIntervals) window.clearInterval(timer);
    this.globalIntervals = [];
    for (const cleanup of this.globalCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
    this.offBackgroundEvent?.();
    this.offPageMessage?.();
    this.offSettings?.();
  }

  private applySettings(next: AppSettings): void {
    this.settings = next;
    uiStore.patch({ settings: next });
    if (isPlayRoute(uiStore.getState().route)) {
      ensurePlayHeaderAnchor(this.context);
      ensureAnchorProbe(this.context);
    } else {
      destroyPlayHeaderAnchor();
      destroyAnchorProbe();
    }
    const play = isPlayRoute(uiStore.getState().route);
    if (!play) {
      const list = LIST_ROUTES.has(uiStore.getState().route.kind);
      if (list) {
        const open = next.ui.learningCenter && !uiStore.getState().centerSuppressed;
        uiStore.patch({ centerOpen: open });
        if (next.ui.learningCenter) void syncSiteCache(this.context, false);
      } else {
        uiStore.patch({ centerOpen: false });
      }
    }
  }

  private installGlobalListeners(): void {
    const markInteraction = () => this.markInteraction();
    document.addEventListener('pointerdown', markInteraction, { capture: true, passive: true });
    document.addEventListener('keydown', markInteraction, { capture: true, passive: true });
    this.globalCleanups.push(() => {
      document.removeEventListener('pointerdown', markInteraction, { capture: true });
      document.removeEventListener('keydown', markInteraction, { capture: true });
    });

    const onShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
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
        stepOutline(this.context, -1);
      } else if (key === shortcuts.nextTopic.toLowerCase()) {
        stepOutline(this.context, 1);
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

    const onResize = () => updateRects(this.context);
    window.addEventListener('resize', onResize, { passive: true });
    this.globalCleanups.push(() => window.removeEventListener('resize', onResize));

    this.offBackgroundEvent = installBackgroundEvents(this.context);
    this.offPageMessage = listenPageMessages(this.context);

    const routeTimer = window.setInterval(() => {
      if (location.hash !== this.lastHash) {
        this.lastHash = location.hash;
        void this.applyRoute();
      }
      updateRects(this.context);
      syncFromPlayer(this.context);
    }, 1000);
    this.globalIntervals.push(routeTimer);
  }

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

    void sendPageContext(this.context);

    if (play) {
      await initPlayPageImpl(this.context);
    } else {
      if (list) void syncSiteCache(this.context, false);
      if (next.kind === 'my-schedule') void syncSchedule(false);
    }
  }

  private teardownPage(): void {
    const courId = uiStore.getState().session?.courId;
    if (courId) void flushStats('switch');
    for (const timer of this.pageIntervals) window.clearInterval(timer);
    for (const timer of this.pageTimeouts) window.clearTimeout(timer);
    this.pageIntervals = [];
    this.pageTimeouts = [];
    for (const cleanup of this.pageCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
    this.player?.destroy();
    this.player = null;
    this.resolver = null;
    resetFollowBusy();
    resetObservations();
  }
}

export async function createWebContentController(): Promise<WebContentController> {
  const settings = await loadSettings();
  applyDebugLogEnabled(settings.debug.logEnabled);
  return new WebContentController(settings);
}
