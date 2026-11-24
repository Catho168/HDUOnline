/**
 * 今晚补进度模拟 simulateEveningStudy（core/stats/forecast.ts，第 237 轮巡检）单测。
 *
 * 覆盖（与 weeklyGoalForecast.test.ts 同风格，秒数用小时常量构造）：
 *  1. 未达标 + 足够补学 → 达成（overBySec = 超额，willHit=true，shortBySec=0）；
 *  2. 未达标 + 补学不足 → 还差（shortBySec = 缺口，willHit=false，overBySec=0）；
 *  3. 恰好达标 → willHit=true、over/short 皆 0；
 *  4. 已达标再学 → 继续输出超额（overBySec 含补学部分）；
 *  5. 非法 extraSec（NaN / Infinity / 0 / 负数）→ null；
 *  6. 非法 targetSec（未设目标 / 非有限）→ null；
 *  7. 脏 weekSec：非有限按 0、负数 clamp 到 0；
 *  8. simulatedSec = weekSec + extraSec（四舍五入取整口径）。
 */
import { describe, expect, it } from 'vitest';

import { simulateEveningStudy } from '@/core/stats/forecast';

const H = 3600;

describe('simulateEveningStudy 模拟结果口径（第 237 轮）', () => {
  it('未达标 + 足够补学 → 达成：overBySec=超额、shortBySec=0', () => {
    const r = simulateEveningStudy({ weekSec: 3 * H, extraSec: 2 * H, targetSec: 4 * H });
    expect(r).not.toBeNull();
    expect(r!.simulatedSec).toBe(5 * H);
    expect(r!.willHit).toBe(true);
    expect(r!.overBySec).toBe(1 * H);
    expect(r!.shortBySec).toBe(0);
  });

  it('未达标 + 补学不足 → 还差：shortBySec=缺口、overBySec=0', () => {
    const r = simulateEveningStudy({ weekSec: 3 * H, extraSec: 30 * 60, targetSec: 4 * H });
    expect(r!.simulatedSec).toBe(3.5 * H);
    expect(r!.willHit).toBe(false);
    expect(r!.overBySec).toBe(0);
    expect(r!.shortBySec).toBe(0.5 * H);
  });

  it('恰好达标：willHit=true、overBySec=0、shortBySec=0', () => {
    const r = simulateEveningStudy({ weekSec: 3 * H, extraSec: 1 * H, targetSec: 4 * H });
    expect(r!.willHit).toBe(true);
    expect(r!.overBySec).toBe(0);
    expect(r!.shortBySec).toBe(0);
  });

  it('已达标再学 → 输出超额（overBySec 含补学部分）', () => {
    const r = simulateEveningStudy({ weekSec: 5 * H, extraSec: 40 * 60, targetSec: 4 * H });
    expect(r!.willHit).toBe(true);
    expect(r!.simulatedSec).toBe(5 * H + 40 * 60);
    expect(r!.overBySec).toBe(1 * H + 40 * 60);
    expect(r!.shortBySec).toBe(0);
  });

  it('simulatedSec 四舍五入取整（小数秒输入）', () => {
    const r = simulateEveningStudy({ weekSec: 100.4, extraSec: 200.6, targetSec: 1000 });
    expect(r!.simulatedSec).toBe(301);
  });
});

describe('simulateEveningStudy 边界防御（第 237 轮）', () => {
  it('extraSec 非法：NaN / Infinity / 0 / 负数 → null', () => {
    expect(simulateEveningStudy({ weekSec: H, extraSec: Number.NaN, targetSec: 4 * H })).toBeNull();
    expect(simulateEveningStudy({ weekSec: H, extraSec: Number.POSITIVE_INFINITY, targetSec: 4 * H })).toBeNull();
    expect(simulateEveningStudy({ weekSec: H, extraSec: 0, targetSec: 4 * H })).toBeNull();
    expect(simulateEveningStudy({ weekSec: H, extraSec: -60, targetSec: 4 * H })).toBeNull();
  });

  it('targetSec 非法：未设目标（0/负）/ 非有限 → null', () => {
    expect(simulateEveningStudy({ weekSec: H, extraSec: 600, targetSec: 0 })).toBeNull();
    expect(simulateEveningStudy({ weekSec: H, extraSec: 600, targetSec: -3600 })).toBeNull();
    expect(simulateEveningStudy({ weekSec: H, extraSec: 600, targetSec: Number.NaN })).toBeNull();
  });

  it('脏 weekSec：非有限按 0、负数 clamp 到 0（缺口=目标全额）', () => {
    expect(simulateEveningStudy({ weekSec: Number.NaN, extraSec: 600, targetSec: 1200 })).toEqual({
      simulatedSec: 600,
      willHit: false,
      overBySec: 0,
      shortBySec: 600,
    });
    expect(simulateEveningStudy({ weekSec: -50, extraSec: 600, targetSec: 1200 })!.simulatedSec).toBe(600);
  });
});
