/**
 * B 站进度上报/站外学习时长统计单测（jsdom + fake timers，callOp 整体 mock）。
 *
 * 覆盖 setupProgressTracking（bilibili.content.tsx）：
 *  1. 单 P 基线（行为不变回归）：timeupdate 节流上报进度位置（距上次 ≥5s 且位置差 ≥3s）；
 *     站外时长按 timeupdate 间 delta 累计、满 30s 上报一次（stats.external.tick）；
 *  2. 口径守卫：暂停/页面隐藏期间不累计；visibilitychange(hidden) 与 pagehide 立即补报位置；
 *  3. SPA 换节点跟随（第 22 轮接线，消除「换节点后统计静默中断」）：
 *     - 同 P 连续换节点（切清晰度）：新节点首个 delta 覆盖旧节点末次 tick 到换节点后
 *       首拍的播放时间——不重复计也不漏计；
 *     - 切 P 位置跳变：首个 delta 为负被既有守卫跳过——换 P 前的位置差不计入新 P，
 *       进度位置随后跟随新 P；
 *     - 换节点后旧节点监听已解绑（旧节点残留 timeupdate 不影响统计）；
 *  4. 捕获兜底：video 晚就绪轮询捕获；超时放弃不残留定时器；卸载（onInvalidated）
 *     后停止跟随与上报。
 *
 * 时钟口径：fake timers 从 now:0 起步（lastReportedAt 初始 0 与生产同构），
 * pump 每拍推进时钟 600ms——进度上报在首拍后 ≥5s 才解锁节流，与真实 epoch 无关。
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { setupProgressTracking } from '@/entrypoints/content/ui/bili/progressTracking';

const callOpMock = callOp as unknown as Mock;

function makeVideo(): HTMLVideoElement {
  return document.createElement('video');
}

/** jsdom 的 paused/duration 是原型只读访问器：defineProperty 到实例上模拟播放状态/时长 */
function setPlaying(video: HTMLVideoElement, playing: boolean): void {
  Object.defineProperty(video, 'paused', { configurable: true, get: () => !playing });
}

function setDuration(video: HTMLVideoElement, seconds: number): void {
  Object.defineProperty(video, 'duration', { configurable: true, get: () => seconds });
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

/** 模拟播放推进：每拍 currentTime 前进 stepSec（≤5s 跳变上限），并按 ~600ms 节奏推进时钟 */
async function pump(video: HTMLVideoElement, times: number, stepSec = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    video.currentTime += stepSec;
    video.dispatchEvent(new Event('timeupdate'));
    await vi.advanceTimersByTimeAsync(600);
  }
}

/** MutationObserver 回调走微任务：多让出几轮确保换节点批次投递完成（同 video-watcher.test.ts） */
async function flushObserver(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function opArgs(op: string): unknown[] {
  return callOpMock.mock.calls.filter((call: unknown[]) => call[0] === op).map((call: unknown[]) => call[1]);
}

let cleanups: Array<() => void> = [];

function setup(bvid: string, title: string): void {
  setupProgressTracking(bvid, title, (fn) => cleanups.push(fn));
}

/** SPA 换节点：旧节点摘除、新节点同批次插入（同 video-watcher.test.ts 的替换用例） */
async function swapVideo(oldVideo: HTMLVideoElement, newVideo: HTMLVideoElement): Promise<void> {
  oldVideo.remove();
  document.body.appendChild(newVideo);
  await flushObserver();
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers({ now: 0 });
  callOpMock.mockClear();
  callOpMock.mockImplementation(async () => undefined);
  cleanups = [];
});

afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
  vi.useRealTimers();
});

