/**
 * 播放页初始化与会话识别编排（D7，第 45 轮自 content/index.tsx 纯搬移拆分）：
 *  - initPlayPage：播放器句柄/识别器装配、注入锚点、播放器事件与媒体变化/选课观察、
 *    tick 与 ASR 跟进定时器、预热与自动转写延时任务；
 *  - loadCandidates：课次候选列表装载（识别失败时的手动选择备选）；
 *  - resolveAndLoad：多证据会话识别编排（重入守卫 resolving/pendingResolve 为本模块
 *    内部状态，外部一律经 ctx.resolveAndLoad 调用，不可绕过）。
 * 逻辑/文案/时序逐行未变（仅 this.→ctx. 与守卫模块化机械替换）；守卫口径（R1）：
 * resolving/pendingResolve 留在本模块、loadToken 留在 sessionData 模块，均不经外部直改。
 */

import { callOp } from '@/core/shared/client';
import type { SessionListItem } from '@/core/shared/types';
import {
  createSessionResolver,
  noteObservedUrl,
  observeMediaSrcChanges,
  observeSessionSelection,
} from '../site/observations';
import { extractCourIdFromMediaUrlWithEvidence } from '../site/sessionResolve';
import { createPlayerHandle } from '../site/player';
import { fetchSessionList } from '../site/api';
import { isPlayRoute, parseRoute } from '../site/routes';
import { log } from './dom';
import { uiStore } from '../ui/store';
import type { ControllerContext } from './context';

/** 会话识别重入守卫（R1：与 resolveAndLoad 同一实现，外部经 ctx 调用不可绕过） */
let resolving = false;
let pendingResolve = false;

export async function initPlayPage(ctx: ControllerContext): Promise<void> {
  const player = createPlayerHandle();
  ctx.setPlayer(player);
  ctx.setResolver(createSessionResolver(ctx.route, player, { allowUnverified: true }));

  uiStore.patch({ panelOpen: !ctx.settings.ui.panelCollapsed, centerOpen: ctx.settings.ui.centerOnPlayPage, centerSuppressed: false });
  ctx.ensurePlayHeaderAnchor();
  ctx.ensureAnchorProbe();

  const playerEvents = ['timeupdate', 'play', 'pause', 'seeking', 'seeked', 'ratechange', 'loadedmetadata', 'durationchange', 'ended', 'canplay'] as const;
  for (const event of playerEvents) {
    ctx.registerPageCleanup(
      player.on(event, () => {
        ctx.syncFromPlayer();
        if (event === 'pause' || event === 'ended') void ctx.flushStats(event === 'ended' ? 'pause' : 'pause');
        if (event === 'seeking' || event === 'play') ctx.markInteraction();
        if ((event === 'loadedmetadata' || event === 'canplay') && !ctx.meta) {
          void resolveAndLoad(ctx, 'player-ready');
        }
        if (event === 'loadedmetadata' || event === 'durationchange') ctx.updateRects();
      }),
    );
  }

  ctx.registerPageCleanup(
    observeMediaSrcChanges(
      (change) => {
        if (!change.isPrimary) return;
        if (change.src) {
          noteObservedUrl(change.src);
          ctx.resolver?.noteObservedUrl(change.src);
          // 站点内切换机位/课次后，手动选择不应继续压过实时证据
          ctx.resolver?.clearManual();
          void resolveAndLoad(ctx, 'media-change');
        }
      },
      { player, intervalMs: 1200 },
    ).disconnect,
  );

  ctx.registerPageCleanup(
    observeSessionSelection((change) => {
      if (change.selected) {
        ctx.resolver?.clearManual();
        void resolveAndLoad(ctx, 'selection');
      }
    }).disconnect,
  );

  ctx.registerPageCleanup(
    player.onViewsChanged(() => {
      ctx.updateRects();
      ctx.syncFromPlayer();
      if (!ctx.meta) void resolveAndLoad(ctx, 'views-changed');
    }),
  );

  void loadCandidates(ctx);
  ctx.updateRects();

  const tickTimer = window.setInterval(() => {
    ctx.syncFromPlayer();
    ctx.updateRects();
  }, 1000);
  ctx.registerPageInterval(tickTimer);

  const followTimer = window.setInterval(() => void ctx.followTick(), 7000);
  ctx.registerPageInterval(followTimer);

  if (ctx.settings.asr.autoWarmup) {
    void callOp('asr.warmup', {}).catch(() => undefined);
  }

  ctx.registerPageTimeout(
    window.setTimeout(() => {
      void resolveAndLoad(ctx, 'initial');
    }, 700),
  );

  if (ctx.settings.asr.autoTranscribeOnOpen) {
    ctx.registerPageTimeout(
      window.setTimeout(() => {
        const state = uiStore.getState();
        if (state.session) void ctx.actions.startTranscribe();
      }, 6000),
    );
  }
}

