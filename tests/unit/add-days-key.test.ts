/**
 * addDaysKey 单测（第 107 轮巡检）：日键加减天数——本地日历日递推、月末/跨月、非法输入。
 */
import { describe, expect, it } from 'vitest';
import { addDaysKey, nextWeekdayKey } from '@/core/shared/utils';

describe('addDaysKey（日键加减天数，第 107 轮）', () => {
  it('正/负天数与月末边界', () => {
    expect(addDaysKey('2026-11-18', 1)).toBe('2026-11-19');
    expect(addDaysKey('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDaysKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysKey('2026-11-18', -1)).toBe('2026-11-17');
    expect(addDaysKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysKey('2026-11-18', 0)).toBe('2026-11-18');
  });

  it('非法输入返回 null', () => {
    expect(addDaysKey('bad', 1)).toBeNull();
    expect(addDaysKey('2026-11-18', NaN)).toBeNull();
  });
});

describe('nextWeekdayKey（下一个星期几，第 112 轮）', () => {
  it('严格晚于当天：周四→下周一跳 4 天；周五→下周五跳 7 天', () => {
    expect(nextWeekdayKey('2026-11-19', 1)).toBe('2026-11-23'); // 周四 → 下周一
    expect(nextWeekdayKey('2026-11-20', 5)).toBe('2026-11-27'); // 周五 → 下周五
    expect(nextWeekdayKey('2026-11-23', 1)).toBe('2026-11-30'); // 周一 → 下周一
    expect(nextWeekdayKey('2026-11-18', 0)).toBe('2026-11-22'); // 周三 → 周日
  });

  it('非法输入返回 null', () => {
    expect(nextWeekdayKey('bad', 1)).toBeNull();
    expect(nextWeekdayKey('2026-11-18', 7)).toBeNull();
    expect(nextWeekdayKey('2026-11-18', NaN)).toBeNull();
  });
});