describe('setupProgressTracking 单 P 基线（行为不变回归）', () => {
  it('timeupdate 节流上报进度位置（≥5s 且位置差 ≥3s）；站外时长满 30s 上报一次', async () => {
    const video = makeVideo();
    setPlaying(video, true);
    setDuration(video, 600);
    document.body.appendChild(video);
    setup('BV1Prog01', '测试视频');

    await pump(video, 10); // 40s 播放；时钟 +6s

    // 8 拍累计 32s ≥ 30s → 上报一次并清零；余 8s 不足阈值不报
    expect(opArgs('stats.external.tick')).toEqual([{ bvid: 'BV1Prog01', title: '测试视频', seconds: 32 }]);
    // 节流：首拍后 5.4s 才解锁，且位置差 ≥3s → 恰好一次（位置 40，时长取自 <video>）
    expect(opArgs('video.progress.report')).toEqual([
      { platform: 'bilibili', videoId: 'BV1Prog01', positionSec: 40, durationSec: 600, title: '测试视频' },
    ]);
  });

  it('暂停：不计站外时长（位置上报不受暂停影响，维持既有口径）', async () => {
    const video = makeVideo();
    setPlaying(video, false);
    document.body.appendChild(video);
    setup('BV1Prog01', '测试视频');

    await pump(video, 12); // 位置推进 48s，但全程暂停

    expect(opArgs('stats.external.tick')).toEqual([]);
    // 节流在第 10 拍（时钟 5.4s）解锁 → 上报当时位置 40（其后各拍均在 5s 窗口内）
    expect(opArgs('video.progress.report')).toEqual([
      { platform: 'bilibili', videoId: 'BV1Prog01', positionSec: 40, durationSec: null, title: '测试视频' },
    ]);
  });

  it('页面隐藏：不累计时长；visibilitychange(hidden) 立即补报位置；恢复可见后继续累计', async () => {
    const video = makeVideo();
    setPlaying(video, true);
    document.body.appendChild(video);
    setup('BV1Prog01', '测试视频');

    await pump(video, 8); // 32s → tick(32)；时钟 4.8s，位置上报尚被节流
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange')); // 补报位置 32（绕过节流）
    await pump(video, 4); // 隐藏期间 16s：不累计
    setVisibility('visible');
    await pump(video, 8); // 恢复后 32s → 第二笔 tick(32)

    expect(opArgs('stats.external.tick')).toEqual([
      { bvid: 'BV1Prog01', title: '测试视频', seconds: 32 },
      { bvid: 'BV1Prog01', title: '测试视频', seconds: 32 },
    ]);
    // 隐藏期的 16s 未计入（第二笔仍是 32s）；位置上报 = 补报的 32 + 恢复后的 72
    expect(opArgs('video.progress.report')).toEqual([
      { platform: 'bilibili', videoId: 'BV1Prog01', positionSec: 32, durationSec: null, title: '测试视频' },
      { platform: 'bilibili', videoId: 'BV1Prog01', positionSec: 72, durationSec: null, title: '测试视频' },
    ]);
  });

  it('pagehide 立即补报位置；同位置重复补报不重复上报；前台 visibilitychange 不补报', async () => {
    const video = makeVideo();
    setPlaying(video, true);
    document.body.appendChild(video);
    setup('BV1Prog01', '测试视频');

    await pump(video, 2); // 8s，尚无任何上报
    document.dispatchEvent(new Event('visibilitychange')); // 前台：不补报
    expect(opArgs('video.progress.report')).toEqual([]);

    window.dispatchEvent(new Event('pagehide')); // 关闭/离开：立即补报 8
    expect(opArgs('video.progress.report')).toEqual([
      { platform: 'bilibili', videoId: 'BV1Prog01', positionSec: 8, durationSec: null, title: '测试视频' },
    ]);

    window.dispatchEvent(new Event('pagehide')); // 位置未变：不重复
    expect(opArgs('video.progress.report')).toHaveLength(1);
    expect(opArgs('stats.external.tick')).toEqual([]);
  });
});

