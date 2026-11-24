/**
 * buildWeeklyHighlight 纯函数测试（第 250 轮巡检，激励域 / 榜样视角）。
 *
 * 覆盖五档优先级与边界：
 *  ① 周目标达成（≥ target，含跨过 1 小时文案取一位小数）；目标未设 / 非有限 → 跳过本档；
 *  ② 打卡 ≥ 5 天（CHECKIN_MIN_SEC 线）；4 天不触发；
 *  ③ 单日峰值（分钟取整、周X 标签、并列取更近今日、0 秒不构成亮点）；
 *  ④ 复习完成最多的一日（仅本周 done、并列取更近今日、reviews 缺省落空）；
 *  ⑤ 无亮点 → null。
 * 另含：与 stats.period 周桶同源交叉验证（buildPeriodReport 周桶 internalSec 喂入
 * 得到与 weeklyGoalStreak 一致的达成判定）、脏数据防御、now 契约违约抛错。
 */

import { describe, expect, it } from 'vitest';
import { CHECKIN_MIN_SEC } from '@/core/stats/aggregate';
import { buildPeriodReport, weeklyGoalStreak } from '@/core/stats/period';
import { buildWeeklyHighlight, type WeeklyHighlightDay } from '@/core/stats/weeklyHighlight';
import type { WatchRecordEntity } from '@/core/shared/types';
import { localDayKey } from '@/core/shared/utils';

/** 固定锚点：2026-11-18（周三）12:00 本地时间 */
const NOW = new Date(2026, 10, 18, 12, 0, 0, 0).getTime();
/** 周五 12:00（本周已过 5 个自然日，打卡满 5 天档用） */
const NOW_FRI = new Date(2026, 10, 20, 12, 0, 0, 0).getTime();
/** 周日 21:00（本周 7 个自然日全过完，打卡满 7 天档用） */
const NOW_SUN = new Date(2026, 10, 22, 21, 0, 0, 0).getTime();
const MONDAY = '2026-11-16';

/** 造一周日报（date → validSec；未给出的日子不出现） */
function days(map: Record<string, number>): WeeklyHighlightDay[] {
  return Object.entries(map).map(([date, validSec]) => ({ date, validSec }));
}

