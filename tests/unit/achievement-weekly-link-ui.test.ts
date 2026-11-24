/**
 * 成就速览条「本周亮点联动」渲染测试（jsdom + react-dom 客户端渲染，无 JSX、
 * 直接 createElement，照 bili-hub-today-card.test.ts 桩模式；callOp 整体 mock）。
 *
 * 第 252 轮口径核对收官（激励域 / 一致性视角）：
 *  1. 本周达成周目标（dash.weekSec ≥ goal.weeklyTargetSec 且目标 > 0，判定式与
 *     buildWeeklyHighlight ① 档同线）→ 进度条 foot 渲染 jade 联动行
 *     （.hdu-achv-weekly-link，文案「本周已达成周目标」）；
 *  2. 未达成周目标 → 联动行不渲染（防噪声约定，同 WeeklyHighlightRow 无亮点不渲染）；
 *  3. external-10「双线学习」徽章改吃 externalTotalSec（站外累计口径，第 252 轮
 *     修齐：与 totalSec 同为流水取数窗口累计）——展示窗口 externalSeconds 为 0 而
 *     累计达标时徽章仍解锁（chip 出现）；
 *  4. 旧快照（无 externalTotalSec 字段）回退 externalSeconds，不虚增进度。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { AchievementStrip } from '@/entrypoints/content/ui/learning/AchievementStrip';
import { uiStore } from '@/entrypoints/content/ui/store';
import type { DashboardReport } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** stats.report 桩（最小可用 DashboardReport；徽章无关字段给安全缺省） */
function dashFixture(patch: Partial<DashboardReport> = {}): DashboardReport {
  return {
    totalSec: 0,
    weekSec: 0,
    todaySec: 0,
    externalSeconds: 0,
    externalTotalSec: 0,
    streakDays: 0,
    days: [],
    weeks: [],
    courses: [],
    sessions: [],
    goal: { weeklyTargetSec: 5 * 3600, weekSec: 0, hitDaysThisWeek: 0 },
    generatedAt: 0,
    ...patch,
  };
}

function stubOps(dash: DashboardReport | null): void {
  callOpMock.mockImplementation(async (op: string) => {
    if (op === 'stats.report') return dash;
    if (op === 'review.list') return [];
    if (op === 'fav.list') return [];
    if (op === 'note.listAll') return [];
    throw new Error(`unexpected op: ${op}`);
  });
}

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // 成就解锁登记写 settings.ui.achievementUnlockedAt：隔离测试间的 store 状态
  uiStore.patch({
    settings: { ...uiStore.getState().settings, ui: { ...uiStore.getState().settings.ui, achievementUnlockedAt: {} } },
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host.remove();
});

async function renderStrip(): Promise<void> {
  await act(async () => {
    root.render(createElement(AchievementStrip));
  });
  await act(async () => {});
}

describe('AchievementStrip 本周亮点联动（第 252 轮口径核对收官）', () => {
  it('本周达成周目标：进度条 foot 渲染 jade 联动行（判定式与亮点 ① 档同线）', async () => {
    stubOps(dashFixture({ weekSec: 6 * 3600, goal: { weeklyTargetSec: 5 * 3600, weekSec: 6 * 3600, hitDaysThisWeek: 3 } }));
    await renderStrip();
    const link = host.querySelector('.hdu-achv-weekly-link');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('本周已达成周目标');
    expect(link?.getAttribute('role')).toBe('status');
  });

  it('未达成周目标：联动行不渲染（防噪声约定）', async () => {
    stubOps(dashFixture({ weekSec: 3 * 3600, goal: { weeklyTargetSec: 5 * 3600, weekSec: 3 * 3600, hitDaysThisWeek: 1 } }));
    await renderStrip();
    expect(host.querySelector('.hdu-achv-weekly-link')).toBeNull();
  });

  it('external-10 徽章吃 externalTotalSec（累计口径）：展示窗口 0 而累计达标 → 徽章解锁', async () => {
    // externalSeconds（近 30 天展示窗口）= 0，externalTotalSec（流水累计）= 30 分钟
    stubOps(dashFixture({ externalSeconds: 0, externalTotalSec: 1800 }));
    await renderStrip();
    const chips = [...host.querySelectorAll('.hdu-achv-chip')].map((chip) => chip.textContent ?? '');
    expect(chips.some((text) => text.includes('双线学习'))).toBe(true);
  });

  it('旧快照无 externalTotalSec：回退 externalSeconds，不虚增站外进度', async () => {
    const dash = dashFixture({ externalSeconds: 0 });
    delete (dash as { externalTotalSec?: number }).externalTotalSec;
    stubOps(dash);
    await renderStrip();
    const chips = [...host.querySelectorAll('.hdu-achv-chip')].map((chip) => chip.textContent ?? '');
    expect(chips.some((text) => text.includes('双线学习'))).toBe(false);
  });
});
