/**
 * stats.period op 集成测试（fake-indexeddb 全链路：repo 范围查询 → 纯函数聚合）。
 *
 * 覆盖两条链路：
 *  1. 周报：watchRecords（date 索引范围查）+ externalWatch + weeklyPlans + favorites
 *     → 当前周站内 / 站外 / 活跃天 / 流水条数与计划完成度；
 *  2. 月报：watchRecords + externalWatch + reviewJobs → 复习保持率口径。
 *
 * 数据放置与「今天是周几 / 几号」无关（测试任何日期运行结果一致）：
 *  - 当前周 / 当月数据放「今天」（必在窗口内且 ≤ 查询上界）；
 *  - 上一周数据放「今天 − 7 天」（同 weekday 回退一周，必落在上一日历周；
 *    是否同属当前月按实际日历计算，不硬编码）；
 *  - 上月复习时间放「今天 − 40 天」（今天日期位最大 31 < 40，必跨入更早自然月）；
 *  - 计划 startDate = 今天：今天的批次已到期、明天的批次属未来排期（不计入分母）。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/core/db';
import { addWatchRecord } from '@/core/db/repo/stats';
import { addExternalWatch } from '@/core/db/repo/external';
import { putFavorite } from '@/core/db/repo/library';
import { upsertWeeklyPlan } from '@/core/db/repo/weekly';
import { dispatchOp } from '@/entrypoints/background/ops';
import { buildWeeklyPlan, type WeeklyPlan } from '@/core/plan/weekly';
import { dayKeyToTs, localDayKey, startOfLocalWeek } from '@/core/shared/utils';
import type { ReviewJobEntity, WatchRecordEntity } from '@/core/shared/types';

const NOW = Date.now();
const DAY_MS = 86_400_000;
const TODAY_KEY = localDayKey(NOW);

function watchRecord(spec: { date: string; sec: number; valid?: boolean; courId?: number }): WatchRecordEntity {
  const startTs = dayKeyToTs(spec.date) + 10 * 3600_000;
  return {
    courId: spec.courId ?? 1,
    teclId: 9,
    date: spec.date,
    startTs,
    endTs: startTs + spec.sec * 1000,
    durationSec: spec.sec,
    playMode: 'vod',
    speed: 1,
    firstWatch: true,
    valid: spec.valid ?? true,
  };
}

function videoFavorite(bvid: string, watchedRatio: number) {
  return {
    id: `fav-op-${bvid}`,
    type: 'video' as const,
    refId: bvid,
    snapshot: { title: `视频 ${bvid}`, content: '' },
    tags: [],
    pinned: false,
    favoritedAt: NOW,
    metadata: { platform: 'bilibili', bvid, watchedRatio },
  };
}

async function putReviewJob(spec: { id: string; favoriteId: string; status: ReviewJobEntity['status']; updatedAt: number }): Promise<void> {
  const db = await getDb();
  const job: ReviewJobEntity = {
    id: spec.id,
    favoriteId: spec.favoriteId,
    dueDate: TODAY_KEY,
    round: 1,
    template: 'regular',
    status: spec.status,
    createdAt: NOW,
    updatedAt: spec.updatedAt,
  };
  await db.put('reviewJobs', job);
}

/** 「今天 − 7 天」是否与今天同属一个自然月（决定月报窗口是否把它包进来） */
function prevWeekSharesMonth(): boolean {
  const prev = new Date(NOW - 7 * DAY_MS);
  const now = new Date(NOW);
  return prev.getFullYear() === now.getFullYear() && prev.getMonth() === now.getMonth();
}

