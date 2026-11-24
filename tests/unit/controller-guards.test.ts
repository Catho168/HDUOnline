/**
 * controller 层守卫单测（第 46 轮，锁定第 45 轮拆分后的语义）：
 *  1) playPage.resolveAndLoad 重入守卫（R1）：识别进行中（resolving）的再次触发只登记
 *     pendingResolve，不并发双跑；首轮完成后以 'queued' 自动补跑一次；识别无结果回退
 *     unresolved 并装载候选；同一课次重复识别不重复 loadSession；媒体直链证据优先；
 *     识别异常回退 unresolved；
 *  2) sessionData 的 loadToken 竞态：旧 token 的迟到元数据/关联数据不写入新会话视图；
 *     nextLoadToken/isLoadTokenCurrent 的先自增后比对语义。
 *
 * 说明：resolving/pendingResolve/loadToken 均为模块私有（R1「同一实现」），但每个
 * resolveAndLoad 完整跑完后守卫自清（finally 复位），用例间无需重置模块；站点模块
 * （routes/api/observations/sessionResolve）与 callOp 整体 mock，uiStore 用真实实例
 * 断言落库结果。
 */

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({
  callOp: vi.fn(async () => undefined),
  onBackgroundEvent: vi.fn(() => () => undefined),
}));

vi.mock('@/entrypoints/content/site/routes', () => ({
  isPlayRoute: vi.fn(() => true),
  parseRoute: vi.fn(() => ({ kind: 'video-detail', teclId: 7 })),
}));

vi.mock('@/entrypoints/content/site/api', () => ({
  fetchSessionList: vi.fn(async () => []),
  fetchPlayPageData: vi.fn(async () => null),
  fetchSiteNotes: vi.fn(async () => []),
  fetchSiteCollectionStatus: vi.fn(async () => null),
}));

vi.mock('@/entrypoints/content/site/observations', () => ({
  createSessionResolver: vi.fn(),
  noteObservedUrl: vi.fn(),
  observeMediaSrcChanges: vi.fn(() => ({ disconnect: () => undefined })),
  observeSessionSelection: vi.fn(() => ({ disconnect: () => undefined })),
  resetObservations: vi.fn(),
}));

vi.mock('@/entrypoints/content/site/sessionResolve', () => ({
  extractCourIdFromMediaUrlWithEvidence: vi.fn(() => null),
}));

import { callOp } from '@/core/shared/client';
import { DEFAULT_SETTINGS } from '@/core/shared/constants';
import type { RouteInfo, SessionMeta } from '@/core/shared/types';
import type { PlayerHandle } from '@/entrypoints/content/site/player';
import { uiStore, type UiActions } from '@/entrypoints/content/ui/store';
import { resolveAndLoad } from '@/entrypoints/content/controller/playPage';
import {
  currentLoadToken,
  isLoadTokenCurrent,
  loadRelated,
  loadSession,
  nextLoadToken,
} from '@/entrypoints/content/controller/sessionData';
import type { ControllerContext } from '@/entrypoints/content/controller/context';

const callOpMock = callOp as unknown as Mock;

type CtxStub = ControllerContext & Record<string, ReturnType<typeof vi.fn> | unknown>;

