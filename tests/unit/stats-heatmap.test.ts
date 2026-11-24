/**
 * 学习热力图纯函数单测（第 77 轮巡检）：core/stats/heatmap 的窗口/周界/合并口径
 * 与档位切分行为锁定。now 一律注入固定本地时刻（2026-11-18 周三 12:00），
 * 期望的周一日键为 2026-11-16（与 startOfLocalWeek 既有惯例对齐）。
 */
import { describe, expect, it } from 'vitest';
import type { ExternalWatchEntity, WatchRecordEntity } from '@/core/shared/types';
import {
  buildActivityHeatmap,
  buildMonthlyHeatmap,
  clampHeatmapMonths,
  clampHeatmapWeeks,
  heatLevel,
  heatmapWindowStartDay,
  HEATMAP_DEFAULT_WEEKS,
} from '@/core/stats/heatmap';

/** 固定「今天」：2026-11-18（周三）本地 12:00 */
const NOW = new Date(2026, 10, 18, 12, 0, 0, 0).getTime();

function rec(date: string, durationSec: number, valid = true): WatchRecordEntity {
  return { date, durationSec, valid, courId: 1, teclId: 1 } as unknown as WatchRecordEntity;
}

function ext(date: string, bvid: string, seconds: number): ExternalWatchEntity {
  return { id: `${date}:${bvid}`, date, bvid, seconds } as ExternalWatchEntity;
}

describe('clampHeatmapWeeks / heatmapWindowStartDay', () => {
  it('周数钳制：缺省 26，下界 1，上界 52，非有限回退默认，小数四舍五入', () => {
    expect(clampHeatmapWeeks(undefined)).toBe(HEATMAP_DEFAULT_WEEKS);
    expect(clampHeatmapWeeks(0)).toBe(1);
    expect(clampHeatmapWeeks(-3)).toBe(1);
    expect(clampHeatmapWeeks(100)).toBe(52);
    expect(clampHeatmapWeeks(12.4)).toBe(12);
    expect(clampHeatmapWeeks(Number.NaN)).toBe(HEATMAP_DEFAULT_WEEKS);
  });

  it('窗口起点按本地周一为界回退（含当前周）', () => {
    expect(heatmapWindowStartDay(NOW, 1)).toBe('2026-11-16');
    expect(heatmapWindowStartDay(NOW, 4)).toBe('2026-10-26');
  });
});

