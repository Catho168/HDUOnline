/**
 * 复习倍增间隔刻度条定位纯函数测试（第 246 轮巡检，复习策略域 / 可视化延续视角）。
 *
 * 覆盖 core/plan/reviewSuggest.ts intervalScalePosition 的行为约定：
 *  1. 正常档位：round 1–4 → 下标 0–3（3/7/14/30 天），percent 25/50/75/100；
 *  2. 超出档位：round ≥5 封顶末档（30 天档），round 为小数向下取整；
 *  3. 异常 steps → null：非数组 / 空数组 / 含非正数 / 非数值 / 相等或倒退（非严格递增）；
 *  4. 边界：round 非法（0 / 负数 / NaN / 非数值）→ null；与第 245 轮建议的
 *     口径互认（regular 模板 1–4 轮内：当前高亮档 = 完成当前轮后的建议档）。
 */

import { describe, expect, it } from 'vitest';
import {
  intervalScalePosition,
  nextSuggestIntervalDays,
} from '@/core/plan/reviewSuggest';

describe('intervalScalePosition（正常档位与进度百分比）', () => {
  it('round 1–4 依次落在 3/7/14/30 天档，percent 25/50/75/100', () => {
    expect(intervalScalePosition(1, [1, 3, 7, 16])).toEqual({ index: 0, intervalDays: 3, percent: 25, tiers: 4 });
    expect(intervalScalePosition(2, [1, 3, 7, 16])).toEqual({ index: 1, intervalDays: 7, percent: 50, tiers: 4 });
    expect(intervalScalePosition(3, [1, 3, 7, 16])).toEqual({ index: 2, intervalDays: 14, percent: 75, tiers: 4 });
    expect(intervalScalePosition(4, [1, 3, 7, 16])).toEqual({ index: 3, intervalDays: 30, percent: 100, tiers: 4 });
  });

  it('不同模板间隔只做合法性校验：exam/custom 模板位置仍按 round 推进', () => {
    expect(intervalScalePosition(2, [1, 2, 3, 5, 7])?.index).toBe(1);
    expect(intervalScalePosition(3, [1, 3, 7])?.index).toBe(2);
    expect(intervalScalePosition(3, [1, 3, 7])?.percent).toBe(75);
  });

  it('超出档位封顶末档：round ≥5 停在 30 天档（percent 100）', () => {
    expect(intervalScalePosition(5, [1, 3, 7, 16])).toEqual({ index: 3, intervalDays: 30, percent: 100, tiers: 4 });
    expect(intervalScalePosition(99, [1, 3, 7, 16])?.intervalDays).toBe(30);
    // steps 只有 2 档的自定义模板：round 3 已超出 steps 长度，仍按倍增刻度封顶推进
    expect(intervalScalePosition(3, [3, 10])?.index).toBe(2);
  });

  it('round 小数向下取整（2.9 → 第 2 轮语义）', () => {
    expect(intervalScalePosition(2.9, [1, 3, 7, 16])?.index).toBe(1);
    expect(intervalScalePosition(1.1, [1, 3, 7, 16])?.index).toBe(0);
  });
});

describe('intervalScalePosition（异常 steps → null，调用方不渲染）', () => {
  it('非数组 / 空数组 / null / undefined', () => {
    expect(intervalScalePosition(2, null)).toBeNull();
    expect(intervalScalePosition(2, undefined)).toBeNull();
    expect(intervalScalePosition(2, [])).toBeNull();
    expect(intervalScalePosition(2, '1,3,7' as unknown as number[])).toBeNull();
    expect(intervalScalePosition(2, 7 as unknown as number[])).toBeNull();
  });

  it('元素非法：0 / 负数 / NaN / 非数值', () => {
    expect(intervalScalePosition(2, [0, 3, 7])).toBeNull();
    expect(intervalScalePosition(2, [-1, 3])).toBeNull();
    expect(intervalScalePosition(2, [Number.NaN, 3])).toBeNull();
    expect(intervalScalePosition(2, ['3' as unknown as number, 7])).toBeNull();
    expect(intervalScalePosition(2, [1, Infinity])).toBeNull();
  });

  it('非严格递增：相等或倒退都是脏模板', () => {
    expect(intervalScalePosition(2, [3, 3, 7])).toBeNull();
    expect(intervalScalePosition(2, [7, 3])).toBeNull();
    expect(intervalScalePosition(2, [1, 3, 3])).toBeNull();
  });
});

describe('intervalScalePosition（round 边界）', () => {
  it('round 非法 → null：0、负数、NaN、Infinity、非数值', () => {
    expect(intervalScalePosition(0, [1, 3, 7, 16])).toBeNull();
    expect(intervalScalePosition(-2, [1, 3, 7, 16])).toBeNull();
    expect(intervalScalePosition(Number.NaN, [1, 3, 7, 16])).toBeNull();
    expect(intervalScalePosition(Infinity, [1, 3, 7, 16])).toBeNull();
    expect(intervalScalePosition('2' as unknown as number, [1, 3, 7, 16])).toBeNull();
    expect(intervalScalePosition(undefined, [1, 3, 7, 16])).toBeNull();
  });
});

describe('与第 245 轮完成建议口径互认（同一倍增序列）', () => {
  it('regular 模板 1–4 轮内：当前高亮档 = 完成当前轮后的建议档', () => {
    const regular = [1, 3, 7, 16];
    for (let round = 1; round <= 4; round += 1) {
      const pos = intervalScalePosition(round, regular);
      const suggest = nextSuggestIntervalDays(regular[round - 1]);
      expect(pos?.intervalDays, `round ${round}`).toBe(suggest);
    }
  });

  it('多轮封顶后建议也封顶 30：round 5+（steps 越界回退除外）口径一致', () => {
    // round 5 超出 regular steps 长度 → 建议回退首档 3（lastIntervalForRound undefined），
    // 刻度条封顶末档 30 —— 两者语义不同（进度可视化 vs 建议日期），title 不写「建议」避免误读
    expect(intervalScalePosition(5, [1, 3, 7, 16])?.intervalDays).toBe(30);
    expect(nextSuggestIntervalDays(undefined)).toBe(3);
  });
});