/** 全量 ctx 桩：方法一律 vi.fn，个别字段（meta/route/candidates）可写便于断言 */
function makeCtx(overrides: Record<string, unknown> = {}): CtxStub {
  let candidates: unknown[] = [];
  const ctx = {
    settings: DEFAULT_SETTINGS,
    route: { kind: 'video-detail', site: 'campus', teclId: 7, raw: location.href } as RouteInfo,
    disposed: false,
    player: null as PlayerHandle | null,
    meta: null as SessionMeta | null,
    resolver: null,
    actions: {} as UiActions,
    lastInteractionAt: 0,
    rectCache: { video: '', timeline: '', rail: '' },
    markInteraction: vi.fn(),
    registerPageCleanup: vi.fn(),
    registerGlobalCleanup: vi.fn(),
    getCourId: vi.fn(() => undefined),
    resolveAndLoad: vi.fn(async () => undefined),
    flushStats: vi.fn(async () => undefined),
    followTick: vi.fn(async () => undefined),
    getCandidates: vi.fn(() => candidates),
    setCandidates: vi.fn((list: unknown[]) => {
      candidates = list;
    }),
    setPlayer: vi.fn((player: PlayerHandle | null) => {
      ctx.player = player;
    }),
    setResolver: vi.fn(),
    setMeta: vi.fn((meta: SessionMeta | null) => {
      ctx.meta = meta;
    }),
    setRoute: vi.fn((next: RouteInfo) => {
      ctx.route = next;
    }),
    registerPageInterval: vi.fn(),
    registerPageTimeout: vi.fn(),
    syncFromPlayer: vi.fn(),
    updateRects: vi.fn(),
    ensurePlayHeaderAnchor: vi.fn(),
    ensureAnchorProbe: vi.fn(),
    nextLoadToken: vi.fn(() => nextLoadToken()),
    isLoadTokenCurrent: vi.fn((token: number) => isLoadTokenCurrent(token)),
    currentLoadToken: vi.fn(() => currentLoadToken()),
    loadCandidates: vi.fn(async () => undefined),
    loadSession: vi.fn(async () => undefined),
    loadRelated: vi.fn(async () => undefined),
    sendPageContext: vi.fn(async () => undefined),
    sendSessionMeta: vi.fn(async () => undefined),
    sendPanelState: vi.fn(async () => undefined),
    persistPanelPreference: vi.fn(),
    syncSiteCache: vi.fn(async () => ({ ok: true, skipped: false, courses: 0, sessions: 0 })),
    syncSchedule: vi.fn(async () => ({ ok: true, skipped: false, count: 0 })),
    freshAudio: vi.fn(async () => null),
    ...overrides,
  };
  return ctx as unknown as CtxStub;
}

/** 刷新微任务队列（queued 补跑是 void 异步调用，需要等它落地） */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const META_A: SessionMeta = {
  courId: 1,
  teclId: 7,
  courseName: '高等数学（上）',
  teacherNames: ['张老师'],
  durationSec: 600,
  views: [],
  courLabel: '课次 1',
};

const META_B: SessionMeta = { ...META_A, courId: 2, courLabel: '课次 2' };

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  callOpMock.mockImplementation(async () => undefined);
  uiStore.patch({
    session: null,
    resolution: { phase: 'idle' },
    busy: { session: false, transcript: false, ai: false, ask: false, capture: false },
    chats: [],
    notes: [],
    favorites: [],
  });
});

