/**
 * 总览「本周亮点」提示行 WeeklyHighlightRow 渲染测试（jsdom + react-dom 客户端渲染，
 * 无 JSX、直接 createElement，照 golden-hint-ui.test.ts 桩模式；纯 props 组件无取数）。
 *
 * 覆盖第 250 轮新增的行为约定：
 *  1. 达成周目标 → jade 标杆行「本周学习 X.X 小时，达成周目标」+ aria 可感知
 *     （role=status + aria-live=polite）；
 *  2. 无亮点（全零）→ 不渲染（总览保持安静，与黄金时段行同防噪声约定）；
 *  3. ⭐ 图标 aria-hidden（读屏只读文案不读图标）；
 *  4. days 引用变化（新一周数据）→ 文案随之更新（useMemo 重算）。
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

describe('本周亮点提示行渲染（第 250 轮巡检）', () => {
  it('达成周目标 → jade 标杆行 + aria 可感知 + ⭐ 图标 aria-hidden', async () => {
    await renderElement(
      createElement(WeeklyHighlightRow, { days: [], weekSec: 2.5 * 3600, weeklyTargetSec: 2 * 3600 }),
    );
    const row = host.querySelector('.hdu-weekly-highlight');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain('本周学习 2.5 小时，达成周目标');
    expect(row?.getAttribute('role')).toBe('status');
    expect(row?.getAttribute('aria-live')).toBe('polite');
    const icon = host.querySelector('.hdu-weekly-highlight-icon');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.textContent).toBe('⭐');
  });

  it('无亮点（全零 / 空数据）→ 不渲染（防噪声）', async () => {
    await renderElement(createElement(WeeklyHighlightRow, { days: [], weekSec: 0, weeklyTargetSec: 5 * 3600 }));
    expect(host.querySelector('.hdu-weekly-highlight')).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('未达目标但单日峰值突出 → 落到峰值文案（优先级回落可见）', async () => {
    // 本周一（动态计算，避免测试结果依赖真实日历——固定日期在其他周会被窗口过滤）
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const [y, m, d] = [monday.getFullYear(), monday.getMonth() + 1, monday.getDate()];
    const dayKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    await renderElement(
      createElement(WeeklyHighlightRow, { days: [{ date: dayKey, validSec: 45 * 60 }], weekSec: 45 * 60, weeklyTargetSec: 5 * 3600 }),
    );
    expect(host.querySelector('.hdu-weekly-highlight')?.textContent).toContain('单日峰值 45 分钟');
  });

  it('数据更新（weekSec 变化跨过目标线）→ 文案随之更新', async () => {
    await renderElement(createElement(WeeklyHighlightRow, { days: [], weekSec: 10 * 60, weeklyTargetSec: 5 * 3600 }));
    expect(host.querySelector('.hdu-weekly-highlight')).toBeNull();

    await renderElement(
      createElement(WeeklyHighlightRow, { days: [], weekSec: 5.2 * 3600, weeklyTargetSec: 5 * 3600 }),
    );
    expect(host.querySelector('.hdu-weekly-highlight')?.textContent).toContain('本周学习 5.2 小时，达成周目标');
  });
});