describe('buildActivityHeatmap', () => {
  it('now 非有限按契约违约抛错', () => {
    expect(() => buildActivityHeatmap({ now: Number.NaN })).toThrow(/now/);
  });

  it('周列 × 7 行结构：首列为回退后的周一，今天高亮，未来日标记 isFuture', () => {
    const data = buildActivityHeatmap({ now: NOW, weeks: 2 });
    expect(data.weekCount).toBe(2);
    expect(data.weeks).toHaveLength(2);
    expect(data.weeks[0]?.startDay).toBe('2026-11-09');
    expect(data.weeks[1]?.startDay).toBe('2026-11-16');
    for (const week of data.weeks) {
      expect(week.days).toHaveLength(7);
    }
    // 每列首日为周一：2026-11-09 与 2026-11-16 均为周一（间隔 7 天）
    expect(data.weeks[0]?.days[0]?.date).toBe('2026-11-09');
    expect(data.weeks[1]?.days[0]?.date).toBe('2026-11-16');
    // 今天 = 2026-11-18（第二列第 3 格）；未来日 = 11-19..11-22
    expect(data.weeks[1]?.days[2]?.isToday).toBe(true);
    expect(data.weeks[1]?.days[2]?.date).toBe('2026-11-18');
    expect(data.weeks[1]?.days[3]?.isFuture).toBe(true);
    expect(data.weeks[1]?.days[6]?.isFuture).toBe(true);
    expect(data.weeks[0]?.days.every((d) => !d.isFuture)).toBe(true);
  });

  it('日秒数 = 站内 valid 流水 + 站外流水合并；脏数据逐条跳过', () => {
    const data = buildActivityHeatmap({
      now: NOW,
      weeks: 2,
      records: [
        rec('2026-11-17', 100),
        rec('2026-11-17', 40), // 同日第二条累加
        rec('2026-11-16', 999, false), // invalid 流水不计
        rec('2026-11-15', 0), // 非正秒数不计
        rec('2026-11-14', -5), // 负数不计
      ],
      externalRecords: [
        ext('2026-11-17', 'BV1', 50),
        ext('2026-11-17', '', 70), // 缺 bvid 跳过
        ext('2026-11-16', 'BV2', Number.NaN), // 非有限跳过
      ],
    });
    const byDay = new Map(data.weeks.flatMap((w) => w.days).map((d) => [d.date, d]));
    expect(byDay.get('2026-11-17')?.sec).toBe(190); // 100 + 40 + 50
    expect(byDay.get('2026-11-16')?.sec).toBe(0);
    expect(data.activeDays).toBe(1);
    expect(data.totalSec).toBe(190);
    expect(data.maxDaySec).toBe(190);
  });

  it('档位按有学习日四分位切分：[100,200,300,400] → 阈值 [200,300,400]', () => {
    const data = buildActivityHeatmap({
      now: NOW,
      weeks: 2,
      records: [
        rec('2026-11-09', 100),
        rec('2026-11-10', 200),
        rec('2026-11-11', 300),
        rec('2026-11-12', 400),
      ],
    });
    expect(data.thresholds).toEqual([200, 300, 400]);
    const byDay = new Map(data.weeks.flatMap((w) => w.days).map((d) => [d.date, d]));
    expect(byDay.get('2026-11-09')?.level).toBe(1); // ≤ Q1
    expect(byDay.get('2026-11-10')?.level).toBe(2); // ≤ 中位
    expect(byDay.get('2026-11-11')?.level).toBe(3); // ≤ Q3
    expect(byDay.get('2026-11-12')?.level).toBe(4); // > Q3
  });

  it('窗口内无学习：阈值 [0,0,0]、档位全 0、活跃 0 天，仍输出完整网格', () => {
    const data = buildActivityHeatmap({ now: NOW, weeks: 4 });
    expect(data.thresholds).toEqual([0, 0, 0]);
    expect(data.activeDays).toBe(0);
    expect(data.totalSec).toBe(0);
    expect(data.weeks).toHaveLength(4);
    expect(data.weeks.flatMap((w) => w.days).every((d) => d.level === 0)).toBe(true);
  });

  it('heatLevel：0 与负数恒为 0 档；阈值下界不含，≥Q3 为最高档', () => {
    const t: [number, number, number] = [100, 200, 300];
    expect(heatLevel(0, t)).toBe(0);
    expect(heatLevel(-1, t)).toBe(0);
    expect(heatLevel(1, t)).toBe(1);
    expect(heatLevel(99, t)).toBe(1);
    expect(heatLevel(100, t)).toBe(2);
    expect(heatLevel(101, t)).toBe(2);
    expect(heatLevel(200, t)).toBe(3);
    expect(heatLevel(300, t)).toBe(4);
    expect(heatLevel(301, t)).toBe(4);
  });
});

describe('buildMonthlyHeatmap（月视图，第 81 轮）', () => {
  it('月数钳制：缺省 12，下界 1，上界 24', () => {
    expect(clampHeatmapMonths(undefined)).toBe(12);
    expect(clampHeatmapMonths(0)).toBe(1);
    expect(clampHeatmapMonths(100)).toBe(24);
    expect(clampHeatmapMonths(Number.NaN)).toBe(12);
  });

  it('月列结构：近 2 个月 = 10 月（31 天）+ 11 月（30 天，未来日补位标记）', () => {
    const data = buildMonthlyHeatmap({ now: NOW, months: 2 });
    expect(data.monthCount).toBe(2);
    expect(data.months).toHaveLength(2);
    expect(data.months[0]?.key).toBe('2026-10');
    expect(data.months[0]?.days).toHaveLength(31);
    expect(data.months[1]?.key).toBe('2026-11');
    expect(data.months[1]?.days).toHaveLength(30);
    expect(data.months[0]?.label).toBe('10月');
    // 今天 = 11-18：所在月列内高亮，之后为未来日
    expect(data.months[1]?.days[17]?.isToday).toBe(true);
    expect(data.months[1]?.days[29]?.isFuture).toBe(true);
  });

  it('口径与周视图一致：合并站内外、脏数据跳过、四分位档位', () => {
    const data = buildMonthlyHeatmap({
      now: NOW,
      months: 2,
      records: [rec('2026-11-17', 3600), rec('2026-11-16', 1800), rec('2026-11-10', 600), rec('2026-11-09', 1200)],
      externalRecords: [ext('2026-11-17', 'BV1', 600)],
    });
    expect(data.activeDays).toBe(4);
    // 11-17 = 3600 + 600 = 4200s 为峰值；合计 = 站内 7200 + 站外 600 = 7800
    expect(data.maxDaySec).toBe(4200);
    expect(data.totalSec).toBe(7800);
    const nov17 = data.months[1]?.days[16];
    expect(nov17?.level).toBe(4);
  });

  it('now 非有限按契约违约抛错', () => {
    expect(() => buildMonthlyHeatmap({ now: Number.NaN })).toThrow(/now/);
  });
});
