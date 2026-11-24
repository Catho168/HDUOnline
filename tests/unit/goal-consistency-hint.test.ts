/**
 * 目标合理性提示纯函数单测（core/plan/dailyGoal.ts goalConsistencyHint，第 242 轮巡检）：
 *  - 偏低档：周目标 < 日目标 × 5（gold 提示，给出 5 倍下界小时数）；
 *  - 偏高档：周目标 > 日目标 × 14（danger 提示，给出 14 倍上界小时数）；
 *  - 合理区间：恰在 5×–14× 之间（含边界 5× / 14×）→ null；
 *  - 未设 / 非法：任一目标非有限正数 → null；
 *  - 文案数值格式：整小时不带小数、非整数保留两位内去尾零。
 */

import { describe, expect, it } from 'vitest';
import { goalConsistencyHint, GOAL_WEEKLY_LOW_DAYS, GOAL_WEEKLY_HIGH_DAYS } from '@/core/plan/dailyGoal';

describe('goalConsistencyHint（目标合理性提示，第 242 轮）', () => {
  it('偏低档：周目标 < 5× 日目标 → kind=low，文案含每日分钟与 5 倍下界小时', () => {
    // 每日 60 分钟（=1 小时），周目标 4 小时（< 5 小时下界）
    const hint = goalConsistencyHint(4 * 3600, 60);
    expect(hint).not.toBeNull();
    expect(hint!.kind).toBe('low');
    expect(hint!.text).toBe('周目标可能偏低（按每日目标 60 分钟，一周至少 5 小时）');
    // 每日 30 分钟：下界 150 分钟 = 2.5 小时（非整数保留小数）
    const hint2 = goalConsistencyHint(2 * 3600, 30);
    expect(hint2!.text).toBe('周目标可能偏低（按每日目标 30 分钟，一周至少 2.5 小时）');
  });

  it('偏高档：周目标 > 14× 日目标 → kind=high，文案含 14 倍上界小时', () => {
    // 每日 60 分钟，周目标 15 小时（> 14 小时上界）
    const hint = goalConsistencyHint(15 * 3600, 60);
    expect(hint!.kind).toBe('high');
    expect(hint!.text).toBe('周目标可能偏高（按每日目标 60 分钟，一周最多 14 小时）');
    // 每日 45 分钟：上界 630 分钟 = 10.5 小时
    const hint2 = goalConsistencyHint(11 * 3600, 45);
    expect(hint2!.kind).toBe('high');
    expect(hint2!.text).toBe('周目标可能偏高（按每日目标 45 分钟，一周最多 10.5 小时）');
  });

  it('合理区间：恰在边界（5× / 14×）与之间 → null', () => {
    // 恰好 5×（严格不等号不触发）
    expect(goalConsistencyHint(5 * 3600, 60)).toBeNull();
    // 恰好 14×
    expect(goalConsistencyHint(14 * 3600, 60)).toBeNull();
    // 之间（如 10×）
    expect(goalConsistencyHint(10 * 3600, 60)).toBeNull();
    // 常见组合：每周 5 小时 + 每日 30 分钟（10×）→ 合理
    expect(goalConsistencyHint(5 * 3600, 30)).toBeNull();
    // 常见组合：每周 3 小时 + 每日 60 分钟（3× < 5×）→ 偏低；7× → 合理
    expect(goalConsistencyHint(3 * 3600, 60)!.kind).toBe('low');
    expect(goalConsistencyHint(7 * 3600, 60)).toBeNull();
    // 倍数常量语义自检（防常量被误改）
    expect(GOAL_WEEKLY_LOW_DAYS).toBe(5);
    expect(GOAL_WEEKLY_HIGH_DAYS).toBe(14);
  });

  it('未设 / 非法：任一目标非有限正数 → null', () => {
    // 周目标侧
    expect(goalConsistencyHint(0, 60)).toBeNull(); // 0 视为未设
    expect(goalConsistencyHint(-3600, 60)).toBeNull();
    expect(goalConsistencyHint(Number.NaN, 60)).toBeNull();
    expect(goalConsistencyHint(undefined, 60)).toBeNull();
    expect(goalConsistencyHint('5', 60)).toBeNull();
    // 每日目标侧
    expect(goalConsistencyHint(10 * 3600, 0)).toBeNull();
    expect(goalConsistencyHint(10 * 3600, -30)).toBeNull();
    expect(goalConsistencyHint(10 * 3600, Number.NaN)).toBeNull();
    expect(goalConsistencyHint(10 * 3600, undefined)).toBeNull();
    // 双侧都未设
    expect(goalConsistencyHint(undefined, undefined)).toBeNull();
  });

  it('小时文案格式：整数不带小数、两位内去尾零（30 分钟 → 至少 2.5；25 分钟 → 至少 2.08）', () => {
    // 25 × 5 = 125 分钟 = 2.0833… 小时 → 四舍五入两位 2.08
    const hint = goalConsistencyHint(2 * 3600, 25);
    expect(hint!.text).toContain('一周至少 2.08 小时');
    // 12 分钟 × 14 = 168 分钟 = 2.8 小时（去尾零后一位）
    const hintHigh = goalConsistencyHint(3 * 3600, 12);
    expect(hintHigh!.kind).toBe('high');
    expect(hintHigh!.text).toContain('一周最多 2.8 小时');
  });
});
