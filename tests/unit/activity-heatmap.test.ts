/**
 * 学习热力图组件单测（第 77/78 轮巡检，jsdom + react-dom 客户端渲染，无 JSX、
 * 直接 createElement，照 bili-hub-today-card.test.ts 模式；callOp 整体 mock）。
 *
 * 覆盖：挂载取数（stats.heatmap 缺省 26 周）与网格/图例/汇总渲染、
 * 周数切换（近 13/26/52 周 PillTabs → 以新周数重新取数重绘）、失败态可重试。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { ActivityHeatmap } from '@/entrypoints/content/ui/learning/ActivityHeatmap';
import { buildActivityHeatmap } from '@/core/stats/heatmap';
import { uiStore } from '@/entrypoints/content/ui/store';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

let host: HTMLElement;
let root: Root;

function heatData(weeks: number) {
  return buildActivityHeatmap({ now: Date.now(), weeks });
}

function stubHeatmap(): void {
  callOpMock.mockImplementation(async (op: string, args?: { weeks?: number }) => {
    if (op !== 'stats.heatmap') throw new Error(`unexpected op: ${op}`);
    return heatData(args?.weeks ?? 26);
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
  stubHeatmap();
  // 重置热力图窗口持久化（第 141 轮起组件状态写入 settings.ui，避免跨用例污染）
  const settings = uiStore.getState().settings;
  uiStore.patch({ settings: { ...settings, ui: { ...settings.ui, heatmapWeekOption: undefined, heatmapMonthOption: undefined } } });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

describe('ActivityHeatmap 组件', () => {
  it('挂载取数 stats.heatmap（缺省 26 周）并渲染网格/图例/汇总', async () => {
    await act(async () => {
      root.render(createElement(ActivityHeatmap));
    });
    await act(async () => {});
    expect(callOpMock).toHaveBeenCalledWith('stats.heatmap', { weeks: 26 });
    expect(document.querySelectorAll('.hdu-heatmap-grid')).toHaveLength(1);
    expect(document.querySelectorAll('.hdu-heatmap-cell')).toHaveLength(26 * 7);
    expect(document.querySelectorAll('.hdu-heatmap-legend i')).toHaveLength(5);
    expect(document.querySelector('.hdu-heatmap-foot')?.textContent).toContain('近 26 周');
    // 月份标注与星期纵轴在场
    expect(document.querySelector('.hdu-heatmap-months')).not.toBeNull();
    expect(document.querySelector('.hdu-heatmap-axis')).not.toBeNull();
  });

  it('周数切换：点「近 13 周」→ 以 weeks=13 重新取数并重绘', async () => {
    await act(async () => {
      root.render(createElement(ActivityHeatmap));
    });
    await act(async () => {});
    const pill = [...document.querySelectorAll('.hdu-pill-tab')].find((el) => el.textContent === '近 13 周');
    expect(pill).not.toBeNull();
    await act(async () => {
      (pill as HTMLButtonElement).click();
    });
    await act(async () => {});
    expect(callOpMock).toHaveBeenLastCalledWith('stats.heatmap', { weeks: 13 });
    expect(document.querySelectorAll('.hdu-heatmap-cell')).toHaveLength(13 * 7);
    expect(document.querySelector('.hdu-heatmap-foot')?.textContent).toContain('近 13 周');
  });

  it('取数失败显示失败态，重试成功后恢复网格', async () => {
    callOpMock.mockImplementation(async () => {
      throw new Error('db down');
    });
    await act(async () => {
      root.render(createElement(ActivityHeatmap));
    });
    await act(async () => {});
    expect(document.querySelector('.hdu-empty-title')?.textContent).toBe('热力图暂不可用');
    stubHeatmap();
    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === '重试');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry!.click();
    });
    await act(async () => {});
    expect(document.querySelectorAll('.hdu-heatmap-cell')).toHaveLength(26 * 7);
  });
});