beforeAll(async () => {
  await getDb();

  // 站内流水：今天 600s 有效 + 500s 无效（封顶/挂机审计）；上一周（今天−7）300s 有效
  await addWatchRecord(watchRecord({ date: TODAY_KEY, sec: 600 }));
  await addWatchRecord(watchRecord({ date: TODAY_KEY, sec: 500, valid: false, courId: 2 }));
  await addWatchRecord(watchRecord({ date: localDayKey(NOW - 7 * DAY_MS), sec: 300, courId: 3 }));

  // 站外流水：今天 BV1A / BV3C
  await addExternalWatch({ date: TODAY_KEY, bvid: 'BV1A', seconds: 120 });
  await addExternalWatch({ date: TODAY_KEY, bvid: 'BV3C', seconds: 60 });

  // 每周计划：从今天起每天 2 个（今天批次 BV1A、BV2B；明天的批次属未来排期，不计入）
  const plan: WeeklyPlan | null = buildWeeklyPlan({
    bvids: ['BV1A', 'BV2B', 'BV3C', 'BV4D'],
    perDay: 2,
    startDate: TODAY_KEY,
    now: NOW,
  });
  if (plan) await upsertWeeklyPlan(plan);

  // 收藏：BV1A 完看（watchedRatio ≥ 0.95）、BV2B 未完看；BV3C / BV4D 未入库（降级路径）
  await putFavorite(videoFavorite('BV1A', 0.97));
  await putFavorite(videoFavorite('BV2B', 0.5));

  // 复习：fav-m1 今天完成（当月）、fav-m2 40 天前完成（必在更早自然月）、fav-m3 仅 pending
  await putReviewJob({ id: 'job-m1', favoriteId: 'fav-m1', status: 'done', updatedAt: NOW });
  await putReviewJob({ id: 'job-m2', favoriteId: 'fav-m2', status: 'done', updatedAt: NOW - 40 * DAY_MS });
  await putReviewJob({ id: 'job-m3', favoriteId: 'fav-m3', status: 'pending', updatedAt: NOW });
});

describe('stats.period op（周报链路）', () => {
  it('近 2 周：范围查询 + 计划完成度 + 站内外合并口径正确', async () => {
    const report = await dispatchOp('stats.period', { kind: 'week', count: 2 });
    expect(report.kind).toBe('week');
    expect(report.buckets).toHaveLength(2);
    const current = report.buckets[1];
    expect(current?.startDay).toBe(localDayKey(startOfLocalWeek(NOW)));
    // 站内：只计有效流水；站外独立口径
    expect(current?.internalSec).toBe(600);
    expect(current?.flowCount).toBe(1);
    expect(current?.externalSec).toBe(180);
    expect(current?.activeDays).toBe(1); // 站内与站外都在今天
    // 计划完成度：今天到期排期 2 个（BV1A/BV2B），BV1A 完看；BV1A 有站外流水覆盖
    expect(current?.plan).toEqual({ total: 2, finished: 1, touched: 1, ratio: 0.5 });
    // 上一周：只有今天−7 的 300s；计划从今天才开始 → 上周无排期
    const prev = report.buckets[0];
    expect(prev?.internalSec).toBe(300);
    expect(prev?.plan).toBeNull();
  });

  it('缺省 count（周报 8）且今日前后数据各归其桶', async () => {
    const report = await dispatchOp('stats.period', { kind: 'week' });
    expect(report.count).toBe(8);
    const current = report.buckets[report.buckets.length - 1];
    expect(current?.startDay).toBe(localDayKey(startOfLocalWeek(NOW)));
    expect(current?.internalSec).toBe(600);
    // 今天−7 天必在上一周桶
    const prev = report.buckets[report.buckets.length - 2];
    expect(prev?.internalSec).toBe(300);
    expect((prev?.endDay ?? '') < TODAY_KEY).toBe(true);
  });
});

describe('stats.period op（月报链路）', () => {
  it('本月：复习保持率 = 当月最近复习 1 / 有复习记录 2', async () => {
    const report = await dispatchOp('stats.period', { kind: 'month', count: 1 });
    expect(report.kind).toBe('month');
    expect(report.buckets).toHaveLength(1);
    const current = report.buckets[0];
    const now = new Date(NOW);
    expect(current?.startDay).toBe(localDayKey(new Date(now.getFullYear(), now.getMonth(), 1)));
    expect(current?.endDay).toBe(localDayKey(new Date(now.getFullYear(), now.getMonth() + 1, 0)));
    // 站内窗口含今天 600s；上一周的 300s 仅当「今天−7」还在本月时被窗口包含
    expect(current?.internalSec).toBe(prevWeekSharesMonth() ? 900 : 600);
    expect(current?.externalSec).toBe(180);
    expect(current?.review).toEqual({ reviewed: 2, retained: 1, ratio: 0.5 });
  });
});
