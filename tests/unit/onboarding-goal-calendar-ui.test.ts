/**
 * 第 256 轮新组件渲染测试（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，
 * 照 weekly-highlight-history-ui.test.ts 桩模式；纯 props 组件无取数）：
 *  1. WeeklyGoalCalendarRow（学习中心今日目标卡下方 7 日格）：7 格渲染、达标 jade 态、
 *     今天描边态、未来日 dim 态、foot 摘要行（本周达标 X/Y 天 · 每日目标 Z 分钟）；
 *  2. OnboardingCard（三步上手引导卡）：步骤行渲染、完成态 ✓、计数徽标、compact 窄版。
 *
 * 日期动态取真实「本周一 − N 天」，不依赖运行日历（照既有先例）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OnboardingCard } from '@/entrypoints/content/ui/learning/OnboardingCard';
import { WeeklyGoalCalendarRow } from '@/entrypoints/content/ui/learning/OverviewView';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  await act(async () => {});
}

/** 真实日历的「本周一 + offset 天」日键 */
function weekDayKey(offset: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset);
  const [y, m, day] = [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
  host.remove();
});

/** 真实日历的「本周一 12:00」时刻（now 注入用：今天恒为周一，判定完全确定） */
function mondayNoon(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  d.setHours(12);
  return d.getTime();
}

describe('WeeklyGoalCalendarRow（本周目标达成 7 日格）', () => {
  it('渲染 7 格 + foot 摘要行；达标格 is-hit、今天 is-today、未来日 is-future', async () => {
    // now 注入「本周一 12:00」：今天恒为周一（offset 0），判定完全确定——
    // 周一达标（1800s = 30 分钟目标线），周二数据虽大但是未来日不判定
    await renderElement(
      createElement(WeeklyGoalCalendarRow, {
        days: [
          { date: weekDayKey(0), validSec: 1800 },
          { date: weekDayKey(1), validSec: 3600 },
        ],
        dailyGoalMin: 30,
        now: mondayNoon(),
      }),
    );
    const cells = [...host.querySelectorAll('.hdu-goal-week-cell')];
    expect(cells).toHaveLength(7);
    cells.forEach((cell, i) => {
      expect(cell.classList.contains('is-hit')).toBe(i === 0);
      expect(cell.classList.contains('is-today')).toBe(i === 0);
      expect(cell.classList.contains('is-future')).toBe(i >= 1);
    });
    const foot = host.querySelector('.hdu-goal-week-foot');
    expect(foot?.textContent).toContain('本周达标 1/1 天');
    expect(foot?.textContent).toContain('每日目标 30 分钟');
  });

  it('aria 标签带达成计数与目标分钟（读屏可感知）', async () => {
    await renderElement(
      createElement(WeeklyGoalCalendarRow, {
        days: [{ date: weekDayKey(0), validSec: 1800 }],
        dailyGoalMin: 30,
        now: mondayNoon(),
      }),
    );
    const wrap = host.querySelector('.hdu-goal-week');
    expect(wrap?.getAttribute('aria-label')).toContain('本周目标达成 1 / 1 天');
    expect(wrap?.getAttribute('aria-label')).toContain('每日目标 30 分钟');
  });
});

describe('OnboardingCard（三步上手引导卡）', () => {
  it('渲染三步（序号 + 步骤名 + hint）；全空输入全部待完成', async () => {
    await renderElement(createElement(OnboardingCard, { input: { hasCourse: false, hasWatch: false, hasLibrary: false } }));
    const steps = [...host.querySelectorAll('.hdu-onboard-step')];
    expect(steps).toHaveLength(3);
    expect(steps.every((s) => !s.classList.contains('is-done'))).toBe(true);
    expect(host.querySelector('.hdu-onboard-count')?.textContent).toBe('0/3');
    expect(host.querySelector('.hdu-onboard-title')?.textContent).toBe('三步上手');
  });

  it('完成态点亮：done 步 ✓ 徽标 + is-done；计数徽标随 doneCount 更新', async () => {
    await renderElement(createElement(OnboardingCard, { input: { hasCourse: true, hasWatch: true, hasLibrary: false } }));
    const steps = [...host.querySelectorAll('.hdu-onboard-step')];
    expect(steps[0]?.classList.contains('is-done')).toBe(true);
    expect(steps[1]?.classList.contains('is-done')).toBe(true);
    expect(steps[2]?.classList.contains('is-done')).toBe(false);
    expect(steps[0]?.querySelector('.hdu-onboard-step-mark')?.textContent).toBe('✓');
    expect(steps[2]?.querySelector('.hdu-onboard-step-mark')?.textContent).toBe('3');
    expect(host.querySelector('.hdu-onboard-count')?.textContent).toBe('2/3');
  });

  it('compact 窄版（popup）：挂 is-compact 类，副题省略', async () => {
    await renderElement(createElement(OnboardingCard, { input: { hasCourse: false, hasWatch: false, hasLibrary: false }, compact: true }));
    expect(host.querySelector('.hdu-onboard')?.classList.contains('is-compact')).toBe(true);
    expect(host.querySelector('.hdu-onboard-sub')).toBeNull();
  });

  it('actions 插槽（第 257 轮）：提供动作的步骤行尾渲染直达按钮，点击触发回调；未提供不渲染', async () => {
    const onSync = vi.fn();
    const onCollect = vi.fn();
    await renderElement(
      createElement(OnboardingCard, {
        input: { hasCourse: false, hasWatch: false, hasLibrary: false },
        actions: {
          sync: { label: '立即同步', onClick: onSync },
          collect: { label: '去知识库', onClick: onCollect },
        },
      }),
    );
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.hdu-onboard-step-action')];
    expect(buttons.map((b) => b.textContent)).toEqual(['立即同步', '去知识库']);
    await act(async () => {
      buttons[0]?.click();
    });
    expect(onSync).toHaveBeenCalledTimes(1);
    await act(async () => {
      buttons[1]?.click();
    });
    expect(onCollect).toHaveBeenCalledTimes(1);
    // watch 步未提供动作 → 该步无按钮（3 步只有 2 个动作按钮）
    const stepRows = [...host.querySelectorAll('.hdu-onboard-step')];
    expect(stepRows[1]?.querySelector('.hdu-onboard-step-action')).toBeNull();
  });
});
