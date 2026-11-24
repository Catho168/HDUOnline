/**
 * 周目标连续达成计数 weeklyGoalStreak（core/stats/period.ts，第 235 轮巡检）单测。
 *
 * 口径：含本周——buckets 最后一项即当前周（periodBuckets「旧 → 新」约定）：
 * 本周已达成则从本周起算；本周未达成则跳过本周、从上一个完整周起算回溯连续。
 * goalSec ≤ 0 / 非有限（未设目标）返回 0；无历史 / 空数组返回 0；
 * 桶行脏数据（internalSec 非有限）按未达成处理不抛错。
 */
import { describe, expect, it } from 'vitest';

import { weeklyGoalStreak, type PeriodBucket } from '@/core/stats/period';

const GOAL = 3600;

/** 周桶构造器：internalSec 是唯一参与判定的字段 */
function wk(internalSec: number, over: Partial<PeriodBucket> = {}): PeriodBucket {
  return {
    key: '2026-11-16',
    label: '11.16–11.22',
    chartLabel: '11-16',
    kind: 'week',
    startDay: '2026-11-16',
    endDay: '2026-11-22',
    startTs: 0,
    endTs: 0,
    internalSec,
    externalSec: 0,
    activeDays: 0,
    flowCount: 0,
    plan: null,
    ...over,
  };
}

describe('weeklyGoalStreak 连续达成回溯（第 235 轮）', () => {
  it('本周已达成：从本周起算（含本周）', () => {
    expect(weeklyGoalStreak([wk(GOAL), wk(GOAL), wk(GOAL)], GOAL)).toBe(3);
    expect(weeklyGoalStreak([wk(0), wk(GOAL), wk(GOAL)], GOAL)).toBe(2);
    expect(weeklyGoalStreak([wk(GOAL)], GOAL)).toBe(1);
  });

  it('本周未达成：跳过本周，从上一个完整周起算', () => {
    // 上两周连续达成、本周（最后一桶）进行中未达成 → 仍记 2 周
    expect(weeklyGoalStreak([wk(GOAL), wk(GOAL), wk(100)], GOAL)).toBe(2);
    // 上周未达成 → 0
    expect(weeklyGoalStreak([wk(GOAL), wk(0), wk(100)], GOAL)).toBe(0);
  });

  it('连续中断回溯：只数到最近一个未达成周为止', () => {
    expect(weeklyGoalStreak([wk(GOAL), wk(0), wk(GOAL), wk(GOAL)], GOAL)).toBe(2);
    expect(weeklyGoalStreak([wk(0), wk(GOAL)], GOAL)).toBe(1);
  });

  it('恰等目标算达成（≥ 语义，与周目标 Progress 同线）', () => {
    expect(weeklyGoalStreak([wk(GOAL)], GOAL)).toBe(1);
  });

  it('无历史 / 空数组 / goalSec 非法返回 0；脏桶按未达成处理', () => {
    expect(weeklyGoalStreak([], GOAL)).toBe(0);
    expect(weeklyGoalStreak([wk(GOAL)], 0)).toBe(0);
    expect(weeklyGoalStreak([wk(GOAL)], -5)).toBe(0);
    expect(weeklyGoalStreak([wk(GOAL)], Number.NaN)).toBe(0);
    // 脏桶：internalSec 非有限 → 按未达成，不抛错
    expect(weeklyGoalStreak([{ ...wk(GOAL), internalSec: Number.NaN }], GOAL)).toBe(0);
    // 非数组输入防御（TS 层面不会出现，运行时兜底）
    expect(weeklyGoalStreak(null as unknown as PeriodBucket[], GOAL)).toBe(0);
  });
});
