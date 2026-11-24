/**
 * 播放页顶栏注入锚点测试（jsdom + fake timers，照 bili-subtitle-panel.test.ts 模式；
 * React 经 anchor 内部 createRoot 渲染，用 act 包裹推进）。
 *
 * 覆盖第 15 轮注入主项的关键契约：
 *  1. 顶栏存在 → chip host append 到 .play-header 末尾（append-only，站点既有节点零改动）；
 *  2. 站点 Vue 重渲染（chip host 被移除）→ 自动重挂且不产生重复节点；
 *  3. 顶栏整体移除 → chip 摘除（降级语义：浮窗胶囊回归）；
 *  4. 顶栏恢复 → 重挂；
 *  5. dispose → 全量摘除无残留（路由 teardown / onInvalidated 同路径）；
 *  6. 无顶栏创建 → 不挂载不报错（静默降级）；
 *  7. 识别链保护：带标记的注入节点被教师名解析剔除；chip 文本因 shadow 隔离天然不入 light DOM；
 *  8. uiStore.anchorChipActive 联动（App 据此隐藏浮窗胶囊保持单入口）。
 */

// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseTeacherNamesFromDom } from '@/entrypoints/content/controller/dom';
import { createPlayHeaderAnchor, type PlayHeaderAnchor } from '@/entrypoints/content/site/anchor';
import { uiStore } from '@/entrypoints/content/ui/store';
import type { SessionMeta } from '@/core/shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION: SessionMeta = {
  courId: 9001,
  teclId: 9001,
  courseName: '线性代数（模拟课程）',
  teacherNames: ['模拟教师'],
  durationSec: 2820,
  views: [],
  courLabel: '第12节',
};

function makeHeader(): HTMLElement {
  const header = document.createElement('div');
  header.className = 'play-header';
  header.innerHTML = '<span class="title">线性代数（模拟课程）</span><span class="meta">教师：模拟教师 · 第5周</span>';
  document.body.appendChild(header);
  return header;
}

