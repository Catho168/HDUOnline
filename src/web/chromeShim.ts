import { AppError, serializeError, toAppError } from '@/core/shared/errors';
import { API_PREFIX } from '@/core/shared/constants';
import { hduCourIdOf, type MediaKey } from '@/core/shared/mediaRef';
import { uuid } from '@/core/shared/utils';
import type { OpName } from '@/core/shared/ops';
import type {
  ContentToBackground,
  OffscreenLlmAbort,
  OffscreenLlmRun,
  OffscreenRequestEnvelope,
  OffscreenShotCapture,
  PageContextMessage,
  PanelStateMessage,
  PlayerStateMessage,
  PopupOverviewMessage,
  RequestMessage,
  ResponseMessage,
  SessionMetaMessage,
} from '@/core/shared/messages';
import { runLlm } from '@/core/llm/runner';
import { loadSettings } from '@/core/shared/settings';
import { getDb } from '@/core/db';
import { putScreenshot } from '@/core/db/repo/library';
import { dispatchOp } from '@/entrypoints/background/ops';
import { handleLlmOffscreenEvent } from '@/entrypoints/background/llm';
import { handleShotResult } from '@/entrypoints/background/screenshot';
import { buildPopupOverview } from '@/entrypoints/background/popup';
import { statsService } from '@/entrypoints/background/stats';
import { registerTab, setPanelOpen } from '@/entrypoints/background/tabs';

export type WebSurface = 'center' | 'play' | 'dashboard' | 'bili' | 'options' | 'popup';

type NavigationListener = (surface: WebSurface, hash?: string) => void;
const navListeners = new Set<NavigationListener>();

export function onWebNavigate(cb: NavigationListener): () => void {
  navListeners.add(cb);
  return () => navListeners.delete(cb);
}

export function navigateWebSurface(surface: WebSurface, hash?: string): void {
  if (hash !== undefined) {
    const normalized = hash === '' ? '#/' : hash.startsWith('#') ? hash : `#${hash}`;
    if (window.location.hash !== normalized) {
      window.history.replaceState(null, '', normalized);
    }
  }
  for (const listener of navListeners) listener(surface, hash);
}

const INTERACTION_OPS = new Set<string>([
  'qa.ask',
  'fav.put',
  'note.put',
  'note.update',
  'ai.generate',
  'asr.start',
  'transcript.search',
  'review.plan',
]);

const llmAbortControllers = new Map<string, AbortController>();

function makeStorageArea(area: 'local' | 'sync', notifyChanged: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void) {
  const prefix = `hdu_ext_${area}:`;
  const readKey = (k: string): unknown => {
    try {
      const raw = localStorage.getItem(prefix + k);
      return raw === null ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  return {
    async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
      const out: Record<string, unknown> = {};
      if (keys == null) {
        for (let i = 0; i < localStorage.length; i += 1) {
          const full = localStorage.key(i);
          if (full && full.startsWith(prefix)) {
            const k = full.slice(prefix.length);
            const v = readKey(k);
            if (v !== undefined) out[k] = v;
          }
        }
        return out;
      }
      if (typeof keys === 'string') {
        const v = readKey(keys);
        if (v !== undefined) out[keys] = v;
        return out;
      }
      if (Array.isArray(keys)) {
        for (const k of keys) {
          const v = readKey(k);
          if (v !== undefined) out[k] = v;
        }
        return out;
      }
      for (const [k, fallback] of Object.entries(keys)) {
        const v = readKey(k);
        out[k] = v !== undefined ? v : fallback;
      }
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        const oldValue = readKey(k);
        localStorage.setItem(prefix + k, JSON.stringify(v));
        changes[k] = { oldValue, newValue: v };
      }
      if (Object.keys(changes).length > 0) notifyChanged(changes, area);
    },
    async remove(keys: string | string[]): Promise<void> {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const k of list) {
        const oldValue = readKey(k);
        localStorage.removeItem(prefix + k);
        if (oldValue !== undefined) changes[k] = { oldValue, newValue: undefined };
      }
      if (Object.keys(changes).length > 0) notifyChanged(changes, area);
    },
    async clear(): Promise<void> {
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const full = localStorage.key(i);
        if (full && full.startsWith(prefix)) toRemove.push(full);
      }
      for (const full of toRemove) localStorage.removeItem(full);
    },
  };
}