describe('playPage.resolveAndLoad 重入守卫（第 46 轮锁定）', () => {
  it('识别进行中的再次触发只登记 pendingResolve；首轮完成后以 queued 补跑一次', async () => {
    let releaseFirst: (value: { courId: number; evidence: string; confidence: string }) => void = () => undefined;
    const resolver = {
      resolve: vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
        .mockImplementationOnce(async () => ({ courId: 2, evidence: 'url', confidence: 'direct' })),
    };
    const ctx = makeCtx({ resolver });
    // 模拟真实 loadSession 的 meta 落位（识别守卫据此判定「同一课次不重载」）
    ctx.loadSession = vi.fn(async (courId: number) => {
      ctx.setMeta({ ...META_A, courId, courLabel: `课次 ${courId}` });
    });

    const p1 = resolveAndLoad(ctx as ControllerContext, 'first');
    const p2 = resolveAndLoad(ctx as ControllerContext, 'second');
    expect(resolver.resolve).toHaveBeenCalledTimes(1); // 重入未并发双跑

    releaseFirst({ courId: 1, evidence: 'url', confidence: 'direct' });
    await p1;
    await p2;
    await flushMicrotasks();

    expect(resolver.resolve).toHaveBeenCalledTimes(2); // queued 补跑
    expect(ctx.loadSession).toHaveBeenCalledTimes(2); // 首轮 courId=1 + 补跑 courId=2
    expect((ctx.loadSession as Mock).mock.calls.map((c) => c[0])).toEqual([1, 2]);
  });

  it('识别无结果：回退 unresolved + 装载候选，不 loadSession', async () => {
    const resolver = { resolve: vi.fn(async () => null) };
    const ctx = makeCtx({ resolver });
    // loadCandidates 会重新拉取候选并回填：mock 站点课次列表
    const { fetchSessionList } = await import('@/entrypoints/content/site/api');
    (fetchSessionList as Mock).mockResolvedValue([{ courId: 9, name: '备选课次' }]);

    await resolveAndLoad(ctx as ControllerContext, 'initial');

    // loadCandidates 为 playPage 模块内直调：经其底层 fetchSessionList 断言
    expect(fetchSessionList).toHaveBeenCalledWith(7);
    expect(uiStore.getState().resolution).toMatchObject({ phase: 'unresolved', candidates: [{ courId: 9, name: '备选课次' }] });
    expect(ctx.loadSession).not.toHaveBeenCalled();
  });

  it('同一课次重复识别：仅刷新 resolution，不重复 loadSession', async () => {
    const resolver = { resolve: vi.fn(async () => ({ courId: 1, evidence: 'url', confidence: 'direct' })) };
    const ctx = makeCtx({ resolver });
    (ctx as { meta: SessionMeta | null }).meta = META_A;

    await resolveAndLoad(ctx as ControllerContext, 'again');

    expect(ctx.loadSession).not.toHaveBeenCalled();
    expect(uiStore.getState().resolution).toMatchObject({ phase: 'resolved', courId: 1 });
  });

  it('媒体直链证据优先（mediaHint 覆盖 url 识别结果）', async () => {
    const { extractCourIdFromMediaUrlWithEvidence } = await import('@/entrypoints/content/site/sessionResolve');
    (extractCourIdFromMediaUrlWithEvidence as Mock).mockReturnValueOnce({ courId: 3, evidence: 'media-url' });

    const resolver = { resolve: vi.fn(async () => ({ courId: 1, evidence: 'url', confidence: 'direct' })) };
    const ctx = makeCtx({ resolver });
    (ctx as { player: unknown }).player = { currentViewUrl: () => 'blob:media' };

    await resolveAndLoad(ctx as ControllerContext, 'media-change');

    expect(ctx.setRoute).toHaveBeenCalledTimes(1);
    expect((ctx.route as { courId?: number }).courId).toBe(3);
    expect(ctx.loadSession).toHaveBeenCalledWith(3);
  });

  it('识别异常：回退 unresolved（带候选），不中断后续重入', async () => {
    const resolver = { resolve: vi.fn(async () => { throw new Error('site down'); }) };
    const ctx = makeCtx({ resolver });

    await resolveAndLoad(ctx as ControllerContext, 'initial');

    expect(uiStore.getState().resolution).toMatchObject({ phase: 'unresolved' });
    expect(ctx.loadSession).not.toHaveBeenCalled();
  });
});

