import { callOp } from '@/core/shared/client';
import { SELECTORS } from '@/core/shared/constants';
import { uiStore } from '../ui/store';
import { log } from './dom';
import type { ControllerContext } from './context';

// 统计节流时间戳自包含（内容脚本每页单实例，随模块生存；原为控制器类字段，随 D9 块迁出）
let lastTickAt = 0;
let lastSummaryAt = 0;

/** 播放器状态同步进 uiStore，并按节流上报 stats.tick / 拉取观看统计小结 */
export function syncFromPlayer(ctx: ControllerContext): void {
  const player = ctx.player;
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
  if (now - lastTickAt < 500) return;
  lastTickAt = now;
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
    interacted: Date.now() - ctx.lastInteractionAt < 2 * 60_000,
  }).catch(() => undefined);

  if (Date.now() - lastSummaryAt > 30_000) {
    lastSummaryAt = Date.now();
    void callOp('stats.sessionSummary', { courId: current.session.courId })
      .then((summary) => uiStore.patch({ watchedSec: summary.watchedSec, watchRatio: summary.watchRatio }))
      .catch(() => undefined);
  }
}

/** 大纲跳转（上一题/下一题快捷键）：定位当前节点后 seek 到相邻节点起点 */
export function stepOutline(ctx: ControllerContext, direction: -1 | 1): void {
  const outline = uiStore.getState().ai?.outline;
  if (!outline || outline.length === 0) return;
  const time = uiStore.getState().currentTime;
  const ordered = [...outline].sort((a, b) => a.start - b.start);
  let current = -1;
  for (let i = 0; i < ordered.length; i += 1) {
    if ((ordered[i]?.start ?? 0) <= time) current = i;
  }
  const next = ordered[Math.max(0, Math.min(ordered.length - 1, current + direction))];
  if (next) ctx.actions.seek(next.start);
}

/** 同步视频/进度条/右栏矩形到 uiStore（浮层与标记定位用），变化才 patch */
export function updateRects(ctx: ControllerContext): void {    const player = ctx.player;
  if (!player) return;
  const video = player.getPrimary();
  if (video) {
    const r = video.getBoundingClientRect();
    const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    if (key !== ctx.rectCache.video && r.width > 0 && r.height > 0) {
      ctx.rectCache.video = key;
      uiStore.patch({ videoRect: { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom } });
    }
  }
  const bar = document.querySelector(SELECTORS.progressBar);
  if (bar) {
    const r = bar.getBoundingClientRect();
    const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    if (key !== ctx.rectCache.timeline && r.width > 0) {
      ctx.rectCache.timeline = key;
      uiStore.patch({ timelineRect: { left: r.left, top: r.top, width: r.width, height: r.height } });
    }
  }
  const rail = document.querySelector(SELECTORS.rightRail);
  if (rail) {
    const r = rail.getBoundingClientRect();
    const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    if (key !== ctx.rectCache.rail && r.width > 0 && r.height > 0) {
      ctx.rectCache.rail = key;
      uiStore.patch({ rightRailRect: { left: r.left, top: r.top, width: r.width, height: r.height } });
    }
  } else if (ctx.rectCache.rail) {
    ctx.rectCache.rail = '';
    uiStore.patch({ rightRailRect: null });
  }
}

/** 统计结算（页面隐藏/切课/暂停时把未落库的观看时长冲进后台） */
export async function flushStats(reason: 'pause' | 'hidden' | 'switch' | 'flush'): Promise<void> {
  const courId = uiStore.getState().session?.courId;
  if (!courId) return;
  await callOp('stats.flush', { courId }).catch(() => undefined);
  log.debug('统计已结算', { reason, courId });
}
