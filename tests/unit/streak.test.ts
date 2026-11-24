/**
 * 学习连续天数单测（第 125 轮巡检）：computeStudyStreak——当前连续（含今天未学从昨天起算）、
 * 最长连续、今日激活；activeDaysFromHeatmap——热力图格提取与未来日过滤。
 */
import { describe, expect, it } from 'vitest';
import { activeDaysFromHeatmap, computeStudyStreak } from '@/core/plan/streak';

describe('computeStudyStreak（学习连续天数，第 125 轮）', () => {
  it('连续日键 → 当前与最长连续', () => {
    const r = computeStudyStreak(['2026-11-17', '2026-11-18', '2026-11-19'], '2026-11-19');
    expect(r).toEqual({ current: 3, longest: 3, activeToday: true });
  });

  it('今天未学：当前连续从昨天起算，activeToday=false', () => {
    const r = computeStudyStreak(['2026-11-17', '2026-11-18'], '2026-11-19');
    expect(r).toEqual({ current: 2, longest: 2, activeToday: false });
  });

  it('断档取最长；乱序与重复日键去重', () => {
    const r = computeStudyStreak(
      ['2026-11-19', '2026-11-18', '2026-11-15', '2026-11-14', '2026-11-18', '2026-11-10'],
      '2026-11-19',
    );
    expect(r.current).toBe(2);
    expect(r.longest).toBe(2);
  });

  it('空集与脏数据防御；非法 todayKey 不抛错', () => {
    expect(computeStudyStreak([], '2026-11-19')).toEqual({ current: 0, longest: 0, activeToday: false });
    expect(computeStudyStreak(['x', null as never, 42 as never], '2026-11-19')).toEqual({ current: 0, longest: 0, activeToday: false });
    expect(computeStudyStreak(['2026-11-19'], 'bad-key')).toEqual({ current: 0, longest: 1, activeToday: false });
    expect(computeStudyStreak(null, '2026-11-19')).toEqual({ current: 0, longest: 0, activeToday: false });
  });
});

describe('activeDaysFromHeatmap（热力图 → 活跃日键，第 125 轮）', () => {
  it('提取 sec>0 的日键；过滤未来补位日与晚于今天的日', () => {
    const weeks = [
      { days: [{ date: '2026-11-16', sec: 0 }, { date: '2026-11-17', sec: 600 }] },
      { days: [{ date: '2026-11-19', sec: 120, isFuture: false }, { date: '2026-11-20', sec: 999, isFuture: true }, { date: '2026-11-21', sec: 5 }] },
    ];
    expect(activeDaysFromHeatmap(weeks, '2026-11-19')).toEqual(['2026-11-17', '2026-11-19']);
  });

  it('脏数据与 null 防御', () => {
    expect(activeDaysFromHeatmap(null, '2026-11-19')).toEqual([]);
    expect(activeDaysFromHeatmap([{ days: 'x' as never }, { days: [{ date: 7, sec: 'y' }] }], '2026-11-19')).toEqual([]);
  });
});
