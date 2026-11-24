/** 共享工具单测（第 167 轮巡检）：safeJsonParseStringArray 防御式解析 + formatBytes 口径；第 180 轮补 formatMonthDay；第 187 轮补 formatCount99；第 190 轮补 nextMenuFocusIndex；第 222 轮补 formatPercent。 */
import { describe, expect, it } from 'vitest';
import { formatBytes, formatCount99, formatMonthDay, formatPercent, nextMenuFocusIndex, safeJsonParseStringArray } from '@/core/shared/utils';

describe('nextMenuFocusIndex（菜单键盘导航，第 190 轮）', () => {
  it('ArrowDown/ArrowUp 相对移动并夹在首尾', () => {
    expect(nextMenuFocusIndex('ArrowDown', 3, 0)).toBe(1);
    expect(nextMenuFocusIndex('ArrowDown', 3, 2)).toBe(2);
    expect(nextMenuFocusIndex('ArrowUp', 3, 2)).toBe(1);
    expect(nextMenuFocusIndex('ArrowUp', 3, 0)).toBe(0);
  });
  it('Home/End 跳首尾；其它按键不移动', () => {
    expect(nextMenuFocusIndex('Home', 3, 2)).toBe(0);
    expect(nextMenuFocusIndex('End', 3, 0)).toBe(2);
    expect(nextMenuFocusIndex('Enter', 3, 1)).toBe(-1);
  });
  it('空菜单 / 越界 activeIndex 防御', () => {
    expect(nextMenuFocusIndex('ArrowDown', 0, 0)).toBe(-1);
    expect(nextMenuFocusIndex('ArrowDown', 3, 99)).toBe(2);
    expect(nextMenuFocusIndex('ArrowDown', Number.NaN, 0)).toBe(-1);
  });
});

describe('formatCount99（计数徽标 99+ 折叠，第 187 轮）', () => {
  it('≤99 原样、>99 折叠 99+、非法值回退 0', () => {
    expect(formatCount99(1)).toBe('1');
    expect(formatCount99(99)).toBe('99');
    expect(formatCount99(100)).toBe('99+');
    expect(formatCount99(9999)).toBe('99+');
    expect(formatCount99(0)).toBe('0');
    expect(formatCount99(-3)).toBe('0');
    expect(formatCount99(Number.NaN)).toBe('0');
  });
});

describe('safeJsonParseStringArray（sessionStorage 防御式解析，第 167 轮）', () => {
  it('合法字符串数组正常解析', () => {
    expect(safeJsonParseStringArray('["a","b"]')).toEqual(['a', 'b']);
    expect(safeJsonParseStringArray('[]')).toEqual([]);
  });
  it('非法 JSON / 非数组 / 非字符串元素 / 空入参均回退空数组', () => {
    expect(safeJsonParseStringArray('not-json{')).toEqual([]);
    expect(safeJsonParseStringArray('{"a":1}')).toEqual([]);
    expect(safeJsonParseStringArray('[1,2,3]')).toEqual([]);
    expect(safeJsonParseStringArray('["ok",42,null]')).toEqual(['ok']);
    expect(safeJsonParseStringArray('')).toEqual([]);
    expect(safeJsonParseStringArray(null)).toEqual([]);
    expect(safeJsonParseStringArray(undefined)).toEqual([]);
  });
});

describe('formatMonthDay（月日短格式，第 180 轮）', () => {
  it('正常时间戳输出 MM/DD（补零）', () => {
    expect(formatMonthDay(Date.parse('2026-01-05T12:00:00'))).toBe('01/05');
    expect(formatMonthDay(Date.parse('2026-12-31T12:00:00'))).toBe('12/31');
  });
  it('非法时间戳回退空串', () => {
    expect(formatMonthDay(Number.NaN)).toBe('');
    expect(formatMonthDay(0)).toBe('');
    expect(formatMonthDay(-5)).toBe('');
  });
});

describe('formatBytes（字节数人性化展示）', () => {
  it('KB/MB/GB 分档', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
  });
});

describe('formatPercent（批量进度百分比，第 222 轮）', () => {
  it('常规比例四舍五入', () => {
    expect(formatPercent(1, 4)).toBe('25%');
    expect(formatPercent(1, 3)).toBe('33%');
    expect(formatPercent(2, 3)).toBe('67%');
    expect(formatPercent(3, 3)).toBe('100%');
    expect(formatPercent(0, 5)).toBe('0%');
  });
  it('越界/非法入参防御：不产生 >100% 或 NaN', () => {
    expect(formatPercent(7, 5)).toBe('100%');
    expect(formatPercent(-1, 5)).toBe('0%');
    expect(formatPercent(Number.NaN, 5)).toBe('0%');
    expect(formatPercent(1, 0)).toBe('0%');
    expect(formatPercent(1, Number.NaN)).toBe('0%');
  });
});
