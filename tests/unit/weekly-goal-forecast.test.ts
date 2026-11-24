/**
 * 周目标达成预测 weeklyGoalForecast（core/stats/forecast.ts，第 236 轮巡检）单测。
 *
 * 覆盖（入参全部用本地 Date 构造，不依赖真实时钟 / 时区——new Date(y, m, d, h)
 * 按运行环境本地时区解释，期望值与构造同源）：
 *  1. 周一 0 学（新周起点）：daysLeft=7、日均缺口向上取整到分钟、onPace=0；
 *  2. 周中未达标 / 节奏可达成两态：daysLeft、neededPerDaySec、onPace、aheadBehindSec；
 *  3. 恰好达标 / 超额：neededPerDaySec=0、willHit=true（已达标态）；
 *  4. 周日最后一天：daysLeft=1、日均=整段缺口；
 *  5. 边界：target≤0 / 非有限、now 非有限 → null；daysLeft 恒 1..7（≤0 防御分支
 *     不可达，以全周日历不变量测试代替）；
 *  6. 向上取整到分钟口径（含整除与不整除）；
 *  7. 脏 weekSec：非有限按 0、负数 clamp 到 0。
 *
 * 日期锚点：2026-11-02 为周一（2026-11-01 是周日），2026-11-08 为周日；
 * 取正午构造避开夏令时切换小时的边界噪声。
 */
import { describe, expect, it } from 'vitest';

import { weeklyGoalForecast } from '@/core/stats/forecast';

/** 本地日构造器：new Date(2026, 10, day, 12) → 2026-11-day 12:00 本地毫秒 */
const at = (day: number, hour = 12): number => new Date(2026, 10, day, hour, 0, 0, 0).getTime();

const H = 3600;

describe('weeklyGoalForecast 周起点与日均口径（第 236 轮）', () => {
  it('周一 0 学：daysLeft=7、缺口日均向上取整到分钟、onPace=0、willHit=false', () => {
    const f = weeklyGoalForecast({ now: at(2), weekSec: 0, targetSec: 5 * H });
    expect(f).not.toBeNull();
    expect(f!.daysLeft).toBe(7);
    // 剩余 18000s / 7 天 = 42.86 分钟 → 向上取整 43 分钟
    expect(f!.neededPerDaySec).toBe(43 * 60);
    expect(f!.onPaceSec).toBe(0);
    expect(f!.willHit).toBe(false);
    expect(f!.aheadBehindSec).toBe(-5 * H);
  });

  it('周中（周三）未达标：daysLeft=5、onPace=周已学/3×7、落后差值正确', () => {
    const f = weeklyGoalForecast({ now: at(4), weekSec: 2 * H, targetSec: 10 * H });
    expect(f!.daysLeft).toBe(5);
    // 剩余 8h / 5 天 = 96 分钟整
    expect(f!.neededPerDaySec).toBe(96 * 60);
    expect(f!.onPaceSec).toBe(Math.round((2 * H / 3) * 7)); // 16800
    expect(f!.willHit).toBe(false);
    expect(f!.aheadBehindSec).toBe(f!.onPaceSec - 10 * H);
  });

  it('周中节奏可达成：onPace ≥ target → willHit=true、aheadBehindSec 正值', () => {
    const f = weeklyGoalForecast({ now: at(4), weekSec: 20000, targetSec: 10 * H });
    expect(f!.neededPerDaySec).toBe(54 * 60); // 剩余 16000/5 = 53.33 分钟 → 54
    expect(f!.onPaceSec).toBe(Math.round((20000 / 3) * 7));
    expect(f!.willHit).toBe(true);
    expect(f!.aheadBehindSec).toBe(f!.onPaceSec - 10 * H);
    expect(f!.aheadBehindSec).toBeGreaterThan(0);
  });

  it('周日最后一天：daysLeft=1、日均=整段缺口向上取整到分钟', () => {
    const f = weeklyGoalForecast({ now: at(8), weekSec: 2 * H, targetSec: 5 * H });
    expect(f!.daysLeft).toBe(1);
    expect(f!.neededPerDaySec).toBe(3 * H); // 剩余 3h 恰好整
    expect(f!.onPaceSec).toBe(2 * H); // 已过 7 天，推算 = 本周已学
    expect(f!.willHit).toBe(false);
  });
});