describe('setupProgressTracking SPA 换节点跟随（本次接线）', () => {
  it('同 P 连续换节点（切清晰度）：旧节点末次 tick 到新节点首拍之间的播放时间照常计入', async () => {
    const v1 = makeVideo();
    setPlaying(v1, true);
    document.body.appendChild(v1);
    setup('BV1Swap01', '换节点视频');
    await pump(v1, 8); // 32s → tick(32)；lastTickSec=32

    // 切清晰度：播放连续，新节点从 33s 继续（32→33 的 1s 是换节点空窗内的真实播放）
    const v2 = makeVideo();
    setPlaying(v2, true);
    v2.currentTime = 33;
    await swapVideo(v1, v2);

    // 旧节点已解绑：残留事件若仍被监听，会把 lastTickSec 跳到 500、吞掉后续累计
    v1.currentTime = 500;
    v1.dispatchEvent(new Event('timeupdate'));
    expect(opArgs('stats.external.tick')).toHaveLength(1);

    await pump(v2, 8); // 首拍 delta=5（37−32，含 1s 空窗）+ 7×4 = 33 → tick(33)

    // 第二笔 33s（而非重置口径下的 32s）：证明空窗播放时间被计入且未重复计
    expect(opArgs('stats.external.tick')).toEqual([
      { bvid: 'BV1Swap01', title: '换节点视频', seconds: 32 },
      { bvid: 'BV1Swap01', title: '换节点视频', seconds: 33 },
    ]);
  });

  it('切 P 位置跳变：换 P 前的位置差不计入新 P（守卫跳过），进度位置随后跟随新 P', async () => {
    const v1 = makeVideo();
    setPlaying(v1, true);
    document.body.appendChild(v1);
    setup('BV1MultiP', '多P视频');
    await pump(v1, 16); // P1：64s → tick(32)+tick(32)；位置上报 40

    // 切 P2：新节点从 0 起播（相对旧节点末次 tick 位置跳变 −64）
    const v2 = makeVideo();
    setPlaying(v2, true);
    v2.currentTime = 0;
    await swapVideo(v1, v2);

    v1.currentTime = 999; // 旧节点残留事件：不得影响任何统计
    v1.dispatchEvent(new Event('timeupdate'));

    await pump(v2, 9); // 首拍 delta=−60 被守卫跳过；之后 8×4=32 → tick(32)（纯 P2 时长）

    // 三笔 tick 均为 32s：P1 两笔 + P2 一笔，P1 的 64s 位置差没有混进 P2 的累计
    expect(opArgs('stats.external.tick')).toEqual([
      { bvid: 'BV1MultiP', title: '多P视频', seconds: 32 },
      { bvid: 'BV1MultiP', title: '多P视频', seconds: 32 },
      { bvid: 'BV1MultiP', title: '多P视频', seconds: 32 },
    ]);
    // 位置上报跟随当前播放的 P：P1 的 40 → P2 的 12（不停留在已摘除的旧节点上）
    expect(opArgs('video.progress.report')).toEqual([
      { platform: 'bilibili', videoId: 'BV1MultiP', positionSec: 40, durationSec: null, title: '多P视频' },
      { platform: 'bilibili', videoId: 'BV1MultiP', positionSec: 12, durationSec: null, title: '多P视频' },
    ]);
  });

  it('卸载（onInvalidated）：停止跟随与上报，之后换节点不再重挂', async () => {
    const v1 = makeVideo();
    setPlaying(v1, true);
    document.body.appendChild(v1);
    setup('BV1Prog01', '测试视频');
    await pump(v1, 8);
    expect(opArgs('stats.external.tick')).toHaveLength(1);

    for (const fn of cleanups) fn(); // 模拟 ctx.onInvalidated
    cleanups = [];

    await pump(v1, 4); // 旧节点监听已解绑
    const v2 = makeVideo();
    setPlaying(v2, true);
    await swapVideo(v1, v2); // watcher 已停：不捕获新节点
    await pump(v2, 4);

    expect(opArgs('stats.external.tick')).toHaveLength(1);
    expect(opArgs('video.progress.report')).toHaveLength(0);
  });
});

describe('setupProgressTracking 捕获兜底', () => {
  it('video 晚就绪（SPA 晚于内容脚本）：轮询捕获后正常统计', async () => {
    setup('BV1Late01', '晚就绪视频');
    await vi.advanceTimersByTimeAsync(600); // 尚无 video，继续等待
    const video = makeVideo();
    setPlaying(video, true);
    document.body.appendChild(video);
    await vi.advanceTimersByTimeAsync(500); // 轮询命中
    await pump(video, 8);

    expect(opArgs('stats.external.tick')).toEqual([{ bvid: 'BV1Late01', title: '晚就绪视频', seconds: 32 }]);
    expect(opArgs('video.progress.report')).toEqual([
      { platform: 'bilibili', videoId: 'BV1Late01', positionSec: 32, durationSec: null, title: '晚就绪视频' },
    ]);
  });

  it('超时无 video：放弃等待不残留定时器；之后出现的 video 不被统计', async () => {
    setup('BV1None01', '无播放器视频');
    await vi.advanceTimersByTimeAsync(21_000); // 超过 20s 等待上限
    const video = makeVideo();
    setPlaying(video, true);
    document.body.appendChild(video);
    await pump(video, 8);

    expect(opArgs('stats.external.tick')).toEqual([]);
    expect(opArgs('video.progress.report')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
