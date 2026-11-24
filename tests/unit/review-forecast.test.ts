/**
 * 复习 N 日到期预测聚合（core/plan/reviewForecast.ts，第 241 轮巡检）纯函数单测：
 *  - 逾期归列（dueDate < today，与周历条 buildReviewWeekColumns 同口径）；
 *  - 今日/明日/窗口日/「以后」分布；
 *  - 空列表 / 全 0 / 脏 dueDate 跳过；
 *  - days 参数边界（钳制 [1,31]）；
 *  - isPeak 最高柱判定（并列同亮，全 0 无峰）；
 *  - forecastBarTitle hover 标题（日柱「N 月 N 日 · M 项」/ 逾期 / 以后）。
 */

import { describe, expect, it } from 'vitest';
import { buildReviewForecast, forecastBarTitle } from '@/core/plan/reviewForecast';
import { addDaysKey } from '@/core/shared/utils';

const TODAY = '2026-11-21';

function job(id: string, dueDate: string): { id: string; dueDate: string } {
  return { id, dueDate };
}

describe('buildReviewForecast', () => {
  it('逾期作业归「逾期」首列，仅当有命中才输出该列', () => {
    const bars = buildReviewForecast([job('a', '2026-11-20'), job('b', '2026-11-01'), job('c', TODAY)], TODAY);
    expect(bars[0]).toMatchObject({ key: 'overdue', date: '', dayLabel: '逾期', count: 2 });
    // 无逾期时不输出逾期列：首列直接是今日
    const bars2 = buildReviewForecast([job('a', TODAY)], TODAY);
    expect(bars2[0]).toMatchObject({ key: TODAY, dayLabel: '今日', count: 1 });
  });

  it('今日/明日标签与日键列；第 8 列「以后」合计 dueDate > today+6', () => {
    const bars = buildReviewForecast(
      [
        job('a', TODAY),
        job('b', addDaysKey(TODAY, 1)!),
        job('c', addDaysKey(TODAY, 6)!),
        job('d', addDaysKey(TODAY, 7)!),
        job('e', addDaysKey(TODAY, 30)!),
      ],
      TODAY,
    );
    expect(bars.map((b) => b.key)).toEqual([
      TODAY,
      addDaysKey(TODAY, 1)!,
      addDaysKey(TODAY, 2)!,
      addDaysKey(TODAY, 3)!,
      addDaysKey(TODAY, 4)!,
      addDaysKey(TODAY, 5)!,
      addDaysKey(TODAY, 6)!,
      'later',
    ]);
    expect(bars[0]).toMatchObject({ date: TODAY, dayLabel: '今日', count: 1 });
    expect(bars[1]).toMatchObject({ dayLabel: '明日', count: 1 });
    expect(bars[6]).toMatchObject({ count: 1, dayLabel: '周五' }); // 2026-11-21 是周六 → +6 天是周五
    expect(bars[7]).toMatchObject({ key: 'later', date: '', dayLabel: '以后', count: 2 });
    expect(bars).toHaveLength(8); // 7 天 + 以后（无逾期不输出逾期列）
  });

  it('空列表 / 全 0：恒输出窗口列 + 以后列，无逾期列，无峰', () => {
    const bars = buildReviewForecast([], TODAY);
    expect(bars.map((b) => b.key)).toEqual([TODAY, addDaysKey(TODAY, 1)!, addDaysKey(TODAY, 2)!, addDaysKey(TODAY, 3)!, addDaysKey(TODAY, 4)!, addDaysKey(TODAY, 5)!, addDaysKey(TODAY, 6)!, 'later']);
    expect(bars.every((b) => b.count === 0)).toBe(true);
    expect(bars.every((b) => !b.isPeak)).toBe(true);
  });

  it('脏 dueDate（非 YYYY-MM-DD 形态 / 非字符串 / 缺失）跳过，不进任何列', () => {
    const bars = buildReviewForecast(
      [
        job('a', '2026/11/20'),
        job('b', 'not-a-date'),
        { id: 'd', dueDate: 12345 },
        { id: 'e' },
        job('f', TODAY),
      ] as Array<{ id: string; dueDate: string }>,
      TODAY,
    );
    expect(bars.find((b) => b.key === TODAY)?.count).toBe(1);
    expect(bars.find((b) => b.key === 'overdue')).toBeUndefined();
    expect(bars.find((b) => b.key === 'later')?.count).toBe(0);
  });

  it('越界日键按 dayKeyToTs 规范化口径落列（与周历条同源实现）：2026-13-40 → 2027-02-09', () => {
    // 口径锁定：dayKeyToTs（reviewWeek.ts 同源）用本地 Date 构造，越界月/日被 JS 规范化为
    // 真实日期——'2026-13-40' 即 2027-02-09（未来）→ 归「以后」。与周历条行为一致。
    const bars = buildReviewForecast([job('c', '2026-13-40')], TODAY);
    expect(bars.find((b) => b.key === 'later')?.count).toBe(1);
  });

  it('days 参数边界：days=1 只输出今日 + 以后；days 钳制 [1,31]；非法 todayKey 返回空', () => {
    const jobs = [job('a', addDaysKey(TODAY, 1)!), job('b', addDaysKey(TODAY, 3)!)];
    const bars1 = buildReviewForecast(jobs, TODAY, 1);
    expect(bars1.map((b) => b.key)).toEqual([TODAY, 'later']);
    expect(bars1[1]!.count).toBe(2); // 明日及以后都归「以后」
    // days=0 / 负数 / 超界钳制
    expect(buildReviewForecast([], TODAY, 0)).toHaveLength(2); // 今日 + 以后
    expect(buildReviewForecast([], TODAY, 31)).toHaveLength(32);
    expect(buildReviewForecast([], TODAY, 99)).toHaveLength(32);
    expect(buildReviewForecast([job('a', TODAY)], '2026-11-21x')).toEqual([]);
  });

  it('isPeak 最高柱判定：最大值柱标亮，并列同亮，逾期/以后也参与', () => {
    const bars = buildReviewForecast(
      [
        job('a', '2026-11-01'),
        job('b', TODAY),
        job('c', TODAY),
        job('d', addDaysKey(TODAY, 1)!),
        job('e', addDaysKey(TODAY, 9)!),
        job('f', addDaysKey(TODAY, 10)!),
      ],
      TODAY,
    );
    expect(bars.find((b) => b.key === TODAY)?.isPeak).toBe(true); // 今日 2 = 全列最大
    expect(bars.find((b) => b.key === 'later')?.isPeak).toBe(true); // 以后 2 与今日并列同亮
    expect(bars.find((b) => b.key === 'overdue')?.isPeak).toBe(false); // 逾期 1 不是峰
    expect(bars.find((b) => b.key === addDaysKey(TODAY, 1)!)?.isPeak).toBe(false);
  });

  it('forecastBarTitle：日柱「N 月 N 日 · M 项」，逾期/以后给文字标签', () => {
    expect(forecastBarTitle({ date: TODAY, dayLabel: '今日', count: 3 })).toBe('11 月 21 日 · 3 项');
    expect(forecastBarTitle({ date: '', dayLabel: '逾期', count: 2 })).toBe('逾期 · 2 项');
    expect(forecastBarTitle({ date: '', dayLabel: '以后', count: 5 })).toBe('以后 · 5 项');
  });
});
