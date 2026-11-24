/**
 * 「近 4 周」亮点回看展开区渲染测试（第 251 轮巡检，jsdom + react-dom 客户端渲染，
 * 无 JSX、直接 createElement，照 weekly-highlight-ui.test.ts / goal-sim-chips-ui.test.ts
 * 桩模式；纯 props 组件无取数）。
 *
 * 覆盖：
 *  1. 收起态与第 250 轮渲染一致（仅标杆行 + 轻入口按钮 aria-expanded=false）；
 *  2. 点击「近 4 周」→ 展开区出现，每周一行（周标签 + 亮点文案），本周行带「本周」
 *     徽标，历史周行无徽标；再点收起（受控展开区交互）；
 *  3. 无亮点历史周省略不占位（数组短于周数的正常形态在 UI 可见）；
 *  4. days 无日报数据但 weekSec 达标 → 展开区空态句（branch 可达性：goal 档由
 *     weekSec 直传触发、回看列表无 days 可派生）；
 *  5. 历史周文案不带「本周」前缀（与单周口径区分）。
 *
 * 日期动态计算（照 weekly-highlight-ui.test.ts 先例）：全部取真实「本周一 − N×7 天」，
 * 避免测试结果依赖运行日历。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WeeklyHighlightRow } from '@/entrypoints/content/ui/learning/OverviewView';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  await act(async () => {});
}

/** 真实日历的「本周一 − backWeeks×7 天」日键（回看数据造数用） */
function mondayKey(backWeeks = 0): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - backWeeks * 7);
  const [y, m, day] = [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toggle(): HTMLButtonElement {
  const el = host.querySelector('.hdu-weekly-history-toggle');
  if (!el) throw new Error('「近 4 周」入口未找到');
  return el as HTMLButtonElement;
}

function historyRows(): HTMLElement[] {
  return [...host.querySelectorAll('.hdu-weekly-history-row')] as HTMLElement[];
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

describe('近 4 周亮点回看展开区渲染（第 251 轮巡检）', () => {
  it('收起态：标杆行照旧渲染 + 入口 aria-expanded=false、无展开区', async () => {
    await renderElement(
      createElement(WeeklyHighlightRow, {
        days: [{ date: mondayKey(0), validSec: 45 * 60 }],
        weekSec: 45 * 60,
        weeklyTargetSec: 5 * 3600,
      }),
    );
    expect(host.querySelector('.hdu-weekly-highlight')).toBeTruthy();
    expect(host.querySelector('.hdu-weekly-highlight-text')?.textContent).toContain('单日峰值 45 分钟');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.hdu-weekly-history')).toBeNull();
  });

  it('点击展开：本周行带「本周」徽标、历史周行无徽标且文案不带「本周」前缀；再点收起', async () => {
    await renderElement(
      createElement(WeeklyHighlightRow, {
        days: [
          { date: mondayKey(0), validSec: 45 * 60 },
          { date: mondayKey(1), validSec: 30 * 60 },
          { date: mondayKey(2), validSec: 20 * 60 },
        ],
        weekSec: 45 * 60,
        weeklyTargetSec: 5 * 3600,
      }),
    );
    await act(async () => {
      toggle().click();
    });
    await act(async () => {});

    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().getAttribute('aria-controls')).toBe('hdu-weekly-history-body');
    const region = host.querySelector('.hdu-weekly-history');
    expect(region?.getAttribute('id')).toBe('hdu-weekly-history-body');
    const rows = historyRows();
    // 近 4 周中 3 周有亮点（本周 + 上 2 周），更早一周无数据省略
    expect(rows).toHaveLength(3);
    // 本周行：徽标 + 文案（峰值文案不带前缀，与前缀规则无关）
    const currentRow = rows.find((r) => r.querySelector('.hdu-weekly-history-badge'));
    expect(currentRow).toBeTruthy();
    expect(currentRow?.querySelector('.hdu-weekly-history-badge')?.textContent).toBe('本周');
    expect(currentRow?.querySelector('.hdu-weekly-history-text')?.textContent).toContain('单日峰值 45 分钟');
    // 历史周行：无徽标、周标签列有内容
    const pastRows = rows.filter((r) => !r.querySelector('.hdu-weekly-history-badge'));
    expect(pastRows).toHaveLength(2);
    for (const row of pastRows) {
      expect(row.querySelector('.hdu-weekly-history-label')?.textContent).toMatch(/^\d{2}-\d{2}–\d{2}-\d{2}$/);
      expect(row.querySelector('.hdu-weekly-history-text')?.textContent).toContain('单日峰值');
    }
    // 再点收起（受控展开区）
    await act(async () => {
      toggle().click();
    });
    await act(async () => {});
    expect(host.querySelector('.hdu-weekly-history')).toBeNull();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('goal 档由 weekSec 直传触发而 days 为空 → 展开区显示空态句（无亮点周全省略）', async () => {
    await renderElement(
      createElement(WeeklyHighlightRow, { days: [], weekSec: 5.2 * 3600, weeklyTargetSec: 5 * 3600 }),
    );
    // 标杆行由 weekSec 直传触发（本周目标达成）
    expect(host.querySelector('.hdu-weekly-highlight-text')?.textContent).toContain('本周学习 5.2 小时，达成周目标');
    await act(async () => {
      toggle().click();
    });
    await act(async () => {});
    expect(historyRows()).toHaveLength(0);
    expect(host.querySelector('.hdu-weekly-history-empty')?.textContent).toBe('近 4 周还没有可回看的亮点');
  });
});
