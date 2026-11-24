/**
 * 学习周报 / 月报聚合器测试（纯函数层，core/stats/period）。
 *
 * 覆盖：空数据、周界对齐（周日 / 周一归属）、窗口外数据忽略、站内外合并与活跃天数、
 * 无效流水排除、计划完成度（含降级路径与「当前周只算已到期排期」）、
 * 复习保持率口径（最近一次 done 落月、边界时刻、denominator 全库一致）、
 * 跨年月桶标签、count clamp 与 now 契约。
 */

import { describe, expect, it } from 'vitest';
import {
  buildPeriodReport,
  lastDoneReviewTsByFavorite,
  periodBuckets,
  type PeriodReportInput,
} from '@/core/stats/period';
import type { ReviewJobEntity, WatchRecordEntity } from '@/core/shared/types';
import type { WeeklyPlan } from '@/core/plan/weekly';

/** 生成某本地日的指定时刻（避免 UTC 偏移干扰） */
function at(day: string, hour: number, minute = 0): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hour, minute, 0, 0).getTime();
}

/** 2026-05-06 是周三；其所在周周一为 2026-05-04 */
const NOW = at('2026-05-06', 20);

function record(spec: { date: string; sec: number; valid?: boolean; courId?: number }): WatchRecordEntity {
  return {
    id: undefined,
    courId: spec.courId ?? 1,
    teclId: 9,
    date: spec.date,
    startTs: at(spec.date, 10),
    endTs: at(spec.date, 10) + spec.sec * 1000,
    durationSec: spec.sec,
    playMode: 'vod',
    speed: 1,
    firstWatch: true,
    valid: spec.valid ?? true,
  };
}

function external(date: string, bvid: string, seconds: number) {
  return { id: `${date}:${bvid}`, date, bvid, seconds };
}

function plan(partial: Partial<WeeklyPlan> & { startDate: string; bvids: string[] }): WeeklyPlan {
  return {
    id: 'plan-1',
    perDay: partial.perDay ?? 2,
    bvids: partial.bvids,
    startDate: partial.startDate,
    createdAt: at('2026-05-01', 9),
    updatedAt: at('2026-05-01', 9),
    ...(partial.label ? { label: partial.label } : {}),
  };
}

function favorite(bvid: string, watchedRatio: number) {
  return {
    id: `fav-${bvid}`,
    type: 'video' as const,
    refId: bvid,
    snapshot: { title: bvid, content: '' },
    tags: [],
    pinned: false,
    favoritedAt: at('2026-05-01', 9),
    updatedAt: at('2026-05-01', 9),
    metadata: { platform: 'bilibili', bvid, watchedRatio },
  };
}

function job(spec: { favoriteId: string; status: ReviewJobEntity['status']; doneAt?: number }): ReviewJobEntity {
  return {
    id: `job-${spec.favoriteId}`,
    favoriteId: spec.favoriteId,
    dueDate: '2026-05-06',
    round: 1,
    template: 'regular',
    status: spec.status,
    createdAt: at('2026-04-01', 9),
    updatedAt: spec.doneAt ?? at('2026-04-01', 9),
  };
}

function weekInput(patch: Partial<PeriodReportInput> = {}): PeriodReportInput {
  return { kind: 'week', count: 8, now: NOW, ...patch };
}

