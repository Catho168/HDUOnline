// 学习进度追踪（setupProgressTracking）：timeupdate 节流上报 video.progress.report，
// 页面隐藏/关闭立即补报一次；并承担站外学习时长上报（stats.external.tick，满 30s 一报）。
// 自 bilibili.content.tsx 第 41 轮巡检纯搬移拆分，上报口径与换节点 delta 规则逐行未变。

import { callOp } from '@/core/shared/client';
import { watchVideoElement } from '@/entrypoints/content/ui/videoWatcher';

/** 进度上报节流：距上次上报 ≥5s 且位置变化 ≥3s 才上报 */
const REPORT_MIN_INTERVAL_MS = 5_000;
const REPORT_MIN_DELTA_SEC = 3;

/** 站外学习时长上报阈值：累计播放满 30s 上报一次（stats.external.tick，独立于站内统计口径） */
const EXTERNAL_TICK_THRESHOLD_SEC = 30;
/** 单次 timeupdate 计入的最大间隔：timeupdate 约 4 次/秒，超过视为拖动/挂起恢复的时间跳跃 */
const EXTERNAL_TICK_MAX_DELTA_SEC = 5;

/**
 * 监听播放器事件并上报学习进度（video.progress.report）。
 * timeupdate 节流上报；页面隐藏/关闭时立即补一次。失败静默，不 toast 不阻塞播放。
 *
 * <video> 跟随：经 watchVideoElement 首次捕获并持续跟随 SPA 换节点——切 P/切清晰度
 * 替换 <video> 后自动解绑旧节点监听、重绑新节点，统计不再静默中断（第 21 轮前本监听
 * 只捕获一次、不跟随换节点，是已记入体验小项池的已知限制）。
 *
 * 换节点时的 delta 口径：累计状态（lastTickSec 等）刻意不重置——
 *  - 同 P 换节点（切清晰度）播放连续：新节点首个 timeupdate 的 delta =
 *    新节点位置 − 旧节点末次 tick 位置，恰好覆盖「旧节点末次 timeupdate 到换节点后
 *    首个 timeupdate」之间的真实播放时间，与同节点逐字同口径（不重复计也不漏计）；
 *  - 切 P / 续播跳变：首个 delta 为负或超 EXTERNAL_TICK_MAX_DELTA_SEC，被既有
 *    「拖动/挂起恢复时间跳跃」守卫跳过（lastTickSec 随该次 tick 跳到新位置）——
 *    换 P 前的位置差不会计入新 P，与同节点拖动同口径。
 *
 * 上报键均不含分 P：进度位置落 videoProgress（bilibili:<bvid>），站外时长落
 * externalWatch（<date>:<bvid> 按日聚合）——换 P 不换键；分 P 只用于字幕 mediaKey
 * （bili:<bvid>:p<N>，见 readBiliPageP / 字幕链路）。
 *
 * 同时承担站外学习时长上报（stats.external.tick）：只在「播放中 + 页面前台可见」时
 * 按 timeupdate 间 delta 累计，满 30s 上报一次并清零；页面隐藏期间不累计
 * （visibilitychange 补报机制只针对进度位置，时长累计天然不跨隐藏窗口）。
 */
export function setupProgressTracking(bvid: string, title: string, registerCleanup: (fn: () => void) => void): void {
  let disposed = false;
  let video: HTMLVideoElement | null = null;
  let lastReportedAt = 0;
  let lastReportedSec = -1;
  // 站外学习时长：自上次上报以来累计的播放秒数
  let externalAccumSec = 0;
  let lastTickSec = 0;

  const report = (positionSec: number) => {
    const el = video;
    if (disposed || !el) return;
    lastReportedAt = Date.now();
    lastReportedSec = positionSec;
    const durationSec = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
    void callOp('video.progress.report', {
      platform: 'bilibili',
      videoId: bvid,
      positionSec: Math.floor(positionSec),
      durationSec,
      title,
    }).catch(() => {
      /* 上报失败静默 */
    });
  };

  const reportExternalTick = () => {
    const seconds = Math.floor(externalAccumSec);
    externalAccumSec = 0;
    void callOp('stats.external.tick', { bvid, title, seconds }).catch(() => {
      /* 上报失败静默 */
    });
  };

  const onTimeUpdate = () => {
    const el = video;
    if (!el) return;
    const current = el.currentTime;
    if (
      Date.now() - lastReportedAt >= REPORT_MIN_INTERVAL_MS &&
      Math.abs(current - lastReportedSec) >= REPORT_MIN_DELTA_SEC
    ) {
      report(current);
    }
    // 站外时长累计：仅播放中且前台可见；负 delta（回拖）与超上限的时间跳跃不计
    const delta = current - lastTickSec;
    lastTickSec = current;
    if (!el.paused && document.visibilityState === 'visible' && delta > 0 && delta <= EXTERNAL_TICK_MAX_DELTA_SEC) {
      externalAccumSec += delta;
      if (externalAccumSec >= EXTERNAL_TICK_THRESHOLD_SEC) reportExternalTick();
    }
  };

  // 页面隐藏/关闭时立即补一次上报，避免丢掉最后一段进度
  const flush = () => {
    const el = video;
    if (el && Math.floor(el.currentTime) !== lastReportedSec) report(el.currentTime);
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  const onPageHide = () => flush();

  const watcher = watchVideoElement({
    onVideo: (el) => {
      if (disposed || video === el) return;
      // 换节点先解绑旧节点监听再绑新节点；document/window 级监听只在首次捕获时挂一次。
      // 累计状态不因换节点重置（口径见函数注释）：连续换节点 delta 无缝衔接，
      // 跳变换节点由 delta 守卫吸收，等价于同节点拖动。
      video?.removeEventListener('timeupdate', onTimeUpdate);
      const firstCapture = video === null;
      video = el;
      if (firstCapture) {
        lastTickSec = el.currentTime;
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('pagehide', onPageHide);
      }
      el.addEventListener('timeupdate', onTimeUpdate);
    },
  });

  registerCleanup(() => {
    disposed = true;
    watcher.stop();
    video?.removeEventListener('timeupdate', onTimeUpdate);
    video = null;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
  });
}
