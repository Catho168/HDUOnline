/**
 * 学习周报 / 月报卡 UI 冒烟测试（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，
 * 照 plan-menu.test.ts 模式；callOp 整体 mock）。
 *
 * 覆盖：
 *  1. 挂载即按默认项「近 8 周」发起 stats.period，渲染数字卡 / 趋势条 / 逐周明细与计划完成度；
 *  2. 切换「本月」重新按 { kind: 'month', count: 1 } 取数，标题与复习保持率口径联动；
 *  3. 空计划排期（plan = null）显示「无计划排期」，复习空数据显示「无复习数据」。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { PeriodReportCard } from '@/entrypoints/content/ui/LearningCenter';
import { dayKeyToTs } from '@/core/shared/utils';
import type { PeriodReport } from '@/core/stats/period';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const WEEK_REPORT: PeriodReport = {
  kind: 'week',
  count: 2,
  todayKey: '2026-05-06',
  buckets: [
    {
      key: '2026-04-27',
      label: '04-27–05-03',
      chartLabel: '04-27',
      kind: 'week',
      startDay: '2026-04-27',
      endDay: '2026-05-03',
      startTs: dayKeyToTs('2026-04-27'),
      endTs: dayKeyToTs('2026-05-04'),
      internalSec: 300,
      externalSec: 0,
      activeDays: 1,
      flowCount: 1,
      plan: null,
    },
    {
      key: '2026-05-04',
      label: '05-04–05-10',
      chartLabel: '05-04',
      kind: 'week',
      startDay: '2026-05-04',
      endDay: '2026-05-10',
      startTs: dayKeyToTs('2026-05-04'),
      endTs: dayKeyToTs('2026-05-11'),
      internalSec: 600,
      externalSec: 180,
      activeDays: 2,
      flowCount: 3,
      plan: { total: 4, finished: 2, touched: 1, ratio: 0.5 },
    },
  ],
  totalInternalSec: 900,
  totalExternalSec: 180,
  generatedAt: dayKeyToTs('2026-05-06') + 20 * 3600_000,
};

const MONTH_REPORT: PeriodReport = {
  kind: 'month',
  count: 1,
  todayKey: '2026-05-06',
  buckets: [
    {
      key: '2026-05',
      label: '2026年5月',
      chartLabel: '5月',
      kind: 'month',
      startDay: '2026-05-01',
      endDay: '2026-05-31',
      startTs: dayKeyToTs('2026-05-01'),
      endTs: dayKeyToTs('2026-06-01'),
      internalSec: 3600,
      externalSec: 900,
      activeDays: 4,
      flowCount: 9,
      review: { reviewed: 4, retained: 1, ratio: 0.25 },
    },
  ],
  totalInternalSec: 3600,
  totalExternalSec: 900,
  generatedAt: WEEK_REPORT.generatedAt,
};

function periodCalls(): Array<{ kind: string; count?: number }> {
  return callOpMock.mock.calls
    .filter((args) => args[0] === 'stats.period')
    .map((args) => args[1] as { kind: string; count?: number });
}

let host: HTMLElement;
let root: Root;

async function renderCard(): Promise<void> {
  await act(async () => {
    root.render(createElement(PeriodReportCard));
  });
  // 让挂载触发的 callOp → setState 异步链落定
  await act(async () => {});
}

function pillButton(label: string): HTMLButtonElement {
  const el = Array.from(host.querySelectorAll<HTMLButtonElement>('.hdu-pill-tab')).find((b) => b.textContent === label);
  if (!el) throw new Error(`pill tab not found: ${label}`);
  return el;
}

async function clickPill(label: string): Promise<void> {
  await act(async () => {
    pillButton(label).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
  callOpMock.mockResolvedValue(WEEK_REPORT);
});

afterEach(() => {
  act(() => root.unmount());
});

describe('学习周报 / 月报卡（统计页）', () => {
  it('挂载按默认「近 8 周」取数，渲染周报数字卡、趋势与逐周明细（含计划完成度与无排期降级）', async () => {
    await renderCard();

    expect(periodCalls()).toEqual([{ kind: 'week', count: 8 }]);
    // 周报标题 + pill 切换：周期四项（默认项选中）+ 分享档位两项（第 237 轮，精简默认选中）
    expect(host.textContent).toContain('学习周报');
    const pills = Array.from(host.querySelectorAll<HTMLButtonElement>('.hdu-pill-tab')).map((b) => b.textContent);
    expect(pills).toEqual(['本周', '近 8 周', '本月', '近 6 月', '精简', '完整']);
    expect(pillButton('近 8 周').getAttribute('aria-selected')).toBe('true');
    expect(pillButton('精简').getAttribute('aria-selected')).toBe('true');
    expect(pillButton('完整').getAttribute('aria-selected')).toBe('false');

    // 当前周期数字卡：站内 / 站外 / 活跃 / 计划完成度
    expect(host.textContent).toContain('05-04–05-10 站内学习');
    expect(host.textContent).toContain('0.2'); // 600s = 0.2 小时
    expect(host.textContent).toContain('流水 3 条');
    expect(host.textContent).toContain('活跃天数');
    expect(host.textContent).toContain('完看 2 / 计划 4 个');

    // 趋势条形（纯 CSS 柱）与逐周明细
    expect(host.querySelectorAll('.hdu-bar-col').length).toBeGreaterThanOrEqual(2);
    expect(host.textContent).toContain('04-27–05-03');
    expect(host.textContent).toContain('站内 5 分钟');
    expect(host.textContent).toContain('站外 3 分钟'); // 180s
    expect(host.textContent).toContain('无计划排期'); // plan = null 的降级展示
    // 完成度徽标（2/4 完看）
    expect(host.textContent).toContain('2/4 完看');
  });

  it('切换「本月」按 { kind: month, count: 1 } 重新取数，标题与复习保持率联动', async () => {
    await renderCard();
    callOpMock.mockClear();
    callOpMock.mockResolvedValue(MONTH_REPORT);

    await clickPill('本月');

    expect(periodCalls()).toEqual([{ kind: 'month', count: 1 }]);
    expect(host.textContent).toContain('学习月报');
    expect(pillButton('本月').getAttribute('aria-selected')).toBe('true');
    expect(host.textContent).toContain('复习保持率');
    expect(host.textContent).toContain('1 / 4 个收藏期内复习过');
    expect(host.textContent).toContain('25% 保持');
    expect(host.textContent).toContain('2026年5月');
    // 周报专属的计划完成度卡不再出现
    expect(host.textContent).not.toContain('完看 2 / 计划 4 个');
  });

  it('取数失败降级为空态文案，不抛错', async () => {
    callOpMock.mockRejectedValue(new Error('rpc down'));
    await renderCard();
    expect(host.textContent).toContain('周期报表暂不可用');
    expect(host.textContent).toContain('近 8 周'); // 切换 pill 仍渲染
  });
});
