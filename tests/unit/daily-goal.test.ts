/**
 * 每日目标钳制 clampDailyGoalMin（core/plan/dailyGoal.ts，第 234 轮巡检）单测。
 *
 * 覆盖：
 *  1. 非法回退：undefined / null / NaN / Infinity / 非数字类型（字符串、对象）→ 默认 30；
 *  2. 下界钳制：0 / 负数 / 4.9 → 5（合法域下界）；
 *  3. 上界钳制：600 保留、600 以上（601 / 10000）→ 600；
 *  4. 正常值：区间内整数原样返回，小数四舍五入（30.4 → 30、29.6 → 30、0.5 边界进位）；
 *  5. 定位边界：仅展示与激励层的分母，不改打卡判定线（CHECKIN_MIN_SEC 仍为 10 分钟）。
 */
import { describe, expect, it } from 'vitest';

import { CHECKIN_MIN_SEC } from '@/core/stats/aggregate';
import { clampDailyGoalMin, DAILY_GOAL_MIN_CEIL, DAILY_GOAL_MIN_FLOOR, DEFAULT_DAILY_GOAL_MIN } from '@/core/plan/dailyGoal';

describe('clampDailyGoalMin 非法回退（第 234 轮）', () => {
  it('undefined / null / NaN / Infinity / 非数字 → 默认 30', () => {
    expect(clampDailyGoalMin(undefined)).toBe(DEFAULT_DAILY_GOAL_MIN);
    expect(clampDailyGoalMin(null)).toBe(DEFAULT_DAILY_GOAL_MIN);
    expect(clampDailyGoalMin(Number.NaN)).toBe(DEFAULT_DAILY_GOAL_MIN);
    expect(clampDailyGoalMin(Number.POSITIVE_INFINITY)).toBe(DEFAULT_DAILY_GOAL_MIN);
    expect(clampDailyGoalMin(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_DAILY_GOAL_MIN);
    expect(clampDailyGoalMin('45' as unknown as number)).toBe(DEFAULT_DAILY_GOAL_MIN);
    expect(clampDailyGoalMin({ min: 45 } as unknown as number)).toBe(DEFAULT_DAILY_GOAL_MIN);
    expect(clampDailyGoalMin(true as unknown as number)).toBe(DEFAULT_DAILY_GOAL_MIN);
    expect(DEFAULT_DAILY_GOAL_MIN).toBe(30);
  });
});

describe('clampDailyGoalMin 钳制边界（第 234 轮）', () => {
  it('下界：0 / 负数 / 不足 5 → 5', () => {
    expect(DAILY_GOAL_MIN_FLOOR).toBe(5);
    expect(clampDailyGoalMin(0)).toBe(5);
    expect(clampDailyGoalMin(-10)).toBe(5);
    expect(clampDailyGoalMin(4.2)).toBe(5);
    expect(clampDailyGoalMin(4)).toBe(5);
  });

  it('上界：600 保留，超出（601 / 10000）→ 600', () => {
    expect(DAILY_GOAL_MIN_CEIL).toBe(600);
    expect(clampDailyGoalMin(600)).toBe(600);
    expect(clampDailyGoalMin(601)).toBe(600);
    expect(clampDailyGoalMin(10_000)).toBe(600);
  });

  it('区间内整数原样返回；小数四舍五入', () => {
    expect(clampDailyGoalMin(30)).toBe(30);
    expect(clampDailyGoalMin(45)).toBe(45);
    expect(clampDailyGoalMin(5)).toBe(5);
    expect(clampDailyGoalMin(30.4)).toBe(30);
    expect(clampDailyGoalMin(29.6)).toBe(30);
    expect(clampDailyGoalMin(120.5)).toBe(121);
  });
});

describe('口径边界（第 234 轮）', () => {
  it('每日目标不改变打卡判定线：CHECKIN_MIN_SEC 仍为 10 分钟', () => {
    expect(CHECKIN_MIN_SEC).toBe(600);
  });
});
