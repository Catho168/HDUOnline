/**
 * buildWeeklyHighlights 近 N 周亮点回看纯函数测试（第 251 轮巡检，激励域 / 回顾延续视角）。
 *
 * 覆盖：多周回看（旧 → 新排序 + index/current 语义）、跨月周界（11 月→12 月自然
 * 跨界）、kind 与档位一一映射、历史周文案去「本周」前缀、全空省略（无亮点周不占位）、
 * weeks clamp、脏数据防御、now 契约违约抛错；另与 buildReport 交叉验证同源（本周
 * 从 days 派生的 weekSec == report.weekSec，目标达成判定与单周函数一致）。
 */

import { describe, expect, it } from 'vitest';
import { CHECKIN_MIN_SEC } from '@/core/stats/aggregate';
import { buildReport } from '@/core/stats/aggregate';
import { buildWeeklyHighlight, buildWeeklyHighlights, type WeeklyHighlightDay } from '@/core/stats/weeklyHighlight';
import type { WatchRecordEntity } from '@/core/shared/types';
import { localDayKey } from '@/core/shared/utils';

/** 固定锚点：2026-11-18（周三）12:00 本地时间（与 weekly-highlight.test.ts 同锚） */
const NOW = new Date(2026, 10, 18, 12, 0, 0, 0).getTime();
/** 跨月锚点：2026-12-02（周三）12:00——近 4 周回看跨 11 月 / 12 月周界 */
const NOW_DEC = new Date(2026, 11, 2, 12, 0, 0, 0).getTime();

/** 造日报行（date → validSec） */
function days(map: Record<string, number>): WeeklyHighlightDay[] {
  return Object.entries(map).map(([date, validSec]) => ({ date, validSec }));
}

