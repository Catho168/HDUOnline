/**
 * 周报摘要三端对齐 UI 冒烟测试（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，
 * 照 stats-period-ui.test.ts / two-step-confirm.test.ts 模式；callOp 整体 mock）。
 *
 * 覆盖第 11 轮任务 B（周报三端对齐，小-中项）：popup 精简摘要与 dashboard「本周学习」卡
 * 必须与学习中心统计页 PeriodReportCard「本周」视图完全同源——同一个 stats.period op、
 * 同参数 { kind: 'week', count: 1 }（对应 LearningCenter PERIOD_OPTIONS 的 w1 项，
 * 聚合口径见 core/stats/period 纯函数；展示格式：小时 = (秒/3600).toFixed(1)、完成度 = Math.round*100%）。
 *
 * 覆盖：
 *  1. popup 挂载即按 { kind: 'week', count: 1 } 取数，紧凑区渲染站内 / 站外小时、活跃天数与计划完成度；
 *  2. popup 取数失败静默降级：不渲染本周区，popup 其余内容不受影响；
 *  3. dashboard 概览按 { kind: 'week', count: 1 } 取数，「本周学习」卡逐项渲染与周报同源的数字卡；
 *  4. dashboard 取数失败静默降级：不渲染该卡，概览其余区块不受影响；
 *  5. dashboard「本周学习」区旁的 B 站视频统计卡（第 28 轮接入共享 BiliWatchCard，固定本周口径）：
 *     按 { kind: 'week' } 取数并渲染 TopN；stats.period 失败不影响该卡自身的空态/数据渲染。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { App as PopupApp } from '@/entrypoints/popup/App';
import { Overview } from '@/entrypoints/dashboard/App';
import { dayKeyToTs } from '@/core/shared/utils';
import type { PeriodReport } from '@/core/stats/period';
import type { DashboardReport } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/**
 * 周报固件：单周期（本周）桶，数字取整核对：
 * internalSec 9000 → 2.5 小时；externalSec 3600 → 1.0 小时；plan ratio 0.5 → 50%。
 */
const WEEK_REPORT: PeriodReport = {
  kind: 'week',
  count: 1,
  todayKey: '2026-05-06',
  buckets: [
    {
      key: '2026-05-04',
      label: '05-04–05-10',
      chartLabel: '05-04',
      kind: 'week',
      startDay: '2026-05-04',
      endDay: '2026-05-10',
      startTs: dayKeyToTs('2026-05-04'),
      endTs: dayKeyToTs('2026-05-11'),
      internalSec: 9000,
      externalSec: 3600,
      activeDays: 3,
      flowCount: 7,
      plan: { total: 4, finished: 2, touched: 1, ratio: 0.5 },
    },
  ],
  totalInternalSec: 9000,
  totalExternalSec: 3600,
  generatedAt: dayKeyToTs('2026-05-06') + 20 * 3600_000,
};

/** 概览最小报表（stats.report 桩，照 two-step-confirm.test.ts 的 REPORT；days 为空避开图表分支） */
const REPORT: DashboardReport = {
  totalSec: 7200,
  weekSec: 1800,
  todaySec: 300,
  externalSeconds: 600,
  streakDays: 3,
  days: [],
  weeks: [],
  courses: [],
  sessions: [],
  goal: { weeklyTargetSec: 18000, weekSec: 1800, hitDaysThisWeek: 2 },
  generatedAt: 0,
};

/** popup 环境的最小 chrome 桩：tabs.query 返回活动标签；sendMessage 抛错模拟内容脚本未注入（popup 自行捕获）。
    storage 缺省 → extStorage 走内存兜底（见 tests/unit/setup.ts 说明） */
function installChromeStub(): void {
  (globalThis as unknown as { chrome?: unknown }).chrome = {
    tabs: {
      query: vi.fn(async () => [{ id: 7 }]),
      sendMessage: vi.fn(async () => {
        throw new Error('no content script');
      }),
      create: vi.fn(),
    },
    runtime: {
      openOptionsPage: vi.fn(),
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
  };
}

/** 记录 stats.period 的取数参数（断言三端口径：必须为 { kind: 'week', count: 1 }） */
function periodCalls(): Array<{ kind: string; count?: number }> {
  return callOpMock.mock.calls
    .filter((args) => args[0] === 'stats.period')
    .map((args) => args[1] as { kind: string; count?: number });
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  // 让挂载触发的多级异步链（loadSettings / tabs.query / callOp → setState）完全落定
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {});
  }
}

