/**
 * 列表渐进显示共享切分测试（第 245 轮巡检，性能域）。
 *
 * 覆盖 ui/learning/progressive.ts 的行为约定（与知识库第 225/226 轮策略同口径）：
 *  1. visibleRowsOf：前 N 条切分的边界（恰 60 / 61 / 0 条）与非法 limit 防御；
 *  2. nextVisibleLimit：「显示更多」步长推进（60 → 120 → …）与非法入参回退。
 */

import { describe, expect, it } from 'vitest';
import { VISIBLE_PAGE_STEP, nextVisibleLimit, visibleRowsOf } from '@/entrypoints/content/ui/learning/progressive';

function rowsOf(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

describe('visibleRowsOf（前 N 条切分）', () => {
  it('恰 60 条：limit 60 → 全部返回', () => {
    const rows = rowsOf(60);
    expect(visibleRowsOf(rows, 60)).toHaveLength(60);
    expect(visibleRowsOf(rows, 60)).toEqual(rows);
  });

  it('61 条：limit 60 → 只返回前 60 条（第 61 条留给「显示更多」）', () => {
    const rows = rowsOf(61);
    const shown = visibleRowsOf(rows, 60);
    expect(shown).toHaveLength(60);
    expect(shown[59]).toBe(59);
    expect(rows[60]).toBe(60);
  });

  it('0 条：返回空数组（不抛错）', () => {
    expect(visibleRowsOf([], 60)).toEqual([]);
  });

  it('limit 大于条数：全部返回', () => {
    expect(visibleRowsOf(rowsOf(3), 60)).toHaveLength(3);
  });

  it('非法 limit 防御：0 / 负数 / NaN / 非数值 → 空数组；小数向下取整', () => {
    const rows = rowsOf(10);
    expect(visibleRowsOf(rows, 0)).toEqual([]);
    expect(visibleRowsOf(rows, -5)).toEqual([]);
    expect(visibleRowsOf(rows, Number.NaN)).toEqual([]);
    expect(visibleRowsOf(rows, '60' as unknown as number)).toEqual([]);
    expect(visibleRowsOf(rows, 4.9)).toHaveLength(4);
  });

  it('null / undefined rows 防御：返回空数组', () => {
    expect(visibleRowsOf(null, 60)).toEqual([]);
    expect(visibleRowsOf(undefined, 60)).toEqual([]);
  });
});

describe('nextVisibleLimit（显示更多步长推进）', () => {
  it('默认步长 60：60 → 120 → 180', () => {
    expect(nextVisibleLimit(60)).toBe(120);
    expect(nextVisibleLimit(120)).toBe(180);
    expect(VISIBLE_PAGE_STEP).toBe(60);
  });

  it('自定义步长', () => {
    expect(nextVisibleLimit(30, 30)).toBe(60);
  });

  it('非法入参回退：current 非法按 0 起（= 步长），step 非法回退默认 60', () => {
    expect(nextVisibleLimit(0)).toBe(60);
    expect(nextVisibleLimit(Number.NaN)).toBe(60);
    expect(nextVisibleLimit(60, Number.NaN)).toBe(120);
    expect(nextVisibleLimit(60, 0)).toBe(120);
  });
});
