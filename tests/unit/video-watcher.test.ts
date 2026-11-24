/**
 * videoWatcher 单测（jsdom + fake timers）：B 站 SPA 播放器 <video> 捕获/跟随基建。
 *
 * 覆盖体验小项池两项的机制层：
 *  1. waitForVideoElement：SPA 晚就绪兜底（轮询到出现为止 / 超时放弃不无限轮询）；
 *  2. watchVideoElement：首次捕获、stop() 取消等待与跟随（关面板即停轮询）、
 *     SPA 替换 <video> 节点后重新捕获（MutationObserver 跟随，is-current 重挂的底座）。
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForVideoElement, watchVideoElement } from '@/entrypoints/content/ui/videoWatcher';

function makeVideo(): HTMLVideoElement {
  return document.createElement('video');
}

/** MutationObserver 回调走微任务：多让出几轮确保变更批次投递完成 */
async function flushObserver(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForVideoElement（一次性等待）', () => {
  it('video 已存在：立即解析出该元素', async () => {
    const video = makeVideo();
    document.body.appendChild(video);
    const promise = waitForVideoElement(1000, 100);
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBe(video);
  });

  it('video 晚就绪：轮询等到出现为止（SPA 晚于内容脚本就绪的兜底）', async () => {
    const promise = waitForVideoElement(10_000, 500);
    let resolved: HTMLVideoElement | null | undefined;
    void promise.then((v) => {
      resolved = v;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBeUndefined(); // 仍未出现，继续等待

    const video = makeVideo();
    document.body.appendChild(video);
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(video);
  });

  it('超时未出现：解析 null 并停止轮询（不残留定时器空转）', async () => {
    const promise = waitForVideoElement(1000, 400);
    let resolved: HTMLVideoElement | null | undefined;
    void promise.then((v) => {
      resolved = v;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(resolved).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    // 之后再出现 video 也不再回调（轮询已放弃）
    document.body.appendChild(makeVideo());
    await vi.advanceTimersByTimeAsync(2000);
    expect(resolved).toBeNull();
  });
});

describe('watchVideoElement（持续跟随）', () => {
  it('video 已存在：立即捕获并进入跟随', async () => {
    const video = makeVideo();
    document.body.appendChild(video);
    const seen: HTMLVideoElement[] = [];
    const watcher = watchVideoElement({ onVideo: (v) => seen.push(v) });
    expect(seen).toEqual([video]);
    expect(watcher.getCurrent()).toBe(video);
    watcher.stop();
  });

  it('video 晚就绪：轮询捕获后进入跟随（首次挂载兜底保留）', async () => {
    const seen: HTMLVideoElement[] = [];
    const watcher = watchVideoElement({ onVideo: (v) => seen.push(v), timeoutMs: 10_000, stepMs: 500 });
    expect(seen).toHaveLength(0);

    const video = makeVideo();
    document.body.appendChild(video);
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual([video]);
    expect(watcher.getCurrent()).toBe(video);
    watcher.stop();
  });

  it('stop() 取消尚未命中的等待轮询：之后 video 才出现也不回调（关面板即停轮询）', async () => {
    const seen: HTMLVideoElement[] = [];
    const watcher = watchVideoElement({ onVideo: (v) => seen.push(v), timeoutMs: 10_000, stepMs: 500 });
    watcher.stop();

    document.body.appendChild(makeVideo());
    await vi.advanceTimersByTimeAsync(3000);
    expect(seen).toHaveLength(0);
    // 轮询定时器已被清理，不残留
    expect(vi.getTimerCount()).toBe(0);
  });

  it('超时放弃：一直无 video 时到上限停轮询（不无限空转）', async () => {
    const seen: HTMLVideoElement[] = [];
    const watcher = watchVideoElement({ onVideo: (v) => seen.push(v), timeoutMs: 1000, stepMs: 400 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    watcher.stop();
  });

  it('SPA 替换 <video> 节点（同批次先删后插）：重新捕获新节点（切 P/切清晰度重挂底座）', async () => {
    const video1 = makeVideo();
    document.body.appendChild(video1);
    const seen: HTMLVideoElement[] = [];
    const watcher = watchVideoElement({ onVideo: (v) => seen.push(v) });
    expect(seen).toEqual([video1]);

    const video2 = makeVideo();
    video1.remove();
    document.body.appendChild(video2);
    await flushObserver();
    expect(seen).toEqual([video1, video2]);
    expect(watcher.getCurrent()).toBe(video2);

    // 再次替换仍跟随
    const video3 = makeVideo();
    video2.remove();
    document.body.appendChild(video3);
    await flushObserver();
    expect(seen).toEqual([video1, video2, video3]);
    watcher.stop();
  });

  it('删除与插入之间有空窗：空窗期不误回调，新节点出现即捕获', async () => {
    const video1 = makeVideo();
    document.body.appendChild(video1);
    const seen: HTMLVideoElement[] = [];
    const watcher = watchVideoElement({ onVideo: (v) => seen.push(v) });
    expect(seen).toEqual([video1]);

    video1.remove();
    await flushObserver();
    expect(seen).toEqual([video1]); // 空窗期无新 video：不追加回调

    const video2 = makeVideo();
    document.body.appendChild(video2);
    await flushObserver();
    expect(seen).toEqual([video1, video2]);
    watcher.stop();
  });

  it('stop() 后停止跟随：节点替换不再回调', async () => {
    const video1 = makeVideo();
    document.body.appendChild(video1);
    const seen: HTMLVideoElement[] = [];
    const watcher = watchVideoElement({ onVideo: (v) => seen.push(v) });
    expect(seen).toEqual([video1]);
    watcher.stop();

    const video2 = makeVideo();
    video1.remove();
    document.body.appendChild(video2);
    await flushObserver();
    expect(seen).toEqual([video1]);
    expect(watcher.getCurrent()).toBe(video1);
  });

  it('video 在 DOM 内移动（未替换成新节点）：不触发重复回调', async () => {
    const video = makeVideo();
    const wrap1 = document.createElement('div');
    wrap1.appendChild(video);
    document.body.appendChild(wrap1);
    const seen: HTMLVideoElement[] = [];
    const watcher = watchVideoElement({ onVideo: (v) => seen.push(v) });
    expect(seen).toEqual([video]);

    const wrap2 = document.createElement('div');
    wrap2.appendChild(video); // reparent：旧位置删除 + 新位置插入，同一元素
    document.body.appendChild(wrap2);
    await flushObserver();
    expect(seen).toEqual([video]);
    watcher.stop();
  });
});