describe('weeklyGoalForecast 已达标与边界（第 236 轮）', () => {
  it('恰好达标（weekSec === target）：neededPerDaySec=0、willHit=true', () => {
    const f = weeklyGoalForecast({ now: at(2), weekSec: 5 * H, targetSec: 5 * H });
    expect(f!.neededPerDaySec).toBe(0);
    expect(f!.willHit).toBe(true);
  });

  it('超额达标：neededPerDaySec=0、willHit=true（onPace/aheadBehind 仍按统一公式）', () => {
    const f = weeklyGoalForecast({ now: at(4), weekSec: 40000, targetSec: 10 * H });
    expect(f!.neededPerDaySec).toBe(0);
    expect(f!.willHit).toBe(true);
    expect(f!.onPaceSec).toBe(Math.round((40000 / 3) * 7));
    expect(f!.aheadBehindSec).toBe(f!.onPaceSec - 10 * H);
  });

  it('targetSec ≤ 0 / 非有限（未设目标）→ null；now 非有限 / 缺失 → null', () => {
    expect(weeklyGoalForecast({ now: at(2), weekSec: 0, targetSec: 0 })).toBeNull();
    expect(weeklyGoalForecast({ now: at(2), weekSec: 0, targetSec: -3600 })).toBeNull();
    expect(weeklyGoalForecast({ now: at(2), weekSec: 0, targetSec: Number.NaN })).toBeNull();
    expect(weeklyGoalForecast({ now: Number.NaN, weekSec: 0, targetSec: 5 * H })).toBeNull();
    expect(weeklyGoalForecast({ now: Number.POSITIVE_INFINITY, weekSec: 0, targetSec: 5 * H })).toBeNull();
    expect(weeklyGoalForecast(undefined as unknown as { now: number; weekSec: number; targetSec: number })).toBeNull();
  });

  it('脏 weekSec：非有限按 0、负数 clamp 到 0（不产生荒谬预测）', () => {
    const fromNaN = weeklyGoalForecast({ now: at(2), weekSec: Number.NaN, targetSec: 5 * H });
    expect(fromNaN!.onPaceSec).toBe(0);
    expect(fromNaN!.neededPerDaySec).toBe(43 * 60);
    const fromNeg = weeklyGoalForecast({ now: at(2), weekSec: -120, targetSec: 5 * H });
    expect(fromNeg!.onPaceSec).toBe(0);
    expect(fromNeg!.willHit).toBe(false);
  });

  it('向上取整到分钟：600s 缺口 / 7 天 → 2 分钟（ceil(1.43)）；4200s / 7 天 → 10 分钟整', () => {
    expect(weeklyGoalForecast({ now: at(2), weekSec: 0, targetSec: 600 })!.neededPerDaySec).toBe(120);
    expect(weeklyGoalForecast({ now: at(2), weekSec: 0, targetSec: 4200 })!.neededPerDaySec).toBe(600);
    // 1 秒缺口也向上取整到 1 分钟
    expect(weeklyGoalForecast({ now: at(8), weekSec: 5 * H - 1, targetSec: 5 * H })!.neededPerDaySec).toBe(60);
  });

  it('本地时区日历不变量：周一=7 … 周日=1，全周各小时恒 1..7（daysLeft≤0 防御分支不可达）', () => {
    // 2026-11-02（周一）..11-08（周日）逐日 × 多个小时点：daysLeft 与星期一一对应
    for (let day = 2; day <= 8; day += 1) {
      for (const hour of [0, 6, 12, 18, 23]) {
        const f = weeklyGoalForecast({ now: at(day, hour), weekSec: 0, targetSec: 5 * H });
        expect(f).not.toBeNull();
        expect(f!.daysLeft).toBe(9 - day); // 周一(2)=7 … 周日(8)=1
        expect(f!.daysLeft).toBeGreaterThanOrEqual(1);
        expect(f!.daysLeft).toBeLessThanOrEqual(7);
      }
    }
  });
});