/** 取 dashboard 数字卡的值（StatCard 结构：.hdu-stat 内 .hdu-stat-top 含 label） */
function statValue(label: string): string {
  const card = Array.from(host.querySelectorAll('.hdu-stat')).find((el) =>
    el.querySelector('.hdu-stat-top')?.textContent?.includes(label),
  );
  const value = card?.querySelector('.hdu-stat-value')?.textContent;
  if (value == null) throw new Error(`stat card not found: ${label}`);
  return value;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('popup 本周摘要（stats.period 精简区）', () => {
  function stubPopupOps(periodResult: unknown): void {
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'stats.report') return REPORT;
      if (op === 'course.bundles') return [];
      if (op === 'stats.period') {
        if (periodResult instanceof Error) throw periodResult;
        return periodResult;
      }
      throw new Error(`unexpected op: ${op}`);
    });
  }

  it('挂载按 { kind: week, count: 1 } 取数（与学习中心「本周」同参数），渲染站内 / 站外小时、活跃天数与计划完成度', async () => {
    installChromeStub();
    stubPopupOps(WEEK_REPORT);
    await renderElement(createElement(PopupApp));

    // 口径断言：与学习中心 PERIOD_OPTIONS w1 项完全同参
    expect(periodCalls()).toEqual([{ kind: 'week', count: 1 }]);
    expect(host.textContent).toContain('本周学习');
    // 数字断言：展示格式与 PeriodReportCard 对齐（小时 toFixed(1)、完成度 Math.round*100%）
    expect(host.textContent).toContain('站内 2.5 小时'); // internalSec 9000
    expect(host.textContent).toContain('站外 1.0 小时'); // externalSec 3600
    expect(host.textContent).toContain('活跃 3 天');
    expect(host.textContent).toContain('计划完成 50%');
  });

  it('stats.period 失败静默降级：不渲染本周区，popup 其余内容不受影响', async () => {
    installChromeStub();
    stubPopupOps(new Error('rpc down'));
    await renderElement(createElement(PopupApp));

    expect(periodCalls()).toHaveLength(1);
    expect(host.textContent).not.toContain('本周学习');
    expect(host.textContent).toContain('数据只保存在本机'); // popup 页面骨架仍在
  });
});