export async function loadCandidates(ctx: ControllerContext): Promise<void> {
  const teclId = ctx.route.teclId;
  if (!teclId) return;
  const list = await fetchSessionList(teclId).catch(() => [] as SessionListItem[]);
  ctx.setCandidates(list);
  if (list.length > 0) {
    uiStore.patch({
      resolution: { ...uiStore.getState().resolution, candidates: list },
    });
  }
}

export async function resolveAndLoad(ctx: ControllerContext, reason: string): Promise<void> {
  if (!ctx.resolver || ctx.disposed) return;
  if (!isPlayRoute(parseRoute())) return;
  if (resolving) {
    pendingResolve = true;
    return;
  }
  resolving = true;
  const before = uiStore.getState().resolution;
  try {
    if (before.phase !== 'resolved') {
      uiStore.patch({ resolution: { ...before, phase: 'resolving' } });
    }
    const result = await ctx.resolver.resolve();
    // 识别中途控制器可能已销毁（路由切换/扩展重载）：不再写路由/store/发起装载
    //（第 51 轮审计 P3-4 加固）
    if (ctx.disposed) return;
    if (!result) {
      await loadCandidates(ctx);
      uiStore.patch({
        resolution: { phase: 'unresolved', candidates: ctx.getCandidates() },
      });
      return;
    }
    // 保护：站点若忽略了 URL 中的 courseId（play-center 深链契约未定），
    // 以正在播放的媒体文件为准，避免把统计/问答记到另一个课次。
    const mediaHint = extractCourIdFromMediaUrlWithEvidence(ctx.player?.currentViewUrl() ?? '');
    const effective =
      result.evidence === 'url' && mediaHint && mediaHint.courId !== result.courId
        ? {
            ...result,
            courId: mediaHint.courId,
            evidence: mediaHint.evidence,
            confidence: 'direct' as const,
          }
        : result;
    if (ctx.meta?.courId === effective.courId) {
      uiStore.patch({
        resolution: {
          phase: 'resolved',
          courId: effective.courId,
          evidence: effective.evidence,
          confidence: effective.confidence,
          candidates: ctx.getCandidates(),
        },
      });
      return;
    }
    ctx.setRoute({ ...ctx.route, courId: effective.courId });
    uiStore.patch({
      resolution: {
        phase: 'resolved',
        courId: effective.courId,
        evidence: effective.evidence,
        confidence: effective.confidence,
        candidates: ctx.getCandidates(),
      },
    });
    log.info('课次已识别', { courId: effective.courId, evidence: effective.evidence, reason });
    await ctx.loadSession(effective.courId);
  } catch (err) {
    log.warn('课次识别失败', err);
    uiStore.patch({ resolution: { phase: 'unresolved', candidates: ctx.getCandidates() } });
  } finally {
    resolving = false;
    if (pendingResolve) {
      pendingResolve = false;
      void resolveAndLoad(ctx, 'queued');
    }
  }
}