describe('buildWeeklyHighlights（第 251 轮巡检）', () => {
  it('多周回看：旧 → 新排序，index 3..0、仅本周 current=true，周标签为周一起止', () => {
    // 三周各有单日峰值（每周只放一天数据 → ③ 档峰值，避免档位遮蔽）
    const input = days({
      '2026-10-27': 40 * 60, // i=3 周（10-26 周一）的周二
      '2026-11-03': 30 * 60, // i=2 周（11-02 周一）的周二
      '2026-11-11': 20 * 60, // i=1 周（11-09 周一）的周三
      '2026-11-16': 10 * 60, // 本周（11-16 周一）的周一
    });
    const entries = buildWeeklyHighlights({ days: input, weeklyTargetSec: 5 * 3600, weeks: 4, now: NOW });
    // 四周均有亮点（峰值档），旧 → 新
    expect(entries.map((e) => e.weekStart)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
    expect(entries.map((e) => e.index)).toEqual([3, 2, 1, 0]);
    expect(entries.map((e) => e.current)).toEqual([false, false, false, true]);
    expect(entries.map((e) => e.weekLabel)).toEqual([
      '10-26–11-01',
      '11-02–11-08',
      '11-09–11-15',
      '11-16–11-22', // 周标签为完整周界（不随「今天」截断，与 stats.period 周桶 label 同口径）
    ]);
    expect(entries.every((e) => e.kind === 'peak')).toBe(true);
    expect(entries[entries.length - 1]?.text).toBe('单日峰值 10 分钟（周一）');
  });

  it('跨月周界：12 月锚点回看 4 周，11 月内的周标签正确（自然月跨界不断档）', () => {
    const entries = buildWeeklyHighlights({
      days: days({ '2026-11-10': 25 * 60, '2026-11-25': 15 * 60, '2026-12-01': 5 * 60 }),
      weeklyTargetSec: 5 * 3600,
      weeks: 4,
      now: NOW_DEC,
    });
    // 锚点 12-02 周三：本周 = 11-30 起；i=1 = 11-23..11-29；i=2 = 11-16..11-22（无数据 → 省略）；i=3 = 11-09..11-15
    expect(entries.map((e) => e.weekStart)).toEqual(['2026-11-09', '2026-11-23', '2026-11-30']);
    expect(entries.map((e) => e.weekLabel)).toEqual([
      '11-09–11-15',
      '11-23–11-29',
      '11-30–12-06',
    ]);
    expect(entries.map((e) => e.index)).toEqual([3, 1, 0]);
    expect(entries.map((e) => e.text)).toEqual([
      '单日峰值 25 分钟（周二）',
      '单日峰值 15 分钟（周三）',
      '单日峰值 5 分钟（周二）',
    ]);
  });

  it('kind 与档位一一映射：goal/checkin/peak 分别落在对应周（互不遮蔽）', () => {
    // i=2 周达成目标（weekSec 由 days 求和 2.5h ≥ target 2h → goal）
    // i=1 周打卡 5 天（CHECKIN_MIN_SEC × 5 → checkin）
    const input = days({
      '2026-11-03': 2.5 * 3600,
      '2026-11-09': CHECKIN_MIN_SEC,
      '2026-11-10': CHECKIN_MIN_SEC,
      '2026-11-11': CHECKIN_MIN_SEC,
      '2026-11-12': CHECKIN_MIN_SEC,
      '2026-11-13': CHECKIN_MIN_SEC,
      '2026-11-17': 8 * 60,
    });
    const entries = buildWeeklyHighlights({ days: input, weeklyTargetSec: 2 * 3600, weeks: 4, now: NOW });
    const kinds = new Map(entries.map((e) => [e.weekStart, e.kind] as const));
    expect(kinds.get('2026-11-02')).toBe('goal');
    expect(kinds.get('2026-11-09')).toBe('checkin');
    expect(kinds.get('2026-11-16')).toBe('peak');
    expect(entries.find((e) => e.weekStart === '2026-11-02')?.text).toBe('学习 2.5 小时，达成周目标');
    expect(entries.find((e) => e.weekStart === '2026-11-09')?.text).toBe('打卡 5 天');
    expect(entries.find((e) => e.weekStart === '2026-11-16')?.text).toBe('单日峰值 8 分钟（周二）');
  });

  it('历史周文案去「本周」前缀、本周文案保留（同一派生单点实现）', () => {
    const input = days({ '2026-11-17': 2.2 * 3600, '2026-11-10': 2.5 * 3600 });
    const entries = buildWeeklyHighlights({ days: input, weeklyTargetSec: 2 * 3600, weeks: 2, now: NOW });
    // i=1（上周）达成：不带「本周」；i=0（本周）达成：带「本周」
    expect(entries.map((e) => e.text)).toEqual(['学习 2.5 小时，达成周目标', '本周学习 2.2 小时，达成周目标']);
  });

  it('全空 / 无亮点周省略：数组短于周数是正常形态（不占空位）', () => {
    expect(buildWeeklyHighlights({ days: [], weeklyTargetSec: 5 * 3600, weeks: 4, now: NOW })).toEqual([]);
    // 只有本周有亮点：返回 1 条且 current=true
    const entries = buildWeeklyHighlights({ days: days({ '2026-11-16': 600 }), weeklyTargetSec: 5 * 3600, weeks: 4, now: NOW });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ weekStart: '2026-11-16', index: 0, current: true, kind: 'peak' });
    // 全零周不构成亮点（0 秒不触发峰值档）
    expect(buildWeeklyHighlights({ days: days({ '2026-11-10': 0 }), weeklyTargetSec: 0, weeks: 4, now: NOW })).toEqual([]);
  });

  it('weeks 非法 clamp：0/负数 → 1；超 12 → 12；缺省 → 4', () => {
    const input = days({ '2026-11-16': 600 });
    expect(buildWeeklyHighlights({ days: input, weeklyTargetSec: 0, weeks: 0, now: NOW })).toHaveLength(1);
    expect(buildWeeklyHighlights({ days: input, weeklyTargetSec: 0, weeks: -3, now: NOW })).toHaveLength(1);
    expect(buildWeeklyHighlights({ days: input, weeklyTargetSec: 0, weeks: 99, now: NOW })).toHaveLength(1);
    expect(buildWeeklyHighlights({ days: input, weeklyTargetSec: 0, now: NOW })).toHaveLength(1);
    // weeks=12：12 周前（8 月）无数据 → 仍只产出本周 1 条（省略语义不破）
    expect(buildWeeklyHighlights({ days: input, weeklyTargetSec: 0, weeks: 12, now: NOW })).toHaveLength(1);
  });

  it('脏数据防御：非对象 / 缺 date / 非有限 validSec / 重复日取首条', () => {
    const dirtyDays = [
      null,
      42,
      { validSec: 100 }, // 缺 date
      { date: '2026-11-17', validSec: 300 },
      { date: '2026-11-17', validSec: 900 }, // 重复日取首条（300）
      { date: '2026-11-16', validSec: '600' as unknown as number }, // 非数值 → 0
      { date: '2026-11-18', validSec: Number.NaN }, // 归 0：不构成峰值（0 秒不触发）
    ] as unknown as WeeklyHighlightDay[];
    const entries = buildWeeklyHighlights({ days: dirtyDays, weeklyTargetSec: 0, weeks: 4, now: NOW });
    // 本周唯一亮点：峰值 300 秒（5 分钟，周二）——重复日 900 未被采纳
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('单日峰值 5 分钟（周二）');
    // days 非数组安全
    expect(buildWeeklyHighlights({ days: 'x' as never, weeklyTargetSec: 0, weeks: 4, now: NOW })).toEqual([]);
  });

  it('与 buildReport 同源：本周从 days 派生的 weekSec == report.weekSec，目标达成判定与单周函数一致', () => {
    const mk = (startTs: number, sec: number): WatchRecordEntity => ({
      courId: 1,
      teclId: 1,
      date: localDayKey(startTs),
      startTs,
      endTs: startTs + sec * 1000,
      durationSec: sec,
      playMode: 'vod',
      speed: 1,
      firstWatch: true,
      valid: true,
    });
    const monTs = new Date(2026, 10, 16, 10, 0, 0, 0).getTime();
    const lastWeekTs = new Date(2026, 10, 10, 10, 0, 0, 0).getTime();
    const records = [mk(monTs, 1800), mk(monTs + 3600_000, 2520), mk(lastWeekTs, 60 * 60)];
    const report = buildReport({ records, sessions: [], courses: [], windowDays: 30, weeklyTargetSec: 3600, checkinMinSec: CHECKIN_MIN_SEC, now: NOW });
    // report.days（30 天窗口）覆盖近 4 周全部周界
    const entries = buildWeeklyHighlights({ days: report.days, weeklyTargetSec: 3600, weeks: 4, now: NOW });
    const current = entries[entries.length - 1];
    if (!current) throw new Error('测试前置失败：本周亮点应存在');
    // ① 本周达 1.2h ≥ 1h 目标 → goal；文案与单周函数直传 report.weekSec 时一致
    expect(current.kind).toBe('goal');
    expect(current.text).toBe('本周学习 1.2 小时，达成周目标');
    expect(buildWeeklyHighlight({ weekSec: report.weekSec, weeklyTargetSec: 3600, days: report.days, now: NOW })?.text).toBe(current.text);
    // ② 上周 1h（未达 1.2h 目标线之上判分母：上周 1h < 1h? 恰等 → 达成）——上周恰等目标也算达成（与单周口径同）
    const last = entries.find((e) => e.weekStart === '2026-11-09');
    expect(last?.kind).toBe('goal');
    expect(last?.text).toBe('学习 1.0 小时，达成周目标');
    // ③ 阈值抬高后两周三档同回落（单周 / 多周判定一致）
    const raised = buildWeeklyHighlights({ days: report.days, weeklyTargetSec: 2 * 3600, weeks: 4, now: NOW });
    expect(raised.find((e) => e.weekStart === '2026-11-16')?.kind).toBe('peak');
    expect(raised.find((e) => e.weekStart === '2026-11-09')?.kind).toBe('peak');
  });

  it('now 非有限 → 契约违约抛错（纯函数约定，与单周函数同款）', () => {
    expect(() => buildWeeklyHighlights({ days: [], weeklyTargetSec: 0, weeks: 4, now: Number.NaN })).toThrow();
    expect(() => buildWeeklyHighlights({ days: [], weeklyTargetSec: 0, weeks: 4, now: undefined as unknown as number })).toThrow();
  });
});