describe('periodBuckets（周期列表）', () => {
  it('周桶以周一为界，含起止 / 标签 / ts；当前周为最后一个', () => {
    const buckets = periodBuckets('week', 8, NOW);
    expect(buckets).toHaveLength(8);
    expect(buckets[0]?.startDay).toBe('2026-03-16'); // 2026-05-04 往前 7 周
    expect(buckets[0]?.endDay).toBe('2026-03-22');
    expect(buckets[0]?.key).toBe('2026-03-16');
    expect(buckets[0]?.label).toBe('03-16–03-22');
    expect(buckets[7]?.startDay).toBe('2026-05-04');
    expect(buckets[7]?.endDay).toBe('2026-05-10');
    expect(buckets[7]?.label).toBe('05-04–05-10');
    // startTs = 周一 00:00；endTs = 次周一 00:00（不含）
    expect(buckets[7]?.startTs).toBe(at('2026-05-04', 0));
    expect(buckets[7]?.endTs).toBe(at('2026-05-11', 0));
  });

  it('月桶为自然月，跨年时键与标签带年份', () => {
    const buckets = periodBuckets('month', 6, NOW);
    expect(buckets.map((b) => b.key)).toEqual(['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
    expect(buckets[0]?.label).toBe('2025年12月');
    expect(buckets[0]?.chartLabel).toBe('25年12月');
    expect(buckets[5]?.label).toBe('2026年5月');
    expect(buckets[5]?.chartLabel).toBe('5月');
    expect(buckets[0]?.startDay).toBe('2025-12-01');
    expect(buckets[0]?.endDay).toBe('2025-12-31');
    expect(buckets[0]?.startTs).toBe(at('2025-12-01', 0));
    expect(buckets[0]?.endTs).toBe(at('2026-01-01', 0));
    expect(buckets[5]?.endDay).toBe('2026-05-31');
    expect(buckets[5]?.endTs).toBe(at('2026-06-01', 0));
  });

  it('count 缺省用默认（周 8 / 月 6），非法值回退并 clamp 到 [1, max]', () => {
    expect(periodBuckets('week', undefined, NOW)).toHaveLength(8);
    expect(periodBuckets('month', undefined, NOW)).toHaveLength(6);
    expect(periodBuckets('week', 0, NOW)).toHaveLength(1);
    expect(periodBuckets('week', -5, NOW)).toHaveLength(1);
    expect(periodBuckets('week', 999, NOW)).toHaveLength(104);
    expect(periodBuckets('month', 999, NOW)).toHaveLength(60);
    expect(periodBuckets('week', Number.NaN, NOW)).toHaveLength(8);
  });

  it('now 非有限抛错（纯函数契约：「今天」必须由调用方注入）', () => {
    expect(() => periodBuckets('week', 8, Number.NaN)).toThrow();
    expect(() => periodBuckets('week', 8, undefined as unknown as number)).toThrow();
  });
});

describe('buildPeriodReport：空数据与防御', () => {
  it('空数据：全零桶，周报 plan / 月报 review 均为 null，不抛错', () => {
    const week = buildPeriodReport(weekInput());
    expect(week.kind).toBe('week');
    expect(week.count).toBe(8);
    expect(week.todayKey).toBe('2026-05-06');
    expect(week.buckets.every((b) => b.internalSec === 0 && b.externalSec === 0 && b.activeDays === 0 && b.flowCount === 0)).toBe(true);
    expect(week.buckets.every((b) => b.plan === null)).toBe(true);
    expect(week.totalInternalSec).toBe(0);

    const month = buildPeriodReport({ kind: 'month', now: NOW });
    expect(month.buckets.every((b) => b.review === null)).toBe(true);
    expect(month.buckets.every((b) => b.plan === undefined)).toBe(true);
  });

  it('脏数据（非数组 / null 元素 / 字段缺失）逐条跳过不抛错', () => {
    const report = buildPeriodReport({
      kind: 'week',
      now: NOW,
      records: [null, record({ date: '2026-05-04', sec: 60 })] as unknown as WatchRecordEntity[],
      externalRecords: [{ date: '2026-05-04' }, { date: '2026-05-04', bvid: 'BV1', seconds: -5 }, 'x'] as unknown as PeriodReportInput['externalRecords'],
      plans: [null] as unknown as WeeklyPlan[],
    });
    const current = report.buckets[7];
    expect(current?.internalSec).toBe(60);
    expect(current?.externalSec).toBe(0);
    expect(current?.plan).toBeNull();
  });

  it('同一输入两次聚合结果一致（无 Date.now 副作用）', () => {
    const input = weekInput({
      records: [record({ date: '2026-05-04', sec: 120 })],
      externalRecords: [external('2026-05-05', 'BV9', 30)],
    });
    expect(JSON.stringify(buildPeriodReport(input))).toBe(JSON.stringify(buildPeriodReport(input)));
  });
});

describe('buildPeriodReport：周界对齐与站内外合并', () => {
  it('周日归上一周桶、周一归当前周桶；无效流水不计秒数与条数；窗口外忽略', () => {
    const report = buildPeriodReport(
      weekInput({
        records: [
          record({ date: '2026-05-03', sec: 300 }), // 周日 → 04-27 桶
          record({ date: '2026-05-04', sec: 600 }), // 周一 → 当前周桶
          record({ date: '2026-05-04', sec: 500, valid: false }), // 无效：排除
          record({ date: '2026-03-01', sec: 999 }), // 窗口外（03-16 之前）
        ],
        externalRecords: [external('2026-05-05', 'BV9', 180)],
      }),
    );
    const prev = report.buckets[6]; // 04-27–05-03
    const current = report.buckets[7]; // 05-04–05-10
    expect(prev?.internalSec).toBe(300);
    expect(prev?.flowCount).toBe(1);
    expect(prev?.activeDays).toBe(1);
    expect(current?.internalSec).toBe(600);
    expect(current?.flowCount).toBe(1); // 无效流水不计数
    expect(current?.externalSec).toBe(180);
    // 当前周活跃日 = 站内 05-04 + 站外 05-05
    expect(current?.activeDays).toBe(2);
    expect(report.totalInternalSec).toBe(900);
    expect(report.totalExternalSec).toBe(180);
  });

  it('站外脏数据（seconds 非正数 / 字段缺失）跳过；站外与站内不混算', () => {
    const report = buildPeriodReport(
      weekInput({
        records: [],
        externalRecords: [
          external('2026-05-04', 'BV1', 60),
          external('2026-05-04', 'BV1', 0), // 非正数：忽略
          external('2026-05-04', 'BV2', Number.NaN), // 非有限：忽略
        ],
      }),
    );
    const current = report.buckets[7];
    expect(current?.externalSec).toBe(60);
    expect(current?.internalSec).toBe(0);
    expect(current?.activeDays).toBe(1);
  });
});

describe('buildPeriodReport：周报计划完成度（复用 plan/weekly 口径）', () => {
  it('排期 4 个、完看 2 个、站外流水覆盖 1 个；上一周无排期为 null', () => {
    const p = plan({ startDate: '2026-05-04', bvids: ['BV1A', 'BV2B', 'BV3C', 'BV4D'], perDay: 2 });
    const report = buildPeriodReport(
      weekInput({
        count: 2,
        plans: [p],
        favorites: [favorite('BV1A', 0.97), favorite('BV2B', 0.5), favorite('BV3C', 1)],
        externalRecords: [external('2026-05-05', 'BV3C', 60)],
      }),
    );
    const current = report.buckets[1];
    expect(current?.plan).toEqual({ total: 4, finished: 2, touched: 1, ratio: 0.5 });
    // 计划 05-04 才开始，上一周（04-27–05-03）无排期
    expect(report.buckets[0]?.plan).toBeNull();
  });

  it('降级路径：收藏缺失时 finished 记 0，但排期总数与流水覆盖仍如实统计', () => {
    const p = plan({ startDate: '2026-05-04', bvids: ['BV1A', 'BV2B'], perDay: 2 });
    const report = buildPeriodReport(
      weekInput({
        count: 1,
        plans: [p],
        favorites: [],
        externalRecords: [external('2026-05-04', 'BV2B', 30)],
      }),
    );
    expect(report.buckets[0]?.plan).toEqual({ total: 2, finished: 0, touched: 1, ratio: 0 });
  });

  it('当前周只统计已到期排期（未来天不计入分母）', () => {
    // 今天 05-06 开始的计划：今天排 2 个，明天 / 后天各排 2 个（未来，不算）
    const p = plan({ startDate: '2026-05-06', bvids: ['BV1', 'BV2', 'BV3', 'BV4', 'BV5', 'BV6'], perDay: 2 });
    const report = buildPeriodReport(weekInput({ count: 1, plans: [p], favorites: [favorite('BV2', 1)] }));
    expect(report.buckets[0]?.plan).toEqual({ total: 2, finished: 1, touched: 0, ratio: 0.5 });
  });

  it('多计划同周排期去重合并；未开始 / 已走完的计划贡献空批次', () => {
    const p1 = plan({ id: 'p1', startDate: '2026-05-04', bvids: ['BV1', 'BV2'], perDay: 2 });
    const p2 = plan({ id: 'p2', startDate: '2026-05-05', bvids: ['BV2', 'BV3'], perDay: 1 });
    const future = plan({ id: 'pf', startDate: '2026-06-01', bvids: ['BVX'], perDay: 1 });
    const report = buildPeriodReport(weekInput({ count: 1, plans: [p1, p2, future], favorites: [] }));
    // 05-04：BV1、BV2；05-05：BV2（重复）、BV3 → 去重后 3 个
    expect(report.buckets[0]?.plan).toEqual({ total: 3, finished: 0, touched: 0, ratio: 0 });
  });
});

describe('buildPeriodReport：月报复习保持率', () => {
  it('有复习记录的收藏中「最近一次 done 在该月内」的占比；分母全库一致', () => {
    const reviewJobs = [
      job({ favoriteId: 'favA', status: 'done', doneAt: at('2026-05-03', 12) }), // 最近一次：5 月
      job({ favoriteId: 'favB', status: 'done', doneAt: at('2026-04-10', 9) }), // 4 月
      job({ favoriteId: 'favC', status: 'done', doneAt: at('2026-03-11', 9) }), // 旧一轮
      job({ favoriteId: 'favC', status: 'done', doneAt: at('2026-04-20', 9) }), // 最近一次：4 月
      job({ favoriteId: 'favD', status: 'pending' }), // 从未完成：不算「有复习记录」
      job({ favoriteId: 'favE', status: 'skipped' }), // 跳过不算
    ];
    const report = buildPeriodReport({ kind: 'month', count: 6, now: NOW, reviewJobs });
    const byKey = new Map(report.buckets.map((b) => [b.key, b]));
    // 分母 = 3（favA / favB / favC），各月一致
    for (const bucket of report.buckets) expect(bucket.review?.reviewed).toBe(3);
    expect(byKey.get('2026-05')?.review).toEqual({ reviewed: 3, retained: 1, ratio: 1 / 3 });
    expect(byKey.get('2026-04')?.review).toEqual({ reviewed: 3, retained: 2, ratio: 2 / 3 });
    expect(byKey.get('2026-03')?.review).toEqual({ reviewed: 3, retained: 0, ratio: 0 }); // favC 最近一次不在 3 月
    expect(byKey.get('2025-12')?.review).toEqual({ reviewed: 3, retained: 0, ratio: 0 });
  });

  it('月末边界：月末 23:59 落在当月；次月 1 日 00:00 起不算当月', () => {
    const reviewJobs = [
      job({ favoriteId: 'favA', status: 'done', doneAt: at('2026-05-31', 23, 59) }),
      job({ favoriteId: 'favB', status: 'done', doneAt: at('2026-06-01', 0, 0) }), // May 桶 endTs 之后
    ];
    const report = buildPeriodReport({ kind: 'month', count: 1, now: at('2026-05-31', 23), reviewJobs });
    // favB 的最近一次复习在 6 月，不在窗口内，但仍计入分母（全库口径）
    expect(report.buckets[0]?.review).toEqual({ reviewed: 2, retained: 1, ratio: 0.5 });
  });

  it('全部为 pending 时 review 为 null（无复习完成记录）', () => {
    const report = buildPeriodReport({
      kind: 'month',
      now: NOW,
      reviewJobs: [job({ favoriteId: 'favA', status: 'pending' })],
    });
    expect(report.buckets.every((b) => b.review === null)).toBe(true);
  });
});

describe('lastDoneReviewTsByFavorite（复习时间归集）', () => {
  it('取每收藏最近一次 done 的 updatedAt；pending / skipped / 脏数据忽略', () => {
    const map = lastDoneReviewTsByFavorite([
      job({ favoriteId: 'a', status: 'done', doneAt: 100 }),
      job({ favoriteId: 'a', status: 'done', doneAt: 300 }),
      job({ favoriteId: 'a', status: 'done', doneAt: 200 }),
      job({ favoriteId: 'b', status: 'pending' }),
      job({ favoriteId: 'c', status: 'skipped', doneAt: 999 }),
      null as unknown as ReviewJobEntity,
    ]);
    expect(map.get('a')).toBe(300);
    expect(map.has('b')).toBe(false);
    expect(map.has('c')).toBe(false);
  });
});
