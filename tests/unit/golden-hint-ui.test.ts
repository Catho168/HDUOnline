/**
 * 总览黄金时段提示行 GoldenSlotHint 渲染测试（jsdom + react-dom 客户端渲染，无 JSX、
 * 直接 createElement，照 time-of-day-card-ui.test.ts 桩模式；callOp 整体 mock）。
 *
 * 覆盖第 239 轮新增的行为约定：
 *  1. 达建议门槛（总有效 ≥60 分钟且最高桶占比 ≥25%）+ 当前小时落在黄金桶 →
 *     jade 提示行（is-now）「现在是你的黄金时段（晚间），适合攻坚难点」；
 *  2. 达门槛但当前不在黄金桶 → 中性提示行（无 is-now）「黄金时段 晚间（18–23 点），
 *     记得留出学习时间」；
 *  3. 不达门槛（总有效 <60 分钟）→ 不渲染（总览保持安静）；
 *  4. 取数失败 → 不渲染；
 *  5. 提示行 aria：role=status + aria-live=polite（读屏可感知）。
 *
 * nowHour 由测试注入固定值（组件 prop），不依赖测试机真实时刻。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { GoldenSlotHint } from '@/entrypoints/content/ui/learning/OverviewView';
import { localDayKey } from '@/core/shared/utils';
import type { WatchRecordEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 桩流水：今天晚间两条（20 点 7200s + 21 点 3600s）→ 晚间 10800s / 总量 10800s，达门槛 */
function stubEveningHeavy(): WatchRecordEntity[] {
  const now = Date.now();
  const ts1 = new Date(now).setHours(20, 0, 0, 0);
  const ts2 = new Date(now).setHours(21, 0, 0, 0);
  const mk = (startTs: number, durationSec: number): WatchRecordEntity => ({
    courId: 1,
    teclId: 1,
    date: localDayKey(startTs),
    startTs,
    endTs: startTs + durationSec * 1000,
    durationSec,
    playMode: 'vod',
    speed: 1,
    firstWatch: true,
    valid: true,
  });
  return [mk(ts1, 7200), mk(ts2, 3600)];
}

/** 桩流水：仅今天 20 点 600s → 总量 10 分钟，不达 60 分钟门槛 */
function stubTooLittle(): WatchRecordEntity[] {
  return stubEveningHeavy().slice(0, 1).map((r) => ({ ...r, durationSec: 600, endTs: r.startTs + 600_000 }));
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  // 放行 useEffect 内的 callOp promise
  await act(async () => {});
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
});

describe('黄金时段提示行渲染（第 239 轮巡检）', () => {
  it('达门槛 + 当前在黄金时段 → jade 提示行（is-now）「现在是你的黄金时段」+ aria 可感知', async () => {
    callOpMock.mockResolvedValue(stubEveningHeavy());
    await renderElement(createElement(GoldenSlotHint, { nowHour: 20 }));

    const hint = host.querySelector('.hdu-golden-hint');
    expect(hint).toBeTruthy();
    expect(hint?.className).toContain('is-now');
    expect(hint?.textContent).toContain('现在是你的黄金时段（晚间）');
    expect(hint?.textContent).toContain('适合攻坚难点');
    expect(hint?.getAttribute('role')).toBe('status');
    expect(hint?.getAttribute('aria-live')).toBe('polite');
  });

  it('达门槛但未到黄金时段 → 中性提示行（无 is-now）「黄金时段 晚间（18–23 点），记得留出学习时间」', async () => {
    callOpMock.mockResolvedValue(stubEveningHeavy());
    await renderElement(createElement(GoldenSlotHint, { nowHour: 10 }));

    const hint = host.querySelector('.hdu-golden-hint');
    expect(hint).toBeTruthy();
    expect(hint?.className).not.toContain('is-now');
    expect(hint?.textContent).toContain('黄金时段 晚间（18–23 点）');
    expect(hint?.textContent).toContain('记得留出学习时间');
  });

  it('不达门槛（总有效 10 分钟 <60 分钟）→ 不渲染（防噪声）', async () => {
    callOpMock.mockResolvedValue(stubTooLittle());
    await renderElement(createElement(GoldenSlotHint, { nowHour: 20 }));
    expect(host.querySelector('.hdu-golden-hint')).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('取数失败 → 不渲染（总览保持安静）', async () => {
    callOpMock.mockRejectedValue(new Error('boom'));
    await renderElement(createElement(GoldenSlotHint, { nowHour: 20 }));
    expect(host.querySelector('.hdu-golden-hint')).toBeNull();
    expect(host.textContent).toBe('');
  });
});