describe('buildWeeklyHighlight（第 250 轮巡检）', () => {
  // ── ① 周目标达成 ──
  it('① weekSec ≥ target →「本周学习 X.X 小时，达成周目标」（一位小数）', () => {
    expect(buildWeeklyHighlight({ weekSec: 2.5 * 3600, weeklyTargetSec: 2 * 3600, days: [], now: NOW })).toEqual({
      tier: 1,
      text: '本周学习 2.5 小时，达成周目标',
    });
    // 恰好等于目标也算达成
    expect(buildWeeklyHighlight({ weekSec: 5 * 3600, weeklyTargetSec: 5 * 3600, days: [], now: NOW })?.tier).toBe(1);
  });

  it('① 目标未设（0 / 负数 / 非有限）→ 跳过本档（哪怕 weekSec 很大）', () => {
    for (const target of [0, -1, Number.NaN, undefined]) {
      const result = buildWeeklyHighlight({ weekSec: 9 * 3600, weeklyTargetSec: target as number, days: [], now: NOW });
      // 无 days / reviews 时落到 null（不误报目标达成）
      expect(result).toBeNull();
    }
  });

  // ── ② 打卡满 5 天 ──
  it('② 打卡 5 天（≥ CHECKIN_MIN_SEC）→「本周打卡 5 天」；不足 5 天不触发', () => {
    const week: Record<string, number> = {};
    for (let i = 0; i < 5; i += 1) {
      week[`${MONDAY.slice(0, 8)}${String(16 + i).padStart(2, '0')}`] = CHECKIN_MIN_SEC;
    }
    // 锚点取周五：本周一..周五共 5 天已过（本周未来日子被过滤是正确行为）
    expect(buildWeeklyHighlight({ weekSec: 50 * 60, weeklyTargetSec: 5 * 3600, days: days(week), now: NOW_FRI })).toEqual({
      tier: 2,
      text: '本周打卡 5 天',
    });
    // 4 天 → 落到 ③ 单日峰值
    const four = Object.fromEntries(Object.entries(week).slice(0, 4));
    expect(
      buildWeeklyHighlight({ weekSec: 40 * 60, weeklyTargetSec: 5 * 3600, days: days(four), now: NOW_FRI })?.tier,
    ).toBe(3);
  });

  it('② 打卡 7 天如实报 7（不封顶文案；锚点取周日）', () => {
    const week: Record<string, number> = {};
    for (let i = 0; i < 7; i += 1) {
      week[`${MONDAY.slice(0, 8)}${String(16 + i).padStart(2, '0')}`] = CHECKIN_MIN_SEC;
    }
    expect(buildWeeklyHighlight({ weekSec: 70 * 60, weeklyTargetSec: 5 * 3600, days: days(week), now: NOW_SUN })?.text).toBe(
      '本周打卡 7 天',
    );
  });

  // ── ③ 单日峰值 ──
  it('③ 单日峰值分钟数与周几标签（跨档回落：目标未达成、打卡不足）', () => {
    const week = { '2026-11-16': 10 * 60, '2026-11-18': 42.6 * 60, '2026-11-17': 3 * 60 };
    expect(buildWeeklyHighlight({ weekSec: 55.6 * 60, weeklyTargetSec: 5 * 3600, days: days(week), now: NOW })).toEqual({
      tier: 3,
      text: '单日峰值 43 分钟（周三）',
    });
  });

  it('③ 峰值并列取更近今日的一日', () => {
    const week = { '2026-11-16': 30 * 60, '2026-11-18': 30 * 60 };
    expect(buildWeeklyHighlight({ weekSec: 60 * 60, weeklyTargetSec: 9 * 3600, days: days(week), now: NOW })?.text).toBe(
      '单日峰值 30 分钟（周三）',
    );
  });

  it('③ 峰值仅统计本周窗口：上周的日子不参与（days 含旧窗口数据也安全）', () => {
    const week = { '2026-11-09': 120 * 60, '2026-11-17': 20 * 60 };
    expect(buildWeeklyHighlight({ weekSec: 20 * 60, weeklyTargetSec: 5 * 3600, days: days(week), now: NOW })?.text).toBe(
      '单日峰值 20 分钟（周二）',
    );
  });

  // ── ④ 复习完成最多的一日（③ 档落空——本周无有效观看——才轮到；适合「只复习未看课」的一周） ──
  it('④ 本周 done 最多的一日（reviews 全量入参，仅统计 updatedAt 在本周内）', () => {
    const tue = new Date(2026, 10, 17, 15, 0, 0, 0).getTime();
    const wed1 = new Date(2026, 10, 18, 9, 0, 0, 0).getTime();
    const wed2 = new Date(2026, 10, 18, 11, 0, 0, 0).getTime(); // 同日第二项（不晚于锚点 12:00）
    const reviews = [
      { status: 'done', updatedAt: tue },
      { status: 'done', updatedAt: wed1 },
      { status: 'done', updatedAt: wed2 },
      { status: 'pending', updatedAt: NOW }, // 非 done 不计
      { status: 'done', updatedAt: new Date(2026, 10, 10, 9, 0, 0, 0).getTime() }, // 上周不计
    ];
    expect(
      buildWeeklyHighlight({ weekSec: 0, weeklyTargetSec: 5 * 3600, days: [], reviews, now: NOW })?.text,
    ).toBe('本周周三完成复习 2 项，是一周里最稠密的一天');
  });

  it('④ reviews 缺省 / 无本周 done → 落空（不误报）', () => {
    const base = { weekSec: 0, weeklyTargetSec: 5 * 3600, days: [], now: NOW };
    expect(buildWeeklyHighlight(base)).toBeNull();
    expect(buildWeeklyHighlight({ ...base, reviews: [{ status: 'done', updatedAt: new Date(2026, 10, 10).getTime() }] })).toBeNull();
    expect(buildWeeklyHighlight({ ...base, reviews: 'dirty' as never })).toBeNull();
  });

  // ── ⑤ 无亮点 ──
  it('⑤ 全零 / 空 days → null（不渲染）', () => {
    expect(buildWeeklyHighlight({ weekSec: 0, weeklyTargetSec: 5 * 3600, days: [], now: NOW })).toBeNull();
    expect(
      buildWeeklyHighlight({ weekSec: 0, weeklyTargetSec: 5 * 3600, days: days({ '2026-11-16': 0 }), now: NOW }),
    ).toBeNull();
  });

  // ── 同源交叉验证：stats.period 周桶喂入与 weeklyGoalStreak 达成判定一致 ──
  it('与 stats.period 周桶同源：周桶 internalSec 达成目标时 ① 档触发（口径交叉验证）', () => {
    // 本周（周一 2026-11-16 起）两条 valid 流水，合计 1.2h；上周不给
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
    const records = [mk(monTs, 1800), mk(monTs + 3600_000, 2520)]; // 0.5h + 0.7h = 1.2h
    const report = buildPeriodReport({ kind: 'week', count: 2, now: NOW, records });
    const currentWeek = report.buckets[report.buckets.length - 1];
    if (!currentWeek) throw new Error('测试前置失败：周桶应存在');
    expect(currentWeek.internalSec).toBe(4320);

    // 周桶数据直接喂入亮点函数：目标 1h → ① 档「1.2 小时」
    const highlight = buildWeeklyHighlight({
      weekSec: currentWeek.internalSec,
      weeklyTargetSec: 3600,
      days: days({ '2026-11-16': 4320 }),
      now: NOW,
    });
    expect(highlight).toEqual({ tier: 1, text: '本周学习 1.2 小时，达成周目标' });

    // 周桶数据喂 weeklyGoalStreak（达成 → ≥1）：两条口径对同一份数据判定一致；
    // 目标抬高到 2h 后两者同时判「未达成」（亮点回落 ③，streak 不计本周）
    expect(weeklyGoalStreak(report.buckets, 3600)).toBe(1);
    expect(buildWeeklyHighlight({
      weekSec: currentWeek.internalSec,
      weeklyTargetSec: 2 * 3600,
      days: days({ '2026-11-16': 4320 }),
      now: NOW,
    })?.tier).toBe(3);
    expect(weeklyGoalStreak(report.buckets, 2 * 3600)).toBe(0);
  });

  // ── 脏数据防御 ──
  it('脏数据逐条跳过：非对象行 / 缺 date / 非有限 validSec / 乱序与重复日', () => {
    const dirtyDays = [
      null,
      42,
      { validSec: 100 }, // 缺 date
      { date: '2026-11-17', validSec: Number.NaN },
      { date: '2026-11-18', validSec: '600' as unknown as number }, // 非数值 → 0，不构成峰值
      { date: '2026-11-16', validSec: 600 },
      { date: '2026-11-16', validSec: 900 }, // 重复日：去重取首条（600）
    ] as unknown as WeeklyHighlightDay[];
    expect(
      buildWeeklyHighlight({ weekSec: 25 * 60, weeklyTargetSec: 5 * 3600, days: dirtyDays, now: NOW })?.text,
    ).toBe('单日峰值 10 分钟（周一）');
  });

  it('days 非数组 / reviews 脏行安全，等价空数据', () => {
    expect(buildWeeklyHighlight({ weekSec: 100, weeklyTargetSec: 0, days: 'x' as never, now: NOW })).toBeNull();
    expect(
      buildWeeklyHighlight({ weekSec: 100, weeklyTargetSec: 0, days: [undefined as never], now: NOW }),
    ).toBeNull();
  });

  it('now 非有限 → 契约违约抛错（纯函数约定，与 period.periodBuckets 同款）', () => {
    expect(() => buildWeeklyHighlight({ weekSec: 0, weeklyTargetSec: 0, days: [], now: Number.NaN })).toThrow();
    expect(() =>
      buildWeeklyHighlight({ weekSec: 0, weeklyTargetSec: 0, days: [], now: undefined as unknown as number }),
    ).toThrow();
  });
});