describe('dashboard「本周学习」卡（stats.period 概览摘要）', () => {
  /** stats.bili.overview 空数据桩（BiliWatchCard 挂载即取；个别用例覆盖为有数据/失败） */
  const BILI_EMPTY = { range: { kind: 'week', startDay: '2026-05-04', endDay: '2026-05-10' }, top: [], recent: [], streakDays: 0 };

  function stubDashboardOps(periodResult: unknown, biliOverviewResult: unknown = BILI_EMPTY): void {
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'stats.report') return REPORT;
      if (op === 'stats.period') {
        if (periodResult instanceof Error) throw periodResult;
        return periodResult;
      }
      if (op === 'stats.bili.overview') {
        if (biliOverviewResult instanceof Error) throw biliOverviewResult;
        return biliOverviewResult;
      }
      throw new Error(`unexpected op: ${op}`);
    });
  }

  it('概览按 { kind: week, count: 1 } 取数，「本周学习」卡逐项渲染与周报同源的数字卡', async () => {
    stubDashboardOps(WEEK_REPORT);
    await renderElement(createElement(Overview, { notify: vi.fn() }));

    // 口径断言：与学习中心 PERIOD_OPTIONS w1 项完全同参；第 235 轮起新增 count: 8
    // 的周达成史取数（周目标连续达成计数，见 core/stats/period.weeklyGoalStreak），
    // 与 w1 数字卡口径分离、互不改动
    expect(periodCalls()).toEqual([
      { kind: 'week', count: 1 },
      { kind: 'week', count: 8 },
    ]);
    expect(host.textContent).toContain('本周学习');
    expect(host.textContent).toContain('05-04–05-10 · 与学习中心统计页「本周」同口径');
    // 逐项数字断言（StatCard 的 value + unit 文本节点拼接）
    expect(statValue('站内学习')).toBe('2.5小时');
    expect(statValue('站外视频')).toBe('1.0小时');
    expect(statValue('活跃天数')).toBe('3天');
    expect(statValue('计划完成度')).toBe('50%');
    expect(host.textContent).toContain('完看 2 / 计划 4 个');
    // 本周目标达成 7 日格（第 257 轮）：与学习中心同款组件接在「本周目标」卡内；
    // REPORT.days 为空固件 → 全部未达标，foot 摘要行恒渲染（判定细节由
    // daily-goal-calendar / onboarding-goal-calendar-ui 专测锁定）
    expect(host.textContent).toContain('本周达标');
    expect(host.textContent).toContain('每日目标 30 分钟');
  });

  it('stats.period 失败静默降级：不渲染「本周学习」卡，概览其余区块不受影响', async () => {
    stubDashboardOps(new Error('rpc down'));
    await renderElement(createElement(Overview, { notify: vi.fn() }));

    // w1 数字卡 + w8 连续达成史料两路取数都发起，双双失败静默降级（第 235 轮起 2 次）
    expect(periodCalls()).toHaveLength(2);
    expect(host.textContent).not.toContain('本周学习');
    expect(host.textContent).toContain('近 30 天'); // 概览骨架仍在
  });

  it('B 站视频统计卡（共享 BiliWatchCard）固定本周口径：按 { kind: week } 取数并渲染 TopN', async () => {
    stubDashboardOps(WEEK_REPORT, {
      range: { kind: 'week', startDay: '2026-05-04', endDay: '2026-05-10' },
      top: [{ bvid: 'BV1Top01', title: '拓扑学导论', totalSec: 600, share: 1 }],
      recent: [],
      streakDays: 2,
    });
    await renderElement(createElement(Overview, { notify: vi.fn() }));

    const biliCalls = callOpMock.mock.calls.filter((args) => args[0] === 'stats.bili.overview');
    expect(biliCalls).toHaveLength(1);
    expect(biliCalls[0]?.[1]).toEqual({ kind: 'week' });
    expect(host.textContent).toContain('B 站视频');
    expect(host.textContent).toContain('拓扑学导论');
    expect(host.textContent).toContain('连续 2 天');
    // 固定本周口径：不出现「本月」切换项
    expect(host.textContent).not.toContain('本月');
  });

  it('stats.period 失败时 B 站卡不受影响：自身空态照常渲染（两卡取数互不干扰）', async () => {
    stubDashboardOps(new Error('rpc down'));
    await renderElement(createElement(Overview, { notify: vi.fn() }));

    expect(host.textContent).not.toContain('本周学习');
    expect(host.textContent).toContain('B 站视频');
    expect(host.textContent).toContain('还没有站外观看记录');
  });

  it('空课次引导卡直达动作（第 258 轮）：传 onNavigate 时 collect 步渲染「去知识库」，点击切视图', async () => {
    const onNavigate = vi.fn();
    stubDashboardOps(WEEK_REPORT);
    await renderElement(createElement(Overview, { notify: vi.fn(), onNavigate }));

    // REPORT.sessions 为空 → 空课次引导卡渲染；onNavigate 提供时 collect 步带直达按钮
    const action = host.querySelector<HTMLButtonElement>('.hdu-onboard-step-action');
    expect(action?.textContent).toBe('去知识库');
    await act(async () => {
      action!.click();
    });
    expect(onNavigate).toHaveBeenCalledWith('library');
  });

  it('空课次引导卡不传 onNavigate：collect 步不渲染按钮（组件不感知路由，向后兼容）', async () => {
    stubDashboardOps(WEEK_REPORT);
    await renderElement(createElement(Overview, { notify: vi.fn() }));

    expect(host.querySelector('.hdu-onboard-step-action')).toBeNull();
    expect(host.textContent).toContain('三步上手');
  });
});