async function runWebLlm(payload: OffscreenLlmRun): Promise<void> {
  const controller = new AbortController();
  llmAbortControllers.set(payload.runId, controller);
  try {
    const settings = await loadSettings();
    const res = await runLlm(
      {
        provider: payload.provider,
        timeouts: payload.timeouts,
        allowLocalEndpoints: payload.allowLocalEndpoints,
        maxRetries: settings.llm.maxRetries,
      },
      {
        system: payload.request.system,
        messages: payload.request.messages,
        maxTokens: payload.request.maxTokens,
        temperature: payload.request.temperature,
        jsonMode: payload.request.jsonMode,
        signal: controller.signal,
        ...(payload.request.stream
          ? {
              onDelta: (text: string) => {
                handleLlmOffscreenEvent({ type: 'OFFSCREEN_LLM_DELTA', runId: payload.runId, text });
              },
            }
          : {}),
      },
    );
    handleLlmOffscreenEvent({
      type: 'OFFSCREEN_LLM_DONE',
      runId: payload.runId,
      text: res.text,
      usage: res.usage,
    });
  } catch (err) {
    const appErr = toAppError(err, 'LLM_NETWORK_ERROR');
    handleLlmOffscreenEvent({
      type: 'OFFSCREEN_LLM_FAILED',
      runId: payload.runId,
      error: serializeError(appErr),
    });
  } finally {
    llmAbortControllers.delete(payload.runId);
  }
}

async function runWebShot(payload: OffscreenShotCapture): Promise<void> {
  try {
    const video = document.querySelector<HTMLVideoElement>('video');
    const width = video && video.videoWidth > 0 ? video.videoWidth : 640;
    const height = video && video.videoHeight > 0 ? video.videoHeight : 360;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');

    if (video && video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, width, height);
    } else {
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, '#1f2837');
      grad.addColorStop(1, '#3b4d68');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#fff8ee';
      ctx.font = '600 22px sans-serif';
      ctx.fillText(payload.meta.courseName, 28, 40);
      ctx.font = '15px sans-serif';
      ctx.fillStyle = 'rgba(255,248,238,0.8)';
      ctx.fillText(payload.meta.courLabel, 28, 72);
    }
    if (payload.watermark) {
      const mm = String(Math.floor(payload.meta.anchorTime / 60)).padStart(2, '0');
      const ss = String(Math.round(payload.meta.anchorTime % 60)).padStart(2, '0');
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(14, height - 34, 260, 22);
      ctx.fillStyle = '#fffdf8';
      ctx.font = '12px sans-serif';
      ctx.fillText(`${payload.meta.courseName} · ${mm}:${ss}`, 20, height - 19);
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
    });
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 160;
    thumbCanvas.height = 90;
    const tctx = thumbCanvas.getContext('2d');
    tctx?.drawImage(canvas, 0, 0, 160, 90);
    const thumbDataUrl = thumbCanvas.toDataURL('image/png');

    const id = uuid();
    await putScreenshot({
      id,
      courId: payload.courId,
      view: payload.view,
      blob,
      thumbDataUrl,
      meta: {
        courseName: payload.meta.courseName,
        courLabel: payload.meta.courLabel,
        anchorTime: payload.meta.anchorTime,
        watermark: payload.watermark,
      },
      createdAt: Date.now(),
    });

    await handleShotResult({
      type: 'OFFSCREEN_SHOT_RESULT',
      requestId: payload.requestId,
      ok: true,
      screenshotId: id,
      width,
      height,
    });
  } catch (err) {
    const appErr = toAppError(err, 'UNKNOWN');
    await handleShotResult({
      type: 'OFFSCREEN_SHOT_RESULT',
      requestId: payload.requestId,
      ok: false,
      error: serializeError(appErr),
    });
  }
}

type RuntimeMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

let installed = false;

export function installChromeShim(): void {
  if (installed) return;
  installed = true;

  const g = globalThis as unknown as { chrome?: unknown };
  const existing = g.chrome as { runtime?: { id?: string } } | undefined;
  if (existing?.runtime?.id) return;

  const messageListeners = new Set<RuntimeMessageListener>();
  const storageListeners = new Set<(changes: Record<string, unknown>, area: string) => void>();

  const notifyStorage = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => {
    for (const fn of storageListeners) {
      try {
        fn(changes, area);
      } catch {
        /* ignore */
      }
    }
  };

  const dispatchPageListeners = async (message: unknown): Promise<unknown> => {
    for (const fn of [...messageListeners]) {
      let replied = false;
      let replyValue: unknown;
      const promise = new Promise<unknown>((resolve) => {
        const res = fn(message, { tab: { id: 1 } } as chrome.runtime.MessageSender, (val) => {
          replied = true;
          replyValue = val;
          resolve(val);
        });
        if (!res) resolve(undefined);
      });
      const out = await promise;
      if (replied) return replyValue;
      if (out !== undefined) return out;
    }
    return undefined;
  };

  const handleBackendMessage = async (raw: unknown): Promise<unknown> => {
    if (!raw || typeof raw !== 'object') return undefined;
    const msg = raw as ContentToBackground | OffscreenRequestEnvelope | { type: string };

    if (msg.type === 'OFFSCREEN_REQUEST') {
      const env = msg as OffscreenRequestEnvelope;
      if (env.op === 'LLM_RUN') {
        void runWebLlm(env.payload);
        return { ok: true };
      }
      if (env.op === 'LLM_ABORT') {
        const abortPayload = env.payload as OffscreenLlmAbort;
        llmAbortControllers.get(abortPayload.runId)?.abort();
        return { ok: true };
      }
      if (env.op === 'SHOT') {
        void runWebShot(env.payload);
        return { ok: true };
      }
      return { ok: true };
    }

    switch (msg.type) {
      case 'PAGE_CONTEXT': {
        const m = msg as PageContextMessage;
        registerTab(1, {
          routeKind: m.context.route.kind,
          courId: m.context.route.courId,
          teclId: m.context.route.teclId,
        });
        return { ok: true };
      }
      case 'SESSION_META': {
        const m = msg as SessionMetaMessage;
        registerTab(1, { courId: m.meta.courId, teclId: m.meta.teclId });
        try {
          await dispatchOp('session.saveMeta', { meta: m.meta });
          return { ok: true };
        } catch (err) {
          const appErr = err instanceof AppError ? err : new AppError('DB_FAILED', { cause: err });
          return { ok: false, error: serializeError(appErr) };
        }
      }
      case 'PLAYER_STATE': {
        const m = msg as PlayerStateMessage;
        registerTab(1, { courId: m.courId, teclId: m.teclId });
        await dispatchOp('stats.tick', {
          courId: m.courId,
          teclId: m.teclId,
          state: m.state,
          visible: m.visible,
          focused: m.focused,
          interacted: m.interacted,
        }).catch(() => undefined);
        return { ok: true };
      }
      case 'PANEL_STATE': {
        const m = msg as PanelStateMessage;
        setPanelOpen(1, m.open);
        if (m.courId !== undefined) registerTab(1, { courId: m.courId });
        return { ok: true };
      }
      case 'POPUP_OVERVIEW': {
        const m = msg as PopupOverviewMessage;
        const overview = await buildPopupOverview(m.courId, 1);
        return { type: 'POPUP_OVERVIEW_RESULT', overview };
      }
      case 'REQUEST': {
        const req = msg as RequestMessage;
        const requestId = req.requestId ?? uuid();
        const args = (req.args ?? {}) as {
          courId?: number;
          mediaKey?: MediaKey;
          teclId?: number;
          favorite?: { courId?: number; teclId?: number };
          note?: { courId?: number; teclId?: number };
        };
        const courId =
          args.courId ??
          (args.mediaKey !== undefined ? hduCourIdOf(args.mediaKey) : undefined) ??
          args.favorite?.courId ??
          args.note?.courId;
        if (typeof courId === 'number' || typeof args.mediaKey === 'string') {
          registerTab(1, {
            courId,
            mediaKey: args.mediaKey,
            teclId: args.teclId ?? args.favorite?.teclId ?? args.note?.teclId,
          });
        }
        try {
          const result = await dispatchOp(req.op as OpName, req.args as never);
          if (INTERACTION_OPS.has(req.op as string) && typeof courId === 'number') {
            await statsService.interaction(courId).catch(() => undefined);
          }
          return { type: 'RESPONSE', requestId, ok: true, result } satisfies ResponseMessage;
        } catch (err) {
          return { type: 'RESPONSE', requestId, ok: false, error: serializeError(err) } satisfies ResponseMessage;
        }
      }
      case 'KEEPALIVE':
        return { ok: true };
      case 'OPEN_OPTIONS':
        navigateWebSurface('options');
        return { ok: true };
      case 'OPEN_DASHBOARD':
        navigateWebSurface('dashboard');
        return { ok: true };
      default:
        return undefined;
    }
  };

  const shim = {
    runtime: {
      id: 'hdu-web-preview',
      getURL(path: string): string {
        const clean = path.replace(/^\/+/, '');
        if (clean === 'dashboard.html') return `${window.location.origin}/?surface=dashboard`;
        if (clean === 'options.html') return `${window.location.origin}/?surface=options`;
        if (clean === 'popup.html') return `${window.location.origin}/?surface=popup`;
        return `${window.location.origin}/${clean}`;
      },
      async sendMessage(message: unknown): Promise<unknown> {
        return handleBackendMessage(message);
      },
      onMessage: {
        addListener(cb: RuntimeMessageListener) {
          messageListeners.add(cb);
        },
        removeListener(cb: RuntimeMessageListener) {
          messageListeners.delete(cb);
        },
      },
      async openOptionsPage(): Promise<void> {
        navigateWebSurface('options');
      },
    },
    storage: {
      local: makeStorageArea('local', notifyStorage),
      sync: makeStorageArea('sync', notifyStorage),
      onChanged: {
        addListener(cb: (changes: Record<string, unknown>, area: string) => void) {
          storageListeners.add(cb);
        },
        removeListener(cb: (changes: Record<string, unknown>, area: string) => void) {
          storageListeners.delete(cb);
        },
      },
    },
    tabs: {
      async query(): Promise<chrome.tabs.Tab[]> {
        return [
          {
            id: 1,
            index: 0,
            pinned: false,
            highlighted: true,
            windowId: 1,
            active: true,
            incognito: false,
            selected: true,
            discarded: false,
            autoDiscardable: true,
            frozen: false,
            lastAccessed: Date.now(),
            groupId: -1,
            url: window.location.href,
            title: document.title,
          },
        ];
      },
      async sendMessage(_tabId: number, message: unknown): Promise<unknown> {
        const pageReply = await dispatchPageListeners(message);
        if (pageReply !== undefined) return pageReply;
        const msg = message as { type?: string; courId?: number } | undefined;
        if (msg?.type === 'POPUP_OVERVIEW') {
          const overview = await buildPopupOverview(msg.courId, 1);
          return { type: 'POPUP_OVERVIEW_RESULT', overview };
        }
        return undefined;
      },
      async create(opts: { url?: string }): Promise<chrome.tabs.Tab | null> {
        const urlStr = opts?.url ?? '';
        try {
          const parsed = new URL(urlStr, window.location.origin);
          if (parsed.origin === window.location.origin) {
            const surf = parsed.searchParams.get('surface') as WebSurface | null;
            if (surf) {
              navigateWebSurface(surf, parsed.hash || undefined);
              return null;
            }
          }
          if (parsed.hostname.includes('bilibili.com')) {
            navigateWebSurface('bili', '');
            return null;
          }
          if (parsed.hash.includes('play-center') || parsed.hash.includes('video-detail')) {
            navigateWebSurface('play', parsed.hash);
            return null;
          }
        } catch {
          /* ignore */
        }
        return null;
      },
      onRemoved: { addListener() {}, removeListener() {} },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    permissions: {
      async contains(): Promise<boolean> {
        return true;
      },
      async request(): Promise<boolean> {
        return true;
      },
    },
    alarms: {
      create() {},
      clear: async () => true,
      onAlarm: { addListener() {}, removeListener() {} },
    },
    notifications: {
      async create() {},
      onClicked: { addListener() {}, removeListener() {} },
    },
    offscreen: {
      async hasDocument(): Promise<boolean> {
        return true;
      },
      async createDocument(): Promise<void> {},
      async closeDocument(): Promise<void> {},
    },
  };

  g.chrome = shim;

  if (typeof window !== 'undefined') {
    window.open = ((url?: string | URL) => {
      if (!url) return null;
      const raw = String(url);
      try {
        const parsed = new URL(raw, window.location.origin);
        if (parsed.hostname.includes('bilibili.com')) {
          const bvMatch = parsed.pathname.match(/\/video\/(BV[\w]+)/);
          navigateWebSurface('bili', bvMatch?.[1] ? `#bvid=${bvMatch[1]}` : '');
          return null;
        }
        if (parsed.hash.includes('play-center') || parsed.hash.includes('video-detail') || parsed.hash.includes('play-video')) {
          navigateWebSurface('play', parsed.hash);
          return null;
        }
        if (parsed.origin === window.location.origin) {
          const surf = parsed.searchParams.get('surface') as WebSurface | null;
          if (surf) {
            navigateWebSurface(surf, parsed.hash || undefined);
            return null;
          }
          if (parsed.hash) {
            navigateWebSurface('center', parsed.hash);
            return null;
          }
        }
      } catch {
        /* ignore invalid urls */
      }
      return null;
    }) as typeof window.open;
  }
}

let fetchShimInstalled = false;

export function installSiteFetchShim(): void {
  if (fetchShimInstalled || typeof window === 'undefined') return;
  fetchShimInstalled = true;
  const origFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url: URL;
    try {
      url = new URL(rawUrl, window.location.origin);
    } catch {
      return origFetch(input, init);
    }

    if (url.origin === window.location.origin && url.pathname.startsWith(API_PREFIX)) {
      const data = await handleMockSiteApi(url.pathname, url.searchParams);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    return origFetch(input, init);
  };
}

async function handleMockSiteApi(pathname: string, searchParams: URLSearchParams): Promise<{ code: string; data: unknown }> {
  const db = await getDb();
  const courses = await db.getAll('courses');
  const sessions = await db.getAll('sessions');
  const curriculum = await db.getAll('curriculum');

  if (pathname === `${API_PREFIX}/v1/currentuser`) {
    return { code: '0', data: { realName: '演示同学', roleType: 1 } };
  }

  if (pathname === `${API_PREFIX}/v1/group_subject_vod_list/t-1`) {
    return {
      code: '0',
      data: courses.map((c) => ({
        teclId: c.teclId,
        subjName: c.subjName,
        subjCode: c.subjCode,
        teclCode: c.teclCode,
        clroName: c.clroName,
        teacherNames: c.teacherNames,
        courTimes: sessions.filter((s) => s.teclId === c.teclId).length,
      })),
    };
  }

  if (pathname === `${API_PREFIX}/v1/subject_vod_list_new`) {
    const teclId = Number(searchParams.get('teclIds') ?? searchParams.get('teclId') ?? 0);
    const list = teclId > 0 ? sessions.filter((s) => s.teclId === teclId) : sessions;
    return {
      code: '0',
      data: {
        records: list.map((s) => {
          const course = courses.find((c) => c.teclId === s.teclId);
          return {
            id: s.courId,
            courBeginTime: s.beginTime,
            courEndTime: s.endTime,
            letiNumber: s.letiNumber,
            letyName: s.letyName,
            clroName: course?.clroName,
            vodStatus: 1,
            vodDisplayStatus: 1,
            noteFlag: false,
          };
        }),
      },
    };
  }

  if (pathname === `${API_PREFIX}/v1/course_vod_urls_new`) {
    const courId = Number(searchParams.get('courseId') ?? 0);
    const session = sessions.find((s) => s.courId === courId) ?? sessions[0];
    if (!session) return { code: '0', data: null };
    const course = courses.find((c) => c.teclId === session.teclId);
    const dur = session.durationSec || 2700;
    return {
      code: '0',
      data: {
        courId: session.courId,
        teclId: session.teclId,
        courName: session.courseName || course?.subjName || '智慧课堂',
        subjCode: course?.subjCode,
        classRoomName: course?.clroName,
        teacherNames: course?.teacherNames?.length ? course.teacherNames : ['主讲教师'],
        courBeginTime: session.beginTime,
        courEndTime: session.endTime,
        letiNumber: session.letiNumber,
        letiName: session.letyName,
        vodTime: dur,
        lastPlayTime: session.lastPositionSec ?? 320,
        courseVodViewList: [
          { vodId: 1, viewNum: 1, name: '教师主画面', url: `${window.location.origin}/#view=1`, vodTime: dur },
          { vodId: 2, viewNum: 2, name: '板书 / PPT', url: `${window.location.origin}/#view=2`, vodTime: dur },
        ],
      },
    };
  }

  if (pathname === `${API_PREFIX}/v1/myself/curriculum`) {
    return {
      code: '0',
      data: curriculum.map((item) => ({
        id: item.courId,
        teclId: item.teclId,
        subjName: item.subjName,
        courBeginTime: item.beginTime,
        courEndTime: item.endTime,
        clroName: item.clroName,
        letiNumber: item.letiNumber,
        courseStatus: '已结束',
      })),
    };
  }

  if (pathname === `${API_PREFIX}/oauth2/token`) {
    return { code: '0', data: { jwt_token: 'hdu-web-preview-jwt-token-0123456789abcdef' } };
  }

  if (pathname === `${API_PREFIX}/v1/list/termYear`) {
    return { code: '0', data: [{ acteId: 9, termYear: '2026-2027-1' }] };
  }

  if (pathname.startsWith(`${API_PREFIX}/v1/teachingClass/`)) {
    const seg = pathname.split('/')[4];
    const teclId = Number(seg ?? 0);
    const course = courses.find((c) => c.teclId === teclId) ?? courses[0];
    return {
      code: '0',
      data: course
        ? {
            subjName: course.subjName,
            clroName: course.clroName,
            teacherNames: course.teacherNames,
          }
        : null,
    };
  }

  if (pathname === `${API_PREFIX}/v1/course_vod_videoinfos`) {
    return { code: '0', data: { openType: 'vod', vodStatus: 1 } };
  }

  if (pathname.startsWith(`${API_PREFIX}/v1/course/note/`)) {
    return { code: '0', data: [] };
  }

  if (pathname.startsWith(`${API_PREFIX}/v1/vod/`) && pathname.endsWith('/getCollection')) {
    return { code: '0', data: false };
  }

  return { code: '0', data: null };
}
