/**
 * 共享 BiliWatchCard（第 28 轮任务 B-3 抽取）单测。
 *
 * 背景：B 站视频学习统计卡原内联在学习中心 StatsView，抽取到
 * src/entrypoints/content/ui/BiliWatchCard.tsx 后由 Dashboard「本周学习」摘要区复用。
 * 两处差异只有一个：Dashboard 固定本周口径（props range='week'，不渲染周/月切换），
 * 学习中心保持内部切换（缺省 props，行为不变）。
 *
 * 覆盖（有数据 / 空态 / 失败重试态沿用同一实现，仅验证固定区间形态）：
 *  1. range='week'：挂载即按 { kind: 'week' } 取数、渲染 TopN 数据、不出现「本月」切换；
 *  2. range='week' + 空数据 → 「还没有站外观看记录」空态；
 *  3. range='week' + 取数失败 → 「加载失败 + 重试」，重试成功后渲染数据；
 *  4. 缺省 props → 仍渲染「本月」切换 tab（学习中心侧行为不变）。
 *
 * jsdom + react-dom 客户端渲染，无 JSX、直接 createElement（照 bili-polish.test.ts 模式）。
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
import { BiliWatchCard } from '@/entrypoints/content/ui/BiliWatchCard';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const OVERVIEW = {
  range: { kind: 'week' as const, startDay: '2026-01-05', endDay: '2026-01-11' },
  top: [{ bvid: 'BV1Top01', title: '拓扑学导论', totalSec: 600, share: 1 }],
  recent: [],
  streakDays: 3,
};

/** stats.bili.overview 桩（BiliWatchCard 只发这一个 op；overrides 覆盖返回/抛错） */
function stubOverview(impl: () => Promise<unknown>): void {
  callOpMock.mockImplementation(async (op: string) => {
    if (op !== 'stats.bili.overview') throw new Error(`unexpected op: ${op}`);
    return impl();
  });
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  await act(async () => {});
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

function buttonWithText(text: string): HTMLButtonElement {
  const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
});

describe('BiliWatchCard 固定区间形态（Dashboard range=week）', () => {
  it('挂载按 { kind: week } 取数，渲染 TopN 数据，且不渲染周/月切换', async () => {
    stubOverview(() => Promise.resolve(OVERVIEW));
    await renderElement(createElement(BiliWatchCard, { range: 'week' }));

    expect(callOpMock).toHaveBeenCalledWith('stats.bili.overview', { kind: 'week' });
    expect(host.textContent).toContain('B 站视频');
    expect(host.textContent).toContain('拓扑学导论');
    expect(host.textContent).toContain('连续 3 天');
    // 固定区间形态：无「本月」切换项（学习中心形态才有 PillTabs）
    expect(host.textContent).not.toContain('本月');
    expect(host.textContent).toContain('本周观看 TopN');
  });

  it('空数据 → 「还没有站外观看记录」空态（沿用共享实现）', async () => {
    stubOverview(() => Promise.resolve({ range: OVERVIEW.range, top: [], recent: [], streakDays: 0 }));
    await renderElement(createElement(BiliWatchCard, { range: 'week' }));

    expect(host.textContent).toContain('还没有站外观看记录');
    expect(host.textContent).not.toContain('加载失败');
  });

  it('取数失败 → 「加载失败 + 重试」；重试成功后渲染数据（沿用共享实现）', async () => {
    stubOverview(() => Promise.reject(new Error('rpc down')));
    await renderElement(createElement(BiliWatchCard, { range: 'week' }));
    expect(host.textContent).toContain('加载失败');
    expect(host.textContent).not.toContain('还没有站外观看记录');

    stubOverview(() => Promise.resolve(OVERVIEW));
    await clickAsync(buttonWithText('重试'));
    expect(callOpMock).toHaveBeenCalledTimes(2);
    expect(callOpMock).toHaveBeenLastCalledWith('stats.bili.overview', { kind: 'week' });
    expect(host.textContent).toContain('拓扑学导论');
    expect(host.textContent).not.toContain('加载失败');
  });
});

describe('BiliWatchCard 缺省形态（学习中心，行为不变）', () => {
  it('不传 range：保留周/月 PillTabs，切换到本月按 { kind: month } 取数', async () => {
    stubOverview(() => Promise.resolve(OVERVIEW));
    await renderElement(createElement(BiliWatchCard));

    expect(callOpMock).toHaveBeenCalledWith('stats.bili.overview', { kind: 'week' });
    const monthTab = buttonWithText('本月');

    stubOverview(() => Promise.resolve({ ...OVERVIEW, range: { ...OVERVIEW.range, kind: 'month' as const } }));
    await clickAsync(monthTab);
    expect(callOpMock).toHaveBeenLastCalledWith('stats.bili.overview', { kind: 'month' });
    expect(host.textContent).toContain('拓扑学导论');
  });
});