describe('sessionData loadToken 竞态（第 46 轮锁定）', () => {
  it('token 先自增后比对：旧 token 的迟到元数据不写入新会话视图', () => {
    const t1 = nextLoadToken();
    expect(isLoadTokenCurrent(t1)).toBe(true);
    const t2 = nextLoadToken();
    expect(t2).not.toBe(t1);
    expect(isLoadTokenCurrent(t1)).toBe(false); // 旧 token 失效
    expect(isLoadTokenCurrent(t2)).toBe(true);
    expect(currentLoadToken()).toBe(t2);
  });

  it('慢的旧 loadSession 迟到完成：不覆盖已切走的新会话', async () => {
    let releaseFirst: (value: { meta: SessionMeta } | null) => void = () => undefined;
    const { fetchPlayPageData } = await import('@/entrypoints/content/site/api');
    (fetchPlayPageData as Mock)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockImplementationOnce(async () => ({ meta: META_B, siteCollected: true }));

    const ctx1 = makeCtx();
    const ctx2 = makeCtx();
    const p1 = loadSession(ctx1 as ControllerContext, 1);
    const p2 = loadSession(ctx2 as ControllerContext, 2);

    releaseFirst({ meta: META_A });
    await p1;
    await p2;
    await flushMicrotasks();

    // 旧 token 的迟到结果被丢弃：ctx1 未落 meta/未发会话消息；新会话正常装载
    expect(ctx1.setMeta).not.toHaveBeenCalled();
    expect(ctx1.sendSessionMeta).not.toHaveBeenCalled();
    expect(ctx2.setMeta).toHaveBeenCalledWith(META_B);
    expect(ctx2.sendSessionMeta).toHaveBeenCalledWith(META_B);
    expect(uiStore.getState().session?.courId).toBe(2);
  });

  it('loadRelated：token 失效后九路结果不写入 store', async () => {
    // 让全部 callOp 挂起，按 op 形状化释放（resolve 不触发 catch，需给成功形状）
    const pending: Array<{ op: string; resolve: (value: unknown) => void }> = [];
    callOpMock.mockImplementation((op: string) => new Promise((resolve) => { pending.push({ op, resolve }); }));

    const ctx = makeCtx();
    const staleToken = nextLoadToken(); // 旧 token
    nextLoadToken(); // 新 token 前移（模拟新会话已开始）

    const p = loadRelated(ctx as ControllerContext, 1, staleToken);
    for (const { op, resolve } of pending) {
      resolve(op === 'ai.get' ? { result: null, stale: false } : op === 'qa.groups' ? [] : null);
    }
    await p;

    // token 已失效：store 不应被旧数据触碰（session 保持 beforeEach 的 null）
    expect(uiStore.getState().session).toBeNull();
    expect(uiStore.getState().chats).toEqual([]);
  });

  it('loadRelated 正常 token：结果按九路落库（transcript/ai/chats/notes/favorites）', async () => {
    const transcript = { mediaKey: 'hdu:1', segments: [{ s: 0, e: 5, text: 'hi' }] };
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'transcript.get') return transcript;
      if (op === 'ai.get') return { result: { topics: [] }, stale: true };
      if (op === 'qa.groups') return [{ groupId: 'g1' }];
      if (op === 'qa.list') return [{ id: 'c1', content: '回答' }];
      if (op === 'fav.list') return [{ id: 'f1' }];
      if (op === 'note.list') return [{ id: 'n1' }];
      if (op === 'stats.sessionSummary') return { watchedSec: 60, watchRatio: 0.1 };
      if (op === 'asr.status') return { id: 'job1' };
      return null; // fetchSiteNotes/fetchSiteCollectionStatus 走各自的 site/api mock
    });
    const { fetchSiteNotes, fetchSiteCollectionStatus } = await import('@/entrypoints/content/site/api');
    (fetchSiteNotes as Mock).mockResolvedValue([{ id: 'sn1' }]);
    (fetchSiteCollectionStatus as Mock).mockResolvedValue({ collected: true });

    const token = nextLoadToken();
    const ctx = makeCtx();
    await loadRelated(ctx as ControllerContext, 1, token);

    const state = uiStore.getState();
    expect(state.transcript).toEqual(transcript);
    expect(state.ai).toEqual({ topics: [] });
    expect(state.aiStale).toBe(true);
    expect(state.chats).toEqual([{ id: 'c1', content: '回答' }]);
    expect(state.activeGroupId).toBe('g1');
    expect(state.notes).toEqual([{ id: 'n1' }]);
    expect(state.favorites).toEqual([{ id: 'f1' }]);
    expect(state.watchedSec).toBe(60);
  });
});
