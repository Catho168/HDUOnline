/**
 * 通用进度模拟薄包装 simulateStudyProgress（core/stats/forecast.ts，第 238 轮巡检）
 * 单测：当日口径（baseSec=今日已学、targetSec=每日目标）的「再学 X 分会怎样」。
 *
 * 覆盖：
 *  1. 当日口径三态：直达达成（差额恰为 extra）/ 仍差 / 超额（已达标态继续加学）；
 *  2. 恰好达标：overBySec = shortBySec = 0、willHit = true（一正一零约定）；
 *  3. 边界防御与 simulateEveningStudy 完全一致（extraSec / targetSec 非法 → null；
 *     baseSec 非有限按 0、负数 clamp 到 0）；
 *  4. 与 simulateEveningStudy 计算委托一致：同一输入（baseSec 对应 weekSec）输出逐字段相等。
 */
import { describe, expect, it } from 'vitest';

import { simulateEveningStudy, simulateStudyProgress } from '@/core/stats/forecast';

describe('simulateStudyProgress 当日口径三态（第 238 轮）', () => {
  it('直达达成：今日 20 分 + 再学 15 分 ≥ 目标 30 分 → willHit、overBySec=300', () => {
    const sim = simulateStudyProgress({ baseSec: 20 * 60, extraSec: 15 * 60, targetSec: 30 * 60 });
    expect(sim).not.toBeNull();
    expect(sim!.simulatedSec).toBe(35 * 60);
    expect(sim!.willHit).toBe(true);
    expect(sim!.overBySec).toBe(5 * 60);
    expect(sim!.shortBySec).toBe(0);
  });

  it('仍差：今日 10 分 + 再学 15 分 < 目标 30 分 → shortBySec=300、overBySec=0', () => {
    const sim = simulateStudyProgress({ baseSec: 10 * 60, extraSec: 15 * 60, targetSec: 30 * 60 });
    expect(sim!.willHit).toBe(false);
    expect(sim!.shortBySec).toBe(5 * 60);
    expect(sim!.overBySec).toBe(0);
  });

  it('超额：已达标态（今日 35 分）再学 15 分 → 超额 20 分钟', () => {
    const sim = simulateStudyProgress({ baseSec: 35 * 60, extraSec: 15 * 60, targetSec: 30 * 60 });
    expect(sim!.willHit).toBe(true);
    expect(sim!.overBySec).toBe(20 * 60);
    expect(sim!.shortBySec).toBe(0);
  });

  it('恰好达标：overBySec = shortBySec = 0、willHit = true', () => {
    const sim = simulateStudyProgress({ baseSec: 15 * 60, extraSec: 15 * 60, targetSec: 30 * 60 });
    expect(sim!.willHit).toBe(true);
    expect(sim!.overBySec).toBe(0);
    expect(sim!.shortBySec).toBe(0);
  });

  it('0 学习起步（尚未开始态）：baseSec=0 + 再学 60 分 ≥ 默认目标 30 分 → 达成', () => {
    const sim = simulateStudyProgress({ baseSec: 0, extraSec: 60 * 60, targetSec: 30 * 60 });
    expect(sim!.willHit).toBe(true);
    expect(sim!.overBySec).toBe(30 * 60);
  });
});

describe('simulateStudyProgress 边界防御（与 simulateEveningStudy 同线，第 238 轮）', () => {
  it('extraSec / targetSec 非法 → null（不模拟）', () => {
    expect(simulateStudyProgress({ baseSec: 100, extraSec: 0, targetSec: 1800 })).toBeNull();
    expect(simulateStudyProgress({ baseSec: 100, extraSec: -60, targetSec: 1800 })).toBeNull();
    expect(simulateStudyProgress({ baseSec: 100, extraSec: Number.NaN, targetSec: 1800 })).toBeNull();
    expect(simulateStudyProgress({ baseSec: 100, extraSec: 60, targetSec: 0 })).toBeNull();
    expect(simulateStudyProgress({ baseSec: 100, extraSec: 60, targetSec: Number.NaN })).toBeNull();
    expect(simulateStudyProgress(null as unknown as { baseSec: number; extraSec: number; targetSec: number })).toBeNull();
  });

  it('baseSec 非有限按 0、负数 clamp 到 0（脏数据不产生荒谬结果）', () => {
    const fromNaN = simulateStudyProgress({ baseSec: Number.NaN, extraSec: 900, targetSec: 1800 });
    expect(fromNaN!.shortBySec).toBe(900); // 0 + 900 vs 1800 → 差 900
    const fromNegative = simulateStudyProgress({ baseSec: -500, extraSec: 900, targetSec: 1800 });
    expect(fromNegative!.simulatedSec).toBe(900);
  });
});

describe('simulateStudyProgress 与 simulateEveningStudy 计算委托一致（第 238 轮）', () => {
  it('同一输入（baseSec 对应 weekSec）输出逐字段相等——薄包装不重复实现计算逻辑', () => {
    const cases: Array<{ baseSec: number; extraSec: number; targetSec: number }> = [
      { baseSec: 0, extraSec: 900, targetSec: 1800 },
      { baseSec: 1700, extraSec: 900, targetSec: 1800 },
      { baseSec: 3600, extraSec: 1800, targetSec: 1800 },
      { baseSec: 1234.5, extraSec: 789.2, targetSec: 2000 },
    ];
    for (const c of cases) {
      const viaWrapper = simulateStudyProgress(c);
      const viaEvening = simulateEveningStudy({ weekSec: c.baseSec, extraSec: c.extraSec, targetSec: c.targetSec });
      expect(viaWrapper).toEqual(viaEvening);
    }
  });
});
