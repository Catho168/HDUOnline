/**
 * 学习中心视图切换过渡与滚动位置策略渲染测试（第 252 轮巡检，视图域 / 体验视角；
 * jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，照 overlay-aria.test.ts
 * 桩模式；callOp 整体 mock，视图切换经真实导航钮 + bindActions 最小实现走通）。
 *
 * 动画本身（.18s opacity 淡入）在 jsdom 无布局引擎无法断言，锁结构与类名约定：
 *  1. 首挂载：.hdu-content-inner 不带 hdu-view-fade 类（面板打开首帧不播动画——
 *     viewFadeOn 初始 false，首次 effect 视图未变不置位）；
 *  2. 点击侧栏「学习统计」→ 内容区 .hdu-content-inner 带 hdu-view-fade 类
 *     （key={view} 重挂载后 CSS 动画随挂载播一次）；
 *  3. 滚动位置策略统一「切换后回到顶部」：切换前把 .hdu-content scrollTop 拨到
 *     500，切换后归 0（此前滚动容器跨视图持久，不重置会带着旧偏移落在下一视图
 *     中部——审计探查结论）；
 *  4. 再切回「总览」：fade 类保持（后续每次切换均播）。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({
  callOp: vi.fn(),
  onBackgroundEvent: vi.fn(() => () => undefined),
}));

import { callOp } from '@/core/shared/client';
import { LearningCenter } from '@/entrypoints/content/ui/LearningCenter';
import { uiStore } from '@/entrypoints/content/ui/store';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

let host: HTMLElement;
let root: Root;

/** 兜底桩：命中查表原样返回，未知 op 一律回 []（结构断言只看渲染，不关心数据流）。
 *  stats.report 必须显式给 null——兜底 [] 会被 OverviewView 当报表对象读 .goal 而炸
 *  （照 overlay-aria.test.ts 的同款桩约定）。 */
function stubAnyOps(table: Record<string, unknown> = {}): void {
  callOpMock.mockImplementation(async (op: string) => {
    if (op in table) return table[op];
    if (op === 'stats.report') return null;
    return [];
  });
}

async function renderCenter(): Promise<void> {
  await act(async () => {
    root.render(createElement(LearningCenter));
  });
  // 让挂载触发的多级异步链（callOp → setState）完全落定
  for (let i = 0; i < 3; i += 1) await act(async () => {});
}

async function clickNav(label: string): Promise<void> {
  const btn = [...host.querySelectorAll('.hdu-nav-item')].find((n) => n.textContent?.includes(label));
  if (!btn) throw new Error(`nav item not found: ${label}`);
  await act(async () => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
  // 单例 store 隔离：视图回总览、绑定最小 setCenterView（真实现即 patch centerView）
  uiStore.patch({ centerView: 'overview', centerDataVersion: 0 });
  uiStore.bindActions({ setCenterView: (view) => uiStore.patch({ centerView: view }) });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host.remove();
});

describe('LearningCenter 视图切换过渡与滚动位置（第 252 轮）', () => {
  it('首挂载：hdu-content-inner 不带 hdu-view-fade（首帧不播动画）', async () => {
    stubAnyOps();
    await renderCenter();
    const inner = host.querySelector('.hdu-content-inner');
    expect(inner).not.toBeNull();
    expect(inner?.classList.contains('hdu-view-fade')).toBe(false);
  });

  it('点击「学习统计」：hdu-content-inner 带 hdu-view-fade，视图切到统计页', async () => {
    stubAnyOps();
    await renderCenter();
    await clickNav('学习统计');
    const inner = host.querySelector('.hdu-content-inner');
    expect(inner?.classList.contains('hdu-view-fade')).toBe(true);
    expect(uiStore.getState().centerView).toBe('stats');
    // 统计页标题进顶栏（视图真实切换，不是空转 patch）
    expect(host.querySelector('.hdu-topbar-title')?.textContent).toContain('学习统计');
  });

  it('切换后滚动位置回到顶部（此前跨视图持久不重置的审计修齐）', async () => {
    stubAnyOps();
    await renderCenter();
    const scroller = host.querySelector('.hdu-content') as HTMLElement | null;
    expect(scroller).not.toBeNull();
    // 拨一个非零偏移模拟「统计页滚到中部」
    scroller!.scrollTop = 500;
    await clickNav('学习统计');
    expect(scroller!.scrollTop).toBe(0);
  });

  it('切回「总览」：fade 类保持（后续切换均播）', async () => {
    stubAnyOps();
    await renderCenter();
    await clickNav('学习统计');
    await clickNav('总览');
    const inner = host.querySelector('.hdu-content-inner');
    expect(inner?.classList.contains('hdu-view-fade')).toBe(true);
    expect(uiStore.getState().centerView).toBe('overview');
  });
});
