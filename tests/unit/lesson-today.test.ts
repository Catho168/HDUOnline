/**
 * 本课今日已学聚合（core/stats/lessonToday.ts，第 241 轮巡检）纯函数单测：
 *  - 按 courId 过滤 + 只计 valid=true（与报表 buildReport 口径一致）；
 *  - durationSec 非法/负数按 0 计，合计四舍五入；
 *  - 防御式：records 非数组 / courId 非有限数返回 0。
 */

import { describe, expect, it } from 'vitest';
import { sumLessonValidSec } from '@/core/stats/lessonToday';

function rec(courId: number, durationSec: number, valid: boolean): Record<string, unknown> {
  return { courId, durationSec, valid };
}

describe('sumLessonValidSec', () => {
  it('按 courId 过滤并合计 valid 流水，invalid 不计', () => {
    const records = [
      rec(101, 60, true),
      rec(101, 120, true),
      rec(101, 999, false), // 挂机/异常：保留审计但不进报表
      rec(202, 300, true), // 其他课次
    ];
    expect(sumLessonValidSec(records, 101)).toBe(180);
    expect(sumLessonValidSec(records, 202)).toBe(300);
  });

  it('durationSec 非法（非数/负数/Infinity）按 0 计，合计取整', () => {
    expect(
      sumLessonValidSec([rec(1, 10.4, true), rec(1, -5, true), rec(1, NaN, true), rec(1, Infinity, true), rec(1, 0.6, true)], 1),
    ).toBe(11); // 10.4 + 0.6 = 11
  });

  it('防御式：非数组 records / 非有限 courId / 空列表返回 0', () => {
    expect(sumLessonValidSec(null, 1)).toBe(0);
    expect(sumLessonValidSec('nope', 1)).toBe(0);
    expect(sumLessonValidSec([rec(1, 60, true)], NaN)).toBe(0);
    expect(sumLessonValidSec([], 1)).toBe(0);
  });
});
