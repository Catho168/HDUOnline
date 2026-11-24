import { callOp } from '@/core/shared/client';
import { hduMediaKey } from '@/core/shared/mediaRef';
import type { VodView } from '@/core/shared/types';
import { fetchCourseVodUrls } from '../site/api';
import { uiStore } from '../ui/store';
import { log } from './dom';
import type { ControllerContext } from './context';

// ASR 自动跟进防重入标志自包含（内容脚本每页单实例；原为控制器类字段，
// teardownPage 经 resetFollowBusy() 复位，语义与拆分前一致）
let followBusy = false;

/** 复位跟进防重入标志（路由 teardown 时由控制器调用） */
export function resetFollowBusy(): void {
  followBusy = false;
}

/** 拉取当前课次视频直链（转写/截图/自动跟进共用的新鲜音频源） */
export async function freshAudio(ctx: ControllerContext, viewNum: number): Promise<{ url: string; viewNum: number; durationSec: number } | null> {
  const courId = uiStore.getState().session?.courId;
  if (!courId) return null;
  const info = await fetchCourseVodUrls(courId).catch(() => null);
  if (!info) return null;
  const views: VodView[] = info.meta.views;
  const currentSrc = ctx.player?.currentViewUrl() ?? '';
  const chosen =
    views.find((view) => view.viewNum === viewNum) ??
    views.find((view) => view.url && currentSrc && view.url.split('?')[0] === currentSrc.split('?')[0]) ??
    views[0];
  if (!chosen?.url) return null;
  return {
    url: chosen.url,
    viewNum: chosen.viewNum ?? viewNum,
    durationSec: ctx.player?.getDuration(info.meta.durationSec) || info.meta.durationSec,
  };
}

/** ASR 窗口自动跟进：按播放位置请示后台决策，需要时换源重启转写 */
export async function followTick(ctx: ControllerContext): Promise<void> {
  const state = uiStore.getState();
  if (!state.session || !ctx.player) return;
  if (ctx.settings.asr.windowMode !== 'around' || !ctx.settings.asr.streamFollow) return;
  if (followBusy) return;
  followBusy = true;
  try {
    const viewNum = ctx.player.currentViewIndex(ctx.meta?.views);
    const followMediaKey = hduMediaKey(state.session.courId);
    const decision = await callOp('asr.follow', {
      mediaKey: followMediaKey,
      viewNum,
      aroundSec: state.currentTime,
      durationSec: state.duration,
      teclId: state.session.teclId,
      paused: state.paused,
      visible: document.visibilityState === 'visible',
      sessionId: `${state.session.courId}:${viewNum}`,
    });
    if (!decision.start) return;
    const fresh = await freshAudio(ctx, viewNum);
    if (!fresh) return;
    const { job } = await callOp('asr.start', {
      mediaKey: followMediaKey,
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
    followBusy = false;
  }
}
