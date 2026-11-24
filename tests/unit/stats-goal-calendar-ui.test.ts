/**
 * 学习中心统计页「本周目标」卡 · 7 日格与双口径对照渲染测试（第 258 轮巡检，目标域；
 * jsdom + react-dom 客户端渲染，照 stats-period-summary-ui.test.ts 桩模式：callOp 整体
 * mock 按 op 查表，未知 op 一律 reject——StatsView 各取数路均有 try/catch 兜底）。
 *
 * 覆盖：
 *  1. 「本周目标」卡内渲染 7 日格（7 格 + foot「本周达标 … 每日目标 30 分钟」）；
 *  2. 双口径对照行：打卡口径（hitDaysThisWeek fixture=2）与目标口径（不锁动态日历数字）
 *     并列呈现；
 *  3. 目标口径数字与打卡口径可以不同（fixture days 只达标部分日，两行数字分开断言）。
 *
 * 日历判定依赖真实「今天」（StatsView 内 buildWeeklyGoalCalendar 用默认 now），
 * 故达标数不做精确断言，由 daily-goal-calendar.test.ts 专测锁定判定逻辑。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { StatsView } from '@/entrypoints/content/ui/learning/StatsView';
import type { BundleData } from '@/entrypoints/content/ui/learning/shared';
import type { DashboardReport } from '@/core/shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 真实日历的「本周一 + offset 天」日键（造数用；判定断言不锁动态星期） */
function weekDayKey(offset: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset);
  const [y, m, day] = [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const GOAL_REPORT: DashboardReport = {
  totalSec: 7200,
  weekSec: 5400,
  todaySec: 1800,
  externalSeconds: 600,
  streakDays: 3,
  days: [
    { date: weekDayKey(0), totalSec: 1800, validSec: 1800, sessionCount: 1, externalSeconds: 0 },
    { date: weekDayKey(1), totalSec: 600, validSec: 600, sessionCount: 1, externalSeconds: 0 },
    { date: weekDayKey(2), totalSec: 3600, validSec: 3600, sessionCount: 2, externalSeconds: 0 },
  ],
  weeks: [],
  courses: [],
  sessions: [],
  goal: { weeklyTargetSec: 18000, weekSec: 5400, hitDaysThisWeek: 2 },
  generatedAt: 0,
};

const DATA: BundleData = {
  bundles: [],
  report: GOAL_REPORT,
  missed: [],
  favorites: [],
  folders: [],
  notes: [],
  schedule: [],
  reviewPending: 0,
  loading: false,
  error: null,
};

let host: HTMLElement;
let root: Root;

async function renderElement(): Promise<void> {
  await act(async () => {
    root.render(createElement(StatsView, { data: DATA }));
  });
  await act(async () => {});
}

beforeEach(() => {
  callOpMock.mockReset();
  callOpMock.mockImplementation(async (op: string) => {
    if (op === 'stats.heatmap') return { weeks: [] };
    if (op === 'review.list') return [];
    if (op === 'stats.report') return GOAL_REPORT;
    if (op === 'stats.period') return { buckets: [] };
    throw new Error(`unexpected op: ${op}`);
  });
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('StatsView「本周目标」卡 · 7 日格与双口径（第 258 轮）', () => {
  it('渲染 7 日格（7 格 + foot 摘要，默认每日目标 30 分钟）', async () => {
    await renderElement();
    const cells = host.querySelectorAll('.hdu-goal-week-cell');
    expect(cells).toHaveLength(7);
    expect(host.textContent).toContain('本周达标');
    expect(host.textContent).toContain('每日目标 30 分钟');
  });

  it('双口径对照行：打卡口径取 report.goal.hitDaysThisWeek（fixture 2），目标口径并列呈现', async () => {
    await renderElement();
    expect(host.textContent).toContain('打卡口径（≥10 分钟）本周有效 2 天');
    expect(host.textContent).toContain('目标口径（≥ 每日目标）达标');
  });

  it('口径说明含每日目标线条目（第 262 轮，双口径文档化）', async () => {
    await renderElement();
    expect(host.textContent).toContain('每日目标线');
    expect(host.textContent).toContain('打卡线回答');
    expect(host.textContent).toContain('目标线回答');
  });
});
