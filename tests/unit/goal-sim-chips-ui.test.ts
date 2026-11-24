/**
 * 每日目标快捷模拟 chips DailyGoalSimChips 渲染测试（jsdom + react-dom 客户端渲染，
 * 无 JSX、直接 createElement，照 evening-sim-ui.test.ts 桩模式；纯前端组件、无取数）。
 *
 * 覆盖第 238 轮新增的行为约定：
 *  1. 固定三档 chips 渲染（再学 15 / 30 / 60 分）+ aria-pressed 初始 false；
 *  2. 点击 chip → aria-live 结果区即时输出两态文案（+X 分 → 达成 ✅ / 仍差 ❌）
 *     与着色类（is-hit jade / is-behind danger），chip 进入 is-active / aria-pressed=true；
 *  3. 再点同 chip = 取消（结果清空、选中态复位）；
 *  4. 点击另一 chip = 结果被替换（新口径重算）；
 *  5. 已达标态（done）：文案切「超额 Y 分 ✅」（模拟引擎同一单点实现）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DailyGoalSimChips } from '@/entrypoints/content/ui/learning/OverviewView';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIN = 60;

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  await act(async () => {});
}

/** 按 chip 文案找按钮 */
function chipByText(text: string): HTMLButtonElement {
  const el = [...host.querySelectorAll('.hdu-goal-sim-chip-row button')].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`chip「${text}」未找到`);
  return el as HTMLButtonElement;
}

function resultLine(): HTMLElement {
  const el = host.querySelector('.hdu-goal-sim-chips-result');
  if (!el) throw new Error('结果行未找到');
  return el as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

describe('每日目标快捷模拟 chips 渲染（第 238 轮巡检）', () => {
  it('固定三档渲染；点击「再学 15 分」→ 仍差文案 + is-behind + chip 选中态', async () => {
    await renderElement(createElement(DailyGoalSimChips, { todaySec: 10 * MIN, dailyGoalSec: 30 * MIN, done: false }));

    const chips = [...host.querySelectorAll('.hdu-goal-sim-chip-row button')];
    expect(chips.map((b) => b.textContent?.trim())).toEqual(['再学 15 分', '再学 30 分', '再学 60 分']);
    expect(chips.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
    // 结果区 aria-live 常驻、初始为空（:empty 零高度不占位）
    expect(resultLine().getAttribute('aria-live')).toBe('polite');
    expect(resultLine().textContent).toBe('');

    await act(async () => {
      chipByText('再学 15 分').click();
    });
    await act(async () => {});

    // 10 分 + 15 分 < 30 分 → 仍差 5 分钟 ❌（danger 着色）
    expect(resultLine().textContent).toBe('+15 分 → 仍差 5 分 ❌');
    expect(resultLine().className).toContain('is-behind');
    expect(resultLine().className).not.toContain('is-hit');
    // chip 选中态：is-active + aria-pressed
    expect(chipByText('再学 15 分').className).toContain('is-active');
    expect(chipByText('再学 15 分').getAttribute('aria-pressed')).toBe('true');
    expect(chipByText('再学 30 分').className).not.toContain('is-active');
  });

  it('再点同 chip = 取消：结果清空、选中态复位', async () => {
    await renderElement(createElement(DailyGoalSimChips, { todaySec: 10 * MIN, dailyGoalSec: 30 * MIN, done: false }));
    await act(async () => {
      chipByText('再学 15 分').click();
    });
    await act(async () => {});
    expect(resultLine().textContent).not.toBe('');

    await act(async () => {
      chipByText('再学 15 分').click();
    });
    await act(async () => {});

    expect(resultLine().textContent).toBe('');
    expect(chipByText('再学 15 分').className).not.toContain('is-active');
    expect(chipByText('再学 15 分').getAttribute('aria-pressed')).toBe('false');
  });

  it('点击另一 chip = 结果被替换：+15 仍差 → +30 达成（is-behind 切 is-hit）', async () => {
    await renderElement(createElement(DailyGoalSimChips, { todaySec: 10 * MIN, dailyGoalSec: 30 * MIN, done: false }));

    await act(async () => {
      chipByText('再学 15 分').click();
    });
    await act(async () => {});
    expect(resultLine().textContent).toBe('+15 分 → 仍差 5 分 ❌');

    await act(async () => {
      chipByText('再学 30 分').click();
    });
    await act(async () => {});

    // 10 分 + 30 分 = 40 分 ≥ 30 分 → 达成 ✅（结果行被新点击替换）
    expect(resultLine().textContent).toBe('+30 分 → 达成 ✅');
    expect(resultLine().className).toContain('is-hit');
    expect(resultLine().className).not.toContain('is-behind');
    // 选中态迁移：15 复位、30 选中
    expect(chipByText('再学 15 分').className).not.toContain('is-active');
    expect(chipByText('再学 30 分').className).toContain('is-active');
  });

  it('已达标态：文案切「超额 Y 分 ✅」（jade 着色）', async () => {
    await renderElement(createElement(DailyGoalSimChips, { todaySec: 35 * MIN, dailyGoalSec: 30 * MIN, done: true }));

    await act(async () => {
      chipByText('再学 15 分').click();
    });
    await act(async () => {});

    // 35 分 + 15 分 = 50 分 → 超额 20 分钟 ✅（达标态超额 = 模拟后总量 − 目标）
    expect(resultLine().textContent).toBe('+15 分 → 超额 20 分 ✅');
    expect(resultLine().className).toContain('is-hit');
  });

  it('0 学习起步 + 再学 60 分：默认目标 30 分钟 → 达成 ✅（dailyGoalMin 未配置同口径）', async () => {
    await renderElement(createElement(DailyGoalSimChips, { todaySec: 0, dailyGoalSec: 30 * MIN, done: false }));
    await act(async () => {
      chipByText('再学 60 分').click();
    });
    await act(async () => {});
    expect(resultLine().textContent).toBe('+60 分 → 达成 ✅');
    expect(resultLine().className).toContain('is-hit');
  });
});