/** 推进 anchor 的轮询扫描（pollMs 驱动，不依赖 jsdom 的 MutationObserver 时序） */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('play-header anchor（注入式 chip）', () => {
  // 断言失败也不能让 anchor 泄漏到后续用例（MO/定时器越界触发会造成级联假失败）
  const live: PlayHeaderAnchor[] = [];
  const track = (anchor: PlayHeaderAnchor): PlayHeaderAnchor => {
    live.push(anchor);
    return anchor;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    uiStore.patch({ session: SESSION, resolution: { phase: 'resolved', courId: 9001 }, anchorChipActive: false });
  });

  afterEach(() => {
    for (const anchor of live.splice(0)) {
      try {
        anchor.dispose();
      } catch {
        /* 清理优先 */
      }
    }
    vi.useRealTimers();
    document.body.innerHTML = '';
    uiStore.patch({ session: null, resolution: { phase: 'idle' }, anchorChipActive: false });
  });

  it('顶栏存在 → chip 挂载到末尾（append-only + uiStore 联动）', async () => {
    const header = makeHeader();
    const originalChildren = [...header.children];
    const changes: boolean[] = [];
    let anchor!: PlayHeaderAnchor;
    await act(async () => {
      anchor = createPlayHeaderAnchor({
        pollMs: 0,
        // 与 ContentController.ensurePlayHeaderAnchor 相同的联动接线
        onMountedChange: (m) => {
          changes.push(m);
          uiStore.patch({ anchorChipActive: m });
        },
      });
      await Promise.resolve();
    });
    track(anchor);

    expect(anchor.isMounted()).toBe(true);
    const host = header.querySelector('[data-hdu-anchor-chip]');
    expect(host).not.toBeNull();
    // append-only：既有子节点原样保留、chip host 在末尾
    expect([...header.children].slice(0, -1)).toEqual(originalChildren);
    expect(header.lastElementChild).toBe(host);
    // chip 内容进入独立 shadow（课程名来自同一 uiStore 会话数据）
    expect(host?.shadowRoot?.textContent).toContain('线性代数（模拟课程）');
    // 挂载状态联动（App 据此隐藏浮窗胶囊，保持单入口）
    expect(uiStore.getState().anchorChipActive).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('chip host 被站点移除（模拟 Vue 重渲染）→ 重挂且无重复', async () => {
    const header = makeHeader();
    await act(async () => {
      track(createPlayHeaderAnchor({ pollMs: 50 }));
      await Promise.resolve();
    });
    header.querySelector('[data-hdu-anchor-chip]')?.remove();

    await advance(300);

    expect(header.querySelectorAll('[data-hdu-anchor-chip]').length).toBe(1);
  });

  it('顶栏整体移除 → chip 摘除（浮窗胶囊降级语义）', async () => {
    const header = makeHeader();
    const changes: boolean[] = [];
    let anchor!: PlayHeaderAnchor;
    await act(async () => {
      anchor = createPlayHeaderAnchor({
        pollMs: 50,
        onMountedChange: (m) => {
          changes.push(m);
          uiStore.patch({ anchorChipActive: m });
        },
      });
      await Promise.resolve();
    });
    track(anchor);
    expect(anchor.isMounted()).toBe(true);
    expect(uiStore.getState().anchorChipActive).toBe(true);

    header.remove();
    await advance(300);

    expect(anchor.isMounted()).toBe(false);
    expect(uiStore.getState().anchorChipActive).toBe(false);
    expect(document.querySelectorAll('[data-hdu-anchor-chip]').length).toBe(0);
    expect(changes).toEqual([true, false]);
  });

  it('顶栏移除后恢复 → chip 重挂', async () => {
    const header = makeHeader();
    let anchor!: PlayHeaderAnchor;
    await act(async () => {
      anchor = createPlayHeaderAnchor({ pollMs: 50 });
      await Promise.resolve();
    });
    track(anchor);
    header.remove();
    await advance(300);
    expect(anchor.isMounted()).toBe(false);

    document.body.appendChild(header);
    await advance(300);

    expect(anchor.isMounted()).toBe(true);
    expect(header.querySelectorAll('[data-hdu-anchor-chip]').length).toBe(1);
  });

  it('dispose → 全量摘除无残留，定时器停止', async () => {
    const header = makeHeader();
    let anchor!: PlayHeaderAnchor;
    await act(async () => {
      anchor = createPlayHeaderAnchor({ pollMs: 50 });
      await Promise.resolve();
    });
    track(anchor);
    expect(anchor.isMounted()).toBe(true);

    await act(async () => {
      anchor.dispose();
    });

    expect(anchor.isMounted()).toBe(false);
    expect(header.querySelector('[data-hdu-anchor-chip]')).toBeNull();
    expect(uiStore.getState().anchorChipActive).toBe(false);
    // 摘除后再推进轮询：不应复活（观察器与定时器已清）
    await advance(300);
    expect(header.querySelector('[data-hdu-anchor-chip]')).toBeNull();
    expect(anchor.isMounted()).toBe(false);
  });

  it('无顶栏创建 → 静默降级不挂载不报错', () => {
    track(createPlayHeaderAnchor({ pollMs: 0 }));
    // 前置用例的 header 已在 afterEach 清空，此处 body 无顶栏
    expect(document.querySelector('.play-header')).toBeNull();
  });

  it('识别链保护：带标记注入节点被教师名解析剔除；chip 文本不入 light DOM', async () => {
    const header = makeHeader();
    header.innerHTML = '<span class="title">课程X</span><span class="meta">教师：张三</span>';
    let anchor!: PlayHeaderAnchor;
    await act(async () => {
      anchor = createPlayHeaderAnchor({ pollMs: 0 });
      await Promise.resolve();
    });
    track(anchor);
    expect(anchor.isMounted()).toBe(true);

    // shadow 隔离：chip 的课程名/课次文本不出现在顶栏 light DOM 文本里
    expect(header.textContent).not.toContain('线性代数（模拟课程）');
    expect(header.textContent).not.toContain('第12节');

    // 纵深防御：即便未来有带标记的 light DOM 注入（伪造教师字段），证据链读取也剔除它
    const decoy = document.createElement('div');
    decoy.setAttribute('data-hdu-anchor-chip', '1');
    decoy.textContent = '教师：注入污染';
    header.appendChild(decoy);
    expect(parseTeacherNamesFromDom()).toEqual(['张三']);
  });
});
